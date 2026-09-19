#!/usr/bin/env node
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { observeCodex } from './ai-capacity-observer.mjs';
import {
  resolveProviderCommand,
  observeGenericCli,
  conservativeCodexCapacity,
} from './ai-provider-inventory.mjs';
import { qualifyAdapters } from './provider-adapter-qualification.mjs';
import { probeClaudeSubscriptionRunner } from './claude-subscription-runner.mjs';

const DEFAULT_TIMEOUT_MS = 12000;
const READ_CAPABILITIES = ['review', 'diagnosis', 'research', 'documentation'];
const CREDIT_BALANCE_STATES = new Set(['NONE', 'ZERO', 'POSITIVE', 'UNLIMITED', 'UNKNOWN']);
const CODEX_SUPPORT_KEYS = ['isolatedConfig', 'ephemeral', 'readOnlySandbox', 'isolatedRoot'];
const CLAUDE_SUPPORT_KEYS = ['safeMode', 'toolsDisabled', 'strictMcp', 'noPersistence', 'systemPrompt', 'disableSkills', 'noChrome'];

function allFlagsTrue(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    keys.every((key) => value[key] === true);
}
function safeCreditBalanceState(credits) {
  if (credits?.status !== 'AVAILABLE') return 'UNKNOWN';
  return CREDIT_BALANCE_STATES.has(credits.balanceState) ? credits.balanceState : 'UNKNOWN';
}

