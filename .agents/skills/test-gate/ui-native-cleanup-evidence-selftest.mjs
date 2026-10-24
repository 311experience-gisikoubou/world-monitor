#!/usr/bin/env node
// Self-test for verifyNativeCleanupReceipt. Synthetic fixtures only; no product data.
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { verifyNativeCleanupReceipt } from './ui-native-cleanup-evidence.mjs';
import { evaluate as evaluateReality, verifyStagedRealityReceipt } from './staged-reality-gate.mjs';

const STATE_ID = 'git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const pre = {
  stage: 'PRE_SHUTDOWN_OBSERVED',
  stateId: STATE_ID,
  ownedTaskId: 'run-1',
  workerPid: 101,
  nativeProcessPid: 102,
  cdpPort: 9466,
  workspaceId: 'synthetic',
  trackedPids: [101, 102],
  observedAt: '2026-10-09T07:00:00.000Z',
};

function buildPost() {
  return {
    schemaVersion: 1,
    receiptType: 'UI_NATIVE_CLEANUP_V1',
    result: 'PASS',
    code: 'NATIVE_CLEANUP_OK',
    stateId: STATE_ID,
    runId: 'run-1',
    ownedTaskId: 'run-1',
    workerPid: 101,
    nativeProcessPid: 102,
    cdpPort: 9466,
    verifiedBeforeShutdown: true,
    workerExited: true,
    nativeProcessExited: true,
    trackedChildrenExited: true,
    cdpPortReleased: true,
    syntheticWorkspaceIsolated: true,
    preEvidencePath: 'C:/synthetic/native-owned-pre-shutdown.json',
    postObservedAt: '2026-10-09T07:00:01.000Z',
  };
}

function sign(post) {
  return createHash('sha256').update(JSON.stringify(post)).digest('hex');
}

function receiptWithId(post) {
  return { ...post, receiptId: sign(post) };
}

// 1. valid PASS
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, pre);
  assert.deepStrictEqual(result, { ok: true, reason: 'NATIVE_CLEANUP_OK' });
}

// 2. missing/altered flags STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  receipt.cdpPortReleased = false;
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, pre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'CLEANUP_PROOF_INCOMPLETE');
}

// 3. stale state STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  const staleStateId = 'git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const result = verifyNativeCleanupReceipt(receipt, staleStateId, pre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'STATE_ID_MISMATCH');
}

// 4. pre mismatch STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  const badPre = { ...pre, nativeProcessPid: 999 };
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, badPre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'PRE_POST_MISMATCH');
}

// 5. wrong receiptId STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  receipt.receiptId = 'f'.repeat(64);
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, pre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'RECEIPT_ID_TAMPERED');
}

// 6. extra field STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  receipt.unexpectedField = 'synthetic';
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, pre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'RECEIPT_EXTRA_FIELDS');
}

// 7. invalid time STOP
{
  const post = buildPost();
  post.postObservedAt = 'not-a-timestamp';
  const receipt = receiptWithId(post);
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, pre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'TIMESTAMP_INVALID');
}

// 8. trackedPids missing owned worker pid STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  const badPre = { ...pre, trackedPids: [102] };
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, badPre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'TRACKED_PIDS_INVALID');
}

// 9. trackedPids contains duplicate entry STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  const badPre = { ...pre, trackedPids: [101, 102, 102] };
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, badPre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'TRACKED_PIDS_INVALID');
}

// 10. trackedPids contains invalid integer STOP
{
  const post = buildPost();
  const receipt = receiptWithId(post);
  const badPre = { ...pre, trackedPids: [101, 102, -1] };
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, badPre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'TRACKED_PIDS_INVALID');
}

// 11. workerPid equals nativeProcessPid STOP
{
  const post = buildPost();
  post.workerPid = post.nativeProcessPid;
  const receipt = receiptWithId(post);
  const samePidPre = { ...pre, workerPid: post.workerPid, trackedPids: [102] };
  const result = verifyNativeCleanupReceipt(receipt, STATE_ID, samePidPre);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'TRACKED_PIDS_INVALID');
}


