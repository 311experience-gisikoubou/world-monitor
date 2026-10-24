# Preflight Audit — Reference

This file is detailed reference only. It is loaded when the specific mechanism below is relevant; it is not required reading for every task. `SKILL.md` is the mandatory summary/boundaries entry point and links here for the exact CLI/schema/self-test detail of each mechanism. Nothing here weakens, replaces, or stands apart from the mandatory safety, cost, authority, Research Gate, Human Decision, merge-authorization, or fail-closed rules stated in `SKILL.md`; those rules remain conjunctive and authoritative.

## Machine-readable capacity evidence

When `.agents/skills/preflight-audit/ai-capacity-observer.mjs` is present and the local execution environment can safely run Node.js, use it before making a current capacity/quota claim about Codex or Claude:

```text
node .agents/skills/preflight-audit/ai-capacity-observer.mjs --pretty
```

- Treat only provider fields marked `AVAILABLE` as measured capacity evidence. `UNAVAILABLE` means exactly unavailable; do not estimate or backfill it from local activity, elapsed time, subscription labels, or another provider's usage.
- The observer intentionally emits only routing-relevant safe fields. It must not emit account IDs, organization IDs/names, email addresses, credential material, credit identifiers/balances, prompts, protected filenames, or business/patient data.
- A `PARTIAL` capacity comparison is useful evidence but is not proof that the chosen cross-provider allocation is globally optimal. Continue to use job fit, safety, permissions, context, known cost, and independent-review needs for providers whose remaining capacity is unavailable.
- Failure to observe one provider does not make another provider mandatory. Record the missing signal and continue only within the existing safety/cost/quality boundaries.

Observer self-test:

```text
node .agents/skills/preflight-audit/ai-capacity-observer-selftest.mjs .agents/skills/preflight-audit/ai-capacity-observer.mjs
```

## Machine-readable bounded task handoff

Once a route decision is otherwise ready, `.agents/skills/preflight-audit/ai-task-router.mjs` turns the existing AI Route Selection criteria into a deterministic, provider-neutral bounded handoff. It selects routes only; it never invokes a provider or grants authority.

```text
node .agents/skills/preflight-audit/ai-task-router.mjs --input <task-and-routes.json> --pretty
```

Input is JSON with `schemaVersion: 1`, one `task`, and `routes[]`. The task supplies `id`, `kind`, `objective`, required capabilities/permissions, one `executionEnvironment`, `dataClass`, `costPolicy`, `independentReviewRequired`, `forbiddenAuthorities`, allowed/forbidden scope, done conditions, required tests, and return format. Each route supplies `id`, `provider`, availability/environment/capabilities/permissions/data classes, `incrementalCost`, `safetyStatus`, capacity evidence, and optional `jobFitScore`.

- Hard filters run before ranking: route availability must be `AVAILABLE`, safety must be `SAFE_CONFIRMED`, execution environment/capabilities/permissions/data class must fit, unknown incremental cost is rejected, and `EXTRA` is rejected under `no-new-cost`. A route carrying any gated or task-forbidden authority permission is excluded.
- Human-gated task kinds/required permissions, protected/real data, merge, production, destructive operations, recurring-cost adoption, external-data-route changes, lifecycle-responsibility changes, and business-policy decisions return `STOP / HUMAN_GATE_REQUIRED`. The router cannot authorize them.
- Ranking is deterministic: job fit first; included/free cost is preferred over extra when extra cost is allowed; measured remaining capacity participates only when every viable route has measured capacity; if evidence is mixed, capacity is excluded from ranking rather than guessed or treated as 0; final tie-break is route id.
- If independent review is required, reviewer eligibility is evaluated separately from executor eligibility: the route must explicitly advertise the `review` capability and still pass the same availability/safety/environment/data/cost/authority boundaries, and must always have at least one explicit `*-read` permission to inspect the target; executor write permissions are additionally reduced to their corresponding read requirement where one exists. The reviewer must be a different route and a different provider is preferred. If no qualified reviewer exists, result is `NEEDS_REVIEW_ROUTE`, never a false pass.
- Safety-relevant task kinds, permissions, forbidden authorities, data classes, availability/cost/safety/capacity states use closed vocabularies; unknown values and duplicate route IDs fail the whole request closed. Output is allow-listed to route ids/providers and routing evidence. Arbitrary input fields, credentials, account identifiers, protected data, and unrelated prompts/filenames are not echoed.
- The handoff contains only the bounded objective/scope/done conditions/tests/return format, selected executor id/provider, and `authorityLimit: HUMAN_ONLY_FOR_GATED_ACTIONS`.

Router self-test:

```text
node .agents/skills/preflight-audit/ai-task-router-selftest.mjs .agents/skills/preflight-audit/ai-task-router.mjs
```

## Machine-readable implementation route receipt

The router selects a route; it does not itself prove that the selection was honored before or after the work. `.agents/skills/preflight-audit/implementation-route-receipt.mjs` closes that gap for the specific failure this phase targets: routing evidence that only lives in chat and is never actually enforced, including a ChatGPT/browser direct executor quietly doing `implementation`, `bugfix`, `refactor`, or `design-with-source-write` work.

Before starting implementation work, record a pre-implementation routing authorization:

```text
node .agents/skills/preflight-audit/implementation-route-receipt.mjs --input <pre-implementation-receipt.json> --pretty
```

After the work lands, finalize the same binding with the exact 40-character implementation HEAD:

```text
node .agents/skills/preflight-audit/implementation-route-receipt.mjs --input <final-receipt.json> --pretty
```

