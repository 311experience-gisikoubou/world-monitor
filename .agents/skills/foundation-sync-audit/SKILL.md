---
name: foundation-sync-audit
description: Use when synchronizing ai-dev-foundation into an application repository, when claiming that shared rules/skills are current, or when an application behaves as if a recently merged common rule is missing. Compare synchronized source paths mechanically and fail closed on missing or stale shared files.
---

# Foundation Sync Audit

## Purpose

Verify that an application repository is actually using the intended `ai-dev-foundation` shared files before stating that the foundation is synchronized, current, applied, or effective.

This closes three gaps:

- a common rule is merged in the foundation while the copied `.agents/skills/` gate in an application remains older;
- canonical shared files are current but an AI-native entrypoint or configured discovery adapter is missing/stale, so the intended common rules may not reach that AI;
- an already-adopted application requires a foundation version update and repeated manual file copying would otherwise risk overwriting repository-local changes or silently missing added/removed shared files.

A version label, sync log entry, matching `AGENTS.md`, or matching canonical skill body alone is not proof of an effective current sync when a configured native adapter is stale. `sync-log.md` is optional informational history only: a missing or stale log is not itself a synchronization failure, and humans must not be required to edit it to make a repository CURRENT. Exact managed-file/blob identity remains authoritative.

## Mandatory Trigger

Run this audit when any of the following applies:

- after a full or partial foundation synchronization;
- before saying an application repository is fully synchronized/current with the foundation;
- before relying on a newly merged common enforcement rule in an application repository;
- when the application behaves as if a common rule or machine gate that should exist is not active;
- during post-merge verification of a synchronization PR when the source foundation files are available;
- when a sync log and the actual shared-file contents may have drifted;
- when an AI-native skill loader is configured and its wrapper/adapter files may have drifted from the canonical skills;
- before and after updating an already-adopted repository from one exact foundation version to another.

Do not ask a non-engineer human to compare files, versions, SHAs, copied skill contents, or native wrappers when machine-readable local or GitHub evidence is available.

## Canonical Sync Surface

Layered V1 is enabled when the Foundation contains `templates/AGENTS.index.md.template`. Its mechanically compared shared surface is:

- generated `AGENTS.md`;
- `CORE.md` and `OPERATIONS.md`;
- every file under `.agents/skills/`, `roles/`, and `learnings/`;
- the managed native entrypoints `.claude/CLAUDE.md`, `GEMINI.md`, and `.agents/rules/ai-foundation.md`.

A pre-Layered Foundation remains a valid update baseline and uses the legacy `AGENTS.md + .agents/skills/` surface only. This compatibility exists so an already-adopted application can be upgraded safely from the exact old version; it does not weaken the Layered V1 target after adoption.

`AGENTS.local.md`, `PROJECT_COMPLETION.md`, root `CLAUDE.md`, application business specifications, application code, local commands/configuration, secrets, tokens, real data, and other repository-local material are not synchronized. Target-only local content must not be overwritten merely to make Foundation sync pass.

## AI-Native Entrypoint Surface

`CORE.md` remains the single Tier 0 safety source. `entrypoint-renderer.mjs` deterministically renders or verifies the always-on native entry layer instead of maintaining duplicate safety text by hand.

- **Codex:** root `AGENTS.md` is generated from the exact `CORE.md` body plus the small task index in `templates/AGENTS.index.md.template`. The renderer enforces a 16 KiB maximum, leaving material headroom below Codex's 32 KiB project-instruction default.
- **Claude Code:** managed `.claude/CLAUDE.md` imports `../AGENTS.md` and `../AGENTS.local.md`. A repository-owned root `CLAUDE.md` is left untouched; verified Claude Code behavior loads both root and `.claude/CLAUDE.md`.
- **Gemini:** managed `GEMINI.md` imports `./AGENTS.md` and `./AGENTS.local.md`.
- **Antigravity:** managed `.agents/rules/ai-foundation.md` contains Tier 0 text generated from `CORE.md`, then points to `AGENTS.md` / `AGENTS.local.md` for task-specific detail. This uses Antigravity's native always-on `.agents/rules/**/*.md` surface.
- **Claude native skills:** `templates/.claude/skills/<skill>/SKILL.md.template` remains a thin optional discovery wrapper around canonical `.agents/skills/<skill>/SKILL.md`.

Run `entrypoint-renderer.mjs --root <foundation-root> --check` before claiming the source entrypoints current. It fails on generated drift, missing adapters/imports, or AGENTS size overflow.

