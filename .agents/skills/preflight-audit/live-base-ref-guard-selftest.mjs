import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const guardPath = resolve(process.argv[2] ?? '');
if (!guardPath) throw new Error('guard path required');
const root = mkdtempSync(join(tmpdir(), 'live-base-ref-guard-'));
const remote = join(root, 'remote.git');
const seed = join(root, 'seed');
const client = join(root, 'client');

function git(args, cwd = root) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git failed: ${args[0]} ${args[1] ?? ''}`);
  return r.stdout.trim();
}
function runGuard(cwd, args) {
  const r = spawnSync(process.execPath, [guardPath, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  let json;
  try { json = JSON.parse(r.stdout.trim()); } catch { throw new Error('guard output must be JSON'); }
  return { status: r.status, json };
}
function assert(value, message) { if (!value) throw new Error(`FAIL: ${message}`); }
try {
  git(['init', '--bare', remote]);
  git(['init', seed]);
  git(['config', 'user.name', 'AI Test'], seed);
  git(['config', 'user.email', 'ai-test@example.invalid'], seed);
  writeFileSync(join(seed, 'README.md'), 'one\n');
  git(['add', 'README.md'], seed);
  git(['commit', '-m', 'one'], seed);
  git(['branch', '-M', 'main'], seed);
  git(['remote', 'add', 'origin', remote], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  git(['clone', '--branch', 'main', remote, client]);
  git(['remote', 'add', 'upstream', remote], client);

  const current = runGuard(client, ['--base', 'main', '--pretty']);
  assert(current.status === 0, 'current tracking ref should pass');
  assert(current.json.result === 'PROCEED', 'current result should PROCEED');
  assert(current.json.code === 'LIVE_BASE_TRACKING_CURRENT', 'current code mismatch');

  const customRemote = runGuard(client, ['--base', 'main', '--remote', 'upstream']);
  assert(customRemote.status === 2 && customRemote.json.code === 'LOCAL_TRACKING_REF_MISSING', 'custom remote should be accepted and fail only because its tracking ref is missing');
  git(['fetch', 'upstream', 'refs/heads/main:refs/remotes/upstream/main'], client);
  const customRemoteCurrent = runGuard(client, ['--base', 'main', '--remote', 'upstream']);
  assert(customRemoteCurrent.status === 0, 'custom remote should pass after its tracking ref is refreshed');

  writeFileSync(join(seed, 'README.md'), 'two\n');
  git(['add', 'README.md'], seed);
  git(['commit', '-m', 'two'], seed);
  git(['push', 'origin', 'main'], seed);
  const stale = runGuard(client, ['--base', 'main']);
  assert(stale.status === 2, 'stale tracking ref should stop');
  assert(stale.json.code === 'LOCAL_TRACKING_REF_STALE', 'stale code mismatch');
  assert(stale.json.localTrackingSha !== stale.json.liveBaseSha, 'stale SHAs should differ');

  git(['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'], client);
  const refreshed = runGuard(client, ['--base', 'main']);
  assert(refreshed.status === 0, 'refreshed tracking ref should pass');
  assert(refreshed.json.localTrackingSha === refreshed.json.liveBaseSha, 'refreshed SHAs should match');

  const missing = runGuard(client, ['--base', 'missing-branch']);
  assert(missing.status === 2, 'missing live branch should stop');
  assert(missing.json.code === 'LIVE_BASE_REF_MISSING', 'missing live branch code mismatch');

  const invalid = runGuard(client, ['--wat', 'x']);
  assert(invalid.status === 2, 'unknown CLI argument should stop');
  assert(invalid.json.code === 'CLI_ARGUMENT_INVALID', 'unknown CLI code mismatch');

  const invalidBase = runGuard(client, ['--base', 'main;evil']);
  assert(invalidBase.status === 2, 'unsafe base branch should stop');
  assert(invalidBase.json.code === 'BASE_BRANCH_INVALID', 'unsafe base branch code mismatch');

  const invalidRemote = runGuard(client, ['--base', 'main', '--remote', '-origin']);
  assert(invalidRemote.status === 2, 'dash-prefixed remote should stop');
  assert(invalidRemote.json.code === 'REMOTE_NAME_INVALID', 'dash-prefixed remote code mismatch');

  const outsideRepo = runGuard(root, ['--base', 'main']);
  assert(outsideRepo.status === 2, 'non-repository cwd should stop');
  assert(outsideRepo.json.code === 'NOT_GIT_REPOSITORY', 'non-repository code mismatch');

  const duplicateRemote = runGuard(client, ['--base', 'main', '--remote', 'origin', '--remote', 'upstream']);
  assert(duplicateRemote.status === 2, 'duplicate remote argument should stop');
  assert(duplicateRemote.json.code === 'CLI_ARGUMENT_INVALID', 'duplicate remote code mismatch');

  console.log('LIVE_BASE_REF_GUARD_SELFTEST=PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
