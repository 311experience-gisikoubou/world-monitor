---
name: long-task-wait
description: Use for local long-running tasks and long-running Claude implementation jobs. Prefer asynchronous job launch plus read-only status for Claude work, and bounded local waits for existing stable task IDs, while preserving fail-closed identity, timeout recovery, and no-duplicate-start rules.
---

# Long Task Wait

Use this skill when a local runner starts a long-lived task and later exposes read-only state by stable `taskId`.

## Goal

Reduce AI -> tool -> local process round-trips without adding a daemon, service, queue, scheduler, broker, push channel, or arbitrary command executor.

The default monitoring sequence is:

```text
start -> turn-budget guard -> bounded wait -> guard again -> checkpoint + end turn before budget exhaustion
next turn -> validate checkpoint -> observe the same task/process -> continue without restart -> result
```

Do not use short-interval repeated `status` calls for continuous monitoring. Keep `status` for one-shot inspection, troubleshooting, and debugging. If a runner controls its own status output, it should include a hint that continuous monitoring uses bounded wait.

## Bounded wait contract

Import `bounded-task-wait.mjs` from a task runner and pass the runner's existing read-only status function as `readStatus`. The helper itself must never start or restart tasks and must never accept an arbitrary shell command.

A runner CLI may expose:

```text
wait <taskId> --until ready|completed --timeout-ms <N>
```

The helper polls only inside the local process. It returns when the requested meaningful state is observed, when the task fails, or when its self-timeout expires.

Foundation defaults are deliberately below the currently observed Remote Desktop Commander outer call limit:

- default self-timeout: 6000 ms;
- hard maximum self-timeout: 7000 ms;
- default local poll interval: 1000 ms;
- allowed local poll interval: 250-2000 ms.

If the outer tool limit is later measured lower, the caller must choose a correspondingly lower timeout. Do not raise the helper maximum merely to hide an outer timeout.

## Result shape

Bounded wait returns a versioned stable envelope:

```json
{
  "schemaVersion": 1,
  "taskId": "...",
  "state": "RUNNING|READY|COMPLETED|FAILED",
  "timedOut": false,
  "elapsedMs": 0,
  "pidAlive": true,
  "next": "WAIT_AGAIN|RESULT|INVESTIGATE",
  "status": {}
}
```

A self-timeout is not task failure. A still-live task returns `timedOut:true` with `next:"WAIT_AGAIN"`; before another bounded wait, run the turn-budget guard with the same `turnWaitStartedAtMs`. Never reset that timestamp within the same ChatGPT turn. Never restart the long task merely because a tool call or bounded wait timed out.

`READY` may come from an explicit READY state or from the caller's existing `cdpReady:true` evidence. For REAL_DEVICE/CDP, the caller remains responsible for proving readiness from local `127.0.0.1` `/json`, including the target application page (for example `localhost:1420`) and a `webSocketDebuggerUrl`. A listening port alone is not READY.

## Turn-level wait budget and checkpoint/resume

Long-running monitoring must not depend on one ChatGPT response stream staying alive. At the first long-task wait in a turn, capture one `turnWaitStartedAtMs`. Before every bounded wait, evaluate `turn-wait-budget.mjs` with that same timestamp. The default turn wait budget is 15 seconds with a 3-second checkpoint reserve; the hard budget maximum is 30 seconds.

When the guard returns `CHECKPOINT_AND_END_TURN`, do not issue another status/wait call. Persist the existing `stagnation-watch` `platform-turn-boundary` checkpoint and include `--continuation-task-id`, `--continuation-process-id` when available, `--continuation-stage`, `--continuation-log-pointer` when available, and `--continuation-next-action`. Then end the response. This is an AI-owned transport boundary, not a human approval gate.

On the next turn, resume through `stagnation-watch` with `--response-intent continue`. Validate its receipt and exact branch/HEAD. Use `resumeContinuation` to inspect the same task/process and existing log/evidence. If the task already completed, consume that completion evidence. If it is still running, continue observation under a fresh turn budget. Do not relaunch unless validated task state proves the original process is gone and the task policy explicitly permits restart.

Checkpoint continuation metadata is receipt-bound. Tampering, branch/HEAD drift, malformed state, or an inconsistent process identity must fail closed and trigger state re-evaluation rather than a blind restart.

## Safety invariants

Preserve the runner's existing task ID, PID identity, workspace lock, `ALREADY_RUNNING`, atomic state/receipt writes, and fail-closed state parsing. If a task is not terminal but its validated process identity is gone, report `FAILED`/crashed through the runner's status function; do not silently convert it to timeout or restart it.

If PID reuse is a realistic ambiguity, the runner must bind process identity to existing metadata such as start time before reporting `pidAlive:true`.

State files must continue to use atomic replacement such as temporary-file write followed by rename. The bounded wait helper is read-only and does not own task state persistence.

The helper uses Node built-ins only. Do not add a dependency, external network path, cloud service, external AI transmission, production data access, patient data access, sales data access, elevated privilege, Windows Service, daemon, named pipe, WebSocket, broker, queue, scheduler, or push notification mechanism for this purpose.

## Long-running Claude implementation jobs

For Claude implementation work that can outlive the outer Remote Desktop Commander/tool wait, use the PowerShell transport under `claude-job/` instead of increasing the outer wait or repeatedly polling the raw CLI.

