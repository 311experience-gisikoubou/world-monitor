---
name: preflight-audit
description: Use before implementation, fixes, refactoring, UI/backend/design changes, security-sensitive work, external-service use, data handling, installation, real-device work, network changes, or multi-step/long-running AI work. Confirm repository/work-ownership/data/AI/network/persistence boundaries, duplicate-implementation risk, cost, human work burden, non-engineer operation boundaries, lifecycle impact, repeated manual work, progress communication, and whether a genuine human value decision exists. Fail closed on unsafe, unknown, destructive, externally sensitive, unnecessarily complex, improperly delegated, insufficiently communicated, or unreflected repeated-failure paths.
---

# Preflight Audit

## Operating Principle

- Safe read-only work, inspection, testing, auditing, and technical decisions should proceed automatically.
- Confidential-data access, external transmission, destructive/irreversible operations, and `UNKNOWN` real-data paths are stop conditions.
- Technical complexity belongs to the AI workflow. Do not require a non-engineer human to judge Git state, permissions, networking, command output, configuration safety, or implementation details.
- **Technical importance alone is not a human-confirmation reason.** If technical evidence can determine a safe answer inside the approved direction, AI decides and proceeds.
- Human confirmation is only for genuine value/ownership choices: human goals, business policy, recurring cost, responsibility, protected-data policy, or meaningful workflow changes.
- **Simple is Best / simplest-safe:** preserve safety, privacy, data-loss prevention, recovery, auditability, required capability, and the human goal first. Among options meeting that floor, prefer fewer dependencies, services, data routes, configuration points, manual handoffs, recurring steps, and maintenance obligations.
- Do not install/adopt ongoing software or services before lifecycle impact and ownership are clear.
- Repeated manual handoffs, relay work, approvals, or setup are structural automation candidates. Do not solve only the single instance when the pattern is recurring.
- Multi-step or long-running AI work must keep a non-engineer user oriented on current stage, meaning, next step, and whether user action is needed; do not make the user infer progress from technical logs.
- Important rules must be classified as `DECLARATION_ONLY`, `OPERATIONAL`, or `TECHNICAL_ENFORCEMENT_REQUIRED`. Do not claim enforcement that does not exist.

## Existing Solution / OSS Reuse Check

Before substantial custom implementation or adoption of a new dependency/service, determine whether the goal can be met more safely and simply by existing approved mechanisms or maintained reusable software.

- Trigger this check for a non-trivial new capability, custom algorithm/tooling, or new dependency/service where reusable components plausibly exist. A tightly scoped bug fix, tiny low-risk helper, or change fully constrained to an existing implementation may be `NOT_APPLICABLE`; do not perform ceremonial searches that add no decision value.
- Search existing repository/platform capabilities first. Then, when external reusable options plausibly exist, research credible OSS/packages through sources such as GitHub and official package ecosystems using abstract technical requirements only. Never put protected/business/patient data, secrets, private filenames, or proprietary source snippets into search queries.
- When meaningful candidates exist, compare roughly 3-5 credible options. If fewer credible candidates exist, compare the real set rather than padding the list.
- Compare at least: requirements fit; license clarity/compatibility; local/offline execution; external communication/telemetry; security/privacy and supply-chain risk; target OS/Windows support where relevant; maintenance/release health; dependency/build/runtime weight; API/stability fit; and upgrade/recovery/removal burden.
- Prefer an existing approved mechanism or maintained OSS reuse/composition when it satisfies the safety floor and is simpler over its lifecycle than custom code. Implement only the missing portion where practical.
- Do not adopt software merely because it exists or is popular. Unknown/unclear licensing, unsafe or unknown data egress, unsupported target environments, abandoned maintenance, excessive dependency weight, poor recovery/removal characteristics, or unresolved security risk can disqualify a candidate.
- Do not add a large dependency to avoid a small, low-risk implementation. Reuse-first is subordinate to the same Simple-is-Best, safety, privacy, lifecycle, and maintainability floor as custom implementation.
- OSS research is evidence for the technical adoption decision, not adoption authorization. Existing recurring-cost, external-data-route, lifecycle-responsibility, workflow-impact, business-policy, and other human approval boundaries remain unchanged.

Record the result as `REUSE_EXISTING`, `ADOPT_OSS`, `COMPOSE_EXISTING`, `CUSTOM_MINIMAL`, or `NOT_APPLICABLE`, with the decisive reason. This is an `OPERATIONAL` preflight requirement; do not claim that every repository mechanically enforces the external research step unless a separate executable gate proves it.

## AI Route Selection

At job start, and whenever the execution AI or route may materially change, select the execution/review route as a technical preflight decision rather than a fixed historical assignment.

- Enumerate currently available AI, CLI, connector, and execution routes. Any newly installed/connected route whose availability and required permissions can be verified enters the normal candidate set automatically; adding a provider/tool does not require a provider-specific common-rule edit. Installation or connection alone never grants sensitive-data access, production authority, paid-use approval, or merge authority.
- First apply hard constraints: required permissions/tools, execution environment, data/privacy boundary, safety, required quality/capability, context continuity, and independent-review separation.
- Then compare job fit across the AI/routes that remain viable. Typical strengths may inform the choice, but AI names alone do not permanently own categories such as implementation, testing, Git work, code reading, design review, or audit.
- When reliable current signals are available, include usage, remaining quota/capacity, expected processing load/time, and expected incremental cost. Do not invent or infer remaining quota from stale or missing evidence.
- The objective is combined safe development efficiency across available AI capacity, not maximizing utilization of one provider or one model.
- If two routes are materially equivalent in capability, safety, quality, permissions, and context, prefer the route with healthier remaining capacity and lower expected incremental cost. If usage is becoming concentrated and equivalent safe work can move to another AI, rebalance automatically within already-approved boundaries.
- If usage/remaining-capacity evidence is unavailable, do not claim the current allocation is optimal. Use job fit plus known safety/permission/cost facts and record the usage signal as unavailable rather than guessing.
- Never reduce required safety, quality, independent review, data protection, or human approval to save quota or cost. A new recurring charge, subscription, paid tier, or changed cost commitment remains a genuine human value/ownership gate.
- Do not ask a non-engineer user to choose between Codex, Claude, or another available AI when the selection can be resolved technically from the evidence above.

### Machine-readable capacity evidence

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

### Machine-readable bounded task handoff

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

### Machine-readable provider inventory

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

### Machine-readable adapter qualification

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

### Machine-readable adapter readiness

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

Claude subscription-only runner:

```text
<safe-task-json-stream> | node .agents/skills/preflight-audit/claude-subscription-runner.mjs --pretty
```

