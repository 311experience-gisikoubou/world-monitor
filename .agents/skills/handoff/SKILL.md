---
name: handoff
description: Use when moving work to a new chat, Claude Code, Codex, another AI, or another session, or when the user asks for handoff, 引き継ぎ, session transfer, context summary, or continuation notes. Also use its turn-start guard when a short implicit continuation cue could resume stale work from another Project Context. Keep the active Project Root authoritative, never the most recently touched repository.
---

# Handoff

Use when the next agent or session needs enough context to continue safely.

## Ordinary-Turn Continuation Alignment

Before interpreting a short continuation-only cue such as `次`, `続けて`, or `進めて`, resolve the active Project Context before selecting the Current Task. Recent repository activity, the last PR discussed, or the most recently touched project never overrides the active Project Root.

When the execution environment independently retains both active and candidate Project Context identity, run the existing guard in turn-start mode:

```text
node .agents/skills/handoff/project-context-guard.mjs --context-file <active-project-root>/PROJECT_CONTEXT.json --state-json <turn-state-json> --turn-start --pretty
```

The turn state is a closed `schemaVersion: 1` object containing exactly `activeProjectContextId`, `activeContextFingerprint`, `candidateProjectContextId`, `candidateContextFingerprint`, and `continuationMode: "IMPLICIT"`. The active identity must match the canonical Project Root manifest. The candidate identity must match the active identity exactly before implicit continuation is allowed.

- Same active/candidate identity returns `TURN_CONTEXT_ALIGNED`.
- Different ID or fingerprint returns `CROSS_PROJECT_CONTINUATION_BLOCKED` and `RESELECT_FROM_ACTIVE_PROJECT`.
- Missing candidate identity fails closed; do not infer it from the latest repository, PR, or task.
- `--turn-start` never authorizes an explicit Project change. A user request that explicitly names another Project/repository proceeds through the normal scope/ownership/context decision path instead of being treated as implicit continuation.
- Browser ChatGPT or another environment that cannot independently retain candidate identity and mechanically invoke the CLI follows the same active-project-first rule operationally, but that protection is `OPERATIONAL`, not `ENFORCED`.

## Canonical Project Context

Every participating repository may carry `PROJECT_CONTEXT.json`, but handoff authority comes only from the Project Root repository's file with `repositoryRole=ROOT`. Related Repo manifests are never accepted as canonical handoff identity. The CLI verifies that the canonical file is named exactly `PROJECT_CONTEXT.json`, is at repository root, and that `thisRepository` matches the exact GitHub `origin`; copied, misdirected, lookalike-host, or Git `url.*.insteadOf`-rewritten origins fail closed without network access; configured and effective origin identities must agree. Configured origin values are read with NUL framing rather than line trimming, so surrounding/internal whitespace, carriage returns, or other malformed bytes are rejected rather than normalized. Repository/configuration-changing Git environment overrides such as `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_CONFIG_*` cause fail-closed before evidence probes; the guard does not silently ignore an active alternate Git configuration.

It fixes (all identity text must be resolved; placeholder-only values such as `UNKNOWN` / `TODO` are rejected):

- `projectContextId` — stable ID shared by the Project Root repo and every Related Repo in the same project.
- `projectName`
- `projectRootRepository`
- `finalObjective`
- `thisRepository`
- `repositoryRole` (`ROOT` or `RELATED`)

Project Root identity changes only by an explicit human project-ownership/goal decision. The guard has no automatic context-transition mode. A canonical `PROJECT_CONTEXT.json` identity change is a separate human-gated project-definition change; recent work volume, current branch, task duration, latest PR, or last-touched repository never changes it.

## Canonical Contract Gate

`PROJECT_CONTEXT.json` also carries the repository's `canonicalContract`. Project identity and mutable specification authority remain separate: changing an approved design/spec version changes the Contract fingerprint, not the stable Project Context fingerprint.

Before implementation authority is selected, run:

```text
node .agents/skills/handoff/canonical-contract-gate.mjs --context-file PROJECT_CONTEXT.json --state-json <contract-work-state-json> --pretty
```

The contract records CURRENT, SUPERSEDED, HISTORICAL, and DRAFT artifacts by stable slot. Exactly one CURRENT artifact may exist per slot. SUPERSEDED artifacts may remain in the repository for history but can never appear in `usedSpecIds` as implementation authority. DESIGN artifacts carry a visual contract identity/version/scope and baseline type. A work state binds the exact repository, contract ID/version, selected target per slot, specs actually used, and Functional Gate result. `CANONICAL_TARGET_MISMATCH`, `SUPERSEDED_SPEC_USED`, missing/ambiguous contracts, cross-repository references, or missing CURRENT source files are STOP.

