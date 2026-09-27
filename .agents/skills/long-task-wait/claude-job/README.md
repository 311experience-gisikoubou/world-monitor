# claude-job (long-running Claude implementation jobs)

This is the Windows/PowerShell transport for long-running Claude implementation work inside the existing `long-task-wait` skill.
It does **not** create a second Claude security/routing path. Actual model execution is delegated to the Foundation's existing
`preflight-audit/implementation-orchestrator.mjs`, so subscription-only, no-new-cost, repository identity, allowed-scope,
and tool-boundary checks remain authoritative.

| file | role |
|---|---|
| `run-claude-job.ps1` | launch a new/continuation job in a dedicated worktree; under a process manager the call returns control while this same tracked process keeps running |
| `claude-job-runner.ps1` | background runner: existing implementation orchestrator -> local gates -> DONE |
| `check-claude-job.ps1` | read-only status view; 60-minute `LONG_RUNNING` and `NO_PROGRESS_WARNING` are warnings, never an auto-kill |
| `stop-claude-job.ps1` | explicit, fail-closed manual stop for one named `-JobId`; never auto-invoked |

## State

`STARTING -> RUNNING -> GATES_RUNNING -> READY_FOR_REVIEW | GATE_INCOMPLETE | GATE_FAILED | CLAUDE_FAILED`

A job can also end in `STOPPED` only through an explicit, successful `stop-claude-job.ps1` run.

Read-only derived views: `LONG_RUNNING` (default 60 minutes, warning only) and `LOST` (the recorded runner process identity no longer matches; PID reuse is not treated as alive).
`DONE` is written only by the outer runner after orchestrator result, scope, and specified test all pass.
Claude's own prose is never a completion gate.

### NO_PROGRESS_WARNING (read-only, warning/candidate only)

`check-claude-job.ps1` also reports `NO_PROGRESS_WARNING` when the job is active+alive and the newest
last-write timestamp among the job's own evidence files that already exist (`status.json`,
`orchestrator.json`, `stderr.log`, `test.log`, `result.json`, `task.json`) is older than
`-NoProgressMinutes` (default 90, configurable). This is honestly named: lack of file activity does
not prove Claude or the orchestrator is frozen. **Limitation:** the current qualified
`implementation-orchestrator.mjs` buffers the provider's stdout/stderr and returns it only after the
whole call completes, so a genuinely still-working long provider call will show no interim file
activity. `NO_PROGRESS_WARNING` is a candidate for inspection only; it is never an automatic kill
trigger, and `check-claude-job.ps1` never stops or signals any process by itself.

### stop-claude-job.ps1 (explicit manual stop only)

`stop-claude-job.ps1` is a separate, narrowly-scoped safety valve for one explicitly named `-JobId`.
It is not a second Claude execution route and must never be auto-invoked from `check-claude-job.ps1`
or from any `LONG_RUNNING`/`NO_PROGRESS_WARNING` warning.

- The caller supplies only `-RepoPath`/`-JobId`/optional `-Reason`. A PID is never accepted as a
  parameter; the only PID ever acted on is the one already recorded in that job's own `status.json`.
- `-JobId` is validated against a bounded safe-token rule (1-64 chars, first/last character
  alphanumeric, interior limited to letters/digits/`.`/`_`/`-`) before any path is built or any file
  is touched. Path separators, drive/colon syntax, whitespace, and traversal segments all fail closed.
- It fails closed unless the job is currently active (`STARTING`/`RUNNING`/`GATES_RUNNING`) and the
  recorded `runner_pid` + `runner_process_start_utc_ticks` exactly match a live process right now
  (identity is re-verified immediately before acting). An unknown `JobId`, a terminal job, or a PID
  reused by an unrelated process all fail closed with no action taken.
- On confirmed stop (Windows only), it stops the exact recorded runner process tree with
  `taskkill /PID <recorded pid> /T /F` so an orchestrator/provider child of that exact runner cannot
  be orphaned, then marks `status.json` `state=STOPPED` with `stopped_at`/`stop_reason`, and removes
  `.ai-jobs/running.lock` only when the lock's own recorded `job_id`+identity exactly match this same
  job; a lock belonging to a different job/identity is left untouched.
- It never merges, pushes, resets, or deletes branches/worktrees; the worktree/branch are left in
  place for inspection.

