#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateWorkStart, parseArgs, parseRemoteDefault } from './work-start-guard.mjs';

const sha = ch => ch.repeat(40);
const base = {
  schemaVersion: 1,
  mode: 'write',
  baseBranch: 'main',
  branch: 'fix/test',
  headSha: sha('a'),
  localBaseSha: sha('b'),
  liveBaseSha: sha('b'),
  mergeBaseSha: sha('b'),
  worktreeClean: true,
  agentsState: 'CURRENT',
};

assert.throws(() => parseArgs(['--base', 'release/old']), /BASE_OVERRIDE_FORBIDDEN/);
assert.deepEqual(parseRemoteDefault(`ref: refs/heads/main\tHEAD\n${sha('b')}\tHEAD\n`), { baseBranch: 'main', liveBaseSha: sha('b') });
assert.equal(parseRemoteDefault(''), null);

let result = evaluateWorkStart(base);
assert.equal(result.result, 'PASS');
assert.equal(result.code, 'WORK_START_READY');

result = evaluateWorkStart({ ...base, worktreeClean: false });
assert.equal(result.code, 'WORK_START_DIRTY_WORKTREE');

result = evaluateWorkStart({ ...base, branch: 'main' });
assert.equal(result.code, 'WORK_START_PROTECTED_BRANCH');
result = evaluateWorkStart({ ...base, localBaseSha: sha('c') });
assert.equal(result.code, 'WORK_START_LOCAL_BASE_STALE');

result = evaluateWorkStart({ ...base, mergeBaseSha: sha('d') });
assert.equal(result.code, 'WORK_START_BRANCH_NOT_CURRENT_BASE');

result = evaluateWorkStart({ ...base, agentsState: 'STALE' });
assert.equal(result.code, 'WORK_START_AGENTS_NOT_CURRENT');

result = evaluateWorkStart({
  ...base,
  mode: 'read-only',
  branch: 'main',
  worktreeClean: false,
  localBaseSha: sha('c'),
  mergeBaseSha: sha('d'),
  agentsState: 'UNKNOWN',
});
assert.equal(result.result, 'PASS');
assert.equal(result.code, 'WORK_START_READ_ONLY_INSPECTION');
assert(result.warnings.includes('DIRTY_WORKTREE'));
assert(result.warnings.includes('PROTECTED_BRANCH'));
assert(result.warnings.includes('LOCAL_BASE_STALE'));
assert(result.warnings.includes('BRANCH_NOT_DERIVED_FROM_LIVE_BASE'));
assert(result.warnings.includes('AGENTS_NOT_CURRENT'));

console.log('work-start-guard selftest: PASS');
