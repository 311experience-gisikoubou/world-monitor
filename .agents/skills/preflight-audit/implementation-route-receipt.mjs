#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { computeChangeSetSha256 } from './implementation-runner.mjs';
import { evaluateInstructionClarity } from './instruction-clarity-gate.mjs';
import {
  evaluateResearchGateBound, blocksSourceWrite,
  validateResearchEnvelopeShape, buildResearchExpectedBinding,
} from './research-gate.mjs';

const STAGES = new Set(['pre-implementation', 'final']);
const TASK_KINDS = new Set([
  'implementation', 'bugfix', 'refactor', 'design-with-source-write',
  'review', 'testing', 'audit', 'research', 'documentation', 'diagnosis', 'design', 'planning',
]);
export const CHATGPT_DIRECT_GATED_KINDS = new Set([
  'implementation', 'bugfix', 'refactor', 'design-with-source-write',
]);
const ROUTE_TYPES = new Set(['qualified-agent', 'direct-browser']);
const CHATGPT_DIRECT_ROUTE_TYPES = new Set(['direct-browser']);
const DATA_CLASSES = new Set(['source-only', 'synthetic', 'public']);
const COST_POLICIES = new Set(['no-new-cost']);
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk']);
const FORBIDDEN_AUTHORITIES = new Set(['merge', 'production', 'destructive']);
const EXCEPTION_REASONS = new Set([
  'HUMAN_EXPLICIT_DIRECT',
  'TRIVIAL_SAFE_LOCAL_EDIT',
  'NO_QUALIFIED_EXECUTOR_LOWER_RISK_DIRECT',
]);
const HEAD_RE = /^[0-9a-f]{40}$/;
const CHANGE_SET_SHA256_RE = /^[0-9A-Fa-f]{64}$/;

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function branchToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value);
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function boundedString(value, max) {
  return nonEmptyString(value) && value.trim().length <= max;
}
function stringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}
function repoRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.startsWith('/') &&
    !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}
function changedPathsArray(value) {
  return Array.isArray(value) && value.every((item) => repoRelativePath(item));
}
function everyIn(values, allowed) {
  return Array.isArray(values) && values.every((item) => allowed.has(item));
}
function intersects(values, blocked) {
  return Array.isArray(values) && values.some((item) => blocked.has(item));
}

function stop(code, extra = {}) {
  return { schemaVersion: 1, result: 'STOP', code, ...extra };
}

