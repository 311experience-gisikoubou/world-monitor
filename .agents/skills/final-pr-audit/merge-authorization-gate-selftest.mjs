#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gate = resolve(gateArg);

function run(extra) {
  return spawnSync(process.execPath, [gate, '--json', ...extra], { encoding: 'utf8' });
}
function expect(extra, status, code) {
  const r = run(extra);
  if (!r.stdout.includes(`"result":"${status}"`)) {
    throw new Error(`expected ${status}: ${r.stdout} ${r.stderr}`);
  }
  if (!r.stdout.includes(code)) throw new Error(`missing ${code}: ${r.stdout}`);
  const expectedExit = status === 'PERSIST' ? 0 : status === 'REAUTHORIZE' ? 3 : 2;
  if (r.status !== expectedExit) throw new Error(`unexpected exit ${r.status}, expected ${expectedExit}`);
}

const base = [
  '--approved', 'yes',
  '--same-pr', 'yes',
  '--same-purpose', 'yes',
  '--same-spec', 'yes',
  '--same-safety-boundary', 'yes',
  '--same-risk-boundary', 'yes',
  '--latest-audit', 'pass',
];

expect([...base, '--head-changed', 'no'], 'PERSIST', 'MERGE_APPROVAL_PERSISTS');
expect([...base, '--head-changed', 'yes'], 'PERSIST', 'MERGE_APPROVAL_PERSISTS_AFTER_HEAD_CHANGE');

expect([
  ...base,
  '--head-changed', 'yes',
  '--latest-audit', 'fail',
], 'STOP', 'LATEST_AUDIT_FAILED');

expect([
  ...base,
  '--head-changed', 'yes',
  '--latest-audit', 'unknown',
], 'STOP', 'LATEST_AUDIT_UNKNOWN');

expect([
  ...base,
  '--head-changed', 'yes',
  '--same-spec', 'no',
], 'REAUTHORIZE', 'MERGE_APPROVAL_SCOPE_CHANGED');

expect([
  ...base,
  '--head-changed', 'yes',
  '--same-safety-boundary', 'no',
], 'REAUTHORIZE', 'MERGE_APPROVAL_SCOPE_CHANGED');

expect([
  ...base,
  '--head-changed', 'yes',
  '--same-pr', 'no',
], 'REAUTHORIZE', 'MERGE_APPROVAL_SCOPE_CHANGED');

expect([
  ...base,
  '--head-changed', 'yes',
  '--approved', 'no',
], 'REAUTHORIZE', 'MERGE_APPROVAL_NOT_PRESENT');

console.log('merge-authorization-gate selftest: PASS');
