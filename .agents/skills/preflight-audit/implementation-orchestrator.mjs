#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolveProviderCommand } from './ai-provider-inventory.mjs';
import { routeTask } from './ai-task-router.mjs';
import { evaluateReceipt, CHATGPT_DIRECT_GATED_KINDS as RECEIPT_RESEARCH_GATED_KINDS } from './implementation-route-receipt.mjs';
import { evaluateInstructionClarity } from './instruction-clarity-gate.mjs';
import {
  evaluateResearchGateBound, blocksSourceWrite,
  validateResearchEnvelopeShape, buildResearchExpectedBinding,
} from './research-gate.mjs';
import {
  ALLOWED_CAPABILITIES,
  ALLOWED_DATA_CLASSES,
  verifyFeatureRepository,
  verifyRepositoryIdentity,
  probeClaudeImplementationRunner,
  runClaudeImplementationTask,
  validScopePattern,
  readBoundedTaskInput,
} from './implementation-runner.mjs';

const SCHEMA_VERSION = 1;
const EXECUTOR_ID = 'claude-implementation-write';
const EXECUTION_ENVIRONMENT = 'local-cli-write';
const ALLOWED_KEYS = new Set([
  'schemaVersion', 'taskId', 'kind', 'objective', 'prompt', 'repoRoot', 'branch',
  'allowedScope', 'forbiddenScope', 'doneConditions', 'requiredTests', 'dataClass', 'repository',
  'instructionClarity', 'research',
]);

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function branchToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value);
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function optionalStringArray(value) {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0));
}

function stop(code, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'STOP',
    code,
    taskId: null,
    routing: null,
    instructionClarity: null,
    researchGate: null,
    preImplementationReceipt: null,
    runner: null,
    executionEvidence: null,
    ...extra,
  };
}

// This is the closed, bounded task schema the orchestrator accepts. It is
// deliberately a superset of neither ai-task-router's nor
// implementation-runner's own schemas; the orchestrator builds each of
// those internally from these fields so a caller cannot hand-craft a route
// or a runner payload that bypasses either one.
export function validateOrchestrationTask(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['payload_not_object'];
  const errors = [];
  if (payload.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion_invalid');
  if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) errors.push('unknown_field');
  if (!safeToken(payload.taskId)) errors.push('taskId_invalid');
  if (!ALLOWED_CAPABILITIES.has(payload.kind)) errors.push('kind_invalid');
  if (!nonEmptyString(payload.objective)) errors.push('objective_invalid');
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) errors.push('prompt_invalid');
  if (!nonEmptyString(payload.repoRoot)) errors.push('repoRoot_invalid');
  if (!branchToken(payload.branch)) errors.push('branch_invalid');
  if (!Array.isArray(payload.allowedScope) || payload.allowedScope.length === 0 ||
      !payload.allowedScope.every((item) => validScopePattern(item))) {
    errors.push('allowedScope_invalid');
  }
  if (payload.forbiddenScope !== undefined && (!Array.isArray(payload.forbiddenScope) ||
      !payload.forbiddenScope.every((item) => validScopePattern(item)))) {
    errors.push('forbiddenScope_invalid');
  }
  if (!optionalStringArray(payload.doneConditions)) errors.push('doneConditions_invalid');
  if (!optionalStringArray(payload.requiredTests)) errors.push('requiredTests_invalid');
  if (!ALLOWED_DATA_CLASSES.has(payload.dataClass)) errors.push('dataClass_invalid');
  const repository = payload.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    errors.push('repository_not_object');
  } else {
    if (!safeToken(repository.owner)) errors.push('repository_owner_invalid');
    if (!safeToken(repository.name)) errors.push('repository_name_invalid');
  }
  // Deep ambiguity-vocabulary validation belongs to instruction-clarity-gate
  // itself (called unconditionally before Claude is ever invoked). This is
  // only the minimal shape/binding check: the field must be present and must
  // declare the same taskId it is being supplied for, so a caller cannot
  // attach unrelated clarity evidence to this task.
  if (!payload.instructionClarity || typeof payload.instructionClarity !== 'object' || Array.isArray(payload.instructionClarity)) {
    errors.push('instructionClarity_invalid');
  } else if (payload.instructionClarity.taskId !== payload.taskId) {
    errors.push('instructionClarity_taskId_mismatch');
  }
  // Every orchestrated task carries its own independent research envelope
  // (raw Research Gate evidence plus current proposal/constraints/human-top-
  // conditions context). This is a shape check only; runImplementationOrchestration
  // independently re-evaluates the raw evidence BEFORE any provider probe or
  // invocation, never trusting a caller-asserted result.
  errors.push(...validateResearchEnvelopeShape(payload.research));
  return errors;
}

