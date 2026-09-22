#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evaluate } from './staged-reality-gate.mjs';

const S = 'worktree:' + 'a'.repeat(64);
const G = 'git:' + 'b'.repeat(40);
const identity = {
  repositoryExpected: 'acme/app',
  repositoryObserved: 'acme/app',
  projectContextExpected: 'app-v1',
  projectContextObserved: 'app-v1',
  workTargetExpected: 'current-target',
  workTargetObserved: 'current-target',
  executionSurfaceExpected: 'feature/issue',
  executionSurfaceObserved: 'feature/issue',
};
const authority = { state: 'CURRENT', source: 'CANONICAL_CONTRACT', reference: 'PROJECT_CONTEXT.json#current-target' };
const ev = (kind, stateId = S, status = 'PASS') => ({ kind, status, source: 'local', reference: 'selftest:' + kind, stateId });
function uiReceipt(stateId = G, phase = 'FINAL_REALITY_CHECK') {
  const core = {
    schemaVersion: 1,
    receiptType: 'UI_MEASUREMENT_V1',
    result: 'PASS',
    code: 'UI_MEASUREMENT_PASS',
    phase,
    stateId,
    artifactId: 'design-v1',
    viewId: 'home',
    referenceVersion: 'v1',
    preflightReceiptId: '1'.repeat(64),
    protectedFilesUnchanged: true,
    checks: [],
    failedIds: [],
  };
  return { ...core, receiptId: createHash('sha256').update(JSON.stringify(core)).digest('hex') };
}
const uiEv = (kind, stateId = G, receipt = uiReceipt(stateId)) => ({
  kind, status: 'PASS', source: 'local', reference: 'selftest:' + kind, stateId, receipt,
});

function input(phase, taskTypes, evidence, checkpoint, stateId = S) {
  return { schemaVersion: 1, phase, taskTypes, stateId, identity, authority, checkpoint, evidence };
}

let result = evaluate(input(
  'EARLY_CHECK', ['UI'],
  [ev('GIT_STATE'), ev('DIFF'), ev('SCREENSHOT')],
  { scopeMatch: true, firstSliceObserved: true },
));
assert.equal(result.result, 'PASS');
assert.equal(result.code, 'EARLY_CHECK_PASS');
assert.match(result.receiptId, /^[0-9a-f]{64}$/);

result = evaluate({
  ...input('EARLY_CHECK', ['UI'], [ev('GIT_STATE'), ev('DIFF'), ev('DOM')], { scopeMatch: true, firstSliceObserved: true }),
  identity: { ...identity, repositoryObserved: 'acme/wrong' },
});
assert.equal(result.code, 'REPOSITORY_MISMATCH');

result = evaluate({
  ...input('EARLY_CHECK', ['CLI_SCRIPT'], [ev('GIT_STATE'), ev('DIFF'), ev('CLI_OUTPUT')], { scopeMatch: true, firstSliceObserved: true }),
  authority: { state: 'SUPERSEDED', source: 'REPO_LOCAL', reference: 'old-spec' },
});
assert.equal(result.code, 'AUTHORITY_NOT_CURRENT');

result = evaluate(input(
  'EARLY_CHECK', ['UI'],
  [ev('GIT_STATE'), ev('DIFF'), ev('SCREENSHOT', 'worktree:' + 'c'.repeat(64))],
  { scopeMatch: true, firstSliceObserved: true },
));
assert.equal(result.code, 'STALE_EVIDENCE');

result = evaluate(input(
  'EARLY_CHECK', ['UI'],
  [ev('GIT_STATE'), ev('DIFF')],
  { scopeMatch: true, firstSliceObserved: true },
));
assert.equal(result.code, 'REQUIRED_EVIDENCE_MISSING');
assert.deepEqual(result.missingEvidence, ['SCREENSHOT|DOM|RUNTIME']);

result = evaluate(input(
  'MILESTONE_CHECK', ['BACKEND_API'],
  [ev('GIT_STATE'), ev('DIFF'), ev('API_RESPONSE')],
  { scopeMatch: true, milestoneObserved: true, structureMatch: true },
));
assert.equal(result.code, 'MILESTONE_CHECK_PASS');

result = evaluate(input(
  'MILESTONE_CHECK', ['BACKEND_API'],
  [ev('GIT_STATE'), ev('DIFF'), ev('TARGETED_TEST')],
  { scopeMatch: true, milestoneObserved: true, structureMatch: false },
));
assert.equal(result.code, 'CHECKPOINT_NOT_PROVEN');

