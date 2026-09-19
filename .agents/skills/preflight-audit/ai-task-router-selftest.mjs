#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const routerArg = process.argv[2];
if (!routerArg) throw new Error('router path required');
const routerUrl = pathToFileURL(resolve(routerArg)).href;
const { routeTask, compareRoutes, validateRoute, validateTask } = await import(routerUrl);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function baseTask(overrides = {}) {
  return {
    id: 'task-1',
    kind: 'implementation',
    objective: 'Implement a bounded source-only change.',
    requiredCapabilities: ['implementation'],
    requiredPermissions: ['repo-read'],
    executionEnvironment: 'local-cli',
    dataClass: 'source-only',
    costPolicy: 'no-new-cost',
    independentReviewRequired: false,
    forbiddenAuthorities: ['merge', 'production'],
    allowedScope: ['src/**'],
    forbiddenScope: ['main'],
    doneConditions: ['tests pass'],
    requiredTests: ['selftest'],
    returnFormat: 'diff + summary',
    ...overrides,
  };
}
function baseRoute(overrides = {}) {
  return {
    id: 'route-a',
    provider: 'provider-a',
    availability: 'AVAILABLE',
    executionEnvironment: 'local-cli',
    capabilities: ['implementation', 'testing'],
    permissions: ['repo-read'],
    allowedDataClasses: ['source-only'],
    incrementalCost: 'INCLUDED',
    safetyStatus: 'SAFE_CONFIRMED',
    capacity: { status: 'UNAVAILABLE' },
    ...overrides,
  };
}

function routed(routes, task = baseTask()) {
  return routeTask({ schemaVersion: 1, task, routes });
}

// Capability and permission hard filters.
{
  const capability = routed([baseRoute({ capabilities: ['testing'] })]);
  assert(capability.result === 'STOP', 'missing capability must stop when no executor remains');
  assert(capability.rejectedRoutes[0].reasons.includes('MISSING_CAPABILITY'), 'missing capability reason');

  const permission = routed([baseRoute({ permissions: [] })]);
  assert(permission.result === 'STOP', 'missing permission must stop when no executor remains');
  assert(permission.rejectedRoutes[0].reasons.includes('MISSING_PERMISSION'), 'missing permission reason');
}
// Cost policy rejects extra/unknown cost under no-new-cost.
{
  const result = routed([
    baseRoute({ id: 'extra', incrementalCost: 'EXTRA' }),
    baseRoute({ id: 'unknown', incrementalCost: 'UNKNOWN' }),
    baseRoute({ id: 'included', incrementalCost: 'INCLUDED' }),
  ]);
  assert(result.result === 'PROCEED' && result.selectedExecutor.id === 'included', 'included route must remain');
  assert(result.rejectedRoutes.find((r) => r.id === 'extra').reasons.includes('EXTRA_COST_NOT_ALLOWED'), 'extra cost reason');
  assert(result.rejectedRoutes.find((r) => r.id === 'unknown').reasons.includes('INCREMENTAL_COST_UNKNOWN'), 'unknown cost reason');
}

// Measured capacity is used only when both otherwise-equivalent routes are measured.
{
  const result = routed([
    baseRoute({ id: 'low', capacity: { status: 'AVAILABLE', remainingPercent: 20 } }),
    baseRoute({ id: 'high', capacity: { status: 'AVAILABLE', remainingPercent: 80 } }),
  ]);
  assert(result.selectedExecutor.id === 'high', 'higher measured capacity must win equivalent measured tie');
  assert(result.routingEvidence.capacityComparison === 'MEASURED', 'all measured must report MEASURED');
}

