#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  resolvePrerequisiteEvidence,
  runAgentCycle,
  selectCandidate,
  selectDependencyAwareCandidate,
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

{
  let advanceCalls = 0;
  const result = runAgentCycle(request({ mode: 'EXECUTE' }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => ({
      result: 'COMPLETED',
      stagnationCheckpoint: {
        ok: false, code: 'STAGNATION_HARD_STOP_ROUTE_CHANGE_REQUIRED',
        terminalState: 'AI_CONTINUES', handoffClass: 'AI_OWNED',
      },
    }),
    advanceFocus: () => { advanceCalls += 1; return { ok: true }; },
  });
  equal(result.result, 'STOP', 'agent-cycle must reject a failed continuation checkpoint');
  equal(result.code, 'INLINE_EXECUTION_FAILED', 'failed checkpoint cannot complete a cycle');
  equal(result.execution.stagnationCheckpoint.handoffClass, 'AI_OWNED', 'technical failure is not human approval');
  equal(advanceCalls, 0, 'failed checkpoint must not advance working memory');
}

// --- Generic, reusable prerequisite-driven continuation (A -> B -> C) -----
// A candidate may optionally declare a bounded set of prerequisite GitHub
// PRs (repository + positive PR number); no project-specific identifier is
// ever used below -- only generic synthetic repository/PR fixtures.

{
  // Malformed and unbounded descriptors must fail closed.
  const badRepo = candidate({ prerequisites: [{ repository: 'not a repo', pr: 1 }] });
  check(validateAgentCycleRequest(request({ candidates: [badRepo] }))
    .some((item) => item.includes('prerequisites_invalid')),
    'malformed repository token must fail closed');

  const badPr = candidate({ prerequisites: [{ repository: 'owner/name', pr: -1 }] });
  check(validateAgentCycleRequest(request({ candidates: [badPr] }))
    .some((item) => item.includes('prerequisites_invalid')),
    'non-positive PR number must fail closed');

  // Mirrors agent-cycle.mjs's own MAX_PREREQUISITES bound (5); one past the
  // bound must fail closed as an unbounded set.
  const tooMany = candidate({
    prerequisites: Array.from({ length: 6 }, (_, i) => ({ repository: 'owner/name', pr: i + 1 })),
  });
  check(validateAgentCycleRequest(request({ candidates: [tooMany] }))
    .some((item) => item.includes('prerequisites_invalid')),
    'an unbounded prerequisite set must fail closed');

  const duplicate = candidate({
    prerequisites: [{ repository: 'owner/name', pr: 1 }, { repository: 'owner/name', pr: 1 }],
  });
  check(validateAgentCycleRequest(request({ candidates: [duplicate] }))
    .some((item) => item.includes('prerequisites_duplicate')),
    'duplicate prerequisite identifiers must fail closed');

  const selfCycle = candidate({
    pullRequest: { repository: 'owner/name', pr: 5 },
    prerequisites: [{ repository: 'owner/name', pr: 5 }],
  });
  check(validateAgentCycleRequest(request({ candidates: [selfCycle] }))
    .some((item) => item.includes('prerequisites_self_cycle')),
    'a self-referential prerequisite must fail closed');

  const badPullRequest = candidate({ pullRequest: { repository: 'owner/name', pr: 0 } });
  check(validateAgentCycleRequest(request({ candidates: [badPullRequest] }))
    .some((item) => item.includes('pullRequest_invalid')),
    'an invalid own pull request identifier must fail closed');
}

{
  // A mutual two-candidate cycle (A depends on B's PR, B depends on A's PR)
  // is representable once both declare their own pullRequest identity, and
  // must fail closed rather than silently selecting either side.
  const first = candidate({
    id: 'cycle-a',
    pullRequest: { repository: 'owner/name', pr: 101 },
    prerequisites: [{ repository: 'owner/name', pr: 102 }],
  });
  const second = candidate({
    id: 'cycle-b',
    pullRequest: { repository: 'owner/name', pr: 102 },
    prerequisites: [{ repository: 'owner/name', pr: 101 }],
    task: orchestrationTask({ taskId: 'task-cycle-b' }),
  });
  const errors = validateAgentCycleRequest(request({ candidates: [first, second] }));
  check(errors.some((item) => item.includes('prerequisites_cycle')),
    'a representable mutual two-candidate cycle must fail closed');
}

