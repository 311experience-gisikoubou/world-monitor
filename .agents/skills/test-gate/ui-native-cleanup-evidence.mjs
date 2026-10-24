#!/usr/bin/env node
// Verifies UI_NATIVE_CLEANUP_V1 evidence receipts against a pre-shutdown observation.
// Fails closed on any structural, consistency, or timestamp defect.
// receiptId below is a tamper-evidence integrity hash only; it never asserts
// cryptographic authorship or identity of who produced the receipt.
import { createHash } from 'node:crypto';

const STATE_ID_RE = /^(?:git|remote):[0-9a-f]{40}$|^(?:worktree|artifact):[0-9a-f]{64}$/;

const RECEIPT_KEYS = new Set([
  'schemaVersion', 'receiptType', 'result', 'code', 'stateId', 'runId', 'ownedTaskId',
  'workerPid', 'nativeProcessPid', 'cdpPort',
  'verifiedBeforeShutdown', 'workerExited', 'nativeProcessExited', 'trackedChildrenExited',
  'cdpPortReleased', 'syntheticWorkspaceIsolated', 'preEvidencePath', 'postObservedAt', 'receiptId',
]);
const PRE_KEYS = new Set([
  'stage', 'stateId', 'ownedTaskId', 'workerPid', 'nativeProcessPid', 'cdpPort', 'workspaceId',
  'trackedPids', 'observedAt',
]);
const BOOL_FLAGS = [
  'verifiedBeforeShutdown', 'workerExited', 'nativeProcessExited',
  'trackedChildrenExited', 'cdpPortReleased', 'syntheticWorkspaceIsolated',
];

function fail(reason) { return { ok: false, reason }; }
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}
function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}
function validTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}
function noExtraKeys(obj, allowed) {
  return Object.keys(obj).every(key => allowed.has(key));
}

export function verifyNativeCleanupReceipt(receipt, stateId, pre) {
  if (!isPlainObject(receipt)) return fail('RECEIPT_INVALID');
  if (!noExtraKeys(receipt, RECEIPT_KEYS)) return fail('RECEIPT_EXTRA_FIELDS');
  if (receipt.receiptType !== 'UI_NATIVE_CLEANUP_V1') return fail('RECEIPT_TYPE_INVALID');
  if (receipt.schemaVersion !== 1) return fail('SCHEMA_VERSION_INVALID');
  if (receipt.result !== 'PASS') return fail('RESULT_NOT_PASS');
  if (receipt.code !== 'NATIVE_CLEANUP_OK') return fail('CODE_INVALID');
  if (!STATE_ID_RE.test(stateId || '') || receipt.stateId !== stateId) return fail('STATE_ID_MISMATCH');
  if (!nonEmptyString(receipt.runId) || !nonEmptyString(receipt.ownedTaskId) ||
      receipt.runId !== receipt.ownedTaskId) {
    return fail('RUN_TASK_ID_INVALID');
  }
  if (!positiveInt(receipt.workerPid) || !positiveInt(receipt.nativeProcessPid)) return fail('PID_INVALID');
  if (!validPort(receipt.cdpPort)) return fail('CDP_PORT_INVALID');
  if (BOOL_FLAGS.some(key => receipt[key] !== true)) return fail('CLEANUP_PROOF_INCOMPLETE');
  if (!nonEmptyString(receipt.preEvidencePath) ||
      !receipt.preEvidencePath.endsWith('/native-owned-pre-shutdown.json')) {
    return fail('PRE_EVIDENCE_PATH_INVALID');
  }
  if (!validTimestamp(receipt.postObservedAt)) return fail('TIMESTAMP_INVALID');

  if (!isPlainObject(pre)) return fail('PRE_OBSERVATION_INVALID');
  if (!noExtraKeys(pre, PRE_KEYS)) return fail('PRE_OBSERVATION_EXTRA_FIELDS');
  if (pre.stage !== 'PRE_SHUTDOWN_OBSERVED') return fail('PRE_STAGE_INVALID');
  if (!nonEmptyString(pre.workspaceId)) return fail('WORKSPACE_ID_INVALID');
  if (pre.stateId !== receipt.stateId || pre.ownedTaskId !== receipt.ownedTaskId ||
      pre.workerPid !== receipt.workerPid || pre.nativeProcessPid !== receipt.nativeProcessPid ||
      pre.cdpPort !== receipt.cdpPort) {
    return fail('PRE_POST_MISMATCH');
  }
  if (!Array.isArray(pre.trackedPids) || !pre.trackedPids.includes(receipt.nativeProcessPid)) {
    return fail('TRACKED_PIDS_MISSING_NATIVE_PID');
  }
  if (
    pre.trackedPids.some(pid => !positiveInt(pid)) ||
    new Set(pre.trackedPids).size !== pre.trackedPids.length ||
    !pre.trackedPids.includes(receipt.workerPid) ||
    receipt.workerPid === receipt.nativeProcessPid
  ) {
    return fail('TRACKED_PIDS_INVALID');
  }
  if (!validTimestamp(pre.observedAt)) return fail('PRE_TIMESTAMP_INVALID');
  if (Date.parse(pre.observedAt) > Date.parse(receipt.postObservedAt)) return fail('TIMESTAMP_ORDER_INVALID');

  const { receiptId, ...rest } = receipt;
  if (!nonEmptyString(receiptId)) return fail('RECEIPT_ID_MISSING');
  const expected = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  if (receiptId !== expected) return fail('RECEIPT_ID_TAMPERED');

  return { ok: true, reason: 'NATIVE_CLEANUP_OK' };
}