- The schema is closed to `schemaVersion`, `stage` (`pre-implementation` or `final`), `task.id`/`task.kind`, `executor.id`/`executor.provider`/`executor.routeType`, `repository.owner`/`repository.name`, `branch`, `allowedScope`, `dataClass` (`source-only` / `synthetic` / `public` only), `costPolicy` (`no-new-cost` only), optional `requestedAuthorities`, an optional `exception`, and — at `stage: final` only — the exact 40-character `implementationHead`.
- For `implementation`, `bugfix`, `refactor`, and `design-with-source-write`, an `executor.routeType` of `direct-browser` (a ChatGPT/browser direct executor) is rejected by default with `DIRECT_EXECUTOR_EXCEPTION_REQUIRED`.
- A direct executor is permitted only through a closed exception vocabulary — `HUMAN_EXPLICIT_DIRECT`, `TRIVIAL_SAFE_LOCAL_EDIT`, `NO_QUALIFIED_EXECUTOR_LOWER_RISK_DIRECT` — plus a non-empty bounded `justification` and `evidenceConfirmed: true`. No matching exception means `STOP`, never a silent pass.
- `main`, `master`, and `trunk` branches, protected/real data classes, unknown cost, and `merge` / `production` / `destructive` requested authorities are rejected; malformed repository/branch/scope/head values fail schema-closed.
- This is a **local pre-work gate plus a final-audit-bound receipt**, not a universal enforcement of what happens inside a browser turn. It cannot force a ChatGPT browser session to call this script before it starts typing; it can only make the routing evidence and the final-PR gate below mechanically check the receipt that was (or was not) produced.

Selftest:

```text
node .agents/skills/preflight-audit/implementation-route-receipt-selftest.mjs .agents/skills/preflight-audit/implementation-route-receipt.mjs
```

## Machine-readable provider inventory

Before building a current `prompt-cli` route set, use `.agents/skills/preflight-audit/ai-provider-inventory.mjs` to turn measured local provider facts into router-compatible route records.

```text
node .agents/skills/preflight-audit/ai-provider-inventory.mjs --pretty
```

- The inventory is observation-only: it does not send prompts to a model, execute a real task, or consume provider quota just to prove routing readiness.
- Codex ChatGPT authentication and measured capacity may be recorded, but the current route remains `UNAVAILABLE`: its local-tool/data boundary and exact incremental-cost boundary for a future prompt adapter are not both proven.
- Claude `claude.ai` authentication and an allow-listed subscription label may be recorded, but the route remains `UNAVAILABLE` because the CLI exposes no supported noninteractive signal proving that metered extra usage is disabled for the future invocation path.
- Gemini and Antigravity remain `UNAVAILABLE` until their prompt adapter, cost path, and safety boundary are independently verified. CLI/version presence alone never promotes them.
- If an OpenAI or Anthropic API-key environment is present, only a boolean presence signal is emitted; key values are never read into output and cost remains `UNKNOWN`.
- Codex remaining capacity uses only measured rate-limit windows and fails closed if any reported measured window is malformed or outside 0 to 100. Claude capacity remains `UNAVAILABLE` when no supported signal exists; it is never guessed.
- Generated routes are `prompt-cli`, source-read only, and limited to `source-only`, `synthetic`, and `public` data classes. The inventory never claims repository write, shell/test execution, merge, or production authority.
- Output values are allow-listed/normalized. Version output is reduced to numeric `major.minor.patch`; arbitrary suffixes, executable paths, tokens, email/org identifiers, prompt history, protected filenames, and unapproved reason strings are not emitted.
- The emitted `routes` array conforms to `ai-task-router.mjs`; with the current evidence it is valid for the router to return `NO_EXECUTOR_AVAILABLE`. A later adapter must earn promotion with separate safety and cost evidence.

Inventory self-test:

```text
node .agents/skills/preflight-audit/ai-provider-inventory-selftest.mjs .agents/skills/preflight-audit/ai-provider-inventory.mjs .agents/skills/preflight-audit/ai-task-router.mjs
```

## Machine-readable adapter qualification

After provider inventory and before any real provider invocation, use `.agents/skills/preflight-audit/provider-adapter-qualification.mjs` to decide whether an adapter has earned promotion to an `AVAILABLE` router route.

```text
node .agents/skills/preflight-audit/provider-adapter-qualification.mjs --input <adapter-evidence.json> --pretty
```

- Qualification is provider-neutral and observation-only. It never invokes a model or widens permissions.
- V1 qualifies only `prompt-cli` adapters restricted to explicit safe payloads, no local tools, `source-read`, and `source-only` / `synthetic` / `public` data.
- Authentication, tool boundary, data boundary, incremental-cost boundary, and fallback behavior use closed evidence vocabularies. Unknown values fail schema closed.
- No-new-cost requires included-only or free-only enforcement. `UNKNOWN` and `EXTRA_COST_POSSIBLE` never promote a route.
- Fallback must stop before cost or permission expansion. Protected/real data, merge, production, destructive authority, and permission widening remain outside this gate.
- Capacity may stay `UNAVAILABLE`; it is preserved and never guessed.
- Qualified adapters emit router-compatible `AVAILABLE / SAFE_CONFIRMED` routes. Unqualified adapters emit reason codes but no route.
- Prior-art scan considered OPA/Cedar/JSON-style engines; this bounded deterministic predicate does not justify a new runtime, package, policy language, or service dependency.

Qualification self-test:

```text
node .agents/skills/preflight-audit/provider-adapter-qualification-selftest.mjs .agents/skills/preflight-audit/provider-adapter-qualification.mjs .agents/skills/preflight-audit/ai-task-router.mjs
```

## Machine-readable adapter readiness

Before qualification or provider invocation, use `.agents/skills/preflight-audit/provider-adapter-readiness.mjs` to convert current local CLI/auth/capacity/safety facts into dev.50 qualification evidence.

```text
node .agents/skills/preflight-audit/provider-adapter-readiness.mjs --pretty
```

- Readiness is observation-only: provider version/auth/help, redacted Codex doctor state, rate-limit/credit state, and local CLI presence only. It never sends a model prompt or changes billing/account settings.
- Exact credit balances, account IDs, emails, org IDs, tokens, paths from raw diagnostic payloads, and arbitrary provider fields are never emitted. Codex credits are reduced to `NONE / ZERO / POSITIVE / UNLIMITED / UNKNOWN`.
- Codex ChatGPT-only auth, included capacity, credit state, isolation-flag support, and denied-read state are recorded separately; no-local-tool, auto-top-up, and runner guarantees remain blockers until independently proven.
- Claude `claude.ai` Pro auth can be promoted only through the fail-closed `claude-subscription-runner.mjs`: Anthropic/Claude/AWS/Google/GCLOUD/Vertex/Azure provider or cloud environment variables are rejected case-insensitively before provider invocation; all tools are disabled; MCP is strict-empty; skills/Chrome/session persistence are disabled; input is explicit safe payload over stdin; and noninteractive execution cannot grant a billing/permission expansion.
- Gemini / Antigravity remain blocked until their safe adapters are implemented and qualified.
- The emitted `qualificationInput` is passed directly through dev.50. On the current `ai-dev` evidence, Claude may qualify as `claude-safe-prompt`; Codex, Gemini, and Antigravity remain unqualified. Any missing runner/auth/cost/tool/data evidence returns the route to `UNKNOWN`/unqualified.

