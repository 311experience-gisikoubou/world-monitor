#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeContinuationMetadata,
  parseContinuationMetadata,
  parseEmbeddedResearchEnvelope,
  prepareAiJobIssue,
  resumeFromWorkState,
  runAgentJobBridge,
} from './agent-job-bridge.mjs';
import { renderPollerIssueFromTask } from '../project-intake/project-intake-gate.mjs';
import { blocksSourceWrite, computeConstraintsDigest, evaluateResearchEnvelope } from './research-gate.mjs';
import { evaluateInstructionClarity } from './instruction-clarity-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeScriptPath = join(here, 'agent-job-bridge.mjs');

function instructionClarityFor(taskId) {
  return {
    schemaVersion: 1,
    taskId,
    instructions: [{ id: 'instr-1', kind: 'INSTRUCTION', summary: 'Implement the bounded bridge change.' }],
    unlistedAssumptionsPresent: false,
    ambiguities: [],
  };
}

// A real, non-fabricated BYPASS_LIGHT-shaped research envelope bound to the
// exact taskId/repository/scope the orchestrator would independently
// re-evaluate it against. This is the same shape required by
// implementation-orchestrator.mjs's validateOrchestrationTask, so a task
// that cannot pass this is not a realistic LONG_TASK candidate.
function researchFor(taskId, { repository = { owner: 'example', name: 'demo' }, scope = ['src/demo.mjs'], constraints = [] } = {}) {
  return {
    evidence: {
      schemaVersion: 1,
      evidenceBinding: {
        taskId, proposalId: 'proposal-1', repository, scope, constraints,
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
      noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Bounded local source edit fixture for agent-job-bridge selftest.' },
      checklist: ['safety', 'dataPreservation', 'existingOverlap'].map((id) => ({
        id, status: 'PASS', applicable: true,
        justification: `${id} looks fine for this bounded fixture edit.`,
        primarySourceRef: 'https://example.invalid/evidence',
      })),
      humanTopConditions: [],
      deepResearch: null,
    },
    context: { proposalId: 'proposal-1', constraints, humanTopConditions: [] },
  };
}

function task(overrides = {}) {
  const taskId = overrides.taskId || 'job-task-1';
  return {
    schemaVersion: 1,
    taskId,
    kind: 'implementation',
    objective: 'Implement the bounded bridge.',
    prompt: 'Edit only the allowed files.',
    repoRoot: 'C:\\repo',
    branch: 'feat/demo',
    allowedScope: ['src/demo.mjs'],
    forbiddenScope: ['.github/workflows/**'],
    doneConditions: ['Bridge works.'],
    requiredTests: ['node src/demo-selftest.mjs'],
    dataClass: 'source-only',
    repository: { owner: 'example', name: 'demo' },
    instructionClarity: instructionClarityFor(taskId),
    research: researchFor(taskId),
    ...overrides,
  };
}

function cycle(overrides = {}) {
  const base = {
    schemaVersion: 1,
    result: 'HANDOFF',
    code: 'LONG_TASK_HANDOFF_REQUIRED',
    goalId: 'goal-1',
    currentNextStep: 'Run the long implementation task.',
    selected: {
      id: 'candidate-1',
      priority: 1,
      executionMode: 'LONG_TASK',
      taskId: 'job-task-1',
      expectedNextStep: 'Run the long implementation task.',
      onSuccessNextStep: 'Verify the completed work.',
    },
    orchestrationTask: task(),
    authority: {
      autoMerge: false,
      autoPush: false,
      newPaidRoute: false,
    },
  };
  return { ...base, ...overrides };
}

function focus(overrides = {}) {
  return {
    goalId: 'goal-1',
    goal: 'Finish the demo safely.',
    goalSource: 'EXPLICIT_HUMAN',
    nextStep: 'Run the long implementation task.',
    approvedReferenceId: null,
    decisionId: 'decision-1',
    recordedAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  };
}

function workState(stage, required = false) {
  return {
    stage,
    outcome: stage === 'DONE' || stage === 'REVIEW' ? 'PASS'
      : stage === 'FAILED' || stage === 'CONFLICT' ? 'FAIL'
        : 'WAITING',
    humanDecision: {
      required,
      reason: required ? 'explicit human decision required' : 'no human decision currently required',
    },
  };
}

let assertions = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}
function ok(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

{
  let renderCalls = 0;
  // A single shared cycle/task instance is used for both the PREPARE call
  // and the "original" comparison below. researchFor() stamps
  // assessedAtUtcMs with Date.now() -- calling cycle() a second time would
  // build a SECOND, separately-timestamped research dossier that can
  // legitimately differ by a millisecond from the first, which is a timing
  // artifact of the test, not a real encode/decode mismatch. Reusing the
  // exact same candidate instance proves the codec preserves raw values
  // exactly, without weakening the equality check or normalizing timestamps.
  const sharedCycle = cycle();
  const prepared = prepareAiJobIssue(sharedCycle, {
    renderTask: (received) => {
      renderCalls += 1;
      equal(received.taskId, 'job-task-1', 'PREPARE passes the exact task to the renderer');
      return { result: 'PROCEED', code: 'TEST_RENDER', markdown: '## 目的\nDemo\n' };
    },
  });
  equal(prepared.result, 'PROCEED', 'PREPARE succeeds');
  equal(prepared.code, 'AI_JOB_ISSUE_READY', 'PREPARE result code');
  equal(prepared.issue.labels.length, 1, 'exactly one poller label');
  equal(prepared.issue.labels[0], 'ai-job', 'existing poller label is reused');
  ok(prepared.issue.body.startsWith('<!-- AGENT_CYCLE_JOB_V1 '), 'continuation metadata is first');
  ok(prepared.issue.body.includes('\n## 目的\nDemo\n'), 'poller body follows metadata');
  equal(prepared.authority.autoMerge, false, 'bridge adds no merge authority');
  equal(prepared.authority.autoPush, false, 'bridge adds no push authority');
  equal(prepared.authority.newPaidRoute, false, 'bridge adds no paid route');
  equal(prepared.authority.scheduledTaskMutation, false, 'bridge adds no scheduler mutation');
  equal(prepared.authority.windowsPolicyMutation, false, 'bridge adds no Windows policy mutation');
  equal(renderCalls, 1, 'PREPARE performs only the injected renderer call');
  // The research envelope embedding now lives solely in the lower-level
  // Project Intake renderer (project-intake-gate.mjs), not in the bridge, so
  // a bare mocked renderTask (as used above) legitimately produces no
  // embedded envelope here -- the real-render case below proves the
  // single-emission embedding end-to-end.
  equal(prepared.issue.body.includes('AGENT_CYCLE_JOB_RESEARCH_V1'), false, 'bridge no longer appends a second research envelope itself');
}

{
  // End-to-end with the REAL poller renderer (not mocked): proves actual
  // forwarding through the production render path, not just that a mocked
  // shape was accepted, and that the envelope is embedded exactly once
  // (by the lower-level renderer, never duplicated by the bridge).
  const realCycle = cycle();
  const prepared = prepareAiJobIssue(realCycle, { renderTask: renderPollerIssueFromTask });
  equal(prepared.result, 'PROCEED', 'PREPARE succeeds with the real poller renderer');
  ok(prepared.issue.body.includes('## 目的'), 'real poller markdown is present in the Issue body');
  const markerCount = prepared.issue.body.split('AGENT_CYCLE_JOB_RESEARCH_V1').length - 1;
  equal(markerCount, 1, 'research envelope marker appears exactly once (single emission, no bridge duplicate)');
  const decoded = parseEmbeddedResearchEnvelope(prepared.issue.body);
  ok(decoded.ok, 'embedded research envelope decodes through the real render path');
  const originalTask = realCycle.orchestrationTask;
  assert.deepEqual(decoded.value.research, originalTask.research, 'decoded research evidence exactly matches the original task evidence through the real render path');
  assert.deepEqual(decoded.value.instructionClarity, originalTask.instructionClarity, 'decoded instructionClarity exactly matches the original task evidence through the real render path');
  assertions += 2;
  equal(decoded.value.research.context.proposalId, 'proposal-1', 'real-render forwarding preserves the actual proposalId, not a placeholder');
  equal(decoded.value.research.evidence.triggers.newCloudApiServiceAppLibraryCliAccount, false, 'real-render forwarding preserves actual trigger values, never an autogenerated trigger:false substitute for missing evidence');
}

{
  // Calling the lower-level Project Intake renderer DIRECTLY (not through
  // the bridge at all) must still carry the raw evidence forward: this is
  // the exact "direct Project Intake" receiving path the bridge cannot see.
  const directTask = task({ taskId: 'direct-intake-task' });
  const direct = renderPollerIssueFromTask(directTask);
  equal(direct.result, 'PROCEED', 'direct renderPollerIssueFromTask succeeds without the bridge');
  const markerCount = direct.markdown.split('AGENT_CYCLE_JOB_RESEARCH_V1').length - 1;
  equal(markerCount, 1, 'direct renderer embeds exactly one research envelope marker');
  const decodedDirect = parseEmbeddedResearchEnvelope(direct.markdown);
  ok(decodedDirect.ok, 'direct renderer output decodes as a valid research envelope');
  assert.deepEqual(decodedDirect.value.research, directTask.research, 'direct renderer preserves the exact research evidence with no bridge involved');
  assert.deepEqual(decodedDirect.value.instructionClarity, directTask.instructionClarity, 'direct renderer preserves the exact instructionClarity evidence with no bridge involved');
  assertions += 2;
}

{
  // A task reaching PREPARE without schema-valid research evidence must
  // fail closed rather than embed an empty/fabricated envelope.
  const missingResearch = cycle({ orchestrationTask: task({ research: undefined }) });
  const result = prepareAiJobIssue(missingResearch, { renderTask: () => ({ result: 'PROCEED', code: 'TEST_RENDER', markdown: '## 目的\nDemo\n' }) });
  equal(result.result, 'STOP', 'missing research evidence is rejected');
  equal(result.code, 'AGENT_JOB_BRIDGE_RESEARCH_EVIDENCE_INVALID', 'missing research evidence rejection code');
}

{
  const bad = cycle({
    authority: { autoMerge: false, autoPush: true, newPaidRoute: false },
  });
  const result = prepareAiJobIssue(bad, {
    renderTask: () => {
      throw new Error('renderer must not run after authority rejection');
    },
  });
  equal(result.result, 'STOP', 'authority expansion is rejected');
  equal(result.code, 'AGENT_JOB_BRIDGE_PREPARE_INVALID', 'authority rejection code');
  ok(result.errors.includes('cycle_authority_expanded'), 'authority rejection reason');
}

const meta = {
  goalId: 'goal-1',
  expectedNextStep: 'Run the long implementation task.',
  onSuccessNextStep: 'Verify the completed work.',
  taskId: 'job-task-1',
};
const encoded = encodeContinuationMetadata(meta);
ok(encoded.ok, 'metadata encodes');
const issueBody = `${encoded.value}\n## 目的\nDemo\n`;
{
  const parsed = parseContinuationMetadata(issueBody);
  ok(parsed.ok, 'metadata parses');
  equal(parsed.value.goalId, 'goal-1', 'goal survives metadata');
  equal(parsed.value.onSuccessNextStep, 'Verify the completed work.', 'success next step survives metadata');
}
{
  const duplicate = parseContinuationMetadata(`${encoded.value}\n${encoded.value}\n## 目的\nDemo\n`);
  equal(duplicate.ok, false, 'duplicate metadata is rejected');
  equal(duplicate.code, 'CONTINUATION_METADATA_DUPLICATE', 'duplicate metadata code');
}
{
  const malformed = parseContinuationMetadata('<!-- AGENT_CYCLE_JOB_V1 *** -->\n## 目的\nDemo\n');
  equal(malformed.ok, false, 'malformed metadata is rejected');
  equal(malformed.code, 'CONTINUATION_METADATA_MALFORMED', 'malformed metadata code');
}

{
  const result = resumeFromWorkState({
    currentFocus: focus({ goalId: 'other-goal' }),
    workState: workState('QUEUED'),
    issueBody,
  });
  equal(result.result, 'STOP', 'stale goal stops');
  equal(result.code, 'CONTINUATION_GOAL_STALE', 'stale goal code');
}
{
  const result = resumeFromWorkState({
    currentFocus: focus({ nextStep: 'A newer step.' }),
    workState: workState('QUEUED'),
    issueBody,
  });
  equal(result.result, 'STOP', 'stale next step stops');
  equal(result.code, 'CONTINUATION_NEXT_STEP_STALE', 'stale next step code');
}

for (const [stage, expectedCode] of [
  ['QUEUED', 'AI_JOB_QUEUED'],
  ['IMPLEMENTING', 'AI_JOB_RUNNING'],
]) {
  const result = resumeFromWorkState({
    currentFocus: focus(),
    workState: workState(stage),
    issueBody,
  });
  equal(result.result, 'WAIT', stage + ' waits');
  equal(result.code, expectedCode, stage + ' wait code');
}

{
  const result = resumeFromWorkState({
    currentFocus: focus(),
    workState: workState('REVIEW', true),
    issueBody,
  });
  equal(result.result, 'WAIT_HUMAN', 'REVIEW waits for human merge decision');
  equal(result.code, 'AI_JOB_REVIEW_WAIT_HUMAN', 'REVIEW code');
}

{
  const result = resumeFromWorkState({
    currentFocus: focus(),
    workState: workState('FAILED', true),
    issueBody,
  });
  equal(result.result, 'WAIT_HUMAN', 'human-gated FAILED waits for human');
  equal(result.code, 'AI_JOB_FAILED_WAIT_HUMAN', 'human-gated FAILED code');
}
{
  const result = resumeFromWorkState({
    currentFocus: focus(),
    workState: workState('FAILED', false),
    issueBody,
  });
  equal(result.result, 'STOP', 'technical FAILED stops');
  equal(result.code, 'AI_JOB_FAILED', 'technical FAILED code');
}
{
  const result = resumeFromWorkState({
    currentFocus: focus(),
    workState: workState('CONFLICT', false),
    issueBody,
  });
  equal(result.result, 'STOP', 'CONFLICT stops');
  equal(result.code, 'AI_JOB_STATE_CONFLICT', 'CONFLICT code');
}
{
  const result = resumeFromWorkState({
    currentFocus: focus(),
    workState: workState('DONE', false),
    issueBody,
  });
  equal(result.result, 'ADVANCE_READY', 'DONE with next step is advance-ready');
  equal(result.code, 'AI_JOB_DONE_ADVANCE_READY', 'DONE advance code');
  equal(result.nextStep, 'Verify the completed work.', 'DONE returns exact next step');
}
{
  const noNext = encodeContinuationMetadata({ ...meta, onSuccessNextStep: null });
  ok(noNext.ok, 'null success next step encodes');
  const result = resumeFromWorkState({
    currentFocus: focus(),
    workState: workState('DONE', false),
    issueBody: `${noNext.value}\n## 目的\nDemo\n`,
  });
  equal(result.result, 'COMPLETED', 'DONE without next step completes');
  equal(result.code, 'AI_JOB_DONE_COMPLETED', 'DONE completed code');
}

{
  const result = runAgentJobBridge({
    schemaVersion: 1,
    action: 'PREPARE',
    cycleResult: cycle(),
  }, {
    renderTask: () => ({ result: 'PROCEED', code: 'TEST', markdown: '## 目的\nDemo\n' }),
  });
  equal(result.result, 'PROCEED', 'closed PREPARE input works');
}
{
  const result = runAgentJobBridge({
    schemaVersion: 1,
    action: 'RESUME',
    currentFocus: focus(),
    workState: workState('IMPLEMENTING'),
    issueBody,
  });
  equal(result.result, 'WAIT', 'closed RESUME input works');
}
{
  const result = runAgentJobBridge({
    schemaVersion: 1,
    action: 'PREPARE',
    cycleResult: cycle(),
    extra: true,
  });
  equal(result.result, 'STOP', 'unknown top-level input is rejected');
  equal(result.code, 'AGENT_JOB_BRIDGE_SCHEMA_INVALID', 'closed input schema code');
}

// --- Bounded read-only CLI extraction mode (--extract-research-envelope) ---
// The real Issue->poller->launcher path loses the embedded envelope because
// scripts/ai-job-poller/poll-once.ps1 only passes a PromptFile to
// run-claude-job.ps1 (no clarity/research file). These tests exercise the
// REAL CLI process (not a mocked parser) against a bridge-rendered body with
// a poller-style prefix, exactly like what the real launcher would receive
// as its PromptFile.
let extractionTempDir;
function extractionFile(name, content) {
  if (!extractionTempDir) extractionTempDir = mkdtempSync(join(tmpdir(), 'agent-job-bridge-extract-'));
  const p = join(extractionTempDir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}
function runExtractCli(filePath) {
  const args = ['--extract-research-envelope'];
  if (filePath !== undefined) args.push(filePath);
  return spawnSync(process.execPath, [bridgeScriptPath, ...args], { encoding: 'utf8' });
}
try {
  const realRenderedCycle = cycle();
  const realRendered = prepareAiJobIssue(realRenderedCycle, { renderTask: renderPollerIssueFromTask });
  equal(realRendered.result, 'PROCEED', 'bridge renders a real poller-style body for the CLI extraction fixture');
  const pollerStylePromptFile = extractionFile('poller-prompt.md', realRendered.issue.body);

  // Valid: the unique embedded envelope decodes exactly, via the real CLI process.
  {
    const result = runExtractCli(pollerStylePromptFile);
    equal(result.status, 0, `valid embedded envelope extraction must exit 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    ok(parsed.ok === true, 'valid extraction reports ok:true');
    assert.deepEqual(parsed.value.research, realRenderedCycle.orchestrationTask.research, 'CLI-extracted research exactly matches the original task evidence, never a placeholder');
    assert.deepEqual(parsed.value.instructionClarity, realRenderedCycle.orchestrationTask.instructionClarity, 'CLI-extracted instructionClarity exactly matches the original task evidence');
    assertions += 1;
  }

  // Missing: a PromptFile with no embedded envelope at all must fail closed, never fabricate a placeholder/trigger:false/ADOPT substitute.
  {
    const missingFile = extractionFile('missing-envelope.md', '## 目的\nPlain poller body with no embedded research envelope.\n');
    const result = runExtractCli(missingFile);
    equal(result.status, 2, 'missing embedded envelope must exit non-zero');
    const parsed = JSON.parse(result.stdout);
    equal(parsed.ok, false, 'missing envelope reports ok:false');
    equal(parsed.code, 'RESEARCH_ENVELOPE_MALFORMED', 'missing envelope code');
  }

  // Duplicate: two embedded envelope markers must fail closed rather than picking either one.
  {
    const duplicateFile = extractionFile('duplicate-envelope.md', `${realRendered.issue.body}\n${realRendered.issue.body}`);
    const result = runExtractCli(duplicateFile);
    equal(result.status, 2, 'duplicate embedded envelope must exit non-zero');
    const parsed = JSON.parse(result.stdout);
    equal(parsed.ok, false, 'duplicate envelope reports ok:false');
    equal(parsed.code, 'RESEARCH_ENVELOPE_DUPLICATE', 'duplicate envelope code');
  }

  // Malformed: a corrupted marker payload must fail closed on decode, never silently substitute a default.
  {
    const malformedFile = extractionFile('malformed-envelope.md', '<!-- AGENT_CYCLE_JOB_RESEARCH_V1 bm90LWpzb24 -->\n## 目的\nDemo\n');
    const result = runExtractCli(malformedFile);
    equal(result.status, 2, 'malformed embedded envelope must exit non-zero');
    const parsed = JSON.parse(result.stdout);
    equal(parsed.ok, false, 'malformed envelope reports ok:false');
    equal(parsed.code, 'RESEARCH_ENVELOPE_DECODE_FAILED', 'malformed envelope code');
  }

  // Unreadable file path: must fail closed, not throw an uncaught exception.
  {
    const result = runExtractCli(join(extractionTempDir, 'does-not-exist.md'));
    equal(result.status, 2, 'unreadable file path must exit non-zero');
    const parsed = JSON.parse(result.stdout);
    equal(parsed.ok, false, 'unreadable file reports ok:false');
    equal(parsed.code, 'RESEARCH_ENVELOPE_FILE_UNREADABLE', 'unreadable file code');
  }

  // Missing file argument after the flag: must fail closed.
  {
    const result = runExtractCli(undefined);
    equal(result.status, 2, 'missing file argument must exit non-zero');
    const parsed = JSON.parse(result.stdout);
    equal(parsed.ok, false, 'missing file argument reports ok:false');
    equal(parsed.code, 'AGENT_JOB_BRIDGE_INPUT_INVALID', 'missing file argument code');
  }

  // Valid dossier reaches the SAME real gates the launcher independently
  // re-evaluates (research-gate + instruction-clarity-gate), with the
  // SAME taskId-only rebind the launcher performs, and WITHOUT invoking any
  // AI provider/runner. This proves the extracted envelope is sufficient to
  // reach launcher qualification; it intentionally stops short of the real
  // claude-job-runner.ps1 (which would actually probe/invoke a provider).
  {
    const result = runExtractCli(pollerStylePromptFile);
    const decoded = JSON.parse(result.stdout).value;
    const orchestratorTaskId = 'claude-job-prompt-envelope-e2e-task';
    const reboundResearch = {
      evidence: {
        ...decoded.research.evidence,
        evidenceBinding: { ...decoded.research.evidence.evidenceBinding, taskId: orchestratorTaskId },
      },
      context: decoded.research.context,
    };
    const gateResult = evaluateResearchEnvelope(reboundResearch, {
      taskId: orchestratorTaskId,
      repository: realRenderedCycle.orchestrationTask.repository,
      scope: realRenderedCycle.orchestrationTask.allowedScope,
    });
    ok(!blocksSourceWrite(gateResult), `extracted envelope must clear the real Research Gate: ${JSON.stringify(gateResult)}`);

    const reboundClarity = { ...decoded.instructionClarity, taskId: orchestratorTaskId };
    const clarityResult = evaluateInstructionClarity(reboundClarity);
    equal(clarityResult.result, 'PROCEED', `extracted instructionClarity must clear the real instruction-clarity gate: ${JSON.stringify(clarityResult)}`);
  }
} finally {
  if (extractionTempDir) rmSync(extractionTempDir, { recursive: true, force: true });
}

process.stdout.write(`agent-job-bridge-selftest: PASS (${assertions} assertions)\n`);
