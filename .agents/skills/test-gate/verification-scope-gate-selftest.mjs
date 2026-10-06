#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluate, classifyFiles } from './verification-scope-gate.mjs';

assert.equal(classifyFiles(['docs/guide.md']).profile, 'DOCS_ONLY');
assert.equal(classifyFiles(['src/main.ts']).profile, 'FRONTEND_ONLY');
assert.equal(classifyFiles(['src-tauri/src/lib.rs']).profile, 'BACKEND_ONLY');
assert.equal(classifyFiles(['migrations/0009_x.sql']).profile, 'DB_MIGRATION');
assert.equal(classifyFiles(['Cargo.lock']).profile, 'DEPENDENCY_CHANGE');
assert.equal(classifyFiles(['src/main.ts', 'src-tauri/src/lib.rs']).profile, 'MIXED_RUNTIME');
assert.equal(classifyFiles(['.agents/skills/test-gate/SKILL.md']).profile, 'GOVERNANCE_ONLY');
assert.equal(classifyFiles(['tools/portfolio-governance-audit.mjs']).profile, 'GOVERNANCE_ONLY');
assert.equal(classifyFiles(['STATUS.md', 'PROJECT_CONTEXT.json']).profile, 'GOVERNANCE_ONLY');
assert.equal(classifyFiles(['templates/.claude/skills/test-gate/SKILL.md.template']).profile, 'GOVERNANCE_ONLY');
assert.equal(classifyFiles(['templates/AGENTS.index.md.template']).profile, 'GOVERNANCE_ONLY');
assert.equal(classifyFiles(['templates/ui-reference/reproduction/FIXED_SHAPES.json.template']).profile, 'GOVERNANCE_ONLY');

// Root runtime JS is accepted only as a companion to an already-clear frontend change.
assert.equal(classifyFiles(['app.js']).profile, 'UNKNOWN');
assert.equal(classifyFiles(['orders.js']).profile, 'UNKNOWN');
assert.equal(classifyFiles(['index.html', 'app.js', 'orders.js']).profile, 'FRONTEND_ONLY');
assert.equal(classifyFiles(['app/visual-snapshot.js', 'app.js', 'orders.js']).profile, 'FRONTEND_ONLY');

// Tooling/backend/test-like root JS remains fail-closed even beside a frontend anchor.
assert.equal(classifyFiles(['index.html', 'server.js']).profile, 'UNKNOWN');
assert.equal(classifyFiles(['index.html', 'build.js']).profile, 'UNKNOWN');
assert.equal(classifyFiles(['index.html', 'config.js']).profile, 'UNKNOWN');
assert.equal(classifyFiles(['index.html', 'visual.test.js']).profile, 'UNKNOWN');

let result = evaluate({
  changedFiles: ['docs/guide.md'],
  plannedChecks: ['DIFF_HYGIENE', 'DOCS_CONSISTENCY'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['docs/guide.md'],
  plannedChecks: ['DIFF_HYGIENE', 'DOCS_CONSISTENCY', 'BACKEND_FULL_TEST'],
});
assert.equal(result.code, 'EXCESSIVE_CHECKS_UNJUSTIFIED');

result = evaluate({
  changedFiles: ['src/main.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST', 'BACKEND_FULL_TEST'],
});
assert.equal(result.code, 'EXCESSIVE_CHECKS_UNJUSTIFIED');

result = evaluate({
  changedFiles: ['src/main.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['index.html', 'app/visual-snapshot.js', 'app.js', 'orders.js', 'scripts/visual-snapshot-frontend.test.js'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST'],
});
assert.equal(result.profile, 'FRONTEND_ONLY');
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['src-tauri/src/lib.rs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['migrations/0009_x.sql'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST', 'BACKEND_FULL_TEST', 'MIGRATION_TEST', 'FULL_REPOSITORY_SUITE'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['Cargo.lock'],
  plannedChecks: ['DIFF_HYGIENE', 'DEPENDENCY_AUDIT'],
});
assert.equal(result.code, 'REQUIRED_CHECK_MISSING');
assert.deepEqual(result.missingMinimumChecks, ['TARGETED_BACKEND_TEST', 'FULL_REPOSITORY_SUITE']);