Readiness self-test:

```text
node .agents/skills/preflight-audit/provider-adapter-readiness-selftest.mjs .agents/skills/preflight-audit/provider-adapter-readiness.mjs
```

### Claude subscription-only runner

```text
<safe-task-json-stream> | node .agents/skills/preflight-audit/claude-subscription-runner.mjs --pretty
```

The task JSON schema is closed to `schemaVersion`, `taskId`, `capability`, `dataClass`, and `prompt`. Only `source-only`, `synthetic`, and `public` payloads are accepted; file paths and provider/config overrides are not part of the schema. Before qualification the runner copies the resolved Claude executable into a fresh isolated temporary directory, verifies that copied executable against the SHA-256 of the exact Claude Code binary that passed the reviewed synthetic safe-route smoke, and uses only that isolated attested copy for capability, auth, and model execution. The original CLI path is never executed after attestation, and only a native Claude descriptor with an empty prefix is accepted, so neither an updater replacing the original path nor injected descriptor-prefix arguments can change the executable/argument boundary in use. Any untrusted copy fails closed to UNQUALIFIED until a new smoke/review attestation updates the trusted hash. The runner returns only allow-listed execution evidence plus the model result and never returns raw stderr/provider diagnostics.

Runner self-test:

```text
node .agents/skills/preflight-audit/claude-subscription-runner-selftest.mjs .agents/skills/preflight-audit/claude-subscription-runner.mjs
```

### Claude executable implementation route

```text
<closed-implementation-task-json-stream> | node .agents/skills/preflight-audit/implementation-orchestrator.mjs --pretty
```

For source implementation work, `claude-implementation-write` is the default executor only while its current readiness evidence qualifies it. `implementation-orchestrator.mjs` is the single normal entry point: it builds the bounded Claude route, asks `ai-task-router.mjs` to select it, issues the pre-implementation route authorization, verifies the feature repository/branch and GitHub-shaped `origin` identity, and invokes `implementation-runner.mjs` only when that exact Claude route was selected. Claude unavailable or unqualified is a fail-closed STOP; the orchestrator never silently substitutes ChatGPT direct execution.

The task schema requires a clean feature worktree plus exact repository `{owner,name}`, `repoRoot`, `branch`, and a non-empty `allowedScope`. An optional `forbiddenScope` uses the same exact-path or trailing-`/**` syntax and is stricter than `allowedScope`: use it for reference images, dimensions, tolerances, inspection scripts, fixed fixtures, or any other task input the implementation AI may read but must not alter. Arbitrary wildcard patterns are rejected. The runner independently repeats the repository/branch/origin checks immediately before Claude invocation. Its hard model tool boundary is `Read,Write,Edit,Glob,Grep` only — no `Bash`, git, network tool, permission bypass, merge, push, or production authority. Provider/cloud credential environment variables are rejected before invocation.

After Claude returns, the runner observes the complete changed-path set, including modified, deleted, and new/untracked files. It first rejects any path matching `forbiddenScope` with `FORBIDDEN_SCOPE_VIOLATION`, then rejects every remaining path outside `allowedScope`, and only then generates deterministic change-set evidence (`preHead`, `changeSetSha256`, sorted `changedPaths`). The later final implementation-route receipt recomputes the same change set from the recorded `preHead` to the exact committed implementation HEAD. This proves the committed source result matches the bounded Claude execution without storing source contents in the receipt.

Deterministic surrounding work such as targeted tests, commit, push, Draft PR creation, and final audit stays outside the model process and may be performed by the existing reviewed workflow. That separation does not change the fact that Claude is the source-edit implementation executor. Codex has no write-capable runner in this release and may be used for implementation only after a separate qualification; Gemini/Antigravity remain review/alternative-analysis routes unless separately qualified. ChatGPT direct source implementation is an explicit exception, not the normal route.

`provider-adapter-readiness.mjs` records this route's general auth/tool/cost readiness under `readiness.claudeImplementation`, but its repository boundary stays per-task: general readiness can never certify a specific repository/branch. Browser turn start is not universally interceptable; enforcement is completed at the receiving side because `final-pr-audit` cannot report an in-scope qualified-agent implementation `MERGE READY` without an exact final route receipt.

Self-tests:

```text
node .agents/skills/preflight-audit/implementation-runner-selftest.mjs .agents/skills/preflight-audit/implementation-runner.mjs
node .agents/skills/preflight-audit/implementation-route-receipt-selftest.mjs .agents/skills/preflight-audit/implementation-route-receipt.mjs
node .agents/skills/preflight-audit/implementation-orchestrator-selftest.mjs .agents/skills/preflight-audit/implementation-orchestrator.mjs
```

## Bounded Agent Cycle (trial)

`agent-cycle.mjs` is a thin coordinator over existing mechanisms, not a second agent platform. It reads the current approved goal and next step from Project Working Memory, rejects stale candidates, deterministically selects one eligible bounded task, and then either delegates an `INLINE` source task to the existing `implementation-orchestrator.mjs` or returns a `LONG_TASK_HANDOFF_REQUIRED` packet for the existing Job Runner path.

The cycle runs at most one selected task per invocation. `PLAN` never executes source work. `EXECUTE` never gains push, merge, paid-route, production, or human-decision authority. If an inline task declares `onSuccessNextStep`, the cycle advances only the existing Project Working Memory focus after source execution; failure to update that memory is a STOP rather than a success claim. Final verification remains owned by staged reality / test-gate / final-pr-audit, so a completed cycle explicitly reports that verification is still required.

