#!/usr/bin/env node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const watcherArg = process.argv[2];
if (!watcherArg) throw new Error('watcher path required');
const watcher = resolve(watcherArg);
const root = await mkdtemp(join(tmpdir(), 'stagnation-watch-selftest-'));
function sameReceipt(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function cmd(command, args, cwd = root) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${command} failed: ${r.stderr}`);
  return r.stdout.trim();
}
cmd('git', ['init']);
cmd('git', ['config', 'user.email', 'test@example.com']);
cmd('git', ['config', 'user.name', 'Test']);
cmd('git', ['checkout', '-b', 'feat/test']);
await writeFile(join(root, 'app.txt'), 'v1\n');
await writeFile(join(root, 'AGENTS.md'), 'governance\n');
cmd('git', ['add', '.']);
cmd('git', ['commit', '-m', 'base']);

function run(extra, expectStatus = 0) {
  const args = [
    watcher,
    '--target-root', root,
    '--work-id', 'issue-1',
    '--gate-phase', 'test-gate',
    '--work-state', 'incomplete',
    '--human-gate', 'none',
    '--continuation-action', 'resume',
    '--workflow-status', 'failed',
    '--pr-state', 'none',
    '--failure-signature', 'same-fail',
    '--route-signature', 'route-a',
    '--interval-minutes', '60',
    ...extra,
  ];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.status !== expectStatus) throw new Error(`status ${r.status}, expected ${expectStatus}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

let out = run(['--now', '2026-09-03T10:00:00Z']);
if (out.code !== 'STAGNATION_BASELINE_CREATED') throw new Error(JSON.stringify(out));
out = run(['--now', '2026-09-03T10:59:00Z']);
if (out.code !== 'STAGNATION_CHECKPOINT_NOT_DUE') throw new Error(JSON.stringify(out));
out = run(['--now', '2026-09-03T11:00:00Z'], 2);
if (out.code !== 'STAGNATION_L1_ROOT_CAUSE_REQUIRED' || out.nextState.unchangedCheckpoints !== 1) throw new Error(JSON.stringify(out));
out = run(['--now', '2026-09-03T12:00:00Z'], 2);
if (out.code !== 'STAGNATION_L2_FORCED_REFLECTION_REQUIRED' || out.nextState.unchangedCheckpoints !== 2) throw new Error(JSON.stringify(out));
out = run(['--now', '2026-09-03T13:00:00Z'], 2);
if (out.code !== 'STAGNATION_HARD_STOP_ROUTE_CHANGE_REQUIRED' || out.nextState.unchangedCheckpoints !== 3) throw new Error(JSON.stringify(out));

await writeFile(join(root, 'app.txt'), 'v2\n');
out = run(['--now', '2026-09-03T13:01:00Z']);
if (out.code !== 'MEANINGFUL_PROGRESS_DETECTED' || out.nextState.unchangedCheckpoints !== 0) throw new Error(JSON.stringify(out));

// Governance-only edits do not count as product progress in product scope.
await writeFile(join(root, 'AGENTS.md'), 'governance changed\n');
out = run(['--now', '2026-09-03T14:01:00Z'], 2);
if (out.code !== 'STAGNATION_L1_ROOT_CAUSE_REQUIRED') throw new Error(JSON.stringify(out));

// A governance-only commit changes HEAD but must not count as product progress.
cmd('git', ['add', 'AGENTS.md']);
cmd('git', ['commit', '-m', 'governance only']);
out = run(['--now', '2026-09-03T15:01:00Z'], 2);
if (out.code !== 'STAGNATION_L2_FORCED_REFLECTION_REQUIRED') throw new Error(JSON.stringify(out));

// New observation resets stagnation even without product diff changes.
out = run(['--now', '2026-09-03T15:02:00Z', '--observation-signature', 'new-root-cause']);
if (out.code !== 'MEANINGFUL_PROGRESS_DETECTED') throw new Error(JSON.stringify(out));

// Active execution is not counted as stagnation.
out = run(['--now', '2026-09-03T19:02:00Z', '--workflow-status', 'in-progress']);
if (out.code !== 'ACTIVE_EXECUTION_IN_PROGRESS') throw new Error(JSON.stringify(out));

// Status-only response on safe incomplete work is forbidden.
out = run(['--now', '2026-09-03T19:03:00Z', '--continuation-action', 'report-only'], 2);
if (out.code !== 'SAFE_WORK_CONTINUATION_REQUIRED') throw new Error(JSON.stringify(out));

// Waiting is valid only at a genuine human gate.
out = run([
  '--now', '2026-09-03T19:04:00Z',
  '--human-gate', 'required',
  '--continuation-action', 'wait-human',
]);
if (out.code !== 'WAITING_AT_VALID_HUMAN_GATE' || out.result !== 'WAIT_HUMAN') throw new Error(JSON.stringify(out));
out = run(['--now', '2026-09-03T19:05:00Z', '--continuation-action', 'wait-human'], 2);
if (out.code !== 'UNNECESSARY_HUMAN_WAIT') throw new Error(JSON.stringify(out));

// A missed 3-hour window escalates directly to HARD_STOP on the next checkpoint.
const statePath = join(root, '.git', 'ai-dev-foundation', 'stagnation', 'issue-2.json');
const baseline2 = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', 'issue-2', '--gate-phase', 'test-gate',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'same-fail',
  '--route-signature', 'route-a', '--interval-minutes', '60', '--now', '2026-09-03T10:00:00Z',
], { encoding: 'utf8' });
if (baseline2.status !== 0) throw new Error(baseline2.stdout);
const jumped = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', 'issue-2', '--gate-phase', 'test-gate',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'same-fail',
  '--route-signature', 'route-a', '--interval-minutes', '60', '--now', '2026-09-03T13:01:00Z',
], { encoding: 'utf8' });
if (jumped.status !== 2 || !jumped.stdout.includes('STAGNATION_HARD_STOP_ROUTE_CHANGE_REQUIRED')) throw new Error(jumped.stdout);
const persisted = JSON.parse(await readFile(statePath, 'utf8'));
if (persisted.unchangedCheckpoints < 3) throw new Error('missed-window checkpoints not persisted');