function run(desc, args, timeoutMs) {
  return spawnSync(desc.file, [...desc.prefix, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024,
  });
}
function boolFromDetail(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

export function sanitizeCodexDoctor(payload) {
  const auth = payload?.checks?.['auth.credentials']?.details ?? {};
  const sandbox = payload?.checks?.['sandbox.helpers']?.details ?? {};
  const storedApiKey = boolFromDetail(auth['stored API key']);
  const authMode = auth['stored auth mode'] === 'chatgpt' && storedApiKey === false
    ? 'CHATGPT_ONLY' : 'UNKNOWN';
  return {
    authMode,
    storedApiKey,
    deniedReadRestrictions: boolFromDetail(sandbox['denied-read restrictions']),
    filesystemSandbox: sandbox['filesystem sandbox'] === 'restricted' ? 'RESTRICTED' : 'UNKNOWN',
    networkSandbox: sandbox['network sandbox'] === 'restricted' ? 'RESTRICTED' : 'UNKNOWN',
    sandboxBackend: sandbox['sandbox backend'] === 'enabled' ? 'ENABLED'
      : sandbox['sandbox backend'] === 'disabled' ? 'DISABLED' : 'UNKNOWN',
  };
}
function hasAll(text, fragments) {
  const value = String(text || '');
  return fragments.every((fragment) => value.includes(fragment));
}
export function successfulProbeText(result) {
  if (!result || result.error || result.status !== 0) return '';
  return String(result.stdout || result.stderr || '');
}

export function codexCliSupport(helpText) {
  return {
    isolatedConfig: hasAll(helpText, ['--ignore-user-config', '--ignore-rules', '--strict-config']),
    ephemeral: hasAll(helpText, ['--ephemeral']),
    readOnlySandbox: hasAll(helpText, ['--sandbox <SANDBOX_MODE>', 'read-only']),
    isolatedRoot: hasAll(helpText, ['--cd <DIR>']),
  };
}

export function claudeCliSupport(helpText) {
  return {
    safeMode: hasAll(helpText, ['--safe-mode']),
    toolsDisabled: hasAll(helpText, ['--tools <tools...>', 'Use "" to disable all']),
    strictMcp: hasAll(helpText, ['--strict-mcp-config']),
    noPersistence: hasAll(helpText, ['--no-session-persistence']),
    systemPrompt: hasAll(helpText, ['--system-prompt <prompt>']),
    disableSkills: hasAll(helpText, ['--disable-slash-commands']),
    noChrome: hasAll(helpText, ['--no-chrome']),
  };
}
function unavailableCapacity() {
  return { status: 'UNAVAILABLE' };
}

function baseAdapter(id, provider, capacity = unavailableCapacity()) {
  return {
    id,
    provider,
    executionEnvironment: 'prompt-cli',
    capabilities: [...READ_CAPABILITIES],
    capacity,
    evidence: {
      authentication: 'UNKNOWN',
      toolBoundary: 'UNKNOWN',
      dataBoundary: 'UNKNOWN',
      incrementalCostBoundary: 'UNKNOWN',
      fallbackBehavior: 'UNKNOWN',
    },
  };
}

function pushReason(target, condition, code) {
  if (condition) target.push(code);
}
export function buildReadiness({
  codex, claude, codexDoctor, codexSupport, claudeAuth, claudeSupport,
  gemini, antigravity, openAiApiKeyPresent,
  anthropicApiKeyPresent, anthropicAuthTokenPresent, claudeRunner,
}) {
  const codexAdapter = baseAdapter('codex-safe-prompt', 'openai', conservativeCodexCapacity(codex?.capacity));
  const claudeAdapter = baseAdapter('claude-safe-prompt', 'anthropic');
  const geminiAdapter = baseAdapter('gemini-safe-prompt', 'google');
  const antigravityAdapter = baseAdapter('antigravity-safe-prompt', 'google');

  const openAiCredentialEnvAbsent = openAiApiKeyPresent === false;
  const codexAuthOk = codexDoctor?.authMode === 'CHATGPT_ONLY' &&
    codexDoctor?.storedApiKey === false && openAiCredentialEnvAbsent;
  if (codexAuthOk) codexAdapter.evidence.authentication = 'VERIFIED';

  const anthropicCredentialEnvAbsent = anthropicApiKeyPresent === false && anthropicAuthTokenPresent === false;
  const claudeAuthOk = claudeAuth?.status === 'AUTHENTICATED' &&
    claudeAuth?.method === 'CLAUDE_AI' && Boolean(claudeAuth?.subscriptionType) &&
    anthropicCredentialEnvAbsent;
  if (claudeAuthOk) claudeAdapter.evidence.authentication = 'VERIFIED';

  const codexSupportOk = allFlagsTrue(codexSupport, CODEX_SUPPORT_KEYS);
  const claudeSupportOk = allFlagsTrue(claudeSupport, CLAUDE_SUPPORT_KEYS);
  const runnerEvidence = claudeRunner?.ready === true ? claudeRunner.evidence : null;
  const claudeRunnerClosed = runnerEvidence?.authentication === 'VERIFIED' &&
    runnerEvidence?.toolBoundary === 'NO_LOCAL_TOOLS_ENFORCED' &&
    runnerEvidence?.dataBoundary === 'EXPLICIT_SAFE_PAYLOAD_ONLY' &&
    runnerEvidence?.incrementalCostBoundary === 'INCLUDED_ONLY_ENFORCED' &&
    runnerEvidence?.fallbackBehavior === 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION';
  const claudeEvidenceReady = claudeAuthOk && claudeSupportOk && claudeRunnerClosed;
  if (claudeEvidenceReady) Object.assign(claudeAdapter.evidence, runnerEvidence);
  const adapters = [codexAdapter, claudeAdapter, geminiAdapter, antigravityAdapter];
  const qualification = qualifyAdapters({ schemaVersion: 1, adapters });
  const codexBlockers = [];
  pushReason(codexBlockers, !codexAuthOk, 'AUTH_NOT_CHATGPT_ONLY');
  pushReason(codexBlockers, openAiApiKeyPresent === true, 'API_KEY_ENV_PRESENT');
  pushReason(codexBlockers, openAiApiKeyPresent !== true && openAiApiKeyPresent !== false, 'API_KEY_ENV_STATE_UNAVAILABLE');
  pushReason(codexBlockers, !codexSupportOk, 'ISOLATION_FLAGS_INCOMPLETE');
  pushReason(codexBlockers, codexDoctor?.deniedReadRestrictions !== true, 'DENIED_READ_RESTRICTIONS_NOT_ENFORCED');
  pushReason(codexBlockers, true, 'LOCAL_TOOL_DISABLE_NOT_PROVEN');
  pushReason(codexBlockers, true, 'CREDIT_AUTOTOPUP_STATE_UNAVAILABLE');
  pushReason(codexBlockers, true, 'RUNNER_NOT_IMPLEMENTED');

  const claudeBlockers = [];
  pushReason(claudeBlockers, !claudeAuthOk, 'CLAUDE_PLAN_AUTH_NOT_VERIFIED');
  pushReason(claudeBlockers, anthropicApiKeyPresent === true || anthropicAuthTokenPresent === true, 'API_CREDENTIAL_ENV_PRESENT');
  pushReason(claudeBlockers, (anthropicApiKeyPresent !== true && anthropicApiKeyPresent !== false) ||
    (anthropicAuthTokenPresent !== true && anthropicAuthTokenPresent !== false), 'API_CREDENTIAL_ENV_STATE_UNAVAILABLE');
  pushReason(claudeBlockers, !claudeSupportOk, 'SAFE_MODE_FLAGS_INCOMPLETE');
  pushReason(claudeBlockers, !claudeRunnerClosed, 'SUBSCRIPTION_RUNNER_NOT_READY');

  const credits = codex?.capacity?.credits;
  return {
    schemaVersion: 1,
    qualificationInput: { schemaVersion: 1, adapters },
    qualification,
    readiness: {
      codex: {
        authState: codexAuthOk ? 'VERIFIED' : 'UNKNOWN',
        capacityState: codexAdapter.capacity.status,
        creditBalanceState: safeCreditBalanceState(credits),
        isolationFlagsSupported: codexSupportOk,
        deniedReadRestrictions: codexDoctor?.deniedReadRestrictions === true ? 'ENFORCED'
          : codexDoctor?.deniedReadRestrictions === false ? 'NOT_ENFORCED' : 'UNKNOWN',
        blockers: codexBlockers,
      },
      claude: {
        authState: claudeAuthOk ? 'VERIFIED' : 'UNKNOWN',
        safeModeFlagsSupported: claudeSupportOk,
        usageCreditState: claudeEvidenceReady ? 'INCLUDED_ONLY_ENFORCED' : 'UNKNOWN',
        runnerState: claudeEvidenceReady ? 'READY' : 'UNAVAILABLE',
        blockers: claudeBlockers,
      },
      gemini: {
        cliState: gemini?.cliStatus === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
        blockers: ['ADAPTER_NOT_IMPLEMENTED'],
      },
      antigravity: {
        cliState: antigravity?.cliStatus === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
        blockers: ['ADAPTER_NOT_IMPLEMENTED'],
      },
    },
    rule: 'Readiness records measured local evidence only; unsupported cost, tool, data, and fallback claims remain UNKNOWN.',
  };
}

function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let pretty = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pretty') pretty = true;
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed >= 1000) timeoutMs = parsed;
      i += 1;
    } else return { valid: false, timeoutMs, pretty };
  }
  return { valid: true, timeoutMs, pretty };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, result: 'STOP', code: 'ARGUMENT_INVALID' })}\n`);
    process.exitCode = 2;
    return;
  }
  const codexDesc = resolveProviderCommand('codex');
  const claudeDesc = resolveProviderCommand('claude');
  const codex = await observeCodex(args.timeoutMs);
  const claude = { cliStatus: claudeDesc ? 'AVAILABLE' : 'UNAVAILABLE', capacity: { status: 'UNAVAILABLE' } };
  const doctorRun = codexDesc ? run(codexDesc, ['doctor', '--json'], Math.min(args.timeoutMs, 8000)) : null;
  let doctorPayload = null;
  if (doctorRun && !doctorRun.error && doctorRun.status === 0) {
    try { doctorPayload = JSON.parse(doctorRun.stdout); } catch { /* fail closed */ }
  }
  const codexHelp = codexDesc ? run(codexDesc, ['exec', '--help'], 5000) : null;
  const claudeRunner = probeClaudeSubscriptionRunner({ desc: claudeDesc, envSource: process.env, timeoutMs: Math.min(args.timeoutMs, 5000) });
  const claudeAuth = claudeRunner.authState === 'VERIFIED'
    ? { status: 'AUTHENTICATED', method: 'CLAUDE_AI', subscriptionType: claudeRunner.subscriptionType }
    : { status: 'UNAVAILABLE', method: null, subscriptionType: null };
  const claudeSupport = claudeRunner.runnerSupported === true
    ? Object.fromEntries(CLAUDE_SUPPORT_KEYS.map((key) => [key, true])) : {};
  const gemini = observeGenericCli('gemini', args.timeoutMs);
  const antigravity = observeGenericCli('antigravity', args.timeoutMs);
  const readiness = buildReadiness({
    codex,
    claude,
    codexDoctor: sanitizeCodexDoctor(doctorPayload),
    codexSupport: codexCliSupport(successfulProbeText(codexHelp)),
    claudeAuth,
    claudeSupport,
    gemini,
    antigravity,
    openAiApiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    anthropicApiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
    anthropicAuthTokenPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    claudeRunner,
  });
  process.stdout.write(`${JSON.stringify(readiness, null, args.pretty ? 2 : 0)}\n`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, result: 'STOP', code: 'READINESS_INTERNAL_ERROR' })}\n`);
    process.exitCode = 2;
  });
}
