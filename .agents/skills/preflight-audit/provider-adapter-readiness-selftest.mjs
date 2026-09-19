#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const readinessArg = process.argv[2];
if (!readinessArg) throw new Error('readiness path required');
const readinessPath = resolve(readinessArg);
const readinessUrl = pathToFileURL(readinessPath).href;
const {
  sanitizeCodexDoctor,
  codexCliSupport,
  claudeCliSupport,
  successfulProbeText,
  buildReadiness,
} = await import(readinessUrl);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function capacity(credits = { status: 'AVAILABLE', hasCredits: false, balanceState: 'NONE' }) {
  return {
    status: 'AVAILABLE', primary: { remainingPercent: 80 },
    secondary: { remainingPercent: 60 }, credits,
  };
}
function doctor(overrides = {}) {
  return {
    authMode: 'CHATGPT_ONLY',
    storedApiKey: false,
    deniedReadRestrictions: false,
    filesystemSandbox: 'RESTRICTED',
    networkSandbox: 'RESTRICTED',
    sandboxBackend: 'DISABLED',
    ...overrides,
  };
}

const codexHelp = [
  '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral',
  '--sandbox <SANDBOX_MODE>', 'read-only', '--cd <DIR>',
].join('\n');
const claudeHelp = [
  '--safe-mode', '--tools <tools...>', 'Use "" to disable all tools',
  '--strict-mcp-config', '--no-session-persistence', '--system-prompt <prompt>',
  '--disable-slash-commands', '--no-chrome',
].join('\n');
{
  const raw = {
    checks: {
      'auth.credentials': { details: { 'stored API key': 'false', 'stored auth mode': 'chatgpt', secret: 'DO_NOT_EMIT' } },
      'sandbox.helpers': { details: {
        'denied-read restrictions': 'true', 'filesystem sandbox': 'restricted',
        'network sandbox': 'restricted', 'sandbox backend': 'enabled', privatePath: 'DO_NOT_EMIT_TOO',
      } },
    },
    secretRoot: 'SECRET_ROOT',
  };
  const safe = sanitizeCodexDoctor(raw);
  assert(safe.authMode === 'CHATGPT_ONLY' && safe.storedApiKey === false, 'codex auth should sanitize');
  assert(safe.deniedReadRestrictions === true && safe.sandboxBackend === 'ENABLED', 'sandbox state should sanitize');
  const text = JSON.stringify(safe);
  assert(!text.includes('DO_NOT_EMIT') && !text.includes('SECRET_ROOT'), 'doctor secrets must not leak');
}

