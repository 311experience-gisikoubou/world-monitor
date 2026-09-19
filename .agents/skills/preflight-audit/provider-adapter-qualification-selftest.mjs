#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const gateArg = process.argv[2];
const routerArg = process.argv[3];
if (!gateArg || !routerArg) throw new Error('qualification gate and router paths required');
const gatePath = resolve(gateArg);
const gateUrl = pathToFileURL(gatePath).href;
const routerUrl = pathToFileURL(resolve(routerArg)).href;
const { qualifyAdapters, validateAdapter } = await import(gateUrl);
const { validateRoute, routeTask } = await import(routerUrl);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}
function evidence(overrides = {}) {
  return {
    authentication: 'VERIFIED',
    toolBoundary: 'NO_LOCAL_TOOLS_ENFORCED',
    dataBoundary: 'EXPLICIT_SAFE_PAYLOAD_ONLY',
    incrementalCostBoundary: 'INCLUDED_ONLY_ENFORCED',
    fallbackBehavior: 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION',
    ...overrides,
  };
}
function adapter(overrides = {}) {
  return {
    id: 'safe-adapter',
    provider: 'example',
    executionEnvironment: 'prompt-cli',
    capabilities: ['review', 'diagnosis'],
    capacity: { status: 'AVAILABLE', remainingPercent: 72 },
    evidence: evidence(),
    ...overrides,
  };
}
function qualified(overrides = {}) {
  return qualifyAdapters({ schemaVersion: 1, adapters: [adapter(overrides)] });
}

{
  const result = qualified();
  assert(result.result === 'QUALIFIED', 'complete evidence must qualify');
  assert(result.qualifiedRoutes.length === 1, 'one qualified route expected');
  const route = result.qualifiedRoutes[0];
  assert(route.availability === 'AVAILABLE', 'qualified route must be available');
  assert(route.incrementalCost === 'INCLUDED', 'included-only evidence must map to INCLUDED');
  assert(route.safetyStatus === 'SAFE_CONFIRMED', 'qualified route safety must be confirmed');
  assert(route.permissions.length === 1 && route.permissions[0] === 'source-read', 'route must be source-read only');
  assert(route.allowedDataClasses.join(',') === 'source-only,synthetic,public', 'route data classes must stay safe');
  assert(validateRoute(route).length === 0, 'qualified route must satisfy router schema');
}
{
  const result = qualified({
    evidence: evidence({ incrementalCostBoundary: 'FREE_ONLY_ENFORCED' }),
    capacity: { status: 'UNAVAILABLE' },
  });
  assert(result.result === 'QUALIFIED', 'free-only adapter may qualify without measured capacity');
  const route = result.qualifiedRoutes[0];
  assert(route.incrementalCost === 'FREE', 'free-only evidence must map to FREE');
  assert(route.capacity.status === 'UNAVAILABLE', 'unavailable capacity must stay unavailable');
  assert(!('remainingPercent' in route.capacity), 'capacity must not be guessed');
}