{
  // Existing candidates without a prerequisites declaration must keep their
  // exact prior selection and schema behavior.
  const errors = validateAgentCycleRequest(request());
  equal(errors.length, 0, 'a candidate without prerequisites validates exactly as before');
  const selected = selectCandidate(request(), alignedFocus().currentFocus);
  equal(selected.id, 'candidate-a', 'selectCandidate is unchanged for a dependency-free candidate');
}

{
  // A (unmerged) -> B waits; an independent C (no prerequisite) still runs.
  // One candidate's WAIT_DEPENDENCY is never terminal for the whole cycle.
  const waitingB = candidate({
    id: 'candidate-b',
    priority: 1,
    prerequisites: [{ repository: 'owner-x/repo-x', pr: 101 }],
    task: orchestrationTask({ taskId: 'task-b' }),
  });
  const independentC = candidate({
    id: 'candidate-c',
    priority: 2,
    task: orchestrationTask({ taskId: 'task-c' }),
  });
  let resolverCalls = 0;
  const result = runAgentCycle(request({
    mode: 'PLAN',
    candidates: [waitingB, independentC],
  }), {
    observeFocus: () => alignedFocus(),
    resolvePrerequisite: (identifier) => {
      resolverCalls += 1;
      equal(identifier.repository, 'owner-x/repo-x', 'resolver receives the exact declared repository');
      equal(identifier.pr, 101, 'resolver receives the exact declared PR number');
      return { ok: true, merged: false, onMain: false, code: 'PREREQUISITE_NOT_MERGED' };
    },
  });
  equal(result.result, 'PLANNED', 'an independent candidate proceeds while a dependent candidate waits');
  equal(result.selected.id, 'candidate-c', 'the independent candidate without an unmet prerequisite is selected');
  equal(result.dependencyCheckpoints.length, 1, 'exactly one checkpoint is retained for the waiting candidate');
  equal(result.dependencyCheckpoints[0].candidateId, 'candidate-b', 'the checkpoint names the waiting candidate');
  equal(result.dependencyCheckpoints[0].nextTrigger,
    'owner-x/repo-x#101 must become merged=true and reachable from the repository live default branch.',
    'the checkpoint honestly names the merge-on-default-branch condition, not an unrelated focus string');
  equal(result.dependencyCheckpoints[0].code, 'WAIT_DEPENDENCY', 'the checkpoint is machine-readable WAIT_DEPENDENCY');
  equal(resolverCalls, 1, 'the prerequisite resolver is consulted exactly once for the dependent candidate');
}

{
  // Never trust a caller-asserted "merged" claim: every non-satisfying
  // evidence shape (unmerged, closed-unmerged, merged-but-stale-main, an
  // unavailable GitHub read, a thrown resolver, and a source mismatch) must
  // all resolve to WAIT_DEPENDENCY and must never allow inline execution.
  const scenarios = [
    { label: 'unmerged', evidence: { ok: true, merged: false, onMain: false, code: 'PREREQUISITE_NOT_MERGED' } },
    { label: 'closed without merge', evidence: { ok: true, merged: false, onMain: false, code: 'PREREQUISITE_CLOSED_UNMERGED' } },
    { label: 'merged but not on current main', evidence: { ok: true, merged: true, onMain: false, code: 'PREREQUISITE_MAIN_STALE' } },
    { label: 'unavailable GitHub response', evidence: { ok: false, code: 'PREREQUISITE_GITHUB_QUERY_FAILED' } },
    { label: 'ambiguous source provenance', evidence: { ok: false, code: 'PREREQUISITE_SOURCE_MISMATCH' } },
    { label: 'resolver throws', evidence: null, throwInstead: true },
  ];
  for (const scenario of scenarios) {
    let executeCalls = 0;
    const dependent = candidate({
      id: 'candidate-b',
      prerequisites: [{ repository: 'owner-x/repo-x', pr: 101 }],
      task: orchestrationTask({ taskId: 'task-b' }),
    });
    const result = runAgentCycle(request({ mode: 'EXECUTE', candidates: [dependent] }), {
      observeFocus: () => alignedFocus(),
      executeInline: () => { executeCalls += 1; return { result: 'COMPLETED', code: 'OK' }; },
      resolvePrerequisite: () => {
        if (scenario.throwInstead) throw new Error('GITHUB_READ_UNAVAILABLE');
        return scenario.evidence;
      },
    });
    equal(result.result, 'STOP', `${scenario.label}: unmet prerequisite must never RUN`);
    equal(result.code, 'WAIT_DEPENDENCY', `${scenario.label}: cycle must honestly report WAIT_DEPENDENCY`);
    equal(result.dependencyCheckpoints[0].candidateId, 'candidate-b', `${scenario.label}: checkpoint names the waiting candidate`);
    equal(executeCalls, 0, `${scenario.label}: inline execution must never be invoked while a prerequisite is unmet`);
  }
}