{
  const support = codexCliSupport(codexHelp);
  assert(Object.keys(support).sort().join(',') === ['ephemeral','isolatedConfig','isolatedRoot','readOnlySandbox'].join(','), 'Codex support keys must be complete');
  assert(Object.values(support).every(Boolean), 'codex isolation flags should be detected');
  assert(!Object.values(codexCliSupport('--ignore-user-config')).every(Boolean), 'partial codex help must fail closed');
  const cSupport = claudeCliSupport(claudeHelp);
  assert(Object.keys(cSupport).sort().join(',') === ['disableSkills','noChrome','noPersistence','safeMode','strictMcp','systemPrompt','toolsDisabled'].join(','), 'Claude support keys must be complete');
  assert(Object.values(cSupport).every(Boolean), 'claude safe-mode flags should be detected');
  assert(!Object.values(claudeCliSupport('--safe-mode')).every(Boolean), 'partial claude help must fail closed');
  assert(successfulProbeText({ status: 0, stdout: codexHelp }) === codexHelp, 'successful help probe should be accepted');
  assert(successfulProbeText({ status: 1, stdout: codexHelp }) === '', 'failed help probe must be ignored');
  assert(successfulProbeText({ status: 0, error: new Error('probe failed'), stdout: codexHelp }) === '', 'errored help probe must be ignored');
}
function closedRunner(overrides = {}) {
  return {
    ready: true, authState: 'VERIFIED', runnerSupported: true, credentialEnvAbsent: true,
    evidence: { authentication: 'VERIFIED', toolBoundary: 'NO_LOCAL_TOOLS_ENFORCED', dataBoundary: 'EXPLICIT_SAFE_PAYLOAD_ONLY', incrementalCostBoundary: 'INCLUDED_ONLY_ENFORCED', fallbackBehavior: 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION' },
    blockers: [], ...overrides,
  };
}
function built(overrides = {}) {
  return buildReadiness({
    codex: { cliStatus: 'AVAILABLE', capacity: capacity() },
    claude: { cliStatus: 'AVAILABLE', capacity: { status: 'UNAVAILABLE' } },
    codexDoctor: doctor(),
    codexSupport: codexCliSupport(codexHelp),
    claudeAuth: { status: 'AUTHENTICATED', method: 'CLAUDE_AI', subscriptionType: 'pro' },
    claudeSupport: claudeCliSupport(claudeHelp),
    gemini: { cliStatus: 'UNAVAILABLE' },
    antigravity: { cliStatus: 'UNAVAILABLE' },
    openAiApiKeyPresent: false,
    anthropicApiKeyPresent: false,
    anthropicAuthTokenPresent: false,
    ...overrides,
  });
}

for (const fragment of ['--ignore-user-config','--ignore-rules','--strict-config','--ephemeral','--sandbox <SANDBOX_MODE>','read-only','--cd <DIR>']) {
  const broken = codexCliSupport(codexHelp.replace(fragment, 'REMOVED'));
  const result = built({ codexSupport: broken });
  assert(result.readiness.codex.isolationFlagsSupported === false, `missing Codex flag must fail: ${fragment}`);
  assert(result.readiness.codex.blockers.includes('ISOLATION_FLAGS_INCOMPLETE'), `Codex blocker expected: ${fragment}`);
  assert(result.qualification.qualifiedRoutes.length === 0, `missing Codex flag must not promote: ${fragment}`);
}
for (const fragment of ['--safe-mode','--tools <tools...>','Use "" to disable all tools','--strict-mcp-config','--no-session-persistence','--system-prompt <prompt>','--disable-slash-commands','--no-chrome']) {
  const broken = claudeCliSupport(claudeHelp.replace(fragment, 'REMOVED'));
  const result = built({ claudeSupport: broken, claudeRunner: closedRunner() });
  assert(result.readiness.claude.safeModeFlagsSupported === false, `missing Claude flag must fail: ${fragment}`);
  assert(result.readiness.claude.blockers.includes('SAFE_MODE_FLAGS_INCOMPLETE'), `Claude blocker expected: ${fragment}`);
  assert(result.qualification.qualifiedRoutes.length === 0, `missing Claude flag must not promote: ${fragment}`);
  assert(result.readiness.claude.runnerState === 'UNAVAILABLE' && result.readiness.claude.usageCreditState === 'UNKNOWN', `missing Claude support must not claim readiness: ${fragment}`);
}

{
  const result = built();
  assert(result.qualification.result === 'NO_QUALIFIED_ADAPTER', 'current evidence must stay unqualified');
  assert(result.qualification.qualifiedRoutes.length === 0, 'readiness must not auto-promote');
  assert(result.readiness.codex.authState === 'VERIFIED', 'codex auth should be verified');
  assert(result.readiness.codex.creditBalanceState === 'NONE', 'zero extra-credit state should be visible without amount');
  assert(result.readiness.codex.blockers.includes('CREDIT_AUTOTOPUP_STATE_UNAVAILABLE'), 'codex auto-topup unknown must block');
  assert(result.readiness.claude.authState === 'VERIFIED', 'claude plan auth should be verified');
  assert(result.readiness.claude.safeModeFlagsSupported === true, 'claude safe flags should be observed');
  assert(result.readiness.claude.blockers.includes('SUBSCRIPTION_RUNNER_NOT_READY'), 'missing Claude runner evidence must block');
}
{
  const result = built({ claudeRunner: closedRunner() });
  assert(result.qualification.result === 'QUALIFIED', 'closed Claude runner evidence must qualify');
  assert(result.qualification.qualifiedRoutes.length === 1 && result.qualification.qualifiedRoutes[0].id === 'claude-safe-prompt', 'only Claude route should qualify');
  assert(result.readiness.claude.runnerState === 'READY', 'Claude runner should be ready');
  assert(result.readiness.claude.usageCreditState === 'INCLUDED_ONLY_ENFORCED', 'Claude cost boundary should be included-only');
}
{
  const badCost = closedRunner({ evidence: { ...closedRunner().evidence, incrementalCostBoundary: 'UNKNOWN' } });
  const result = built({ claudeRunner: badCost });
  assert(result.qualification.qualifiedRoutes.length === 0 && result.readiness.claude.runnerState === 'UNAVAILABLE', 'unknown runner cost must fail closed');
}
{
  const unknownEnv = built({
    openAiApiKeyPresent: undefined, anthropicApiKeyPresent: undefined, anthropicAuthTokenPresent: undefined,
  });
  assert(unknownEnv.readiness.codex.authState === 'UNKNOWN', 'missing OpenAI credential env evidence must not verify auth');
  assert(unknownEnv.readiness.codex.blockers.includes('API_KEY_ENV_STATE_UNAVAILABLE'), 'missing OpenAI env evidence blocker expected');
  assert(unknownEnv.readiness.claude.authState === 'UNKNOWN', 'missing Anthropic credential env evidence must not verify auth');
  assert(unknownEnv.readiness.claude.blockers.includes('API_CREDENTIAL_ENV_STATE_UNAVAILABLE'), 'missing Anthropic env evidence blocker expected');
  assert(unknownEnv.qualification.qualifiedRoutes.length === 0, 'missing credential env evidence must not promote');
}
{
  const openAiKey = built({ openAiApiKeyPresent: true });
  assert(openAiKey.readiness.codex.authState === 'UNKNOWN', 'OpenAI API key env must invalidate ChatGPT-only evidence');
  assert(openAiKey.qualification.qualifiedRoutes.length === 0, 'OpenAI API key evidence must not promote');
  const anthropicKey = built({ anthropicApiKeyPresent: true, claudeRunner: closedRunner() });
  assert(anthropicKey.readiness.claude.authState === 'UNKNOWN', 'Anthropic API key env must invalidate plan-only evidence');
  assert(anthropicKey.qualification.qualifiedRoutes.length === 0, 'Anthropic API key evidence must not promote');
  const anthropicToken = built({ anthropicAuthTokenPresent: true, claudeRunner: closedRunner() });
  assert(anthropicToken.readiness.claude.authState === 'UNKNOWN', 'Anthropic auth token env must invalidate plan-only evidence');
  assert(anthropicToken.qualification.qualifiedRoutes.length === 0, 'Anthropic token evidence must not promote');
}

{
  const result = built({
    codex: { cliStatus: 'AVAILABLE', capacity: capacity({
      status: 'AVAILABLE', hasCredits: true, balanceState: 'POSITIVE', rawBalance: 'SECRET_BALANCE',
    }) },
  });
  const text = JSON.stringify(result);
  assert(result.readiness.codex.creditBalanceState === 'POSITIVE', 'positive credit state should be surfaced');
  assert(!text.includes('SECRET_BALANCE') && !text.includes('rawBalance'), 'raw credit data must not leak');
}
{
  const maliciousCredit = built({
    codex: { cliStatus: 'AVAILABLE', capacity: capacity({
      status: 'AVAILABLE', hasCredits: true, balanceState: 'SECRET_BALANCE_STATE', secret: 'DO_NOT_EMIT_CREDIT',
    }) },
  });
  const text = JSON.stringify(maliciousCredit);
  assert(maliciousCredit.readiness.codex.creditBalanceState === 'UNKNOWN', 'unknown credit state must fail closed');
  assert(!text.includes('SECRET_BALANCE_STATE') && !text.includes('DO_NOT_EMIT_CREDIT'), 'unknown credit state must not leak');
}
{
  const emptySupport = built({ codexSupport: {}, claudeSupport: {} });
  assert(emptySupport.readiness.codex.isolationFlagsSupported === false, 'empty Codex support must fail closed');
  assert(emptySupport.readiness.codex.blockers.includes('ISOLATION_FLAGS_INCOMPLETE'), 'empty Codex support blocker expected');
  assert(emptySupport.readiness.claude.safeModeFlagsSupported === false, 'empty Claude support must fail closed');
  assert(emptySupport.readiness.claude.blockers.includes('SAFE_MODE_FLAGS_INCOMPLETE'), 'empty Claude support blocker expected');
  assert(emptySupport.qualification.qualifiedRoutes.length === 0, 'empty support evidence must not promote');
}

{
  const malformed = sanitizeCodexDoctor({
    checks: {
      'auth.credentials': { details: { 'stored API key': 'SECRET', 'stored auth mode': 'private-mode' } },
      'sandbox.helpers': { details: { 'denied-read restrictions': 'SECRET' } },
    },
    secret: 'DO_NOT_EMIT_MALFORMED',
  });
  assert(malformed.authMode === 'UNKNOWN' && malformed.storedApiKey === null, 'malformed doctor auth must fail closed');
  assert(malformed.deniedReadRestrictions === null, 'malformed denied-read evidence must fail closed');
  assert(!JSON.stringify(malformed).includes('DO_NOT_EMIT'), 'malformed raw doctor input must not leak');
  const malformedResult = built({ codexDoctor: malformed });
  assert(malformedResult.qualification.qualifiedRoutes.length === 0, 'malformed doctor evidence must not promote');
}

{
  const noCapacity = built({ codex: { cliStatus: 'AVAILABLE', capacity: { status: 'UNAVAILABLE' } } });
  assert(noCapacity.qualification.qualifiedRoutes.length === 0, 'unavailable capacity must not create a qualified route under current evidence');
  const noClaudeAuth = built({ claudeAuth: { status: 'UNAVAILABLE', method: null, subscriptionType: null }, claudeRunner: closedRunner() });
  assert(noClaudeAuth.qualification.qualifiedRoutes.length === 0, 'missing Claude auth must not promote');
  assert(noClaudeAuth.readiness.claude.runnerState === 'UNAVAILABLE' && noClaudeAuth.readiness.claude.usageCreditState === 'UNKNOWN', 'missing Claude auth must not claim readiness');
}

{
  const result = built();
  assert(result.qualification.result !== 'STOP', 'readiness output must satisfy qualification schema');
  assert(result.readiness.gemini.blockers.includes('ADAPTER_NOT_IMPLEMENTED'), 'Gemini must stay blocked');
  assert(result.readiness.antigravity.blockers.includes('ADAPTER_NOT_IMPLEMENTED'), 'Antigravity must stay blocked');
}
{
  const source = fs.readFileSync(readinessPath, 'utf8');
  const forbidden = [
    "['-p'", 'quota-auto-resume', '/usage-credits', 'setup_overage_billing',
    'account/rateLimitResetCredit/consume', 'account/sendAddCreditsNudgeEmail',
    'merge_pull_request', 'production', 'dangerously-bypass',
  ];
  for (const token of forbidden) {
    assert(!source.includes(token), `readiness probe must not contain active billing/task escalation token: ${token}`);
  }
  assert(source.includes("['doctor', '--json']"), 'Codex doctor observation expected');
  assert(source.includes("['exec', '--help']"), 'Codex help observation expected');
  assert(source.includes('probeClaudeSubscriptionRunner'), 'Claude runner probe must own Claude auth/capability observation');
  assert(!source.includes("['exec', '--json']") && !source.includes("['-p',"), 'readiness must not invoke a model task');
  const mainSource = source.slice(source.indexOf('async function main()'));
  assert(!mainSource.includes('observeBillingAuth('), 'readiness must not invoke Claude auth outside the fail-closed runner probe');
  assert(!mainSource.includes("claudeDesc, ['--help']"), 'readiness must not invoke Claude help outside the fail-closed runner probe');
  assert(mainSource.includes('const claudeRunner = probeClaudeSubscriptionRunner'), 'Claude runner probe must execute before readiness promotion');
}

console.log('provider-adapter-readiness selftest: PASS');
