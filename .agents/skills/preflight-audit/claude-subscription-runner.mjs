#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveProviderCommand } from './ai-provider-inventory.mjs';

const SCHEMA_VERSION = 1;
const ROUTE_ID = 'claude-safe-prompt';
const ALLOWED_CAPABILITIES = new Set(['review', 'diagnosis', 'research', 'documentation', 'planning', 'audit']);
const ALLOWED_DATA_CLASSES = new Set(['source-only', 'synthetic', 'public']);
const ALLOWED_KEYS = new Set(['schemaVersion', 'taskId', 'capability', 'dataClass', 'prompt']);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const SAFE_SUBSCRIPTIONS = new Set(['pro']);
// Claude Code 2.1.236 binary verified on ai-dev by the dev.55 synthetic safe-route smoke.
// Any binary update fails closed until a new reviewed attestation is added.
const TRUSTED_CLAUDE_SHA256 = new Set(['647E736F20C9FF0553C754624CBF8A6DCAC196E8595509D8F63DCE8BBE818757']);
const UNSAFE_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'AWS_', 'GOOGLE_', 'GCLOUD_', 'VERTEX_', 'AZURE_'];

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}

function stop(code, taskId = null) {
  return { schemaVersion: SCHEMA_VERSION, result: 'STOP', code, routeId: ROUTE_ID, taskId };
}
export function validateClaudeTask(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['payload_not_object'];
  const errors = [];
  if (payload.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion_invalid');
  if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) errors.push('unknown_field');
  if (!safeToken(payload.taskId)) errors.push('taskId_invalid');
  if (!ALLOWED_CAPABILITIES.has(payload.capability)) errors.push('capability_invalid');
  if (!ALLOWED_DATA_CLASSES.has(payload.dataClass)) errors.push('dataClass_invalid');
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) errors.push('prompt_invalid');
  else if (Buffer.byteLength(payload.prompt, 'utf8') > MAX_INPUT_BYTES) errors.push('prompt_too_large');
  return errors;
}

function sanitizedChildEnv(source = process.env) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATH']) {
    if (typeof source[key] === 'string' && source[key]) env[key] = source[key];
  }
  env.CLAUDE_CODE_SAFE_MODE = '1';
  return env;
}

export function unsafeProviderEnvPresent(source = process.env) {
  return Object.entries(source).some(([key, value]) => {
    if (typeof value !== 'string' || value.trim() === '') return false;
    const upper = key.toUpperCase();
    return UNSAFE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
  });
}

function sha256FileSync(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex').toUpperCase();
}
function trustedClaudeBinary(desc) {
  if (!desc || typeof desc.file !== 'string') return false;
  try { return TRUSTED_CLAUDE_SHA256.has(sha256FileSync(desc.file)); } catch { return false; }
}
export function isNativeClaudeDescriptor(desc) {
  return Boolean(desc) && typeof desc.file === 'string' && Array.isArray(desc.prefix) && desc.prefix.length === 0;
}
function isolateTrustedClaudeBinary(desc, tempRoot) {
  if (!isNativeClaudeDescriptor(desc)) return null;
  const isolatedFile = path.join(tempRoot, process.platform === 'win32' ? 'claude-attested.exe' : 'claude-attested');
  try {
    fs.copyFileSync(desc.file, isolatedFile, fs.constants.COPYFILE_EXCL);
    const isolatedDesc = { file: isolatedFile, prefix: [...desc.prefix] };
    if (!trustedClaudeBinary(isolatedDesc)) { fs.rmSync(isolatedFile, { force: true }); return null; }
    try { fs.chmodSync(isolatedFile, 0o500); } catch { /* hash-bound isolated copy remains the trust anchor */ }
    return isolatedDesc;
  } catch { return null; }
}


function run(desc, args, options = {}) {
  return spawnSync(desc.file, [...desc.prefix, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES,
    ...options,
  });
}
function subscriptionAuth(desc, env, timeoutMs, cwd) {
  const authRun = run(desc, ['auth', 'status', '--json'], { env, cwd, timeout: Math.min(timeoutMs, 5000) });
  if (authRun.error || authRun.status !== 0) return null;
  try {
    const auth = JSON.parse(authRun.stdout);
    return {
      loggedIn: auth?.loggedIn === true,
      subscriptionType: typeof auth?.subscriptionType === 'string' ? auth.subscriptionType.toLowerCase() : null,
      authMethod: auth?.authMethod === 'claude.ai' ? 'claude.ai' : null,
    };
  } catch {
    return null;
  }
}