function buildRoute(probe) {
  const ready = probe.generalEvidenceReady === true;
  return {
    id: EXECUTOR_ID,
    provider: 'claude',
    availability: ready ? 'AVAILABLE' : 'UNAVAILABLE',
    executionEnvironment: EXECUTION_ENVIRONMENT,
    capabilities: [...ALLOWED_CAPABILITIES],
    permissions: ['source-write'],
    allowedDataClasses: [...ALLOWED_DATA_CLASSES],
    incrementalCost: ready ? 'INCLUDED' : 'UNKNOWN',
    safetyStatus: ready ? 'SAFE_CONFIRMED' : 'UNKNOWN',
    capacity: { status: 'UNAVAILABLE' },
  };
}

function buildRouterTask(payload) {
  return {
    id: payload.taskId,
    kind: payload.kind,
    objective: payload.objective,
    requiredCapabilities: [payload.kind],
    requiredPermissions: ['source-write'],
    executionEnvironment: EXECUTION_ENVIRONMENT,
    dataClass: payload.dataClass,
    costPolicy: 'no-new-cost',
    independentReviewRequired: false,
    forbiddenAuthorities: [],
    allowedScope: [...payload.allowedScope],
    forbiddenScope: Array.isArray(payload.forbiddenScope) ? [...payload.forbiddenScope] : [],
    doneConditions: Array.isArray(payload.doneConditions) && payload.doneConditions.length > 0
      ? [...payload.doneConditions]
      : ['Source edits are limited to allowedScope.'],
    requiredTests: Array.isArray(payload.requiredTests) ? [...payload.requiredTests] : [],
    returnFormat: 'execution-evidence-json',
  };
}

