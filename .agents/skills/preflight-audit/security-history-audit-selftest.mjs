#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const gate = resolve(process.argv[2]);
function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'ignore' }); }
function run(cwd, visibility='private') {
  return spawnSync(process.execPath, [gate, '--visibility', visibility, '--json'], { cwd, encoding: 'utf8' });
}
function makeRepo() {
  const d = mkdtempSync(join(tmpdir(), 'history-audit-'));
  git(d, 'init');
  git(d, 'config', 'user.email', 'selftest@example.invalid');
  git(d, 'config', 'user.name', 'selftest');
  writeFileSync(join(d, 'safe.js'), 'export const x=1;\n');
  git(d, 'add', '.');
  git(d, 'commit', '-m', 'safe');
  return d;
}
let d;
try {
  d = makeRepo();
  let r = run(d);
  if (r.status !== 0 || !r.stdout.includes('PROCEED')) throw new Error('safe history should proceed');

  const syntheticPersonFile = 'SYNTHETIC_PERSON_IDENTIFIER_123.csv';
  writeFileSync(join(d, syntheticPersonFile), 'secret-body-not-for-output\n');
  git(d, 'add', '.'); git(d, 'commit', '-m', 'data');
  rmSync(join(d, syntheticPersonFile)); git(d, 'add', '-A'); git(d, 'commit', '-m', 'remove');
  r = run(d, 'private');
  if (r.status === 0 || !r.stdout.includes('HISTORICAL_DATA_OR_MEDIA_PATH')) throw new Error('historical csv should be found');
  if (r.stdout.includes(syntheticPersonFile)) throw new Error('history audit leaked a potentially sensitive filename');
  if (r.stdout.includes('secret-body-not-for-output')) throw new Error('history audit leaked content');

  mkdirSync(join(d, 'backup'));
  const syntheticDbFile = 'SYNTHETIC_PERSON_IDENTIFIER_456.db';
  writeFileSync(join(d, 'backup', syntheticDbFile), 'not-a-real-db\n');
  git(d, 'add', '.'); git(d, 'commit', '-m', 'db');
  rmSync(join(d, 'backup'), { recursive: true }); git(d, 'add', '-A'); git(d, 'commit', '-m', 'remove db');
  r = run(d, 'public');
  if (r.status === 0 || !r.stdout.includes('HISTORICAL_HIGH_RISK_PATH')) throw new Error('public historical db should stop');
  if (r.stdout.includes(syntheticDbFile) || r.stdout.includes('backup/')) throw new Error('history audit leaked high-risk path');
  if (r.stdout.includes('not-a-real-db')) throw new Error('history audit leaked db content');

  const syntheticHtmlFile = 'SYNTHETIC_PERSON_IDENTIFIER_789.html';
  writeFileSync(join(d, syntheticHtmlFile), 'x'.repeat(600 * 1024));
  git(d, 'add', '.'); git(d, 'commit', '-m', 'large html');
  rmSync(join(d, syntheticHtmlFile)); git(d, 'add', '-A'); git(d, 'commit', '-m', 'remove html');
  r = run(d, 'private');
  if (!r.stdout.includes('LARGE_HISTORICAL_HTML')) throw new Error('large historical html should be flagged');
  if (r.stdout.includes(syntheticHtmlFile)) throw new Error('history audit leaked large-html filename');

  console.log('security-history-audit selftest: PASS');
} finally {
  if (d) rmSync(d, { recursive: true, force: true });
}