// Remote-only callers can round-trip state as JSON without local writes.
const remoteBase = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', 'remote-1', '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'x',
  '--route-signature', 'r', '--interval-minutes', '60', '--now', '2026-09-03T10:00:00Z', '--no-write',
], { encoding: 'utf8' });
if (remoteBase.status !== 0) throw new Error(remoteBase.stdout);
const remoteState = JSON.parse(remoteBase.stdout).nextState;
const remoteNext = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', 'remote-1', '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'x',
  '--route-signature', 'r', '--interval-minutes', '60', '--now', '2026-09-03T11:00:00Z',
  '--state-json', JSON.stringify(remoteState), '--no-write',
], { encoding: 'utf8' });
if (remoteNext.status !== 2 || !remoteNext.stdout.includes('STAGNATION_L1_ROOT_CAUSE_REQUIRED')) throw new Error(remoteNext.stdout);


function runPreMerge(extra, expectStatus = 0) {
  const args = [
    watcher, '--target-root', root, '--work-id', 'pre-merge-' + Math.random().toString(16).slice(2),
    '--gate-phase', 'test-gate', '--work-state', 'incomplete', '--completion-target', 'pre-merge',
    '--workflow-status', 'failed', '--interval-minutes', '60', '--now', '2026-09-03T20:00:00Z', '--no-write',
    ...extra,
  ];
  const r = spawnSync(process.execPath, args, { encoding:'utf8' });
  if (r.status !== expectStatus) throw new Error('pre-merge status '+r.status+', expected '+expectStatus+': '+r.stdout+' '+r.stderr);
  return JSON.parse(r.stdout);
}
const readyStages = [
  '--test-gate-state','pass','--commit-state','done','--push-state','done','--pr-state','open','--pr-draft','yes',
  '--final-audit-state','pass','--exact-pr-head-state','verified',
];