The task JSON schema is closed to `schemaVersion`, `taskId`, `capability`, `dataClass`, and `prompt`. Only `source-only`, `synthetic`, and `public` payloads are accepted; file paths and provider/config overrides are not part of the schema. Before qualification the runner copies the resolved Claude executable into a fresh isolated temporary directory, verifies that copied executable against the SHA-256 of the exact Claude Code binary that passed the reviewed synthetic safe-route smoke, and uses only that isolated attested copy for capability, auth, and model execution. The original CLI path is never executed after attestation, and only a native Claude descriptor with an empty prefix is accepted, so neither an updater replacing the original path nor injected descriptor-prefix arguments can change the executable/argument boundary in use. Any untrusted copy fails closed to UNQUALIFIED until a new smoke/review attestation updates the trusted hash. The runner returns only allow-listed execution evidence plus the model result and never returns raw stderr/provider diagnostics.

Runner self-test:

```text
node .agents/skills/preflight-audit/claude-subscription-runner-selftest.mjs .agents/skills/preflight-audit/claude-subscription-runner.mjs
```

## Execution / Evidence Location

Before repository checks, identify where the proposed or audited change actually exists.

- **Local-workspace path:** if implementation/testing will use a local checkout, inspect that checkout's root, branch/HEAD, upstream, working tree, untracked files, stash, local/origin relationship, and relevant local-only risks.
- **Remote-only path:** if work will be created directly on a remote feature branch and no local checkout participates, use machine-readable remote evidence for branch/base/head/merge-base/diff/scope and exact-head file contents. Do not require an unrelated local working tree or stash.
- **Mixed path:** if both local and remote environments participate, inspect both and prove they refer to the same intended head before treating them as one change.
- The evidence path does not weaken safety checks. A property that cannot be proven from the actual execution location or an equivalent independent source is `UNKNOWN`/`NEEDS_CHECK`, not PASS.
- Do not turn missing tool access into non-engineer relay work when another machine-readable route exists.

### Live remote base guard

Before a local audit or new worktree uses a remote-tracking base such as `origin/main`, run `node .agents/skills/preflight-audit/live-base-ref-guard.mjs --base <branch> --pretty`. The guard compares the local tracking ref with the live remote branch SHA using read-only Git operations. `PROCEED` means they match; any stale, missing, failed, or ambiguous evidence is `STOP` until AI refreshes the exact remote-tracking ref and reruns the guard. Do not ask a non-engineer user to diagnose or copy Git state.

Guard self-test: `node .agents/skills/preflight-audit/live-base-ref-guard-selftest.mjs .agents/skills/preflight-audit/live-base-ref-guard.mjs`.

## Work Ownership / Duplicate-Implementation Check

Before creating a new feature branch, Issue, PR, or product implementation, confirm the work owner and canonical current-state source.

- Confirm that the requested work belongs to the current repository / common-foundation scope.
- Check available `CURRENT_STATUS.md`, Issue, PR, branch, and specification evidence for the same task already being active in a dedicated application project or another workstream.
- If another dedicated project / repository already owns the same product task, do not create or update a parallel product branch, Issue, PR, or implementation from the current workstream. Use that state only as observation material for cross-project governance when relevant, then continue with the next safe task owned by the current workstream.
- Change work ownership only when explicit transfer, completion, or restart evidence exists. If ownership is unclear and affects scope, mark it `NEEDS_CHECK` / `STOP`; do not ask a non-engineer human to compare Git/PR details that the AI can retrieve.

- Mechanical enforcement lives in the existing Fast/Full change classifier and `project-context-guard`, not a parallel policy engine. Change classification supplies only the **expected** project identity from the already-established active project context plus the intended operation/remote target; the guard independently observes the **actual** repository, committed `PROJECT_CONTEXT.json`, branch, and HEAD from Git. Do not derive the expected identity from the actual observation, because that would erase the boundary being checked.
- A non-read-only operation stops when the independently observed repository/project identity differs from the expected project, or when its target Issue/PR repository differs from the expected repository. A direct `read-only-reference` check may name another repository, but the Fast/Full **change classifier rejects read-only reference as change authority**, so it cannot authorize implementation, REAL_DEVICE, or a write.
- The actual Project Context is read from the committed Git `HEAD:PROJECT_CONTEXT.json`; working-tree identity drift is a STOP. The observation also binds the current branch and HEAD and is freshness-limited. WIP freshness remains the existing `wipReview` gate; merge-time PR/base/HEAD/live-main freshness remains the existing final-PR/merge execution gates rather than being duplicated here.

## Machine Gate

When Node.js and Git are available in the local execution workspace being used for the change, run the dependency-free security gate before semantic checks.

Read-only/source investigation:

```text
node .agents/skills/preflight-audit/security-preflight.mjs --mode audit --data-mode source-only
```

Before implementation/change work:

```text
node .agents/skills/preflight-audit/security-preflight.mjs --mode change --data-mode source-only
```

Before real/confidential-data use:

```text
node .agents/skills/preflight-audit/security-preflight.mjs --mode audit --data-mode real
```

- `PROCEED`: continue automatically.
- `NEEDS_CHECK`: AI resolves using local metadata/code/settings without exposing protected data.
- `STOP`: stop the affected path; do not bypass the gate to continue.
- Machine-gate output uses counts and generic safe metadata. It must not print matched contents or raw filenames/paths because filenames and directory names can themselves contain patient, clinic, customer, or other protected identifiers.
- If raw-path inspection is needed to resolve a finding, keep it local-only and do not send the raw path to an external AI.
- For a genuinely remote-only source change, absence of a local machine-gate run is not itself a reason to involve the human. Perform the equivalent remote repository/data/external-boundary checks below and mark any property that cannot be equivalently proven as unavailable/`UNKNOWN`.

Machine-gate self-test:

```text
node .agents/skills/preflight-audit/security-preflight-selftest.mjs .agents/skills/preflight-audit/security-preflight.mjs
```

## Fast Path / Full Gate Classification

Before invoking the heavy change/audit stack, classify the intended change with `fast-path-classifier.mjs` once the intended touched-file set and impact facts are known:

```text
<change-evidence-json> | node .agents/skills/preflight-audit/fast-path-classifier.mjs --pretty
```