result = evaluate({
  changedFiles: ['Cargo.lock', 'migrations/0009_x.sql'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST', 'BACKEND_FULL_TEST', 'MIGRATION_TEST', 'DEPENDENCY_AUDIT', 'FULL_REPOSITORY_SUITE'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['package-lock.json', 'src/main.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST', 'DEPENDENCY_AUDIT', 'FULL_REPOSITORY_SUITE'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['docs/guide.md'],
  plannedChecks: ['DIFF_HYGIENE', 'DOCS_CONSISTENCY', 'FULL_REPOSITORY_SUITE'],
  escalationReason: 'RELEASE_GATE',
});
assert.equal(result.decision, 'PROCEED_ESCALATED');

result = evaluate({
  changedFiles: ['weird/file.xyz'],
  plannedChecks: ['DIFF_HYGIENE'],
});
assert.equal(result.code, 'CHANGE_SCOPE_UNKNOWN');

// Root index.html is frontend; unrelated scripts/*.ts is not classified as frontend.
assert.equal(classifyFiles(['index.html']).profile, 'FRONTEND_ONLY');
assert.equal(classifyFiles(['scripts/build-release.ts']).profile, 'UNKNOWN');

// Narrow frontend-verification-script predicate.
assert.equal(classifyFiles(['scripts/home-stage-scale.selftest.ts']).profile, 'FRONTEND_ONLY');
assert.equal(classifyFiles(['scripts/home-invoice-pending.selftest.ts']).profile, 'FRONTEND_ONLY');
assert.equal(classifyFiles(['scripts/ui-layout-smoke.check.js']).profile, 'FRONTEND_ONLY');

// Required PASS selftest: index.html + src file + frontend-verification-script => FRONTEND_ONLY, PROCEED.
result = evaluate({
  changedFiles: ['index.html', 'src/home.ts', 'scripts/home-stage-scale.selftest.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST'],
});
assert.equal(result.profile, 'FRONTEND_ONLY');
assert.equal(result.decision, 'PROCEED');

// Negative: unknown extension with no clear purpose/semantics stays UNKNOWN/STOP.
result = evaluate({
  changedFiles: ['weird/file.xyz'],
  plannedChecks: ['DIFF_HYGIENE'],
});
assert.equal(result.decision, 'STOP');
assert.equal(result.code, 'CHANGE_SCOPE_UNKNOWN');

// Negative: migration change is DB_MIGRATION, not frontend-only, even alongside frontend files.
result = evaluate({
  changedFiles: ['migrations/0010_add_column.sql', 'src/home.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST', 'BACKEND_FULL_TEST', 'MIGRATION_TEST', 'FULL_REPOSITORY_SUITE'],
});
assert.equal(result.profile, 'DB_MIGRATION');
assert.notEqual(result.profile, 'FRONTEND_ONLY');

// Negative: backend change is BACKEND_ONLY, not frontend-only.
result = evaluate({
  changedFiles: ['src-tauri/src/lib.rs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.notEqual(result.profile, 'FRONTEND_ONLY');

// Negative: dependency change is DEPENDENCY_CHANGE, not frontend-only, even with frontend deps.
result = evaluate({
  changedFiles: ['package-lock.json'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST', 'DEPENDENCY_AUDIT', 'FULL_REPOSITORY_SUITE'],
});
assert.equal(result.profile, 'DEPENDENCY_CHANGE');
assert.notEqual(result.profile, 'FRONTEND_ONLY');

// --- Gateway vocabulary integration -------------------------------------

// User example 1 (exact required path): gateway/viewer-core.mjs is backend.
assert.equal(classifyFiles(['gateway/viewer-core.mjs']).profile, 'BACKEND_ONLY');

// User example 2 (exact required path): gateway/viewer-server.mjs is backend.
assert.equal(classifyFiles(['gateway/viewer-server.mjs']).profile, 'BACKEND_ONLY');

// User example 3 (exact required path): gateway/receiver.mjs is backend.
assert.equal(classifyFiles(['gateway/receiver.mjs']).profile, 'BACKEND_ONLY');

// Preserved nested coverage: gateway/viewer-core/** nested runtime path is backend.
assert.equal(classifyFiles(['gateway/viewer-core/index.ts']).profile, 'BACKEND_ONLY');

// Preserved nested coverage: gateway/viewer-server/** nested runtime path is backend.
assert.equal(classifyFiles(['gateway/viewer-server/server.ts']).profile, 'BACKEND_ONLY');

// Preserved nested coverage: gateway/receiver/** nested runtime path is backend.
assert.equal(classifyFiles(['gateway/receiver/handler.ts']).profile, 'BACKEND_ONLY');

// User example 4 (dedicated test): scripts/gateway-viewer-phase8.test.mjs is backend.
assert.equal(classifyFiles(['scripts/gateway-viewer-phase8.test.mjs']).profile, 'BACKEND_ONLY');

// User example 5 (dedicated test): scripts/gateway-receiver-e2e.test.mjs is backend.
assert.equal(classifyFiles(['scripts/gateway-receiver-e2e.test.mjs']).profile, 'BACKEND_ONLY');

// Future gateway test names remain recognized by the narrow reusable predicate
// without hardcoding specific repository names.
assert.equal(classifyFiles(['scripts/gateway-sync-worker.selftest.ts']).profile, 'BACKEND_ONLY');
assert.equal(classifyFiles(['scripts/gateway-metrics-queue.spec.js']).profile, 'BACKEND_ONLY');
assert.equal(classifyFiles(['scripts/gateway.test.mjs']).profile, 'BACKEND_ONLY');

// Negative: unrelated scripts file stays UNKNOWN.
assert.equal(classifyFiles(['scripts/unrelated.js']).profile, 'UNKNOWN');

// Negative: scripts/gateway-tools.js has the gateway segment but no delimited
// test/selftest/spec semantic segment, and is not under a gateway/ directory.
assert.equal(classifyFiles(['scripts/gateway-tools.js']).profile, 'UNKNOWN');

// Negative: misleading names must not match via substring.
// "gatewayish" is not the delimited segment "gateway".
assert.equal(classifyFiles(['scripts/gatewayish-test.js']).profile, 'UNKNOWN');
// "contest" is not the delimited segment "test".
assert.equal(classifyFiles(['scripts/gateway-contest.js']).profile, 'UNKNOWN');

// Negative: singular script/** (not scripts/**) is not matched by the
// dedicated-test predicate and is not a gateway/ directory, so it remains UNKNOWN.
assert.equal(classifyFiles(['script/gateway-test.js']).profile, 'UNKNOWN');

// Frontend regression: existing frontend-only classification is unaffected.
assert.equal(classifyFiles(['src/main.ts']).profile, 'FRONTEND_ONLY');

// Backend regression: existing backend-only classification is unaffected.
assert.equal(classifyFiles(['src-tauri/src/lib.rs']).profile, 'BACKEND_ONLY');

// Mixed regression: pre-existing frontend+backend mix is still MIXED_RUNTIME.
assert.equal(classifyFiles(['src/main.ts', 'src-tauri/src/lib.rs']).profile, 'MIXED_RUNTIME');

// Gateway + frontend mixed: a gateway backend path alongside a frontend path
// is MIXED_RUNTIME, not BACKEND_ONLY or FRONTEND_ONLY.
assert.equal(classifyFiles(['gateway/receiver/handler.ts', 'src/main.ts']).profile, 'MIXED_RUNTIME');

// Precedence: dependency classification still wins over a gateway directory path.
assert.equal(classifyFiles(['gateway/package-lock.json']).profile, 'DEPENDENCY_CHANGE');

// Precedence: migration classification still wins over a gateway directory path.
assert.equal(classifyFiles(['gateway/migrations/0001_init.sql']).profile, 'DB_MIGRATION');

// Precedence: governance classification still wins over a gateway directory path.
assert.equal(classifyFiles(['.agents/gateway/notes.md']).profile, 'GOVERNANCE_ONLY');

// Precedence: docs classification still wins over a gateway dedicated test name
// when the file is actually a markdown doc, not a .js|.ts|.mjs script.
assert.equal(classifyFiles(['docs/gateway-test-notes.md']).profile, 'DOCS_ONLY');

// Backend wins over frontend viewer semantics for a gateway dedicated test:
// evaluated alongside an explicit frontend file, the set is MIXED_RUNTIME
// (backend recognized), never collapsed into FRONTEND_ONLY.
result = evaluate({
  changedFiles: ['scripts/gateway-viewer-phase8.test.mjs', 'src/main.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'MIXED_RUNTIME');
assert.equal(result.decision, 'PROCEED');

// evaluate(): gateway-only change with required backend test plan proceeds.
result = evaluate({
  changedFiles: ['gateway/receiver/handler.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.equal(result.decision, 'PROCEED');

// evaluate(): dedicated gateway script test alone also requires backend test plan.
result = evaluate({
  changedFiles: ['scripts/gateway-receiver-e2e.test.mjs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.equal(result.decision, 'PROCEED');

// evaluate(): missing the required backend check for a gateway change stops.
result = evaluate({
  changedFiles: ['gateway/receiver/handler.ts'],
  plannedChecks: ['DIFF_HYGIENE'],
});
assert.equal(result.code, 'REQUIRED_CHECK_MISSING');
assert.deepEqual(result.missingMinimumChecks, ['TARGETED_BACKEND_TEST']);

// evaluate(): unrelated/unknown scripts change (vs the gateway backend case
// above) stays CHANGE_SCOPE_UNKNOWN and must STOP rather than PROCEED.
result = evaluate({
  changedFiles: ['scripts/unrelated.js'],
  plannedChecks: ['DIFF_HYGIENE'],
});
assert.equal(result.decision, 'STOP');
assert.equal(result.code, 'CHANGE_SCOPE_UNKNOWN');

// evaluate(): exact required path gateway/viewer-core.mjs alone proceeds
// as BACKEND_ONLY with the required backend test plan.
result = evaluate({
  changedFiles: ['gateway/viewer-core.mjs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.equal(result.decision, 'PROCEED');

// evaluate(): exact required path gateway/viewer-server.mjs alone proceeds
// as BACKEND_ONLY with the required backend test plan.
result = evaluate({
  changedFiles: ['gateway/viewer-server.mjs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.equal(result.decision, 'PROCEED');

// evaluate(): exact required path gateway/receiver.mjs alone proceeds
// as BACKEND_ONLY with the required backend test plan.
result = evaluate({
  changedFiles: ['gateway/receiver.mjs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.equal(result.decision, 'PROCEED');

// --- Frontend anchor leakage from gateway dedicated backend tests -------
//
// A dedicated backend gateway script test must never manufacture a
// frontend companion anchor for an unrelated root JS file. Previously
// hasStrongFrontendAnchor was computed before backend classification, so
// scripts/gateway-ui.test.mjs (itself backend via
// isGatewayDedicatedScriptTest) matched FRONTEND_VERIFICATION_SCRIPT_RE's
// loose substring lookaheads ("ui", "test") and created a false anchor,
// pulling orders.js into the frontend bucket and producing MIXED_RUNTIME.

// Negative: backend-only dedicated gateway test alone stays BACKEND_ONLY.
assert.equal(classifyFiles(['scripts/gateway-ui.test.mjs']).profile, 'BACKEND_ONLY');

// Negative: a frontend-looking gateway directory path (contains "ui") is
// still backend because BACKEND_RE (gateway/ prefix) wins, and it must not
// leak a frontend anchor either.
assert.equal(classifyFiles(['gateway/ui/render.js']).profile, 'BACKEND_ONLY');

// Negative: the dedicated backend test beside an unrelated root JS file
// must NOT become MIXED_RUNTIME via a false companion anchor. With no real
// frontend anchor present, orders.js remains unclassified (UNKNOWN).
assert.equal(classifyFiles(['scripts/gateway-ui.test.mjs', 'orders.js']).profile, 'UNKNOWN');
assert.notEqual(classifyFiles(['scripts/gateway-ui.test.mjs', 'orders.js']).profile, 'MIXED_RUNTIME');

// Negative: a frontend-looking gateway directory path beside an unrelated
// root JS file must likewise not fabricate a frontend anchor.
assert.equal(classifyFiles(['gateway/ui/render.js', 'orders.js']).profile, 'UNKNOWN');
assert.notEqual(classifyFiles(['gateway/ui/render.js', 'orders.js']).profile, 'MIXED_RUNTIME');

// Positive: a genuine frontend anchor (root index.html) alongside the
// dedicated backend gateway test is correctly MIXED_RUNTIME — real
// frontend anchors are preserved, only the false ones are excluded.
assert.equal(classifyFiles(['index.html', 'scripts/gateway-ui.test.mjs']).profile, 'MIXED_RUNTIME');

// Positive: a genuine frontend anchor still allows a root JS companion to
// be classified as frontend when no gateway/backend file is involved.
assert.equal(classifyFiles(['index.html', 'orders.js']).profile, 'FRONTEND_ONLY');

// evaluate(): the backend-only dedicated gateway test case proceeds with
// the required backend test plan (no spurious FRONTEND_BUILD required).
result = evaluate({
  changedFiles: ['scripts/gateway-ui.test.mjs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.equal(result.decision, 'PROCEED');

// evaluate(): the genuine mixed case (real frontend anchor + dedicated
// backend gateway test) requires both frontend and backend checks.
result = evaluate({
  changedFiles: ['index.html', 'scripts/gateway-ui.test.mjs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.profile, 'MIXED_RUNTIME');
assert.equal(result.decision, 'PROCEED');

// --- Proportionate verification regression cases (2026-10-05) ---------
result = evaluate({
  changedFiles: ['src-tauri/src/import/categories.rs'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST'],
});
assert.equal(result.decision, 'PROCEED');
assert.equal(result.verificationLevel, 'TARGETED');
assert.deepEqual(result.minimumChecks, ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST']);

result = evaluate({
  changedFiles: ['src/components/InvoiceBadge.tsx'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_FRONTEND_TEST'],
});
assert.equal(result.decision, 'PROCEED');
assert.equal(result.verificationLevel, 'TARGETED');
assert.equal(result.excessiveChecks.includes('FULL_REPOSITORY_SUITE'), false);

result = evaluate({
  changedFiles: ['migrations/0011_add_invoice_index.sql'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_BACKEND_TEST', 'BACKEND_FULL_TEST', 'MIGRATION_TEST', 'FULL_REPOSITORY_SUITE'],
});
assert.equal(result.decision, 'PROCEED');
assert.equal(result.verificationLevel, 'FULL');

result = evaluate({
  changedFiles: ['docs/verification-cost.md'],
  plannedChecks: ['DIFF_HYGIENE', 'DOCS_CONSISTENCY'],
});
assert.equal(result.decision, 'PROCEED');
assert.equal(result.verificationLevel, 'MINIMAL');

result = evaluate({
  changedFiles: ['docs/release-note.md'],
  plannedChecks: ['DIFF_HYGIENE', 'DOCS_CONSISTENCY', 'FULL_REPOSITORY_SUITE'],
  escalationReason: 'RELEASE_GATE',
});
assert.equal(result.decision, 'PROCEED_ESCALATED');
assert.equal(result.verificationLevel, 'FULL');

console.log('verification-scope-gate selftest: PASS');
