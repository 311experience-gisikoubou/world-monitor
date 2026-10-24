#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readBoundedTaskInput } from './implementation-runner.mjs';
import { validateResearchEnvelopeShape, evaluateResearchEnvelope, blocksSourceWrite } from './research-gate.mjs';
import { validateInstructionClarityInput, evaluateInstructionClarity } from './instruction-clarity-gate.mjs';

// `../project-intake/project-intake-gate.mjs` (and its own transitive
// chain: implementation-orchestrator.mjs, human-decision-sync.mjs, ...) is
// only needed by the PREPARE path's default renderer below. The bounded
// read-only `--extract-research-envelope` CLI mode (and any caller that
// supplies its own `renderTask`) never needs it, so it is loaded lazily and
// synchronously here instead of as a top-level static import, which would
// otherwise force every invocation of this file -- including the extract-
// only mode -- to resolve that entire dependency graph.
const require = createRequire(import.meta.url);
function defaultRenderTask(taskPayload) {
  const { renderPollerIssueFromTask } = require('../project-intake/project-intake-gate.mjs');
  return renderPollerIssueFromTask(taskPayload);
}

const SCHEMA_VERSION = 1;
const META_TAG = 'AGENT_CYCLE_JOB_V1';
const RESEARCH_META_TAG = 'AGENT_CYCLE_JOB_RESEARCH_V1';
const ACTIONS = new Set(['PREPARE', 'RESUME']);
const PREPARE_KEYS = new Set(['schemaVersion', 'action', 'cycleResult']);
const RESUME_KEYS = new Set(['schemaVersion', 'action', 'currentFocus', 'workState', 'issueBody']);
// Every real runAgentCycle() EXECUTE/LONG_TASK HANDOFF result (agent-
// cycle.mjs) now also carries `dependencyCheckpoints` (the prerequisite-
// chain checkpoint list -- unused here, forwarded as inert data only) and
// the fixed, non-judgmental `AI_CYCLE_CONTINUATION_MARKER` (terminalState /
// responseMayTerminate / turnCloseReceipt / handoffClass). Both are closed-
// object members of the ACTUAL cycle shape this bridge receives, so both
// must be accepted here -- never stripped silently and never re-derived --
// or every genuine HANDOFF cycle fails closed on cycle_schema_invalid before
// the marker itself can even be checked below.
const CYCLE_KEYS = new Set([
  'schemaVersion', 'result', 'code', 'goalId', 'currentNextStep',
  'selected', 'orchestrationTask', 'authority', 'dependencyCheckpoints',
  'terminalState', 'responseMayTerminate', 'turnCloseReceipt', 'handoffClass',
]);
// The exact, fixed, non-judgmental continuation marker agent-cycle.mjs
// stamps on every HANDOFF (and every other non-terminal) result. This
// bridge never decides pause/stagnation/terminal state itself -- that
// judgment belongs solely to stagnation-watch.mjs -- so this is NOT a
// second stagnation gate; it only mechanically REQUIRES the one safe,
// fixed, already-defined marker shape to be present verbatim on every real
// HANDOFF cycle it accepts. An absent, partial (some-but-not-all keys), or
// mismatched/forged marker (e.g. a smuggled terminalState other than
// 'AI_CONTINUES', or responseMayTerminate:true) must fail closed here
// instead of ever being treated as, or silently reclassified toward, a
// human-approved/PRE_MERGE_READY/auto-merge terminal state.
const CYCLE_CONTINUATION_MARKER = Object.freeze({
  terminalState: 'AI_CONTINUES',
  responseMayTerminate: false,
  turnCloseReceipt: null,
  handoffClass: 'AI_OWNED',
});
const CYCLE_CONTINUATION_MARKER_KEYS = Object.keys(CYCLE_CONTINUATION_MARKER);
const SELECTED_KEYS = new Set([
  'id', 'priority', 'executionMode', 'taskId', 'expectedNextStep', 'onSuccessNextStep',
]);
const AUTHORITY_KEYS = new Set(['autoMerge', 'autoPush', 'newPaidRoute']);
const FOCUS_KEYS = new Set([
  'goalId', 'goal', 'goalSource', 'nextStep', 'approvedReferenceId', 'decisionId', 'recordedAt',
]);
const WORK_STATE_KEYS = new Set([
  'repository', 'issue', 'executor', 'objective', 'scope', 'prohibitions',
  'branch', 'worktree', 'head', 'workingTree', 'jobId', 'stage', 'outcome',
  'humanDecision', 'evidence', 'testResult', 'nextAction', 'sources',
]);
const HUMAN_DECISION_KEYS = new Set(['required', 'reason']);
const WORK_STAGES = new Set(['QUEUED', 'IMPLEMENTING', 'REVIEW', 'FAILED', 'DONE', 'CONFLICT']);