{
  // A merged AND present on current main -> B becomes eligible.
  let resolverArgs = null;
  const dependent = candidate({
    id: 'candidate-b',
    prerequisites: [{ repository: 'owner-x/repo-x', pr: 101 }],
    task: orchestrationTask({ taskId: 'task-b' }),
  });
  const result = runAgentCycle(request({ mode: 'PLAN', candidates: [dependent] }), {
    observeFocus: () => alignedFocus(),
    resolvePrerequisite: (identifier) => {
      resolverArgs = identifier;
      return { ok: true, merged: true, onMain: true, code: 'PREREQUISITE_MERGED_ON_MAIN' };
    },
  });
  equal(result.result, 'PLANNED', 'a merged-and-on-main prerequisite makes the dependent candidate eligible');
  equal(result.selected.id, 'candidate-b', 'the dependent candidate is selected once its prerequisite is satisfied');
  equal(result.dependencyCheckpoints.length, 0, 'no checkpoint is retained once the prerequisite is satisfied');
  equal(resolverArgs.pr, 101, 'the resolver was consulted with the declared prerequisite PR number');
}

{
  // A -> B -> C: once B's prerequisite (standing in for "A") is satisfied, B
  // runs exactly once and hands off focus so an independent C candidate
  // (depending on B's PR) becomes eligible in the following cycle -- with
  // no duplicate execution of either step.
  let executeCallsB = 0;
  const bCandidate = candidate({
    id: 'candidate-b',
    expectedNextStep: 'Implement the next bounded change.',
    onSuccessNextStep: 'Proceed with candidate C.',
    prerequisites: [{ repository: 'owner-x/repo-x', pr: 101 }],
    task: orchestrationTask({ taskId: 'task-b' }),
  });
  const resultB = runAgentCycle(request({ mode: 'EXECUTE', candidates: [bCandidate] }), {
    observeFocus: () => alignedFocus(),
    resolvePrerequisite: () => ({ ok: true, merged: true, onMain: true, code: 'PREREQUISITE_MERGED_ON_MAIN' }),
    executeInline: () => { executeCallsB += 1; return { result: 'COMPLETED', code: 'OK' }; },
    advanceFocus: (root, focus, nextStep) => ({
      ok: true, code: 'CURRENT_FOCUS_ADVANCED', currentFocus: { ...focus, nextStep },
    }),
  });
  equal(resultB.result, 'COMPLETED', 'B completes once its prerequisite is merged and present on current main');
  equal(executeCallsB, 1, 'B executes exactly once');

  let executeCallsC = 0;
  const cCandidate = candidate({
    id: 'candidate-c',
    expectedNextStep: 'Proceed with candidate C.',
    prerequisites: [{ repository: 'owner-x/repo-x', pr: 202 }],
    task: orchestrationTask({ taskId: 'task-c' }),
  });
  const resultC = runAgentCycle(request({ mode: 'EXECUTE', candidates: [cCandidate] }), {
    observeFocus: () => alignedFocus('Proceed with candidate C.'),
    resolvePrerequisite: () => ({ ok: true, merged: true, onMain: true, code: 'PREREQUISITE_MERGED_ON_MAIN' }),
    executeInline: () => { executeCallsC += 1; return { result: 'COMPLETED', code: 'OK' }; },
  });
  equal(resultC.result, 'COMPLETED', 'C becomes eligible once B has completed its step of the chain');
  equal(executeCallsC, 1, 'C executes exactly once, forming the generic A -> B -> C continuation chain');
}

