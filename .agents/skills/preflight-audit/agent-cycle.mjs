#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  runImplementationOrchestration,
  runStagnationCheckpoint,
  validateOrchestrationTask,
} from './implementation-orchestrator.mjs';
import { readBoundedTaskInput } from './implementation-runner.mjs';

const SCHEMA_VERSION = 1;
const MODES = new Set(['PLAN', 'EXECUTE']);
const EXECUTION_MODES = new Set(['INLINE', 'LONG_TASK']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'repoRoot', 'branch', 'goalId', 'mode', 'candidates',
]);
// 'prerequisites' and 'pullRequest' are an optional, bounded, generic
// prerequisite-chain extension (A -> B -> C ...). They never carry any
// project-specific identifier: every candidate still works unchanged when
// neither key is present.
const CANDIDATE_KEYS = new Set([
  'id', 'priority', 'blocked', 'goalId', 'expectedNextStep',
  'executionMode', 'task', 'onSuccessNextStep', 'prerequisites', 'pullRequest',
]);
const MAX_PREREQUISITES = 5;
const REPO_TOKEN_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_IDENTIFIER_KEYS = new Set(['repository', 'pr']);
const SHA40_RE = /^[0-9a-f]{40}$/;
const GITHUB_PREREQUISITE_TIMEOUT_MS = 10_000;

// Canonical, fixed, non-judgmental continuation marker. runAgentCycle never
// decides pause/stagnation state itself -- that judgment belongs solely to
// stagnation-watch.mjs (the one canonical authority for AI_CONTINUES vs a
// permitted human/merge close receipt). Every response this module returns
// externally (PLANNED, HANDOFF, INLINE COMPLETED, and every technical STOP)
// is, by construction, never itself a human-authorized turn-closing event:
// PLANNED only selects, LONG_TASK HANDOFF hands off to an AI runner (not a
// human), INLINE COMPLETED is one bounded step still carrying
// verificationRequired:true, and every STOP here is a technical/schema/
// dependency outcome, not a reviewed human decision or an exact-HEAD
// independent final PR audit. Stamping this fixed, same-shaped marker (field
// names/semantics match stagnation-watch's own terminalState /
// responseMayTerminate / turnCloseReceipt / handoffClass contract) lets any
// caller mechanically detect "this response must not be treated as a human
// terminal state" without re-deriving or duplicating stagnation-watch's own
// pause/stagnation judgment, and without this file gaining a second
// stagnation gate or intercepting any external chat UI.
const AI_CYCLE_CONTINUATION_MARKER = Object.freeze({
  terminalState: 'AI_CONTINUES',
  responseMayTerminate: false,
  turnCloseReceipt: null,
  handoffClass: 'AI_OWNED',
});

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}

function branchToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value);
}

function cleanText(value, max = 2000) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function closedObject(value, allowedKeys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key));
}

// A bounded, uniquely identified prerequisite GitHub PR descriptor:
// repository ("owner/name") + a positive PR number. This is the entire
// generic representation used for an A -> B -> C prerequisite chain -- no
// project-specific identifier is ever hard-coded here.
function validPrIdentifier(value) {
  return closedObject(value, PR_IDENTIFIER_KEYS)
    && REPO_TOKEN_RE.test(value.repository ?? '')
    && Number.isSafeInteger(value.pr) && value.pr > 0 && value.pr < 1_000_000_000;
}

function prIdentifierKey(value) {
  return `${value.repository}#${value.pr}`;
}

// Detects a representable prerequisite cycle across the whole candidate set.
// A cycle is only representable when a candidate declares both its own
// `pullRequest` identity and a `prerequisites` edge; self-reference (a
// candidate listing its own pullRequest as a prerequisite) is caught by the
// per-candidate duplicate check below and also collapses to a 1-node cycle
// here. This never assumes any specific repository or PR number.
function detectPrerequisiteCycles(candidates) {
  const indexesByKey = new Map();
  candidates.forEach((candidate, index) => {
    if (!validPrIdentifier(candidate.pullRequest)) return;
    const key = prIdentifierKey(candidate.pullRequest);
    if (!indexesByKey.has(key)) indexesByKey.set(key, []);
    indexesByKey.get(key).push(index);
  });

  const edges = new Map();
  candidates.forEach((candidate) => {
    if (!validPrIdentifier(candidate.pullRequest) || !Array.isArray(candidate.prerequisites)) return;
    const fromKey = prIdentifierKey(candidate.pullRequest);
    const toKeys = candidate.prerequisites
      .filter((item) => validPrIdentifier(item))
      .map((item) => prIdentifierKey(item));
    edges.set(fromKey, toKeys);
  });

  const state = new Map();
  const cycleKeys = new Set();
  function visit(key, stack) {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) {
      const start = stack.indexOf(key);
      stack.slice(start).forEach((item) => cycleKeys.add(item));
      return;
    }
    state.set(key, 1);
    stack.push(key);
    for (const next of edges.get(key) ?? []) visit(next, stack);
    stack.pop();
    state.set(key, 2);
  }
  for (const key of edges.keys()) visit(key, []);

  const affectedIndexes = new Set();
  cycleKeys.forEach((key) => (indexesByKey.get(key) ?? []).forEach((index) => affectedIndexes.add(index)));
  return affectedIndexes;
}