## Prerequisites

- `.ai-jobs/` must be in the target repository `.gitignore`.
- Target repository has the current Foundation `preflight-audit/implementation-orchestrator.mjs`.
- New jobs require an explicit `ScopePaths`; patterns are exact repo-relative paths or `directory/**` only.
- A `TestCommand` is required for `READY_FOR_REVIEW`; without one the job remains `GATE_INCOMPLETE`.

## Usage

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run-claude-job.ps1 `
  -RepoPath C:\dev\repo -PromptFile .\task.md -TaskName task `
  -ScopePaths 'src/**','README.md' -TestCommand 'npm test'

powershell -NoProfile -ExecutionPolicy Bypass -File .\check-claude-job.ps1 `
  -RepoPath C:\dev\repo -JobId 20260923-001

powershell -NoProfile -ExecutionPolicy Bypass -File .\run-claude-job.ps1 `
  -RepoPath C:\dev\repo -PromptFile .\remaining.md `
  -ContinueJob 20260923-001 -ClearStaleLock

# Explicit manual stop only; never automated from a warning.
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-claude-job.ps1 `
  -RepoPath C:\dev\repo -JobId 20260923-001 -Reason 'operator requested stop'
```

Continuation does not use Claude session persistence. If the previous attempt left in-scope uncommitted work,
the launcher makes a normal WIP checkpoint commit on the existing job branch before starting the next bounded run.
Any out-of-scope change blocks continuation. No amend/reset/force-push is used.

## Bounded auto-continuation (Issue #215)

Inside one job the runner makes the initial attempt plus at most 2 automatic retries (`-MaxAutoRetries`, default 2,
hard max 2, stored in `status.json`). It retries only an ordinary executed test failure when the
orchestrator_exit, claude_result and scope gates all PASS. It stops (recorded as `retry_stop_code`) on
`HUMAN_GATE_REQUIRED` / `WAITING_AT_VALID_HUMAN_GATE` / `HUMAN_CONFIRMATION_REQUIRED`, scope/no-change failures,
Claude/orchestrator failure, invalid evidence, skipped test, test transport error, a repeated normalized failure
fingerprint, or retry exhaustion. Retry prompts are job-local (`prompt.md` is untouched); per-attempt evidence is
kept in `.ai-jobs/<job>/attempts/attempt-N/`. Policy: `claude-job-retry-policy.ps1`; selftest:
`claude-job-runner-selftest.ps1`. Manual `-ContinueJob` remains available.

## Storage

- job records: `<repo>/.ai-jobs/<yyyyMMdd-NNN>/` (ignored by git)
- worktree: `<repo-parent>/<repo-name>.ai-worktrees/<job-id>/`
- branch: `job/<job-id>-<task>`

Job records include prompt/status/task/orchestrator result/test log/result/DONE as applicable. Do not place patient, clinic,
billing, credential, or other protected real data in prompts or logs.

## Timeout semantics

Remote Desktop Commander starts the launcher as the tracked long-lived process, returns control after initial output, and later uses short status/output reads against the same job. The launcher no longer abandons a detached child process.
`check`'s 60-minute threshold is a warning, not a kill condition. The provider invocation has a separate hard upper bound
(`-ProviderTimeoutMinutes`, default/max 360) to prevent an indefinitely orphaned provider process.

## Verification

Verified on the target Windows machine with Windows PowerShell 5.1 and the real Claude CLI:
- the outer Remote Desktop Commander start call timed out after 10 seconds while the managed job kept running;
- a later read-only check observed the same runner PID alive;
- real job `20260923-007` reached `READY_FOR_REVIEW` with orchestrator, Claude result, scope, and test all PASS.
A previous detached-child prototype became `LOST`; the launcher now keeps the worker inside the tracked process session to remove that failure mode.

## Not performed

These scripts do not merge, push, force-push, reset, delete worktrees/branches/logs, or perform production operations.
After `READY_FOR_REVIEW`, return to the existing Foundation test-gate, staged reality checks, PR, final-pr-audit, merge authorization,
and post-merge verification flow. `stop-claude-job.ps1` is a manual, explicitly-named safety valve only; it is never
auto-invoked by `check-claude-job.ps1`, `LONG_RUNNING`, or `NO_PROGRESS_WARNING`, and it does not add a second Claude
execution route.