// 12. LocalOps observer output is NOT an independently trusted native issuer:
// even structurally valid SHA-256 self-claims must STOP at the native FINAL gate.
{
  const receipt = receiptWithId(buildPost());
  assert.deepStrictEqual(verifyNativeCleanupReceipt(receipt, STATE_ID, pre),
    { ok: true, reason: 'NATIVE_CLEANUP_OK' }); // structural check only
  const e = (kind, extra = {}) => ({
    kind, status: 'PASS', source: 'local', reference: 'synthetic:' + kind,
    stateId: STATE_ID, ...extra,
  });
  const input = {
    schemaVersion: 2, phase: 'FINAL_REALITY_CHECK', taskTypes: ['UI'],
    stateId: STATE_ID,
    identity: {
      repositoryExpected: 'synthetic/native', repositoryObserved: 'synthetic/native',
      projectContextExpected: 'native-fixture', projectContextObserved: 'native-fixture',
      workTargetExpected: 'tauri-screen', workTargetObserved: 'tauri-screen',
      executionSurfaceExpected: 'Tauri native', executionSurfaceObserved: 'Tauri native',
    },
    authority: { state: 'CURRENT', source: 'REPO_LOCAL', reference: 'synthetic-only' },
    actors: { implementerId: 'localops-claimed', judgeId: 'foundation-consumer' },
    checkpoint: { scopeMatch: true, structureMatch: true,
      implementationComplete: true, deliverableMatch: true },
    evidence: [
      e('GIT_STATE'), e('DIFF'), e('SCREENSHOT'),
      e('UI_NATIVE_CLEANUP', { receipt, preEvidence: pre, issuerClaim: 'LocalOps OS observer' }),
      e('TEST_GATE_RESULT'),
    ],
  };
  for (const fake of [input, {
    ...input, evidence: input.evidence.map(({ issuerClaim, ...item }) => item),
  }]) {
    const checked = evaluateReality(fake);
    assert.strictEqual(checked.result, 'STOP');
    assert.strictEqual(checked.code, 'UI_NATIVE_CLEANUP_FAILED');
    assert.strictEqual(checked.reason, 'TRUSTED_NATIVE_ISSUER_REQUIRED');
  }
  const forgedIssuer = receiptWithId({ ...buildPost(), issuer: 'LocalOps' });
  assert.strictEqual(verifyNativeCleanupReceipt(forgedIssuer, STATE_ID, pre).reason,
    'RECEIPT_EXTRA_FIELDS');
  const aggregate = {
    schemaVersion: 2, receiptType: 'STAGED_REALITY_RECEIPT_V2',
    result: 'PASS', code: 'FINAL_REALITY_CHECK_PASS',
    phase: 'FINAL_REALITY_CHECK', stateId: STATE_ID,
    taskTypes: ['UI'], authority: input.authority, actors: input.actors,
    identity: input.identity, checkpoint: input.checkpoint,
    evidence: input.evidence.map(({ kind, status, source, reference, stateId }) =>
      ({ kind, status, source, reference, stateId })),
    requiredEvidence: ['GIT_STATE', 'DIFF', 'SCREENSHOT', 'UI_NATIVE_CLEANUP', 'TEST_GATE_RESULT'],
  };
  aggregate.receiptId = sign(aggregate);
  const checkedAggregate = verifyStagedRealityReceipt(aggregate, STATE_ID,
    { requireFinal: true, requireUi: true });
  assert.strictEqual(checkedAggregate.ok, false);
  assert.strictEqual(checkedAggregate.code, 'NATIVE_FINAL_ISSUER_NOT_PROVEN');
}

console.log('ui-native-cleanup-evidence-selftest: all assertions passed');