function stop(code, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'STOP',
    code,
    ...extra,
    // Placed last so no caller-supplied `extra` can ever mask the fixed
    // non-terminal marker: every technical STOP from this module stays
    // mechanically distinguishable from a human-authorized turn close.
    ...AI_CYCLE_CONTINUATION_MARKER,
  };
}

export function validateAgentCycleRequest(payload) {
  if (!closedObject(payload, TOP_LEVEL_KEYS)) return ['payload_schema_invalid'];
  const errors = [];
  if (payload.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion_invalid');
  if (!cleanText(payload.repoRoot, 2000)) errors.push('repoRoot_invalid');
  if (!branchToken(payload.branch)) errors.push('branch_invalid');
  if (!safeToken(payload.goalId)) errors.push('goalId_invalid');
  if (!MODES.has(payload.mode)) errors.push('mode_invalid');
  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    errors.push('candidates_invalid');
    return errors;
  }

  payload.candidates.forEach((candidate, index) => {
    const prefix = `candidate_${index}`;
    if (!closedObject(candidate, CANDIDATE_KEYS)) {
      errors.push(`${prefix}_schema_invalid`);
      return;
    }
    if (!safeToken(candidate.id)) errors.push(`${prefix}_id_invalid`);
    if (!Number.isInteger(candidate.priority) || candidate.priority < 0 || candidate.priority > 1_000_000) {
      errors.push(`${prefix}_priority_invalid`);
    }
    if (typeof candidate.blocked !== 'boolean') errors.push(`${prefix}_blocked_invalid`);
    if (!safeToken(candidate.goalId)) errors.push(`${prefix}_goalId_invalid`);
    if (!cleanText(candidate.expectedNextStep, 1200)) errors.push(`${prefix}_expectedNextStep_invalid`);
    if (!EXECUTION_MODES.has(candidate.executionMode)) errors.push(`${prefix}_executionMode_invalid`);
    if (candidate.onSuccessNextStep !== undefined && candidate.onSuccessNextStep !== null
      && !cleanText(candidate.onSuccessNextStep, 1200)) {
      errors.push(`${prefix}_onSuccessNextStep_invalid`);
    }

    const taskErrors = validateOrchestrationTask(candidate.task);
    if (taskErrors.length > 0) errors.push(`${prefix}_task_invalid:${taskErrors.join(',')}`);
    if (candidate.task?.repoRoot !== payload.repoRoot) errors.push(`${prefix}_task_repoRoot_mismatch`);
    if (candidate.task?.branch !== payload.branch) errors.push(`${prefix}_task_branch_mismatch`);

    let candidatePrKey = null;
    if (candidate.pullRequest !== undefined) {
      if (!validPrIdentifier(candidate.pullRequest)) errors.push(`${prefix}_pullRequest_invalid`);
      else candidatePrKey = prIdentifierKey(candidate.pullRequest);
    }

    if (candidate.prerequisites !== undefined) {
      const list = candidate.prerequisites;
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PREREQUISITES
        || !list.every((item) => validPrIdentifier(item))) {
        errors.push(`${prefix}_prerequisites_invalid`);
      } else {
        const keys = list.map((item) => prIdentifierKey(item));
        if (new Set(keys).size !== keys.length) errors.push(`${prefix}_prerequisites_duplicate`);
        if (candidatePrKey && keys.includes(candidatePrKey)) errors.push(`${prefix}_prerequisites_self_cycle`);
      }
    }
  });

  detectPrerequisiteCycles(payload.candidates).forEach((index) => {
    errors.push(`candidate_${index}_prerequisites_cycle`);
  });

  return errors;
}