```text
<closed-agent-cycle-json-stream> | node .agents/skills/preflight-audit/agent-cycle.mjs
node .agents/skills/preflight-audit/agent-cycle-selftest.mjs
```

The v1.1 long-task bridge stays inside this existing surface. `agent-job-bridge.mjs` does not start a second runner: `PREPARE` converts an already-selected `LONG_TASK_HANDOFF_REQUIRED` result into the existing `ai-job` Issue format, using the same poller-safe renderer as Project Intake and prefixing one bounded `AGENT_CYCLE_JOB_V1` continuation comment. It returns Issue title/label/body only; it never calls GitHub, PowerShell, Task Scheduler, Claude, push, PR, or merge itself.

After the existing `ai-job-poller` owns selection/execution, use the existing `local-ai-handoff/work-state-report.mjs` as lifecycle evidence. `agent-job-bridge.mjs RESUME` accepts that current work-state evidence plus the Issue body and exact current focus, then maps only canonical stages: `QUEUED/IMPLEMENTING -> WAIT`, `REVIEW -> WAIT_HUMAN`, technical `FAILED/CONFLICT -> STOP`, human-gated `FAILED -> WAIT_HUMAN`, and `DONE -> ADVANCE_READY` (or `COMPLETED` when no next step was declared). Stale goal/next-step metadata fails closed. `ADVANCE_READY` is permission to call the existing Working Memory update path; the bridge does not create another state store.

```text
<agent-cycle LONG_TASK result> | agent-job-bridge PREPARE
existing approved GitHub Issue-create route -> ai-job
existing ai-job-poller -> implementation / tests / Draft PR
existing work-state-report -> lifecycle evidence
agent-job-bridge RESUME -> WAIT | WAIT_HUMAN | STOP | ADVANCE_READY | COMPLETED
```

Self-test:

```text
node .agents/skills/preflight-audit/agent-job-bridge-selftest.mjs
```

This trial deliberately does not add a daemon, scheduler, second state database, autonomous task invention, GitHub push/PR/merge authority, new provider route, or Scheduled Task / Windows execution-policy mutation. Candidate invention/event triggering remains a later decision only if the existing Issue queue, poller, and observers prove insufficient in real operation.

## Legacy implementation audit (rescue-only, fail-closed)

`.agents/skills/preflight-audit/legacy-implementation-audit.mjs` exists only to rescue-audit implementation work that was genuinely completed **before this file existed**. It is not a second normal route: new work always uses `implementation-orchestrator.mjs` -> `implementation-runner.mjs` -> `implementation-route-receipt.mjs`. This module never produces normal `executionEvidence`, never marks an `implementation-route-receipt` "verified", and never widens or substitutes for the normal path.

```text
node .agents/skills/preflight-audit/legacy-implementation-audit.mjs --input <legacy-audit-input.json> --pretty
```