{
  // PLAN mode must never write and must state WAIT_DEPENDENCY honestly even
  // when it is the only candidate in the cycle.
  const onlyDependent = candidate({
    id: 'candidate-b',
    prerequisites: [{ repository: 'owner-x/repo-x', pr: 101 }],
    task: orchestrationTask({ taskId: 'task-b' }),
  });
  let executeCalls = 0;
  let advanceCalls = 0;
  const result = runAgentCycle(request({ mode: 'PLAN', candidates: [onlyDependent] }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => { executeCalls += 1; return { result: 'COMPLETED' }; },
    advanceFocus: () => { advanceCalls += 1; return { ok: true }; },
    resolvePrerequisite: () => ({ ok: true, merged: false, onMain: false, code: 'PREREQUISITE_NOT_MERGED' }),
  });
  equal(result.result, 'STOP', 'PLAN mode honestly stops when the only candidate is waiting on a dependency');
  equal(result.code, 'WAIT_DEPENDENCY', 'PLAN mode reports WAIT_DEPENDENCY rather than a generic no-candidate code');
  equal(executeCalls, 0, 'PLAN mode never executes');
  equal(advanceCalls, 0, 'PLAN mode never advances working memory');
}

{
  // selectDependencyAwareCandidate is the exact reusable primitive wired
  // into runAgentCycle above; exercise it directly too.
  const ready = candidate({ id: 'ready', priority: 2 });
  const waiting = candidate({
    id: 'waiting',
    priority: 1,
    prerequisites: [{ repository: 'owner-x/repo-x', pr: 101 }],
    task: orchestrationTask({ taskId: 'task-waiting' }),
  });
  const { selected, checkpoints } = selectDependencyAwareCandidate(
    request({ candidates: [waiting, ready] }),
    alignedFocus().currentFocus,
    () => ({ ok: false, code: 'PREREQUISITE_GITHUB_QUERY_FAILED' }),
  );
  equal(selected.id, 'ready', 'selectDependencyAwareCandidate skips the waiting candidate for an independent one');
  equal(checkpoints.length, 1, 'selectDependencyAwareCandidate records exactly one checkpoint');
  equal(checkpoints[0].candidateId, 'waiting', 'the checkpoint names the correct waiting candidate');
}

// --- resolvePrerequisiteEvidence: live default-branch selection behavior --
// These regression tests exercise the resolver's REAL branch-selection
// logic through an injected, bounded `ghApiReader` test seam (no live
// network access, no caller-asserted shortcuts). They specifically cover
// the reviewed false-positive: a PR's own `base.ref` must never be trusted
// as "the default branch" -- the live `default_branch` is always
// independently discovered from the repository's own metadata, and
// eligibility is decided only against that branch's live head.

const SHA_MERGE = 'a'.repeat(40);
const SHA_STALE_MAIN = 'b'.repeat(40);
const SHA_ADVANCED_MAIN = SHA_MERGE;

function mergedPrJson({ repository, baseRef, mergeCommitSha, state = 'closed' }) {
  return {
    state,
    merged: true,
    merge_commit_sha: mergeCommitSha,
    base: { ref: baseRef, repo: { full_name: repository } },
  };
}

function routedGhApiReader(routes) {
  return (args) => {
    const route = routes.find(([path]) => args[0] === 'api' && args[1] === path);
    if (!route) throw new Error(`UNEXPECTED_GH_API_CALL:${JSON.stringify(args)}`);
    return route[1];
  };
}

