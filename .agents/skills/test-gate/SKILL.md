---
name: test-gate
description: Use after implementation, fixes, refactoring, UI changes, backend changes, or migration changes, including Japanese requests such as 実装後の検証, 修正後のテスト, 必要テストの選択, 型チェック相当, selftest, build, migration test, 実機確認, 未実施確認, or テストゲート. Select and run only verification that is proportionate to the actual changed scope, require machine-readable scope planning before heavy checks, preserve exact-head evidence, and never treat unrun or unavailable checks as passing.
---

# Test Gate

Use after changes are made and verification is required.

The purpose is to prove the properties affected by the change with the smallest safe verification set. A test is evidence, not a ritual. More tests are not automatically safer when they prove properties unrelated to the diff.

## Evidence Location

Before selecting checks, identify where the audited change exists and where verification can actually execute.

- If the audited head exists in a local workspace, use that workspace and record its exact head/state.
- If the audited head was created remotely and no local workspace participated, do not require an unrelated local checkout merely to satisfy habit. Use exact remote-head content and machine-readable GitHub/remote evidence where the property can be reproduced equivalently.
- If both local and remote paths participated, prove both refer to the same audited head.
- An alternative verification counts as `success` only when it operates on the exact audited source or canonical diff and is technically equivalent to the required property.
- If equivalence cannot be established, mark the check `unavailable` or `unrun`; never upgrade it to success.
- Do not make a non-engineer human relay command output between tools when an accessible machine-readable source can provide the evidence.

## Mandatory Verification Scope Gate

Before running broad or expensive verification, build the planned verification set from the actual changed files and run:

```text
<json-plan-producer> | node .agents/skills/test-gate/verification-scope-gate.mjs
```

Input schema:

```json
{
  "changedFiles": ["path/from/repository/root"],
  "plannedChecks": ["DIFF_HYGIENE"],
  "escalationReason": null
}
```

Supported `plannedChecks`:

- `DIFF_HYGIENE`
- `DOCS_CONSISTENCY`
- `TARGETED_SELFTEST`
- `FORMAT`
- `LINT`
- `TYPECHECK`
- `TARGETED_FRONTEND_TEST`
- `FRONTEND_BUILD`
- `FRONTEND_FULL_TEST`
- `TARGETED_BACKEND_TEST`
- `BACKEND_BUILD`
- `BACKEND_FULL_TEST`
- `MIGRATION_TEST`
- `DEPENDENCY_AUDIT`
- `REAL_DEVICE_OBJECTIVE`
- `FULL_REPOSITORY_SUITE`

The gate classifies the changed files into one of these profiles:

- `DOCS_ONLY`
- `GOVERNANCE_ONLY`
- `FRONTEND_ONLY`
- `BACKEND_ONLY`
- `DB_MIGRATION`
- `DEPENDENCY_CHANGE`
- `MIXED_RUNTIME`
- `UNKNOWN`

Decisions:

- `PROCEED`: planned verification is proportionate and contains the required minimum checks.
- `PROCEED_ESCALATED`: a normally excessive check is allowed because a valid explicit escalation reason exists.
- `STOP`: do not run the planned verification set. Correct the plan or resolve the unknown scope first.

A heavy check that is unrelated to the classified change must not run merely for reassurance. If a repository-specific requirement genuinely needs a broader check, use exactly one applicable escalation reason:

- `REPOSITORY_POLICY`
- `BASE_CHANGED`
- `PREEXISTING_FAILURE_TRIAGE`
- `CROSS_CUTTING_UNCERTAINTY`
- `RELEASE_GATE`

Do not invent a free-text escalation reason. Do not use an escalation code merely to preserve an old habit.

Self-test:

```text
node .agents/skills/test-gate/verification-scope-gate-selftest.mjs
```

## Binding Scope Rule

The scope-gate result is binding for the current exact changed-file set and test plan.

- Checks outside the approved plan are `unneeded` unless new evidence changes the applicable profile or a valid escalation reason arises.
- A later workflow stage, including PR preparation or `final-pr-audit`, must not resurrect an `unneeded` full suite merely because that stage historically ran it.
- Previously valid PASS evidence may be reused when the exact tested HEAD, relevant base/environment assumptions, generated outputs, and property being proved remain equivalent.
- If HEAD, audited base, environment assumptions, generated output, changed-file set, or the property being proved changes materially, rerun the scope gate and only the newly applicable checks.
- A caller assertion alone is not proof that prior evidence still applies.
- Repository-required independent OS/device/platform checks remain required when they prove a distinct property not covered by the local checks.

## Required Workflow

1. Inspect changed files and changed content.
2. Read the repository's `AGENTS.local.md` `Repository Commands` and any repository-specific verification rules.
3. Build the planned check categories.
4. Run `verification-scope-gate.mjs` before heavy verification.
5. Run lighter required checks before heavier required checks.
6. Stop when a required earlier check fails, is interrupted, times out, or cannot run without an accepted equivalent path.
7. Separate automated checks from real-device verification and genuinely human-only confirmation. `REAL_DEVICE` is an execution environment label, not a Human Confirmation Point by itself.
8. Do not mark work complete until every required check is `success` or explicitly `unneeded`.
9. Record every check as exactly one of: `success`, `failure`, `unrun`, `unneeded`, `unavailable`, or `interrupted`.