For Claude native skill wrappers, the audit still verifies that each canonical skill has a matching wrapper template with the same `name` / `description` and canonical reference. If the target already uses Claude native skills — detected by root `CLAUDE.md` or `.claude/skills/` — wrappers are compared byte-for-byte; repository-local Claude skills may coexist as target-only extras.

## Machine Gate

When the source foundation checkout and target application checkout are both available locally, run:

```text
node .agents/skills/foundation-sync-audit/foundation-sync-audit.mjs --source-root <foundation-root> --target-root <application-root>
```

The gate is dependency-free and reads only development-control files: the canonical sync surface, the foundation `VERSION`, and the Claude wrapper template/target adapter surface when applicable.

Results include:

- `PASS / FOUNDATION_SYNC_MATCH`: canonical shared files match and every configured adapter checked by the gate is current.
- `STOP / FOUNDATION_SYNC_MISSING`: one or more canonical source shared files are absent from the target.
- `STOP / FOUNDATION_SYNC_STALE`: one or more canonical target shared files differ from the source.
- `STOP / FOUNDATION_SOURCE_CLAUDE_WRAPPER_MISSING`: a canonical skill has no source Claude wrapper template.
- `STOP / FOUNDATION_SOURCE_CLAUDE_WRAPPER_DRIFT`: source wrapper metadata/reference does not match its canonical skill, or an orphan wrapper exists.
- `STOP / FOUNDATION_CLAUDE_ADAPTER_MISSING`: Claude integration is configured in the target but one or more required wrappers are absent.
- `STOP / FOUNDATION_CLAUDE_ADAPTER_STALE`: a configured target Claude wrapper differs from the foundation template.
- `INFO / FOUNDATION_TARGET_EXTRA_PRESENT`: target-only files exist under `.agents/skills/`.
- `INFO / FOUNDATION_CLAUDE_ADAPTER_EXTRA_PRESENT`: target-only Claude skills/wrappers exist.
- `INFO / FOUNDATION_CLAUDE_ADAPTER_NOT_CONFIGURED`: Claude native adapter is not configured in this repository.
- `STOP` source/root/version errors: the comparison source cannot be trusted, so no current-sync claim is allowed.

Machine-gate self-tests:

```text
node .agents/skills/foundation-sync-audit/entrypoint-renderer-selftest.mjs
node .agents/skills/foundation-sync-audit/foundation-sync-audit-selftest.mjs .agents/skills/foundation-sync-audit/foundation-sync-audit.mjs
node .agents/skills/foundation-sync-audit/foundation-layered-sync-selftest.mjs
```

The layered regression fixture proves a current Layered V1 target passes, a missing Gemini native entrypoint fails with `FOUNDATION_SYNC_MISSING`, and a tampered Antigravity always-on rule fails with `FOUNDATION_SYNC_STALE`.

## Safe Bootstrap

For a repository that has not yet adopted the foundation, use the bootstrap gate instead of manually copying the canonical surface file by file.

Dry-run planning is the default:

```text
node .agents/skills/foundation-sync-audit/foundation-bootstrap.mjs --source-root <foundation-root> --target-root <application-root> --json
```

Apply only on a dedicated feature branch:

```text
node .agents/skills/foundation-sync-audit/foundation-bootstrap.mjs --source-root <foundation-root> --target-root <application-root> --apply --json
```

The bootstrap gate is deliberately narrow and fail-closed:

- it refuses `main` / `master`, detached HEAD, a non-root target checkout, and a dirty target working tree;
- for Layered V1 it copies the full managed surface: generated `AGENTS.md`, common detail docs/skills/roles/learnings, and the Claude/Gemini/Antigravity native entrypoints; legacy source baselines retain the old `AGENTS.md + .agents/skills/` behavior;
- when the target already uses Claude native skills (`CLAUDE.md` or `.claude/skills/`), it also copies the foundation Claude wrapper templates to the matching `.claude/skills/<skill>/SKILL.md` paths;
- it never overwrites the repository-owned root `CLAUDE.md`; the common Claude entry is `.claude/CLAUDE.md`;
- it never creates, edits, or overwrites `AGENTS.local.md`, business specifications, application code, secrets, runtime data, or repository-local skills;
- if a canonical/wrapper target path already exists with different content, it stops before changing anything instead of overwriting the target;
- after copying, it automatically runs `foundation-sync-audit`; if that post-copy audit fails, files created by the bootstrap attempt are removed on a best-effort rollback;
- it creates no commit, push, PR, merge, network service, daemon, external dependency, or new permission.

