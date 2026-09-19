#!/usr/bin/env node
import process from 'node:process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const observerArg = process.argv[2];
if (!observerArg) throw new Error('observer path required');
const observerUrl = pathToFileURL(resolve(observerArg)).href;
const {
  sanitizeCodexRateLimits, sanitizeClaudeAuthStatus, buildSummary,
  observeCodex, observeClaude, descriptorForResolvedPath,
} = await import(observerUrl);

const codexRaw = {
  result: {
    rateLimits: {
      primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 111 },
      secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 222 },
      credits: { balance: '987.65', hasCredits: true, creditId: 'SECRET_CREDIT_ID_IN_SNAPSHOT' },
      planType: 'plus',
    },
    accountId: 'SECRET_ACCOUNT_ID',
    rateLimitResetCredits: { credits: [{ id: 'SECRET_CREDIT_ID' }] },
  },
};
const codex = sanitizeCodexRateLimits(codexRaw);
if (codex.status !== 'AVAILABLE') throw new Error(JSON.stringify(codex));
if (codex.primary.remainingPercent !== 93 || codex.secondary.remainingPercent !== 50) {
  throw new Error('remaining percent calculation failed');
}
const claudeRaw = {
  loggedIn: true,
  authMethod: 'claude.ai',
  subscriptionType: 'pro',
  email: 'secret@example.invalid',
  orgId: 'SECRET_ORG_ID',
  orgName: 'SECRET_ORG_NAME',
};
const claudeAuth = sanitizeClaudeAuthStatus(claudeRaw);
if (claudeAuth.status !== 'AUTHENTICATED' || claudeAuth.subscriptionType !== 'pro') {
  throw new Error(JSON.stringify(claudeAuth));
}

const summary = buildSummary({
  codex: { cliStatus: 'AVAILABLE', version: '0.0.0', capacity: codex },
  claude: {
    cliStatus: 'AVAILABLE', version: '0.0.0', auth: claudeAuth,
    capacity: { status: 'UNAVAILABLE', reason: 'no_supported_noninteractive_capacity_signal' },
  },
  generatedAt: '2026-09-07T00:00:00.000Z',
});
const text = JSON.stringify(summary);
for (const forbidden of ['SECRET_ACCOUNT_ID', '987.65', 'SECRET_CREDIT_ID_IN_SNAPSHOT', 'SECRET_CREDIT_ID', 'secret@example.invalid', 'SECRET_ORG_ID', 'SECRET_ORG_NAME']) {
  if (text.includes(forbidden)) throw new Error(`sensitive fixture leaked: ${forbidden}`);
}
if (summary.capacityComparison !== 'PARTIAL') throw new Error(JSON.stringify(summary));
const unknownClaude = sanitizeClaudeAuthStatus({ loggedIn: true, subscriptionType: 'unexpected-private-label', email: 'hidden@example.invalid' });
if (unknownClaude.subscriptionType !== null) throw new Error('unknown subscription label must not be echoed');

const ambiguousCredits = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: true, balance: null } } } });
if (ambiguousCredits.credits.balanceState !== 'UNKNOWN') throw new Error('null balance must not become zero');
const blankCredits = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: true, balance: '' } } } });
if (blankCredits.credits.balanceState !== 'UNKNOWN') throw new Error('blank balance must not become zero');
const zeroCredits = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: true, balance: '0' } } } });
if (zeroCredits.credits.balanceState !== 'ZERO') throw new Error('zero balance state expected');
const unlimitedCredits = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: true, unlimited: true, balance: 'SECRET_BALANCE' } } } });
if (unlimitedCredits.credits.balanceState !== 'UNLIMITED' || JSON.stringify(unlimitedCredits).includes('SECRET_BALANCE')) throw new Error('unlimited state must not leak balance');
for (const badBalance of [-1, Number.NaN, 'SECRET_BALANCE']) {
  const bad = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: true, balance: badBalance } } } });
  if (bad.credits.balanceState !== 'UNKNOWN' || JSON.stringify(bad).includes('SECRET_BALANCE')) throw new Error('malformed balance must fail closed');
}

for (const badUsed of [null, '', '   ', true, false, -1, Number.NaN, Number.POSITIVE_INFINITY, 'NaN', '-1', '1e3', '1.2.3', {}, []]) {
  const bad = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: badUsed } } } });
  if (bad.status !== 'UNAVAILABLE') throw new Error('invalid usedPercent must fail closed: ' + JSON.stringify(badUsed));
}
const clampedWindow = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: 150 } } } });
if (clampedWindow.primary.usedPercent !== 100 || clampedWindow.primary.remainingPercent !== 0) throw new Error(JSON.stringify(clampedWindow));
const stringWindow = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: '12.5', windowDurationMins: '300', resetsAt: '333' } } } });
if (stringWindow.primary.remainingPercent !== 87 || stringWindow.primary.windowDurationMins !== 300 || stringWindow.primary.resetsAt !== 333) throw new Error(JSON.stringify(stringWindow));
const invalidMeta = sanitizeCodexRateLimits({ result: { rateLimits: { primary: { usedPercent: 0, windowDurationMins: false, resetsAt: null } } } });
if (invalidMeta.primary.usedPercent !== 0 || invalidMeta.primary.windowDurationMins !== null || invalidMeta.primary.resetsAt !== null) throw new Error(JSON.stringify(invalidMeta));