function workingMemoryScript(repoRoot) {
  return join(
    resolve(repoRoot),
    '.agents',
    'skills',
    'handoff',
    'project-working-memory.mjs',
  );
}

function runWorkingMemoryCli(repoRoot, args) {
  const script = workingMemoryScript(repoRoot);
  if (!existsSync(script)) return { ok: false, code: 'WORKING_MEMORY_SCRIPT_MISSING' };

  const child = spawnSync(process.execPath, [script, ...args], {
    cwd: resolve(repoRoot),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(String(child.stdout ?? '').trim());
  } catch {
    return {
      ok: false,
      code: 'WORKING_MEMORY_OUTPUT_INVALID',
      exitCode: child.status,
    };
  }

  if (child.error || child.status !== 0 || parsed?.ok !== true) {
    return {
      ok: false,
      code: parsed?.code ?? 'WORKING_MEMORY_COMMAND_FAILED',
      exitCode: child.status,
      detail: parsed,
    };
  }

  return { ok: true, code: parsed.code, detail: parsed };
}

export function observeCurrentFocus(repoRoot, goalId) {
  const root = resolve(repoRoot);
  const contextFile = join(root, 'PROJECT_CONTEXT.json');

  const focusGate = runWorkingMemoryCli(root, [
    '--action', 'focus-gate',
    '--root', root,
    '--context-file', contextFile,
    '--input-json', JSON.stringify({
      goalId,
      requireApprovedReference: false,
    }),
  ]);
  if (!focusGate.ok) return focusGate;

  const snapshot = runWorkingMemoryCli(root, [
    '--action', 'snapshot',
    '--root', root,
    '--context-file', contextFile,
  ]);
  if (!snapshot.ok) return snapshot;

  const currentFocus = focusGate.detail?.currentFocus;
  if (!currentFocus || currentFocus.goalId !== goalId) {
    return { ok: false, code: 'CURRENT_FOCUS_INVALID' };
  }
  if (snapshot.detail?.currentGoalId !== goalId) {
    return { ok: false, code: 'WORKING_MEMORY_SNAPSHOT_GOAL_MISMATCH' };
  }
  if (snapshot.detail?.nextStep !== currentFocus.nextStep) {
    return { ok: false, code: 'WORKING_MEMORY_SNAPSHOT_DRIFT' };
  }

  return {
    ok: true,
    code: 'CURRENT_FOCUS_ALIGNED',
    currentFocus,
    snapshot: snapshot.detail,
  };
}

export function advanceCurrentFocus(repoRoot, currentFocus, nextStep) {
  const root = resolve(repoRoot);
  const contextFile = join(root, 'PROJECT_CONTEXT.json');
  const normalizedNextStep = cleanText(nextStep, 1200);
  if (!normalizedNextStep) return { ok: false, code: 'NEXT_STEP_INVALID' };

  const input = {
    goalId: currentFocus.goalId,
    goal: currentFocus.goal,
    goalSource: currentFocus.goalSource,
    nextStep: normalizedNextStep,
    approvedReferenceId: currentFocus.approvedReferenceId ?? null,
    decisionId: currentFocus.decisionId ?? null,
  };

  const updated = runWorkingMemoryCli(root, [
    '--action', 'set-focus',
    '--root', root,
    '--context-file', contextFile,
    '--input-json', JSON.stringify(input),
  ]);
  if (!updated.ok) return updated;

  return {
    ok: true,
    code: 'CURRENT_FOCUS_ADVANCED',
    currentFocus: updated.detail?.currentFocus ?? null,
  };
}

function focusEligibleCandidates(payload, currentFocus) {
  return payload.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.blocked === false)
    .filter(({ candidate }) => candidate.goalId === payload.goalId)
    .filter(({ candidate }) => candidate.expectedNextStep === currentFocus.nextStep)
    .sort((a, b) => (a.candidate.priority - b.candidate.priority) || (a.index - b.index));
}

export function selectCandidate(payload, currentFocus) {
  return focusEligibleCandidates(payload, currentFocus)[0]?.candidate ?? null;
}

function runGhApiJson(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: GITHUB_PREREQUISITE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, code: 'PREREQUISITE_GITHUB_QUERY_FAILED' };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ''));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'PREREQUISITE_GITHUB_RESPONSE_INVALID' };
  }
  return { ok: true, value: parsed };
}