{
  // The exact reviewed false-positive: a PR merged into an intermediate
  // branch ("staging") must NEVER be treated as onMain just because the PR
  // targeted that branch. The live repository default branch is "main",
  // and "main" has not yet advanced to include the merge commit.
  const repository = 'owner-y/repo-y';
  const reader = routedGhApiReader([
    [`repos/${repository}/pulls/303`, { ok: true, value: mergedPrJson({
      repository, baseRef: 'staging', mergeCommitSha: SHA_MERGE,
    }) }],
    [`repos/${repository}`, { ok: true, value: { full_name: repository, default_branch: 'main' } }],
    [`repos/${repository}/branches/main`, { ok: true, value: { commit: { sha: SHA_STALE_MAIN } } }],
    [`repos/${repository}/compare/${SHA_MERGE}...${SHA_STALE_MAIN}`, { ok: true, value: { status: 'diverged' } }],
  ]);
  const evidence = resolvePrerequisiteEvidence({ repository, pr: 303 }, { ghApiReader: reader });
  equal(evidence.merged, true, 'merged on an intermediate branch is still honestly reported as merged=true');
  equal(evidence.onMain, false,
    'merged-on-intermediate-branch must NOT be reported as onMain until the live default branch includes it');
  equal(evidence.code, 'PREREQUISITE_MAIN_STALE', 'the resolver reports the honest stale-main code');
  equal(evidence.baseRef, 'staging', 'the PR base.ref is preserved only as diagnostic context');
  equal(evidence.defaultBranch, 'main',
    'the live repository default branch, not the PR base.ref, is the branch actually checked');
}

{
  // The same intermediate-branch PR becomes eligible only once the LIVE
  // default branch ("main") has independently advanced to include the
  // merge commit -- proving the fix checks the repository's live default
  // branch head rather than ever trusting PR.base.ref as "the" branch.
  const repository = 'owner-y/repo-y';
  const reader = routedGhApiReader([
    [`repos/${repository}/pulls/303`, { ok: true, value: mergedPrJson({
      repository, baseRef: 'staging', mergeCommitSha: SHA_MERGE,
    }) }],
    [`repos/${repository}`, { ok: true, value: { full_name: repository, default_branch: 'main' } }],
    [`repos/${repository}/branches/main`, { ok: true, value: { commit: { sha: SHA_ADVANCED_MAIN } } }],
  ]);
  const evidence = resolvePrerequisiteEvidence({ repository, pr: 303 }, { ghApiReader: reader });
  equal(evidence.merged, true, 'merged remains true once the default branch advances');
  equal(evidence.onMain, true,
    'onMain becomes true once the live default branch head equals the merge commit, independent of base.ref');
  equal(evidence.code, 'PREREQUISITE_MERGED_ON_MAIN', 'the resolver reports the honest merged-on-main code');
  equal(evidence.baseRef, 'staging', 'baseRef is still reported, but never drove the onMain decision');
  equal(evidence.defaultBranch, 'main', 'the decision is driven by the live default branch');
}

{
  // An "ahead" compare result (merge commit is an ancestor of, but not
  // equal to, the live default branch head) must also resolve onMain=true.
  const repository = 'owner-y/repo-y';
  const liveMainSha = 'c'.repeat(40);
  const reader = routedGhApiReader([
    [`repos/${repository}/pulls/303`, { ok: true, value: mergedPrJson({
      repository, baseRef: 'main', mergeCommitSha: SHA_MERGE,
    }) }],
    [`repos/${repository}`, { ok: true, value: { full_name: repository, default_branch: 'main' } }],
    [`repos/${repository}/branches/main`, { ok: true, value: { commit: { sha: liveMainSha } } }],
    [`repos/${repository}/compare/${SHA_MERGE}...${liveMainSha}`, { ok: true, value: { status: 'ahead' } }],
  ]);
  const evidence = resolvePrerequisiteEvidence({ repository, pr: 303 }, { ghApiReader: reader });
  equal(evidence.onMain, true, 'an ancestor merge commit (compare status "ahead") is honestly onMain=true');
  equal(evidence.code, 'PREREQUISITE_MERGED_ON_MAIN', 'ancestor merge commit resolves to the merged-on-main code');
}

