#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jobDir = path.join(here, 'claude-job');
const read = (name) => fs.readFileSync(path.join(jobDir, name), 'utf8');
for (const name of ['README.md', 'run-claude-job.ps1', 'claude-job-runner.ps1', 'check-claude-job.ps1', 'stop-claude-job.ps1']) {
  assert.equal(fs.existsSync(path.join(jobDir, name)), true, `${name} must exist`);
}
const launcher = read('run-claude-job.ps1');
const runner = read('claude-job-runner.ps1');
const checker = read('check-claude-job.ps1');
const stopper = read('stop-claude-job.ps1');
const readme = read('README.md');
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

// NO_PROGRESS_WARNING: warning/candidate signal only, honestly named, configurable, and
// check-claude-job.ps1 must remain read-only (it must never itself stop/signal a process).
assert.match(checker, /NO_PROGRESS_WARNING/);
assert.match(checker, /\$NoProgressMinutes\s*=\s*90/);
assert.match(checker, /candidate/i);
assert.match(checker, /never an automatic kill trigger/i);
assert.match(checker, /buffers the provider'?s stdout\/stderr/i);
assert.doesNotMatch(checker, /Stop-Process/i);
assert.doesNotMatch(checker, /taskkill/i);

// stop-claude-job.ps1: dedicated, explicitly-named, fail-closed manual stop only.
// The regression check must target only the script's top-level param() block (the caller
// contract), not private helper function parameters like Process-MatchesIdentity's internal
// [int]$processId, which legitimately receives the already-recorded PID from status.json.
const stopperParamBlockMatch = stopper.match(/(?:^|\n)param\(([\s\S]*?)\r?\n\)/);
assert.ok(stopperParamBlockMatch, 'stop script top-level param() block not found');
const stopperParamBlock = stopperParamBlockMatch[1];
assert.match(stopperParamBlock, /\$RepoPath\b/, 'top-level param block must expose -RepoPath');
assert.match(stopperParamBlock, /\$JobId\b/, 'top-level param block must expose -JobId');
assert.match(stopperParamBlock, /\$Reason\b/, 'top-level param block must expose -Reason');
assert.doesNotMatch(
  stopperParamBlock,
  /\$(?:ProcessId|Pid|TargetPid)\b/i,
  'stop script top-level param block must not accept a caller-supplied PID/ProcessId/TargetPid parameter'
);
assert.match(stopper, /Process-MatchesIdentity/);
assert.match(stopper, /runner_process_start_utc_ticks/);
assert.match(stopper, /'STARTING',\s*'RUNNING',\s*'GATES_RUNNING'/);
assert.match(stopper, /taskkill\.exe/);
assert.match(stopper, /\/PID \$rpid \/T \/F/);
assert.match(stopper, /state = 'STOPPED'|state.*STOPPED/);
assert.match(stopper, /stopped_at/);
assert.match(stopper, /stop_reason/);
assert.match(stopper, /identityMatches/);
assert.match(stopper, /left in place/i);
assert.doesNotMatch(stopper, /git .*(merge|push|reset|worktree remove|branch -[dD])/i);

// The stop script must never be auto-wired from the read-only checker or the launcher.
assert.doesNotMatch(checker, /stop-claude-job/);
assert.doesNotMatch(launcher, /stop-claude-job/);
assert.doesNotMatch(runner, /stop-claude-job/);

assert.match(readme, /stop-claude-job\.ps1/);
assert.match(readme, /NO_PROGRESS_WARNING/);
assert.match(readme, /never (?:be )?auto-invoked/);

console.log('claude-job selftest: PASS');