function closedObject(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function stop(code, extra = {}) {
  return { schemaVersion: SCHEMA_VERSION, result: 'STOP', code, ...extra };
}

function ownership() {
  return {
    selectionAndExecution: 'existing-ai-job-poller',
    lifecycleEvidence: 'existing-work-state-report',
    stateStore: 'none-added',
  };
}

function authority() {
  return {
    autoMerge: false,
    autoPush: false,
    newPaidRoute: false,
    scheduledTaskMutation: false,
    windowsPolicyMutation: false,
  };
}

function validateMetadata(meta) {
  const allowed = new Set(['goalId', 'expectedNextStep', 'onSuccessNextStep', 'taskId']);
  if (!closedObject(meta, allowed) || Object.keys(meta).length !== allowed.size) {
    return { ok: false, code: 'CONTINUATION_METADATA_SCHEMA_INVALID' };
  }
  if (!safeToken(meta.goalId) || !safeToken(meta.taskId)) {
    return { ok: false, code: 'CONTINUATION_METADATA_ID_INVALID' };
  }
  if (!cleanText(meta.expectedNextStep, 1200)) {
    return { ok: false, code: 'CONTINUATION_METADATA_NEXT_STEP_INVALID' };
  }
  if (meta.onSuccessNextStep !== null && !cleanText(meta.onSuccessNextStep, 1200)) {
    return { ok: false, code: 'CONTINUATION_METADATA_SUCCESS_STEP_INVALID' };
  }
  return { ok: true, value: meta };
}

export function encodeContinuationMetadata(meta) {
  const validated = validateMetadata(meta);
  if (!validated.ok) return validated;
  const encoded = Buffer.from(JSON.stringify(validated.value), 'utf8').toString('base64url');
  return { ok: true, value: `<!-- ${META_TAG} ${encoded} -->` };
}

export function parseContinuationMetadata(issueBody) {
  if (typeof issueBody !== 'string' || issueBody.length === 0 || issueBody.length > 64 * 1024) {
    return { ok: false, code: 'ISSUE_BODY_INVALID' };
  }
  const markerCount = issueBody.split(META_TAG).length - 1;
  const matches = [...issueBody.matchAll(/<!--\s*AGENT_CYCLE_JOB_V1\s+([A-Za-z0-9_-]+)\s*-->/gu)];
  if (markerCount !== 1 || matches.length !== 1) {
    return { ok: false, code: markerCount > 1 ? 'CONTINUATION_METADATA_DUPLICATE' : 'CONTINUATION_METADATA_MALFORMED' };
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'CONTINUATION_METADATA_DECODE_FAILED' };
  }
  return validateMetadata(parsed);
}

