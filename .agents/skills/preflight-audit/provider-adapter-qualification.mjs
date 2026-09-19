#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const EXECUTION_ENVIRONMENT = 'prompt-cli';
const SAFE_CAPABILITIES = new Set([
  'review', 'diagnosis', 'research', 'documentation', 'design',
  'planning', 'audit',
]);
const AUTH_EVIDENCE = new Set(['VERIFIED', 'UNKNOWN', 'FAILED']);
const TOOL_BOUNDARIES = new Set(['NO_LOCAL_TOOLS_ENFORCED', 'UNKNOWN', 'UNSAFE']);
const DATA_BOUNDARIES = new Set(['EXPLICIT_SAFE_PAYLOAD_ONLY', 'UNKNOWN', 'UNSAFE']);
const COST_BOUNDARIES = new Set([
  'INCLUDED_ONLY_ENFORCED', 'FREE_ONLY_ENFORCED', 'UNKNOWN', 'EXTRA_COST_POSSIBLE',
]);
const FALLBACK_BEHAVIORS = new Set([
  'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION', 'UNKNOWN', 'UNSAFE',
]);
const CAPACITY_STATES = new Set(['AVAILABLE', 'UNAVAILABLE']);
function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function uniqueStrings(value) {
  return stringArray(value) && new Set(value).size === value.length;
}
function validCapacity(capacity) {
  if (!capacity || typeof capacity !== 'object' || Array.isArray(capacity)) return false;
  if (!CAPACITY_STATES.has(capacity.status)) return false;
  if (capacity.status === 'UNAVAILABLE') return !('remainingPercent' in capacity);
  return Number.isFinite(capacity.remainingPercent) &&
    capacity.remainingPercent >= 0 && capacity.remainingPercent <= 100;
}
function publicCapacity(capacity) {
  return capacity.status === 'AVAILABLE'
    ? { status: 'AVAILABLE', remainingPercent: capacity.remainingPercent }
    : { status: 'UNAVAILABLE' };
}

export function validateAdapter(adapter) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return ['adapter_not_object'];
  if (!safeToken(adapter.id)) errors.push('id_invalid');
  if (!safeToken(adapter.provider)) errors.push('provider_invalid');
  if (adapter.executionEnvironment !== EXECUTION_ENVIRONMENT) errors.push('executionEnvironment_invalid');
  if (!uniqueStrings(adapter.capabilities) ||
      !adapter.capabilities.every((item) => SAFE_CAPABILITIES.has(item))) {
    errors.push('capabilities_invalid');
  }
  if (!validCapacity(adapter.capacity)) errors.push('capacity_invalid');
  const evidence = adapter.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push('evidence_invalid');
    return errors;
  }
  if (!AUTH_EVIDENCE.has(evidence.authentication)) errors.push('authentication_invalid');
  if (!TOOL_BOUNDARIES.has(evidence.toolBoundary)) errors.push('toolBoundary_invalid');
  if (!DATA_BOUNDARIES.has(evidence.dataBoundary)) errors.push('dataBoundary_invalid');
  if (!COST_BOUNDARIES.has(evidence.incrementalCostBoundary)) errors.push('incrementalCostBoundary_invalid');
  if (!FALLBACK_BEHAVIORS.has(evidence.fallbackBehavior)) errors.push('fallbackBehavior_invalid');
  return errors;
}

function qualificationReasons(adapter) {
  const reasons = [];
  if (adapter.evidence.authentication !== 'VERIFIED') reasons.push('AUTH_NOT_VERIFIED');
  if (adapter.evidence.toolBoundary !== 'NO_LOCAL_TOOLS_ENFORCED') reasons.push('TOOL_BOUNDARY_NOT_ENFORCED');
  if (adapter.evidence.dataBoundary !== 'EXPLICIT_SAFE_PAYLOAD_ONLY') reasons.push('DATA_BOUNDARY_NOT_ENFORCED');
  const cost = adapter.evidence.incrementalCostBoundary;
  if (cost !== 'INCLUDED_ONLY_ENFORCED' && cost !== 'FREE_ONLY_ENFORCED') {
    reasons.push('NO_NEW_COST_NOT_ENFORCED');
  }
  if (adapter.evidence.fallbackBehavior !== 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION') {
    reasons.push('FALLBACK_NOT_FAIL_CLOSED');
  }
  return reasons;
}

function routeFor(adapter, qualified) {
  const costEvidence = adapter.evidence.incrementalCostBoundary;
  const incrementalCost = qualified
    ? (costEvidence === 'FREE_ONLY_ENFORCED' ? 'FREE' : 'INCLUDED')
    : 'UNKNOWN';
  return {
    id: adapter.id,
    provider: adapter.provider,
    availability: qualified ? 'AVAILABLE' : 'UNAVAILABLE',
    executionEnvironment: EXECUTION_ENVIRONMENT,
    capabilities: [...adapter.capabilities],
    permissions: ['source-read'],
    allowedDataClasses: ['source-only', 'synthetic', 'public'],
    incrementalCost,
    safetyStatus: qualified ? 'SAFE_CONFIRMED' : 'UNKNOWN',
    capacity: publicCapacity(adapter.capacity),
  };
}

function stop(code) {
  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'STOP',
    code,
    qualifiedRoutes: [],
    decisions: [],
    rule: 'Adapter promotion requires closed, machine-verifiable auth, tool, data, cost, and fallback evidence.',
  };
}

export function qualifyAdapters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return stop('SCHEMA_INVALID');
  if (input.schemaVersion !== SCHEMA_VERSION || !Array.isArray(input.adapters)) return stop('SCHEMA_INVALID');
  const ids = new Set();
  for (const adapter of input.adapters) {
    if (validateAdapter(adapter).length > 0) return stop('SCHEMA_INVALID');
    if (ids.has(adapter.id)) return stop('DUPLICATE_ADAPTER_ID');
    ids.add(adapter.id);
  }

  const decisions = [];
  const qualifiedRoutes = [];
  for (const adapter of input.adapters) {
    const reasons = qualificationReasons(adapter);
    const qualified = reasons.length === 0;
    const route = routeFor(adapter, qualified);
    decisions.push({
      id: adapter.id,
      provider: adapter.provider,
      status: qualified ? 'QUALIFIED' : 'UNQUALIFIED',
      reasons,
    });
    if (qualified) qualifiedRoutes.push(route);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    result: qualifiedRoutes.length > 0 ? 'QUALIFIED' : 'NO_QUALIFIED_ADAPTER',
    qualifiedRoutes,
    decisions,
    rule: 'Adapter promotion requires closed, machine-verifiable auth, tool, data, cost, and fallback evidence.',
  };
}

function parseArgs(argv) {
  let inputPath = null;
  let pretty = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pretty') pretty = true;
    else if (argv[i] === '--input' && argv[i + 1]) {
      inputPath = argv[i + 1];
      i += 1;
    } else return { valid: false, inputPath: null, pretty };
  }
  return { valid: Boolean(inputPath), inputPath, pretty };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) {
    process.stdout.write(`${JSON.stringify(stop('ARGUMENT_INVALID'))}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const raw = fs.readFileSync(path.resolve(args.inputPath), 'utf8');
    const input = JSON.parse(raw);
    const result = qualifyAdapters(input);
    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    if (result.result !== 'QUALIFIED') process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify(stop('INPUT_READ_OR_PARSE_FAILED'))}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