// UNAVAILABLE capacity is not guessed or treated as 0%.
{
  const result = routed([
    baseRoute({ id: 'a-unmeasured', capacity: { status: 'UNAVAILABLE' } }),
    baseRoute({ id: 'z-measured', capacity: { status: 'AVAILABLE', remainingPercent: 1 } }),
  ]);
  assert(result.selectedExecutor.id === 'a-unmeasured', 'unmeasured capacity must not be penalized as zero');
  assert(result.routingEvidence.capacityComparison === 'PARTIAL', 'mixed evidence must report PARTIAL');
  const item = result.routingEvidence.candidates.find((candidate) => candidate.id === 'a-unmeasured');
  assert(item.remainingPercent === null, 'unmeasured route must emit null remainingPercent');
}
// Mixed measured/unmeasured capacity remains deterministic across permutations.
{
  const routes = [
    baseRoute({ id: 'a', capacity: { status: 'AVAILABLE', remainingPercent: 20 } }),
    baseRoute({ id: 'b', capacity: { status: 'UNAVAILABLE' } }),
    baseRoute({ id: 'c', capacity: { status: 'AVAILABLE', remainingPercent: 80 } }),
  ];
  const permutations = [
    [routes[0], routes[1], routes[2]], [routes[0], routes[2], routes[1]],
    [routes[1], routes[0], routes[2]], [routes[1], routes[2], routes[0]],
    [routes[2], routes[0], routes[1]], [routes[2], routes[1], routes[0]],
  ];
  const winners = permutations.map((items) => routed(items).selectedExecutor.id);
  assert(winners.every((id) => id === winners[0]), `mixed-capacity selection changed by input order: ${winners}`);
}

// Independent review prefers a different provider.
{
  const task = baseTask({ independentReviewRequired: true });
  const result = routed([
    baseRoute({ id: 'exec', provider: 'p1', jobFitScore: 90, capabilities: ['implementation'] }),
    baseRoute({ id: 'same-provider', provider: 'p1', jobFitScore: 80, capabilities: ['review'], permissions: ['repo-read'] }),
    baseRoute({ id: 'other-provider', provider: 'p2', jobFitScore: 70, capabilities: ['review'], permissions: ['repo-read'] }),
  ], task);
  assert(result.result === 'PROCEED', 'review route available should proceed');
  assert(result.selectedExecutor.id === 'exec', 'highest fit executor expected');
  assert(result.selectedReviewer.id === 'other-provider', 'different provider reviewer preferred');
  assert(!result.rejectedRoutes.some((route) => route.id === 'other-provider'), 'selected review-only route must not be reported rejected');
}

// Required review with no second route is explicitly non-PASS.
{
  const result = routed([baseRoute()], baseTask({ independentReviewRequired: true }));
  assert(result.result === 'NEEDS_REVIEW_ROUTE', 'missing reviewer must be NEEDS_REVIEW_ROUTE');
  assert(result.selectedReviewer === null, 'reviewer must be null');
}

// Review routes must have the read permission needed to inspect the target.
{
  const result = routed([
    baseRoute({ id: 'exec-read', provider: 'p1', capabilities: ['implementation'] }),
    baseRoute({ id: 'review-no-read', provider: 'p2', capabilities: ['review'], permissions: [] }),
  ], baseTask({ independentReviewRequired: true }));
  assert(result.result === 'NEEDS_REVIEW_ROUTE', 'review route without target-read permission must not qualify');
  assert(result.rejectedRoutes.some((route) => route.reasons.includes('REVIEW_MISSING_READ_PERMISSION')), 'review read-permission rejection must be recorded');
}

// Review always requires an explicit target-read permission, even when task permissions are execute-only.
{
  for (const requiredPermissions of [['test-run'], ['local-exec']]) {
    const result = routed([
      baseRoute({ id: 'exec-exec-only', provider: 'p1', permissions: requiredPermissions }),
      baseRoute({ id: 'review-no-read-exec-only', provider: 'p2', capabilities: ['review'], permissions: [] }),
    ], baseTask({ requiredPermissions, independentReviewRequired: true }));
    assert(result.result === 'NEEDS_REVIEW_ROUTE', `review without read permission must not qualify for ${requiredPermissions}`);
    assert(result.rejectedRoutes.some((route) => route.reasons.includes('REVIEW_TARGET_READ_PERMISSION_MISSING')), 'review target-read floor rejection missing');
  }
}