// Single entry point: task in, routing decision + actual Claude execution +
// binding evidence out. Never invokes the runner unless ai-task-router
// selected claude-implementation-write and the pre-implementation route
// receipt independently authorized it; never substitutes a direct/browser
// executor when Claude is unavailable or unqualified.
export function runImplementationOrchestration(payload, {
  desc = resolveProviderCommand('claude'),
  envSource = process.env,
  timeoutMs,
} = {}) {
  const taskId = safeToken(payload?.taskId) ? payload.taskId : null;
  const schemaErrors = validateOrchestrationTask(payload);
  if (schemaErrors.length > 0) return stop('TASK_SCHEMA_INVALID', { taskId, schemaErrors });

  const instructionClarity = evaluateInstructionClarity(payload.instructionClarity);
  if (instructionClarity.result !== 'PROCEED') {
    return stop('INSTRUCTION_CLARITY_NOT_CONFIRMED', { taskId, instructionClarity });
  }

  // The raw research envelope is independently re-evaluated here, BEFORE
  // probeClaudeImplementationRunner (which actually spawns the Claude CLI to
  // check subscription auth -- a real provider probe) or any later
  // invocation. Expected taskId/repository/scope are built strictly from
  // this task's own already-validated payload fields, never from the
  // evidence, and a caller-asserted result is never trusted: the raw
  // checklist/trigger/deepResearch evidence is recomputed from scratch.
  const researchExpected = buildResearchExpectedBinding(payload.research, {
    taskId: payload.taskId, repository: payload.repository, scope: payload.allowedScope,
  });
  const researchGate = evaluateResearchGateBound(payload.research.evidence, researchExpected);
  if (blocksSourceWrite(researchGate)) {
    return stop('RESEARCH_GATE_BLOCKED', { taskId, instructionClarity, researchGate });
  }

  const probe = probeClaudeImplementationRunner({ desc, envSource, timeoutMs: Math.min(timeoutMs ?? 5000, 5000) });
  const route = buildRoute(probe);
  const routerTask = buildRouterTask(payload);
  const routing = routeTask({ schemaVersion: 1, task: routerTask, routes: [route] });
  if (routing.result !== 'PROCEED') {
    return stop('ROUTE_NOT_AUTHORIZED', { taskId, instructionClarity, researchGate, routing });
  }
  if (routing.selectedExecutor?.id !== EXECUTOR_ID) {
    return stop('UNEXPECTED_EXECUTOR_SELECTED', { taskId, instructionClarity, researchGate, routing });
  }

  const preImplementationReceipt = evaluateReceipt({
    schemaVersion: 1,
    stage: 'pre-implementation',
    task: { id: payload.taskId, kind: payload.kind },
    executor: { id: EXECUTOR_ID, provider: 'claude', routeType: 'qualified-agent' },
    repository: payload.repository,
    branch: payload.branch,
    allowedScope: [...payload.allowedScope],
    dataClass: payload.dataClass,
    costPolicy: 'no-new-cost',
    requestedAuthorities: [],
    instructionClarity: payload.instructionClarity,
    ...(RECEIPT_RESEARCH_GATED_KINDS.has(payload.kind) ? { research: payload.research } : {}),
  });
  if (preImplementationReceipt.result !== 'PROCEED') {
    return stop('PRE_IMPLEMENTATION_RECEIPT_REJECTED', { taskId, instructionClarity, researchGate, routing, preImplementationReceipt });
  }

  // Independently re-verify the exact repository/branch and repository
  // identity before invoking the runner. implementation-runner performs
  // its own equivalent checks again (including the worktree-clean check)
  // just before invoking Claude; this earlier check exists only so an
  // obviously wrong repoRoot/branch/repository is rejected before the
  // pre-implementation receipt is treated as meaningfully bound to it.
  const repoCheck = verifyFeatureRepository(payload.repoRoot, payload.branch);
  if (!repoCheck.ok) {
    return stop(repoCheck.code, { taskId, instructionClarity, researchGate, routing, preImplementationReceipt });
  }
  const identityCheck = verifyRepositoryIdentity(repoCheck.resolvedRoot, payload.repository.owner, payload.repository.name);
  if (!identityCheck.ok) {
    return stop(identityCheck.code, { taskId, instructionClarity, researchGate, routing, preImplementationReceipt });
  }

  const runner = runClaudeImplementationTask({
    schemaVersion: 1,
    taskId: payload.taskId,
    capability: payload.kind,
    dataClass: payload.dataClass,
    prompt: payload.prompt,
    repoRoot: payload.repoRoot,
    branch: payload.branch,
    allowedScope: [...payload.allowedScope],
    forbiddenScope: Array.isArray(payload.forbiddenScope) ? [...payload.forbiddenScope] : [],
    repository: { owner: payload.repository.owner, name: payload.repository.name },
    research: payload.research,
  }, { desc, envSource, timeoutMs });
  if (runner.result !== 'COMPLETED') {
    return stop(runner.code || 'RUNNER_STOPPED', { taskId, instructionClarity, researchGate, routing, preImplementationReceipt, runner });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'COMPLETED',
    code: 'IMPLEMENTATION_ROUTED_AND_EXECUTED',
    taskId,
    instructionClarity,
    researchGate,
    routing,
    preImplementationReceipt,
    runner,
    executionEvidence: { ...runner.executionEvidence },
  };
}

function parseArgs(argv) {
  let pretty = false;
  let timeoutMs;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pretty') pretty = true;
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 21600000) return { valid: false };
      timeoutMs = parsed;
    } else return { valid: false };
  }
  return { valid: true, pretty, timeoutMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) { process.stdout.write(`${JSON.stringify(stop('ARGUMENT_INVALID'))}\n`); process.exitCode = 2; return; }
  try {
    const raw = await readBoundedTaskInput(process.stdin);
    const payload = JSON.parse(raw);
    const result = runImplementationOrchestration(payload, args.timeoutMs ? { timeoutMs: args.timeoutMs } : {});
    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    if (result.result !== 'COMPLETED') process.exitCode = 1;
  } catch (error) {
    const code = ['INPUT_TOO_LARGE', 'INPUT_TIMEOUT', 'INPUT_STREAM_ERROR'].includes(error?.code) ? error.code : 'INPUT_READ_OR_PARSE_FAILED';
    process.stdout.write(`${JSON.stringify(stop(code))}\n`); process.exitCode = 2;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(() => { process.stdout.write(`${JSON.stringify(stop('ORCHESTRATOR_INTERNAL_ERROR'))}\n`); process.exitCode = 2; });