// Isolated, bounded, read-only live PR status resolver injected at the
// agent-cycle boundary. Never trusts a caller-asserted "merged" claim, and
// never trusts the PR's own `base.ref` as "the default branch": a PR may be
// merged into an intermediate feature/staging branch while the repository's
// actual default/main branch remains unreached. The live default branch
// name is independently discovered from the SAME repository's own
// authenticated metadata (`repos/{repository}`) -- never inferred from this
// PR or from any caller input -- and the merge commit is only accepted once
// it is proven identical to, or an ancestor of, that LIVE default branch
// head. Every read is routed through the injectable `ghApiReader` seam
// (defaulting to the real bounded `gh` CLI call) so tests can exercise the
// exact branch-selection logic without any live network access. All reads
// stay strictly bounded by GITHUB_PREREQUISITE_TIMEOUT_MS. Any incomplete,
// ambiguous, stale, untrusted-identity, or source-mismatched evidence
// resolves to a non-satisfied status so the caller fails closed (never RUN).
export function resolvePrerequisiteEvidence(identifier, dependencies = {}) {
  const ghApiReader = dependencies.ghApiReader ?? runGhApiJson;
  if (!validPrIdentifier(identifier)) {
    return { ok: false, code: 'PREREQUISITE_IDENTIFIER_INVALID', merged: false, onMain: false };
  }
  const { repository, pr } = identifier;

  const prResult = ghApiReader(['api', `repos/${repository}/pulls/${pr}`]);
  if (!prResult.ok) return { ...prResult, merged: false, onMain: false };
  const prJson = prResult.value;

  const observedRepository = typeof prJson?.base?.repo?.full_name === 'string'
    ? prJson.base.repo.full_name
    : null;
  if (observedRepository !== repository) {
    return { ok: false, code: 'PREREQUISITE_SOURCE_MISMATCH', merged: false, onMain: false };
  }

  const state = String(prJson.state ?? '').toLowerCase();
  const merged = prJson.merged === true;
  const mergeCommitSha = typeof prJson.merge_commit_sha === 'string'
    ? prJson.merge_commit_sha.toLowerCase()
    : null;
  // `baseRef` (the PR's merge-target branch) is retained ONLY as diagnostic
  // context in the returned evidence. It is NEVER used below to decide
  // onMain: the PR may legitimately target an intermediate branch, and only
  // the repository's own live default branch head decides eligibility.
  const baseRef = typeof prJson.base?.ref === 'string' ? prJson.base.ref : null;

  if (!merged) {
    return {
      ok: true,
      merged: false,
      onMain: false,
      state,
      code: state === 'closed' ? 'PREREQUISITE_CLOSED_UNMERGED' : 'PREREQUISITE_NOT_MERGED',
    };
  }
  if (!baseRef || !SHA40_RE.test(mergeCommitSha ?? '')) {
    return { ok: true, merged: true, onMain: false, state, code: 'PREREQUISITE_MERGE_EVIDENCE_INCOMPLETE' };
  }

  const repoResult = ghApiReader(['api', `repos/${repository}`]);
  if (!repoResult.ok) return { ...repoResult, merged: true, onMain: false, state, baseRef };
  const repoJson = repoResult.value;
  const observedRepositoryIdentity = typeof repoJson?.full_name === 'string' ? repoJson.full_name : null;
  if (observedRepositoryIdentity !== repository) {
    return {
      ok: false, code: 'PREREQUISITE_SOURCE_MISMATCH', merged: true, onMain: false, state, baseRef,
    };
  }
  const defaultBranch = repoJson?.default_branch;
  if (!branchToken(defaultBranch)) {
    return {
      ok: true, merged: true, onMain: false, state, baseRef, code: 'PREREQUISITE_DEFAULT_BRANCH_UNAVAILABLE',
    };
  }

  const branchResult = ghApiReader(['api', `repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`]);
  if (!branchResult.ok) return { ...branchResult, merged: true, onMain: false, state, baseRef, defaultBranch };
  const liveMainSha = typeof branchResult.value?.commit?.sha === 'string'
    ? branchResult.value.commit.sha.toLowerCase()
    : null;
  if (!SHA40_RE.test(liveMainSha ?? '')) {
    return {
      ok: true, merged: true, onMain: false, state, baseRef, defaultBranch, code: 'PREREQUISITE_MAIN_SHA_INVALID',
    };
  }

  if (liveMainSha === mergeCommitSha) {
    return {
      ok: true, merged: true, onMain: true, state, code: 'PREREQUISITE_MERGED_ON_MAIN',
      baseRef, defaultBranch, mergeCommitSha, liveMainSha,
    };
  }

  const compareResult = ghApiReader(['api', `repos/${repository}/compare/${mergeCommitSha}...${liveMainSha}`]);
  if (!compareResult.ok) return { ...compareResult, merged: true, onMain: false, state, baseRef, defaultBranch };
  const compareStatus = String(compareResult.value?.status ?? '');
  // base=mergeCommitSha, head=liveMainSha: "ahead" or "identical" means
  // mergeCommitSha is an ancestor of (already contained in) the LIVE
  // default/main branch head -- not merely the PR's own base branch.
  const onMain = compareStatus === 'identical' || compareStatus === 'ahead';
  return {
    ok: true,
    merged: true,
    onMain,
    state,
    code: onMain ? 'PREREQUISITE_MERGED_ON_MAIN' : 'PREREQUISITE_MAIN_STALE',
    baseRef,
    defaultBranch,
    mergeCommitSha,
    liveMainSha,
    compareStatus,
  };
}

