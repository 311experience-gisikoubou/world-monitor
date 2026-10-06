#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { providerVendorKey } from './research-gate.mjs';

const SAFE_DATA_CLASSES = new Set(['source-only', 'synthetic', 'public']);
const PROTECTED_DATA_CLASSES = new Set([
  'protected-data', 'real-data', 'patient-data', 'clinic-data', 'customer-data',
  'business-data', 'order-data', 'pricing-data', 'invoice-data', 'sales-data',
  'credentials', 'personal-data',
]);
const ALL_DATA_CLASSES = new Set([...SAFE_DATA_CLASSES, ...PROTECTED_DATA_CLASSES]);
const COST_POLICIES = new Set(['no-new-cost', 'allow-extra-cost']);
const AVAILABILITY = new Set(['AVAILABLE', 'UNAVAILABLE']);
const COST_STATES = new Set(['INCLUDED', 'FREE', 'EXTRA', 'UNKNOWN']);
const SAFETY_STATES = new Set(['SAFE_CONFIRMED', 'UNKNOWN', 'UNSAFE']);
const CAPACITY_STATES = new Set(['AVAILABLE', 'UNAVAILABLE']);

const HUMAN_GATED = new Set([
  'merge', 'production', 'destructive', 'recurring-cost', 'external-data-route',
  'lifecycle-responsibility', 'business-policy', 'protected-data', 'real-data',
]);
const SAFE_KINDS = new Set([
  'implementation', 'review', 'testing', 'audit', 'research', 'documentation',
  'diagnosis', 'refactor', 'bugfix', 'design', 'planning',
]);
const TASK_KINDS = new Set([...SAFE_KINDS, ...HUMAN_GATED]);
const SAFE_PERMISSIONS = new Set([
  'repo-read', 'repo-write', 'source-read', 'source-write', 'test-run',
  'local-exec', 'shell-read', 'shell-write', 'git-read', 'git-write',
]);
const PERMISSIONS = new Set([...SAFE_PERMISSIONS, ...HUMAN_GATED]);

// Role routing is a thin layer over the same hard safety/capability/
// permission/cost/capacity qualification used for executor selection. It
// never grants a role authority that the underlying route evaluation did
// not already clear.
const ROLES = new Set(['executor', 'designer', 'researchPrimary', 'researchAdversarial', 'reviewer']);
const RESEARCH_ROLES = new Set(['researchPrimary', 'researchAdversarial']);
// A research role must never carry repo-write/source-write/install authority:
// research is evidence-gathering, not a source writer or install route.
const RESEARCH_FORBIDDEN_PERMISSIONS = new Set(['repo-write', 'source-write', 'git-write', 'shell-write']);

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function everyIn(values, allowed) {
  return stringArray(values) && values.every((item) => allowed.has(item));
}
function includesAll(values, required) {
  return required.every((item) => values.includes(item));
}
function intersects(values, blocked) {
  return values.some((item) => blocked.has(item));
}
function publicRoute(route) {
  return route ? { id: route.id, provider: route.provider } : null;
}
function stop(code, taskId = null, rejectedRoutes = [], role = null) {
  return {
    schemaVersion: 1,
    result: 'STOP',
    code,
    taskId,
    role,
    selectedExecutor: null,
    selectedReviewer: null,
    rejectedRoutes,
    routingEvidence: null,
    handoff: null,
  };
}