- `FAST_PATH` is allowed only for complete evidence, `routine` / `configuration` / `implementation`, `source-only` / `synthetic` / `public`, local development, every impact flag explicitly `false`, and no sensitive touched path.
- Change-evidence schema v3 requires both `wipReview: { decision, evidenceFetchedAt }` and a closed `projectGuard` envelope. Older schemas are intentionally rejected so Project Guard cannot be silently omitted. The envelope carries expected repository/project identity **plus the established Project Context fingerprint**, optional read-only/Issue/PR target repositories, operation type, and route selection; actual local identity and mutable runtime state are never accepted from this caller input. The expected triplet must also match the active-context authority supplied by the parent workflow through `AI_ACTIVE_TASK_REPOSITORY`, `AI_ACTIVE_PROJECT_CONTEXT_ID`, and `AI_ACTIVE_PROJECT_CONTEXT_FINGERPRINT`; changing all caller envelope fields to match the wrong checkout therefore does not redefine the active project.
- `wipReview.decision` must be `CONTINUE` and `evidenceFetchedAt` must be canonical UTC milliseconds and no more than 5 minutes old. Missing, stale, future-dated, malformed, or `STOP_NEW_WORK` WIP evidence is a hard work-start stop, not a reason to continue through Full Gate.
- Mutable runtime facts are not caller assertions or reusable receipts. A selected committed route declares exact `{ kind, subject, processName, commandContains[] }` requirements in `.agents/known-good-paths.json`, read from the captured Git HEAD. Foundation itself takes a fresh local Windows process snapshot through the absolute system Windows PowerShell path with a fixed read-only query. It derives one `ai-bind-<sha256>` marker from the independently observed repository ID plus Project Context fingerprint and requires exactly one matching marker in the process command line, in addition to the committed process name and route tokens. The marker may live inside any supported application argument such as a logfile/config path; no unknown third-party CLI option is required. No application-provided JavaScript, imported helper, subprocess recipe, network fetch, or runtime-state JSON is executed or trusted. Missing matching live state fails closed; non-Windows environments currently fail closed for runtime-bearing routes. REAL_DEVICE routes must declare at least one live runtime requirement; the existing REAL_DEVICE preparation gate remains authoritative for device-specific confirmation.
- Repo-local route knowledge lives in optional `.agents/known-good-paths.json` and is read from **Git HEAD**, never from an uncommitted working copy. Registry routes are `known-good`, `candidate`, or `known-failed`. An available known-good route has priority; an alternate must be a committed candidate with an explicit closed reason code plus explanation. Any non-null route choice must resolve to a route already recorded in that committed registry; an id absent from the registry cannot authorize work under any selection. This is stronger than waiting for a caller-reported second decision: actual route choices are mechanized from first use, so the 2+ reuse requirement never depends on session memory or a caller counter. A `known-failed` route is blocked by default and may run only with `selection=known-failed-under-test` when that exact route is itself the test subject, using reason code `route-under-test`. When no route applies to the operation type, `selection=not-applicable` with no selected path stays valid and does not accumulate state across repeated classifier runs. REAL_DEVICE fails closed when the registry is absent. Repeated-failure handling is not duplicated in Project Guard: the existing `operation-preflight` / `stagnation-watch` anti-loop remains authoritative, including the two-failure structural-review breakpoint.

Minimal repo-local registry shape (the concrete route IDs/runtime requirements belong to each application repository, not Foundation):

```json
{
  "schemaVersion": 1,
  "routes": [
    { "id": "existing-safe-route", "operationType": "real-device", "status": "known-good", "runtimeRequirements": [{ "kind": "tunnel", "subject": "verified-tunnel", "processName": "cloudflared.exe", "commandContains": ["tunnel"] }] }
  ]
}
```
- Missing, malformed, unknown, or incomplete evidence fails closed to `FULL_GATE`; invalid evidence or unsupported CLI arguments exit non-zero. The only optional CLI flag is `--pretty`.
- Sensitive paths only escalate. Recognized security/auth/credential, database/migration, deployment/workflow, dependency manifest/lockfile, and any Foundation `.agents/skills/` governance path can never create a Fast Path; complete impact evidence remains the primary safety boundary.
- There is deliberately no diff-line threshold. Change size is measured separately and is not used as a proxy for safety.
- `FAST_PATH` retains `security-preflight`, targeted tests, `git diff --check`, and explicit merge authorization if a merge is requested.
- `FAST_PATH` automatically skips only `operation-preflight` that would exist solely because AI work has multiple steps. It may also skip a full selftest suite only when that suite would otherwise run solely because of the generic heavy-flow policy; repository/project-specific full-suite requirements remain mandatory. Historical Git audit, OSS prior-art scan, lifecycle review, independent review, repeated-failure handling, and other checks retain their own existing triggers and are not waived by the classifier.
- The WIP review-queue observer remains the source of the WIP decision, but its fresh result is now required by the change classifier itself before new implementation work. This removes the session-memory bypass without adding persistent STOP state.
- If actual touched files or impact facts expand beyond the classified evidence, re-run the classifier. Do not re-run it at every phase when scope is unchanged.

Classifier self-test:

```text
node .agents/skills/preflight-audit/fast-path-classifier-selftest.mjs .agents/skills/preflight-audit/fast-path-classifier.mjs
```

## Full Gate Selftest Scope

When the classifier returns `FULL_GATE`, reuse the **same change-evidence JSON** with `full-gate-selftest-selector.mjs` before running Foundation selftests:

```text
<change-evidence-json> | node .agents/skills/preflight-audit/full-gate-selftest-selector.mjs --pretty
```

- This does not downgrade Full Gate. It only chooses which Foundation selftests are relevant to the touched governance components. Independent review, lifecycle/value gates, security boundaries, WIP control, diff checking, and merge authorization keep their own triggers.
- `IMPACT_SCOPED` always includes the merge-authorization, merge-execution, Fast Path classifier, security-preflight, and selector selftests, plus the mapped impacted family. The output includes fixed machine-readable `commands` so callers do not reconstruct test invocations.
- Unknown governance paths, selector changes, Fast Path classifier changes, merge-control code/instructions, any `.agents/skills/*/SKILL.md` change, or any declared impact flag set to `true` fail closed to `FULL_SUITE`. Skill instructions are governance code and never self-authorize a narrow suite, even when mixed with otherwise mapped implementation paths. Incomplete evidence also uses the full suite; malformed evidence exits non-zero.
- `CHANGELOG.md` and `VERSION` are neutral only when accompanied by at least one mapped implementation/test path. Metadata-only governance changes do not self-authorize a narrow suite.
- There is no diff-size threshold. Measured runtime is optimization evidence, never a safety classifier.
- On the 2026-09-09 baseline, the 20-test pre-selector suite measured 83.9s. An operation-preflight-only example selected 6 tests and measured 8.4s; these are observations, not promised runtimes.

Selector self-test:

```text
node .agents/skills/preflight-audit/full-gate-selftest-selector-selftest.mjs .agents/skills/preflight-audit/full-gate-selftest-selector.mjs
```

## Cross-Project Portfolio Health Observer

Use `portfolio-health-observer.mjs` when a cross-project view is needed for WIP pressure, stagnation state, and Foundation rollout/currentness.

```text
node .agents/skills/preflight-audit/portfolio-health-observer.mjs --manifest <portfolio-manifest.json>
```

The observer is read-only and does not create a new classifier. Its input contains fresh machine-readable outputs from the existing WIP observer, stagnation watch, and Foundation rollout/sync evidence for each repository. It validates repository identity and snapshot freshness, then aggregates those existing decisions into one report.

- Existing `STOP_NEW_WORK`, stagnation `STOP/BLOCKED/WAIT_HUMAN`, and Foundation `UPDATE/PARTIAL_RESUME/STOP` states are surfaced unchanged.
- Missing or invalid WIP/Foundation evidence is shown as `UNKNOWN`, never silently healthy.
- Merge authority, product priority, and repository-local gates remain separate.
- Do not run application tests or add hosted schedules/services merely to produce the portfolio view.