// Honest, machine-readable description of what must become true before a
// waiting candidate can ever become eligible again: each unmet prerequisite
// must reach merged=true AND become reachable from the repository's LIVE
// default branch -- never a restatement of the unrelated working-memory
// focus string.
function describeWaitDependencyTrigger(waiting) {
  if (!Array.isArray(waiting) || waiting.length === 0) {
    return 'All declared prerequisites must become merged=true and reachable from the repository live default branch.';
  }
  return waiting
    .map(({ prerequisite }) => (validPrIdentifier(prerequisite)
      ? `${prerequisite.repository}#${prerequisite.pr} must become merged=true and reachable from the repository live default branch.`
      : 'An unresolved prerequisite must become merged=true and reachable from the repository live default branch.'))
    .join(' ');
}

function evaluateCandidateDependency(candidate, resolvePrerequisite) {
  const list = Array.isArray(candidate.prerequisites) ? candidate.prerequisites : [];
  if (list.length === 0) return { ready: true, waiting: [] };

  const waiting = [];
  for (const identifier of list) {
    let evidence;
    try {
      evidence = resolvePrerequisite(identifier);
    } catch {
      evidence = null;
    }
    const satisfied = evidence?.ok === true && evidence.merged === true && evidence.onMain === true;
    if (!satisfied) {
      waiting.push({
        prerequisite: identifier,
        code: evidence?.code ?? 'PREREQUISITE_EVIDENCE_UNAVAILABLE',
        evidence: evidence ?? null,
      });
    }
  }
  return { ready: waiting.length === 0, waiting };
}

// Dependency-aware selection: reuses the exact same focus-eligible ordering
// as selectCandidate, but skips (never RUNs) any candidate whose declared
// prerequisites are not yet verifiably merged-and-on-main, recording a
// machine-readable checkpoint for each skipped candidate and letting an
// independent eligible candidate proceed instead. A candidate without a
// `prerequisites` declaration behaves exactly as before.
export function selectDependencyAwareCandidate(payload, currentFocus, resolvePrerequisite = resolvePrerequisiteEvidence) {
  const checkpoints = [];
  for (const { candidate } of focusEligibleCandidates(payload, currentFocus)) {
    const dependency = evaluateCandidateDependency(candidate, resolvePrerequisite);
    if (dependency.ready) {
      return { selected: candidate, checkpoints };
    }
    checkpoints.push({
      candidateId: candidate.id,
      goalId: candidate.goalId,
      code: 'WAIT_DEPENDENCY',
      nextTrigger: describeWaitDependencyTrigger(dependency.waiting),
      waitingOn: dependency.waiting,
    });
  }
  return { selected: null, checkpoints };
}