- Output identity is closed: `schema: "LEGACY_IMPLEMENTATION_AUDIT_V1"`, `result: PROCEED | STOP`, and `evidenceNature: "LEGACY_CORROBORATION_NOT_RUNNER_ATTESTATION"` on every response.
- A hard-coded `LEGACY_ELIGIBILITY_CUTOFF_UTC` (this feature's own introduction time) bounds eligibility. Every audited implementation commit's own committer timestamp must be at or before that cutoff **and** inside the caller-declared `implementationWindow`; a commit after the cutoff is `COMMIT_AFTER_CUTOFF`, never treated as legacy. New work after the cutoff MUST use the normal orchestrator/runner/receipt path instead of this audit.
- `legacyReason` is a closed allowlist (`PRE_RECEIPT_WORK`, `NORMAL_ENTRY_MISSED_BEFORE_ENFORCEMENT`) and `implementationAI` must be exactly `claude-cli`. `main`/`master`/`trunk` branches are rejected.
- Repository/branch/HEAD/base/scope facts are machine-derived, never taken on the caller's word: a real clean Git worktree, exact branch and `expectedHead`, the actual GitHub `origin` owner/name, `baseHead` as a genuine ancestor, and `git diff`/`git rev-list` derived `changedPaths`/commits inside `allowedScope` and outside `forbiddenScope`.
- Claude corroboration comes only from explicit `claudeEvidenceFiles` (bounded size, SHA-256 hashed, optional `expectedEvidenceSha256` tamper check) — never from an automatic scan of arbitrary local history. Each JSONL line must parse; a genuine Claude assistant `tool_use` must edit a changed path; every audited commit must be bound to a Claude `Bash` `git commit` `tool_use` plus a matching `tool_result` containing that exact commit SHA in the same session/cwd/branch. An abbreviated Git ID (hex, >=7 and <40 chars) in the `tool_result` is accepted only when the audited full SHA starts with it AND Git in the audited repository resolves `<token>^{commit}` to exactly that 40-character commit; prefix strings alone are never trusted, and shorter, wrong, ambiguous/unresolvable, non-commit, or other-commit tokens do not bind.
- Evidence is screened for safety: known secret/credential/browser-profile/auth-store paths are rejected, filesystem paths outside the repository must be covered by an explicit `allowedSyntheticEvidenceRoots` entry, and non-loopback network access (anything other than the same GitHub origin or `localhost`/`127.0.0.1`) is rejected. An ambiguous command fails closed rather than being guessed safe.
- `currentHeadVerifications` (`testGate`, `canonicalContract`, `humanDecisionSync`, `finalRealityCheck`) must already be caller-provided `PASS` results at the exact `expectedHead`; this module only binds and echoes their normalized status/head, it does not fabricate them.

Self-test:

```text
node .agents/skills/preflight-audit/legacy-implementation-audit-selftest.mjs .agents/skills/preflight-audit/legacy-implementation-audit.mjs
```

## Machine-readable improvement followup (Issue #280 Phase 1, bounded source-only trial)

`.agents/skills/preflight-audit/improvement-followup.mjs` is a bounded, source-only, non-networked slice of Issue #280. Given already-available sanitized local/synthetic Issue/PR + project metadata (it never calls GitHub, never posts an Issue/PR comment, and never starts a provider/runner itself), it identifies new and unresolved improvement candidates, deduplicates them against caller-supplied known records, and preserves each accepted candidate's evidence/time/owner unchanged.

```text
node .agents/skills/preflight-audit/improvement-followup.mjs --repo <owner/repo> --project-context-id <id> --evidence-file <temporary-json>
```

The evidence JSON (`schemaVersion: 1`) declares one `repository`, one `projectContextId`, one `expectedOwner`, a current UTC-millisecond `fetchedAt`, `retrievalComplete: true`, a `knownRecords` array of already-known candidate ids to exclude as duplicates, and an `items` array (closed shape: `id`, `sourceType` `issue`/`pr_comment`, `number`, `title`, `summary`, `owner`, `projectContextId`, `createdAt`, `updatedAt`, `state`, `labels`, `protectedData`, `claimedCompletion`, `runnerEvidence`).

- Fails closed (whole evidence rejected) on an unsupported schema, repository/project-context mismatch, incomplete/stale/future-dated `fetchedAt`, a malformed item, or a duplicate item id.
- Per item, a schema-valid entry is excluded (not reported as a candidate) rather than failing the whole batch when it is a known duplicate, carries a different `projectContextId` (project drift) or a different `owner` than the declared `expectedOwner`, is flagged `protectedData: true`, has gone stale (its own `updatedAt` far older than the current-candidate staleness window), lacks a qualifying improvement/enhancement label, or is closed without a completion claim. Excluded entries expose only `{ id, code }`, never the title/summary/content of a protected or excluded item.
- A genuinely new, open, labeled, fresh, project/owner-matched item becomes a `NEW` candidate with its `owner`/`createdAt`/`updatedAt`/`summary` preserved verbatim.
- An item whose own text claims the work is executed/completed is never taken at face value: only `runnerEvidence.present === true` with a canonical completed state (`DONE` or `READY_FOR_REVIEW`, reusing the same canonical stage vocabulary as `local-ai-handoff/work-state-report.mjs`) confirms resolution (`CONFIRMED_RESOLVED`, excluded as already done). Absent, unproven, or non-completed runner evidence keeps the item as a `NEEDS_VERIFICATION` candidate instead of silently accepting the issue/PR comment's own completion claim.

This module is wired into the existing `portfolio-health-observer.mjs` aggregator rather than left as a standalone unused helper: a repository entry's optional `improvementFollowup` field is validated/aggregated the same way the existing `wip`/`foundation` fields are (repository-identity bound, `ok`/count-shaped, `UNKNOWN` on invalid evidence). The field is opt-in: a manifest that omits it is unaffected (no added attention/totals), so existing callers are unchanged until they adopt it. Feeding a manifest with a real `improvementFollowup` report increments `totals.improvementFollowupNewCandidates` / `totals.improvementFollowupNeedsVerification` / `totals.improvementFollowupUnknown` and surfaces `IMPROVEMENT_FOLLOWUP_NEW_CANDIDATES` / `IMPROVEMENT_FOLLOWUP_NEEDS_VERIFICATION` / `IMPROVEMENT_FOLLOWUP_UNKNOWN` per-repository attention, exactly like the existing WIP/Foundation fields.

This is Phase 1 of Issue #280 only: identification/deduplication/evidence-preservation from already-sanitized input. Cross-repo Issue creation/comment posting, provider auto-start, a new daemon/scheduler/database, and any live GitHub fetch inside this module are explicitly out of scope and require a separate research/security gate before real activation.

Self-test:

```text
node .agents/skills/preflight-audit/improvement-followup-selftest.mjs
```

### Phase 2: dispatch classification and executable handoff plan (bounded, source-only)

`buildDispatchReport` (same module, `--mode dispatch --dispatch-file <temporary-json>`) is Issue #280 Phase 2. Given a HUMAN-approved active-task identity snapshot (`activeTask`: `projectContextId`, exact source `repository`, `issueNumber`, `branch`, `worktree`, `headSha`, `jobId`, fresh `capturedAt`), a live Project Root/owner snapshot (`projectSnapshot`: `projectContextId`, `projectRootRepository`, `owner`, `ownedRepositories`, fresh `capturedAt`), a caller-supplied fresh/complete existing-Issue list (`existingIssues`: `fetchedAt`, `retrievalComplete: true`, `entries` of `{ number, repository, dedupKey, branch, worktree, headSha }`), and dispatch candidates (each carrying `subjectOwner`/`subjectRepository`/`relatedIssueNumber`/`kind`/`protectedData`/`capturedAt`/cause-and-outcome/path/command/`dedupKey`/`runnerEvidence` fields), it classifies every candidate relative to the active task:

- `IN_SCOPE`: the candidate's `subjectRepository` matches the active task's own repository **and** `relatedIssueNumber` matches the active task's own Issue number.
- `NEW_SCOPE`: the candidate is in the active task's own repository but about a different Issue/feature. Represented as `proposal: { recorded: false, planned: true, note: 'NEW_SCOPE_NO_SOURCE_CHANGE' }` only; never a dispatch plan, never a source change.
- `CROSS_PROJECT`: the candidate's `subjectRepository` differs from the active task's repository but is still a recognized repository (the Project Root repository or a listed owned repository) under the declared `owner`.
- `UNKNOWN`: the candidate's owner/repository is not recognized against the live snapshot, the candidate is flagged `protectedData: true`, or the candidate's own `capturedAt` is stale (same 5-minute freshness window as Phase 1 evidence). Each of these blocks only that one candidate -- never the rest of the batch, and never an external handoff.

A dispatch plan (`APPEND_EXISTING` vs `NEW_ISSUE`, matched by `(targetRepository, dedupKey)` against `existingIssues`) is only built for `CROSS_PROJECT` or relevant `IN_SCOPE` candidates whose `kind === 'technical_bugfix'`; other `IN_SCOPE` candidates (for example a feature idea) stay `dispatchStatus: 'NOT_STARTED'` with no plan, so the safe main task continues unchanged. More than one existing-Issue record sharing the same `(repository, dedupKey)` (for example two worktrees both claiming ownership with different branch/worktree/HEAD identity) is an unresolved conflict: that one candidate fails closed as `dispatchStatus: 'UNKNOWN'` / `EXISTING_ISSUE_DEDUP_CONFLICT` rather than guessing which record is authoritative.

A built plan's `instruction` carries exactly seven parts: (1) `causeEvidence` (verified vs unverified cause/evidence, never both), (2) `desiredOutcome`, (3) `ownerTargetRepoAllowedPaths`, (4) `forbiddenPathsAndAuthority` (fixed no-auto-merge/no-auto-push/no-provider-start wording plus the caller's forbidden paths), (5) `reproductionAndTestCommand`, (6) `auditAndDraftPrOutcome` (independent reviewer audits and opens a Draft PR -- this module never posts/merges), and (7) `executorReceipt` (caller-provided `runnerEvidence` is unverified: claims are retained separately as `claimedRunnerStatus`, the actual `runnerStatus` remains `UNKNOWN` until an independently authenticated job receipt is checked; absent evidence it reports `NOT_STARTED`).

