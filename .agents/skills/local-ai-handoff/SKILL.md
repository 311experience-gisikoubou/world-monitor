---
name: local-ai-handoff
description: Use when handing off state, audit results, or next instructions between local AI CLIs on the same PC (Claude Code and Codex CLI in V1), so the human does not have to copy and paste between them. Also covers Japanese requests such as Claudeからcodexへ引き継ぎ, ローカルhandoff, codexに渡す, or codexの結果をclaudeへ. Does not apply to the browser-based ChatGPT/GPT, which has no local file access and continues to use the existing [AI_HANDOFF] GitHub PR-comment channel (see OPERATIONS.md); do not invent a new GPT-specific handoff format.
---

# Local AI Handoff (V1: Claude ↔ Codex)

Use this skill to pass state, audit results, and next-step instructions between local AI CLIs running against the same repository checkout, without the human copying and pasting between chat windows.

## Scope (V1)

- **Claude ↔ Codex**: in scope. Both run locally against the same repository and can read/write local files.
- **Gemini / Antigravity**: not wired into the default flow in V1. `antigravity chat --mode agent <prompt>` exists and can read local files, so this skill's file protocol is written to extend to it later, but nothing in V1 invokes it automatically. Do not add Gemini to the live routing without an explicit decision to do so.
- **GPT (browser)**: out of scope for this skill entirely. GPT has no local file access. Continue using the existing `[AI_HANDOFF]` GitHub PR-comment convention (`OPERATIONS.md`) for anything GPT needs to see. Do not create a parallel GPT-specific local format.

## Runtime Layout (per application repository)

The live runtime lives in the application repository being worked on, never in `ai-dev-foundation` itself (`ai-dev-foundation` holds only this skill definition and the adoption template — see `templates/.ai-handoff/README.md.template`).

```
.ai-handoff/
├─ README.md
└─ runtime/
   ├─ outbox/      # newly written messages, not yet delivered to the reader
   ├─ inbox/        # messages delivered and waiting for the addressed AI to read
   └─ processed/    # messages already read and acted upon (kept as an audit trail, not deleted)
```

`.ai-handoff/runtime/` holds working state, not permanent history. Whether an application repository tracks it in git or excludes it via `.gitignore` is that repository's own decision (see "Adoption" below) — this skill does not assume either.

## Message Lifecycle

1. The sending AI writes a message to `runtime/outbox/<ISO8601-UTC>-<from>-to-<to>.md` (for example, `20260817T235900Z-claude-to-codex.md`). The filename's `<from>-to-<to>` makes the direction explicit regardless of which folder the file is later found in.
2. Before the addressed AI is invoked, the file is moved from `outbox/` to `inbox/`. This is a deliberate, visible step (not automatic), so there is always a clear record of what has been handed off versus what is still pending.
3. **Immediately before the addressed AI is invoked**, run `validate-handoff-message.ps1` against the `inbox/` file (see "Automated Guards" below). If it does not exit 0, stop — do not invoke the addressed AI, and report the failure reason to the human.
4. The addressed AI reads from `inbox/`, acts on it, and — when it produces a result the other side needs — writes its own message to `outbox/` (for the return trip) using the same naming convention, including fresh `message_id` and `head_sha` values.
5. Once a message has been read and acted upon, it is moved from `inbox/` to `processed/`. Do not delete processed messages; they are the audit trail for what was handed off and when.

## Message Content

Reuse the `handoff` skill's format and required sections (repository, path, branch, HEAD, upstream, working tree, completed work, recent PR, confirmed specs, unfinished items, next steps, blockers, `要補足` for unknowns) rather than inventing a second content schema. A local-ai-handoff message *is* a `handoff` skill output, written to a file in `runtime/outbox/` instead of pasted into a chat.

Every message additionally requires four fields, each on its own bullet line so `validate-handoff-message.ps1` can parse them:

```
- message_id: `<unique identifier for this message>`
- head_sha: `<repository HEAD SHA at the moment this message was written>`
- repository: `<owner/repo, e.g. 311experience-gisikoubou/digital-work-order>`
- branch: `<the branch checked out at the moment this message was written>`
```

These four fields are local to this file-based protocol; they are unrelated to (and do not need to match the field names of) the `[AI_HANDOFF]` GitHub PR-comment convention, which is a separate channel for GPT. `message_id` only needs to be unique within this repository's `.ai-handoff/runtime/` tree. `repository` must be the canonical `owner/repo` form, matched against the actual repository derived from `git remote get-url origin` (HTTPS or SSH, with or without a trailing `.git`) — not from a folder name, and not the bare repo name alone, since two different owners can have same-named repositories. `branch` and `head_sha` are what "Automated Guards" below compares against the repository's actual state at validation time.

## Automated Guards (V2 / V2.1)

V1 only checked duplicate `message_id` and HEAD SHA drift by hand. `validate-handoff-message.ps1`, bundled in this skill's directory alongside `detect-codex.ps1`, enforces the following mechanically, in this order, stopping at the first failure:

```powershell
& "<this skill's directory>\validate-handoff-message.ps1" -MessagePath "<inbox message path>" -RepoRoot "<repository root>"
if ($LASTEXITCODE -ne 0) {
    # Stop. Do not invoke Codex. Report the failure reason (printed on stderr) to the human.
}
```