At ordinary turn-start, `project-context-guard.mjs --turn-start` validates the Contract and its committed CURRENT sources automatically. Normal aligned work continues without a human confirmation. Contract conflicts are technical STOPs for AI-owned correction unless the conflict represents a genuine unresolved human specification decision.

## Approved UI Reference Authority

This rule is dormant unless a human explicitly adopts a UI image as the design baseline. Non-UI projects and projects without an approved image do not need a UI-reference folder.

When the human says an image is the baseline/current design, persist that decision instead of relying on conversation memory:

- `docs/ui-reference/CURRENT.json` is the machine-readable active registry.
- `docs/ui-reference/current/<viewId>.<png|jpg|jpeg|webp>` holds only active approved images.
- `docs/ui-reference/archive/<viewId>/...` preserves replaced approved images as history; archive files are never current authority.
- The matching Canonical Contract artifact must be `kind: DESIGN`, `status: CURRENT`, and `visual.baseline: REFERENCE_IMAGE`. Its `visual.scope` must exactly match the registry view IDs, and its sources must be exactly `CURRENT.json` plus those current images.
- The explicit adoption/replacement is recorded in Human Decision Sync. When a design is replaced, the old canonical artifact becomes `SUPERSEDED`; it may remain for history but cannot drive implementation.

Use `ui-reference-manager.mjs` on a feature branch to adopt a new image. It copies the prior current image to archive, writes the new current image and registry entry, and reports the exact Canonical Contract sources required. It refuses direct adoption on `main`/`master`/`trunk`. The Canonical Contract Gate then validates the committed registry/image/scope/source set at turn-start, preflight, and final audit; stale or ambiguous references STOP.

An approved image means **reproduction, not redesign**. At the switch to an approved reference, provisional/development UI, old UI/screenshots, and AI memory stop being visual authority. The existing implementation may still be read for logic, data flow, and state behavior, but its CSS/layout/color/spacing is not evidence of the intended appearance. If the existing structure conflicts with the approved reference, rebuild the visual structure while preserving approved logic and data behavior; do not force the new design onto an incompatible old layout.

For an approved-reference reproduction task, classify it as `UI_REFERENCE_REPRODUCTION` and run `.agents/skills/test-gate/ui-reference-reproduction-gate.mjs` in `PREFLIGHT` mode before implementation. Preparation must already provide the approved image/version, overlay-verified dimension table, tolerances, inspection script, display conditions, fixed synthetic dummy data, and overlay proof. The implementation AI must not create, infer, fill, or relax those inputs. Feed the preflight receipt's `protectedPaths` directly into the Claude implementation route's `forbiddenScope`; any edit to a protected path is a fail-closed stop.

During EARLY, MILESTONE, and FINAL REALITY, DOM/CSS measurements are the primary PASS/FAIL evidence for position, size, spacing, font, and color. The reproduction gate evaluates those measurements against the prepared table/tolerances and binds a tamper-evident receipt to the exact `stateId`; the same check ID failing three consecutive attempts returns `REPEATED_CHECK_FAILURE`. Screenshot, overlay, and pixel-diff output remain supplemental localization/PR evidence and must not override a numeric FAIL or turn an unverified measurement into PASS. The shared `visual-diff-engine.mjs` may generate that supplemental image evidence under fixed capture conditions. Approved reference images and fixtures committed to Git must use synthetic/non-sensitive content only—never patient, clinic, billing, sales, credential, or other protected real data.

## Human Decision Sync

When `canonicalContract.requiredValidation` includes `human-decision-sync`, `PROJECT_CONTEXT.json.humanDecisionSync` is the tracked project source of truth for explicit human-confirmed mutable decisions. Store only decisions the human actually resolved; brainstorming and AI suggestions remain `PROPOSED`, open choices remain `UNRESOLVED`, accepted authority is `CONFIRMED`, and replaced authority remains visible as `DEPRECATED`.

Run `.agents/skills/handoff/human-decision-sync.mjs` before relying on decision IDs. Only `CONFIRMED` decisions can drive implementation. `DEPRECATED`, `PROPOSED`, or `UNRESOLVED` selection is a STOP. A confirmed decision that names canonical artifact IDs is valid only while those artifacts remain `CURRENT`. `--turn-start` returns the confirmed/deprecated/unresolved/proposed registry together with `currentState` and `nextAction`, so a new chat can recover the authoritative decision state without trusting conversation memory.

Conversation memory, summaries, old chats, and AI inference are supporting evidence only. If a new explicit human decision supersedes the tracked state, synchronize `PROJECT_CONTEXT.json` and deprecate the old decision before continuing implementation. Do not auto-promote every conversation statement into the registry.

