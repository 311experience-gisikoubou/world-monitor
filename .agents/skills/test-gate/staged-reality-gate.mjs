#!/usr/bin/env node
import { createHash } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifyStagedEvidence as verifyUiReproductionEvidence } from './ui-reference-reproduction-gate.mjs';

const MAX_INPUT_BYTES = 64 * 1024;
const PHASES = new Set(['EARLY_CHECK', 'MILESTONE_CHECK', 'FINAL_REALITY_CHECK']);
const TASK_TYPES = new Set(['UI', 'UI_REFERENCE_REPRODUCTION', 'BACKEND_API', 'DB_SCHEMA', 'CLI_SCRIPT', 'GENERATED_ARTIFACT', 'DOCS_CONFIG']);
const AUTHORITY_STATES = new Set(['CURRENT']);
const AUTHORITY_SOURCES = new Set(['CANONICAL_CONTRACT', 'HUMAN_DECISION_SYNC', 'REPO_LOCAL', 'ISSUE', 'EXPLICIT_HUMAN']);
const EVIDENCE_SOURCES = new Set(['local', 'remote', 'github-api', 'connector', 'device', 'provider']);
const EVIDENCE_STATUSES = new Set(['PASS', 'FAIL', 'UNAVAILABLE']);
const EVIDENCE_KINDS = new Set([
  'GIT_STATE', 'DIFF', 'SCREENSHOT', 'DOM', 'RUNTIME', 'TARGETED_TEST',
  'TEST_GATE_RESULT', 'API_RESPONSE', 'DB_SCHEMA', 'DB_STATE', 'CLI_OUTPUT',
  'GENERATED_ARTIFACT', 'HASH', 'DOCUMENT_CONSISTENCY', 'UI_MEASUREMENT', 'PROTECTED_FILES_CHECK',
]);
const STATE_ID_RE = /^(?:git|remote):[0-9a-f]{40}$|^(?:worktree|artifact):[0-9a-f]{64}$/;

const TASK_REQUIREMENTS = Object.freeze({
  UI: [['SCREENSHOT', 'DOM', 'RUNTIME']],
  UI_REFERENCE_REPRODUCTION: [['SCREENSHOT', 'DOM', 'RUNTIME'], ['UI_MEASUREMENT'], ['PROTECTED_FILES_CHECK']],
  BACKEND_API: [['API_RESPONSE', 'RUNTIME', 'TARGETED_TEST']],
  DB_SCHEMA: [['DB_SCHEMA']],
  CLI_SCRIPT: [['CLI_OUTPUT', 'TARGETED_TEST']],
  GENERATED_ARTIFACT: [['GENERATED_ARTIFACT']],
  DOCS_CONFIG: [['DOCUMENT_CONSISTENCY', 'GENERATED_ARTIFACT']],
});

