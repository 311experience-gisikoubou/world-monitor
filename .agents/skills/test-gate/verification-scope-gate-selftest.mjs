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
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_SELFTEST', 'FRONTEND_BUILD', 'BACKEND_FULL_TEST'],
});
assert.equal(result.code, 'EXCESSIVE_CHECKS_UNJUSTIFIED');

result = evaluate({
  changedFiles: ['src/main.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_SELFTEST', 'FRONTEND_BUILD'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['index.html', 'app/visual-snapshot.js', 'app.js', 'orders.js', 'scripts/visual-snapshot-frontend.test.js'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_SELFTEST', 'FRONTEND_BUILD'],
});
assert.equal(result.profile, 'FRONTEND_ONLY');
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['src-tauri/src/lib.rs'],
  plannedChecks: ['DIFF_HYGIENE', 'BACKEND_FULL_TEST'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['migrations/0009_x.sql'],
  plannedChecks: ['DIFF_HYGIENE', 'BACKEND_FULL_TEST', 'MIGRATION_TEST'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['Cargo.lock'],
  plannedChecks: ['DIFF_HYGIENE', 'DEPENDENCY_AUDIT'],
});
assert.equal(result.code, 'REQUIRED_CHECK_MISSING');
assert.deepEqual(result.missingMinimumChecks, ['BACKEND_FULL_TEST']);

result = evaluate({
  changedFiles: ['Cargo.lock', 'migrations/0009_x.sql'],
  plannedChecks: ['DIFF_HYGIENE', 'BACKEND_FULL_TEST', 'MIGRATION_TEST', 'DEPENDENCY_AUDIT'],
});
assert.equal(result.decision, 'PROCEED');

result = evaluate({
  changedFiles: ['package-lock.json', 'src/main.ts'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_SELFTEST', 'FRONTEND_BUILD', 'DEPENDENCY_AUDIT'],
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
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_SELFTEST', 'FRONTEND_BUILD'],
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
  plannedChecks: ['DIFF_HYGIENE', 'BACKEND_FULL_TEST', 'MIGRATION_TEST'],
});
assert.equal(result.profile, 'DB_MIGRATION');
assert.notEqual(result.profile, 'FRONTEND_ONLY');

// Negative: backend change is BACKEND_ONLY, not frontend-only.
result = evaluate({
  changedFiles: ['src-tauri/src/lib.rs'],
  plannedChecks: ['DIFF_HYGIENE', 'BACKEND_FULL_TEST'],
});
assert.equal(result.profile, 'BACKEND_ONLY');
assert.notEqual(result.profile, 'FRONTEND_ONLY');

// Negative: dependency change is DEPENDENCY_CHANGE, not frontend-only, even with frontend deps.
result = evaluate({
  changedFiles: ['package-lock.json'],
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_SELFTEST', 'FRONTEND_BUILD', 'DEPENDENCY_AUDIT'],
});
assert.equal(result.profile, 'DEPENDENCY_CHANGE');
assert.notEqual(result.profile, 'FRONTEND_ONLY');

console.log('verification-scope-gate selftest: PASS');
