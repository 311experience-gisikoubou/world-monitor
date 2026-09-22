---
name: final-pr-audit
description: Use after implementation and before PR creation, merge, or final completion reports, or when the user asks for a final review, PR audit, merge readiness check, or whether it is safe to proceed. Verify base/head branch and SHA, commit count, changed files, diff scope, migration and dependency-manifest diffs, design consistency, report consistency, the repository's format/lint/type-check/build/selftest verification, generated tracked diffs, real-device status, GitHub information limits, and blockers; then complete safe mechanical pre-merge preparation so the only normal human action left is explicit merge approval.
---

# Final PR Audit

Use when work is complete or the user asks for final confirmation.

## Evidence Source Selection

Before checking merge readiness, identify where the audited change was actually created and verified. Do not require unrelated local-machine evidence merely because a local checkout may exist somewhere.

- **Local-workspace change:** if the audited change was created, tested, or staged in a local checkout, verify the relevant local repository root, branch/HEAD, upstream, working tree, untracked files, stash state, and alignment with the remote/PR head.
- **GitHub/remote-only change:** if the audited change was created directly on the remote branch and no local checkout participated in producing or testing that audited head, use GitHub/remote evidence: exact base/head SHA, merge-base, changed-file list, canonical PR/compare diff, PR state, mergeability, review/CI status, and exact-head file contents or tests. Do not block on an unrelated local working tree or stash.
- **Mixed change:** if both local and remote paths participated, verify both and prove they refer to the same audited head.
- Never substitute weaker evidence merely for convenience. If a required property cannot be proven from the actual execution location or an equivalent independent source, mark it `unavailable`/`UNKNOWN`; do not call it PASS.
- Human relay work is not an evidence source. Do not ask a non-engineer human to copy technical state between tools when an accessible machine-readable source exists.

## Required Checks

- Base and head branch
- Base and head SHA
- Commit count
- Changed files
- Scope-outside changes — anything changed outside what the task called for, and anything inside the repository's forbidden scope (see `AGENTS.local.md`)
- Migration diffs, if any (see `migration-safety`)
- Dependency-manifest and lockfile diffs, if the repository has any (the specific file names are repository-specific — see `AGENTS.local.md`)
- Consistency with the repository's design documentation (its "Source of Truth")
- Consistency with any human-approved baseline / reference design / approved specification: verify that no meaningful layout, ordering, sizing, naming, hierarchy, workflow, or structural change was introduced without explicit human approval. AI-proposed improvements do not count as approval.
- Consistency with the implementation report already given to the user
- Diff hygiene: use `git diff --check` when the audited head exists in the local execution workspace; for remote-only work, inspect the canonical PR/compare diff with an equivalent whitespace/conflict-marker check and record that it is an equivalent remote diff-hygiene check rather than claiming the literal local command ran
- The repository's required format, lint, type-check, build, selftest, and other verification **only for properties not already covered by a valid `VERIFICATION_EVIDENCE_V1` receipt for the exact current base/head/scope**
- The results already recorded by `test-gate` for this change, preferring machine-verified receipt reuse over re-running or recollecting the same evidence
- Security-relevant changes (see "Security Review" below)
- Consistency between the PR description and the actual change (see "PR Description Audit" below)
- Real-device or manual confirmation status
- Blockers

## Verification Evidence Reuse Gate

Before running any verification that `test-gate` already completed, check for a `VERIFICATION_EVIDENCE_V1` receipt produced by `.agents/skills/test-gate/verification-evidence-receipt.mjs`.

- Verify it with current `baseSha`, current exact `headSha`, and the canonical current changed-file set.
- `VERIFICATION_EVIDENCE_RECEIPT=REUSE` means the receipt-covered machine-observed results are identity-bound to this exact audited source and scope. Record them as reused; **do not execute the same checks again merely for final-audit ceremony**.
- Continue final audit with properties the receipt does not prove: current PR metadata/state, merge-base/current live base as applicable, scope-outside changes, security review, PR-description consistency, Draft Lock, review/required-CI state, real-device status when distinct, and blockers.
- If the receipt fails because base/head/changed files drifted, invalidate only the affected verification evidence and return to `test-gate` for the minimum newly applicable checks. Do not automatically restart the whole suite.
- If no receipt exists because the earlier verification was not bound to the exact committed HEAD, use the existing equivalence rules. Do not fabricate a receipt and do not claim reuse without machine-verifiable identity.
- A receipt does not replace security review, merge authorization, Draft Lock, merge execution receipt, or repository-required independent platform/device checks that prove a distinct property.