export function parseEmbeddedResearchEnvelope(issueBody) {
  if (typeof issueBody !== 'string' || issueBody.length === 0 || issueBody.length > 64 * 1024) {
    return { ok: false, code: 'ISSUE_BODY_INVALID' };
  }
  const markerCount = issueBody.split(RESEARCH_META_TAG).length - 1;
  const matches = [...issueBody.matchAll(/<!--\s*AGENT_CYCLE_JOB_RESEARCH_V1\s+([A-Za-z0-9_-]+)\s*-->/gu)];
  if (markerCount !== 1 || matches.length !== 1) {
    return { ok: false, code: markerCount > 1 ? 'RESEARCH_ENVELOPE_DUPLICATE' : 'RESEARCH_ENVELOPE_MALFORMED' };
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'RESEARCH_ENVELOPE_DECODE_FAILED' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((key) => key !== 'research' && key !== 'instructionClarity')) {
    return { ok: false, code: 'RESEARCH_ENVELOPE_SCHEMA_INVALID' };
  }
  const researchErrors = validateResearchEnvelopeShape(parsed.research);
  if (researchErrors.length > 0) return { ok: false, code: 'RESEARCH_ENVELOPE_SHAPE_INVALID', errors: researchErrors };
  const clarityErrors = validateInstructionClarityInput(parsed.instructionClarity);
  if (clarityErrors.length > 0) return { ok: false, code: 'RESEARCH_ENVELOPE_INSTRUCTION_CLARITY_INVALID', errors: clarityErrors };
  return { ok: true, value: parsed };
}

function validatePrepareCycle(cycle) {
  if (!closedObject(cycle, CYCLE_KEYS)) return ['cycle_schema_invalid'];
  const errors = [];
  if (cycle.schemaVersion !== 1) errors.push('cycle_schemaVersion_invalid');
  if (cycle.result !== 'HANDOFF') errors.push('cycle_result_invalid');
  if (cycle.code !== 'LONG_TASK_HANDOFF_REQUIRED') errors.push('cycle_code_invalid');
  if (!safeToken(cycle.goalId)) errors.push('cycle_goalId_invalid');
  if (!cleanText(cycle.currentNextStep, 1200)) errors.push('cycle_currentNextStep_invalid');

  if (!closedObject(cycle.selected, SELECTED_KEYS)) errors.push('cycle_selected_schema_invalid');
  else {
    if (cycle.selected.executionMode !== 'LONG_TASK') errors.push('cycle_selected_executionMode_invalid');
    if (!safeToken(cycle.selected.taskId)) errors.push('cycle_selected_taskId_invalid');
    if (!cleanText(cycle.selected.expectedNextStep, 1200)) errors.push('cycle_selected_expectedNextStep_invalid');
    if (cycle.selected.expectedNextStep !== cycle.currentNextStep) errors.push('cycle_selected_nextStep_mismatch');
    if (cycle.selected.onSuccessNextStep !== null && cycle.selected.onSuccessNextStep !== undefined
      && !cleanText(cycle.selected.onSuccessNextStep, 1200)) {
      errors.push('cycle_selected_onSuccessNextStep_invalid');
    }
  }

  if (!closedObject(cycle.authority, AUTHORITY_KEYS)
    || Object.keys(cycle.authority ?? {}).length !== AUTHORITY_KEYS.size) {
    errors.push('cycle_authority_schema_invalid');
  } else if (cycle.authority.autoMerge !== false
    || cycle.authority.autoPush !== false
    || cycle.authority.newPaidRoute !== false) {
    errors.push('cycle_authority_expanded');
  }

  if (!cycle.orchestrationTask || typeof cycle.orchestrationTask !== 'object'
    || Array.isArray(cycle.orchestrationTask)) {
    errors.push('cycle_orchestrationTask_invalid');
  } else if (cycle.selected?.taskId !== cycle.orchestrationTask.taskId) {
    errors.push('cycle_taskId_mismatch');
  }

  // dependencyCheckpoints is always present on a real agent-cycle.mjs
  // HANDOFF (empty array when no candidate has an unmet prerequisite). It
  // is never read or acted on by this bridge -- only forwarded as inert
  // data -- so it is bounded to "array" here rather than given a second,
  // duplicate deep schema already owned by agent-cycle.mjs.
  if (!Array.isArray(cycle.dependencyCheckpoints)) {
    errors.push('cycle_dependencyCheckpoints_invalid');
  }

  // The fixed non-terminal continuation marker must be present verbatim:
  // absent, partial (any one of the four keys missing), or mismatched
  // (forged) all fail the same closed check. This is a structural presence/
  // equality check only -- it never evaluates or re-derives pause/
  // stagnation/terminal judgment itself.
  if (CYCLE_CONTINUATION_MARKER_KEYS.some((key) => !(key in cycle)
    || cycle[key] !== CYCLE_CONTINUATION_MARKER[key])) {
    errors.push('cycle_continuation_marker_invalid');
  }

  return errors;
}

