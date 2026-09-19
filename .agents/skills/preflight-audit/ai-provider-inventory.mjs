#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  observeCodex,
  observeClaude,
  descriptorForResolvedPath,
} from './ai-capacity-observer.mjs';

const DEFAULT_TIMEOUT_MS = 12000;
const SAFE_DATA_CLASSES = ['source-only', 'synthetic', 'public'];
const PROMPT_ENVIRONMENT = 'prompt-cli';
const KNOWN_CLAUDE_SUBSCRIPTIONS = new Set(['pro', 'max', 'team', 'enterprise']);
const SAFE_REASONS = new Set([
  'cli_not_found',
  'version_probe_failed',
  'prompt_smoke_timeout',
  'prompt_smoke_failed',
  'prompt_smoke_unexpected_output',
  'prompt_adapter_not_verified',
  'adapter_local_tool_boundary_not_verified',
  'metered_extra_usage_boundary_unverified',
  'cost_or_auth_not_safely_confirmed',
  'auth_probe_failed',
  'auth_method_unverified',
  'not_run',
]);

function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let pretty = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pretty') pretty = true;
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed >= 1000) timeoutMs = parsed;
      i += 1;
    } else {
      return { valid: false, timeoutMs, pretty };
    }
  }
  return { valid: true, timeoutMs, pretty };
}