export function validateTask(task) {
  const errors = [];
  if (!task || typeof task !== 'object' || Array.isArray(task)) return ['task_not_object'];
  if (!safeToken(task.id)) errors.push('id_invalid');
  if (!TASK_KINDS.has(task.kind)) errors.push('kind_invalid');
  if (task.role !== undefined && !ROLES.has(task.role)) errors.push('role_invalid');
  if (task.counterpartProviderId !== undefined && !safeToken(task.counterpartProviderId)) errors.push('counterpartProviderId_invalid');
  if (!nonEmptyString(task.objective)) errors.push('objective_invalid');
  if (!stringArray(task.requiredCapabilities)) errors.push('requiredCapabilities_invalid');
  if (!everyIn(task.requiredPermissions, PERMISSIONS)) errors.push('requiredPermissions_invalid');
  if (!safeToken(task.executionEnvironment)) errors.push('executionEnvironment_invalid');
  if (!ALL_DATA_CLASSES.has(task.dataClass)) errors.push('dataClass_invalid');
  if (!COST_POLICIES.has(task.costPolicy)) errors.push('costPolicy_invalid');
  if (typeof task.independentReviewRequired !== 'boolean') errors.push('independentReviewRequired_invalid');
  if (!everyIn(task.forbiddenAuthorities, HUMAN_GATED)) errors.push('forbiddenAuthorities_invalid');
  if (!stringArray(task.allowedScope)) errors.push('allowedScope_invalid');
  if (!stringArray(task.forbiddenScope)) errors.push('forbiddenScope_invalid');
  if (!stringArray(task.doneConditions)) errors.push('doneConditions_invalid');
  if (!stringArray(task.requiredTests)) errors.push('requiredTests_invalid');
  if (!nonEmptyString(task.returnFormat)) errors.push('returnFormat_invalid');
  return errors;
}

export function validateRoute(route) {
  const errors = [];
  if (!route || typeof route !== 'object' || Array.isArray(route)) return ['route_not_object'];
  if (!safeToken(route.id)) errors.push('id_invalid');
  if (!safeToken(route.provider)) errors.push('provider_invalid');
  if (!AVAILABILITY.has(route.availability)) errors.push('availability_invalid');
  if (!safeToken(route.executionEnvironment)) errors.push('executionEnvironment_invalid');
  if (!stringArray(route.capabilities)) errors.push('capabilities_invalid');
  if (!everyIn(route.permissions, PERMISSIONS)) errors.push('permissions_invalid');
  if (!everyIn(route.allowedDataClasses, ALL_DATA_CLASSES)) errors.push('allowedDataClasses_invalid');
  if (!COST_STATES.has(route.incrementalCost)) errors.push('incrementalCost_invalid');
  if (!SAFETY_STATES.has(route.safetyStatus)) errors.push('safetyStatus_invalid');
  if (!route.capacity || typeof route.capacity !== 'object' || !CAPACITY_STATES.has(route.capacity.status)) {
    errors.push('capacity_status_invalid');
  } else if (route.capacity.status === 'AVAILABLE') {
    const value = route.capacity.remainingPercent;
    if (!Number.isFinite(value) || value < 0 || value > 100) errors.push('capacity_remainingPercent_invalid');
  } else if ('remainingPercent' in route.capacity) {
    errors.push('capacity_remainingPercent_forbidden_when_unavailable');
  }
  if (route.jobFitScore !== undefined &&
      (!Number.isInteger(route.jobFitScore) || route.jobFitScore < 0 || route.jobFitScore > 100)) {
    errors.push('jobFitScore_invalid');
  }
  if (route.distinctRouteRationale !== undefined && !nonEmptyString(route.distinctRouteRationale)) {
    errors.push('distinctRouteRationale_invalid');
  }
  return errors;
}

function costRank(value) {
  if (value === 'INCLUDED' || value === 'FREE') return 0;
  if (value === 'EXTRA') return 1;
  return 2;
}

export function compareRoutes(a, b, { useMeasuredCapacity = false } = {}) {
  const fitA = a.jobFitScore ?? 50;
  const fitB = b.jobFitScore ?? 50;
  if (fitA !== fitB) return fitB - fitA;
  const costA = costRank(a.incrementalCost);
  const costB = costRank(b.incrementalCost);
  if (costA !== costB) return costA - costB;
  if (useMeasuredCapacity && a.capacity.remainingPercent !== b.capacity.remainingPercent) {
    return b.capacity.remainingPercent - a.capacity.remainingPercent;
  }
  return a.id.localeCompare(b.id, 'en');
}
function executorRejectionReasons(route, task, role = 'executor') {
  const reasons = [];
  if (route.availability !== 'AVAILABLE') reasons.push('ROUTE_UNAVAILABLE');
  if (route.safetyStatus !== 'SAFE_CONFIRMED') reasons.push('SAFETY_NOT_CONFIRMED');
  if (route.executionEnvironment !== task.executionEnvironment) reasons.push('ENVIRONMENT_MISMATCH');
  if (!includesAll(route.capabilities, task.requiredCapabilities)) reasons.push('MISSING_CAPABILITY');
  if (!includesAll(route.permissions, task.requiredPermissions)) reasons.push('MISSING_PERMISSION');
  if (!route.allowedDataClasses.includes(task.dataClass)) reasons.push('DATA_CLASS_NOT_ALLOWED');
  if (route.incrementalCost === 'UNKNOWN') reasons.push('INCREMENTAL_COST_UNKNOWN');
  if (task.costPolicy === 'no-new-cost' && route.incrementalCost === 'EXTRA') reasons.push('EXTRA_COST_NOT_ALLOWED');
  const forbidden = new Set([...HUMAN_GATED, ...task.forbiddenAuthorities]);
  if (intersects(route.permissions, forbidden)) reasons.push('FORBIDDEN_AUTHORITY_PRESENT');
  if (RESEARCH_ROLES.has(role) && intersects(route.permissions, RESEARCH_FORBIDDEN_PERMISSIONS)) {
    reasons.push('RESEARCH_ROLE_WRITE_AUTHORITY_FORBIDDEN');
  }
  return reasons;
}