1. **Required fields present** (`message_id`, `head_sha`, `repository`, `branch`). Missing any one is itself a validation failure (exit code 3) — it does not fall back to skipping the check.
2. **Repository drift (V2.1)**: the message's `repository` must match the actual repository name at `RepoRoot`, resolved from `git remote get-url origin` (HTTPS or SSH form). A message written for one repository must never be acted on inside a different one — for example, if the same message file were copied or the wrong `-RepoRoot` were passed. Exit code 6 on a mismatch, or if the repository name cannot be determined at all (no `origin` remote, or an unparseable URL).
3. **Branch drift (V2.1)**: the message's `branch` must match the branch currently checked out at `RepoRoot` (`git branch --show-current`). Also fails if `RepoRoot` is in a detached-HEAD state. Exit code 7 on a mismatch.
4. **Duplicate `message_id`**: scans every other file under `runtime/inbox/`, `runtime/outbox/`, and `runtime/processed/` for the same `message_id`. No separate log file to keep in sync — the runtime tree itself is the source of truth. Exit code 4 on a match.
5. **HEAD SHA drift**: compares the message's `head_sha` against the repository's current `git rev-parse HEAD`. Exit code 5 on a mismatch.

If the target/content/risk this message was approved against may no longer hold — a different repository, a different branch, a different commit — this fails closed rather than proceeding. This script only validates; it never invokes Codex, moves files, or decides what to do next. That decision belongs to the orchestrating AI and, per `OPERATIONS.md`'s Human Confirmation Points, to the human when the failure reason itself constitutes one of those points (for example, any of these four drift/duplicate conditions is a change in approved scope).

## Codex Detection (no hardcoded paths, no PATH changes)

Codex CLI's executable lives at a per-build, hash-named path (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`) that changes across installs. Never hardcode a specific hash in instructions, scripts, or documentation. Use the bundled `detect-codex.ps1` in this skill's directory to resolve the current path at run time:

```powershell
$codexPath = & "<this skill's directory>\detect-codex.ps1"
if ($LASTEXITCODE -ne 0) {
    # Codex CLI is not installed on this machine; stop and report, do not guess a fallback path.
}
```

This script only detects and prints a path. It does not modify PATH or any environment variable.

## Invoking Codex Non-Interactively

Codex CLI supports non-interactive execution via `codex exec`, confirmed from `codex.exe exec --help` on this machine:

```powershell
& $codexPath exec -C "<repository root>" -o "<runtime/outbox output file>" "<prompt, e.g. referencing the inbox message path>"
```

- `-C <dir>` sets the working root so Codex operates on the correct repository.
- `-o <file>` writes Codex's final message to a file, which can be placed directly under `runtime/outbox/`.
- Do not add `--dangerously-bypass-approvals-and-sandbox` or `--approve-for-me` as part of this skill's default invocation. Doing so would weaken the human-approval floor in `CORE.md` and `OPERATIONS.md`'s Human Confirmation Points. Leave Codex's approval policy at its configured default unless the human has explicitly requested otherwise for a specific task.

Actually invoking Codex is a repository operation like any other and follows the same `OPERATIONS.md` Human Confirmation Points — this skill documents the command, it does not make invoking another agentic AI process an unattended default action.

## Orchestration (V3)

`run-codex-handoff.ps1`, bundled alongside `detect-codex.ps1` and `validate-handoff-message.ps1`, runs the mechanical middle of the flow above — validate, detect, invoke read-only, save output, check the result — in one command instead of four or five separate ones:

```powershell
& "<this skill's directory>\run-codex-handoff.ps1" -MessagePath "<inbox message path>" -RepoRoot "<repository root>"
```

This does not add any permission or automate any new decision. It automates steps that were already being performed by hand, one at a time:

1. Confirm the message file exists.
2. Run `validate-handoff-message.ps1`. If it does not exit 0, stop here — Codex is never invoked.
3. Run `detect-codex.ps1`. If it does not exit 0, stop here.
4. Invoke `codex exec -C <RepoRoot> -s read-only -o <output file>`, with a prompt that both points Codex at the message and restates the "do not edit / commit / push / PR / merge / branch / destructive operation" constraint every time.
5. Confirm Codex exited 0 and its output file exists.
6. Confirm the output file is non-empty.
7. Report a structured PASS/FAIL result naming exactly which step succeeded or failed.

Two things this script deliberately does **not** do, to keep the existing checkpoints intact:

- It never moves a message between `outbox/`, `inbox/`, or `processed/`. Those transitions stay separate, deliberate, visible steps performed by the operator (see "Message Lifecycle"). It only acts on a message already sitting in `inbox/`.
- It has no parameter to change the sandbox mode or bypass approvals. It always runs `-s read-only`; there is no way to pass `--dangerously-bypass-approvals-and-sandbox` or `--approve-for-me` through this script.

Like `detect-codex.ps1` and `validate-handoff-message.ps1`, this script does not run itself — it is invoked explicitly, for a task the operator has already decided to hand to Codex.

## Safety Constraints

- Do not write secrets, tokens, credentials, personal information, or real data into any `.ai-handoff/` file (`CORE.md`).
- This channel exists to reduce copy-paste friction. It must never become a way to route around `OPERATIONS.md`'s Human Confirmation Points (spec/value judgment, real-device judgment, high-risk or destructive changes, unexpected diff, NG/UNKNOWN, LOOP DETECTED, changed approval scope, merge). A handoff message that would trigger one of those still stops for human confirmation, regardless of which AI produced or received it.

## Adoption (per application repository)

1. Copy `templates/.ai-handoff/README.md.template` into the target repository as `.ai-handoff/README.md`.
2. Create `.ai-handoff/runtime/{outbox,inbox,processed}/` in that repository.
3. Decide, in that repository's `AGENTS.local.md`, whether `.ai-handoff/runtime/` is git-tracked or excluded via `.gitignore`, and record the decision there. This skill does not decide it for the repository.
4. Record the adoption in that repository's `.agents/sync-log.md`, consistent with how other common skills are synced.

## Application-Specific Configuration

Whether `.ai-handoff/runtime/` is tracked in git, and any repository-specific constraints on what may be written to it, are recorded in that application repository's `AGENTS.local.md`. This skill names no specific repository.