export function prepareAiJobIssue(cycleResult, dependencies = {}) {
  const errors = validatePrepareCycle(cycleResult);
  if (errors.length > 0) return stop('AGENT_JOB_BRIDGE_PREPARE_INVALID', { errors });

  const renderTask = dependencies.renderTask ?? defaultRenderTask;
  const rendered = renderTask(cycleResult.orchestrationTask);
  if (!rendered || rendered.result !== 'PROCEED' || typeof rendered.markdown !== 'string') {
    return stop('AGENT_JOB_BRIDGE_RENDER_FAILED', { render: rendered ?? null });
  }

  // The research/instructionClarity evidence embedding itself now lives in
  // the lower-level Project Intake renderer (project-intake-gate.mjs), so
  // every caller of renderPollerIssueFromTask/renderAiJobIssue -- not only
  // this bridge -- carries it forward, and it is emitted exactly once
  // (never appended a second time here). This remains a hard requirement,
  // not a best-effort echo: a task that reaches this point without
  // schema-valid evidence fails closed rather than letting an injected
  // test/custom renderTask silently substitute an empty/fabricated blob.
  const researchShapeErrors = validateResearchEnvelopeShape(cycleResult.orchestrationTask.research);
  if (researchShapeErrors.length > 0) {
    return stop('AGENT_JOB_BRIDGE_RESEARCH_EVIDENCE_INVALID', { errors: researchShapeErrors });
  }
  const clarityShapeErrors = validateInstructionClarityInput(cycleResult.orchestrationTask.instructionClarity);
  if (clarityShapeErrors.length > 0) {
    return stop('AGENT_JOB_BRIDGE_INSTRUCTION_CLARITY_INVALID', { errors: clarityShapeErrors });
  }

  // Shape-valid evidence is not the same as QUALIFIED evidence: a task must
  // never reach QUEUED on the strength of a well-formed envelope alone. The
  // expected taskId/repository/scope binding is derived strictly from this
  // task's own already-validated orchestrationTask fields -- never from the
  // embedded research.context, which must not be trusted to supply its own
  // expected values. evaluateResearchEnvelope independently recomputes the
  // raw Research Gate evidence against that binding (rejecting a stale,
  // wrong-task/repository/scope/constraints, or otherwise invalid
  // evaluation) and blocksSourceWrite applies the SAME downstream policy the
  // runner uses, so a legitimate ADOPT/BYPASS_LIGHT, or an explicitly
  // authorized bounded synthetic TRIAL, still proceeds while every other
  // outcome (REJECT/STOP/unauthorized TRIAL) fails closed here instead of
  // only at the downstream runner.
  const researchGate = evaluateResearchEnvelope(cycleResult.orchestrationTask.research, {
    taskId: cycleResult.orchestrationTask.taskId,
    repository: cycleResult.orchestrationTask.repository,
    scope: cycleResult.orchestrationTask.allowedScope,
  });
  if (blocksSourceWrite(researchGate, {
    trialWriteMode: cycleResult.orchestrationTask.trialWriteMode,
    dataClass: cycleResult.orchestrationTask.dataClass,
  })) {
    return stop('AGENT_JOB_BRIDGE_RESEARCH_GATE_BLOCKED', { researchGate });
  }

  // Instruction clarity is likewise independently re-evaluated here (never
  // trusted merely because it was shape-valid): an unresolved material
  // ambiguity or an unlisted-assumption flag must stop this task before an
  // Issue/label is ever emitted.
  const instructionClarity = evaluateInstructionClarity(cycleResult.orchestrationTask.instructionClarity);
  if (instructionClarity.result !== 'PROCEED') {
    return stop('AGENT_JOB_BRIDGE_INSTRUCTION_CLARITY_NOT_CONFIRMED', { instructionClarity });
  }

  const title = cleanText(cycleResult.orchestrationTask.objective, 200);
  if (!title || /\r|\n/u.test(cycleResult.orchestrationTask.objective)) {
    return stop('AGENT_JOB_BRIDGE_TITLE_INVALID');
  }

  const meta = {
    goalId: cycleResult.goalId,
    expectedNextStep: cycleResult.selected.expectedNextStep,
    onSuccessNextStep: cycleResult.selected.onSuccessNextStep ?? null,
    taskId: cycleResult.selected.taskId,
  };
  const encoded = encodeContinuationMetadata(meta);
  if (!encoded.ok) return stop(encoded.code);

  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'PROCEED',
    code: 'AI_JOB_ISSUE_READY',
    issue: {
      title,
      labels: ['ai-job'],
      body: `${encoded.value}\n${rendered.markdown}`,
    },
    continuation: meta,
    ownership: ownership(),
    authority: authority(),
  };
}