{
  // Missing/failing default-branch discovery must fail closed rather than
  // ever falling back to inferring a branch from the PR or caller input.
  const repository = 'owner-y/repo-y';
  const reader = routedGhApiReader([
    [`repos/${repository}/pulls/303`, { ok: true, value: mergedPrJson({
      repository, baseRef: 'staging', mergeCommitSha: SHA_MERGE,
    }) }],
    [`repos/${repository}`, { ok: false, code: 'PREREQUISITE_GITHUB_QUERY_FAILED' }],
  ]);
  const evidence = resolvePrerequisiteEvidence({ repository, pr: 303 }, { ghApiReader: reader });
  equal(evidence.ok, false, 'a failed repository metadata read fails closed');
  equal(evidence.onMain, false, 'a failed default-branch discovery is never treated as onMain');
  equal(evidence.merged, true, 'the already-proven merged=true fact is preserved alongside the failure');
}

{
  // A missing or malformed default_branch field in otherwise-trusted
  // repository metadata must fail closed, never inferring any branch name.
  const repository = 'owner-y/repo-y';
  const reader = routedGhApiReader([
    [`repos/${repository}/pulls/303`, { ok: true, value: mergedPrJson({
      repository, baseRef: 'staging', mergeCommitSha: SHA_MERGE,
    }) }],
    [`repos/${repository}`, { ok: true, value: { full_name: repository, default_branch: '' } }],
  ]);
  const evidence = resolvePrerequisiteEvidence({ repository, pr: 303 }, { ghApiReader: reader });
  equal(evidence.ok, true, 'incomplete default-branch metadata is a reported, non-throwing evidence shape');
  equal(evidence.onMain, false, 'an unavailable default branch name is never treated as onMain');
  equal(evidence.code, 'PREREQUISITE_DEFAULT_BRANCH_UNAVAILABLE', 'the resolver names the exact missing evidence');
}

{
  // Untrusted/ambiguous source identity in the repository metadata response
  // (a different full_name than the declared repository) must fail closed
  // exactly like the existing PR-level source-mismatch check.
  const repository = 'owner-y/repo-y';
  const reader = routedGhApiReader([
    [`repos/${repository}/pulls/303`, { ok: true, value: mergedPrJson({
      repository, baseRef: 'staging', mergeCommitSha: SHA_MERGE,
    }) }],
    [`repos/${repository}`, { ok: true, value: { full_name: 'someone-else/forked-repo-y', default_branch: 'main' } }],
  ]);
  const evidence = resolvePrerequisiteEvidence({ repository, pr: 303 }, { ghApiReader: reader });
  equal(evidence.ok, false, 'an ambiguous repository identity in the default-branch lookup fails closed');
  equal(evidence.code, 'PREREQUISITE_SOURCE_MISMATCH', 'repository identity mismatch is named explicitly');
  equal(evidence.onMain, false, 'an untrusted repository identity is never treated as onMain');
}

{
  // The intermediate-branch false-positive, run end-to-end through
  // selectDependencyAwareCandidate using the live resolver (not a stub),
  // must keep the dependent candidate on WAIT_DEPENDENCY.
  const repository = 'owner-y/repo-y';
  const reader = routedGhApiReader([
    [`repos/${repository}/pulls/303`, { ok: true, value: mergedPrJson({
      repository, baseRef: 'staging', mergeCommitSha: SHA_MERGE,
    }) }],
    [`repos/${repository}`, { ok: true, value: { full_name: repository, default_branch: 'main' } }],
    [`repos/${repository}/branches/main`, { ok: true, value: { commit: { sha: SHA_STALE_MAIN } } }],
    [`repos/${repository}/compare/${SHA_MERGE}...${SHA_STALE_MAIN}`, { ok: true, value: { status: 'diverged' } }],
  ]);
  const dependent = candidate({
    id: 'candidate-b',
    prerequisites: [{ repository, pr: 303 }],
    task: orchestrationTask({ taskId: 'task-b' }),
  });
  const { selected, checkpoints } = selectDependencyAwareCandidate(
    request({ candidates: [dependent] }),
    alignedFocus().currentFocus,
    (identifier) => resolvePrerequisiteEvidence(identifier, { ghApiReader: reader }),
  );
  equal(selected, null, 'a prerequisite merged only on an intermediate branch must never make the dependent eligible');
  equal(checkpoints[0].waitingOn[0].code, 'PREREQUISITE_MAIN_STALE',
    'the live resolver end-to-end reports the honest stale-main code through the dependency checkpoint');
  equal(checkpoints[0].nextTrigger, `${repository}#303 must become merged=true and reachable from the repository live default branch.`,
    'the checkpoint names the merge-on-default-branch condition for this exact prerequisite');
}

