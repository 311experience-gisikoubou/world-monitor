#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gate = path.resolve(gateArg);
const gateDir = path.dirname(gate);
const { evaluateReceipt, verifyFinalReceipt } = await import(pathToFileURL(gate).href);
const { computeChangeSetSha256, readHeadSha } = await import(pathToFileURL(path.join(gateDir, 'implementation-runner.mjs')).href);
const { computeConstraintsDigest } = await import(pathToFileURL(path.join(gateDir, 'research-gate.mjs')).href);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-receipt-'));
let seq = 0;
function writeInput(obj) {
  seq += 1;
  const file = path.join(tmpDir, `input-${seq}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

function expect(input, extraArgs, code, exitCode) {
  const file = writeInput(input);
  const r = spawnSync(process.execPath, [gate, '--input', file, ...(extraArgs || [])], { encoding: 'utf8' });
  if (!r.stdout.includes(`"code":"${code}"`)) {
    throw new Error(`expected code ${code}, got: ${r.stdout} ${r.stderr}`);
  }
  if (r.status !== exitCode) {
    throw new Error(`unexpected exit ${r.status}, expected ${exitCode}: ${r.stdout}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const EVIDENCE_HEAD = 'c'.repeat(40);
const EVIDENCE_CHANGE_SET = 'd'.repeat(64);
const EVIDENCE_CHANGED_PATHS = ['src/widget.ts'];

const baseTask = { id: 'task-1', kind: 'implementation' };
const baseRepo = { owner: 'acme', name: 'widgets' };

function clarityFor(taskId, overrides = {}) {
  return {
    schemaVersion: 1,
    taskId,
    instructions: [{ id: 'human-1', kind: 'INSTRUCTION', summary: 'Implement the requested bounded source change.' }],
    unlistedAssumptionsPresent: false,
    ambiguities: [],
    ...overrides,
  };
}

function minimalPassChecklist() {
  return ['safety', 'dataPreservation', 'existingOverlap'].map((id) => ({
    id, status: 'PASS', applicable: true,
    justification: `${id} looks fine for this bounded fixture edit.`,
    primarySourceRef: 'https://example.invalid/evidence',
  }));
}

// A minimal, honest (not forged) BYPASS_LIGHT-shaped research envelope bound
// to the exact taskId/repository/scope this receipt will be evaluated
// against. decide() always independently re-evaluates this raw evidence; it
// is never trusted on a caller-asserted result.
function researchFor(taskId, overrides = {}) {
  const repository = overrides.repository || baseRepo;
  const scope = overrides.scope || ['src/widget.ts'];
  const proposalId = overrides.proposalId || 'proposal-1';
  const constraints = overrides.constraints || [];
  const humanTopConditions = overrides.humanTopConditions || [];
  const checklist = overrides.checklist || minimalPassChecklist();
  return {
    evidence: {
      schemaVersion: 1,
      evidenceBinding: {
        taskId,
        proposalId,
        repository,
        scope,
        constraints,
        constraintsDigestSha256: computeConstraintsDigest(constraints),
        assessedAtUtcMs: Date.now(),
        maxEvidenceAgeMs: 24 * 60 * 60 * 1000,
      },
      triggers: {
        newCloudApiServiceAppLibraryCliAccount: false,
        authNetworkPrivacySecurityEncryptionBackupStorageChange: false,
        protectedMedicalData: false,
        feeOrFreeQuota: false,
        osBrowserCompatibility: false,
        largeTransfer: false,
        irreversibleOperation: false,
        ongoingMaintenance: false,
      },
      noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Bounded local source edit fixture for receipt selftest.' },
      checklist,
      humanTopConditions: humanTopConditions.map((item) => ({ ...item, active: true })),
      deepResearch: null,
    },
    context: {
      proposalId,
      constraints,
      humanTopConditions: humanTopConditions.map((item) => ({ id: item.id, statement: item.statement })),
    },
  };
}

function preInput(overrides = {}) {
  const task = overrides.task || baseTask;
  return {
    schemaVersion: 1,
    stage: 'pre-implementation',
    task,
    executor: { id: 'claude-cli', provider: 'claude', routeType: 'qualified-agent' },
    repository: baseRepo,
    branch: 'feat/widget',
    allowedScope: ['src/widget.ts'],
    dataClass: 'source-only',
    costPolicy: 'no-new-cost',
    requestedAuthorities: [],
    instructionClarity: clarityFor(task.id),
    research: researchFor(task.id),
    ...overrides,
  };
}
function finalInput(overrides = {}) {
  return {
    ...preInput(),
    stage: 'final',
    implementationHead: HEAD,
    executionEvidence: { preHead: EVIDENCE_HEAD, changeSetSha256: EVIDENCE_CHANGE_SET, changedPaths: EVIDENCE_CHANGED_PATHS },
    ...overrides,
  };
}

// 1. normal source-only UI implementation with qualified Claude route -> PASS/PROCEED
expect(preInput(), [], 'ROUTE_AUTHORIZED', 0);
expect(finalInput(), [], 'FINAL_RECEIPT_ISSUED', 0);

// Missing/failed clarity evidence must fail closed for source-write receipts.
expect(preInput({ instructionClarity: undefined }), [], 'SCHEMA_INVALID', 2);
expect(preInput({
  instructionClarity: clarityFor('task-1', { unlistedAssumptionsPresent: true }),
}), [], 'SCHEMA_INVALID', 2);
expect(preInput({
  instructionClarity: clarityFor('other-task'),
}), [], 'SCHEMA_INVALID', 2);

// 2. ChatGPT direct without exception -> STOP
expect(preInput({ executor: { id: 'chatgpt-web', provider: 'chatgpt', routeType: 'direct-browser' } }), [], 'DIRECT_EXECUTOR_EXCEPTION_REQUIRED', 2);

// 3. valid narrow exception -> PASS
expect(preInput({
  executor: { id: 'chatgpt-web', provider: 'chatgpt', routeType: 'direct-browser' },
  exception: { reason: 'HUMAN_EXPLICIT_DIRECT', justification: 'User explicitly directed ChatGPT to make this exact edit.', evidenceConfirmed: true },
}), [], 'ROUTE_AUTHORIZED', 0);

// direct-browser final receipts have no runner, so they carry no execution evidence and must not require it
expect(finalInput({
  executor: { id: 'chatgpt-web', provider: 'chatgpt', routeType: 'direct-browser' },
  exception: { reason: 'HUMAN_EXPLICIT_DIRECT', justification: 'User explicitly directed ChatGPT to make this exact edit.', evidenceConfirmed: true },
  executionEvidence: undefined,
}), [], 'FINAL_RECEIPT_ISSUED', 0);

// 4. stale HEAD -> STOP via final-pr-audit verification wrapper (mismatch is caught before execution-evidence/repo-root verification)
expect(finalInput(), ['--expect-owner', 'acme', '--expect-name', 'widgets', '--expect-branch', 'feat/widget', '--expect-head', OTHER_HEAD], 'HEAD_MISMATCH', 2);

// verifying a matching HEAD for a qualified-agent receipt without --repo-root must fail closed, not silently skip execution-evidence proof
expect(finalInput(), ['--expect-owner', 'acme', '--expect-name', 'widgets', '--expect-branch', 'feat/widget', '--expect-head', HEAD], 'REPO_ROOT_REQUIRED_FOR_EXECUTION_EVIDENCE', 2);

// 5. main branch -> STOP
expect(preInput({ branch: 'main' }), [], 'PROTECTED_BRANCH_REJECTED', 2);
expect(preInput({ branch: 'master' }), [], 'PROTECTED_BRANCH_REJECTED', 2);
expect(preInput({ branch: 'trunk' }), [], 'PROTECTED_BRANCH_REJECTED', 2);

// extra: forbidden authority
expect(preInput({ requestedAuthorities: ['merge'] }), [], 'FORBIDDEN_AUTHORITY_REQUESTED', 2);

// extra: protected data class rejected by schema
expect(preInput({ dataClass: 'real-data' }), [], 'SCHEMA_INVALID', 2);

// extra: unknown cost rejected
expect(preInput({ costPolicy: 'allow-extra-cost' }), [], 'SCHEMA_INVALID', 2);

// extra: malformed head at final stage
expect(finalInput({ implementationHead: 'not-a-sha' }), [], 'SCHEMA_INVALID', 2);

// extra: malformed repo/scope
expect(preInput({ repository: { owner: 'bad owner', name: 'widgets' } }), [], 'SCHEMA_INVALID', 2);
expect(preInput({ allowedScope: [] }), [], 'SCHEMA_INVALID', 2);

// extra: destructive/production authority rejected
expect(preInput({ requestedAuthorities: ['production'] }), [], 'FORBIDDEN_AUTHORITY_REQUESTED', 2);
expect(preInput({ requestedAuthorities: ['destructive'] }), [], 'FORBIDDEN_AUTHORITY_REQUESTED', 2);

// extra: bugfix/refactor/design-with-source-write also gated for direct-browser
for (const kind of ['bugfix', 'refactor', 'design-with-source-write']) {
  expect(preInput({
    task: { id: 'task-x', kind },
    executor: { id: 'chatgpt-web', provider: 'chatgpt', routeType: 'direct-browser' },
  }), [], 'DIRECT_EXECUTOR_EXCEPTION_REQUIRED', 2);
}

// extra: qualified-agent final receipts missing/malformed execution evidence must fail schema-closed, never silently pass
expect(finalInput({ executionEvidence: undefined }), [], 'SCHEMA_INVALID', 2);
expect(finalInput({ executionEvidence: { preHead: 'not-a-sha', changeSetSha256: EVIDENCE_CHANGE_SET, changedPaths: EVIDENCE_CHANGED_PATHS } }), [], 'SCHEMA_INVALID', 2);
expect(finalInput({ executionEvidence: { preHead: EVIDENCE_HEAD, changeSetSha256: 'zz', changedPaths: EVIDENCE_CHANGED_PATHS } }), [], 'SCHEMA_INVALID', 2);
expect(finalInput({ executionEvidence: { preHead: EVIDENCE_HEAD, changeSetSha256: EVIDENCE_CHANGE_SET, changedPaths: ['../escape'] } }), [], 'SCHEMA_INVALID', 2);
expect(finalInput({ executionEvidence: { preHead: EVIDENCE_HEAD, changeSetSha256: EVIDENCE_CHANGE_SET, changedPaths: EVIDENCE_CHANGED_PATHS, extra: 1 } }), [], 'SCHEMA_INVALID', 2);

// extra: execution evidence is forbidden outside final qualified-agent receipts
expect(preInput({ executionEvidence: { preHead: EVIDENCE_HEAD, changeSetSha256: EVIDENCE_CHANGE_SET, changedPaths: EVIDENCE_CHANGED_PATHS } }), [], 'SCHEMA_INVALID', 2);

// --- Research Gate wiring: every source-write receipt (pre AND final) carries and re-evaluates a raw research envelope ---

// missing research envelope entirely must fail schema-closed for a source-write receipt
expect(preInput({ research: undefined }), [], 'SCHEMA_INVALID', 2);
expect(finalInput({ research: undefined }), [], 'SCHEMA_INVALID', 2);

// malformed research context (missing proposalId) must fail schema-closed
expect(preInput({ research: { evidence: researchFor('task-1').evidence, context: { constraints: [], humanTopConditions: [] } } }), [], 'SCHEMA_INVALID', 2);

// research is forbidden for non-source-write task kinds
expect(preInput({ task: { id: 'task-review', kind: 'review' }, instructionClarity: undefined }), [], 'SCHEMA_INVALID', 2);

// raw evidence with a checklist FAIL must block this receipt BEFORE any provider invocation, re-evaluated from scratch (never trusting a caller claim)
expect(preInput({
  research: researchFor('task-1', { checklist: [
    { id: 'safety', status: 'FAIL', applicable: true, justification: 'A real safety concern exists.', primarySourceRef: 'https://example.invalid/evidence' },
    { id: 'dataPreservation', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
    { id: 'existingOverlap', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
  ] }),
}), [], 'RESEARCH_GATE_BLOCKED', 2);
expect(finalInput({
  research: researchFor('task-1', { checklist: [
    { id: 'safety', status: 'FAIL', applicable: true, justification: 'A real safety concern exists.', primarySourceRef: 'https://example.invalid/evidence' },
    { id: 'dataPreservation', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
    { id: 'existingOverlap', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
  ] }),
}), [], 'RESEARCH_GATE_BLOCKED', 2);

// evidence bound to a DIFFERENT task/repository/scope than this receipt must block, never pass through on name alone
expect(preInput({ research: researchFor('some-other-task') }), [], 'RESEARCH_GATE_BLOCKED', 2);
expect(preInput({ research: researchFor('task-1', { repository: { owner: 'someone-else', name: 'widgets' } }) }), [], 'RESEARCH_GATE_BLOCKED', 2);
expect(preInput({ research: researchFor('task-1', { scope: ['other/**'] }) }), [], 'RESEARCH_GATE_BLOCKED', 2);
// evidence bound to 'proposal-1' but the CURRENT (context) proposal has since changed -> must block, not pass on the evidence's own say-so
expect(preInput({ research: { ...researchFor('task-1'), context: { ...researchFor('task-1').context, proposalId: 'other-proposal' } } }), [], 'RESEARCH_GATE_BLOCKED', 2);

// a caller cannot assert its own 'ADOPT'/result on the raw evidence: the research-gate schema has no such field, so smuggling one in is rejected as an
// unknown field by the independent re-evaluation inside decide() (never trusted on say-so), and the receipt blocks rather than silently passing through
expect(preInput({ research: { evidence: { ...researchFor('task-1').evidence, result: 'ADOPT' }, context: researchFor('task-1').context } }), [], 'RESEARCH_GATE_BLOCKED', 2);

// --- real-repository execution-evidence binding: prove the final gate recomputes and matches the actual committed change set ---
const repoDir = path.join(tmpDir, 'repo');
fs.mkdirSync(repoDir, { recursive: true });
function git(args) {
  const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
git(['init', '-q']);
git(['config', 'user.email', 'test@example.invalid']);
git(['config', 'user.name', 'Test']);
fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoDir, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf8');
git(['add', '.']);
git(['commit', '-q', '-m', 'init']);
const realPreHead = readHeadSha(repoDir);
assert(realPreHead, 'expected a resolvable preHead in the fixture repo');

fs.writeFileSync(path.join(repoDir, 'src', 'widget.ts'), 'export const widget = 2;\n', 'utf8');
fs.writeFileSync(path.join(repoDir, 'src', 'new-file.ts'), 'export const created = true;\n', 'utf8');
const realChangeSet = computeChangeSetSha256(repoDir, realPreHead);
assert(realChangeSet, 'expected a computable change-set hash for the uncommitted edit');
git(['add', '.']);
git(['commit', '-q', '-m', 'implement widget change']);
const realImplementationHead = readHeadSha(repoDir);
assert(realImplementationHead, 'expected a resolvable implementation head after commit');

const realFinalInput = finalInput({
  implementationHead: realImplementationHead,
  executionEvidence: { preHead: realPreHead, changeSetSha256: realChangeSet.changeSetSha256, changedPaths: realChangeSet.changedPaths },
});
expect(realFinalInput, [
  '--expect-owner', 'acme', '--expect-name', 'widgets', '--expect-branch', 'feat/widget',
  '--expect-head', realImplementationHead, '--repo-root', repoDir,
], 'FINAL_RECEIPT_VERIFIED', 0);

// tampering the recorded change-set hash must be caught, not trusted on say-so
expect(finalInput({
  implementationHead: realImplementationHead,
  executionEvidence: { preHead: realPreHead, changeSetSha256: OTHER_HEAD.padEnd(64, '0'), changedPaths: realChangeSet.changedPaths },
}), [
  '--expect-owner', 'acme', '--expect-name', 'widgets', '--expect-branch', 'feat/widget',
  '--expect-head', realImplementationHead, '--repo-root', repoDir,
], 'EXECUTION_EVIDENCE_CHANGE_SET_MISMATCH', 2);

// wrong branch at verification time
expect(realFinalInput, [
  '--expect-owner', 'acme', '--expect-name', 'widgets', '--expect-branch', 'feat/other',
  '--expect-head', realImplementationHead, '--repo-root', repoDir,
], 'BRANCH_MISMATCH', 2);

// direct function-level check: evaluateReceipt + verifyFinalReceipt without going through the CLI
const directDecision = evaluateReceipt(realFinalInput);
assert(directDecision.result === 'PASS', 'direct evaluateReceipt should PASS a well-formed qualified-agent final receipt');
const directVerified = verifyFinalReceipt(directDecision, {
  owner: 'acme', name: 'widgets', branch: 'feat/widget', head: realImplementationHead, repoRoot: repoDir,
});
assert(directVerified.result === 'MERGE_READY', `direct verifyFinalReceipt should be MERGE_READY: ${JSON.stringify(directVerified)}`);
const strippedClarity = verifyFinalReceipt({ ...directDecision, instructionClarity: null }, {
  owner: 'acme', name: 'widgets', branch: 'feat/widget', head: realImplementationHead, repoRoot: repoDir,
});
assert(strippedClarity.code === 'INSTRUCTION_CLARITY_EVIDENCE_MISSING_OR_FAILED',
  'a source-write final receipt with missing clarity evidence must never become MERGE_READY');
const directVerifiedNoRepo = verifyFinalReceipt(directDecision, {
  owner: 'acme', name: 'widgets', branch: 'feat/widget', head: realImplementationHead,
});
assert(directVerifiedNoRepo.code === 'REPO_ROOT_REQUIRED_FOR_EXECUTION_EVIDENCE', 'omitting repoRoot for a qualified-agent receipt must fail closed');

// Receiving-side checks: successful issuance and a valid committed hash do not
// authorize missing, altered or stale Research evidence.
const receiverExpected = {
  owner: 'acme', name: 'widgets', branch: 'feat/widget',
  head: realImplementationHead, repoRoot: repoDir,
};
for (const alter of [
  (receipt) => { delete receipt.research; receipt.researchGate = { result: 'ADOPT' }; },
  (receipt) => { receipt.research.evidence.checklist[0].status = 'FAIL'; },
  (receipt) => { receipt.research.evidence.checklist[0].status = 'UNKNOWN'; delete receipt.research.evidence.checklist[0].primarySourceRef; },
  (receipt) => { receipt.research.evidence.evidenceBinding.assessedAtUtcMs = 0; },
  (receipt) => { receipt.research.context.constraints = ['new-human-constraint']; },
]) {
  const altered = structuredClone(directDecision);
  alter(altered);
  assert(verifyFinalReceipt(altered, receiverExpected).code === 'RESEARCH_EVIDENCE_MISSING_OR_FAILED',
    'bare ADOPT, FAIL, UNKNOWN, stale or mismatched raw evidence must not reach MERGE_READY');
}
const conditionChanged = structuredClone(directDecision);
conditionChanged.research.evidence.humanTopConditions = [
  { id: 'OTHER', active: true, statement: 'Mandatory protected-condition check.', linkedChecklistId: 'safety' },
];
conditionChanged.research.context.humanTopConditions = [
  { id: 'OTHER', statement: 'Mandatory protected-condition check.', linkedChecklistId: 'dataPreservation' },
];
assert(verifyFinalReceipt(conditionChanged, receiverExpected).code === 'RESEARCH_EVIDENCE_MISSING_OR_FAILED',
  'changing the current condition criterion while retaining its ID/statement must fail at the receiver');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('implementation-route-receipt selftest: PASS');