export function validateReceipt(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input_not_object'];
  if (input.schemaVersion !== 1) errors.push('schemaVersion_invalid');
  if (!STAGES.has(input.stage)) errors.push('stage_invalid');

  const task = input.task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    errors.push('task_not_object');
  } else {
    if (!safeToken(task.id)) errors.push('task_id_invalid');
    if (!TASK_KINDS.has(task.kind)) errors.push('task_kind_invalid');
  }

  const taskKind = task && typeof task === 'object' ? task.kind : undefined;
  if (CHATGPT_DIRECT_GATED_KINDS.has(taskKind)) {
    const clarity = evaluateInstructionClarity(input.instructionClarity);
    if (clarity.result !== 'PROCEED') errors.push('instructionClarity_not_proceed');
    else if (clarity.taskId !== task.id) errors.push('instructionClarity_taskId_mismatch');
  } else if (input.instructionClarity !== undefined) {
    errors.push('instructionClarity_forbidden_for_non_source_write');
  }

  // Every source-write receipt (pre-implementation AND final) must carry an
  // independent research envelope. This is a shape check only; decide()
  // always independently re-evaluates the raw evidence and never trusts a
  // caller-supplied result.
  if (CHATGPT_DIRECT_GATED_KINDS.has(taskKind)) {
    errors.push(...validateResearchEnvelopeShape(input.research));
  } else if (input.research !== undefined) {
    errors.push('research_forbidden_for_non_source_write');
  }

  const executor = input.executor;
  if (!executor || typeof executor !== 'object' || Array.isArray(executor)) {
    errors.push('executor_not_object');
  } else {
    if (!safeToken(executor.id)) errors.push('executor_id_invalid');
    if (!safeToken(executor.provider)) errors.push('executor_provider_invalid');
    if (!ROUTE_TYPES.has(executor.routeType)) errors.push('executor_routeType_invalid');
  }

  const repository = input.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    errors.push('repository_not_object');
  } else {
    if (!safeToken(repository.owner)) errors.push('repository_owner_invalid');
    if (!safeToken(repository.name)) errors.push('repository_name_invalid');
  }

  if (!branchToken(input.branch)) errors.push('branch_invalid');
  if (!stringArray(input.allowedScope)) errors.push('allowedScope_invalid');
  if (!DATA_CLASSES.has(input.dataClass)) errors.push('dataClass_invalid');
  if (!COST_POLICIES.has(input.costPolicy)) errors.push('costPolicy_invalid');

  if (input.requestedAuthorities !== undefined && !stringArray(input.requestedAuthorities) &&
      !(Array.isArray(input.requestedAuthorities) && input.requestedAuthorities.length === 0)) {
    errors.push('requestedAuthorities_invalid');
  }

  if (input.exception !== undefined && input.exception !== null) {
    const exception = input.exception;
    if (typeof exception !== 'object' || Array.isArray(exception)) {
      errors.push('exception_not_object');
    } else {
      if (!EXCEPTION_REASONS.has(exception.reason)) errors.push('exception_reason_invalid');
      if (!boundedString(exception.justification, 500)) errors.push('exception_justification_invalid');
      if (exception.evidenceConfirmed !== true) errors.push('exception_evidenceConfirmed_invalid');
    }
  }

  if (input.stage === 'final') {
    if (!HEAD_RE.test(input.implementationHead || '')) errors.push('implementationHead_invalid');
  } else if (input.implementationHead !== undefined) {
    errors.push('implementationHead_forbidden_at_pre_implementation');
  }

  // A qualified-agent (e.g. claude-implementation-write) final receipt must
  // bind the committed head to the actual runner execution: without this,
  // "final receipt says PASS" and "a runner actually produced this diff"
  // are two unrelated claims. Direct-browser executors have no runner to
  // produce this evidence, so they are exempted here (their gate is the
  // exception vocabulary above, not execution evidence).
  const executorRouteType = executor && typeof executor === 'object' ? executor.routeType : undefined;
  if (input.stage === 'final' && executorRouteType === 'qualified-agent') {
    const evidence = input.executionEvidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      errors.push('executionEvidence_required');
    } else {
      if (!HEAD_RE.test(evidence.preHead || '')) errors.push('executionEvidence_preHead_invalid');
      if (!CHANGE_SET_SHA256_RE.test(evidence.changeSetSha256 || '')) errors.push('executionEvidence_changeSetSha256_invalid');
      if (!changedPathsArray(evidence.changedPaths)) errors.push('executionEvidence_changedPaths_invalid');
      if (Object.keys(evidence).some((key) => !['preHead', 'changeSetSha256', 'changedPaths'].includes(key))) {
        errors.push('executionEvidence_unknown_field');
      }
    }
  } else if (input.executionEvidence !== undefined) {
    errors.push('executionEvidence_forbidden_outside_final_qualified_agent');
  }

  return errors;
}

