#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  runAgentCycle,
  selectCandidate,
  validateAgentCycleRequest,
} from './agent-cycle.mjs';
import { computeConstraintsDigest } from './research-gate.mjs';

const repoRoot = 'C:\\repo';
const branch = 'feat/agent-runner';

function instructionClarityFor(taskId) {
  return {
    schemaVersion: 1,
    taskId,
    instructions: [{ id: 'human-1', kind: 'INSTRUCTION', summary: 'Implement the requested bounded source change.' }],
    unlistedAssumptionsPresent: false,
    ambiguities: [],
  };
}

function minimalPassChecklist() {
  return ['safety', 'dataPreservation', 'existingOverlap'].map((id) => ({
    id, status: 'PASS', applicable: true,
    justification: `${id} looks fine for this bounded fixture edit.`,
    primarySourceRef: 'https://example.invalid/evidence',
  }));
}

// A minimal, honest BYPASS_LIGHT-shaped research envelope bound to the exact
// taskId/repository/scope the orchestrator will independently re-evaluate it
// against; never trusted on a caller-asserted result.
function researchFor(taskId, overrides = {}) {
  const repository = overrides.repository || { owner: 'example-owner', name: 'example-repo' };
  const scope = overrides.scope || ['src/a.js'];
  const constraints = overrides.constraints || [];
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
      noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Bounded local source edit fixture for agent-cycle selftest.' },
      checklist: minimalPassChecklist(),
      humanTopConditions: [],
      deepResearch: null,
    },
    context: { proposalId: 'proposal-1', constraints, humanTopConditions: [] },
  };
}

function orchestrationTask(overrides = {}) {
  const taskId = overrides.taskId || 'task-a';
  return {
    schemaVersion: 1,
    taskId,
    kind: 'implementation',
    objective: 'Implement one bounded change.',
    prompt: 'Edit only the allowed file.',
    repoRoot,
    branch,
    allowedScope: ['src/a.js'],
    forbiddenScope: [],
    doneConditions: ['Change is bounded.'],
    requiredTests: ['node test.js'],
    dataClass: 'source-only',
    repository: {
      owner: 'example-owner',
      name: 'example-repo',
    },
    instructionClarity: instructionClarityFor(taskId),
    research: researchFor(taskId),
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-a',
    priority: 10,
    blocked: false,
    goalId: 'goal-a',
    expectedNextStep: 'Implement the next bounded change.',
    executionMode: 'INLINE',
    task: orchestrationTask(),
    onSuccessNextStep: null,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    repoRoot,
    branch,
    goalId: 'goal-a',
    mode: 'PLAN',
    candidates: [candidate()],
    ...overrides,
  };
}

function alignedFocus(nextStep = 'Implement the next bounded change.') {
  return {
    ok: true,
    code: 'CURRENT_FOCUS_ALIGNED',
    currentFocus: {
      goalId: 'goal-a',
      goal: 'Finish the approved goal.',
      goalSource: 'EXPLICIT_HUMAN',
      nextStep,
      approvedReferenceId: null,
      decisionId: 'decision-a',
    },
    snapshot: {
      currentGoalId: 'goal-a',
      nextStep,
    },
  };
}

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

{
  const invalid = request({ extra: true });
  const errors = validateAgentCycleRequest(invalid);
  check(errors.includes('payload_schema_invalid'), 'unknown top-level field must fail closed');
}

{
  const invalidCandidate = candidate({ surprise: true });
  const errors = validateAgentCycleRequest(request({ candidates: [invalidCandidate] }));
  check(errors.some((item) => item.includes('candidate_0_schema_invalid')),
    'unknown candidate field must fail closed');
}

{
  const errors = validateAgentCycleRequest(request({
    candidates: [candidate({
      task: orchestrationTask({ branch: 'feat/other' }),
    })],
  }));
  check(errors.some((item) => item.includes('task_branch_mismatch')),
    'task branch must match cycle branch');
}

{
  const result = runAgentCycle(request({
    candidates: [candidate({ expectedNextStep: 'Old step.' })],
  }), {
    observeFocus: () => alignedFocus(),
  });
  equal(result.result, 'STOP', 'stale next step must stop');
  equal(result.code, 'NO_ELIGIBLE_CANDIDATE', 'stale next step code');
}

{
  const high = candidate({ id: 'high', priority: 20 });
  const lowFirst = candidate({ id: 'low-first', priority: 5 });
  const lowSecond = candidate({ id: 'low-second', priority: 5 });
  const selected = selectCandidate(
    request({ candidates: [high, lowFirst, lowSecond] }),
    alignedFocus().currentFocus,
  );
  equal(selected.id, 'low-first', 'lowest priority number wins with stable tie order');
}

{
  const blocked = candidate({ id: 'blocked', priority: 1, blocked: true });
  const ready = candidate({ id: 'ready', priority: 2 });
  const selected = selectCandidate(
    request({ candidates: [blocked, ready] }),
    alignedFocus().currentFocus,
  );
  equal(selected.id, 'ready', 'blocked candidate must never be selected');
}