The batch-level `decision` and every item's `dispatchStatus` are restricted to `PLAN_READY` / `NOT_STARTED` / `UNKNOWN` -- never `POSTED`, `RUNNING`, or `DONE` -- because this slice only ever produces a plan: no GitHub Issue/PR comment is posted, and no provider/runner is started. `activeTaskSnapshot` in the report is the validated active task echoed back verbatim; this module never mutates the active task, current branch, current worktree, or current repository files, and classifying a `CROSS_PROJECT` finding never changes any of them.

```text
node .agents/skills/preflight-audit/improvement-followup.mjs --mode dispatch --dispatch-file <temporary-json>
```

Self-test (same file as Phase 1):

```text
node .agents/skills/preflight-audit/improvement-followup-selftest.mjs
```

### Phase 3B — one-call offline handoff preview (Issue #280)

`previewSyntheticHandoff` composes existing Phase 2 classifier, Phase 3A
synthetic action preparation, and Phase 3B metadata-only publication review
without a new routing system. A single source-only invocation accepts
synthetic task/candidate and caller-supplied metadata inventory, applies
owner, source safety, repository, privacy, dedup and freshness checks,
and returns only a **fixed-template, redacted REVIEW_ONLY preview**.

Unlike the individual preparer, the composition never returns the
candidate's free-text body, reproduction command or a postable action.
It always returns `authenticated:false`, `outboundAllowed:false`,
`providerState:NOT_STARTED`, and on failure only a safe STOP code.
No GitHub request, account access, external write, provider start or
permission to merge is implemented.

Synthetic end-to-end cases include no prior Issue, append to the exact
existing Issue, legacy collision, repeated marker, wrong privacy target,
bad owner, protected candidate and stale/incomplete metadata.
Passing these checks does **not** authenticate caller-supplied metadata
or permit automatic cross-project posting. Before a real source route,
the distinct triggered Research/Security Gate, trusted collector and
qualified writer/runner evidence are still required.

### Phase 3B — stable supplied before/after Issue review (Issue #280)

`reviewStableSuppliedGitHubReadback` stays in the **existing**
`improvement-followup-synthetic.mjs` without creating a GitHub client.
It compares two already-supplied Issue GET shapes bracketing comment-page
readback: global Issue ID/node ID, state, update timestamp, comment count,
canonical URL, exact repository/Issue identity and a bounded observation
window. It then calls the existing page-and-marker verifier. A differing
count, state, identity, URL, update timestamp, stale evidence or incomplete
comment page fails closed to UNKNOWN.

GitHub official pagination guidance prefers server-supplied Link headers;
this synthetic comparison does not inspect headers or guarantee atomic
snapshot isolation. Even unchanged GET snapshots can hide intermediate
mutations or fabricated caller data. Success is a **candidate only**:
`authenticated:false`, `markerUniqueConfirmed:false`,
`atomicSnapshotProven:false`, `outboundAllowed:false`,
`providerState:NOT_STARTED`. Never infer real POSTED/RUNNING/DONE.

A bounded real read-only smoke trial used the already connected local
GitHub CLI to GET an existing non-sensitive technical Issue before and
after all its comment pages; the known technical marker matched once
in the supplied snapshot. Only safe counts/status were stored locally
in `.ai-jobs/`; no body content, token or other remote write was stored.

Production trusted collector, stable Link-header pagination,
protected-data review, cross-repo legacy dedup and autonomous writing
still require triggered independent Research/Security Gate and separate
qualified runner. **Do not reuse this offline BYPASS_LIGHT for those.**

### Phase 3B — complete supplied comment-page review (Issue #280)

`reviewSuppliedGitHubCommentPages` extends the **existing**
`improvement-followup-synthetic.mjs` pure no-network review. It
cross-checks already-supplied GET Issue comment count and canonical
Issue identity against sequential 100-item page snapshots (at most
500 comments); validates every comment ID/URL/Issue binding, rejects
duplicate IDs, embedded/repeated or wrong-author markers, missing
pages, stale snapshots, and mismatched total counts. No raw Issue or
comment text appears in the response or stored smoke summary.

Even a syntactically complete page snapshot is **caller-supplied and
not independently authenticated**. `PAGE_MARKER_MATCH_CANDIDATE`
means `READ_ONLY_REVIEW`, `authenticated:false`,
`markerUniqueConfirmed:false`, `outboundAllowed:false`,
`providerState:NOT_STARTED`. A concurrent update, fake page or
unmarked historical Issue can still defeat a claimed real-world
dedup proof. Do not use the candidate to create/comment on an Issue
or start an AI. Real GitHub collector trust and posting require a
**separately triggered independent Research/Security Gate**.

A bounded GET-only live smoke test used an existing authenticated
GitHub CLI session on previously known non-sensitive Issue #251
and source-only comment #6103954867. It structurally matched the
supplied one-page/47-comment snapshot. Its local record is stored
outside the tracked repository, without Issue/comment bodies or
credentials; no API mutation or new transport was performed.

### Phase 3B — offline GitHub GET-shape review (Issue #280)