Self-test: `node .agents/skills/preflight-audit/portfolio-health-observer-selftest.mjs`

## Interactive / AI Work Operation Gate

Before asking a human to perform real-device, network, production, installation, service-adoption, or other interactive setup, run `operation-preflight.mjs`.

For AI-owned `multi-step` or `long-running` work, run `operation-preflight.mjs` when the Fast Path classifier returns `FULL_GATE`, when a human interactive operation is actually required, or when repeated-failure / lifecycle / value-ownership conditions independently trigger the gate. A valid `FAST_PATH` classification explicitly exempts unchanged-scope AI-only work from `operation-preflight`; progress communication still applies, but no machine gate call is required solely because the AI work has multiple steps.

For local Full Gate work with **no human operation**, use `--operation-kind ai-only`. In that mode the gate derives `scope=local-dev`, user minutes/steps `0`, `work-impact=none`, and `scheduled-window=no`; human profile/role/technical-judgment-owner/instruction-mode are non-applicable and must not be supplied. Any conflicting human-operation field or non-local scope fails closed with `AI_ONLY_HUMAN_OPERATION_CONFLICT`. All safety-relevant planning, lifecycle/value decisions, repeated-failure handling, and progress requirements remain unchanged.

Required planning inputs:

- full contiguous human operation time and manual-step estimate;
- alternatives reviewed;
- whether the proposed path is the simplest safe path;
- work impact and safe stopping point;
- human profile/role and technical-judgment owner;
- instruction mode;
- `change-class`;
- `lifecycle-impact yes|no`;
- whether a repeated manual pattern exists;
- `ai-work-structure` as `single-step`, `multi-step`, or `long-running`;
- `progress-update-event` as `none`, `task-start`, `phase-change`, or `user-action-change`;
- `same-class-failure-count` as the number of failed **resolution interventions** already observed in the same-loop candidate before the proposed next action. Read-only investigation, log inspection, comparison, and observation do not increment this count merely because they fail to prove the hypothesis;
- `post-failure-action` as `not-applicable`, `retry-same`, `retry-materially-changed`, `root-cause-analysis`, `hypothesis-reselection`, `route-reselection`, `independent-review`, or `stop`;
- when `post-failure-action=retry-materially-changed`, `material-change-reviewed yes|no`;
- after two same-class resolution-intervention failures, a third resolution intervention also requires `forced-reflection-reviewed yes`, `reflection-recorded yes`, and `reflection-basis` as `new-observation`, `new-hypothesis`, `new-route`, `materially-changed-condition`, or `insufficient-observation`.
- when recovering from an execution timeout, `execution-outcome=timeout`, `timed-out-process-state running|exited|unknown`, `recovery-scope poll-existing|failed-only|split-command|whole-phase|root-cause-analysis|route-reselection`, `completed-evidence-present yes|no`, and `same-command-timeout-count` are required.

### Timeout recovery boundary

Treat a tool/command timeout as an execution-state problem, not permission to blindly restart the whole phase.

- If the timed-out process is still running, inspect/poll that existing process; a duplicate launch is blocked with `TIMEOUT_PROCESS_STILL_RUNNING_POLL_REQUIRED`.
- If process state is unknown, stop the retry and inspect it first (`TIMEOUT_PROCESS_STATE_UNKNOWN_INSPECT_REQUIRED`).
- If the process exited but exact current-work PASS evidence already exists, a whole-phase restart is blocked; resume the missing/failed portion instead (`TIMEOUT_COMPLETED_EVIDENCE_REUSE_REQUIRED`).
- After the same command has timed out twice, another exited-process retry must split the command, perform root-cause analysis, or reselect the route. An unchanged failed-only/whole-phase retry is blocked.
- These rules complement existing exact-evidence reuse and Forced Reflection. They do not convert failed checks into PASS and do not relax repository-local required verification.

Example after a timed-out command is confirmed exited while earlier checks remain valid:

```text
node .agents/skills/preflight-audit/operation-preflight.mjs --operation-kind ai-only --alternatives-reviewed yes --simplest-safe yes --safe-stop yes --change-class implementation --lifecycle-impact no --repeated-manual-pattern no --same-class-failure-count 1 --post-failure-action retry-same --ai-work-structure single-step --progress-update-event none --execution-outcome timeout --timed-out-process-state exited --recovery-scope failed-only --completed-evidence-present yes --same-command-timeout-count 1 --json
```

### GitHub Actions cost / route boundary

Before pushing `.github/workflows/**` changes, or before selecting GitHub-hosted Actions as an execution/verification route, run `github-actions-cost-guard.mjs`. Local edit/commit may prepare the evidence first without consuming hosted minutes; PASS is required before push or hosted execution. This is part of existing preflight route selection, not a second approval system.

- Private-repository hosted minutes are a scarce metered route. Prefer an already-approved local, connector, or self-hosted route when it can produce equivalent evidence with the same safety/quality boundary.
- A temporary/one-shot private-repository hosted workflow is blocked when an equivalent safe local/connector route is available, and fails closed when that route review is unknown.
- At `quota-percent >= 90`, non-required private hosted routes are blocked. A `required-independent` hosted gate may continue only when equivalent safe evidence is unavailable and the exact `--workflow-path` is present both in Git HEAD and the committed `.agents/github-actions-required-gates.json` registry. Working-tree-only registry edits do not authorize the route.
- At exhausted included quota, private hosted use stops unless a separate Human Confirmation Point has explicitly authorized paid overage. This gate records that evidence but never creates cost authorization itself.
- Persistent/required hosted workflows require explicit PASS reviews for trigger duplication, path/filter scope, concurrency/cancel behavior, and matrix/OS/runtime fan-out. A PASS review may document why a broad trigger or no-cancel behavior is required; it is not a demand to weaken a necessary gate.
- When retrying Actions, use failed-job/failed-jobs-only rerun when the available GitHub route supports it. `--failed-only-rerun-available yes` must be backed by current `--rerun-capability-evidence github-api|connector`; otherwise the gate fails closed.
- Treat a verification as a property, not a stage ritual. Use `--verification-phase pre-merge|post-merge-required|deployment` plus `--same-property-already-passed yes|no|unknown` when duplicate-proof evidence is relevant. A reusable `yes` must also carry machine-readable `--prior-pass-evidence-source local-receipt|github-api|connector` and `--prior-pass-head <exact current HEAD>`; missing/stale evidence fails closed. `unknown` fails closed instead of launching another hosted run by habit. Distinct `post-merge-required` or `deployment` properties still run.
- For normal PR verification, prefer one pre-merge hosted run over feature-push plus merged-main duplication. A main/post-merge run is justified only for a distinct deployment/runtime property.
- Public-repository standard hosted usage does not create the same private included-minute pressure, but normal simplicity and duplicate-work reviews still apply.
- Do not remove merge authorization, final-pr-audit, test-gate, security checks, or required Windows/device/platform evidence merely to save minutes.