This is an initial-adoption helper. If a repository already has an older foundation, use the safe update helper below rather than using bootstrap to overwrite existing canonical files.

Bootstrap self-test:

```text
node .agents/skills/foundation-sync-audit/foundation-bootstrap-selftest.mjs \
  .agents/skills/foundation-sync-audit/foundation-bootstrap.mjs \
  .agents/skills/foundation-sync-audit/foundation-sync-audit.mjs
```

The self-test covers dry-run behavior, feature-branch apply, Claude configured/not-configured behavior, `AGENTS.local.md` preservation, protected-branch rejection, dirty-tree rejection, target-conflict rejection, and rollback after post-copy audit failure.

## Safe Existing Update

For a repository that already adopted a known older foundation version, use `foundation-update.mjs` instead of manually copying changed files.

The updater requires two trusted foundation checkouts:

- `--from-root`: the exact older foundation source that the target is expected to match;
- `--source-root`: the exact newer foundation source to update to.

Dry-run planning is the default:

```text
node .agents/skills/foundation-sync-audit/foundation-update.mjs \
  --from-root <old-foundation-root> \
  --source-root <new-foundation-root> \
  --target-root <application-root> \
  --json
```

Apply only on a dedicated feature branch:

```text
node .agents/skills/foundation-sync-audit/foundation-update.mjs \
  --from-root <old-foundation-root> \
  --source-root <new-foundation-root> \
  --target-root <application-root> \
  --apply --json
```

The updater is deliberately fail-closed:

- it refuses `main` / `master`, detached HEAD, a non-root target checkout, a dirty target working tree, invalid source surfaces, and equal source version labels;
- for a path present in both old and new canonical surfaces, the target must match the old source byte-for-byte before replacement is allowed;
- for a path removed by the new foundation, deletion is allowed only when the target still matches the old source byte-for-byte;
- for a newly added canonical path, an absent target path may be created; an existing different file/directory is a collision and causes `STOP`;
- when Claude native skills are configured, the same old-match/new-update rules apply to foundation wrapper templates;
- target-only `.agents/skills/` and `.claude/skills/` entries remain untouched;
- Layered V1 additions such as `CORE.md`, common detail docs, `roles/`, `learnings/`, `.claude/CLAUDE.md`, `GEMINI.md`, and `.agents/rules/ai-foundation.md` use the same old-match/new-update/collision rules as the older managed paths;
- `AGENTS.local.md`, root `CLAUDE.md`, repository-local specifications, application code, secrets, runtime data, and any path outside the foundation surfaces are never part of the update plan;
- after applying the plan, the updater automatically runs `foundation-sync-audit` against the new source and then runs the targeted selftest for any changed Foundation family it knows how to verify; if the audit, targeted selftest, or an apply step fails, changed foundation files are restored on a best-effort rollback;
- for `operation-preflight` changes, the updater invokes the committed `operation-preflight-selftest.mjs` with the exact updated gate path, so callers do not need to guess or reconstruct that verification command;
- it creates no commit, push, PR, merge, network service, daemon, external dependency, or new permission.

Important STOP results include:

- `FOUNDATION_UPDATE_TARGET_DRIFT`: a target shared file no longer matches the trusted old foundation and must not be overwritten;
- `FOUNDATION_UPDATE_TARGET_MISSING_OLD`: an old canonical/wrapper path is unexpectedly missing;
- `FOUNDATION_UPDATE_NEW_PATH_CONFLICT`: a new foundation path collides with repository-owned content;
- `FOUNDATION_UPDATE_POST_AUDIT_FAILED`: the new full-current audit failed after apply and rollback was attempted;
- `FOUNDATION_UPDATE_TARGET_SELFTEST_FAILED`: an updater-owned targeted selftest failed after apply and rollback was attempted.

Update self-test:

```text
node .agents/skills/foundation-sync-audit/foundation-update-selftest.mjs \
  .agents/skills/foundation-sync-audit/foundation-update.mjs \
  .agents/skills/foundation-sync-audit/foundation-sync-audit.mjs
```

The self-test covers dry-run/apply behavior, additions, replacements, removals, Claude configured/not-configured behavior, `AGENTS.local.md` and target-only skill preservation, protected-branch rejection, dirty-tree rejection, drift/missing/collision rejection, updater-owned `operation-preflight` targeted selftest execution, and rollback after post-update audit or targeted-selftest failure.