const missingCodex = sanitizeCodexRateLimits({ result: { rateLimits: {} } });
if (missingCodex.status !== 'UNAVAILABLE') throw new Error(JSON.stringify(missingCodex));

const tempRoot = await mkdtemp(join(tmpdir(), 'ai-capacity-observer-selftest-'));
const fakeCli = join(tempRoot, 'fake-cli.mjs');
const fakeSource = `
const [provider, ...args] = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(provider === 'codex' || provider === 'timeout' || provider === 'oversized' ? 'codex-cli 9.9.9' : '9.8.7 (Claude Code)');
  process.exit(0);
}
if (provider === 'claude' && args.join(' ') === 'auth status --json') {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'pro', email: 'SPAWN_SECRET_EMAIL', orgId: 'SPAWN_SECRET_ORG' }));
  process.exit(0);
}
if (provider === 'timeout' && args[0] === 'app-server') {
  setInterval(() => {}, 1000);
} else if (provider === 'oversized' && args[0] === 'app-server') {
  process.stdout.write('SPAWN_SECRET_OVERSIZED_' + 'X'.repeat(300 * 1024));
  setInterval(() => {}, 1000);
} else if (provider === 'codex' && args[0] === 'app-server') {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        if (msg.method !== 'initialize') process.exit(31);
        console.log(JSON.stringify({ id: 1, result: { ok: true } }));
      } else if (msg.method === 'initialized') {
        continue;
      } else if (msg.id === 2) {
        if (msg.method !== 'account/rateLimits/read') process.exit(32);
        console.log(JSON.stringify({ id: 2, result: { accountId: 'SPAWN_SECRET_ACCOUNT', rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 333 }, secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 444 }, credits: { hasCredits: false, unlimited: false, balance: 0 } } } }));
      } else process.exit(33);
    }
  });
} else process.exit(2);
`;
await writeFile(fakeCli, fakeSource, 'utf8');
try {
  const codexObserved = await observeCodex(3000, { file: process.execPath, prefix: [fakeCli, 'codex'] });
  if (codexObserved.capacity.status !== 'AVAILABLE' || codexObserved.capacity.primary.remainingPercent !== 88 || codexObserved.capacity.credits.balanceState !== 'NONE') {
    throw new Error(JSON.stringify(codexObserved));
  }
  if (JSON.stringify(codexObserved).includes('SPAWN_SECRET_ACCOUNT')) throw new Error('spawn codex secret leaked');

  let claudeDesc = { file: process.execPath, prefix: [fakeCli, 'claude'] };
  if (process.platform === 'win32') {
    const fakeCmd = join(tempRoot, 'fake-claude.cmd');
    await writeFile(fakeCmd, `@echo off\r\n"${process.execPath}" "${fakeCli}" claude %*\r\n`, 'utf8');
    claudeDesc = descriptorForResolvedPath(fakeCmd);
  }
  const claudeObserved = observeClaude(3000, claudeDesc);
  if (claudeObserved.auth.status !== 'AUTHENTICATED' || claudeObserved.auth.subscriptionType !== 'pro') {
    throw new Error(JSON.stringify(claudeObserved));
  }
  const claudeText = JSON.stringify(claudeObserved);
  if (claudeText.includes('SPAWN_SECRET_EMAIL') || claudeText.includes('SPAWN_SECRET_ORG')) throw new Error('spawn claude secret leaked');

  const started = Date.now();
  const timedOut = await observeCodex(1000, { file: process.execPath, prefix: [fakeCli, 'timeout'] });
  if (timedOut.capacity.reason !== 'codex_rate_limit_timeout') throw new Error(JSON.stringify(timedOut));
  if (Date.now() - started > 6000) throw new Error('timeout cleanup took too long');
  const oversized = await observeCodex(3000, { file: process.execPath, prefix: [fakeCli, 'oversized'] });
  if (oversized.capacity.reason !== 'codex_rate_limit_output_too_large') throw new Error(JSON.stringify(oversized));
  if (JSON.stringify(oversized).includes('SPAWN_SECRET_OVERSIZED')) throw new Error('oversized raw output leaked');
  const comparable = buildSummary({
    codex: { capacity: { status: 'AVAILABLE' } },
    claude: { capacity: { status: 'AVAILABLE' } },
  });
  if (comparable.capacityComparison !== 'COMPARABLE') throw new Error(JSON.stringify(comparable));
  const observerSource = await readFile(observerArg, 'utf8');
  const allowedMethods = new Set(['initialize', 'initialized', 'account/rateLimits/read']);
  const observedMethods = [...observerSource.matchAll(/method:\s*'([^']+)'/g)].map((match) => match[1]);
  for (const method of observedMethods) if (!allowedMethods.has(method)) throw new Error(`unexpected observer RPC: ${method}`);
  for (const forbidden of ['account/rateLimitResetCredit/consume', 'account/sendAddCreditsNudgeEmail', "['exec'", "['-p'"]) {
    if (observerSource.includes(forbidden)) throw new Error(`observer contains forbidden token: ${forbidden}`);
  }
  console.log('ai-capacity-observer selftest: PASS');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