function fileExists(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function lookupOnPath(command) {
  const lookup = process.platform === 'win32' ? ['where.exe', [command]] : ['which', [command]];
  const run = spawnSync(lookup[0], lookup[1], {
    encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024,
  });
  if (run.status !== 0) return null;
  const candidate = String(run.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return candidate ? descriptorForResolvedPath(candidate) : null;
}

export function resolveProviderCommand(kind) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = [];
  if (kind === 'codex') {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  } else if (kind === 'claude') {
    candidates.push(path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  } else if (kind === 'gemini' || kind === 'antigravity') {
    const executable = process.platform === 'win32' ? `${kind}.cmd` : kind;
    candidates.push(
      path.join(appData, 'npm', executable),
      path.join(home, '.local', 'bin', process.platform === 'win32' ? `${kind}.exe` : kind),
    );
  }
  for (const candidate of candidates) {
    if (!fileExists(candidate)) continue;
    if (kind === 'codex' && candidate.endsWith('.js')) {
      return { file: process.execPath, prefix: [candidate] };
    }
    return descriptorForResolvedPath(candidate);
  }
  return lookupOnPath(kind);
}

function versionFrom(text) {
  const match = String(text || '').match(/\b\d+\.\d+\.\d+\b/);
  return match ? match[0] : null;
}
function safeVersion(value) {
  return typeof value === 'string' ? versionFrom(value) : null;
}
function safeReason(value, fallback = 'not_run') {
  return typeof value === 'string' && SAFE_REASONS.has(value) ? value : fallback;
}
function safeSubscription(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : null;
  return normalized && KNOWN_CLAUDE_SUBSCRIPTIONS.has(normalized) ? normalized : null;
}
function safeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function observeGenericCli(kind, timeoutMs, desc = resolveProviderCommand(kind)) {
  if (!desc) return { cliStatus: 'UNAVAILABLE', version: null, reason: 'cli_not_found' };
  const run = spawnSync(desc.file, [...desc.prefix, '--version'], {
    encoding: 'utf8', windowsHide: true, timeout: Math.min(timeoutMs, 5000), maxBuffer: 64 * 1024,
  });
  if (run.error || run.status !== 0) {
    return { cliStatus: 'UNAVAILABLE', version: null, reason: 'version_probe_failed' };
  }
  return { cliStatus: 'AVAILABLE', version: versionFrom(run.stdout || run.stderr), reason: null };
}

export function observeBillingAuth(kind, timeoutMs, desc = resolveProviderCommand(kind)) {
  if (!desc) return { status: 'UNAVAILABLE', method: 'UNKNOWN', subscriptionType: null, reason: 'cli_not_found' };
  if (kind === 'codex') {
    const run = spawnSync(desc.file, [...desc.prefix, 'login', 'status'], {
      encoding: 'utf8', windowsHide: true, timeout: Math.min(timeoutMs, 5000), maxBuffer: 64 * 1024,
    });
    if (run.error || run.status !== 0) {
      return { status: 'UNAVAILABLE', method: 'UNKNOWN', subscriptionType: null, reason: 'auth_probe_failed' };
    }
    const output = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
    if (/^Logged in using ChatGPT$/i.test(output)) {
      return { status: 'AUTHENTICATED', method: 'CHATGPT', subscriptionType: null, reason: null };
    }
    return { status: 'UNAVAILABLE', method: 'UNKNOWN', subscriptionType: null, reason: 'auth_method_unverified' };
  }
  if (kind === 'claude') {
    const run = spawnSync(desc.file, [...desc.prefix, 'auth', 'status', '--json'], {
      encoding: 'utf8', windowsHide: true, timeout: Math.min(timeoutMs, 5000), maxBuffer: 64 * 1024,
    });
    if (run.error || run.status !== 0) {
      return { status: 'UNAVAILABLE', method: 'UNKNOWN', subscriptionType: null, reason: 'auth_probe_failed' };
    }
    try {
      const payload = JSON.parse(run.stdout);
      const subscriptionType = safeSubscription(payload?.subscriptionType);
      if (payload?.loggedIn === true && payload?.authMethod === 'claude.ai' && subscriptionType) {
        return { status: 'AUTHENTICATED', method: 'CLAUDE_AI', subscriptionType, reason: null };
      }
    } catch { /* fail closed */ }
    return { status: 'UNAVAILABLE', method: 'UNKNOWN', subscriptionType: null, reason: 'auth_method_unverified' };
  }
  return { status: 'UNAVAILABLE', method: 'UNKNOWN', subscriptionType: null, reason: 'auth_method_unverified' };
}

export function conservativeCodexCapacity(capacity) {
  if (capacity?.status !== 'AVAILABLE') return { status: 'UNAVAILABLE' };
  const windows = [capacity.primary, capacity.secondary].filter((window) => window != null);
  if (windows.length === 0) return { status: 'UNAVAILABLE' };
  const values = [];
  for (const window of windows) {
    const value = window?.remainingPercent;
    if (!Number.isFinite(value) || value < 0 || value > 100) return { status: 'UNAVAILABLE' };
    values.push(value);
  }
  return { status: 'AVAILABLE', remainingPercent: Math.min(...values) };
}

function unavailableCapacity() {
  return { status: 'UNAVAILABLE' };
}

function safeObservation(base, extra = {}) {
  return {
    cliStatus: base?.cliStatus === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
    version: safeVersion(base?.version),
    ...extra,
  };
}

function routeBase({ id, provider, capabilities, permissions = ['source-read'] }) {
  return {
    id,
    provider,
    availability: 'UNAVAILABLE',
    executionEnvironment: PROMPT_ENVIRONMENT,
    capabilities,
    permissions,
    allowedDataClasses: [...SAFE_DATA_CLASSES],
    incrementalCost: 'UNKNOWN',
    safetyStatus: 'UNKNOWN',
    capacity: unavailableCapacity(),
  };
}

export function buildInventory({
  codex,
  claude,
  gemini,
  antigravity,
  codexBillingAuth,
  claudeBillingAuth,
  openAiApiKeyPresent = false,
  anthropicApiKeyPresent = false,
  generatedAt = new Date().toISOString(),
}) {
  const claudeSubscription = safeSubscription(claudeBillingAuth?.subscriptionType);
  const codexCost = 'UNKNOWN';
  const claudeCost = 'UNKNOWN';

  const codexRoute = routeBase({
    id: 'codex-prompt',
    provider: 'openai',
    capabilities: ['review', 'diagnosis', 'research', 'documentation'],
  });
  codexRoute.incrementalCost = codexCost;
  codexRoute.capacity = conservativeCodexCapacity(codex?.capacity);
  // Codex prompt execution can still expose local read tools under the current CLI route.
  // Do not promote until a dispatcher adapter can enforce a narrower tool/data boundary.

  const claudeRoute = routeBase({
    id: 'claude-prompt',
    provider: 'anthropic',
    capabilities: ['review', 'diagnosis', 'research', 'documentation', 'design'],
  });
  claudeRoute.incrementalCost = claudeCost;
  const geminiRoute = routeBase({
    id: 'gemini-prompt',
    provider: 'google',
    capabilities: ['review', 'diagnosis', 'research'],
  });
  const antigravityRoute = routeBase({
    id: 'antigravity-prompt',
    provider: 'google',
    capabilities: ['review', 'diagnosis', 'research'],
  });

  const observations = {
    codex: safeObservation(codex, {
      authMethod: codexBillingAuth?.method === 'CHATGPT' ? 'CHATGPT' : 'UNKNOWN',
      routeStatus: 'UNAVAILABLE',
      routeReason: 'adapter_local_tool_boundary_not_verified',
      costState: codexCost,
      capacityStatus: codexRoute.capacity.status,
      apiKeyEnvPresent: Boolean(openAiApiKeyPresent),
    }),
    claude: safeObservation(claude, {
      authMethod: claudeBillingAuth?.method === 'CLAUDE_AI' ? 'CLAUDE_AI' : 'UNKNOWN',
      subscriptionType: claudeSubscription,
      routeStatus: 'UNAVAILABLE',
      routeReason: 'metered_extra_usage_boundary_unverified',
      costState: claudeCost,
      capacityStatus: 'UNAVAILABLE',
      apiKeyEnvPresent: Boolean(anthropicApiKeyPresent),
    }),
    gemini: safeObservation(gemini, {
      routeStatus: 'UNAVAILABLE',
      routeReason: gemini?.cliStatus === 'AVAILABLE'
        ? 'prompt_adapter_not_verified' : safeReason(gemini?.reason, 'cli_not_found'),
      costState: 'UNKNOWN',
      capacityStatus: 'UNAVAILABLE',
    }),
    antigravity: safeObservation(antigravity, {
      routeStatus: 'UNAVAILABLE',
      routeReason: antigravity?.cliStatus === 'AVAILABLE'
        ? 'prompt_adapter_not_verified' : safeReason(antigravity?.reason, 'cli_not_found'),
      costState: 'UNKNOWN',
      capacityStatus: 'UNAVAILABLE',
    }),
  };

  return {
    schemaVersion: 1,
    generatedAt: safeTimestamp(generatedAt),
    executionEnvironment: PROMPT_ENVIRONMENT,
    routes: [codexRoute, claudeRoute, geminiRoute, antigravityRoute],
    observations,
    rule: 'Only measured local route facts are promoted; unknown capacity, cost, adapters, and permissions are never inferred.',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, result: 'STOP', code: 'ARGUMENT_INVALID' })}\n`);
    process.exitCode = 2;
    return;
  }

  const [codex, claude] = await Promise.all([
    observeCodex(args.timeoutMs),
    Promise.resolve(observeClaude(args.timeoutMs)),
  ]);
  const gemini = observeGenericCli('gemini', args.timeoutMs);
  const antigravity = observeGenericCli('antigravity', args.timeoutMs);
  const codexBillingAuth = observeBillingAuth('codex', args.timeoutMs);
  const claudeBillingAuth = observeBillingAuth('claude', args.timeoutMs);

  const openAiApiKeyPresent = Boolean(process.env.OPENAI_API_KEY);
  const anthropicApiKeyPresent = Boolean(process.env.ANTHROPIC_API_KEY);

  const inventory = buildInventory({
    codex,
    claude,
    gemini,
    antigravity,
    codexBillingAuth,
    claudeBillingAuth,
    openAiApiKeyPresent,
    anthropicApiKeyPresent,
  });
  process.stdout.write(`${JSON.stringify(inventory, null, args.pretty ? 2 : 0)}\n`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, result: 'STOP', code: 'INVENTORY_INTERNAL_ERROR' })}\n`);
    process.exitCode = 2;
  });
}