function reviewerRequiredPermissions(task) {
  const required = new Set();
  const readMappings = new Map([
    ['repo-write', 'repo-read'],
    ['source-write', 'source-read'],
    ['shell-write', 'shell-read'],
    ['git-write', 'git-read'],
  ]);
  for (const permission of task.requiredPermissions) {
    if (permission.endsWith('-read')) required.add(permission);
    const mapped = readMappings.get(permission);
    if (mapped) required.add(mapped);
  }
  return [...required];
}

// `requireTaskCapabilities` distinguishes the two real call sites below:
//  - explicit `task.role === 'reviewer'` routing (the reviewer IS the task):
//    every declared task.requiredCapabilities (e.g. ['review','security-audit'])
//    must actually be present on the route, not merely a hardcoded 'review'
//    check -- that was the actual bug: a route with only ['review'] used to
//    PROCEED for a task that explicitly required ['review','security-audit']
//    too.
//  - automatic independent-review selection for a separate executor/
//    implementation task (`task.independentReviewRequired`): the reviewer
//    only ever needs generic 'review' capability, never the EXECUTOR's own
//    requiredCapabilities (e.g. 'implementation'/source-writing), since that
//    would incorrectly demand the reviewer be able to do the executor's job.
function reviewerRejectionReasons(route, task, { requireTaskCapabilities = false } = {}) {
  const reasons = [];
  if (route.availability !== 'AVAILABLE') reasons.push('REVIEW_ROUTE_UNAVAILABLE');
  if (route.safetyStatus !== 'SAFE_CONFIRMED') reasons.push('REVIEW_SAFETY_NOT_CONFIRMED');
  if (route.executionEnvironment !== task.executionEnvironment) reasons.push('REVIEW_ENVIRONMENT_MISMATCH');
  if (requireTaskCapabilities) {
    if (!includesAll(route.capabilities, task.requiredCapabilities)) reasons.push('REVIEW_CAPABILITY_MISSING');
  } else if (!route.capabilities.includes('review')) {
    reasons.push('REVIEW_CAPABILITY_MISSING');
  }
  if (!route.permissions.some((permission) => permission.endsWith('-read'))) reasons.push('REVIEW_TARGET_READ_PERMISSION_MISSING');
  if (!includesAll(route.permissions, reviewerRequiredPermissions(task))) reasons.push('REVIEW_MISSING_READ_PERMISSION');
  if (!route.allowedDataClasses.includes(task.dataClass)) reasons.push('REVIEW_DATA_CLASS_NOT_ALLOWED');
  if (route.incrementalCost === 'UNKNOWN') reasons.push('REVIEW_INCREMENTAL_COST_UNKNOWN');
  if (task.costPolicy === 'no-new-cost' && route.incrementalCost === 'EXTRA') reasons.push('REVIEW_EXTRA_COST_NOT_ALLOWED');
  const forbidden = new Set([...HUMAN_GATED, ...task.forbiddenAuthorities]);
  if (intersects(route.permissions, forbidden)) reasons.push('REVIEW_FORBIDDEN_AUTHORITY_PRESENT');
  return reasons;
}

function capacityComparison(routes) {
  const measured = routes.filter((route) => route.capacity.status === 'AVAILABLE').length;
  if (measured === 0) return 'UNAVAILABLE';
  if (measured === routes.length) return 'MEASURED';
  return 'PARTIAL';
}