{
  let executeCalls = 0;
  const result = runAgentCycle(request({ mode: 'PLAN' }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => {
      executeCalls += 1;
      return { result: 'COMPLETED' };
    },
  });
  equal(result.result, 'PLANNED', 'PLAN must only select');
  equal(result.code, 'AGENT_CYCLE_TASK_SELECTED', 'PLAN selection code');
  equal(executeCalls, 0, 'PLAN must not execute');
}

{
  let executeCalls = 0;
  const result = runAgentCycle(request({ mode: 'EXECUTE' }), {
    observeFocus: () => alignedFocus(),
    executeInline: (task) => {
      executeCalls += 1;
      equal(task.taskId, 'task-a', 'INLINE delegates exact selected task');
      return {
        result: 'COMPLETED',
        code: 'IMPLEMENTATION_ROUTED_AND_EXECUTED',
        executionEvidence: { head: 'abc' },
      };
    },
  });
  equal(result.result, 'COMPLETED', 'INLINE success completes one cycle');
  equal(result.code, 'AGENT_CYCLE_INLINE_COMPLETED', 'INLINE success code');
  equal(result.verificationRequired, true, 'cycle must not imply verification is complete');
  equal(executeCalls, 1, 'INLINE executes exactly once');
}

{
  const result = runAgentCycle(request({ mode: 'EXECUTE' }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => ({ result: 'STOP', code: 'PROVIDER_TIMEOUT' }),
  });
  equal(result.result, 'STOP', 'INLINE failure must stop');
  equal(result.code, 'INLINE_EXECUTION_FAILED', 'INLINE failure code');
  equal(result.execution.code, 'PROVIDER_TIMEOUT', 'INLINE failure evidence is preserved');
}

{
  let executeCalls = 0;
  const result = runAgentCycle(request({
    mode: 'EXECUTE',
    candidates: [candidate({ executionMode: 'LONG_TASK' })],
  }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => {
      executeCalls += 1;
      return { result: 'COMPLETED' };
    },
  });
  equal(result.result, 'HANDOFF', 'LONG_TASK must hand off');
  equal(result.code, 'LONG_TASK_HANDOFF_REQUIRED', 'LONG_TASK handoff code');
  equal(executeCalls, 0, 'LONG_TASK must not invoke inline Claude');
  equal(result.orchestrationTask.taskId, 'task-a', 'handoff carries bounded orchestrator task');
  equal(result.authority.autoMerge, false, 'handoff does not gain merge authority');
  equal(result.authority.autoPush, false, 'handoff does not gain push authority');
  equal(result.authority.newPaidRoute, false, 'handoff does not gain paid-route authority');
}

{
  let advanced = null;
  const result = runAgentCycle(request({
    mode: 'EXECUTE',
    candidates: [candidate({
      onSuccessNextStep: 'Run the required verification.',
    })],
  }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => ({ result: 'COMPLETED', code: 'OK' }),
    advanceFocus: (root, focus, nextStep) => {
      advanced = { root, focus, nextStep };
      return {
        ok: true,
        code: 'CURRENT_FOCUS_ADVANCED',
        currentFocus: { ...focus, nextStep },
      };
    },
  });
  equal(result.result, 'COMPLETED', 'successful focus advance preserves cycle success');
  equal(advanced.root, repoRoot, 'focus advance uses exact repository root');
  equal(advanced.focus.goalId, 'goal-a', 'focus advance preserves goal');
  equal(advanced.focus.goalSource, 'EXPLICIT_HUMAN', 'focus advance preserves goal source');
  equal(advanced.focus.decisionId, 'decision-a', 'focus advance preserves human decision');
  equal(advanced.nextStep, 'Run the required verification.', 'focus advances to declared next step');
}

{
  const result = runAgentCycle(request({
    mode: 'EXECUTE',
    candidates: [candidate({
      onSuccessNextStep: 'Run verification.',
    })],
  }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => ({ result: 'COMPLETED', code: 'OK' }),
    advanceFocus: () => ({ ok: false, code: 'WORKING_MEMORY_CONTEXT_UNVERIFIED' }),
  });
  equal(result.result, 'STOP', 'focus advance failure must stop');
  equal(result.code, 'WORKING_MEMORY_ADVANCE_FAILED', 'focus advance failure code');
  equal(result.focusAdvance.code, 'WORKING_MEMORY_CONTEXT_UNVERIFIED',
    'focus advance failure evidence is preserved');
}

{
  let observeCalls = 0;
  const invalid = request({
    candidates: [candidate({ priority: -1 })],
  });
  const result = runAgentCycle(invalid, {
    observeFocus: () => {
      observeCalls += 1;
      return alignedFocus();
    },
  });
  equal(result.result, 'STOP', 'schema failure stops');
  equal(result.code, 'AGENT_CYCLE_SCHEMA_INVALID', 'schema failure code');
  equal(observeCalls, 0, 'schema failure must stop before observing repository state');
}

process.stdout.write(`agent-cycle-selftest: PASS (${assertions} assertions)\n`);