Example under high quota pressure for an independently required Windows gate:

```text
node .agents/skills/preflight-audit/github-actions-cost-guard.mjs --repo-visibility private --route github-hosted --workflow-mode required-independent --workflow-path .github/workflows/windows-fixture-gate.yml --equivalent-safe-route unavailable --quota-percent 90.1 --trigger-review pass --path-filter-review pass --concurrency-review pass --matrix-review pass --retry-scope none --json
```

Required-independent registry shape (repo-local, committed before hosted execution):

```json
{"schemaVersion":1,"gates":[{"workflowPath":".github/workflows/windows-fixture-gate.yml","status":"required-independent","reason":"Independent clean Windows runner evidence."}]}
```

Gate self-test:

```text
node .agents/skills/preflight-audit/github-actions-cost-guard-selftest.mjs .agents/skills/preflight-audit/github-actions-cost-guard.mjs
```
### Progress communication boundary

For `single-step`, `--progress-update-event none` is allowed when no progress update is needed.

For `multi-step` or `long-running`, `progress-update-event=none` is a fail-closed `STOP`. At each applicable checkpoint, the user-visible update must already have been sent and must contain all four items:

- current stage;
- why the current stage matters / its meaning;
- what happens next;
- whether user action is required, explicitly stating `none`/不要 when no action is needed.

For existing/human-interactive callers, the detailed attestation remains:

- `--progress-update-sent yes`
- `--progress-current-stage-present yes`
- `--progress-meaning-present yes`
- `--progress-next-step-present yes`
- `--progress-user-action-status-present yes`

For `--operation-kind ai-only`, the same already-sent update may instead be attested once with `--progress-update-complete yes`. This compact attestation means all five detailed conditions above are true. It is invalid for human-interactive work, invalid when `progress-update-event=none`, and must not be mixed with detailed progress flags.

Do not substitute speculative future completion-time promises for progress visibility. When exact duration cannot be guaranteed, communicate the work scale and current phase, such as a short check, multi-stage audit, or final verification phase.

For a non-engineer human:

- `--human-profile non-engineer`
- `--human-role operator`, `observer`, or `value-decider`; never `technical-decider`
- `--technical-judgment-owner ai-workflow`, `system`, or a verified `provider`; never `user` or `unknown`
- `--instruction-mode stepwise-ui` by default; use `stepwise-command` only when genuinely necessary and the AI will interpret the output

`stepwise-ui` names the visible screen/button/field and exact action. `stepwise-command` explains how to open the command interface, gives one exact command, and leaves diagnosis to the AI.

### Change-class boundary

Use exactly one `--change-class`:

AI-decided technical classes:

- `routine`
- `configuration`
- `implementation`
- `architecture`
- `install-adoption` when technical evidence shows the adoption is within an already approved direction, has no separate unresolved cost/data/workflow/responsibility choice, and lifecycle ownership is safely managed

Human value/ownership classes:

- `external-data-route`
- `recurring-cost`
- `lifecycle-responsibility`
- `workflow-impact`
- `business-policy`

Classify by the **highest relevant human-impact dimension**, not merely technical shape. A network implementation that changes where protected data travels is `external-data-route`, not `architecture`. An installation that introduces recurring cost is `recurring-cost`; one that changes daily work is `workflow-impact`; one that changes maintenance responsibility is `lifecycle-responsibility`.

For AI-decided technical classes, no human decision is required. If `--human-decision pending` is supplied, the gate stops with `UNNECESSARY_HUMAN_CONFIRMATION`.

For human value/ownership classes:

1. AI resolves technical facts and safety first.
2. AI compares viable options and gives a recommendation with reasons.
3. AI explains practical effects, benefits, downsides, risks, relevant cost, and relevant maintenance burden without assuming engineering knowledge.
4. `--nonengineer-explanation-ready yes` is required.
5. `--human-decision approved` is required before proceeding.

Do not request unrelated information merely because a human decision exists. For example, a `business-policy` decision with no lifecycle impact does not require maintenance-owner fields.

### Lifecycle impact and ownership

Always classify `--lifecycle-impact yes|no`.

Use `yes` when the step creates or changes ongoing software/service/configuration ownership, update requirements, recovery/troubleshooting responsibility, or safe removal/replacement responsibility. `install-adoption` and `lifecycle-responsibility` require `yes`.

When lifecycle impact is `yes`, establish:

- routine maintenance/update owner;
- recovery/troubleshooting owner;
- safe removal/replacement owner;
- expected recurring user maintenance time.

Allowed owners: `system`, `ai-workflow`, `provider`, `user`, `none`, `unknown`.

`user` or `unknown` causes `STOP` when it would make the non-engineer user the technical maintainer. `ai-workflow` is valid only when a real execution path exists; do not use it as a promise of background management. Do not impose an arbitrary universal minute threshold as a substitute for ownership analysis; the actual burden is evidence for simplest-safe and human-impact review.

### Repeated manual pattern

Always classify `--repeated-manual-pattern yes|no`.

If `yes`, the gate requires `--structural-automation-reviewed yes`. This means the AI considered the broader class of similar handoffs/work rather than only the current instance. The review may conclude safe automation is not currently possible, but that conclusion must be technically justified and safety may not be weakened merely to automate.

### Anti-loop / Forced Reflection

Always provide `--same-class-failure-count` and `--post-failure-action`; omission is fail-closed. This section is the executable semantic source in synchronized application repositories. `learnings/L-0004.md` remains the foundation-side rationale/history record and is not a runtime dependency of application repositories.

The threshold is a deliberate **forced-reflection breakpoint**, not a claim that two failures are statistically optimal.

- Count failed **resolution interventions**, not ordinary observation. Reading logs/code/settings, read-only diagnosis, comparison, reproduction for cause isolation, and independent review do not increment the count merely because they do not solve the problem.
- Treat attempts as the same-loop candidate when the cause hypothesis, solution route/principle, or repeated human operation is substantially the same. Command spelling, AI/session, minor flags, or cosmetic path changes do not reset the loop.
- No prior failed resolution intervention: `--same-class-failure-count 0 --post-failure-action not-applicable`.
- After one failed resolution intervention, a second same-method attempt is allowed if otherwise safe: `--same-class-failure-count 1 --post-failure-action retry-same`.
- After two failed resolution interventions, normal retry mode ends. `--post-failure-action retry-same` is a mandatory `STOP` with `LOOP_DETECTED_THIRD_SAME_METHOD_BLOCKED`.
- The reflection phase itself may proceed as `root-cause-analysis`, `hypothesis-reselection`, `route-reselection`, `independent-review`, or `stop`; these are not a third resolution attempt.
- Before any third resolution intervention, first externalize the forced reflection using an existing task-visible evidence channel (current progress report, PR/[AI_HANDOFF] record, or equivalent existing work record). Do not create a new long-lived source file only for this purpose.
- That reflection must state: the two failed interventions and observed results; the current hypothesis status (`否定` / `弱まった` / `未確定`); the new basis (`新しい観測` / `新しい仮説` / `別経路` / `実質的な条件変更`); and the next action.
- A third resolution intervention is represented as `retry-materially-changed` and requires `--material-change-reviewed yes --forced-reflection-reviewed yes --reflection-recorded yes` plus a valid `--reflection-basis`.
- `reflection-basis=insufficient-observation` means the third intervention is not authorized; the gate returns `OBSERVATION_INSUFFICIENT_RETURN_TO_INVESTIGATION` so work returns to observation/root-cause analysis.
- A valid reflection does **not** erase the previous two failures. It only allows one half-open-style attempt under a substantively changed basis. If that attempt fails, do not continue with the same basis; return to observation/reflection again.
- Never use forced reflection as a reason to dump technical judgment onto a non-engineer. Technical escalation order remains observation → root-cause analysis → hypothesis reselection → route reselection → independent review. Human involvement is for genuine value/ownership or real-device subjective decisions, not as a technical escape hatch.

