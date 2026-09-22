# claude-job (long-running Claude implementation jobs)

This is the Windows/PowerShell transport for long-running Claude implementation work inside the existing `long-task-wait` skill.
It does **not** create a second Claude security/routing path. Actual model execution is delegated to the Foundation's existing
`preflight-audit/implementation-orchestrator.mjs`, so subscription-only, no-new-cost, repository identity, allowed-scope,
and tool-boundary checks remain authoritative.

| file | role |
|---|---|
| `run-claude-job.ps1` | launch a new/continuation job in a dedicated worktree; under a process manager the call returns control while this same tracked process keeps running |
| `claude-job-runner.ps1` | background runner: existing implementation orchestrator -> local gates -> DONE |
| `check-claude-job.ps1` | read-only status view; 60-minute warning is not an auto-kill |

## State

`STARTING -> RUNNING -> GATES_RUNNING -> READY_FOR_REVIEW | GATE_INCOMPLETE | GATE_FAILED | CLAUDE_FAILED`

Read-only derived views: `LONG_RUNNING` (default 60 minutes, warning only) and `LOST` (the recorded runner process identity no longer matches; PID reuse is not treated as alive).
`DONE` is written only by the outer runner after orchestrator result, scope, and specified test all pass.
Claude's own prose is never a completion gate.

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
```

Continuation does not use Claude session persistence. If the previous attempt left in-scope uncommitted work,
the launcher makes a normal WIP checkpoint commit on the existing job branch before starting the next bounded run.
Any out-of-scope change blocks continuation. No amend/reset/force-push is used.

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
and post-merge verification flow.