## Selection Rules

Use repository commands that actually exist. Do not invent commands.

- Documentation-only changes: diff hygiene plus relevant document consistency. Build, application tests, dependency audit, and real-device checks are normally `unneeded`.
- Governance-only changes such as `.agents/` or common rule documentation: diff hygiene plus the targeted selftest for the changed gate/rule and document consistency. Application-wide frontend/backend suites are normally `unneeded`.
- Frontend-only changes: diff hygiene, relevant selftest, repository-listed frontend static checks as applicable, and frontend build. Full frontend suites, backend full suites, migration tests, and dependency audit require evidence that they are actually needed; the scope gate rejects unrelated broad checks by default.
- Backend-only changes: diff hygiene plus repository-listed backend verification. A backend full suite may be required when the backend implementation changed; unrelated frontend verification remains `unneeded`.
- Database/migration changes: also use `migration-safety`; verify frozen migrations remain unchanged, run backend coverage required by the repository, migration-specific tests, fresh-apply/upgrade/integrity coverage where defined.
- Dependency changes: dependency/security audit is required. Add affected build/tests according to the changed dependency and repository policy; do not automatically run every repository suite.
- Mixed frontend/backend runtime changes: verify both affected stacks, but do not automatically add `FULL_REPOSITORY_SUITE` unless a valid escalation reason exists.
- Unknown scope: fail closed. Classify the changed file or update the common gate only when the classification gap is real and reusable; do not guess.

## Verification Placement and Evidence Reuse

- Prefer local execution for deterministic source, format, lint, type, unit, build, and selftest properties when the exact audited head is available locally.
- Use hosted/independent execution only when it proves a distinct property local execution cannot equivalently establish, such as a clean OS image or platform-specific behavior required by policy.
- Do not repeat the same property merely because work moved from implementation to PR, merge, or post-merge.
- A PR CI gate normally provides its independent evidence before merge. A second post-merge run is justified only for an explicitly post-merge/deployment/runtime property, not unchanged source behavior.
- Evidence reuse never converts unavailable or unknown evidence into PASS.

### Machine-readable verification evidence receipt

When all planned checks completed successfully **on an exact committed HEAD**, issue one reusable receipt instead of making later stages recollect or rerun the same verification properties:

```text
<receipt-issue-json> | node .agents/skills/test-gate/verification-evidence-receipt.mjs
```

The issue payload uses `schemaVersion: 1`, `mode: "issue"`, and binds the successful verification to `baseSha`, `headSha`, the exact `changedFiles`, `profile`, `scopeDecision`, `plannedChecks`, and one successful result/evidence source for every planned check. The gate rejects `UNKNOWN` scope, accepts only closed-vocabulary PASS evidence, and emits `VERIFICATION_EVIDENCE_V1` plus a tamper-evident `receiptId`. The receipt preserves and binds machine-observed results; it does not independently execute the underlying tests, so it may be issued only from results already observed by the active `test-gate` workflow.

Before `final-pr-audit` reuses that evidence, verify the receipt against the current exact base/head/changed-file set:

```text
<receipt-verify-json> | node .agents/skills/test-gate/verification-evidence-receipt.mjs
```

- `REUSE`: the receipt is intact and the current base SHA, HEAD SHA, and changed-file set are identical. The listed verification checks are already proven and **must not be rerun or recollected merely because the workflow moved to another stage**.
- `STOP`: receipt tamper, base drift, HEAD drift, changed-file drift, incomplete results, or invalid evidence. Return only the invalidated properties to `test-gate`; do not restart unrelated checks that still have valid evidence.
- A caller statement such as "tests already passed" is not a receipt. Evidence source is restricted to `local`, `remote`, `github-api`, `connector`, `device`, or `provider`.
- If verification ran before the final commit and exact-HEAD equivalence has not been mechanically proven, **do not mint a receipt for that later HEAD**. Keep the earlier result as ordinary evidence and perform only the minimum exact-head verification needed by repository policy.
- Repository-required independent OS/device/platform evidence remains separate when it proves a distinct property.

Self-test:

```text
node .agents/skills/test-gate/verification-evidence-receipt-selftest.mjs
```

## Real-Device Preparation Gate

Before assigning real-device or other manual verification, classify its basis and owner.

Displayed values, control presence, navigation, persistence results, logs, and other reproducible evidence are `objective` and remain AI/system/provider-owned when observable. Preference, operation feel, or another inherently subjective judgment is `subjective` and may be user-owned.

Before verification starts, run:

```text
node .agents/skills/test-gate/real-device-preparation-gate.mjs --manual-verification required --verification-basis objective --verification-owner ai-workflow --sample-data required --sample-data-prepared yes --sample-data-preparer ai-workflow --sample-data-source dev-preload --approved-test-environment yes --human-sample-data-entry no --ui-path-verified yes --manual-started no
```

Use values matching the actual verification.