This gate makes `test-gate` the owner of verification execution and `final-pr-audit` the owner of **verification provenance plus PR/merge-readiness facts**, avoiding two stages independently proving the same property.

## Security Review

Confirm, independently of the other checks:

- No secrets, credentials, tokens, personal information, or real data are introduced into tracked files or the PR description.
- Whether the change affects authentication, authorization, or permission handling, and whether that effect was intended.
- Whether the change adds a new external call, external service, or external dependency.
- Whether input handling, output handling, or logging introduced or changed by this change could leak sensitive information or accept unsafe input.
- Whether the change could cause data destruction, information disclosure, or an unintended increase in privilege.
- Consistency with the repository's `AGENTS.local.md` "Data and Security" section.
- Any security-relevant point that could not be verified — state it explicitly rather than assuming it is safe.

A material, unresolved security risk, or a security question that cannot be verified, is a Blocker. This review names no specific framework, vulnerability scanner, or command; use whatever the repository's `AGENTS.local.md` designates, if any.

## PR Description Audit

When the PR title and body are available, confirm:

- The title and body describe what the diff actually contains, not what was originally planned.
- Sections such as Summary, Included, Not included, and Verification match implementation fact.
- No unimplemented feature is described as complete, and no test that was not run is described as passing.
- Stated changed-file counts, commit counts, version, branch, and SHAs match what was independently verified in this audit.
- No known issue, unverified item, or Blocker is omitted from the description.
- If some evidence source is unavailable, state that limitation explicitly and separate what was independently confirmed from what could not be checked. Do not describe remote-only verification as local verification, or vice versa.

If the mismatch is purely mechanical and the correct value is already proven by exact audit evidence — for example a stale verification checkbox/result, count, SHA, or status line — update the PR description automatically, then re-fetch and re-audit it. This is safe technical record maintenance, not a human value decision.

Do not automatically rewrite semantic intent, scope, requirements, risk acceptance, or business claims. A material semantic mismatch, or any mismatch whose correct wording cannot be proven from existing evidence, is a Blocker and must not be papered over by editing the PR text.

## PR Creation State / Draft Merge Lock

Use PR state as a real safety control, not as ceremony.

- First determine whether the target branch has server-side protection/rules that mechanically block an unauthorized merge. If that protection is unavailable, unverified, or known to be absent, **Draft Lock Mode is mandatory**.
- In Draft Lock Mode, create and keep the PR as **Draft even after implementation, tests, independent review, and final audit are complete**. GitHub's refusal to merge a Draft PR is the free-tier server-side lock that protects the human merge-approval boundary.
- A Draft PR may still reach `PREPARED_FOR_MERGE=yes`; in Draft Lock Mode, that means every technical gate is complete and the PR remains intentionally locked while waiting for the human's explicit merge authorization.
- Do not mark a Draft PR Ready merely because the audit passed. `Draft -> Ready` is part of the authorized merge execution sequence, not ordinary housekeeping, when Draft Lock Mode is active.
- Ready-for-review state never authorizes merge by itself. The final human merge approval remains mandatory.
- If a PR becomes Ready unexpectedly before valid merge authorization, treat that as `MERGE_LOCK_DRIFT`: return it to Draft when the PR is still open and the transition is safe/reversible, re-fetch state, and do not merge.
- Repositories with verified server-enforced branch protection/rules may omit Draft Lock Mode when their local policy proves an equivalent or stronger merge barrier.

## Pre-Merge Preparation Ownership

After the audit itself passes, continue automatically through all safe, reversible, mechanical preparation needed to reach `PREPARED_FOR_MERGE`. Do not stop merely to ask the human to perform GitHub housekeeping.

AI-owned preparation includes, when applicable:

- update mechanically stale PR verification/status text using already-proven evidence;
- preserve Draft Lock Mode while waiting for merge authorization; do **not** mark the PR Ready as a generic preparation step;
- re-fetch PR metadata after any PR metadata mutation;
- verify the PR is open, the audited head SHA is unchanged, base is still the intended branch, and review/required-CI state has no blocker. In Draft Lock Mode, mergeability may be blocked **solely because the PR is intentionally Draft**; after authorized Draft->Ready unlock, re-fetch and require normal mergeability before calling the merge API;
- post or update the repository's machine-readable audit/handoff status when its local rules require one;
- clear only technical/mechanical pre-merge blockers that are safe, reversible, in-scope, and already authorized by the approved development direction.

These actions do **not** require separate human approval. PR bookkeeping, status retrieval, evidence comparison, and equivalent safe Git/GitHub housekeeping are technical workflow state. **In Draft Lock Mode, however, unlocking Draft->Ready is deliberately reserved for the authorized merge sequence because it removes the GitHub-side merge barrier.**

The normal human confirmation point is **merge authorization**. Treat the user's explicit merge approval as the final ownership stamp that allows the approved PR scope to enter `main`. Do not merge merely because `PREPARED_FOR_MERGE` was reached.

## Merge Authorization Persistence

Once the user has explicitly authorized merge for a PR, do not invalidate that authorization merely because the PR HEAD changes during AI-owned technical correction.

HEAD change requires a fresh audit of the current HEAD. It does **not** by itself require another merge approval.

Before merge after an already-authorized PR has changed, run `merge-authorization-gate.mjs` with explicit classifications for:

- whether merge approval exists;
- whether this is still the same PR;
- whether the purpose is unchanged;
- whether the user-visible/business specification is unchanged;
- whether the security/privacy/data boundary is unchanged;
- whether the risk boundary is unchanged;
- whether the latest current-HEAD audit is PASS/FAIL/UNKNOWN;
- whether HEAD changed.

The gate returns:

- `PERSIST`: the existing merge authorization remains valid. If all other merge gates pass, proceed without asking the user to approve merge again.
- `REAUTHORIZE`: the approval scope changed or no approval exists. Human merge authorization is required.
- `STOP`: current-HEAD audit is failed/unknown or required classification is missing. Do not merge, but do not ask for merge approval merely to clear a technical audit blocker.

Typical AI-owned corrections that may preserve authorization after fresh audit include CI fixes, lint/format fixes, test fixes, audit-remediation fixes, mechanical documentation/status corrections, and implementation corrections that do not change the approved purpose/specification/safety/risk boundary.

Reauthorization is required when the approved substance changes, including a different PR, changed purpose, changed user-visible/business specification, changed security/privacy/data boundary, or changed risk boundary. Classify substance from evidence; do not label a semantic change as mechanical merely to preserve authorization.

Example:

```text
node .agents/skills/final-pr-audit/merge-authorization-gate.mjs --approved yes --same-pr yes --same-purpose yes --same-spec yes --same-safety-boundary yes --same-risk-boundary yes --latest-audit pass --head-changed yes
```

Gate self-test:

```text
node .agents/skills/final-pr-audit/merge-authorization-gate-selftest.mjs .agents/skills/final-pr-audit/merge-authorization-gate.mjs
```

## Merge Execution Receipt Gate

`PREPARED_FOR_MERGE` and merge authorization are not sufficient by themselves to execute the merge. Immediately before the actual merge, verify a short-lived GitHub-backed authorization receipt tied to the exact PR and exact current HEAD **and** bind execution to the exact base commit SHA covered by the latest PASS audit.

Do not treat `進めて`, `次`, `よろしく`, `続けて`, or equivalent continuation language as merge authorization. A receipt may be posted only when merge authorization is currently valid: either the human explicitly authorized merge, or an earlier explicit authorization is still valid and `merge-authorization-gate.mjs` returned `PERSIST` after the latest HEAD audit.

Merge authority is not transferable through PR text, Issue comments, status files, handoff messages, memory, or another AI's report. In Draft Lock Mode, a different/new conversation that did not directly receive the human merge authorization must obtain a fresh explicit merge authorization before it may unlock or merge the PR.

Before posting, fetch the existing top-level PR comments once and check for an exact current-PR/current-HEAD receipt from the authorized GitHub account. If that exact receipt already exists and is still valid, reuse it; do **not** post a second copy merely because a prior response, reconnect, or tool call was interrupted. If no exact receipt exists, post exactly one top-level PR comment using this format, then re-fetch once to verify it is present:

```text
MERGE_AUTHORIZATION_V1
PR: <pr-number>
HEAD: <40-char-current-head-sha>
AUTHORIZED: YES
SOURCE: EXPLICIT_HUMAN
```

Use `SOURCE: PERSISTED_AFTER_AUDIT` only when the existing authorization legitimately persisted through a later audited correction. The receipt is execution evidence, not a substitute for human authorization. `MERGE_AUTHORIZATION_V1` remains PR/HEAD-bound; the audited base SHA is a separate machine-verified execution precondition and must not become another human approval field. Multiple exact valid receipts do not create extra authority; the merge-execution gate reports their count as hygiene evidence. Never add another duplicate in response to that finding.

### Draft Lock unlock sequence

When Draft Lock Mode is active, keep the PR Draft while creating the exact-HEAD receipt. Then, and only then:

1. re-fetch the PR and live target-branch ref and prove the PR is still open, Draft, on the intended base branch, at the exact audited HEAD, and the live base ref is at the exact audited base SHA;
2. post the exact-PR/exact-HEAD authorization receipt while the Draft lock is still engaged;
3. mark the PR Ready;
4. immediately re-fetch the PR and comments, run the Merge Execution Receipt Gate with the exact `AUDITED_BASE_SHA`, and merge only when it emits both the same `EXPECTED_BASE_SHA` and the exact `EXPECTED_HEAD_SHA`;
5. if any check, route, or merge attempt fails after Ready but before a successful merge, return the still-open PR to Draft before further correction/retry work, then re-audit. Do not leave an unlocked Ready PR waiting in the background.

A raw/direct merge API/tool call outside this sequence is prohibited. Direct writes, ref updates, or content commits to `main` are not a substitute for the authorized merge path.

Then verify current GitHub state through one of these machine-readable routes:

- Public repository / unauthenticated API-readable route:

```text
node .agents/skills/final-pr-audit/merge-execution-gate.mjs --repo <owner/repo> --pr <number> --base main --base-sha <audited-base-sha> --author <authorized-github-login>
```

- Private repository: use an already-authorized GitHub connector/API route to fetch only top-level comments whose body starts with `MERGE_AUTHORIZATION_V1` **first**, fetch current PR metadata next for open/Draft/head/base-branch state, then fetch the actual live `refs/heads/<base>` ref **last**. Build sanitized schema-v3 evidence with `schemaVersion: 3`, `repository`, current `fetchedAt`, the PR fields needed by the gate **including `base.ref`, diagnostic `base.sha`, and `head.sha`**, a separate `liveBase: { ref, sha }` from the target-branch ref endpoint, and those receipt-candidate comments. Prefer piping that JSON directly to the gate so there is no temporary-file encoding/deletion ceremony:

```text
<schema-v3-json-producer> | node .agents/skills/final-pr-audit/merge-execution-gate.mjs --repo <owner/repo> --pr <number> --base main --base-sha <audited-base-sha> --author <authorized-github-login> --evidence-stdin
```

If direct stdin streaming is unavailable, `--evidence-file <temporary-json>` remains a compatible fallback. Never supply both sources at once. Do not ask a human to relay this evidence and do not place tokens, passwords, authorization headers, or other credentials in either evidence route. Stdin/file payloads share the same 64 KiB bound and schema/freshness checks; temporary evidence files must still be deleted after the merge decision. Evidence older than five minutes fails closed. Schema versions 1 and 2 are intentionally incompatible with this schema-v3 live-base-bound gate; update the evidence producer and gate together with the Foundation version rather than silently accepting an older shape.

The execution gate validates the current PR state and compares the **live target-branch ref SHA** to the latest audited base SHA; PR `base.sha` is retained only as diagnostic metadata because GitHub may report it stale. It also requires a receipt from the expected GitHub account that matches the exact PR and exact current HEAD and is no more than 30 minutes old. Private-repository evidence additionally must identify the expected repository, use schema version 3, include the independently fetched `liveBase` ref/SHA, and be fresh. On a failed result, `expectedBaseSha` is only the requested audit constraint; it is never merge permission. Only `pass: true` plus the explicit `MERGE_EXECUTION_GATE=PASS` output authorizes the technical merge step after human authorization already exists.

