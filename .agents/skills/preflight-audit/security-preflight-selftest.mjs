#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gate = resolve(gateArg);
function run(cwd, extra = []) {
  return spawnSync(process.execPath, [gate, '--mode', 'audit', '--data-mode', 'source-only', '--json', ...extra], { cwd, encoding: 'utf8' });
}
function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'ignore' }); }
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'security-preflight-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'selftest@example.invalid');
  git(dir, 'config', 'user.name', 'selftest');
  git(dir, 'checkout', '-b', 'feature/selftest');
  writeFileSync(join(dir, 'safe.txt'), 'safe\n');
  git(dir, 'add', 'safe.txt');
  git(dir, 'commit', '-m', 'safe');
  return dir;
}
let dir;
try {
  dir = repo();
  let r = run(dir);
  if (r.status !== 0 || !r.stdout.includes('PROCEED')) throw new Error(`safe repo should proceed: ${r.stdout} ${r.stderr}`);

  const syntheticSensitiveName = 'SYNTHETIC_PERSON_IDENTIFIER_123.pdf';
  writeFileSync(join(dir, syntheticSensitiveName), 'synthetic-content-not-for-output\n');
  r = run(dir);
  if (r.status === 0 || !r.stdout.includes('CHANGED_DATA_OR_MEDIA_FILE')) throw new Error('pdf should require check');
  if (r.stdout.includes(syntheticSensitiveName)) throw new Error('gate leaked a potentially sensitive filename');
  if (r.stdout.includes('synthetic-content-not-for-output')) throw new Error('gate leaked file content');
  rmSync(join(dir, syntheticSensitiveName));

  const externalSample = 'f' + "etch('h" + 'ttps://example.invalid/api' + "')\n";
  const externalFileName = 'SYNTHETIC_PERSON_IDENTIFIER_456.js';
  writeFileSync(join(dir, externalFileName), externalSample);
  git(dir, 'add', externalFileName);
  r = run(dir);
  if (r.status === 0 || !r.stdout.includes('NEW_EXTERNAL_COMMUNICATION_MARKER')) throw new Error('external marker should stop');
  if (r.stdout.includes(externalFileName)) throw new Error('gate leaked external-marker filename');
  if (r.stdout.includes('example.invalid/api')) throw new Error('gate leaked diff content');
  rmSync(join(dir, externalFileName));
  git(dir, 'reset');

  const secretSample = 'PASS' + 'WORD=' + 'super' + 'secretvalue\n';
  writeFileSync(join(dir, '.env'), secretSample);
  r = run(dir);
  if (r.status === 0 || !r.stdout.includes('CHANGED_HIGH_RISK_FILE')) throw new Error('.env should stop');
  if (r.stdout.includes('.env')) throw new Error('gate leaked high-risk filename');
  if (r.stdout.includes('supersecretvalue')) throw new Error('gate leaked secret content');

  console.log('security-preflight selftest: PASS');
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