## Remote-Only Equivalent

If the synchronization or audit is performed through GitHub/remote-only tooling and the two local checkouts are not available, use equivalent machine-readable evidence:

1. Fix the exact foundation source commit SHA and target application commit/PR head SHA.
2. Enumerate the exact managed surface for that source SHA. For Layered V1 this includes generated `AGENTS.md`, common detail docs/skills/roles/learnings, and the mapped Claude/Gemini/Antigravity entrypoint templates; for a legacy baseline use its legacy surface.
3. Confirm each managed target path exists at the target head and compare exact blob/content identity.
4. Enumerate `templates/.claude/skills/*/SKILL.md.template` and confirm that each template corresponds to a canonical skill with matching `name`, `description`, and canonical reference path.
5. If the target has `.claude/skills/` or root `CLAUDE.md`, compare every foundation Claude skill wrapper template to `.claude/skills/<skill>/SKILL.md` at the exact target head.
6. Treat missing/different managed files, Layered V1 native entrypoints, or configured native wrappers as `STOP`.
7. Record the source foundation `VERSION` and source commit SHA in the synchronization evidence/log.
8. Do not treat a matching top-level `AGENTS.md`, a version string, or a sync-log statement as a substitute for managed-surface and adapter equality.

For a remote-only version update, additionally fix the exact old foundation SHA and prove that every target path to be replaced/deleted matches the old source before writing the new blob. Newly introduced paths must be absent or already identical to the new source. If old-state identity cannot be proved, report `STOP` instead of overwriting.

If equivalent evidence cannot be obtained, report `UNKNOWN`/`STOP`; do not convert the gap into manual copy-and-paste work for the non-engineer human.

### Remote-Only Direct Git Update Planner

When remote-only GitHub tooling exposes exact blob/tree/commit/ref operations, prefer the direct Git Data route over generating a one-shot workflow merely to transport Foundation files.

Build a machine-readable manifest from the exact old Foundation source, exact new Foundation source, and exact target branch head, then run:

```text
node .agents/skills/foundation-sync-audit/foundation-remote-update-plan.mjs --manifest <manifest.json>
```

The planner is read-only. It validates only Foundation-managed target paths from the shared managed-surface contract: Layered V1 common files and native entrypoints, recursive `.agents/skills/**` / `roles/**` / `learnings/**`, plus configured `.claude/skills/**`. `AGENTS.local.md` and root `CLAUDE.md` remain outside this write surface. It fails closed when:

- a replace/delete target no longer matches the trusted old blob SHA;
- a newly introduced path collides with different target content;
- the target branch is `main` / `master` (including `refs/heads/...` form);
- a manifest contains duplicate, invalid, or out-of-surface paths;
- exact source/target commit or base-tree identifiers are missing/invalid.

On PASS it emits `FOUNDATION_REMOTE_UPDATE_PLAN_READY` with a Git Data contract:

1. create each required new blob in the target repository and verify the created SHA equals the trusted new-source blob SHA;
2. create a tree from the exact target-head base tree using only the planned canonical entries;
3. create a commit whose parent is the exact target head used for planning;
4. update the feature-branch ref with `force=false`; if the branch moved, the update must fail rather than overwrite concurrent work;
5. perform the normal full Foundation sync audit at the resulting exact head before claiming `FULL_CURRENT`.

The planner does not replace source-surface enumeration or the post-write full audit. Callers must still enumerate the exact canonical/wrapper surfaces described above and include every path being replaced, added, or deleted. `AGENTS.local.md`, application code, business specifications, data paths, target-only skills, sync logs, secrets, and runtime data are outside this write plan.

Planner self-test:

```text
node .agents/skills/foundation-sync-audit/foundation-remote-update-plan-selftest.mjs \
  .agents/skills/foundation-sync-audit/foundation-remote-update-plan.mjs
```

This direct route adds no token, cross-repository secret, service, daemon, or recurring workflow. If exact Git Data operations are unavailable, fall back to another already-approved safe route; do not weaken old-state identity checks merely to avoid a tooling limitation.

### Batch Rollout Planning

When one Foundation release must be propagated across multiple application repositories, do not rebuild the same old/new Foundation delta independently for every repository. Build that exact release delta once, collect exact target blob identities for only those changed Foundation-owned paths, then run:

```text
node .agents/skills/foundation-sync-audit/foundation-batch-rollout-plan.mjs --manifest <batch-manifest.json>
```