function decide(input) {
  const task = input.task;
  const executor = input.executor;
  const repository = input.repository;
  const requestedAuthorities = input.requestedAuthorities || [];

  if (intersects(requestedAuthorities, FORBIDDEN_AUTHORITIES)) {
    return stop('FORBIDDEN_AUTHORITY_REQUESTED', { taskId: task.id });
  }
  if (PROTECTED_BRANCHES.has(input.branch.toLowerCase())) {
    return stop('PROTECTED_BRANCH_REJECTED', { taskId: task.id, branch: input.branch });
  }

  if (CHATGPT_DIRECT_GATED_KINDS.has(task.kind) && CHATGPT_DIRECT_ROUTE_TYPES.has(executor.routeType)) {
    const exception = input.exception;
    if (!exception || !EXCEPTION_REASONS.has(exception.reason) ||
        !boundedString(exception.justification, 500) || exception.evidenceConfirmed !== true) {
      return stop('DIRECT_EXECUTOR_EXCEPTION_REQUIRED', { taskId: task.id, executor: executor.id });
    }
  }

  // The research envelope's raw evidence is ALWAYS independently
  // re-evaluated here -- at both the pre-implementation and the final
  // stage -- from scratch. A caller can never short-circuit this by
  // asserting its own 'ADOPT' result: the evidence schema has no such
  // field, and evaluateResearchGateBound recomputes the decision from the
  // raw checklist/trigger/deepResearch evidence every single time. Missing,
  // stale, mismatched, REJECT, or TRIAL_REQUIRED evidence blocks this
  // receipt (and therefore blocks the eventual final MERGE_READY, since
  // verifyFinalReceipt requires 'PASS' from here).
  let researchGate = null;
  if (CHATGPT_DIRECT_GATED_KINDS.has(task.kind)) {
    const expected = buildResearchExpectedBinding(input.research, { taskId: task.id, repository, scope: input.allowedScope });
    researchGate = evaluateResearchGateBound(input.research.evidence, expected);
    if (blocksSourceWrite(researchGate)) {
      return stop('RESEARCH_GATE_BLOCKED', { taskId: task.id, researchGate });
    }
  }

  const stage = input.stage;
  const clarity = CHATGPT_DIRECT_GATED_KINDS.has(task.kind)
    ? evaluateInstructionClarity(input.instructionClarity)
    : null;
  const result = stage === 'final' ? 'PASS' : 'PROCEED';
  return {
    schemaVersion: 1,
    result,
    code: stage === 'final' ? 'FINAL_RECEIPT_ISSUED' : 'ROUTE_AUTHORIZED',
    taskId: task.id,
    taskKind: task.kind,
    executor: { id: executor.id, provider: executor.provider, routeType: executor.routeType },
    repository: { owner: repository.owner, name: repository.name },
    branch: input.branch,
    allowedScope: [...input.allowedScope],
    dataClass: input.dataClass,
    costPolicy: input.costPolicy,
    exception: input.exception ? {
      reason: input.exception.reason,
      justification: input.exception.justification,
      evidenceConfirmed: input.exception.evidenceConfirmed,
    } : null,
    instructionClarity: clarity ? {
      result: clarity.result,
      code: clarity.code,
      taskId: clarity.taskId,
      instructionCount: clarity.instructionCount,
      ambiguityCount: clarity.ambiguityCount,
      materialResolvedCount: clarity.materialResolvedCount,
      nonMaterialCount: clarity.nonMaterialCount,
      assumptionCount: clarity.assumptionCount,
      humanClarificationCount: clarity.humanClarificationCount,
      evidence: clarity.evidence,
    } : null,
    researchGate: researchGate ? { result: researchGate.result, code: researchGate.code, taskId: researchGate.taskId } : null,
    ...(researchGate ? { research: structuredClone(input.research) } : {}),
    implementationHead: stage === 'final' ? input.implementationHead : null,
    executionEvidence: stage === 'final' && input.executionEvidence
      ? {
        preHead: input.executionEvidence.preHead,
        changeSetSha256: input.executionEvidence.changeSetSha256,
        changedPaths: [...input.executionEvidence.changedPaths],
      }
      : null,
  };
}

export function evaluateReceipt(input) {
  const errors = validateReceipt(input);
  if (errors.length > 0) return stop('SCHEMA_INVALID', { errors });
  return decide(input);
}

