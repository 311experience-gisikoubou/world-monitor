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
import { runAgentCycle } from './agent-cycle.mjs';
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
function researchFor(taskId, {
  repository = { owner: 'example', name: 'demo' },
  scope = ['src/demo.mjs'],
  constraints = [],
  // Defaults to "now" for every existing caller; only the Issue #280
  // prepublish provenance-check stale-evidence fixture below overrides
  // this to a deliberately out-of-window timestamp.
  assessedAtUtcMs = Date.now(),
} = {}) {
  return {
    evidence: {
      schemaVersion: 1,
      evidenceBinding: {
        taskId, proposalId: 'proposal-1', repository, scope, constraints,
        constraintsDigestSha256: computeConstraintsDigest(constraints),
        assessedAtUtcMs,
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

// The exact, fixed, non-judgmental continuation marker runAgentCycle()
// stamps on every real HANDOFF (agent-cycle.mjs's AI_CYCLE_CONTINUATION_
// MARKER). Mirrored here verbatim -- not imported from agent-cycle.mjs --
// so this fixture builder matches the ACTUAL cross-module cycle shape the
// bridge receives, exercising the real regression (Issue #108) rather than
// a synthetic shape agent-cycle.mjs would never actually produce.
const REAL_CYCLE_CONTINUATION_MARKER = Object.freeze({
  terminalState: 'AI_CONTINUES',
  responseMayTerminate: false,
  turnCloseReceipt: null,
  handoffClass: 'AI_OWNED',
});

// A current, actual agent-cycle.mjs HANDOFF cycle is exactly this shape:
// the base PREPARE fields PLUS `dependencyCheckpoints` (always present,
// even empty) PLUS the fixed continuation marker. This is the literal
// closed-object cross-module contract agent-job-bridge.mjs must accept.
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
    dependencyCheckpoints: [],
    ...REAL_CYCLE_CONTINUATION_MARKER,
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
  // --- Issue #280: PREPARE prepublish provenance check ------------------
  // The embedded research+instructionClarity evidence must be
  // independently re-bound (never merely shape-valid) to THIS task's own
  // taskId/repository/allowedScope, and must still be fresh, before any
  // Issue/label is ever produced. These are synthetic, explicitly-marked
  // fixtures built from the SAME cycle()/task()/researchFor() builders
  // used throughout this file -- never real provider-produced evidence.

  function stopsClosedWithNoPublication(result, message) {
    equal(result.result, 'STOP', message);
    ok(!('issue' in result), `${message} (no Issue is produced)`);
    ok(!('labels' in result), `${message} (no label is produced)`);
  }

  // Control: a valid bound research+clarity dossier still PROCEEDs, and
  // the published Issue body still carries the EXACT original research
  // forward (not a placeholder), via the real poller renderer.
  {
    const validCycle = cycle();
    const validPrepared = prepareAiJobIssue(validCycle, { renderTask: renderPollerIssueFromTask });
    equal(validPrepared.result, 'PROCEED', 'prepublish provenance check: valid bound research+clarity still PROCEEDs');
    const validDecoded = parseEmbeddedResearchEnvelope(validPrepared.issue.body);
    ok(validDecoded.ok, 'prepublish provenance check: valid control embeds a decodable research envelope');
    assert.deepEqual(validDecoded.value.research, validCycle.orchestrationTask.research, 'prepublish provenance check: embedded research is the exact original, not a placeholder');
    assertions += 1;
  }

  // Wrong taskId: research evidence bound to a DIFFERENT taskId than this
  // task's own orchestrationTask.taskId.
  {
    const mismatchedTask = task({ research: researchFor('other-task-id') });
    const result = prepareAiJobIssue(cycle({ orchestrationTask: mismatchedTask }), {
      renderTask: () => ({ result: 'PROCEED', code: 'TEST_RENDER', markdown: '## 目的\nDemo\n' }),
    });
    stopsClosedWithNoPublication(result, 'wrong-taskId research evidence fails closed');
    equal(result.code, 'AGENT_JOB_BRIDGE_RESEARCH_GATE_BLOCKED', 'wrong-taskId rejection code');
    equal(result.researchGate.code, 'TASK_MISMATCH', 'wrong-taskId researchGate reason');
  }

  // Other repository: research evidence bound to a DIFFERENT repository
  // than this task's own orchestrationTask.repository.
  {
    const mismatchedTask = task({ research: researchFor('job-task-1', { repository: { owner: 'other-owner', name: 'other-repo' } }) });
    const result = prepareAiJobIssue(cycle({ orchestrationTask: mismatchedTask }), {
      renderTask: () => ({ result: 'PROCEED', code: 'TEST_RENDER', markdown: '## 目的\nDemo\n' }),
    });
    stopsClosedWithNoPublication(result, 'other-repository research evidence fails closed');
    equal(result.code, 'AGENT_JOB_BRIDGE_RESEARCH_GATE_BLOCKED', 'other-repository rejection code');
    equal(result.researchGate.code, 'REPOSITORY_MISMATCH', 'other-repository researchGate reason');
  }

  // Other allowedScope: research evidence bound to a DIFFERENT scope than
  // this task's own orchestrationTask.allowedScope.
  {
    const mismatchedTask = task({ research: researchFor('job-task-1', { scope: ['src/other-file.mjs'] }) });
    const result = prepareAiJobIssue(cycle({ orchestrationTask: mismatchedTask }), {
      renderTask: () => ({ result: 'PROCEED', code: 'TEST_RENDER', markdown: '## 目的\nDemo\n' }),
    });
    stopsClosedWithNoPublication(result, 'other-allowedScope research evidence fails closed');
    equal(result.code, 'AGENT_JOB_BRIDGE_RESEARCH_GATE_BLOCKED', 'other-allowedScope rejection code');
    equal(result.researchGate.code, 'SCOPE_MISMATCH', 'other-allowedScope researchGate reason');
  }

  // Stale assessedAtUtcMs: research evidence older than its own declared
  // maxEvidenceAgeMs (24h) window.
  {
    const staleTask = task({ research: researchFor('job-task-1', { assessedAtUtcMs: Date.now() - 25 * 60 * 60 * 1000 }) });
    const result = prepareAiJobIssue(cycle({ orchestrationTask: staleTask }), {
      renderTask: () => ({ result: 'PROCEED', code: 'TEST_RENDER', markdown: '## 目的\nDemo\n' }),
    });
    stopsClosedWithNoPublication(result, 'stale assessedAtUtcMs research evidence fails closed');
    equal(result.code, 'AGENT_JOB_BRIDGE_RESEARCH_GATE_BLOCKED', 'stale-evidence rejection code');
    equal(result.researchGate.code, 'EVIDENCE_STALE', 'stale-evidence researchGate reason');
  }

  // Material unresolved instructionClarity: an explicit HUMAN-owned,
  // user-visible-design-behavior ambiguity left UNRESOLVED.
  {
    const materialTask = task({
      instructionClarity: {
        schemaVersion: 1,
        taskId: 'job-task-1',
        instructions: [{ id: 'instr-1', kind: 'INSTRUCTION', summary: 'Implement the bounded bridge change.' }],
        unlistedAssumptionsPresent: false,
        ambiguities: [{
          id: 'amb-1',
          summary: 'Whether the fallback path should retry automatically.',
          category: 'user-visible-design-behavior',
          materiality: 'MATERIAL',
          classificationReason: 'Changes visible retry behavior with no explicit instruction.',
          decisionOwner: 'HUMAN',
          resolution: 'UNRESOLVED',
        }],
      },
    });
    const result = prepareAiJobIssue(cycle({ orchestrationTask: materialTask }), {
      renderTask: () => ({ result: 'PROCEED', code: 'TEST_RENDER', markdown: '## 目的\nDemo\n' }),
    });
    stopsClosedWithNoPublication(result, 'material unresolved instructionClarity fails closed');
    equal(result.code, 'AGENT_JOB_BRIDGE_INSTRUCTION_CLARITY_NOT_CONFIRMED', 'material-ambiguity rejection code');
    equal(result.instructionClarity.code, 'MATERIAL_AMBIGUITY_UNRESOLVED', 'material-ambiguity instructionClarity reason');
  }
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

// --- Issue #108: cross-module AI_CONTINUES handoff regression -------------
// After PR #327, every real runAgentCycle() EXECUTE/LONG_TASK HANDOFF
// result also carries `dependencyCheckpoints` and the fixed non-terminal
// continuation marker (terminalState/responseMayTerminate/turnCloseReceipt/
// handoffClass). This block proves (a) an actual current agent-cycle-
// shaped HANDOFF -- built with the EXACT same fixture cycle() every other
// test in this file already uses -- now reaches the research/clarity and
// PREPARE path instead of failing closed on cycle_schema_invalid, and
// (b) a forged, partial, or omitted marker still fails closed and is never
// treated as, or reclassified toward, a human-approved/PRE_MERGE_READY/
// auto-merge terminal state.
{
  // Control: the real agent-cycle-shaped cycle() fixture (now including
  // dependencyCheckpoints + the fixed marker) reaches PROCEED through the
  // real poller renderer -- proving the research/clarity/PREPARE path is
  // actually reached, not merely that cycle_schema_invalid is absent.
  const realShapedCycle = cycle();
  const result = prepareAiJobIssue(realShapedCycle, { renderTask: renderPollerIssueFromTask });
  ok(!(result.errors ?? []).includes('cycle_schema_invalid'), 'real agent-cycle-shaped HANDOFF never hits cycle_schema_invalid');
  equal(result.result, 'PROCEED', 'real agent-cycle-shaped HANDOFF reaches PREPARE PROCEED');
  equal(result.code, 'AI_JOB_ISSUE_READY', 'real agent-cycle-shaped HANDOFF reaches the real Issue-ready code');
}
{
  // A non-empty dependencyCheckpoints (a candidate waiting on an unmet
  // prerequisite in the SAME cycle another candidate was selected from)
  // must still be accepted and forwarded inertly, never blocking PREPARE.
  const withCheckpoints = cycle({
    dependencyCheckpoints: [{
      candidateId: 'candidate-waiting', goalId: 'goal-1', code: 'WAIT_DEPENDENCY',
      nextTrigger: 'owner/repo#1 must become merged=true and reachable from the repository live default branch.',
      waitingOn: [{ prerequisite: { repository: 'owner/repo', pr: 1 }, code: 'PREREQUISITE_NOT_MERGED', evidence: null }],
    }],
  });
  const result = prepareAiJobIssue(withCheckpoints, { renderTask: renderPollerIssueFromTask });
  equal(result.result, 'PROCEED', 'a non-empty dependencyCheckpoints list is accepted and does not block PREPARE');
}
{
  // Omitted marker entirely (pre-PR-#327-shaped cycle): must still fail
  // closed with the specific marker reason, not silently proceed.
  const { terminalState, responseMayTerminate, turnCloseReceipt, handoffClass, ...withoutMarker } = cycle();
  const result = prepareAiJobIssue(withoutMarker, {
    renderTask: () => { throw new Error('renderer must not run with an omitted continuation marker'); },
  });
  equal(result.result, 'STOP', 'an omitted continuation marker fails closed');
  equal(result.code, 'AGENT_JOB_BRIDGE_PREPARE_INVALID', 'omitted-marker rejection code');
  ok(result.errors.includes('cycle_continuation_marker_invalid'), 'omitted-marker rejection reason');
}
{
  // Partial marker (only some of the four keys present -- turnCloseReceipt
  // and handoffClass dropped): must still fail closed, never treated as
  // "close enough".
  const { turnCloseReceipt, handoffClass, ...partialMarkerCycle } = cycle();
  const result = prepareAiJobIssue(partialMarkerCycle, {
    renderTask: () => { throw new Error('renderer must not run with a partial continuation marker'); },
  });
  equal(result.result, 'STOP', 'a partial continuation marker fails closed');
  equal(result.code, 'AGENT_JOB_BRIDGE_PREPARE_INVALID', 'partial-marker rejection code');
  ok(result.errors.includes('cycle_continuation_marker_invalid'), 'partial-marker rejection reason');
}
{
  // Forged/mismatched marker values: a smuggled human-terminal-looking
  // marker must never be accepted as if it were the safe fixed shape, and
  // must never be, or be treated as, PRE_MERGE_READY/human-approved/
  // auto-merge.
  const forgedCases = [
    { terminalState: 'HUMAN_APPROVED' },
    { responseMayTerminate: true },
    { turnCloseReceipt: 'forged-receipt' },
    { handoffClass: 'HUMAN_OWNED' },
  ];
  for (const forged of forgedCases) {
    const forgedCycle = cycle(forged);
    const result = prepareAiJobIssue(forgedCycle, {
      renderTask: () => { throw new Error('renderer must not run with a forged continuation marker'); },
    });
    equal(result.result, 'STOP', `forged marker ${JSON.stringify(forged)} fails closed`);
    equal(result.code, 'AGENT_JOB_BRIDGE_PREPARE_INVALID', `forged marker ${JSON.stringify(forged)} rejection code`);
    ok(result.errors.includes('cycle_continuation_marker_invalid'), `forged marker ${JSON.stringify(forged)} rejection reason`);
    ok(result.result !== 'PROCEED', `forged marker ${JSON.stringify(forged)} is never reclassified toward a terminal/PROCEED outcome`);
  }
}
{
  // A non-array dependencyCheckpoints must fail closed rather than being
  // silently coerced or ignored.
  const badCheckpoints = cycle({ dependencyCheckpoints: 'not-an-array' });
  const result = prepareAiJobIssue(badCheckpoints, {
    renderTask: () => { throw new Error('renderer must not run with an invalid dependencyCheckpoints shape'); },
  });
  equal(result.result, 'STOP', 'a non-array dependencyCheckpoints fails closed');
  equal(result.code, 'AGENT_JOB_BRIDGE_PREPARE_INVALID', 'invalid dependencyCheckpoints rejection code');
  ok(result.errors.includes('cycle_dependencyCheckpoints_invalid'), 'invalid dependencyCheckpoints rejection reason');
}

// --- Issue #108: pure synthetic TRUE integration regression test ----------
// Everything above this block exercises prepareAiJobIssue against a cycle()
// fixture that is manually MIRRORED to match agent-cycle.mjs's actual HANDOFF
// shape -- it never calls the real runAgentCycle(). This block closes that
// gap: it invokes the REAL imported runAgentCycle() (agent-cycle.mjs, loaded
// at the top of this file -- not re-implemented or re-mirrored here) in
// EXECUTE/LONG_TASK mode against an already-valid synthetic task/research/
// instructionClarity fixture (the SAME task()/researchFor()/
// instructionClarityFor() builders used everywhere else in this file), with
// an injected in-memory observeFocus (never touching PROJECT_CONTEXT.json or
// spawning the real working-memory CLI) and throwing side-effect spies for
// executeInline/advanceFocus/resolvePrerequisite (none of which a LONG_TASK
// HANDOFF selection with no declared prerequisites may ever invoke). The
// ACTUAL, unmodified HANDOFF object runAgentCycle() returns is then forwarded
// -- untouched -- to the real prepareAiJobIssue(..., { renderTask:
// renderPollerIssueFromTask }), proving the real cross-module cycle, not a
// hand-authored stand-in, reaches PROCEED/AI_JOB_ISSUE_READY with the exact
// fixed marker, all-false authority, and the original embedded Research and
// Clarity evidence intact. This is still a bounded, pure in-process synthetic
// fixture test -- it never invokes any AI provider, never touches the
// network, the filesystem, or any live application/job/scheduler state, and
// it makes no claim about, and never exercises, a real platform ChatGPT-turn
// -resume end-to-end flow.
{
  const integrationTask = task(); // taskId 'job-task-1', repoRoot 'C:\\repo', branch 'feat/demo'

  const integrationCandidate = {
    id: 'candidate-1',
    priority: 1,
    blocked: false,
    goalId: 'goal-1',
    expectedNextStep: 'Run the long implementation task.',
    executionMode: 'LONG_TASK',
    task: integrationTask,
    onSuccessNextStep: 'Verify the completed work.',
  };

  const integrationPayload = {
    schemaVersion: 1,
    repoRoot: 'C:\\repo',
    branch: 'feat/demo',
    goalId: 'goal-1',
    mode: 'EXECUTE',
    candidates: [integrationCandidate],
  };

  let observeFocusCalls = 0;
  const integrationObserveFocus = (repoRoot, goalId) => {
    observeFocusCalls += 1;
    equal(repoRoot, 'C:\\repo', 'real-integration observeFocus receives the exact payload repoRoot');
    equal(goalId, 'goal-1', 'real-integration observeFocus receives the exact payload goalId');
    return {
      ok: true,
      code: 'CURRENT_FOCUS_ALIGNED',
      currentFocus: {
        goalId: 'goal-1',
        goal: 'Finish the demo safely.',
        goalSource: 'EXPLICIT_HUMAN',
        nextStep: 'Run the long implementation task.',
        approvedReferenceId: null,
        decisionId: 'decision-1',
      },
      snapshot: { currentGoalId: 'goal-1', nextStep: 'Run the long implementation task.' },
    };
  };

  // These three dependencies are real side-effecting seams in agent-cycle.mjs
  // (executeInline runs the implementation orchestrator; advanceFocus writes
  // working memory; resolvePrerequisite calls the GitHub API). A LONG_TASK
  // HANDOFF selection with no declared `prerequisites` must never reach any
  // of them -- throwing here turns any unexpected invocation into an
  // immediate, loud failure instead of a silent pass.
  const integrationExecuteInline = () => {
    throw new Error('executeInline must never run for a LONG_TASK HANDOFF selection');
  };
  const integrationAdvanceFocus = () => {
    throw new Error('advanceFocus must never run for a LONG_TASK HANDOFF selection');
  };
  const integrationResolvePrerequisite = () => {
    throw new Error('resolvePrerequisite must never run when no candidate declares prerequisites');
  };

  let handoff;
  try {
    handoff = runAgentCycle(integrationPayload, {
      observeFocus: integrationObserveFocus,
      executeInline: integrationExecuteInline,
      advanceFocus: integrationAdvanceFocus,
      resolvePrerequisite: integrationResolvePrerequisite,
    });
  } catch (error) {
    assert.fail(`real runAgentCycle() must return a HANDOFF result without invoking any side-effecting dependency: ${error.message}`);
  }

  equal(observeFocusCalls, 1, 'real-integration observeFocus is invoked exactly once by the real runAgentCycle()');
  equal(handoff.result, 'HANDOFF', 'real runAgentCycle() actually returns HANDOFF for an EXECUTE/LONG_TASK selection');
  equal(handoff.code, 'LONG_TASK_HANDOFF_REQUIRED', 'real runAgentCycle() HANDOFF code');
  equal(handoff.goalId, 'goal-1', 'real HANDOFF goalId');
  equal(handoff.currentNextStep, 'Run the long implementation task.', 'real HANDOFF currentNextStep');
  equal(handoff.selected.taskId, 'job-task-1', 'real HANDOFF selected.taskId');
  equal(handoff.selected.executionMode, 'LONG_TASK', 'real HANDOFF selected.executionMode');
  ok(handoff.orchestrationTask === integrationTask, 'real HANDOFF forwards the exact synthetic orchestrationTask instance, never a copy or placeholder');
  equal(handoff.authority.autoMerge, false, 'real HANDOFF authority.autoMerge is false');
  equal(handoff.authority.autoPush, false, 'real HANDOFF authority.autoPush is false');
  equal(handoff.authority.newPaidRoute, false, 'real HANDOFF authority.newPaidRoute is false');
  ok(Array.isArray(handoff.dependencyCheckpoints) && handoff.dependencyCheckpoints.length === 0, 'real HANDOFF dependencyCheckpoints is an empty array (no unmet prerequisite)');
  equal(handoff.terminalState, 'AI_CONTINUES', 'real HANDOFF marker: terminalState');
  equal(handoff.responseMayTerminate, false, 'real HANDOFF marker: responseMayTerminate');
  equal(handoff.turnCloseReceipt, null, 'real HANDOFF marker: turnCloseReceipt');
  equal(handoff.handoffClass, 'AI_OWNED', 'real HANDOFF marker: handoffClass');

  // Forward the ACTUAL, unmodified HANDOFF result (not a copy, not a
  // re-derived shape) straight into the real PREPARE path with the real
  // poller renderer.
  const prepared = prepareAiJobIssue(handoff, { renderTask: renderPollerIssueFromTask });
  ok(!(prepared.errors ?? []).includes('cycle_schema_invalid'), 'real-integration HANDOFF never hits cycle_schema_invalid');
  equal(prepared.result, 'PROCEED', 'real-integration HANDOFF reaches PREPARE PROCEED through the real poller renderer');
  equal(prepared.code, 'AI_JOB_ISSUE_READY', 'real-integration HANDOFF reaches the real Issue-ready code');
  equal(prepared.authority.autoMerge, false, 'real-integration PREPARE output authority.autoMerge is false');
  equal(prepared.authority.autoPush, false, 'real-integration PREPARE output authority.autoPush is false');
  equal(prepared.authority.newPaidRoute, false, 'real-integration PREPARE output authority.newPaidRoute is false');
  equal(prepared.authority.scheduledTaskMutation, false, 'real-integration PREPARE output authority.scheduledTaskMutation is false');
  equal(prepared.authority.windowsPolicyMutation, false, 'real-integration PREPARE output authority.windowsPolicyMutation is false');

  const integrationDecoded = parseEmbeddedResearchEnvelope(prepared.issue.body);
  ok(integrationDecoded.ok, 'real-integration embedded research envelope decodes through the real render path');
  assert.deepEqual(integrationDecoded.value.research, integrationTask.research, 'real-integration decoded research exactly matches the original synthetic fixture research, with no runAgentCycle/bridge mutation');
  assert.deepEqual(integrationDecoded.value.instructionClarity, integrationTask.instructionClarity, 'real-integration decoded instructionClarity exactly matches the original synthetic fixture instructionClarity, with no runAgentCycle/bridge mutation');
  assertions += 2;
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