function unique(values) { return [...new Set(values)]; }
function bounded(value, max = 1000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function stop(code, extra = {}) {
  return { schemaVersion: 1, result: 'STOP', code, ...extra };
}
function identityMismatch(identity) {
  const pairs = [
    ['REPOSITORY_MISMATCH', 'repositoryExpected', 'repositoryObserved'],
    ['PROJECT_CONTEXT_MISMATCH', 'projectContextExpected', 'projectContextObserved'],
    ['WORK_TARGET_MISMATCH', 'workTargetExpected', 'workTargetObserved'],
    ['EXECUTION_SURFACE_MISMATCH', 'executionSurfaceExpected', 'executionSurfaceObserved'],
  ];
  for (const [code, expected, observed] of pairs) {
    if (!bounded(identity?.[expected], 500) || !bounded(identity?.[observed], 500)) {
      return { code: 'IDENTITY_INVALID', field: expected.replace('Expected', '') };
    }
    if (identity[expected] !== identity[observed]) return { code, expected: identity[expected], observed: identity[observed] };
  }
  return null;
}
function checkpointRequirements(phase) {
  if (phase === 'EARLY_CHECK') return ['scopeMatch', 'firstSliceObserved'];
  if (phase === 'MILESTONE_CHECK') return ['scopeMatch', 'milestoneObserved', 'structureMatch'];
  return ['scopeMatch', 'structureMatch', 'implementationComplete', 'deliverableMatch'];
}
function evidenceRequirements(taskTypes, phase) {
  const groups = [['GIT_STATE'], ['DIFF']];
  for (const taskType of taskTypes) {
    for (const group of TASK_REQUIREMENTS[taskType]) groups.push(group);
  }
  if (taskTypes.includes('GENERATED_ARTIFACT') && phase === 'FINAL_REALITY_CHECK') groups.push(['HASH']);
  if (taskTypes.includes('DB_SCHEMA') && phase === 'FINAL_REALITY_CHECK') groups.push(['DB_STATE', 'RUNTIME']);
  if (phase === 'FINAL_REALITY_CHECK') groups.push(['TEST_GATE_RESULT']);
  return groups;
}
function normalizeEvidence(evidence) {
  return evidence.map(item => ({
    kind: item.kind,
    status: item.status,
    source: item.source,
    reference: item.reference,
    stateId: item.stateId,
    ...(['UI_MEASUREMENT', 'PROTECTED_FILES_CHECK'].includes(item.kind) && item.receipt?.receiptId ? { uiReproductionReceiptId: item.receipt.receiptId } : {}),
  }));
}
export function evaluate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return stop('INPUT_INVALID');
  if (input.schemaVersion !== 1) return stop('SCHEMA_VERSION_INVALID');
  if (!PHASES.has(input.phase)) return stop('PHASE_INVALID');
  if (!STATE_ID_RE.test(input.stateId || '')) return stop('STATE_ID_INVALID');
  if (!Array.isArray(input.taskTypes) || input.taskTypes.length === 0 || input.taskTypes.length > TASK_TYPES.size ||
      unique(input.taskTypes).length !== input.taskTypes.length || input.taskTypes.some(x => !TASK_TYPES.has(x))) {
    return stop('TASK_TYPES_INVALID');
  }

  const mismatch = identityMismatch(input.identity);
  if (mismatch) return stop(mismatch.code, mismatch);

  const authority = input.authority;
  if (!authority || typeof authority !== 'object' || !AUTHORITY_STATES.has(authority.state) ||
      !AUTHORITY_SOURCES.has(authority.source) || !bounded(authority.reference, 1000)) {
    return stop('AUTHORITY_NOT_CURRENT');
  }

  const requiredCheckpoint = checkpointRequirements(input.phase);
  if (!input.checkpoint || typeof input.checkpoint !== 'object' || Array.isArray(input.checkpoint)) {
    return stop('CHECKPOINT_INVALID', { requiredCheckpoint });
  }
  const failedCheckpoint = requiredCheckpoint.filter(key => input.checkpoint[key] !== true);
  if (failedCheckpoint.length > 0) return stop('CHECKPOINT_NOT_PROVEN', { missingOrFalse: failedCheckpoint });

  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 40) {
    return stop('EVIDENCE_INVALID');
  }
  for (const item of input.evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !EVIDENCE_KINDS.has(item.kind) || !EVIDENCE_STATUSES.has(item.status) ||
        !EVIDENCE_SOURCES.has(item.source) || !bounded(item.reference, 2000) ||
        !STATE_ID_RE.test(item.stateId || '')) {
      return stop('EVIDENCE_INVALID');
    }
    if (item.status === 'FAIL') return stop('EVIDENCE_FAILURE', { kind: item.kind, reference: item.reference });
    if (item.status === 'PASS' && item.stateId !== input.stateId) {
      return stop('STALE_EVIDENCE', { kind: item.kind, expectedStateId: input.stateId, evidenceStateId: item.stateId });
    }
    if (['UI_MEASUREMENT', 'PROTECTED_FILES_CHECK'].includes(item.kind) && item.status === 'PASS') {
      const uiReceipt = verifyUiReproductionEvidence(item.receipt, input.stateId);
      if (!uiReceipt.ok) return stop('UI_REPRODUCTION_EVIDENCE_INVALID', { reason: uiReceipt.code, reference: item.reference });
    }
  }

  const passKinds = new Set(input.evidence.filter(item => item.status === 'PASS' && item.stateId === input.stateId).map(item => item.kind));
  const requirements = evidenceRequirements(input.taskTypes, input.phase);
  const missingEvidence = requirements
    .filter(group => !group.some(kind => passKinds.has(kind)))
    .map(group => group.join('|'));
  if (missingEvidence.length > 0) return stop('REQUIRED_EVIDENCE_MISSING', { missingEvidence });

  const receiptBase = {
    schemaVersion: 1,
    receiptType: 'STAGED_REALITY_RECEIPT_V1',
    result: 'PASS',
    code: input.phase + '_PASS',
    phase: input.phase,
    stateId: input.stateId,
    taskTypes: [...input.taskTypes].sort(),
    authority: { state: authority.state, source: authority.source, reference: authority.reference },
    identity: { ...input.identity },
    checkpoint: Object.fromEntries(requiredCheckpoint.map(key => [key, true])),
    evidence: normalizeEvidence(input.evidence),
    requiredEvidence: requirements.map(group => group.join('|')),
  };
  const receiptId = createHash('sha256').update(JSON.stringify(receiptBase)).digest('hex');
  return {
    ...receiptBase,
    receiptId,
    rule: 'Only objective PASS evidence bound to the exact stateId satisfies a staged reality check; a mismatch or stale state fails closed.',
  };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) return { error: 'INPUT_TOO_LARGE' };
    chunks.push(chunk);
  }
  try { return { value: JSON.parse(chunks.join('')) }; }
  catch { return { error: 'INPUT_JSON_INVALID' }; }
}

async function main() {
  const input = await readStdin();
  const result = input.error ? stop(input.error) : evaluate(input.value);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.result === 'PASS' ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
