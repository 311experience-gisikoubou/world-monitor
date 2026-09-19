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