- `run-claude-job.ps1` creates an isolated job worktree/branch and stays as the tracked worker process; a process manager such as Remote Desktop Commander returns control after initial output and later observes that same PID.
- A new job requires AI-prepared `-InstructionClarityFile <clarity.json>`. The launcher rebinds the evidence to the concrete job task ID, runs the existing `preflight-audit/instruction-clarity-gate.mjs`, and stores the validated file with job evidence. Continuations reuse that evidence unless the AI supplies an explicit replacement. Do not ask the human to create this file.
- Model execution remains delegated to the existing `preflight-audit/implementation-orchestrator.mjs`; do not add a second raw-Claude route.
- `check-claude-job.ps1` is read-only. `LONG_RUNNING` is a warning only; it never authorizes an automatic kill.
- `check-claude-job.ps1` also reports `NO_PROGRESS_WARNING`, a read-only candidate signal derived only from the
  newest last-write timestamp among a job's own existing evidence files (`status.json`, `instruction-clarity.json`, `orchestrator.json`,
  `stderr.log`, `test.log`, `result.json`, `task.json`), configurable via `-NoProgressMinutes` (default 90). It is
  honestly named: no file activity does not prove Claude is frozen, because the current qualified
  `implementation-orchestrator.mjs` buffers provider stdout/stderr until the call completes. It is a candidate
  for inspection only, never an automatic kill trigger.
- Job logs live under ignored `.ai-jobs/`. Do not place protected real data, credentials, patient/clinic/billing data, or secrets in prompts/logs.
- One repository has at most one active Claude job. A continuation reuses the same job worktree and checkpoints only already in-scope changes with a normal commit; out-of-scope changes stop continuation.
- `DONE` is created only by the outer runner after the existing orchestrator, scope gate, and the supplied job-local test command pass. Claude prose is never completion evidence.
- `READY_FOR_REVIEW` returns to the normal Foundation staged-reality/test-gate/final-PR flow; it is not merge authorization.
- The provider process has a separate hard timeout ceiling of 360 minutes. The default 60-minute `LONG_RUNNING` threshold remains warning-only.
- `stop-claude-job.ps1` is a separate, explicit, fail-closed manual stop for one named `-JobId`. It never accepts a
  PID from the caller, only acts when the job is active and the recorded runner PID + process-start identity
  exactly match a live process, and is never auto-invoked from `LONG_RUNNING`/`NO_PROGRESS_WARNING` or any timeout.
- Bounded auto-retry: by default a Claude job runs the initial attempt plus at most 2 AI-owned auto retries. A retry happens only for an ordinary test-command failure while orchestrator, Claude result, and scope gates all PASS. Human-gate codes (`HUMAN_GATE_REQUIRED`, `WAITING_AT_VALID_HUMAN_GATE`, `HUMAN_CONFIRMATION_REQUIRED`), scope/Claude/orchestrator failure, test transport error, skipped/incomplete test, missing evidence, and a repeated failure fingerprint stop immediately.
- Before each auto retry (only after the retry decision is retry=true), the runner commits the scope-PASS attempt changes on the same job branch and verifies the worktree is clean, because the orchestrator rejects dirty worktrees. If that fails it stops with `retry_stop_code=RETRY_CHECKPOINT_FAILED` and starts no further attempt. It never resets, force-pushes, merges, or writes main.
- Manual `-ContinueJob` remains available after the final failure. The runner never auto-pushes, opens a PR, merges, or makes a human decision.

See `claude-job/README.md` for the Windows entrypoints.

## Timeout recovery interaction

This skill complements the existing `operation-preflight` timeout recovery boundary. A tool timeout means inspect/reuse the existing task first. Unknown process state fails closed; an observed running task is polled/reused; completed verification evidence is reused; repeated unchanged retries remain blocked by the existing preflight rules.

## Prior-art / implementation choice

Before extending this mechanism, check whether the active local execution tool already offers timeout-bounded process/output waiting. Prefer that existing capability when it satisfies the same safety boundary. Introduce a runner-level bounded wait only when it materially reduces cross-tool polling calls or provides domain readiness such as CDP READY that the generic process waiter cannot observe.

## Verification

Run:

```text
node .agents/skills/long-task-wait/bounded-task-wait-selftest.mjs
node .agents/skills/long-task-wait/claude-job-runtime-selftest.mjs
node .agents/skills/long-task-wait/claude-job-launcher-selftest.mjs
```

`claude-job-runtime-selftest.mjs` exercises `check-claude-job.ps1` (`NO_PROGRESS_WARNING` stays warning-only) and `stop-claude-job.ps1` (fail-closed on wrong JobId/identity; exact synthetic process stop only on confirmed identity match). `claude-job-launcher-selftest.mjs` is an offline regression proving `run-claude-job.ps1` itself rejects FAIL/UNKNOWN/missing/mismatched-continuation-context Research Gate evidence before any branch/worktree/background-job/continuation-checkpoint mutation, using a temporary synthetic git repository and local fixture evidence only. Both are Windows PowerShell 5 only and no-op elsewhere.

Use proportional verification. This helper does not justify application Rust/frontend full suites, repeated REAL_DEVICE runs, GitHub-hosted Actions, or unrelated refactoring by itself.
