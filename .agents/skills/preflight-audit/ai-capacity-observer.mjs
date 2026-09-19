#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 12000;
const SAFE_SUBSCRIPTIONS = new Set(['free', 'pro', 'max', 'team', 'enterprise']);

function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let pretty = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pretty') pretty = true;
    if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed >= 1000) timeoutMs = parsed;
      i += 1;
    }
  }
  return { timeoutMs, pretty };
}

function fileExists(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}
export function descriptorForResolvedPath(candidate) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
    return { file: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/c', 'call', candidate] };
  }
  return { file: candidate, prefix: [] };
}

function lookupOnPath(command) {
  const lookup = process.platform === 'win32' ? ['where.exe', [command]] : ['which', [command]];
  const result = spawnSync(lookup[0], lookup[1], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  if (result.status !== 0) return null;
  const candidate = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return candidate ? descriptorForResolvedPath(candidate) : null;
}

function commandDescriptor(kind) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (kind === 'codex') {
    const npmEntry = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fileExists(npmEntry)) return { file: process.execPath, prefix: [npmEntry] };
    return lookupOnPath('codex') || { file: 'codex', prefix: [] };
  }
  const native = process.platform === 'win32' ? path.join(home, '.local', 'bin', 'claude.exe') : path.join(home, '.local', 'bin', 'claude');
  if (fileExists(native)) return { file: native, prefix: [] };
  return lookupOnPath('claude') || { file: 'claude', prefix: [] };
}

function runSync(desc, args, timeoutMs) {
  return spawnSync(desc.file, [...desc.prefix, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 128 * 1024,
  });
}

function versionFrom(text) {
  const match = String(text || '').match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : null;
}
function safeCreditsSnapshot(credits) {
  if (!credits || typeof credits !== 'object' || Array.isArray(credits)) return { status: 'UNAVAILABLE' };
  const hasCredits = credits.hasCredits ?? credits.has_credits;
  if (typeof hasCredits !== 'boolean') return { status: 'UNAVAILABLE' };
  if (hasCredits === false) return { status: 'AVAILABLE', hasCredits: false, balanceState: 'NONE' };
  if (credits.unlimited === true) return { status: 'AVAILABLE', hasCredits: true, balanceState: 'UNLIMITED' };
  const rawBalance = credits.balance;
  const balance = typeof rawBalance === 'number' ? rawBalance
    : (typeof rawBalance === 'string' && /^\d+(?:\.\d+)?$/.test(rawBalance.trim()) ? Number(rawBalance) : NaN);
  if (!Number.isFinite(balance) || balance < 0) return { status: 'AVAILABLE', hasCredits: true, balanceState: 'UNKNOWN' };
  return { status: 'AVAILABLE', hasCredits: true, balanceState: balance === 0 ? 'ZERO' : 'POSITIVE' };
}

function safeNonnegativeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeWindow(window) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null;
  const usedRaw = safeNonnegativeNumber(window.usedPercent);
  if (usedRaw === null) return null;
  const used = Math.min(100, Math.max(0, Math.round(usedRaw)));
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    windowDurationMins: safeNonnegativeNumber(window.windowDurationMins),
    resetsAt: safeNonnegativeNumber(window.resetsAt),
  };
}

export function sanitizeCodexRateLimits(payload) {
  const rateLimits = payload?.result?.rateLimits ?? payload?.rateLimits ?? null;
  if (!rateLimits) return { status: 'UNAVAILABLE', reason: 'rate_limit_snapshot_missing' };
  const primary = safeWindow(rateLimits.primary);
  const secondary = safeWindow(rateLimits.secondary);
  if (!primary && !secondary) return { status: 'UNAVAILABLE', reason: 'rate_limit_windows_missing' };
  return {
    status: 'AVAILABLE',
    source: 'codex_app_server_account_rateLimits_read',
    primary,
    secondary,
    credits: safeCreditsSnapshot(rateLimits.credits),
  };
}

export function sanitizeClaudeAuthStatus(payload) {
  const loggedIn = payload?.loggedIn === true;
  const rawType = typeof payload?.subscriptionType === 'string' ? payload.subscriptionType.toLowerCase() : null;
  return {
    status: loggedIn ? 'AUTHENTICATED' : 'UNAVAILABLE',
    subscriptionType: rawType && SAFE_SUBSCRIPTIONS.has(rawType) ? rawType : null,
  };
}
function terminateChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 3000,
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  const escalation = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 500);
  escalation.unref();
}