export function verifyFinalReceipt(receipt, expected) {
  if (!receipt || receipt.result !== 'PASS') {
    return stop('FINAL_RECEIPT_NOT_PASS');
  }
  if (expected.owner && receipt.repository.owner !== expected.owner) {
    return stop('REPOSITORY_OWNER_MISMATCH');
  }
  if (expected.name && receipt.repository.name !== expected.name) {
    return stop('REPOSITORY_NAME_MISMATCH');
  }
  if (expected.branch && receipt.branch !== expected.branch) {
    return stop('BRANCH_MISMATCH');
  }
  if (expected.head && receipt.implementationHead !== expected.head) {
    return stop('HEAD_MISMATCH');
  }
  if (CHATGPT_DIRECT_GATED_KINDS.has(receipt.taskKind)) {
    if (!receipt.instructionClarity || receipt.instructionClarity.result !== 'PROCEED' ||
        receipt.instructionClarity.taskId !== receipt.taskId) {
      return stop('INSTRUCTION_CLARITY_EVIDENCE_MISSING_OR_FAILED');
    }
  }
  if (CHATGPT_DIRECT_GATED_KINDS.has(receipt.taskKind)) {
    const errors = validateResearchEnvelopeShape(receipt.research);
    if (errors.length) return stop('RESEARCH_EVIDENCE_MISSING_OR_FAILED', { errors });
    const researchExpected = buildResearchExpectedBinding(receipt.research, {
      taskId: receipt.taskId, repository: receipt.repository, scope: receipt.allowedScope,
    });
    const researchGate = evaluateResearchGateBound(receipt.research.evidence, researchExpected);
    if (blocksSourceWrite(researchGate)) return stop('RESEARCH_EVIDENCE_MISSING_OR_FAILED', { researchGate });
  }
  // A qualified-agent receipt claims a runner actually produced the
  // committed change set. Schema validation already proved the evidence is
  // well-formed; here we recompute the real committed change set (paths
  // plus committed blob OIDs, including new/untracked files) from the exact
  // repository and require it to match exactly, so a receipt cannot be
  // honored on say-so alone. Verification of a qualified-agent receipt
  // without repoRoot is refused rather than silently skipped.
  if (receipt.executor.routeType === 'qualified-agent') {
    if (!receipt.executionEvidence) return stop('EXECUTION_EVIDENCE_MISSING');
    if (!expected.repoRoot) return stop('REPO_ROOT_REQUIRED_FOR_EXECUTION_EVIDENCE');
    const recomputed = computeChangeSetSha256(expected.repoRoot, receipt.executionEvidence.preHead, receipt.implementationHead);
    if (!recomputed) return stop('EXECUTION_EVIDENCE_UNVERIFIABLE');
    if (recomputed.changeSetSha256 !== receipt.executionEvidence.changeSetSha256) return stop('EXECUTION_EVIDENCE_CHANGE_SET_MISMATCH');
  }
  return { schemaVersion: 1, result: 'MERGE_READY', code: 'FINAL_RECEIPT_VERIFIED' };
}

function parseArgs(argv) {
  const out = {
    inputPath: null, pretty: false, expectOwner: null, expectName: null, expectBranch: null,
    expectHead: null, repoRoot: null, valid: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) { out.inputPath = argv[i + 1]; i += 1; }
    else if (a === '--pretty') out.pretty = true;
    else if (a === '--expect-owner' && argv[i + 1]) { out.expectOwner = argv[i + 1]; i += 1; }
    else if (a === '--expect-name' && argv[i + 1]) { out.expectName = argv[i + 1]; i += 1; }
    else if (a === '--expect-branch' && argv[i + 1]) { out.expectBranch = argv[i + 1]; i += 1; }
    else if (a === '--expect-head' && argv[i + 1]) { out.expectHead = argv[i + 1]; i += 1; }
    else if (a === '--repo-root' && argv[i + 1]) { out.repoRoot = argv[i + 1]; i += 1; }
    else out.valid = false;
  }
  if (!nonEmptyString(out.inputPath)) out.valid = false;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) {
    process.stdout.write(`${JSON.stringify(stop('SCHEMA_INVALID'))}\n`);
    process.exitCode = 2;
    return;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(path.resolve(args.inputPath), 'utf8'));
  } catch {
    process.stdout.write(`${JSON.stringify(stop('SCHEMA_INVALID'))}\n`);
    process.exitCode = 2;
    return;
  }
  let result = evaluateReceipt(input);
  const hasExpectations = args.expectOwner || args.expectName || args.expectBranch || args.expectHead;
  if (hasExpectations && input.stage === 'final') {
    result = verifyFinalReceipt(result, {
      owner: args.expectOwner,
      name: args.expectName,
      branch: args.expectBranch,
      head: args.expectHead,
      repoRoot: args.repoRoot ? path.resolve(args.repoRoot) : null,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  const ok = result.result === 'PROCEED' || result.result === 'PASS' || result.result === 'MERGE_READY';
  process.exitCode = ok ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();