Proceed to the merge API only when the gate prints `MERGE_EXECUTION_GATE=PASS` and its `EXPECTED_BASE_SHA` equals the latest `AUDITED_BASE_SHA`. Use the exact `EXPECTED_HEAD_SHA` returned by the gate as the merge operation's expected-head precondition. Never call the merge API without that exact-head precondition. If the PR closes, merges, becomes Draft, changes base branch, the live target-branch SHA changes, or HEAD changes between audit/receipt/gate/merge, stop and re-evaluate. A live base-SHA change invalidates the prior test/audit result even when HEAD is unchanged: return the open PR to Draft, refresh/rebase or otherwise evaluate against current base, rerun the required tests and final audit, then use `merge-authorization-gate` to decide whether the existing human authorization may persist. Do not silently mint a replacement receipt unless authorization remains valid under that persistence gate.

On the normal free-tier GitHub merge route, the merge API provides an expected-HEAD precondition but no atomic expected-base-SHA precondition. Therefore this gate is a **final observed-state check**, not a claim of an atomic base lock. The live route fetches receipt comments first, PR state next, and the live target-branch ref last so the base check does not depend on potentially stale PR `base.sha`; after PASS, perform no unrelated network or review work before the expected-HEAD merge call. A base advance in the residual gate-to-merge race window must be detected immediately by `post-merge-verification` as `BASE_SHA_DRIFT`. Do not describe this free-tier path as atomically preventing every possible base race; verified stronger server-side protection may provide a stronger barrier.

After merge, verify the PR is `MERGED` and `main` points at the reported merge commit. A receipt cannot authorize a different PR or HEAD, and a merged/closed PR fails the gate.

Execution-gate self-test:

```text
node .agents/skills/final-pr-audit/merge-execution-gate-selftest.mjs
```

### Cross-repository merge-execution gate

For several already-audited PRs that each have a valid exact-HEAD merge authorization receipt, use the read-only batch wrapper to collect comments first, PR state second, and the live base ref last, then reuse the single-PR merge-execution gate for every target:

```text
node .agents/skills/final-pr-audit/cross-repo-merge-execution-gate.mjs --collect-config <config.json>
```

A batch PASS may supply exact expected base/head values for subsequent merge API calls. The wrapper does **not** post authorization receipts, change Draft/Ready state, merge a PR, write a branch, or replace final-pr-audit. Any target failure makes the batch fail closed; do not merge a subset unless each remaining target is independently re-evaluated.

### Cross-repository merge executor

After the human has explicitly authorized the exact PR/HEAD targets and durable `MERGE_AUTHORIZATION_V1` receipts already exist on GitHub, use the local executor to remove repeated Ready/merge/post-merge orchestration:

```text
node .agents/skills/final-pr-audit/cross-repo-merge-executor.mjs --config <config.json>
node .agents/skills/final-pr-audit/cross-repo-merge-executor.mjs --config <config.json> --execute
```

Without `--execute`, the executor is read-only and returns only a plan. With `--execute`, it still must first prove a valid pre-existing exact-PR/exact-HEAD human authorization receipt for every open target; the executor must never create, synthesize, or infer authorization from a CLI flag, AI state, or config field.

The executor performs a read-only preflight for all targets before any mutation, marks only exact authorized Draft targets Ready, reuses the batch merge-execution gate, squash-merges with the exact audited HEAD precondition, and immediately verifies merged PR state, live `main`, merged tree equality, and single-parent equality to the audited base. On pre-merge failure it restores only PRs it changed from Draft to Ready. On partial merge/interruption it never replays a target already proven merged; remaining targets are restored to Draft when safe and may resume from durable GitHub state.

A previously merged target counts as resumable only when the exact audited HEAD still matches the PR, the merge commit tree matches the audited tree, the first/only parent equals the audited base, live `main` still points at that merge commit, and an exact authorization receipt existed **before** `merged_at`. Later approval is never retroactive authorization.
### Implementation Route Receipt Gate

`IMPLEMENTATION_ROUTE_RECEIPT_REQUIRED=YES`

For `implementation`, `bugfix`, `refactor`, and `design-with-source-write` changes, require a finalized `PASS` implementation-route receipt from `.agents/skills/preflight-audit/implementation-route-receipt.mjs` before `MERGE READY`. This binds the exact repository/branch/current HEAD so a stale or mismatched receipt fails closed rather than being reused by habit.

For a qualified-agent implementation route, verify against the actual local repository so the runner-generated change-set evidence is recomputed from the recorded `preHead` to the exact committed implementation HEAD:

```text
node .agents/skills/preflight-audit/implementation-route-receipt.mjs --input <final-receipt.json> --expect-owner <owner> --expect-name <repo> --expect-branch <branch> --expect-head <exact-current-head> --repo-root <local-repo-root> --pretty
```

- `MERGE_READY` requires the receipt's `stage: final` result to already be `PASS` and the repository/branch/head to exactly match the currently audited state; any mismatch returns a fail-closed repository/branch/head error and blocks `PREPARED_FOR_MERGE`.
- Qualified-agent receipts must carry runner-generated `preHead`, `changeSetSha256`, and the exact sorted `changedPaths`. Final verification recomputes the committed change set, including modified, deleted, and newly added files; missing or mismatched execution evidence blocks merge readiness.
- A missing receipt for an in-scope kind is a blocker, not `UNKNOWN`-and-proceed.
- Direct-browser implementation has no runner-generated change-set proof and is accepted only through the existing closed exception vocabulary (`HUMAN_EXPLICIT_DIRECT`, `TRIVIAL_SAFE_LOCAL_EDIT`, or `NO_QUALIFIED_EXECUTOR_LOWER_RISK_DIRECT`) with explicit justification/evidence.
- This receiving-side gate does not claim universal interception of browser turn start. It ensures that a qualified-agent implementation cannot become merge-ready without exact execution evidence, and it does not change merge-authorization semantics.

### Final Reality Check Gate

`FINAL_REALITY_CHECK_REQUIRED=YES`

At the start of final PR audit, require `.agents/skills/test-gate/staged-reality-gate.mjs` to return a `FINAL_REALITY_CHECK` PASS for the exact state being audited. Record:

```text
FINAL_REALITY_CHECK=PASS
FINAL_REALITY_STATE=<exact-state-id>
FINAL_REALITY_RECEIPT=<receipt-id>
```

The receipt must use task-appropriate objective evidence and include the existing successful `TEST_GATE_RESULT`; do not rerun tests solely to satisfy this receiving-side gate. If the source/diff/state changes after the receipt, the old receipt is stale and blocks merge readiness until the affected reality check is re-evaluated. A test PASS never substitutes for proof that the actual deliverable is the intended target.

For `UI_REFERENCE_REPRODUCTION`, independently confirm that the FINAL receipt contains verified state-bound `UI_MEASUREMENT` and `PROTECTED_FILES_CHECK` evidence. The PR evidence must identify the approved reference version and include the reference/actual/diff comparison, fixed check-ID results, minimum regression result, confirmation that protected preparation inputs were unchanged, and any AI-chosen behavior for states not shown in the reference. Screenshot/overlay/pixel diff remains supplemental and cannot override a numeric measurement FAIL. The independent audit checks the evidence and diff; it does not re-implement the UI or relax the preparation thresholds.

### Contract Conformance Gate

Functional verification and Contract Conformance are independent. Before `PREPARED_FOR_MERGE=yes`, rerun `.agents/skills/handoff/canonical-contract-gate.mjs` against the exact current HEAD contract and the audited implementation target/spec-use state.

Record:

```text
CONTRACT=<contract-id>@<contract-version>
CONTRACT_GATE=PASS
CANONICAL_TARGET=<slot>=<artifact-id>
SUPERSEDED_SPEC_USED=NO
```

A Functional Gate PASS never overrides Contract Gate FAIL. Missing/ambiguous CURRENT authority, use of a SUPERSEDED/HISTORICAL/DRAFT spec, a cross-project contract, or an implementation target different from the CURRENT artifact is a merge blocker. Normal Contract PASS adds no human confirmation.

When `human-decision-sync` is required, also run `.agents/skills/handoff/human-decision-sync.mjs` against the exact current HEAD `PROJECT_CONTEXT.json` and the decision IDs actually relied on by the audited change. `DECISION_CONFLICT`, `PROPOSED_DECISION_USED`, `UNRESOLVED_DECISION_USED`, missing required decision state, or human-decision worktree drift is a merge blocker. A confirmed decision may bind a canonical artifact only while that artifact remains CURRENT.

### `PREPARED_FOR_MERGE` criteria

Report `PREPARED_FOR_MERGE=yes` only when all applicable conditions are proven:

- final audit result is PASS;
- for `implementation` / `bugfix` / `refactor` / `design-with-source-write` changes, the Implementation Route Receipt Gate returns `MERGE_READY` for the exact current repository/branch/HEAD;
- Canonical Contract Gate is PASS for the exact audited implementation target, `SUPERSEDED_SPEC_USED=NO`, and the recorded contract ID/version still match the current HEAD;
- required `test-gate` and real-device/manual checks are PASS or explicitly unneeded;
- `FINAL_REALITY_CHECK=PASS` is bound to the exact state under final audit;
- PR description is consistent with verified facts;
- PR state matches the active protection mode: **Draft when Draft Lock Mode is required**, or the repository's verified stronger server-side protection policy otherwise;
- fresh GitHub metadata confirms the PR is open and has no known review/required-CI blocker; mergeability may remain blocked solely because the intentional Draft lock is still engaged;
- the current HEAD is the HEAD covered by the latest PASS audit;
- `AUDITED_BASE_SHA` records the exact base commit covered by that PASS audit, and the current **live target-branch ref SHA** still equals it; PR `base.sha` alone is not sufficient proof;
- if merge was already authorized before a HEAD change, `merge-authorization-gate` returns `PERSIST`; otherwise valid explicit merge authorization is still required before merge;
- no unresolved human value/ownership decision remains;
- no technical housekeeping step is being delegated to the non-engineer human.

If any condition is not proven, report `PREPARED_FOR_MERGE=no` and state the machine-resolvable blocker or genuine human decision separately.

## Execution-Route Failure

If an AI/tool/connector path fails while performing an already-authorized safe technical preparation step:

1. diagnose the failing route without changing the approved target, diff, SHA, or risk;
2. try another available and permitted machine-readable/execution route consistent with repository rules;
3. follow the approved-operation route-fallback rules (`L-0012` and, for GitHub-specific failures, `L-0010`) rather than repeating the same broken path;
4. do not convert the route failure into non-engineer relay work such as "click Ready for review", "copy this SHA", "run this Git command", or "paste the output back" merely because that is easier;
5. if no permitted machine route remains, stop with `EXECUTION_PATH_BLOCKED`, describe the tooling limitation, and keep the technical ownership on the AI workflow. Do not mislabel the user as a technical decider.

A route failure does not create a new human value decision. Human involvement is appropriate only if the underlying target/scope/risk changes or another genuine confirmation point applies.

## Command Notes

- Build output directories may be updated by a build command; verify tracked files remain unchanged afterward when a local workspace was used.
- For a migration checksum failure, first check for raw-byte or line-ending differences before treating it as a logic failure.
- If GitHub PR data is unavailable, mark GitHub-only checks unavailable rather than guessing or turning them into human browser homework when another machine-readable route can be used.
- Audit approval and pre-merge preparation are not merge execution.
- For post-implementation verification execution and result tracking, use `test-gate`; final PR audit checks the `test-gate` results rather than re-running everything from scratch.
- For actual post-merge verification and any required local `main` synchronization, use `post-merge-verification`.

## Output

Report:

- Final judgment
- `PREPARED_FOR_MERGE=yes|no`
- Evidence source(s): local / remote-only / mixed
- Git state relevant to those source(s)
- Diff scope
- Specification fit
- `CONTRACT=<id>@<version>`, `CONTRACT_GATE=PASS|FAIL`, canonical target(s), and `SUPERSEDED_SPEC_USED=YES|NO`
- Approved baseline preservation: `NONE` / `PRESERVED` / `AUTHORIZED_CHANGE` / `BLOCKER`
- Verification results, distinguishing literal commands from equivalent remote checks
- Security review result
- PR description consistency result
- Real-device confirmation
- Mechanical pre-merge preparation performed
- Merge authorization state: new approval required / `PERSIST` / `REAUTHORIZE` / `STOP`
- Route fallback performed, if any
- Blockers
- Merge readiness
- The remaining human action only when actually needed by the authorization state
- Operations not performed

## Application-Specific Configuration

The exact build/test/lint/type-check commands, dependency-manifest file names, migration conventions, forbidden scope, and repository-specific PR status conventions come from that repository's `AGENTS.local.md` — specifically its "Repository Commands", "Forbidden Scope", "Migration Rules", and PR/GitHub sections. This skill names no specific language, package manager, or framework.