### Stateful Stagnation / Safe Continuation

For multi-step or long-running work, use `stagnation-watch.mjs` as the stateful companion to the failure-count Forced Reflection gate. It prevents an unchanged blocker from remaining in ordinary retry/report mode merely because no one incremented `--same-class-failure-count`, and it prevents a status question from becoming a report-only terminal event when safe work is still incomplete.

Run it at task start and again at meaningful checkpoints, including before answering a status check such as “進んだ？” / “どうなった？” when the work remains incomplete. A periodic monitor may also call it. The default interval is 60 minutes, but the enforcement logic is independent of the scheduler: if several intervals elapsed without a checkpoint, the next invocation accumulates the missed unchanged checkpoints and escalates immediately.

Local checkout state is stored by default under `.git/ai-dev-foundation/stagnation/<work-id>.json`, so chat/session wording changes do not reset it. Remote-only callers can pass the previous `nextState` with `--state-json` and persist the returned `nextState` in an existing task-visible evidence channel such as the tracked Issue/PR state; do not create a separate long-lived business source merely for this runtime state.

The default `--fingerprint-scope product` fingerprints the branch plus the committed product tree and uncommitted product changes while excluding governance-only paths (`.agents/`, `.claude/`, `.github/`, `AGENTS*.md`, `CURRENT_STATUS.md`). A governance-only HEAD change does not count as product progress. Use `--fingerprint-scope all` when the work itself is foundation/governance work. Add stable `--failure-signature`, `--blocker-signature`, `--observation-signature`, and `--route-signature` values when available. A genuinely new observation or route changes the fingerprint; cosmetic wording changes do not.

Escalation is fail-closed:

- first due unchanged checkpoint: `STAGNATION_L1_ROOT_CAUSE_REQUIRED` → ordinary retry/report mode stops; return to root-cause analysis;
- second due unchanged checkpoint: `STAGNATION_L2_FORCED_REFLECTION_REQUIRED` → Forced Reflection is mandatory;
- third or later unchanged checkpoint: `STAGNATION_HARD_STOP_ROUTE_CHANGE_REQUIRED` → the same route remains blocked until a new observation/hypothesis/route/material condition changes the fingerprint;
- `workflow-status=in-progress` does not accumulate stagnation;
- a valid human gate with `--continuation-action wait-human` pauses the checkpoint clock;
- `work-state=incomplete --human-gate none --continuation-action report-only` stops with `SAFE_WORK_CONTINUATION_REQUIRED`;
- `work-state=incomplete --human-gate none --continuation-action wait-human` stops with `UNNECESSARY_HUMAN_WAIT`;
- genuine merge/production/destructive/value/ownership gates still use `human-gate=required` and may wait.
- For an explicit “up to merge handoff” target, use `--completion-target pre-merge` plus `--test-gate-state`, `--commit-state`, `--push-state`, `--pr-state`, `--pr-draft`, `--final-audit-state`, and `--exact-pr-head-state`. `PRE_MERGE_READY_WAITING_MERGE_AUTH` is valid only after all technical stages are complete and `--human-gate-kind merge-authorization` is present.
- Output `handoffClass` separates `AI_OWNED`, `HUMAN_REQUIRED`, `MERGE_AUTH_REQUIRED`, and `COMPLETE`. A technical gate STOP remains `AI_OWNED`; it blocks that unsafe attempt but returns control to diagnosis/repair/route reselection rather than becoming a human handoff.
- `PRE_MERGE_CONTINUATION_REQUIRED` blocks report-only termination before the target is reached. A merge-authorization wait before the technical stages are complete is rejected with `PRE_MERGE_MERGE_GATE_PREMATURE`.
- Immediately before a progress/status response would terminate the current turn, invoke the same gate with `--response-intent terminate`. Termination is allowed only when `terminalState` is `PRE_MERGE_READY`, `HUMAN_CONFIRMATION_REQUIRED`, `COMPLETE`, or safe-route-exhausted `BLOCKED`; `AI_CONTINUES` is rejected with `TERMINAL_RESPONSE_REJECTED_AI_CONTINUES`. A permitted terminate invocation emits fresh `turnCloseReceipt`; `AI_CONTINUES` never receives one.
- If the ChatGPT/tool runtime itself forces a turn boundary while `terminalState=AI_CONTINUES`, use `--response-intent platform-turn-boundary`. The gate persists `continuationCheckpoint` plus `resumeCheckpointReceipt`, returns nonzero `STOP` with `PLATFORM_TURN_BOUNDARY_CHECKPOINT_SAVED`, and keeps `responseMayTerminate=false` and `handoffClass=AI_OWNED`. Resume is accepted only when the checkpoint receipt is valid and the exact branch/HEAD still match; stale HEAD returns `PLATFORM_TURN_BOUNDARY_CHECKPOINT_STALE_HEAD` for state re-evaluation. This path never authorizes a voluntary terminal response; only the platform-forced cutoff can end that turn. This does not claim repository code can remove platform runtime limits.

Example:

```text
node .agents/skills/preflight-audit/stagnation-watch.mjs --target-root . --work-id issue-270 --gate-phase test-gate --work-state incomplete --human-gate none --continuation-action resume --workflow-status failed --pr-state none --failure-signature migration_0001_checksum_is_unchanged --route-signature ui6c-one-shot --interval-minutes 60
```

This gate intentionally does **not** install an always-on hourly GitHub Actions workflow in every repository. A permanent per-repository schedule would add recurring runner usage and maintenance. Existing AI/tool scheduling may invoke this gate when appropriate, while missed intervals are still enforced at the next checkpoint.

Stagnation self-test:

```text
node .agents/skills/preflight-audit/stagnation-watch-selftest.mjs .agents/skills/preflight-audit/stagnation-watch.mjs
```

### Example: routine technical operation