let pm = runPreMerge(['--human-gate','none','--continuation-action','report-only','--pr-state','none'], 2);
if (pm.code !== 'PRE_MERGE_CONTINUATION_REQUIRED' || pm.handoffClass !== 'AI_OWNED') throw new Error(JSON.stringify(pm));
pm = runPreMerge(['--human-gate','none','--continuation-action','resume','--pr-state','none','--test-gate-state','fail']);
if (pm.handoffClass !== 'AI_OWNED') throw new Error(JSON.stringify(pm));
pm = runPreMerge(['--human-gate','required','--human-gate-kind','merge-authorization','--continuation-action','wait-human','--pr-state','none','--test-gate-state','fail'], 2);
if (pm.code !== 'PRE_MERGE_MERGE_GATE_PREMATURE' || pm.handoffClass !== 'AI_OWNED') throw new Error(JSON.stringify(pm));
pm = runPreMerge(['--human-gate','required','--human-gate-kind','cost','--continuation-action','wait-human','--pr-state','none']);
if (pm.code !== 'WAITING_AT_VALID_HUMAN_GATE' || pm.handoffClass !== 'HUMAN_REQUIRED') throw new Error(JSON.stringify(pm));
pm = runPreMerge(['--human-gate','none','--continuation-action','resume', ...readyStages], 2);
if (pm.code !== 'PRE_MERGE_MERGE_AUTHORIZATION_REQUIRED' || pm.handoffClass !== 'MERGE_AUTH_REQUIRED' || !pm.preMergeTechnicalReady) throw new Error(JSON.stringify(pm));
pm = runPreMerge(['--human-gate','required','--human-gate-kind','merge-authorization','--continuation-action','wait-human', ...readyStages]);
if (pm.code !== 'PRE_MERGE_READY_WAITING_MERGE_AUTH' || pm.result !== 'WAIT_HUMAN' || pm.handoffClass !== 'MERGE_AUTH_REQUIRED') throw new Error(JSON.stringify(pm));

// Terminal-response gate: safe AI-owned work cannot end as a progress-only terminal response.
pm = runPreMerge(['--human-gate','none','--continuation-action','resume','--pr-state','none','--test-gate-state','fail','--response-intent','terminate'], 2);
if (pm.code !== 'TERMINAL_RESPONSE_REJECTED_AI_CONTINUES' || pm.terminalState !== 'AI_CONTINUES' || pm.responseMayTerminate !== false || pm.handoffClass !== 'AI_OWNED' || pm.turnCloseReceipt !== null) throw new Error(JSON.stringify(pm));

// Genuine human confirmation, pre-merge readiness, complete work, and exhausted AI routes are terminal states.
pm = runPreMerge(['--human-gate','required','--human-gate-kind','cost','--continuation-action','wait-human','--pr-state','none','--response-intent','terminate']);
if (pm.terminalState !== 'HUMAN_CONFIRMATION_REQUIRED' || !pm.responseMayTerminate || !pm.turnCloseReceipt?.id || pm.turnCloseReceipt.issuedAt !== '2026-09-03T20:00:00.000Z') throw new Error(JSON.stringify(pm));
pm = runPreMerge(['--human-gate','required','--human-gate-kind','cost','--continuation-action','wait-human','--response-intent','terminate', ...readyStages]);
if (pm.terminalState !== 'HUMAN_CONFIRMATION_REQUIRED' || !pm.responseMayTerminate) throw new Error(JSON.stringify(pm));
pm = runPreMerge(['--human-gate','none','--continuation-action','resume','--response-intent','terminate', ...readyStages], 2);
if (pm.terminalState !== 'PRE_MERGE_READY' || !pm.responseMayTerminate || !pm.turnCloseReceipt?.id || pm.turnCloseReceipt.terminalState !== 'PRE_MERGE_READY') throw new Error(JSON.stringify(pm));
out = run(['--now','2026-09-03T20:10:00Z','--work-state','complete','--response-intent','terminate']);
if (out.terminalState !== 'COMPLETE' || !out.responseMayTerminate || out.result !== 'COMPLETE' || !out.turnCloseReceipt?.id || out.turnCloseReceipt.issuedAt !== '2026-09-03T20:10:00.000Z') throw new Error(JSON.stringify(out));
const firstCompleteReceipt = out.turnCloseReceipt;
out = run(['--now','2026-09-03T20:10:01Z','--work-state','complete','--response-intent','terminate']);
if (!out.turnCloseReceipt?.id || out.turnCloseReceipt.id === firstCompleteReceipt.id || out.turnCloseReceipt.issuedAt !== '2026-09-03T20:10:01.000Z') throw new Error(JSON.stringify(out));
out = run(['--now','2026-09-03T20:10:30Z','--work-state','complete','--human-gate','required','--human-gate-kind','cost','--response-intent','terminate'], 2);
if (out.code !== 'STAGNATION_WATCH_INVALID_INPUT') throw new Error(JSON.stringify(out));
out = run(['--now','2026-09-03T20:11:00Z','--ai-route-state','exhausted','--response-intent','terminate'], 2);
if (out.terminalState !== 'BLOCKED' || !out.responseMayTerminate || out.code !== 'SAFE_AI_ROUTE_EXHAUSTED' || !out.turnCloseReceipt?.id) throw new Error(JSON.stringify(out));