## Project-local Working Memory

Human Decision Sync is the only human-decision authority. The sibling `project-working-memory.mjs` is only a Git-excluded local continuity cache for transient Current Goal / Approved Reference / Next Step and artifact recall. It must not maintain a second human-decision registry or override `PROJECT_CONTEXT.json.humanDecisionSync` or the Canonical Contract. A focus may reference a canonical confirmed decision ID, but that ID is validated against Human Decision Sync rather than copied into local authority state.

The live file is `.ai/working/project-memory.json`. The helper binds it to the committed Project Context ID/fingerprint and exact GitHub origin, adds `/.ai/working/` only to the repository-local `.git/info/exclude`, and refuses a tracked or cross-project memory file. Schema v2 contains no local `decisions` array. A valid legacy v1 file is migrated by retaining focus/reference continuity while dropping local decision copies and clearing legacy decision links. Do not place patient, clinic, billing, sales, credential, protected, or other real sensitive data in it.

At task start, resume, or before answering "前のやつ / 前に決めたもの", run `ensure` then `snapshot` when this local route is available. The snapshot surfaces Current Goal, Approved Reference, Next Step, and—only when the current focus names one—the authoritative confirmed Human Decision Sync record.

When the human explicitly adopts, rejects, defers, or changes a value/specification choice, update Human Decision Sync rather than local working memory. AI inference must never be promoted to `EXPLICIT_HUMAN`. References use these evidence classes:

- `VERIFIED`: confirmed by an actual file, UI observation, code observation, or explicit human reference evidence.
- `UNVERIFIED`: existence/name is suggested but the actual artifact has not been confirmed.
- `INFERENCE`: AI inference; never present it as an existing approved artifact.
- `NEWLY_CREATED`: created during the current work; keep the creation reason and do not present it as a recovered past artifact.

For a past-artifact request, run `artifact-recall` before presenting an item as existing. Missing or unverified items return `REPORT_MISSING`. Reproduction is allowed only with an explicit reason and must be disclosed as a new reconstruction; the helper returns the required `NEWLY_CREATED` classification and disclosure text. An approved reference that is missing or no longer available is a STOP for substitution: find the real reference or obtain a human value decision instead of silently replacing it.

Use `human-decision-sync.mjs` before relying on a human-value choice. Technical comparison/verification remains AI-owned; unresolved human-value authority remains blocked by Human Decision Sync. Use `focus-gate` at meaningful checkpoints when the current task risks drifting from the stored Current Goal; any focus `decisionId` must still be present in the canonical confirmed decision set.

This is mechanically `ENFORCED` only where an agent has local repository access and actually invokes the helper. Browser-only environments without that execution hook remain `OPERATIONAL`; do not claim universal browser enforcement.

## Required Machine Gate Before Generation

Create machine-readable state containing:

- `establishedProjectContextId` from the active project context
- `establishedContextFingerprint` from the previously validated active Project Root context
- `currentTaskRepository`
- `declaredHandoffRootRepository`
- `sectionOrder`: exactly `projectRoot`, `currentState`, `relatedWork`, `nextAction`
- optional `relatedRepositories`
- `repositorySafetyFacts`: resolved, non-placeholder `forbiddenScope`, `dataSecurity`, `gitRules`, `realDeviceRequirements`, and `additionalCostCondition`, copied from the relevant repository rules without protected/real data; bare or formatting/punctuation-only unresolved values such as `UNKNOWN`, `UNKNOWN.`, `TODO:`, `UNAVAILABLE`, `要補足`, or placeholder-only text are not accepted; resolved rules may mention those words descriptively

Run the guard before writing prose:

```text
node .agents/skills/handoff/project-context-guard.mjs --context-file PROJECT_CONTEXT.json --state-json <handoff-state-json> --pretty
```

If `currentTaskRepository != projectRootRepository`, the guard automatically classifies it as `RELATED_REPO` and adds it to normalized related repositories. Placeholder/unresolved repository identifiers and surrounding whitespace/control padding are rejected for Project Root, Current Task, and Related Repo fields rather than trimmed into validity.

Stop on any `STOP`, especially:

- `PROJECT_ROOT_TAKEOVER_DETECTED`
- `PROJECT_CONTEXT_TRANSITION_MISMATCH`
- `PROJECT_CONTEXT_ID_MISSING`
- `HANDOFF_SECTION_ORDER_DRIFT`
- missing, duplicate-key, malformed, or contradictory Project Context evidence

These are Context Health failures; Project Root takeover is a severe drift.