export function claudeRunnerEvidence({ auth, credentialEnvAbsent, runnerSupported = false } = {}) {
  const authOk = auth?.loggedIn === true && SAFE_SUBSCRIPTIONS.has(auth?.subscriptionType) && auth?.authMethod === 'claude.ai';
  const closed = authOk && credentialEnvAbsent === true && runnerSupported === true;
  return {
    authentication: authOk ? 'VERIFIED' : 'UNKNOWN',
    toolBoundary: closed ? 'NO_LOCAL_TOOLS_ENFORCED' : 'UNKNOWN',
    dataBoundary: closed ? 'EXPLICIT_SAFE_PAYLOAD_ONLY' : 'UNKNOWN',
    incrementalCostBoundary: closed ? 'INCLUDED_ONLY_ENFORCED' : 'UNKNOWN',
    fallbackBehavior: closed ? 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION' : 'UNKNOWN',
  };
}

export function probeClaudeSubscriptionRunner({
  desc = resolveProviderCommand('claude'), envSource = process.env, timeoutMs = 5000,
} = {}) {
  if (!desc) return { ready: false, authState: 'UNKNOWN', runnerSupported: false, credentialEnvAbsent: null, evidence: claudeRunnerEvidence(), blockers: ['CLAUDE_CLI_UNAVAILABLE'] };
  const credentialEnvAbsent = !unsafeProviderEnvPresent(envSource);
  if (!credentialEnvAbsent) return { ready: false, authState: 'UNKNOWN', runnerSupported: false, credentialEnvAbsent: false, evidence: claudeRunnerEvidence({ credentialEnvAbsent: false }), blockers: ['UNSAFE_PROVIDER_ENV_PRESENT'] };
  const env = sanitizedChildEnv(envSource);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-claude-probe-'));
  try {
    const isolatedDesc = isolateTrustedClaudeBinary(desc, tempRoot);
    const supported = Boolean(isolatedDesc) && runnerSupport(isolatedDesc, env, tempRoot);
    const auth = supported ? subscriptionAuth(isolatedDesc, env, timeoutMs, tempRoot) : null;
    const evidence = claudeRunnerEvidence({ auth, credentialEnvAbsent: true, runnerSupported: supported });
    const ready = Object.values(evidence).every((value) => !['UNKNOWN', 'FAILED', 'UNSAFE', 'EXTRA_COST_POSSIBLE'].includes(value));
    const blockers = [];
    if (!supported) blockers.push('RUNNER_BINARY_OR_FLAGS_UNTRUSTED');
    if (supported && evidence.authentication !== 'VERIFIED') blockers.push('SUBSCRIPTION_AUTH_NOT_VERIFIED');
    return { ready, authState: evidence.authentication, subscriptionType: SAFE_SUBSCRIPTIONS.has(auth?.subscriptionType) ? auth.subscriptionType : null, runnerSupported: supported, credentialEnvAbsent: true, evidence, blockers };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function claudeArgs(emptyMcpConfig) {
  return [
    '--print', '--input-format', 'text', '--output-format', 'json',
    '--safe-mode', '--setting-sources', '', '--settings', '{}',
    '--tools', '', '--strict-mcp-config', '--mcp-config', emptyMcpConfig,
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--permission-mode', 'plan', '--model', 'sonnet',
    '--system-prompt', 'Use only the supplied prompt. Do not use tools, files, network access, plugins, skills, MCP, or external context. Return only the requested analysis.',
  ];
}
function runnerSupport(desc, env, cwd) {
  if (!trustedClaudeBinary(desc)) return false;
  const help = run(desc, ['--help'], { env, cwd, timeout: 5000 });
  if (help.error || help.status !== 0) return false;
  const text = `${help.stdout || ''}\n${help.stderr || ''}`;
  const requiredHelp = [
    '-p, --print', '--input-format <format>', '--output-format <format>',
    '--safe-mode', '--setting-sources <sources>', '--settings <file-or-json>',
    '--tools <tools...>', 'Use "" to disable all', '--strict-mcp-config', '--mcp-config <configs...>',
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--permission-mode <mode>', '--model <model>', '--system-prompt <prompt>',
    'CLAUDE.md', 'skills', 'plugins', 'hooks', 'MCP servers', 'disabled',
  ];
  return requiredHelp.every((token) => text.includes(token));
}

export function runClaudeSubscriptionTask(payload, {
  desc = resolveProviderCommand('claude'),
  envSource = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const taskId = safeToken(payload?.taskId) ? payload.taskId : null;
  const errors = validateClaudeTask(payload);
  if (errors.length > 0) return stop('TASK_SCHEMA_INVALID', taskId);
  if (!desc) return stop('CLAUDE_CLI_UNAVAILABLE', taskId);
  if (unsafeProviderEnvPresent(envSource)) return stop('UNSAFE_PROVIDER_ENV_PRESENT', taskId);
  const env = sanitizedChildEnv(envSource);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-claude-runner-'));
  try {
    const isolatedDesc = isolateTrustedClaudeBinary(desc, tempRoot);
    if (!isolatedDesc || !runnerSupport(isolatedDesc, env, tempRoot)) return stop('RUNNER_BINARY_OR_FLAGS_UNTRUSTED', taskId);
    const auth = subscriptionAuth(isolatedDesc, env, timeoutMs, tempRoot);
    if (!auth?.loggedIn || !SAFE_SUBSCRIPTIONS.has(auth.subscriptionType) || auth.authMethod !== 'claude.ai') {
      return stop('SUBSCRIPTION_AUTH_NOT_VERIFIED', taskId);
    }
    const result = run(isolatedDesc, claudeArgs('{"mcpServers":{}}'), {
      cwd: tempRoot, env, input: payload.prompt, timeout: timeoutMs,
    });
    if (result.error?.code === 'ETIMEDOUT') return stop('PROVIDER_TIMEOUT', taskId);
    if (result.error?.code === 'ENOBUFS') return stop('PROVIDER_OUTPUT_TOO_LARGE', taskId);
    if (result.error || result.status !== 0) return stop('PROVIDER_STOPPED', taskId);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return stop('PROVIDER_OUTPUT_INVALID', taskId); }
    if (parsed?.type !== 'result' || parsed?.subtype !== 'success' || parsed?.is_error !== false || typeof parsed?.result !== 'string') return stop('PROVIDER_OUTPUT_INVALID', taskId);
    if (Buffer.byteLength(parsed.result, 'utf8') > MAX_OUTPUT_BYTES) return stop('PROVIDER_OUTPUT_TOO_LARGE', taskId);
    return {
      schemaVersion: SCHEMA_VERSION,
      result: 'COMPLETED',
      routeId: ROUTE_ID,
      taskId,
      capability: payload.capability,
      dataClass: payload.dataClass,
      output: parsed.result,
      evidence: claudeRunnerEvidence({ auth, credentialEnvAbsent: true, runnerSupported: true }),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function readBoundedTaskInput(stream = process.stdin, { maxBytes = MAX_INPUT_BYTES * 2, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false; let bytes = 0; const chunks = [];
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.removeListener('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const fail = (code) => { const error = new Error(code); error.code = code; try { stream.pause(); } catch {} finish(error); };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); bytes += buffer.length;
      if (bytes > maxBytes) { fail('INPUT_TOO_LARGE'); return; }
      chunks.push(buffer);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const onError = () => fail('INPUT_STREAM_ERROR');
    const timer = setTimeout(() => fail('INPUT_TIMEOUT'), timeoutMs);
    stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError);
  });
}

function parseArgs(argv) {
  let pretty = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pretty') pretty = true;
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 120000) return { valid: false };
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
    const result = runClaudeSubscriptionTask(payload, { timeoutMs: args.timeoutMs });
    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    if (result.result !== 'COMPLETED') process.exitCode = 1;
  } catch (error) {
    const code = ['INPUT_TOO_LARGE','INPUT_TIMEOUT','INPUT_STREAM_ERROR'].includes(error?.code) ? error.code : 'INPUT_READ_OR_PARSE_FAILED';
    process.stdout.write(`${JSON.stringify(stop(code))}\n`); process.exitCode = 2;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(() => { process.stdout.write(`${JSON.stringify(stop('RUNNER_INTERNAL_ERROR'))}\n`); process.exitCode = 2; });