function validateResumeInput(currentFocus, workState) {
  const errors = [];
  if (!closedObject(currentFocus, FOCUS_KEYS)) errors.push('currentFocus_schema_invalid');
  else {
    if (!safeToken(currentFocus.goalId)) errors.push('currentFocus_goalId_invalid');
    if (!cleanText(currentFocus.nextStep, 1200)) errors.push('currentFocus_nextStep_invalid');
  }

  if (!closedObject(workState, WORK_STATE_KEYS)) errors.push('workState_schema_invalid');
  else {
    if (!WORK_STAGES.has(workState.stage)) errors.push('workState_stage_invalid');
    if (!closedObject(workState.humanDecision, HUMAN_DECISION_KEYS)
      || Object.keys(workState.humanDecision ?? {}).length !== HUMAN_DECISION_KEYS.size
      || typeof workState.humanDecision.required !== 'boolean'
      || !cleanText(workState.humanDecision.reason, 1000)) {
      errors.push('workState_humanDecision_invalid');
    }
  }
  return errors;
}

export function resumeFromWorkState({ currentFocus, workState, issueBody }) {
  const errors = validateResumeInput(currentFocus, workState);
  if (errors.length > 0) return stop('AGENT_JOB_BRIDGE_RESUME_INVALID', { errors });

  const meta = parseContinuationMetadata(issueBody);
  if (!meta.ok) return stop(meta.code);
  if (meta.value.goalId !== currentFocus.goalId) {
    return stop('CONTINUATION_GOAL_STALE', {
      expectedGoalId: currentFocus.goalId,
      observedGoalId: meta.value.goalId,
    });
  }
  if (meta.value.expectedNextStep !== currentFocus.nextStep) {
    return stop('CONTINUATION_NEXT_STEP_STALE', {
      expectedNextStep: currentFocus.nextStep,
      observedNextStep: meta.value.expectedNextStep,
    });
  }

  const base = {
    schemaVersion: SCHEMA_VERSION,
    goalId: currentFocus.goalId,
    taskId: meta.value.taskId,
    ownership: ownership(),
    authority: authority(),
  };

  if (workState.stage === 'QUEUED') {
    return { ...base, result: 'WAIT', code: 'AI_JOB_QUEUED' };
  }
  if (workState.stage === 'IMPLEMENTING') {
    return { ...base, result: 'WAIT', code: 'AI_JOB_RUNNING' };
  }
  if (workState.stage === 'REVIEW') {
    return {
      ...base,
      result: 'WAIT_HUMAN',
      code: 'AI_JOB_REVIEW_WAIT_HUMAN',
      reason: workState.humanDecision.reason,
    };
  }
  if (workState.stage === 'FAILED') {
    if (workState.humanDecision.required === true) {
      return {
        ...base,
        result: 'WAIT_HUMAN',
        code: 'AI_JOB_FAILED_WAIT_HUMAN',
        reason: workState.humanDecision.reason,
      };
    }
    return stop('AI_JOB_FAILED', {
      goalId: currentFocus.goalId,
      taskId: meta.value.taskId,
      ownership: ownership(),
      authority: authority(),
    });
  }
  if (workState.stage === 'CONFLICT') {
    return stop('AI_JOB_STATE_CONFLICT', {
      goalId: currentFocus.goalId,
      taskId: meta.value.taskId,
      ownership: ownership(),
      authority: authority(),
    });
  }
  if (workState.stage === 'DONE') {
    if (meta.value.onSuccessNextStep) {
      return {
        ...base,
        result: 'ADVANCE_READY',
        code: 'AI_JOB_DONE_ADVANCE_READY',
        nextStep: meta.value.onSuccessNextStep,
      };
    }
    return { ...base, result: 'COMPLETED', code: 'AI_JOB_DONE_COMPLETED' };
  }

  return stop('WORK_STATE_STAGE_UNSUPPORTED');
}