// --- Issue #108: every externally returned response carries a fixed,
// non-judgmental continuation marker so PLAN/HANDOFF/INLINE COMPLETED/STOP
// can never masquerade as a human terminal state. The marker's field names
// and semantics mirror stagnation-watch.mjs's own canonical contract
// (terminalState / responseMayTerminate / turnCloseReceipt / handoffClass);
// stagnation-watch remains the sole authority that ever computes a
// non-AI_CONTINUES value for these fields.

function expectContinuationMarker(result, message) {
  equal(result.terminalState, 'AI_CONTINUES', `${message}: terminalState must be AI_CONTINUES`);
  equal(result.responseMayTerminate, false, `${message}: responseMayTerminate must be false`);
  equal(result.turnCloseReceipt, null, `${message}: turnCloseReceipt must be null`);
  equal(result.handoffClass, 'AI_OWNED', `${message}: handoffClass must be AI_OWNED`);
}

{
  // Non-terminal PLAN: selection only, never a human terminal state.
  const result = runAgentCycle(request({ mode: 'PLAN' }), {
    observeFocus: () => alignedFocus(),
  });
  equal(result.result, 'PLANNED', 'PLAN still selects as before');
  expectContinuationMarker(result, 'PLANNED');
}

{
  // LONG_TASK HANDOFF is to an AI runner, never a human, and must not
  // masquerade as a human terminal state either.
  const result = runAgentCycle(request({
    mode: 'EXECUTE',
    candidates: [candidate({ executionMode: 'LONG_TASK' })],
  }), {
    observeFocus: () => alignedFocus(),
  });
  equal(result.result, 'HANDOFF', 'LONG_TASK still hands off as before');
  expectContinuationMarker(result, 'LONG_TASK HANDOFF');
}

{
  // Single-step INLINE COMPLETED already declares verificationRequired:true
  // (it is one bounded step, not pre-merge-ready); the continuation marker
  // must be present alongside it, not instead of it.
  const result = runAgentCycle(request({ mode: 'EXECUTE' }), {
    observeFocus: () => alignedFocus(),
    executeInline: () => ({ result: 'COMPLETED', code: 'OK' }),
  });
  equal(result.result, 'COMPLETED', 'INLINE success still completes one cycle');
  equal(result.verificationRequired, true, 'verificationRequired:true is preserved unchanged');
  expectContinuationMarker(result, 'INLINE COMPLETED');
}

{
  // An ordinary technical STOP (e.g. no eligible candidate) must carry the
  // same marker so it is never read as a human/merge close receipt.
  const result = runAgentCycle(request({
    candidates: [candidate({ expectedNextStep: 'Old step.' })],
  }), {
    observeFocus: () => alignedFocus(),
  });
  equal(result.result, 'STOP', 'ordinary technical STOP still stops as before');
  equal(result.code, 'NO_ELIGIBLE_CANDIDATE', 'ordinary technical STOP code is unchanged');
  expectContinuationMarker(result, 'technical STOP');
}

{
  // The schema-invalid STOP path (returned via the shared stop() helper
  // before any repository I/O) must also carry the marker.
  const result = runAgentCycle(request({ candidates: [candidate({ priority: -1 })] }), {
    observeFocus: () => alignedFocus(),
  });
  equal(result.result, 'STOP', 'schema-invalid STOP still stops as before');
  equal(result.code, 'AGENT_CYCLE_SCHEMA_INVALID', 'schema-invalid STOP code is unchanged');
  expectContinuationMarker(result, 'schema-invalid STOP');
}

process.stdout.write(`agent-cycle-selftest: PASS (${assertions} assertions)\n`);