- `PROCEED`: prerequisites and ownership are consistent.
- `STOP`: do not start or continue. Return to AI-side preparation unless the blocker is a genuine subjective Human Confirmation Point.
- `UNNECESSARY_HUMAN_CONFIRMATION`: the check is objective and must be reassigned from the user to AI/system/provider evidence.

When sample/test data is required, the preparer must be `ai-workflow`, `system`, or `provider`, and the source must identify a prepared safe source such as `seed`, `fixture`, `dev-preload`, or `existing-test-data`. `--human-sample-data-entry yes` is always a stop condition.

Preparation self-test:

```text
node .agents/skills/test-gate/real-device-preparation-gate-selftest.mjs .agents/skills/test-gate/real-device-preparation-gate.mjs
```

Additional rules:

- Do not use production or real-person data merely because test data is missing.
- Do not make the human create or type sample/test data during REAL_DEVICE/manual verification.
- Verify the intended non-production environment/data source before interaction.
- Verify actual UI labels and paths from source/UI evidence; do not ask the human to discover controls.
- If sample data, environment proof, or UI path is missing, keep verification `unrun` or `interrupted` and return to preparation.
- When `verificationOwner=user`, report the duration estimate and fixed human-check count before the first human action. AI-owned objective verification does not create a user-facing confirmation step.

## Default Order

Run only applicable checks, normally in this order:

1. Verification scope gate
2. Diff hygiene
3. Targeted selftest
4. Format / lint / type checks when applicable
5. Targeted or stack-level unit/integration verification when applicable
6. Build when applicable
7. Migration-specific verification when applicable
8. Dependency audit when applicable
9. Real-device verification or genuinely human-only confirmation when applicable

If a required repository-specific check must run in another order, record why.

## Known-Failure and Regression Triage

- When a required check fails, determine whether the failure already existed before this change or is a new regression.
- Base that determination on pre-change evidence, not assumption.
- If it cannot be determined confidently, treat it as a regression until shown otherwise.
- A known failure does not justify skipping unrelated regression checks.
- Confirm the current change did not alter the known failure's cause or scope.
- Proceeding despite a known failure is acceptable only once the pre-existing status is proven and recorded.

## Result Counting

- Report runner-provided succeeded, failed, skipped, and not-run counts where available.
- When multiple suites run, report counts per suite as well as totals.
- Do not estimate counts and present them as confirmed.
- If counts are unavailable, state that and why.
- On rerun, report the final result and the failures observed before the fix.

## Stop Conditions

Stop the verification attempt when any of these applies:

- `verification-scope-gate` returns `STOP`.
- Required test fails, is interrupted, or times out.
- Required repository command does not exist and no technically equivalent evidence path applies.
- Unexpected generated or tracked files appear in a workspace actually used.
- A used local working tree becomes dirty unexpectedly.
- Migration checksum or line-ending state is unclear.
- Required real-device verification is not performed.
- `real-device-preparation-gate` returns `STOP`.
- Required real-device preparation is incomplete.
- A human would need to create or type sample/test data.
- A proposed command or equivalent path is unknown.
- A new regression is confirmed.
- A paid service, external API, automatic billing, or added dependency may be involved without prior authorization.

A test-gate `STOP` is not automatically a Human Confirmation Point. Return the result to the orchestrating AI workflow; when the user already authorized the work scope and no genuine Human Confirmation Point is introduced, the AI should diagnose, correct the technical issue, rebuild the verification plan, and rerun without asking for a new approval.

## Do Not Do

- Do not guess repository commands.
- Do not add dependencies or packages merely to satisfy the gate.
- Do not run a full suite solely because it feels safer.
- Do not use a generic final-audit checklist to override a scope-gate `unneeded` decision without new evidence or a valid escalation reason.
- Do not modify application code, migrations, or docs inside the read-only test-gate itself; return required fixes to the orchestrating workflow.
- Do not create PRs, merge, delete branches, commit, push, rebase, reset, force, or change Git configuration from the gate.
- Do not infer real-device/manual success.
- Do not ask the human to create, type, or improvise sample/test data.
- Do not report `unrun` or `unavailable` checks as passing.
- Do not require an unrelated local working tree or stash when the audited head was produced and verified entirely through another evidence path.

## Output

Report:

- Skills used
- Evidence source: local / remote-only / mixed
- Audited head SHA when available
- Changed files
- Verification profile and scope-gate decision
- Planned checks and any escalation reason
- Commands or equivalent checks run, execution location, and status
- Checks marked `unneeded` and why
- Checks marked `unrun`, `unavailable`, or `interrupted` and why
- Failed-check known/new regression determination and evidence
- Verification counts per suite and total when available
- Generated-output or data-write risk
- Real-device preparation/verification status when applicable
- Whether completion is allowed
- Blockers

## Application-Specific Configuration

The exact commands for format, lint, type check, unit/integration test, build, selftest, migration test, dependency audit, and real-device execution come from that repository's `AGENTS.local.md` and existing repository scripts. This common skill selects categories and constrains scope; it does not invent language-, framework-, or repository-specific commands.
