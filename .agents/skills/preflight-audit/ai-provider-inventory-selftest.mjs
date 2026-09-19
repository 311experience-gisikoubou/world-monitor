#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const inventoryArg = process.argv[2];
const routerArg = process.argv[3];
if (!inventoryArg || !routerArg) throw new Error('inventory and router paths required');

const inventoryUrl = pathToFileURL(resolve(inventoryArg)).href;
const routerUrl = pathToFileURL(resolve(routerArg)).href;
const { buildInventory, conservativeCodexCapacity } = await import(inventoryUrl);
const { validateRoute, routeTask } = await import(routerUrl);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function codex(overrides = {}) {
  return {
    cliStatus: 'AVAILABLE',
    version: 'Codex 1.2.3 extra text',
    capacity: {
      status: 'AVAILABLE',
      source: 'codex_app_server_account_rateLimits_read',
      primary: { remainingPercent: 80 },
      secondary: { remainingPercent: 60 },
    },
    ...overrides,
  };
}

function claude(overrides = {}) {
  return {
    cliStatus: 'AVAILABLE',
    version: 'Claude Code 2.3.4',
    auth: { status: 'AUTHENTICATED', subscriptionType: 'pro' },
    capacity: { status: 'UNAVAILABLE' },
    ...overrides,
  };
}

function generic(cliStatus = 'UNAVAILABLE', overrides = {}) {
  return {
    cliStatus,
    version: cliStatus === 'AVAILABLE' ? 'Gemini 3.4.5' : null,
    reason: cliStatus === 'AVAILABLE' ? null : 'cli_not_found',
    ...overrides,
  };
}

function built(overrides = {}) {
  return buildInventory({
    codex: codex(),
    claude: claude(),
    gemini: generic(),
    antigravity: generic(),
    codexBillingAuth: { status: 'AUTHENTICATED', method: 'CHATGPT', subscriptionType: null },
    claudeBillingAuth: { status: 'AUTHENTICATED', method: 'CLAUDE_AI', subscriptionType: 'pro' },
    generatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  });
}

{
  const capacity = conservativeCodexCapacity(codex().capacity);
  assert(capacity.status === 'AVAILABLE' && capacity.remainingPercent === 60, 'codex capacity must use conservative measured minimum');
  assert(conservativeCodexCapacity({ status: 'UNAVAILABLE' }).status === 'UNAVAILABLE', 'unavailable capacity must stay unavailable');
  assert(conservativeCodexCapacity({ status: 'AVAILABLE', primary: { remainingPercent: 150 }, secondary: { remainingPercent: 60 } }).status === 'UNAVAILABLE', 'out-of-range capacity must fail closed');
  assert(conservativeCodexCapacity({ status: 'AVAILABLE', primary: { remainingPercent: NaN }, secondary: { remainingPercent: 60 } }).status === 'UNAVAILABLE', 'malformed measured window must fail closed');
}

{
  const inventory = built();
  assert(inventory.routes.length === 4, 'four route records expected');
  for (const route of inventory.routes) {
    assert(route.availability === 'UNAVAILABLE', `${route.id} must remain unavailable until execution and cost boundaries are verified`);
    assert(route.safetyStatus === 'UNKNOWN', `${route.id} safety must remain unknown`);
    assert(route.incrementalCost === 'UNKNOWN', `${route.id} cost must remain unknown`);
  }
  const codexRoute = inventory.routes.find((route) => route.id === 'codex-prompt');
  const claudeRoute = inventory.routes.find((route) => route.id === 'claude-prompt');
  assert(codexRoute.capacity.remainingPercent === 60, 'codex measured capacity may still be recorded');
  assert(claudeRoute.capacity.status === 'UNAVAILABLE', 'claude capacity must not be guessed');
  assert(inventory.observations.codex.authMethod === 'CHATGPT', 'codex auth method evidence should be retained');
  assert(inventory.observations.claude.authMethod === 'CLAUDE_AI', 'claude auth method evidence should be retained');
  assert(inventory.observations.claude.routeReason === 'metered_extra_usage_boundary_unverified', 'claude route must record why cost remains unknown');
}

{
  const inventory = built({
    gemini: generic('AVAILABLE'),
    antigravity: generic('AVAILABLE'),
  });
  for (const id of ['gemini-prompt', 'antigravity-prompt']) {
    const route = inventory.routes.find((item) => item.id === id);
    assert(route.availability === 'UNAVAILABLE', `${id} must stay unavailable without verified prompt adapter`);
    assert(route.incrementalCost === 'UNKNOWN', `${id} cost must stay unknown`);
    assert(route.capacity.status === 'UNAVAILABLE', `${id} capacity must stay unavailable`);
  }
}

{
  const inventory = built();
  for (const route of inventory.routes) {
    assert(validateRoute(route).length === 0, `${route.id} must satisfy router schema`);
    assert(route.allowedDataClasses.every((value) => ['source-only', 'synthetic', 'public'].includes(value)), `${route.id} must only allow safe data classes`);
    assert(route.permissions.length === 1 && route.permissions[0] === 'source-read', `${route.id} must claim source-read only`);
  }
}

{
  const inventory = built();
  const task = {
    id: 'review-1', kind: 'review', objective: 'Review source-only diff.',
    requiredCapabilities: ['review'], requiredPermissions: ['source-read'],
    executionEnvironment: 'prompt-cli', dataClass: 'source-only',
    costPolicy: 'no-new-cost', independentReviewRequired: false,
    forbiddenAuthorities: ['merge', 'production'], allowedScope: ['diff'],
    forbiddenScope: ['real-data'], doneConditions: ['review returned'],
    requiredTests: [], returnFormat: 'verdict',
  };

  const result = routeTask({ schemaVersion: 1, task, routes: inventory.routes });
  assert(result.result === 'STOP' && result.code === 'NO_EXECUTOR_AVAILABLE', 'inventory must not auto-route without verified execution/cost boundaries');
}

{
  const inventory = built({
    codex: codex({ version: '1.2.3-SECRET', secretMarker: 'DO_NOT_EMIT', binaryPath: 'C:\\secret\\codex.exe' }),
    claude: claude({ version: '2.3.4+TOKEN', token: 'DO_NOT_EMIT_TOO' }),
    gemini: generic('UNAVAILABLE', { reason: 'secret-reason' }),
    generatedAt: 'not-a-date SECRET',
  });
  const output = JSON.stringify(inventory);
  assert(!output.includes('DO_NOT_EMIT') && !output.includes('SECRET') && !output.includes('TOKEN'), 'arbitrary provider/version/timestamp strings must not leak');
  assert(!output.includes('binaryPath') && !output.includes('token') && !output.includes('secret-reason'), 'unapproved fields/reasons must not leak');
  assert(inventory.generatedAt === null, 'invalid generatedAt must fail closed');
  assert(inventory.observations.codex.version === '1.2.3', 'version suffix must be stripped');
  assert(inventory.observations.claude.version === '2.3.4', 'build suffix must be stripped');
  assert(inventory.observations.gemini.routeReason === 'cli_not_found', 'unknown reason must use safe fallback');
}

{
  const inventory = built({ openAiApiKeyPresent: true, anthropicApiKeyPresent: true });
  assert(inventory.observations.codex.apiKeyEnvPresent === true, 'OpenAI API key presence may be exposed only as boolean');
  assert(inventory.observations.claude.apiKeyEnvPresent === true, 'Anthropic API key presence may be exposed only as boolean');
  assert(inventory.routes.every((route) => route.incrementalCost === 'UNKNOWN'), 'API-key presence cannot promote cost evidence');
}

console.log('ai-provider-inventory selftest: PASS');