export function runAgentJobBridge(payload, dependencies = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return stop('AGENT_JOB_BRIDGE_SCHEMA_INVALID');
  }
  const allowed = payload.action === 'PREPARE' ? PREPARE_KEYS
    : payload.action === 'RESUME' ? RESUME_KEYS
      : null;
  if (!allowed || !closedObject(payload, allowed) || payload.schemaVersion !== SCHEMA_VERSION
    || !ACTIONS.has(payload.action)) {
    return stop('AGENT_JOB_BRIDGE_SCHEMA_INVALID');
  }

  if (payload.action === 'PREPARE') {
    return prepareAiJobIssue(payload.cycleResult, dependencies);
  }
  return resumeFromWorkState({
    currentFocus: payload.currentFocus,
    workState: payload.workState,
    issueBody: payload.issueBody,
  });
}

const EXTRACT_FLAG = '--extract-research-envelope';

// Bounded, read-only CLI extraction mode. The real Issue->poller->launcher
// path loses the embedded AGENT_CYCLE_JOB_RESEARCH_V1 envelope because
// scripts/ai-job-poller/poll-once.ps1 only ever passes a PromptFile (no
// clarity/research file) to run-claude-job.ps1. This mode lets the EXISTING
// launcher recover that evidence itself: given an arbitrary text file (a
// bridge-rendered, poller-delivered PromptFile/Issue body), it reuses the
// SAME parseEmbeddedResearchEnvelope validator already used for the real
// Issue-body path -- never a second parser, never a placeholder/
// trigger:false/ADOPT substitute on failure. It only reads the given file;
// it never writes, never mutates any job/worktree/checkpoint state, and
// never invokes a provider.
function runExtractCli(filePath) {
  let text;
  try {
    text = readFileSync(resolve(filePath), 'utf8');
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'RESEARCH_ENVELOPE_FILE_UNREADABLE', errors: null })}\n`);
    process.exitCode = 2;
    return;
  }
  const result = parseEmbeddedResearchEnvelope(text);
  if (result.ok) {
    process.stdout.write(`${JSON.stringify({ ok: true, value: result.value })}\n`);
    process.exitCode = 0;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: false, code: result.code, errors: result.errors ?? null })}\n`);
    process.exitCode = 2;
  }
}

async function main() {
  const extractIndex = process.argv.indexOf(EXTRACT_FLAG);
  if (extractIndex !== -1) {
    const filePath = process.argv[extractIndex + 1];
    if (!filePath) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: 'AGENT_JOB_BRIDGE_INPUT_INVALID', errors: null })}\n`);
      process.exitCode = 2;
      return;
    }
    runExtractCli(filePath);
    return;
  }
  try {
    const raw = await readBoundedTaskInput(process.stdin);
    const payload = JSON.parse(raw);
    const result = runAgentJobBridge(payload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = ['PROCEED', 'WAIT', 'WAIT_HUMAN', 'ADVANCE_READY', 'COMPLETED'].includes(result.result) ? 0 : 2;
  } catch (error) {
    const code = ['INPUT_TOO_LARGE', 'INPUT_TIMEOUT', 'INPUT_STREAM_ERROR'].includes(error?.code)
      ? error.code
      : 'AGENT_JOB_BRIDGE_INPUT_INVALID';
    process.stdout.write(`${JSON.stringify(stop(code))}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(stop('AGENT_JOB_BRIDGE_INTERNAL_ERROR'))}\n`);
    process.exitCode = 2;
  });
}