const evidenceFailures = [
  ['authentication', 'UNKNOWN', 'AUTH_NOT_VERIFIED'],
  ['toolBoundary', 'UNKNOWN', 'TOOL_BOUNDARY_NOT_ENFORCED'],
  ['dataBoundary', 'UNKNOWN', 'DATA_BOUNDARY_NOT_ENFORCED'],
  ['incrementalCostBoundary', 'UNKNOWN', 'NO_NEW_COST_NOT_ENFORCED'],
  ['incrementalCostBoundary', 'EXTRA_COST_POSSIBLE', 'NO_NEW_COST_NOT_ENFORCED'],
  ['fallbackBehavior', 'UNKNOWN', 'FALLBACK_NOT_FAIL_CLOSED'],
];
for (const [field, value, reason] of evidenceFailures) {
  const result = qualified({ evidence: evidence({ [field]: value }) });
  assert(result.result === 'NO_QUALIFIED_ADAPTER', `${field} failure must not qualify`);
  assert(result.qualifiedRoutes.length === 0, `${field} failure must emit no route`);
  assert(result.decisions[0].reasons.includes(reason), `${field} failure reason expected`);
}
{
  const invalidCapacity = qualifyAdapters({
    schemaVersion: 1,
    adapters: [adapter({ capacity: { status: 'AVAILABLE', remainingPercent: 101 } })],
  });
  assert(invalidCapacity.result === 'STOP' && invalidCapacity.code === 'SCHEMA_INVALID', 'invalid capacity must stop');
  const unknownCapability = qualifyAdapters({
    schemaVersion: 1,
    adapters: [adapter({ capabilities: ['review', 'secret-capability'] })],
  });
  assert(unknownCapability.result === 'STOP' && unknownCapability.code === 'SCHEMA_INVALID', 'unknown capability must stop');
  const unknownEvidence = qualifyAdapters({
    schemaVersion: 1,
    adapters: [adapter({ evidence: evidence({ authentication: 'VERIFIED_SECRET' }) })],
  });
  assert(unknownEvidence.result === 'STOP' && unknownEvidence.code === 'SCHEMA_INVALID', 'unknown evidence value must stop');
  const unknownCapacityState = qualifyAdapters({
    schemaVersion: 1, adapters: [adapter({ capacity: { status: 'UNKNOWN' } })],
  });
  assert(unknownCapacityState.result === 'STOP', 'unknown capacity state must stop');
  const unavailableWithPercent = qualifyAdapters({
    schemaVersion: 1, adapters: [adapter({ capacity: { status: 'UNAVAILABLE', remainingPercent: 50 } })],
  });
  assert(unavailableWithPercent.result === 'STOP', 'unavailable capacity must forbid remainingPercent');
  const duplicate = qualifyAdapters({
    schemaVersion: 1,
    adapters: [adapter(), adapter({ provider: 'other' })],
  });
  assert(duplicate.result === 'STOP' && duplicate.code === 'DUPLICATE_ADAPTER_ID', 'duplicate ids must stop');
}

{
  const input = adapter({
    secretMarker: 'DO_NOT_EMIT',
    evidence: { ...evidence(), secretEvidence: 'DO_NOT_EMIT_TOO' },
  });
  const output = JSON.stringify(qualifyAdapters({ schemaVersion: 1, adapters: [input] }));
  assert(!output.includes('DO_NOT_EMIT'), 'arbitrary input fields must not leak');
  const malformed = qualifyAdapters({ schemaVersion: 1, adapters: [{ id: 'bad id', secret: 'LEAK' }] });
  assert(JSON.stringify(malformed).includes('LEAK') === false, 'schema failure must not echo malformed input');
}
{
  const route = qualified().qualifiedRoutes[0];
  const task = {
    id: 'qualification-smoke', kind: 'review', objective: 'Review explicit source payload.',
    requiredCapabilities: ['review'], requiredPermissions: ['source-read'],
    executionEnvironment: 'prompt-cli', dataClass: 'source-only',
    costPolicy: 'no-new-cost', independentReviewRequired: false,
    forbiddenAuthorities: ['merge', 'production'], allowedScope: ['explicit-payload'],
    forbiddenScope: ['protected-data'], doneConditions: ['review returned'],
    requiredTests: [], returnFormat: 'verdict',
  };
  const routed = routeTask({ schemaVersion: 1, task, routes: [route] });
  assert(routed.result === 'PROCEED', 'qualified route must feed router directly');
  const blocked = routeTask({ schemaVersion: 1, task, routes: [] });
  assert(blocked.result === 'STOP' && blocked.code === 'NO_EXECUTOR_AVAILABLE', 'no qualified route must remain stopped');
}

{
  assert(validateAdapter(adapter()).length === 0, 'valid adapter fixture expected');
  const source = fs.readFileSync(gatePath, 'utf8');
  assert(!source.includes("node:child_process"), 'qualification gate must not invoke provider processes');
  assert(!source.includes('spawnSync(') && !source.includes('execSync('), 'qualification gate must stay observation-only');
}

console.log('provider-adapter-qualification selftest: PASS');