function buildHandoff(task, executor) {
  return {
    objective: task.objective,
    allowedScope: [...task.allowedScope],
    forbiddenScope: [...task.forbiddenScope],
    doneConditions: [...task.doneConditions],
    requiredTests: [...task.requiredTests],
    returnFormat: task.returnFormat,
    executor: publicRoute(executor),
    authorityLimit: 'HUMAN_ONLY_FOR_GATED_ACTIONS',
  };
}

function routingEvidence(routes) {
  return {
    capacityComparison: capacityComparison(routes),
    rule: 'Hard constraints before ranking; capacity participates only when all viable routes are measured.',
    candidates: routes.map((route) => ({
      id: route.id,
      provider: route.provider,
      jobFitScore: route.jobFitScore ?? 50,
      capacityStatus: route.capacity.status,
      remainingPercent: route.capacity.status === 'AVAILABLE' ? route.capacity.remainingPercent : null,
      incrementalCost: route.incrementalCost,
    })),
  };
}

export function routeTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return stop('SCHEMA_INVALID');
  if (input.schemaVersion !== 1) return stop('SCHEMA_INVALID');
  const taskErrors = validateTask(input.task);
  if (taskErrors.length > 0) return stop('SCHEMA_INVALID');
  if (!Array.isArray(input.routes)) return stop('SCHEMA_INVALID', input.task.id);
  const task = input.task;
  // Adversarial research without a declared counterpart provider is still
  // valid (e.g. the only prior research step is external/manual); the
  // distinctness preference below only applies when a counterpart is named.
  const role = task.role ?? 'executor';
  if (HUMAN_GATED.has(task.kind) || PROTECTED_DATA_CLASSES.has(task.dataClass) ||
      intersects(task.requiredPermissions, HUMAN_GATED)) {
    return stop('HUMAN_GATE_REQUIRED', task.id, [], role);
  }

  const validatedRoutes = [];
  for (const route of input.routes) {
    if (validateRoute(route).length > 0) return stop('SCHEMA_INVALID', task.id, [], role);
    validatedRoutes.push(route);
  }
  const ids = validatedRoutes.map((route) => route.id);
  if (new Set(ids).size !== ids.length) return stop('SCHEMA_INVALID', task.id, [], role);

  if (role === 'reviewer') {
    const reviewRejected = new Map();
    const reviewEligible = [];
    for (const route of validatedRoutes) {
      // Explicit reviewer-role routing: this reviewer task's OWN declared
      // requiredCapabilities (e.g. ['review','security-audit']) are the
      // actual requirement, enforced in full.
      const reasons = reviewerRejectionReasons(route, task, { requireTaskCapabilities: true });
      if (reasons.length > 0) reviewRejected.set(route.id, reasons);
      else reviewEligible.push(route);
    }
    if (reviewEligible.length === 0) {
      const rejectedRoutes = [...reviewRejected.entries()].map(([id, reasons]) => ({ id, reasons }));
      return stop('NO_EXECUTOR_AVAILABLE', task.id, rejectedRoutes, role);
    }
    const useCapacity = reviewEligible.every((route) => route.capacity.status === 'AVAILABLE');
    const ranked = [...reviewEligible].sort((a, b) => compareRoutes(a, b, { useMeasuredCapacity: useCapacity }));
    const selected = ranked[0];
    const rejectedRoutes = [...reviewRejected.entries()]
      .filter(([id]) => id !== selected.id)
      .map(([id, reasons]) => ({ id, reasons }));
    return {
      schemaVersion: 1,
      result: 'PROCEED',
      taskId: task.id,
      role,
      selectedExecutor: publicRoute(selected),
      selectedReviewer: null,
      rejectedRoutes,
      routingEvidence: routingEvidence(ranked),
      handoff: buildHandoff(task, selected),
    };
  }

  const executorRejected = new Map();
  const executorEligible = [];
  for (const route of validatedRoutes) {
    const reasons = executorRejectionReasons(route, task, role);
    if (reasons.length > 0) executorRejected.set(route.id, reasons);
    else executorEligible.push(route);
  }

  let candidatePool = executorEligible;
  if (role === 'researchAdversarial' && task.counterpartProviderId !== undefined) {
    // Alias-normalized vendor comparison: a relabeled same-vendor route
    // (e.g. 'claude' vs 'anthropic') must never be mistaken for an
    // independent counterpart. Original provider labels are always
    // preserved in routingEvidence/handoff; only this comparison normalizes.
    const counterpartVendor = providerVendorKey(task.counterpartProviderId);
    const distinct = candidatePool.filter((route) => providerVendorKey(route.provider) !== counterpartVendor);
    const sameProviderWithRationale = candidatePool.filter(
      (route) => providerVendorKey(route.provider) === counterpartVendor && nonEmptyString(route.distinctRouteRationale),
    );
    const sameProviderWithoutRationale = candidatePool.filter(
      (route) => providerVendorKey(route.provider) === counterpartVendor && !nonEmptyString(route.distinctRouteRationale),
    );
    for (const route of sameProviderWithoutRationale) {
      executorRejected.set(route.id, [...(executorRejected.get(route.id) || []), 'SAME_PROVIDER_ADVERSARIAL_RATIONALE_REQUIRED']);
    }
    candidatePool = distinct.length > 0 ? distinct : sameProviderWithRationale;
  }

  if (candidatePool.length === 0) {
    const rejectedRoutes = [...executorRejected.entries()].map(([id, reasons]) => ({ id, reasons }));
    return stop('NO_EXECUTOR_AVAILABLE', task.id, rejectedRoutes, role);
  }

  const executorUseCapacity = candidatePool.every((route) => route.capacity.status === 'AVAILABLE');
  const executorComparator = (a, b) => compareRoutes(a, b, { useMeasuredCapacity: executorUseCapacity });
  const ranked = [...candidatePool].sort(executorComparator);
  const executor = ranked[0];

  let reviewer = null;
  const reviewerRejected = new Map();
  if (task.independentReviewRequired) {
    const reviewerEligible = [];
    for (const route of validatedRoutes) {
      if (route.id === executor.id) continue;
      // Automatic independent-review pairing for THIS executor/implementation
      // task: never require the executor's own requiredCapabilities (e.g.
      // 'implementation') from the reviewer -- only generic 'review'.
      const reasons = reviewerRejectionReasons(route, task);
      if (reasons.length > 0) reviewerRejected.set(route.id, reasons);
      else reviewerEligible.push(route);
    }
    if (reviewerEligible.length > 0) {
      const reviewerUseCapacity = reviewerEligible.every((route) => route.capacity.status === 'AVAILABLE');
      const reviewerComparator = (a, b) => compareRoutes(a, b, { useMeasuredCapacity: reviewerUseCapacity });
      const executorVendor = providerVendorKey(executor.provider);
      const differentProvider = reviewerEligible.filter((route) => providerVendorKey(route.provider) !== executorVendor);
      reviewer = [...(differentProvider.length > 0 ? differentProvider : reviewerEligible)].sort(reviewerComparator)[0] ?? null;
    }
  }

  const rejectedRoutes = [];
  for (const route of validatedRoutes) {
    if (route.id === executor.id || route.id === reviewer?.id) continue;
    const reasons = [
      ...(executorRejected.get(route.id) || []),
      ...(task.independentReviewRequired ? (reviewerRejected.get(route.id) || []) : []),
    ];
    if (reasons.length > 0) rejectedRoutes.push({ id: route.id, reasons: [...new Set(reasons)] });
  }

  const result = task.independentReviewRequired && !reviewer ? 'NEEDS_REVIEW_ROUTE' : 'PROCEED';
  return {
    schemaVersion: 1,
    result,
    taskId: task.id,
    role,
    selectedExecutor: publicRoute(executor),
    selectedReviewer: publicRoute(reviewer),
    rejectedRoutes,
    routingEvidence: routingEvidence(ranked),
    handoff: buildHandoff(task, executor),
  };
}

function parseArgs(argv) {
  let inputPath = null;
  let pretty = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input' && argv[i + 1]) {
      inputPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--pretty') pretty = true;
    else return { valid: false, inputPath: null, pretty: false };
  }
  return { valid: nonEmptyString(inputPath), inputPath, pretty };
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
  const result = routeTask(input);
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  process.exitCode = result.result === 'PROCEED' ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
