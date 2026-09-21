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
assert.equal(classifyFiles(['templates/.claude/skills/test-gate/SKILL.md.template']).profile, 'GOVERNANCE_ONLY');

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

console.log('verification-scope-gate selftest: PASS');