`matchSuppliedGitHubGetShape` uses only an already-supplied pair of
GitHub Issue and comment GET response objects (no request code, no
credential, no provider launch). It parses canonical host/protocol/path,
checks exact repository, Issue and comment IDs, author and the bounded
handoff marker, and fails closed on mismatch or unexpected extra markers.
No candidate free-text is returned. The result is explicitly
`GH_GET_SHAPE_MATCH_ONLY`, `authenticated:false`,
`markerUniqueConfirmed:false`, `outboundAllowed:false` and
`providerState:NOT_STARTED`, even when all fields match.

An existing authenticated `gh api --method GET` session was used
separately to smoke-test this pure function on a known Foundation
technical Issue #251 and its already-existing source-only comment.
This proves a structural match against that actual response; it does
not make the function a trusted collector. The local smoke receipt
is untracked in `.ai-jobs/`; issue and comment bodies were not saved.

Real autonomous Issue POST, broad duplicate attestation and provider
activation are **still blocked** pending a triggered independent
Research/Security Gate, qualified connector/runner route and complete
legacy-Issue dedup/authorization. This offline change cannot bypass
those requirements or elevate an Issue comment to proof of execution.

### Phase 3B — post-write readback matching (offline only)

`reconcileSyntheticHandoffReadback` extends the **same**
`improvement-followup-synthetic.mjs` with a pure, caller-supplied
readback comparison. It checks exact repository, Issue number, comment ID,
author, marker key, pagination completeness and 5-minute freshness, with
special handling for ACK_UNKNOWN and missing/multiple matches. The synthetic
new-Issue path requires the exact Issue marker key (not just a marker count).

`SYNTHETIC_READBACK_MATCH_CANDIDATE` is **not** real GitHub proof:
the caller can fabricate inputs. Results always remain
`REVIEW_ONLY`, `authenticated:false`, `outboundAllowed:false` and
`providerState:NOT_STARTED`. It never returns POSTED/RUNNING/DONE,
never reads real Issue bodies, and never performs a network call.

Actual GitHub evidence must come from a separately trusted/authenticated
GitHub connection and pass the triggered Research/Security Gate before any
auto-POST implementation or provider handoff is enabled.

### Phase 3B — offline metadata-only publication review (Issue #280)

Use `assessReadOnlyIssuePublication` in the **existing**
`improvement-followup-synthetic.mjs` for a bounded, local metadata review.
It consumes a validated synthetic Phase 3A action plus a fresh, complete,
source/target repository-scoped metadata snapshot, checks exact Issue number,
dedup key, comments completeness, visibility, and refuses ambiguous/stale
records. Legacy/unknown Issues block automatic new-Issue approval; private
source -> public target is STOP. An exact already-posted marker is
`RECORDED_CANDIDATE`, not a provider-running or completion receipt.

On eligible synthetic inputs, the result is `METADATA_REVIEW_ONLY` with
`outboundAllowed:false` and a **fixed-vocabulary preview that never includes
raw titles, cause text, commands or test payloads**. Supplied metadata cannot
authenticate itself, and the function performs no network access or GitHub
POST. Its `REVIEW_ONLY` output is never authority to publish.

**Still blocked:** a real authenticated GitHub write requires its own
triggered Research/Security Gate, privacy-safe exact outbound payload,
target authorization, conservative legacy dedup, single-writer/reconcile
behavior, and actual readback receipts. A separate qualified job receipt
is required for RUNNING or DONE; #251's unqualified writer is not bypassed.

### Phase 3A: synthetic-only Issue-action rehearsal (Issue #280)

The Phase 2 classifier is reused by `improvement-followup-synthetic.mjs`.
`prepareSyntheticIssueAction` revalidates fresh source/owner/Issue evidence and
prepares a bounded `APPEND_EXISTING` or `NEW_ISSUE` mock action only with
`simulationOnly:true` and `dataClass:synthetic`. The complementary
`simulateSyntheticIssueAction` operates on an **in-memory synthetic fixture**;
it never contacts GitHub or writes to disk. Replays do not duplicate simulated
comments/Issues, and an ambiguous ACK returns UNKNOWN without auto-retry.
Results are `SIMULATED_ONLY`, never real `POSTED`/`RUNNING`/`DONE`.

**No real GitHub Issue/comment posting or AI provider launch is implemented.**
These remain Phase 3B tasks requiring triggered Research/Security Gate,
an approved existing connector/CLI route, verified ownership/privacy/permission
and a real E2E receipt. This helper cannot be used as merge/launch authority
or a ChatGPT every-turn hook.

Focused synthetic E2E regression (called by the original selftest):
```text
node .agents/skills/preflight-audit/improvement-followup-synthetic-selftest.mjs
```

## Scope Boundary Gate (Issue #283, part A)

Before an AI creates a new GitHub Issue/PR/comment, or acts on an existing one, classify the request as exactly one of `IN_SCOPE` / `CROSS_PROJECT` / `NEW_SCOPE` / `UNKNOWN` with `.agents/skills/preflight-audit/scope-boundary-gate.mjs`. The gate is pure evaluation: it never calls GitHub, never creates an Issue/PR/comment itself, and never starts a provider/runner. It only turns already-available closed evidence into a classification plus an allow/deny decision for the caller (poller/orchestrator/human-facing packet renderer) to honor.

```text
node .agents/skills/preflight-audit/scope-boundary-gate.mjs --evidence-file <temporary-json> --pretty
```

