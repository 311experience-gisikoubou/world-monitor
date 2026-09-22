#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jobDir = path.join(here, 'claude-job');
const read = (name) => fs.readFileSync(path.join(jobDir, name), 'utf8');
for (const name of ['README.md', 'run-claude-job.ps1', 'claude-job-runner.ps1', 'check-claude-job.ps1']) {
  assert.equal(fs.existsSync(path.join(jobDir, name)), true, `${name} must exist`);
}
const launcher = read('run-claude-job.ps1');
const runner = read('claude-job-runner.ps1');
const checker = read('check-claude-job.ps1');
assert.match(launcher, /git -C \$top worktree add/);
assert.match(launcher, /Process-MatchesIdentity/);
assert.match(launcher, /runner_process_start_utc_ticks/);
assert.doesNotMatch(launcher, /Start-Process\s+@startArgs/);
assert.match(launcher, /& \$runner -JobDir \$jobDir -LockPath \$lockPath/);
assert.match(launcher, /live-base-ref-guard\.mjs/);
assert.match(launcher, /FileMode\]::CreateNew/);
assert.match(launcher, /FileShare\]::None/);
assert.doesNotMatch(launcher, /FileMode\]::CreateNew\)\)\.Close/);
assert.match(launcher, /\$_ -eq '\.\.'|\$_ -eq "\.\."/);
assert.match(launcher, /traversal is forbidden/);
assert.match(runner, /implementation-orchestrator\.mjs/);
assert.doesNotMatch(runner, /Get-Command\s+claude|&\s*claude(?:\.exe)?\b/i);
assert.match(runner, /runner_process_start_utc_ticks/);
assert.match(runner, /Join-Path \$JobDir 'DONE'/);
assert.match(checker, /runner_process_start_utc_ticks/);
assert.match(checker, /LONG_RUNNING/);
assert.match(checker, /PID \$rpid reused by another process/);
console.log('claude-job selftest: PASS');