// Executor write permission maps to corresponding read permission for reviewer.
{
  const result = routed([
    baseRoute({ id: 'exec-write', provider: 'p1', capabilities: ['implementation'], permissions: ['repo-write'] }),
    baseRoute({ id: 'review-read', provider: 'p2', capabilities: ['review'], permissions: ['repo-read'] }),
  ], baseTask({ requiredPermissions: ['repo-write'], independentReviewRequired: true }));
  assert(result.result === 'PROCEED' && result.selectedReviewer.id === 'review-read', 'repo-write task must permit repo-read reviewer');
}

// Multiple implementation-only routes cannot masquerade as independent reviewers.
{
  const result = routed([
    baseRoute({ id: 'impl-a', provider: 'p1' }),
    baseRoute({ id: 'impl-b', provider: 'p2' }),
  ], baseTask({ independentReviewRequired: true }));
  assert(result.result === 'NEEDS_REVIEW_ROUTE', 'implementation-only peer must not satisfy review');
  assert(result.selectedReviewer === null, 'unqualified reviewer must remain null');
  assert(result.rejectedRoutes.some((route) => route.reasons.includes('REVIEW_CAPABILITY_MISSING')), 'review capability rejection must be recorded');
}

// Gated task authorities never route.
{
  for (const kind of ['merge', 'production', 'destructive', 'recurring-cost', 'external-data-route', 'lifecycle-responsibility', 'business-policy']) {
    const result = routed([baseRoute()], baseTask({ kind }));
    assert(result.result === 'STOP' && result.code === 'HUMAN_GATE_REQUIRED', `${kind} must human-gate`);
  }
  const permissionGate = routed([baseRoute({ permissions: ['repo-read', 'merge'] })], baseTask({ requiredPermissions: ['repo-read', 'merge'] }));
  assert(permissionGate.result === 'STOP' && permissionGate.code === 'HUMAN_GATE_REQUIRED', 'gated permission must human-gate');
}
// Protected or real data never routes.
{
  for (const dataClass of ['protected-data', 'real-data', 'patient-data']) {
    const result = routed([baseRoute()], baseTask({ dataClass }));
    assert(result.result === 'STOP' && result.code === 'HUMAN_GATE_REQUIRED', `${dataClass} must human-gate`);
  }
}

// Deterministic tie-break is route.id ascending and input-order independent.
{
  const a = baseRoute({ id: 'a-route', provider: 'z-provider' });
  const b = baseRoute({ id: 'b-route', provider: 'a-provider' });
  const first = routed([b, a]);
  const second = routed([a, b]);
  assert(first.selectedExecutor.id === 'a-route', 'route id must break full tie');
  assert(second.selectedExecutor.id === first.selectedExecutor.id, 'tie-break must ignore input order');
  assert(compareRoutes(a, b) === -compareRoutes(b, a), 'comparator must be antisymmetric');
}

