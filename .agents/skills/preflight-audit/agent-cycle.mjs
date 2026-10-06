#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  runImplementationOrchestration,
  validateOrchestrationTask,
} from './implementation-orchestrator.mjs';
import { readBoundedTaskInput } from './implementation-runner.mjs';

const SCHEMA_VERSION = 1;
const MODES = new Set(['PLAN', 'EXECUTE']);
const EXECUTION_MODES = new Set(['INLINE', 'LONG_TASK']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'repoRoot', 'branch', 'goalId', 'mode', 'candidates',
]);
const CANDIDATE_KEYS = new Set([
  'id', 'priority', 'blocked', 'goalId', 'expectedNextStep',
  'executionMode', 'task', 'onSuccessNextStep',
]);

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

function stop(code, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'STOP',
    code,
    ...extra,
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

export function selectCandidate(payload, currentFocus) {
  const eligible = payload.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.blocked === false)
    .filter(({ candidate }) => candidate.goalId === payload.goalId)
    .filter(({ candidate }) => candidate.expectedNextStep === currentFocus.nextStep)
    .sort((a, b) => (a.candidate.priority - b.candidate.priority) || (a.index - b.index));

  return eligible[0]?.candidate ?? null;
}

export function runAgentCycle(payload, dependencies = {}) {
  const schemaErrors = validateAgentCycleRequest(payload);
  if (schemaErrors.length > 0) return stop('AGENT_CYCLE_SCHEMA_INVALID', { schemaErrors });

  const observeFocus = dependencies.observeFocus ?? observeCurrentFocus;
  const executeInline = dependencies.executeInline ?? runImplementationOrchestration;
  const advanceFocus = dependencies.advanceFocus ?? advanceCurrentFocus;

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

  const selected = selectCandidate(payload, currentFocus);
  if (!selected) {
    return stop('NO_ELIGIBLE_CANDIDATE', {
      goalId: payload.goalId,
      currentNextStep: currentFocus.nextStep ?? null,
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
    };
  }

  const execution = executeInline(selected.task);
  if (execution?.result !== 'COMPLETED') {
    return stop('INLINE_EXECUTION_FAILED', {
      goalId: payload.goalId,
      selected: selection,
      execution: execution ?? null,
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