The batch planner is read-only and provider-neutral. Its schema-v1 manifest contains one `release` (`fromVersion`, `sourceVersion`, exact old/new Foundation commits, and changed canonical entries) plus multiple target snapshots (`repository`, branch, exact head/base tree, and exact target blob SHA or `null` for every release path). It never trusts a target version label by itself.

For each target it compares every release path against the exact old and exact new blob states:

- all paths already equal the new state -> `CURRENT / NONE`; do not create a branch, rewrite files, rerun application verification, or open a rollout PR;
- pending paths all equal the old state -> `UPDATE`;
- some paths equal exact-new while the remaining paths equal exact-old -> `PARTIAL_RESUME`; only the exact-old remainder is planned, so a safe interrupted rollout can resume without rewriting completed paths;
- any path is neither exact-old nor exact-new, or exact target evidence is missing -> `STOP`; investigate drift rather than overwriting it.

If an `UPDATE`/`PARTIAL_RESUME` target snapshot is on `main` or `master`, the planner returns `CREATE_FEATURE_BRANCH` from that exact head and no write plan. After the AI creates the feature branch, rerun the same planner against that branch; the unchanged exact blob evidence then produces `APPLY_REMOTE_PLAN`. For non-protected feature branches, the batch planner delegates the remaining entries to the existing `foundation-remote-update-plan.mjs` and returns that planner's fail-closed write contract. It does not introduce a second update algorithm.

The Foundation release delta is validated once for duplicate/out-of-surface paths, invalid SHA/content pairs, and unchanged entries. Targets are bounded, deduplicated by repository+branch, and must provide exact head/base-tree identity. No application/runtime/data/credential path is eligible.

Batch planner self-test:

```text
node .agents/skills/foundation-sync-audit/foundation-batch-rollout-plan-selftest.mjs
```

After any actual target write, the existing full `foundation-sync-audit` remains mandatory before claiming `FULL_CURRENT`. Each application repository still uses its own feature branch / Draft PR / final audit / explicit human merge authorization. Batch planning reduces repeated discovery and writes; it does not combine application merge authority.

## Partial Sync Handling

Partial synchronization is allowed only when explicitly scoped and recorded as partial. It must not be described as a full/current foundation sync.

After a partial sync:

- the changed subset may be verified as applied;
- the repository as a whole remains `PARTIAL` until the full canonical sync surface matches the selected foundation source and any configured native adapter is current;
- a later full audit may still detect older files or missing wrappers left behind by earlier partial syncs.

This distinction is important because different shared skills or AI-native discovery routes can otherwise silently remain at different foundation versions.

## Required Output

Use a compact result such as:

```text
FOUNDATION_SYNC_AUDIT: PASS / STOP / PARTIAL / UNKNOWN
Source version: <foundation VERSION>
Source commit: <exact SHA when available>
Target head: <exact SHA when available>
Canonical shared files checked: <count>
Canonical missing: <count>
Canonical stale: <count>
Canonical target-only extras: <count>
Claude adapter: CURRENT / NOT_CONFIGURED / STOP
Claude wrappers checked: <count>
Claude missing: <count>
Claude stale: <count>
Claude target-only extras: <count>
Claim allowed: FULL_CURRENT / PARTIAL_ONLY / NO
User action: none / <only genuinely unavoidable action>
```

Do not print protected-data paths or content. The compared surfaces are development-control files only; repository-local data is outside the audit surface.

## Stop Conditions

Do not claim `FULL_CURRENT` when:

- any foundation canonical shared file is missing;
- any corresponding canonical shared file differs;
- the foundation's own native wrapper templates are incomplete or drifted from canonical skill metadata/reference paths;
- a native adapter is configured in the target and a required wrapper is missing or stale;
- the exact foundation source version/commit cannot be established when the workflow requires that evidence;
- only `AGENTS.md` or only a selected subset was synchronized;
- the sync log says current but file comparison disagrees;
- the comparison itself cannot be completed with trustworthy evidence.

For an existing-foundation update, also stop instead of overwriting when the target does not exactly match the trusted old foundation on a path that would be replaced/deleted, or when a newly introduced foundation path collides with repository-owned content.

## Key Principle

**Synchronization is a property of the files that actually control behavior, not a statement in a log.**

Keep one canonical skill body in `.agents/skills/`. Native-loader files stay thin adapters and must be mechanically tied to that canonical source. Prefer exact file identity and metadata/reference checks over duplicate rule bodies, new services, daemons, cloud dependencies, or human maintenance steps.