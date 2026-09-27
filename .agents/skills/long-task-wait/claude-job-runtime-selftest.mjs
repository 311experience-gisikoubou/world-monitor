#!/usr/bin/env node
// Functional regression coverage for the two claude-job hardening gaps:
//   1. check-claude-job.ps1 NO_PROGRESS_WARNING is warning/candidate-only and never kills anything.
//   2. stop-claude-job.ps1 is fail-closed on wrong JobId/identity and performs an exact
//      synthetic process stop only on a confirmed identity match.
// These scripts are Windows PowerShell only, so this whole file is a no-op on other platforms.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jobDir = join(here, 'claude-job');
const checkScript = join(jobDir, 'check-claude-job.ps1');
const stopScript = join(jobDir, 'stop-claude-job.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git failed: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout.trim();
}
function runPs(script, args) {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function getStartTicks(pid) {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });
  const raw = (r.stdout || '').trim();
  return /^\d+$/.test(raw) ? raw : null;
}
function readStartTicks(pid) {
  let ticks = null;
  for (let i = 0; i < 30 && !ticks; i++) {
    ticks = getStartTicks(pid);
    if (!ticks) spawnSync(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 100'], { windowsHide: true });
  }
  assert.ok(ticks, `must be able to read start ticks for PID ${pid}`);
  return ticks;
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function waitUntilDead(pid, tries = 30) {
  let alive = isAlive(pid);
  for (let i = 0; i < tries && alive; i++) { spawnSync(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 100'], { windowsHide: true }); alive = isAlive(pid); }
  return alive;
}
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'claude-job-runtime-'));
  git(['init', '-q', root]);
  git(['config', 'user.name', 'AI Test'], root);
  git(['config', 'user.email', 'ai-test@example.invalid'], root);
  writeFileSync(join(root, 'README.md'), 'seed\n');
  git(['add', 'README.md'], root);
  git(['commit', '-q', '-m', 'seed'], root);
  const head = git(['rev-parse', 'HEAD'], root);
  return { root, head };
}
function writeStatus(dir, f) {
  writeFileSync(join(dir, 'status.json'), `{
  "job_id": ${JSON.stringify(f.jobId)},
  "task": "test",
  "state": ${JSON.stringify(f.state)},
  "repo": ${JSON.stringify(f.repo)},
  "worktree": ${JSON.stringify(f.worktree)},
  "branch": ${JSON.stringify(f.branch)},
  "root_base_commit": ${JSON.stringify(f.rootBaseCommit)},
  "scope_paths": [],
  "started_at": ${JSON.stringify(f.startedAt)},
  "runner_pid": ${f.runnerPid},
  "runner_process_start_utc_ticks": ${f.runnerTicks}
}`, 'utf8');
}
function writeLock(jobsRoot, f) {
  writeFileSync(join(jobsRoot, 'running.lock'), `{
  "job_id": ${JSON.stringify(f.jobId)},
  "runner_pid": ${f.runnerPid},
  "runner_process_start_utc_ticks": ${f.runnerTicks},
  "started_at": ${JSON.stringify(new Date().toISOString())}
}`, 'utf8');
}

const cleanupChildren = [];
const cleanupPids = [];
function trackedProbe() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  cleanupChildren.push(child);
  return child;
}
// A synthetic "parent" process that itself spawns and owns a live child process, so a
// stop test can prove taskkill /T reaches the child and no orphan is left behind.
function trackedParentWithChild() {
  const marker = join(tmpdir(), `claude-job-child-pid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const parentSrc = [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });",
    `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', parentSrc], { stdio: 'ignore', windowsHide: true });
  cleanupChildren.push(parent);
  let childPid = null;
  for (let i = 0; i < 50 && !childPid; i++) {
    if (existsSync(marker)) {
      const raw = readFileSync(marker, 'utf8').trim();
      if (/^\d+$/.test(raw)) childPid = Number(raw);
    }
    if (!childPid) spawnSync(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 100'], { windowsHide: true });
  }
  assert.ok(childPid, 'child process pid marker file must appear');
  try { rmSync(marker, { force: true }); } catch { }
  cleanupPids.push(childPid);
  return { parentPid: parent.pid, childPid };
}

if (process.platform !== 'win32') {
  console.log('claude-job-runtime selftest: SKIPPED (non-Windows platform; check/stop scripts are Windows PowerShell only)');
} else
try {
  // --- Test A: exact synthetic process stop on a confirmed identity match, proving
  //     taskkill /T reaches a real child of the recorded process (no orphan left behind) ---
  {
    const { root, head } = makeRepo();
    try {
      const { parentPid: pid, childPid } = trackedParentWithChild();
      const ticks = readStartTicks(pid);
      assert.equal(isAlive(pid), true, 'synthetic parent must be alive before stop');
      assert.equal(isAlive(childPid), true, 'synthetic parent-owned child must be alive before stop');
      const jobsRoot = join(root, '.ai-jobs');
      const jid = 'testjob-A';
      const jd = join(jobsRoot, jid);
      mkdirSync(jd, { recursive: true });
      writeStatus(jd, { jobId: jid, state: 'RUNNING', repo: root, worktree: root, branch: 'job/testjob-A', rootBaseCommit: head, startedAt: new Date().toISOString(), runnerPid: pid, runnerTicks: ticks });
      writeLock(jobsRoot, { jobId: jid, runnerPid: pid, runnerTicks: ticks });

      const result = runPs(stopScript, ['-RepoPath', root, '-JobId', jid, '-Reason', 'selftest-stop-A']);
      assert.equal(result.status, 0, `expected exact synthetic stop to succeed: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /\[STOPPED\] testjob-A/);
      assert.equal(waitUntilDead(pid), false, 'exact recorded synthetic parent process must be stopped');
      assert.equal(waitUntilDead(childPid), false, 'the recorded parent\'s live child must also be stopped (taskkill /T prevents an orphan)');

      const st = JSON.parse(readFileSync(join(jd, 'status.json'), 'utf8'));
      assert.equal(st.state, 'STOPPED');
      assert.ok(st.stopped_at, 'stopped_at must be recorded');
      assert.equal(st.stop_reason, 'selftest-stop-A');
      assert.ok(st.ended_at, 'ended_at must be recorded');
      assert.equal(existsSync(join(jobsRoot, 'running.lock')), false, 'matching running.lock must be removed after confirmed stop');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test B: unknown JobId fails closed ---
  {
    const { root } = makeRepo();
    try {
      const result = runPs(stopScript, ['-RepoPath', root, '-JobId', 'does-not-exist']);
      assert.notEqual(result.status, 0, 'unknown JobId must fail closed');
      assert.match(result.stdout, /\[STOP-FAILED\]/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test C: wrong recorded identity (start-ticks mismatch) fails closed; real live process untouched ---
  {
    const { root, head } = makeRepo();
    try {
      const child = trackedProbe();
      const pid = child.pid;
      const ticks = readStartTicks(pid);
      const wrongTicks = String(BigInt(ticks) + 1234567890n);
      const jobsRoot = join(root, '.ai-jobs');
      const jid = 'testjob-C';
      const jd = join(jobsRoot, jid);
      mkdirSync(jd, { recursive: true });
      writeStatus(jd, { jobId: jid, state: 'RUNNING', repo: root, worktree: root, branch: 'job/testjob-C', rootBaseCommit: head, startedAt: new Date().toISOString(), runnerPid: pid, runnerTicks: wrongTicks });

      const result = runPs(stopScript, ['-RepoPath', root, '-JobId', jid]);
      assert.notEqual(result.status, 0, 'identity mismatch (wrong recorded start ticks) must fail closed');
      assert.match(result.stdout, /\[STOP-FAILED\]/);
      assert.equal(isAlive(pid), true, 'the real live process must be left untouched on identity mismatch');

      const st = JSON.parse(readFileSync(join(jd, 'status.json'), 'utf8'));
      assert.equal(st.state, 'RUNNING', 'status must remain unchanged on a fail-closed identity mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test D: job not active (terminal state) fails closed even with a matching identity ---
  {
    const { root, head } = makeRepo();
    try {
      const child = trackedProbe();
      const pid = child.pid;
      const ticks = readStartTicks(pid);
      const jobsRoot = join(root, '.ai-jobs');
      const jid = 'testjob-D';
      const jd = join(jobsRoot, jid);
      mkdirSync(jd, { recursive: true });
      writeStatus(jd, { jobId: jid, state: 'READY_FOR_REVIEW', repo: root, worktree: root, branch: 'job/testjob-D', rootBaseCommit: head, startedAt: new Date().toISOString(), runnerPid: pid, runnerTicks: ticks });

      const result = runPs(stopScript, ['-RepoPath', root, '-JobId', jid]);
      assert.notEqual(result.status, 0, 'a terminal-state job must fail closed');
      assert.equal(isAlive(pid), true, 'process must be left untouched when job is not active');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test E: running.lock belonging to a different job/identity is left untouched ---
  {
    const { root, head } = makeRepo();
    try {
      const child = trackedProbe();
      const pid = child.pid;
      const ticks = readStartTicks(pid);
      const jobsRoot = join(root, '.ai-jobs');
      const jid = 'testjob-E';
      const jd = join(jobsRoot, jid);
      mkdirSync(jd, { recursive: true });
      writeStatus(jd, { jobId: jid, state: 'RUNNING', repo: root, worktree: root, branch: 'job/testjob-E', rootBaseCommit: head, startedAt: new Date().toISOString(), runnerPid: pid, runnerTicks: ticks });
      writeLock(jobsRoot, { jobId: 'some-other-job', runnerPid: pid + 1, runnerTicks: ticks });

      const result = runPs(stopScript, ['-RepoPath', root, '-JobId', jid, '-Reason', 'selftest-stop-E']);
      assert.equal(result.status, 0, `expected stop to succeed: ${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(join(jobsRoot, 'running.lock')), true, 'a lock belonging to a different job/identity must be left in place');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test F: NO_PROGRESS_WARNING is warning-only; check-claude-job.ps1 never kills anything ---
  {
    const { root, head } = makeRepo();
    try {
      const child = trackedProbe();
      const pid = child.pid;
      const ticks = readStartTicks(pid);
      const jobsRoot = join(root, '.ai-jobs');
      const jid = 'testjob-F';
      const jd = join(jobsRoot, jid);
      mkdirSync(jd, { recursive: true });
      const startedAt = new Date(Date.now() - 70 * 60 * 1000).toISOString(); // 70 min ago -> LONG_RUNNING under default 60
      writeStatus(jd, { jobId: jid, state: 'RUNNING', repo: root, worktree: root, branch: 'job/testjob-F', rootBaseCommit: head, startedAt, runnerPid: pid, runnerTicks: ticks });
      const statusPath = join(jd, 'status.json');
      const staleMtime = new Date(Date.now() - 120 * 60 * 1000);
      utimesSync(statusPath, staleMtime, staleMtime);

      const stale = runPs(checkScript, ['-RepoPath', root, '-JobId', jid, '-NoProgressMinutes', '30']);
      assert.equal(stale.status, 0, `check should succeed: ${stale.stdout}\n${stale.stderr}`);
      assert.match(stale.stdout, /NO_PROGRESS_WARNING/, 'stale evidence must surface NO_PROGRESS_WARNING');
      assert.match(stale.stdout, /candidate/i);
      assert.match(stale.stdout, /never an automatic kill trigger/i);
      assert.equal(isAlive(pid), true, 'check-claude-job.ps1 must never kill the process it is only reading about');

      const freshMtime = new Date();
      utimesSync(statusPath, freshMtime, freshMtime);
      const fresh = runPs(checkScript, ['-RepoPath', root, '-JobId', jid, '-NoProgressMinutes', '30']);
      assert.equal(fresh.status, 0);
      assert.doesNotMatch(fresh.stdout, /NO_PROGRESS_WARNING/, 'fresh evidence must not surface NO_PROGRESS_WARNING');
      assert.equal(isAlive(pid), true, 'process must remain alive after a normal read-only check');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test G: traversal-like / unsafe JobId fails closed before any Join-Path/file
  //     access and cannot escape .ai-jobs ---
  {
    const { root } = makeRepo();
    try {
      const jobsRoot = join(root, '.ai-jobs');
      const escapeMarkers = [join(root, 'escaped.txt'), join(dirname(root), 'escaped.txt')];
      const unsafeIds = [
        '../evil', '..\\evil', '../../etc/passwd', '..', '.', 'a/b', 'a\\b',
        'C:\\evil', 'C:evil', '  ', 'a b', 'a\tb', 'a:b', '.hidden', 'trailing.',
        '-badstart',
      ];
      for (const badId of unsafeIds) {
        const result = runPs(stopScript, ['-RepoPath', root, '-JobId', badId]);
        assert.notEqual(result.status, 0, `unsafe JobId must fail closed: ${JSON.stringify(badId)}`);
        assert.match(result.stdout, /\[STOP-FAILED\]/, `unsafe JobId must emit STOP-FAILED: ${JSON.stringify(badId)}`);
        for (const marker of escapeMarkers) {
          assert.equal(existsSync(marker), false, `unsafe JobId must not create anything outside .ai-jobs: ${JSON.stringify(badId)}`);
        }
      }
      assert.equal(existsSync(jobsRoot), false, 'no .ai-jobs directory should have been created for any rejected JobId');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  console.log('claude-job-runtime selftest: PASS');
} finally {
  for (const child of cleanupChildren) { try { child.kill(); } catch { } }
  for (const pid of cleanupPids) { try { process.kill(pid); } catch { } }
}