// Handoff is a strict allow-list and contains the required bounded contract.
{
  const result = routed([baseRoute()]);
  const keys = Object.keys(result.handoff).sort();
  const expected = ['allowedScope', 'authorityLimit', 'doneConditions', 'executor', 'forbiddenScope', 'objective', 'requiredTests', 'returnFormat'].sort();
  assert(JSON.stringify(keys) === JSON.stringify(expected), `handoff keys changed: ${keys.join(',')}`);
  assert(result.handoff.authorityLimit === 'HUMAN_ONLY_FOR_GATED_ACTIONS', 'authority limit missing');
  assert(result.handoff.executor.id === 'route-a', 'executor missing from handoff');
}
// Malformed schema and unknown safety enums fail closed globally.
{
  assert(routeTask(null).result === 'STOP', 'null input must stop');
  assert(routeTask({ schemaVersion: 2, task: baseTask(), routes: [] }).result === 'STOP', 'unknown schema version must stop');
  assert(routeTask({ schemaVersion: 1, task: { id: 'broken' }, routes: [] }).result === 'STOP', 'incomplete task must stop');

  const unknownSafety = routed([baseRoute({ safetyStatus: 'MAYBE' })]);
  assert(unknownSafety.result === 'STOP' && unknownSafety.code === 'SCHEMA_INVALID', 'unknown safety enum must schema-stop');
  assert(unknownSafety.rejectedRoutes.length === 0, 'schema-stop must not echo malformed route fields');

  const unavailableWithGuess = routed([baseRoute({ capacity: { status: 'UNAVAILABLE', remainingPercent: 50 } })]);
  assert(unavailableWithGuess.result === 'STOP' && unavailableWithGuess.code === 'SCHEMA_INVALID', 'fabricated unavailable capacity must schema-stop');
  assert(validateRoute(baseRoute({ capacity: { status: 'UNAVAILABLE', remainingPercent: 50 } })).length > 0, 'validateRoute must reject guessed capacity');
  assert(validateTask(baseTask({ dataClass: 'mystery' })).length > 0, 'validateTask must reject unknown data class');

  assert(routed([baseRoute()], baseTask({ kind: 'merg' })).code === 'SCHEMA_INVALID', 'unknown kind must schema-stop');
  assert(routed([baseRoute()], baseTask({ requiredPermissions: ['repo-read', 'merg'] })).code === 'SCHEMA_INVALID', 'unknown permission must schema-stop');
  assert(routed([baseRoute()], baseTask({ forbiddenAuthorities: ['merg'] })).code === 'SCHEMA_INVALID', 'unknown forbidden authority must schema-stop');
  assert(routed([baseRoute({ permissions: ['repo-read', 'merg'] })]).code === 'SCHEMA_INVALID', 'unknown route permission must schema-stop');
  assert(routed([baseRoute({ allowedDataClasses: ['source-only', 'mystery'] })]).code === 'SCHEMA_INVALID', 'unknown route data class must schema-stop');
}

// Duplicate route IDs fail closed before ranking.
{
  const duplicate = routed([baseRoute({ id: 'dup' }), baseRoute({ id: 'dup', provider: 'provider-b' })]);
  assert(duplicate.result === 'STOP' && duplicate.code === 'SCHEMA_INVALID', 'duplicate route IDs must schema-stop');
}

// Invalid task IDs are never echoed on schema failure.
{
  const result = routeTask({ schemaVersion: 1, task: baseTask({ id: { secretMarker: 'SENSITIVE' } }), routes: [] });
  const output = JSON.stringify(result);
  assert(result.result === 'STOP' && result.taskId === null, 'invalid task id must not enter output');
  assert(!output.includes('SENSITIVE') && !output.includes('secretMarker'), 'invalid task id leaked');
}

// Unsafe/unknown routes and source-only data mismatch are hard-filtered.
{
  const result = routed([
    baseRoute({ id: 'unknown', safetyStatus: 'UNKNOWN' }),
    baseRoute({ id: 'unsafe', safetyStatus: 'UNSAFE' }),
  ]);
  assert(result.result === 'STOP', 'unconfirmed safety routes must not route');
  assert(result.rejectedRoutes.every((route) => route.reasons.includes('SAFETY_NOT_CONFIRMED')), 'safety rejection reason missing');

  const dataMismatch = routed([baseRoute({ allowedDataClasses: ['public'] })]);
  assert(dataMismatch.result === 'STOP', 'source-only task cannot route to public-only route');
  assert(dataMismatch.rejectedRoutes[0].reasons.includes('DATA_CLASS_NOT_ALLOWED'), 'data mismatch reason missing');
}
// Output is allow-listed: arbitrary route fields must never leak.
{
  const result = routed([baseRoute({ secretMarker: 'DO_NOT_EMIT_THIS' })]);
  const text = JSON.stringify(result);
  assert(!text.includes('DO_NOT_EMIT_THIS'), 'arbitrary route field leaked into output');
  assert(!text.includes('secretMarker'), 'arbitrary route key leaked into output');
}

// Availability and cost safety enums are closed sets.
{
  const unknownAvailability = routed([baseRoute({ availability: 'UNKNOWN' })]);
  assert(unknownAvailability.result === 'STOP', 'unknown availability must fail closed');
  const unknownCost = routed([baseRoute({ incrementalCost: 'MAYBE' })]);
  assert(unknownCost.result === 'STOP', 'unknown cost enum must fail closed');
}

console.log('ai-task-router selftest: PASS');