export function runAgentCycle(payload, dependencies = {}) {
  const schemaErrors = validateAgentCycleRequest(payload);
  if (schemaErrors.length > 0) return stop('AGENT_CYCLE_SCHEMA_INVALID', { schemaErrors });

  const observeFocus = dependencies.observeFocus ?? observeCurrentFocus;
  // agent-cycle EXECUTE calls the exported implementation function directly,
  // bypassing implementation-orchestrator.mjs CLI main(). Reuse the existing
  // HEAD-bound watcher before advancing working memory.
  const executeInline = dependencies.executeInline ?? ((task) => {
    const implementation = runImplementationOrchestration(task);
    if (validateOrchestrationTask(task).length !== 0) return implementation;
    const stagnationCheckpoint = runStagnationCheckpoint(
      { repoRoot: task.repoRoot, taskId: task.taskId }, implementation,
    );
    return { ...implementation, stagnationCheckpoint };
  });
  const advanceFocus = dependencies.advanceFocus ?? advanceCurrentFocus;
  const resolvePrerequisite = dependencies.resolvePrerequisite ?? resolvePrerequisiteEvidence;

  const focus = observeFocus(payload.repoRoot, payload.goalId);
  if (!focus?.ok) {
    return stop(focus?.code ?? 'CURRENT_FOCUS_UNAVAILABLE', {
      focusEvidence: focus ?? null,
    });
  }

  const currentFocus = focus.currentFocus;
  if (!currentFocus || currentFocus.goalId !== payload.goalId) {
    return stop('CURRENT_GOAL_MISMATCH');
  }

  const { selected, checkpoints: dependencyCheckpoints } = selectDependencyAwareCandidate(
    payload, currentFocus, resolvePrerequisite,
  );
  if (!selected) {
    // A WAIT_DEPENDENCY checkpoint on one candidate is never terminal for
    // the whole cycle; it is only reached here when no other independent
    // eligible candidate was available in this same cycle either.
    return stop(dependencyCheckpoints.length > 0 ? 'WAIT_DEPENDENCY' : 'NO_ELIGIBLE_CANDIDATE', {
      goalId: payload.goalId,
      currentNextStep: currentFocus.nextStep ?? null,
      dependencyCheckpoints,
    });
  }

  const selection = {
    id: selected.id,
    priority: selected.priority,
    executionMode: selected.executionMode,
    taskId: selected.task.taskId,
    expectedNextStep: selected.expectedNextStep,
    onSuccessNextStep: selected.onSuccessNextStep ?? null,
  };

  if (payload.mode === 'PLAN') {
    return {
      schemaVersion: SCHEMA_VERSION,
      result: 'PLANNED',
      code: 'AGENT_CYCLE_TASK_SELECTED',
      goalId: payload.goalId,
      currentNextStep: currentFocus.nextStep,
      selected: selection,
      orchestrationTask: selected.task,
      dependencyCheckpoints,
      ...AI_CYCLE_CONTINUATION_MARKER,
    };
  }

  if (selected.executionMode === 'LONG_TASK') {
    return {
      schemaVersion: SCHEMA_VERSION,
      result: 'HANDOFF',
      code: 'LONG_TASK_HANDOFF_REQUIRED',
      goalId: payload.goalId,
      currentNextStep: currentFocus.nextStep,
      selected: selection,
      orchestrationTask: selected.task,
      authority: {
        autoMerge: false,
        autoPush: false,
        newPaidRoute: false,
      },
      dependencyCheckpoints,
      ...AI_CYCLE_CONTINUATION_MARKER,
    };
  }

  const execution = executeInline(selected.task);
  if (execution?.result !== 'COMPLETED' || execution?.stagnationCheckpoint?.ok === false) {
    return stop('INLINE_EXECUTION_FAILED', {
      goalId: payload.goalId,
      selected: selection,
      execution: execution ?? null,
      dependencyCheckpoints,
    });
  }

  let focusAdvance = null;
  if (selected.onSuccessNextStep) {
    focusAdvance = advanceFocus(payload.repoRoot, currentFocus, selected.onSuccessNextStep);
    if (!focusAdvance?.ok) {
      return stop('WORKING_MEMORY_ADVANCE_FAILED', {
        goalId: payload.goalId,
        selected: selection,
        execution,
        focusAdvance: focusAdvance ?? null,
        dependencyCheckpoints,
      });
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'COMPLETED',
    code: 'AGENT_CYCLE_INLINE_COMPLETED',
    goalId: payload.goalId,
    selected: selection,
    execution,
    focusAdvance,
    verificationRequired: true,
    dependencyCheckpoints,
    ...AI_CYCLE_CONTINUATION_MARKER,
  };
}

async function main() {
  try {
    const raw = await readBoundedTaskInput(process.stdin);
    const payload = JSON.parse(raw);
    const result = runAgentCycle(payload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = ['PLANNED', 'HANDOFF', 'COMPLETED'].includes(result.result) ? 0 : 2;
  } catch (error) {
    const code = ['INPUT_TOO_LARGE', 'INPUT_TIMEOUT', 'INPUT_STREAM_ERROR'].includes(error?.code)
      ? error.code
      : 'AGENT_CYCLE_INPUT_INVALID';
    process.stdout.write(`${JSON.stringify(stop(code))}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(stop('AGENT_CYCLE_INTERNAL_ERROR'))}\n`);
    process.exitCode = 2;
  });
}