```text
node .agents/skills/preflight-audit/operation-preflight.mjs --scope network --estimated-user-minutes 5 --estimated-user-steps 3 --alternatives-reviewed yes --simplest-safe yes --work-impact low --safe-stop yes --scheduled-window no --human-profile non-engineer --human-role operator --technical-judgment-owner ai-workflow --instruction-mode stepwise-ui --change-class routine --lifecycle-impact no --repeated-manual-pattern no --same-class-failure-count 0 --post-failure-action not-applicable --ai-work-structure single-step --progress-update-event none
```

### Example: third resolution attempt after forced reflection

```text
node .agents/skills/preflight-audit/operation-preflight.mjs --scope interactive --estimated-user-minutes 0 --estimated-user-steps 0 --alternatives-reviewed yes --simplest-safe yes --work-impact none --safe-stop yes --scheduled-window no --human-profile non-engineer --human-role observer --technical-judgment-owner ai-workflow --instruction-mode stepwise-ui --change-class implementation --lifecycle-impact no --repeated-manual-pattern no --same-class-failure-count 2 --post-failure-action retry-materially-changed --material-change-reviewed yes --forced-reflection-reviewed yes --reflection-recorded yes --reflection-basis new-observation --ai-work-structure multi-step --progress-update-event phase-change --progress-update-sent yes --progress-current-stage-present yes --progress-meaning-present yes --progress-next-step-present yes --progress-user-action-status-present yes
```

### Example: multi-step AI work with no human operation

```text
node .agents/skills/preflight-audit/operation-preflight.mjs --operation-kind ai-only --alternatives-reviewed yes --simplest-safe yes --safe-stop yes --change-class implementation --lifecycle-impact no --repeated-manual-pattern no --same-class-failure-count 0 --post-failure-action not-applicable --ai-work-structure multi-step --progress-update-event task-start --progress-update-complete yes
```

### Example: fully managed software/service adoption

```text
node .agents/skills/preflight-audit/operation-preflight.mjs --scope real-device --estimated-user-minutes 5 --estimated-user-steps 3 --alternatives-reviewed yes --simplest-safe yes --work-impact low --safe-stop yes --scheduled-window no --human-profile non-engineer --human-role operator --technical-judgment-owner ai-workflow --instruction-mode stepwise-ui --change-class install-adoption --lifecycle-impact yes --maintenance-plan-reviewed yes --maintenance-owner system --recovery-owner ai-workflow --removal-owner ai-workflow --estimated-user-maintenance-minutes-month 0 --repeated-manual-pattern no --same-class-failure-count 0 --post-failure-action not-applicable --ai-work-structure single-step --progress-update-event none
```

Use `--scheduled-window yes` only for work deliberately scheduled into a work window.

The operation gate fails closed when required inputs are absent or when, among other cases:

- alternatives were not reviewed;
- the chosen path is not the simplest safe option;
- there is no safe stopping point;
- estimated human operation exceeds 10 minutes without a scheduled window;
- estimated manual steps exceed 8 without a scheduled window;
- work impact is medium/high without a scheduled window;
- technical judgment is delegated to a non-engineer;
- expert instructions are proposed for a non-engineer;
- a genuine human value/ownership choice lacks explanation or approval;
- lifecycle impact exists but ownership is missing/unknown or makes the user the technical maintainer;
- install/adoption or lifecycle-responsibility change bypasses lifecycle review;
- a repeated manual pattern has not received structural automation review;
- same-class failure count or post-failure action is missing/invalid;
- two failed resolution interventions already occurred and the proposed next action is the same method again;
- a third resolution intervention is proposed without forced reflection and an externalized reflection record;
- the forced reflection says observation is insufficient but a retry is still proposed;
- a materially changed retry is claimed without reviewing that the change is actually material;
- multi-step/long-running work has no applicable progress update event;
- a required progress update was not actually sent;
- current stage, meaning, next step, or user-action status is missing from the required update;
- routine technical work is needlessly waiting on human confirmation.

Do not split a known long operation into artificial small steps to bypass the gate. Do not describe an installation as simple while ignoring future upkeep. Do not hide a human value choice inside a technical label, and do not turn a technical decision into a human question merely because asking is easier than investigating. Do not classify multi-stage work as `single-step` merely to bypass progress communication. Do not reset, relabel, or cosmetically alter the same-loop candidate merely to bypass forced reflection.

Operation-gate self-test:

```text
node .agents/skills/preflight-audit/operation-preflight-selftest.mjs .agents/skills/preflight-audit/operation-preflight.mjs
```

## Historical Git Audit

For protected/data-like file history, use the content-safe audit. It internally enumerates object paths and sizes but output is restricted to counts and safe aggregate metadata; raw historical filenames/paths and blob contents must not be printed.

Private repository:

```text
node .agents/skills/preflight-audit/security-history-audit.mjs --visibility private
```

Public repository:

```text
node .agents/skills/preflight-audit/security-history-audit.mjs --visibility public
```

- Historical database/backup/capture/credential-like paths are high-risk. In a public repo they are `STOP` until investigated safely.
- Historical CSV/spreadsheet/PDF/image/data-like paths are `NEEDS_CHECK`.
- Historical HTML >=512 KiB is `NEEDS_CHECK`, not proof of leakage.
- Deleted files remain detectable through reachable Git objects/refs.
- Do not open flagged historical content or send raw historical paths to an external AI merely to decide sensitivity.

History-audit self-test:

```text
node .agents/skills/preflight-audit/security-history-audit-selftest.mjs .agents/skills/preflight-audit/security-history-audit.mjs
```

## Machine-readable WIP review queue

Before starting new implementation work, use `.agents/skills/preflight-audit/wip-review-queue-observer.mjs` as a Priority 2 guard against unbounded work-in-progress. It only observes how many pull requests already await human review; it carries no merge authority, holds no GitHub login/token, and enforces no diff-size threshold.

The observer never calls GitHub itself. Use an already-authorized GitHub route (private-repository connector, or the public API for a public repository) to fetch current pull request state, and write it as a temporary sanitized evidence JSON file with `schemaVersion: 1`, `repository`, current `fetchedAt` in exact UTC millisecond form (`YYYY-MM-DDTHH:mm:ss.sssZ`), `retrievalComplete: true`, and a `pullRequests[]` array where each entry gives `number`, `state` (`open`/`closed`), `draft`, `additions`, `deletions`, `changedFiles`, `baseRef`, and `headSha`. Set `retrievalComplete: true` only after the authorized fetch route has confirmed the requested PR result set is complete; missing or false evidence fails closed. Then run:

```text
node .agents/skills/preflight-audit/wip-review-queue-observer.mjs --repo <owner/repo> --evidence-file <temporary-json>
```