// A platform turn boundary is the only nonterminal response exception and must persist an exact resumable checkpoint.
const turnWorkId = 'turn-boundary-1';
const turnStatePath = join(root, '.git', 'ai-dev-foundation', 'stagnation', turnWorkId + '.json');
const turn = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', turnWorkId, '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:20:00Z',
  '--continuation-task-id', 'task-144', '--continuation-process-id', 'pid-4242',
  '--continuation-stage', 'full-suite', '--continuation-log-pointer', 'C:/tmp/full-suite.log',
  '--continuation-next-action', 'observe-existing-process',
  '--response-intent', 'platform-turn-boundary',
], { encoding:'utf8' });
if (turn.status !== 2) throw new Error(turn.stdout + turn.stderr);
const turnOut = JSON.parse(turn.stdout);
if (turnOut.code !== 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_SAVED' || turnOut.result !== 'STOP' || turnOut.terminalState !== 'AI_CONTINUES' || turnOut.responseMayTerminate !== false || !turnOut.resumeRequired || turnOut.handoffClass !== 'AI_OWNED' || turnOut.turnCloseReceipt !== null || !turnOut.resumeCheckpointReceipt?.id || turnOut.resumeCheckpointReceipt.createdAt !== '2026-09-03T20:20:00.000Z') throw new Error(JSON.stringify(turnOut));
const turnReportOnly = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', 'turn-boundary-report-only', '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'report-only',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:20:30Z',
  '--response-intent', 'platform-turn-boundary',
], { encoding:'utf8' });
if (turnReportOnly.status !== 2) throw new Error(turnReportOnly.stdout + turnReportOnly.stderr);
const turnReportOut = JSON.parse(turnReportOnly.stdout);
if (turnReportOut.code !== 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_SAVED' || turnReportOut.result !== 'STOP' || turnReportOut.responseMayTerminate !== false || turnReportOut.terminalResponseUnderlyingCode !== 'SAFE_WORK_CONTINUATION_REQUIRED') throw new Error(JSON.stringify(turnReportOut));
const turnPersisted = JSON.parse(await readFile(turnStatePath, 'utf8'));
if (turnPersisted.level !== 'PLATFORM_TURN_BOUNDARY' || turnPersisted.requiredAction !== 'resume-from-checkpoint' || turnPersisted.continuationCheckpoint?.headSha !== cmd('git',['rev-parse','HEAD']) || !sameReceipt(turnPersisted.continuationCheckpoint?.receipt, turnOut.resumeCheckpointReceipt)) throw new Error(JSON.stringify(turnPersisted));
if (turnPersisted.continuationCheckpoint?.continuation?.taskId !== 'task-144' || turnPersisted.continuationCheckpoint?.continuation?.processId !== 'pid-4242' || turnPersisted.continuationCheckpoint?.continuation?.stage !== 'full-suite' || turnPersisted.continuationCheckpoint?.continuation?.nextAction !== 'observe-existing-process') throw new Error(JSON.stringify(turnPersisted));
const tamperedState = JSON.parse(JSON.stringify(turnPersisted));
tamperedState.continuationCheckpoint.receipt.id = '0'.repeat(64);
const tamperedResume = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', turnWorkId, '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:20:45Z',
  '--state-json', JSON.stringify(tamperedState), '--no-write',
], { encoding:'utf8' });
if (tamperedResume.status !== 2) throw new Error(tamperedResume.stdout + tamperedResume.stderr);
const tamperedOut = JSON.parse(tamperedResume.stdout);
if (tamperedOut.code !== 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_INVALID' || tamperedOut.handoffClass !== 'AI_OWNED') throw new Error(JSON.stringify(tamperedOut));
const metadataTamperedState = JSON.parse(JSON.stringify(turnPersisted));
metadataTamperedState.continuationCheckpoint.continuation.processId = 'pid-9999';
const metadataTamperedResume = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', turnWorkId, '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:20:50Z',
  '--state-json', JSON.stringify(metadataTamperedState), '--no-write',
], { encoding:'utf8' });
if (metadataTamperedResume.status !== 2 || JSON.parse(metadataTamperedResume.stdout).code !== 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_INVALID') throw new Error(metadataTamperedResume.stdout + metadataTamperedResume.stderr);
const resumed = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', turnWorkId, '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:21:00Z',
], { encoding:'utf8' });
if (resumed.status !== 0) throw new Error(resumed.stdout + resumed.stderr);
const resumedOut = JSON.parse(resumed.stdout);
if (resumedOut.code !== 'PLATFORM_TURN_BOUNDARY_RESUMED' || resumedOut.handoffClass !== 'AI_OWNED' || resumedOut.resumeRequired || !sameReceipt(resumedOut.resumeCheckpointReceipt, turnOut.resumeCheckpointReceipt)) throw new Error(JSON.stringify(resumedOut));
if (resumedOut.resumeContinuation?.taskId !== 'task-144' || resumedOut.resumeContinuation?.processId !== 'pid-4242' || resumedOut.resumeContinuation?.stage !== 'full-suite' || resumedOut.resumeContinuation?.nextAction !== 'observe-existing-process') throw new Error(JSON.stringify(resumedOut));