The evidence (`schemaVersion: 1`) declares `activeProjectContextId`, `activeProjectRootRepository`, `approvedRelatedRepositories`, `requestedAction` (`CREATE_ISSUE`/`CREATE_PR`/`CREATE_ISSUE_COMMENT`/`CREATE_PR_COMMENT`), `requestedTargetRepository`, `approvedTaskScopePaths` (the current task packet's allowed scope, or `null` when not yet established), `requestedChangePaths` (or `null` for a comment action), `explicitHumanScopeApproval`, and `humanApprovalDecisionId` (required exactly when the approval flag is `true`).

- A target repository outside the active Project Root and its explicitly approved related repositories is `CROSS_PROJECT`.
- An approved scope path covers a requested path using the exact same closed ScopePaths syntax already certified by `implementation-runner.mjs` (`validScopePattern`/`pathMatchesScopePattern`), with NO broader match ever granted: a bare path with no trailing `/**` covers ONLY that exact requested path (never its children by prefix), and a path with a literal trailing `/**` covers that directory itself and everything under it at an exact `/` path-segment boundary. A sibling directory that only shares a string prefix (e.g. `.../preflight-audit-other/x` against an approval for `.../preflight-audit/**`) is never mistaken for a covered child.
- A `CREATE_ISSUE`/`CREATE_PR` request whose declared paths are not already covered by the current approved task scope (or whose coverage cannot be verified because either side is `null`) is `NEW_SCOPE`.
- A comment action on an already-approved repository is `IN_SCOPE` by itself; it does not expand code scope.
- Malformed, inconsistent, or unsupported-schema evidence is `UNKNOWN` and always blocks the action.
- `IN_SCOPE` proceeds automatically. `CROSS_PROJECT` and `NEW_SCOPE` block the action (`allowCreate:false`) unless the caller supplies a traceable `explicitHumanScopeApproval:true` plus `humanApprovalDecisionId`, i.e. an already-recorded human confirmation rather than an AI judgment that the expansion is probably fine.

Self-test: `node .agents/skills/preflight-audit/scope-boundary-gate-selftest.mjs`.

## Writer Lease Guard (Issue #283, parts C and D)

For one target Repo+PR (or Repo+Issue+job), `.agents/skills/preflight-audit/writer-lease-guard.mjs` is an **advisory evaluator**, not an atomic enforcer, that scores "at most 1 active writer at a time" across humans and AIs (chat sessions, Claude jobs, other AI runners) from caller-supplied evidence. It never starts, stops, or inspects a process itself; it only evaluates already-collected, caller-supplied evidence, including an existing runner/LocalOps PID-lease record that the caller has already re-verified as live/dead. It never force-pushes, resets, cleans, or merges; it returns a lease decision and an advisory `canMerge` flag for the caller's own merge-authorization path. See the honesty-boundary note below: this module must never be described as "enforcing" single-writer exclusion across real concurrent processes/chat windows until an atomic shared claim primitive and an actual call site both exist; that capability is `COVERAGE_UNKNOWN`/`NOT_IMPLEMENTED` today.

```text
node .agents/skills/preflight-audit/writer-lease-guard.mjs --evidence-file <temporary-json> --pretty
```

The evidence (`schemaVersion: 1`) declares `targetRepository`, `targetPrNumber`/`targetIssueNumber` (at least one non-null), a caller-supplied `nowMs`, a bounded `leaseTtlMs` (up to 24h), a closed `claims[]` array of already-collected writer-lease claims (`writerId`, `writerKind` `AI_JOB`/`HUMAN`/`OTHER_AI`, `claimedAtMs`, `evidenceKind` `PID_LEASE`/`DECLARED_ACTIVE_JOB`/`HUMAN_DECLARED`, and for `PID_LEASE` only: `pid`, `processStartMs`, caller-verified `live`), the `requestedWriterId`/`requestedWriterKind`, `forceOverride`/`explicitHumanOverrideApproved`, and an optional `mergeReadinessEvidence` (`{ testResult, branchMatches }`).

- A claim is never trusted when future-dated. For a `PID_LEASE` claim, the caller-reverified `live` flag alone decides active/inactive -- a still-live process must never lose ownership solely because `claimedAtMs` is older than `leaseTtlMs`. For non-`PID_LEASE` evidence (`DECLARED_ACTIVE_JOB`, `HUMAN_DECLARED`), which carries no independent liveness signal, active/inactive is decided by age within `leaseTtlMs`.
- Exactly one active writer that is not the requester blocks the request (`WRITER_LEASE_HELD_BY_OTHER`) unless `forceOverride` and an explicit `explicitHumanOverrideApproved:true` are both supplied, in which case the lease is replaced (`WRITER_LEASE_OVERRIDE_GRANTED`).
- More than one simultaneously active writer is always a fail-closed `WRITER_RACE_DETECTED`, even if the requester is one of them: this condition must never occur, and this module never resolves it automatically.
- `canMerge` is `true` only when `mergeReadinessEvidence.testResult === 'PASS'` and `branchMatches === true`; `FAIL`, `UNKNOWN`, `COVERAGE_UNKNOWN`, a branch mismatch, or missing evidence all keep `canMerge:false`. This module carries no merge authority itself; it only feeds the existing human merge-authorization path.
- **Honesty boundary, partial opt-in claim coverage:** this `writer-lease-guard.mjs` remains a pure function over caller-supplied claims; two callers passing empty arrays can both receive a positive advisory result. It is NOT an atomic shared lock and has no source-write enforcement. A separate, already-scoped `long-task-wait/claude-job/writer-claim-store.mjs` now uses OS-atomic create and is called by the existing `run-claude-job.ps1` launcher **only when** a nonzero target PR and/or Issue number is explicitly supplied. Such launched jobs acquire an actual local claim before source writes and release only matching owner tokens when the launcher returns. The synthetic Windows PowerShell 5.1 subprocess tests prove same-PR single-winner, independent PR concurrency, stale claim STOP and cleanup. Targetless legacy paths and non-launcher writers, browser tabs, other Windows users/devices and remote GitHub edits remain OUT OF COVERAGE and must not inherit an `ENFORCED` verdict from the successful opt-in test. Keep full-system coverage `COVERAGE_UNKNOWN` until every intended writer entrance is actually qualified and wired.

Self-test: `node .agents/skills/preflight-audit/writer-lease-guard-selftest.mjs`.

This is a bounded Issue #283 slice: the Scope Boundary Gate and Writer Lease Guard are read-only evaluation helpers over caller-supplied evidence. Live GitHub Issue/PR/comment creation, actual PID/process management, LocalOps runner changes, and `.github/workflows/**` changes remain out of scope for this change and continue to go through their existing owning surfaces (`scripts/ai-job-poller/**`, LocalOps, `long-task-wait/claude-job/**`). The actual local claim helper is now connected to the qualified Claude job launcher only for explicitly target-bound runs, with a separate Windows subprocess test. The full cross-platform and targetless-source-write behavior remains `COVERAGE_UNKNOWN`, not universally ENFORCED.