- Only open, non-draft pull requests count as pending human review.
- The observer fails closed on incomplete retrieval, stale (>5 minutes old), any future-dated timestamp, malformed, oversized (>64 KiB), or repository-mismatched evidence.
- Failures emit only allow-listed error codes; raw evidence-file paths and arbitrary CLI argument text are not echoed.
- Successful output exposes the validated source evidence timestamp as `evidenceFetchedAt` separately from report-generation `generatedAt`, and lists each pending PR's `number`, `additions`, `deletions`, `changedFiles`, `diffLines` (additions + deletions), `baseRef`, and `headSha`, plus the total pending count and total pending diff lines. Failed validation reports `evidenceFetchedAt: null`; never reuse an unvalidated input timestamp.
- The provisional WIP limit is 2 pending reviews: `pendingReviewCount < 2` reports `CONTINUE`; `pendingReviewCount >= 2` reports `STOP_NEW_WORK`. This is an observation signal, not a merge gate and not a STOP state file.
- Before classifying any new implementation change, copy only a successful observer output's `decision` and validated `evidenceFetchedAt` into change-evidence schema v3 as `wipReview`. The classifier rechecks presence, timestamp format, 5-minute freshness, future timestamps, and `CONTINUE`. Therefore a skipped observer, stale carry-over from an earlier session, or a current WIP stop fails closed before either Fast Path or Full Gate begins.
- Delete the temporary evidence file after recording the observation.

Observer self-test:

```text
node .agents/skills/preflight-audit/wip-review-queue-observer-selftest.mjs .agents/skills/preflight-audit/wip-review-queue-observer.mjs
```

## Required Semantic Checks

### Repository / change safety

Use evidence that belongs to the actual execution path.

- For local-workspace work: check repository root, branch, HEAD/upstream, local and origin main as relevant, working tree/untracked/stash, visibility, `.gitignore`, relevant design/code/tests, expected changed files, migrations, forbidden areas, and specification conflicts.
- For remote-only work: check remote feature branch/base/head SHA, merge-base, canonical compare/PR diff, changed files, visibility, relevant design/code/tests at the exact head, migrations, forbidden areas, and specification conflicts. Local working-tree/stash state is not relevant unless that local checkout participated.
- For mixed work: perform both and prove head alignment.

### Confidential-data boundary

Determine whether work can reach patient/person identifiers, clinic/customer data, orders/work contents, instructions/images/PDFs/exports/production DBs, prices/unit prices/invoices/sales/profit, credentials/tokens/session data, backups/logs/reports/cache/TEMP.

Do not inspect confidential content merely to prove safety. Prefer safe metadata such as counts, extensions, hashes, ACLs, and process/network information. Treat filenames and directory paths as potentially confidential metadata; do not send raw names/paths to an external AI unless they are already confirmed non-sensitive source-code paths required for the development task.

### AI / tool access boundary

Check whether ChatGPT, Codex, Claude/Claude Code, Gemini, local AI, IDE extensions, MCP, plugins, connectors, or agents can technically access protected locations. “The AI will not read it” is not proof. If access is possible and not safely isolated, real-data use is `UNKNOWN` or `STOP`.

### External communication boundary

Check external AI/cloud/GitHub/APIs, telemetry/analytics, update checks, RSS/fetches, package lifecycle scripts, MCP/plugin/connector communication, sync/transfer apps, and unknown destinations. If protected data could reach an external destination and safety is not proven, stop real-data use.

### Local-network boundary

Check bind/listen address, port, authentication, permissions, firewall profile/scope, SMB/share ACLs, and which LAN devices can reach the service. `LAN only` does not automatically mean safe.

### Persistence boundary

Check logs, reports, TEMP/cache, packet captures, state/session/pairing files, exports, backups, and browser storage/cache.

### Human / instruction boundary

Check whether the non-engineer human is being asked to infer safety, diagnose output, choose a protocol, compare technical identifiers, remember hidden configuration, or make a technical decision the AI can resolve. Also check the inverse: whether a genuine human value/ownership choice is being hidden inside a technical decision.

### Lifecycle / maintenance boundary

When lifecycle impact exists, check update, recovery, removal/replacement ownership, recurring user maintenance, where configuration knowledge lives, and whether the claimed AI/system/provider maintainer can actually perform the role.

## Classification

Every relevant safety item must be one of:

- `SAFE_CONFIRMED`
- `NEEDS_CHECK`
- `NEEDS_FIX`
- `UNKNOWN`

Do not say “probably safe”.

## Stop Conditions

Stop when the machine/operation gate says `STOP`, safety is `UNKNOWN` for a real-data path, confidential data may reach an external/unknown destination, destructive or production-impacting work lacks authorization, the relevant execution workspace/scope or work ownership is unsafe or unclear, duplicate product implementation would be created, an unexpected diff/spec conflict exists, extra cost may occur without authorization, the non-engineer is made technical maintainer/technical decider, a genuine human value choice is unapproved, lifecycle ownership is unresolved where lifecycle impact exists, a repeated manual pattern is being handled only as another one-off workaround, `LOOP_DETECTED_THIRD_SAME_METHOD_BLOCKED` is raised after two failed resolution interventions, a third resolution intervention lacks the required forced-reflection evidence, or required progress communication for multi-step/long-running AI work is missing.

## Automatic Proceed Rule

If all applicable checks are `SAFE_CONFIRMED`, the next step is non-destructive and within approved scope, and no genuine human value/ownership choice remains unresolved, proceed automatically. Do not ask for technical confirmation merely because the work is complex.

For interactive/real-device/network/production/installation/service-adoption work, the operation gate must also be `PROCEED` before asking the human to start. For `multi-step` or `long-running` AI work, the operation gate must be `PROCEED` at task start and at each applicable phase/user-action checkpoint before continuing that phase.

## Output

Report plainly:

- 使用スキル
- `PROCEED` / `STOP` / `UNKNOWN`
- execution/evidence source(s): local / remote-only / mixed
- work ownership / duplicate-implementation status
- existing-solution / OSS-reuse check status and decision (REUSE_EXISTING / ADOPT_OSS / COMPOSE_EXISTING / CUSTOM_MINIMAL / NOT_APPLICABLE)
- overall project progress when relevant
- estimated human operation time and manual-step load
- work impact and safe stopping point
- human profile/role, technical-judgment owner, instruction mode
- change class and whether a genuine human decision exists
- lifecycle-impact / lifecycle-ownership status when relevant
- repeated-manual-pattern / structural-automation-review status
- same-class failure count / post-failure action / material-change review status when relevant
- forced-reflection reviewed / reflection-recorded / reflection-basis status when a third resolution intervention is considered
- AI work structure / progress-update event and whether required progress communication is complete
- what proceeds automatically
- what is stopped and why
- current state / expected change scope
- data/external/network findings and risks
- enforcement status for newly established rules
- any genuine human decision that remains

Do not convert technical uncertainty into human homework. If undeterminable, report `UNKNOWN` and stop the affected real-data path.

## Application-Specific Configuration

These checks do not change by application stack. Repository-specific forbidden areas, business Source of Truth, protected data, file layout, and real-device conditions come from that repository's `AGENTS.local.md`.