const MAX_CODEX_STDIO_BUFFER_BYTES = 256 * 1024;

export async function observeCodex(timeoutMs, desc = commandDescriptor('codex')) {
  const versionRun = runSync(desc, ['--version'], Math.min(timeoutMs, 4000));
  if (versionRun.error || versionRun.status !== 0) {
    return { cliStatus: 'UNAVAILABLE', version: null, capacity: { status: 'UNAVAILABLE', reason: 'codex_cli_unavailable' } };
  }
  const version = versionFrom(versionRun.stdout || versionRun.stderr);
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const child = spawn(desc.file, [...desc.prefix, 'app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const finish = (capacity) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateChild(child);
      resolve({ cliStatus: 'AVAILABLE', version, capacity });
    };
    const timer = setTimeout(() => finish({ status: 'UNAVAILABLE', reason: 'codex_rate_limit_timeout' }), timeoutMs);
    child.on('error', () => finish({ status: 'UNAVAILABLE', reason: 'codex_app_server_start_failed' }));
    child.stdin.on('error', () => finish({ status: 'UNAVAILABLE', reason: 'codex_app_server_stdin_failed' }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      if (Buffer.byteLength(buffer, 'utf8') + Buffer.byteLength(chunk, 'utf8') > MAX_CODEX_STDIO_BUFFER_BYTES) {
        finish({ status: 'UNAVAILABLE', reason: 'codex_rate_limit_output_too_large' });
        return;
      }
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 1 && message?.result) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read' })}\n`);
        } else if (message?.id === 2) {
          finish(sanitizeCodexRateLimits(message));
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'ai-dev-foundation-observer', version: '1' } },
    })}\n`);
  });
}
export function observeClaude(timeoutMs, desc = commandDescriptor('claude')) {
  const versionRun = runSync(desc, ['--version'], Math.min(timeoutMs, 4000));
  if (versionRun.error || versionRun.status !== 0) {
    return {
      cliStatus: 'UNAVAILABLE', version: null,
      auth: { status: 'UNAVAILABLE', subscriptionType: null },
      capacity: { status: 'UNAVAILABLE', reason: 'claude_cli_unavailable' },
    };
  }
  const version = versionFrom(versionRun.stdout || versionRun.stderr);
  const authRun = runSync(desc, ['auth', 'status', '--json'], Math.min(timeoutMs, 5000));
  let auth = { status: 'UNAVAILABLE', subscriptionType: null };
  if (!authRun.error && authRun.status === 0) {
    try { auth = sanitizeClaudeAuthStatus(JSON.parse(authRun.stdout)); } catch { /* fail closed */ }
  }
  return {
    cliStatus: 'AVAILABLE', version, auth,
    capacity: { status: 'UNAVAILABLE', reason: 'no_supported_noninteractive_capacity_signal' },
  };
}

export function buildSummary({ codex, claude, generatedAt = new Date().toISOString() }) {
  const availableCount = [codex?.capacity?.status, claude?.capacity?.status]
    .filter((status) => status === 'AVAILABLE').length;
  return {
    schemaVersion: 1,
    generatedAt,
    providers: { codex, claude },
    capacityComparison: availableCount === 2 ? 'COMPARABLE' : availableCount === 1 ? 'PARTIAL' : 'UNAVAILABLE',
    rule: 'Do not infer unavailable remaining capacity.',
  };
}
async function main() {
  const { timeoutMs, pretty } = parseArgs(process.argv.slice(2));
  const [codex, claude] = await Promise.all([
    observeCodex(timeoutMs),
    Promise.resolve(observeClaude(timeoutMs)),
  ]);
  const summary = buildSummary({ codex, claude });
  process.stdout.write(`${JSON.stringify(summary, null, pretty ? 2 : 0)}\n`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    const fallback = buildSummary({
      codex: { cliStatus: 'UNAVAILABLE', version: null, capacity: { status: 'UNAVAILABLE', reason: 'observer_internal_error' } },
      claude: {
        cliStatus: 'UNAVAILABLE', version: null,
        auth: { status: 'UNAVAILABLE', subscriptionType: null },
        capacity: { status: 'UNAVAILABLE', reason: 'observer_internal_error' },
      },
    });
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    process.exitCode = 2;
  });
}