// A saved platform checkpoint is bound to the exact branch/HEAD and cannot silently resume after repo movement.
const staleWorkId = 'turn-boundary-stale-head';
const staleSave = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', staleWorkId, '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:30:00Z',
  '--response-intent', 'platform-turn-boundary',
], { encoding:'utf8' });
if (staleSave.status !== 2) throw new Error(staleSave.stdout + staleSave.stderr);
const staleSavedOut = JSON.parse(staleSave.stdout);
if (!staleSavedOut.resumeCheckpointReceipt?.id) throw new Error(JSON.stringify(staleSavedOut));
await writeFile(join(root, 'AGENTS.md'), 'governance changed again\n');
cmd('git', ['add', 'AGENTS.md']);
cmd('git', ['commit', '-m', 'governance-only-head-move']);
const staleResume = spawnSync(process.execPath, [
  watcher, '--target-root', root, '--work-id', staleWorkId, '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:31:00Z',
], { encoding:'utf8' });
if (staleResume.status !== 2) throw new Error(staleResume.stdout + staleResume.stderr);
const staleResumeOut = JSON.parse(staleResume.stdout);
if (staleResumeOut.code !== 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_STALE_HEAD' || staleResumeOut.handoffClass !== 'AI_OWNED' || staleResumeOut.nextState?.requiredAction !== 're-evaluate-work-state') throw new Error(JSON.stringify(staleResumeOut));

// Default state storage must work from a linked Git worktree where `.git` is a file, not a directory.
const worktreeParent = await mkdtemp(join(tmpdir(), 'stagnation-watch-worktree-'));
const linkedRoot = join(worktreeParent, 'linked');
cmd('git', ['worktree', 'add', '-b', 'feat/worktree-state', linkedRoot, 'HEAD']);
const linkedRun = spawnSync(process.execPath, [
  watcher, '--target-root', linkedRoot, '--work-id', 'worktree-state-path', '--gate-phase', 'audit',
  '--work-state', 'incomplete', '--human-gate', 'none', '--continuation-action', 'resume',
  '--workflow-status', 'failed', '--pr-state', 'none', '--failure-signature', 'technical-fail',
  '--route-signature', 'route-b', '--interval-minutes', '60', '--now', '2026-09-03T20:40:00Z',
], { encoding:'utf8' });
if (linkedRun.status !== 0) throw new Error(linkedRun.stdout + linkedRun.stderr);
const linkedOut = JSON.parse(linkedRun.stdout);
if (linkedOut.code !== 'STAGNATION_BASELINE_CREATED') throw new Error(JSON.stringify(linkedOut));
const linkedStatePath = cmd('git', ['-C', linkedRoot, 'rev-parse', '--git-path', 'ai-dev-foundation/stagnation/worktree-state-path.json']);
const linkedState = JSON.parse(await readFile(linkedStatePath, 'utf8'));
if (linkedState.workId !== 'worktree-state-path') throw new Error(JSON.stringify(linkedState));

console.log('stagnation-watch selftest: PASS');