## Generate From the Validated Skeleton

Do not hand-author the identity/order frame. Generate it from the guard:

```text
node .agents/skills/handoff/project-context-guard.mjs --context-file PROJECT_CONTEXT.json --state-json <handoff-state-json> --render
```

The rendered output is the complete Project Context envelope. Do not fill, append, reorder, or rewrite it. Detailed status is loaded after envelope validation from canonical repository evidence rather than embedded as free-form handoff prose.

Required first four sections are exactly:

1. **Project Root** — project name, root repository, final objective.
2. **Current State** — overall project position and Current Task.
3. **Related Work** — non-root Current Task and other Related Repos.
4. **Next Action** — next safe action for the project.

The `# Project Handoff` title must be followed directly by `## Project Root`, with blank lines only between them. No additional headings, list items, continuation prose, technical detail, or free-form text may be added to the envelope. Final validation requires byte-for-byte equality with the machine-rendered envelope after CRLF-to-LF normalization.

## Required Final Artifact Validation

Before sending/releasing the handoff, validate the completed Markdown:

```text
node .agents/skills/handoff/project-context-guard.mjs --context-file <project-root>/PROJECT_CONTEXT.json --state-json <active-handoff-state-json> --handoff-file <completed-handoff.md> --pretty
```

Do not release unless the result is `HANDOFF_ARTIFACT_ALIGNED`. The untouched rendered envelope is already the complete artifact; any edit or addition is drift.

The artifact check reuses the independently retained active state, including established fingerprint and repository safety facts. It requires one allow-listed machine header beginning at byte 0 with an explicit following line break, exactly four visible `##` sections, unique reserved identity fields, deterministic machine-rendered continuation markers, exact safety facts, and a visible Related Repo inventory that exactly matches normalized metadata. The handoff uses a restricted Markdown surface: raw HTML, HTML entities, bare carriage returns, leading indentation, blockquotes, inline/reference Markdown links/images, Markdown backslash escapes, fenced code, HTML comments, setext/horizontal-rule syntax, and alternate/formatted representations of reserved identity/safety labels are rejected rather than interpreted. Reserved fields must use the generated `- Label:` form and casing exactly; case variants are rejected. The guard verifies caller-supplied active state and repository safety facts but cannot prove their provenance. Safety facts must also be representable in the restricted handoff syntax; unsupported bracket/angle/backslash, Unicode default-ignorable characters, or control-character constructs, including C1 controls, fail closed before rendering. Values that would introduce a reserved identity/safety label such as `Git rules:` are also rejected before rendering. File and Git evidence are decoded with fatal UTF-8 handling; malformed byte sequences are rejected rather than replaced. Retaining the active state independently and copying the relevant `AGENTS.local.md` rules remain operational requirements. If the platform cannot create the symlink selftest fixture, the test reports SKIP: static rejection code is checked, but behavioral symlink enforcement is not proven on that platform.

## New-Chat / New-Session Consumption

Before a new agent continues the project, validate the inbound handoff against the Project Root repository's canonical `PROJECT_CONTEXT.json` and the independently retained active project state using the same `--handoff-file` command. If established state is unavailable, fail closed instead of deriving a new identity from the destination manifest. A Related Repo manifest cannot authorize or redefine the Project Root.

- A session may work on a Related Repo only after the inbound handoff validates against the Project Root canonical manifest; the Current Task remains `RELATED_REPO`.
- An unrelated repository or different Project Root returns `PROJECT_CONTEXT_TRANSITION_MISMATCH` and must not replace the established project.
- The new-chat opening alignment must repeat: Project Root -> Current State -> Related Work -> Next Action.

## Load Detailed State After Envelope Validation

After the inbound envelope validates, retrieve detailed current state from canonical evidence: `AGENTS.md`, relevant `AGENTS.local.md`, `CURRENT_STATUS.md` when present, current PR/Issue/Git evidence, product specifications, and required gates. Do not duplicate mutable details inside the identity envelope. If canonical evidence needed for safety or scope is missing or contradictory, fail closed.

## General Rules

- Do not guess conversation-only details.
- Mark unknown or unavailable details as `要補足` only when they do not affect Project Root identity or safety. Project Root identity itself fails closed when unknown.
- Separate facts from recommendations.
- A busy repository is not promoted from Related Repo to Project Root.
- Copy the relevant repository-specific safety facts from `AGENTS.local.md` into the handoff itself, especially forbidden areas, data/security boundaries, Git rules, real-device requirements, and additional-cost conditions. Do not merely point to `AGENTS.local.md`, because the receiving session may not have repository access. `PROJECT_CONTEXT.json` is only the machine-readable source for project identity.