const finalEv = kind => ev(kind, G);
result = evaluate(input(
  'FINAL_REALITY_CHECK', ['BACKEND_API'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('RUNTIME'), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.code, 'FINAL_REALITY_CHECK_PASS');

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['BACKEND_API'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('RUNTIME')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.code, 'REQUIRED_EVIDENCE_MISSING');
assert(result.missingEvidence.includes('TEST_GATE_RESULT'));

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['DB_SCHEMA'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('DB_SCHEMA'), finalEv('DB_STATE'), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.result, 'PASS');

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['DB_SCHEMA'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('DB_STATE'), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert(result.missingEvidence.includes('DB_SCHEMA'));

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['GENERATED_ARTIFACT'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('GENERATED_ARTIFACT'), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert(result.missingEvidence.includes('HASH'));

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['GENERATED_ARTIFACT'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('GENERATED_ARTIFACT'), finalEv('HASH'), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.result, 'PASS');

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['DOCS_CONFIG'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('DOCUMENT_CONSISTENCY'), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.result, 'PASS');
assert(!result.requiredEvidence.some(x => x.includes('SCREENSHOT')));

result = evaluate(input(
  'MILESTONE_CHECK', ['CLI_SCRIPT', 'DOCS_CONFIG'],
  [ev('GIT_STATE'), ev('DIFF'), ev('CLI_OUTPUT'), ev('DOCUMENT_CONSISTENCY')],
  { scopeMatch: true, milestoneObserved: true, structureMatch: true },
));
assert.equal(result.result, 'PASS');

// Ordinary UI tasks remain backward compatible. Approved-reference reproduction is explicit
// and uses numeric DOM/CSS measurement plus protected-file evidence at every staged check.
// Overlay/pixel diff is intentionally outside the staged PASS/FAIL decision and remains PR evidence.
result = evaluate(input(
  'EARLY_CHECK', ['UI'],
  [ev('GIT_STATE'), ev('DIFF'), ev('SCREENSHOT')],
  { scopeMatch: true, firstSliceObserved: true },
));
assert.equal(result.result, 'PASS');
assert(!result.requiredEvidence.some(x => x.includes('UI_MEASUREMENT')));

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['UI'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('SCREENSHOT'), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.result, 'PASS');

result = evaluate(input(
  'EARLY_CHECK', ['UI_REFERENCE_REPRODUCTION'],
  [ev('GIT_STATE'), ev('DIFF'), ev('SCREENSHOT')],
  { scopeMatch: true, firstSliceObserved: true },
));
assert.equal(result.code, 'REQUIRED_EVIDENCE_MISSING');
assert(result.missingEvidence.includes('UI_MEASUREMENT'));
assert(result.missingEvidence.includes('PROTECTED_FILES_CHECK'));

const earlyUiReceipt = uiReceipt(S, 'EARLY_CHECK');
result = evaluate(input(
  'EARLY_CHECK', ['UI_REFERENCE_REPRODUCTION'],
  [ev('GIT_STATE'), ev('DIFF'), ev('SCREENSHOT'), uiEv('UI_MEASUREMENT', S, earlyUiReceipt), uiEv('PROTECTED_FILES_CHECK', S, earlyUiReceipt)],
  { scopeMatch: true, firstSliceObserved: true },
));
assert.equal(result.result, 'PASS');
assert.equal(result.code, 'EARLY_CHECK_PASS');
assert.equal(result.evidence.find(x => x.kind === 'UI_MEASUREMENT').uiReproductionReceiptId, earlyUiReceipt.receiptId);

const finalUiReceipt = uiReceipt(G, 'FINAL_REALITY_CHECK');
result = evaluate(input(
  'FINAL_REALITY_CHECK', ['UI_REFERENCE_REPRODUCTION'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('SCREENSHOT'), uiEv('UI_MEASUREMENT', G, finalUiReceipt), uiEv('PROTECTED_FILES_CHECK', G, finalUiReceipt), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.result, 'PASS');
assert.equal(result.code, 'FINAL_REALITY_CHECK_PASS');

const tamperedUiReceipt = uiReceipt(G, 'FINAL_REALITY_CHECK');
tamperedUiReceipt.protectedFilesUnchanged = false;
result = evaluate(input(
  'FINAL_REALITY_CHECK', ['UI_REFERENCE_REPRODUCTION'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('SCREENSHOT'), uiEv('UI_MEASUREMENT', G, tamperedUiReceipt), uiEv('PROTECTED_FILES_CHECK', G, tamperedUiReceipt), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.code, 'UI_REPRODUCTION_EVIDENCE_INVALID');

result = evaluate(input(
  'FINAL_REALITY_CHECK', ['UI_REFERENCE_REPRODUCTION'],
  [finalEv('GIT_STATE'), finalEv('DIFF'), finalEv('SCREENSHOT'), uiEv('UI_MEASUREMENT', 'worktree:' + 'c'.repeat(64), uiReceipt('worktree:' + 'c'.repeat(64))), uiEv('PROTECTED_FILES_CHECK', 'worktree:' + 'c'.repeat(64), uiReceipt('worktree:' + 'c'.repeat(64))), finalEv('TEST_GATE_RESULT')],
  { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  G,
));
assert.equal(result.code, 'STALE_EVIDENCE');
assert.equal(result.kind, 'UI_MEASUREMENT');

result = evaluate(input(
  'EARLY_CHECK', ['CLI_SCRIPT'],
  [ev('GIT_STATE'), ev('DIFF', S, 'FAIL'), ev('CLI_OUTPUT')],
  { scopeMatch: true, firstSliceObserved: true },
));
assert.equal(result.code, 'EVIDENCE_FAILURE');

const deterministic = input(
  'EARLY_CHECK', ['UI'],
  [ev('GIT_STATE'), ev('DIFF'), ev('DOM')],
  { scopeMatch: true, firstSliceObserved: true },
);
assert.equal(evaluate(deterministic).receiptId, evaluate(deterministic).receiptId);

console.log('staged-reality-gate selftest: PASS');
