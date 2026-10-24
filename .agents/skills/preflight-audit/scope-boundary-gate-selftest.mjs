#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyScopeBoundary } from './scope-boundary-gate.mjs';

const scriptPath = fileURLToPath(new URL('./scope-boundary-gate.mjs', import.meta.url));
const ROOT = 'acme/app';
const RELATED = 'acme/app-related';
const OTHER = 'acme/unrelated-app';

function base(overrides = {}) {
  return {
    schemaVersion: 1,
    activeProjectContextId: 'ai-common-platform-v1',
    activeProjectRootRepository: ROOT,
    approvedRelatedRepositories: [RELATED],
    requestedAction: 'CREATE_PR',
    requestedTargetRepository: ROOT,
    approvedTaskScopePaths: ['.agents/skills/preflight-audit/**'],
    requestedChangePaths: ['.agents/skills/preflight-audit/scope-boundary-gate.mjs'],
    explicitHumanScopeApproval: false,
    humanApprovalDecisionId: null,
    ...overrides,
  };
}

// 1. Covered scope on the Project Root repository is IN_SCOPE and proceeds.
{
  const r = classifyScopeBoundary(base());
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'IN_SCOPE');
  assert.equal(r.allowCreate, true);
  assert.equal(r.code, 'SCOPE_BOUNDARY_CLEAR');
}

// 2. Uncovered paths on the Project Root repository are NEW_SCOPE and blocked without approval.
{
  const r = classifyScopeBoundary(base({ requestedChangePaths: ['OPERATIONS.md'] }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.classification, 'NEW_SCOPE');
  assert.equal(r.allowCreate, false);
  assert.equal(r.code, 'SCOPE_EXPANSION_REQUIRES_HUMAN_CONFIRMATION');
}

// 3. The same NEW_SCOPE request proceeds once explicit human approval is recorded.
{
  const r = classifyScopeBoundary(base({
    requestedChangePaths: ['OPERATIONS.md'],
    explicitHumanScopeApproval: true,
    humanApprovalDecisionId: 'decision-283-scope-expand',
  }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'NEW_SCOPE');
  assert.equal(r.allowCreate, true);
  assert.equal(r.code, 'SCOPE_EXPANSION_HUMAN_APPROVED');
  assert.equal(r.humanApprovalDecisionId, 'decision-283-scope-expand');
}

// 4. A target repository outside root/approved-related is CROSS_PROJECT and blocked without approval.
{
  const r = classifyScopeBoundary(base({ requestedTargetRepository: OTHER }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.classification, 'CROSS_PROJECT');
  assert.equal(r.allowCreate, false);
}

// 5. The same CROSS_PROJECT request proceeds once explicit human approval is recorded.
{
  const r = classifyScopeBoundary(base({
    requestedTargetRepository: OTHER,
    explicitHumanScopeApproval: true,
    humanApprovalDecisionId: 'decision-283-cross-project',
  }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'CROSS_PROJECT');
  assert.equal(r.allowCreate, true);
}

// 6. An approved related repository with unknown approved task scope is NEW_SCOPE (cannot verify coverage).
{
  const r = classifyScopeBoundary(base({ requestedTargetRepository: RELATED, approvedTaskScopePaths: null }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.classification, 'NEW_SCOPE');
  assert.equal(r.repoClass, 'RELATED_APPROVED');
}

// 7. Repository boundary is evaluated before the comment exemption: a comment on an unapproved repo is still CROSS_PROJECT.
{
  const r = classifyScopeBoundary(base({
    requestedAction: 'CREATE_ISSUE_COMMENT',
    requestedTargetRepository: OTHER,
    requestedChangePaths: null,
  }));
  assert.equal(r.classification, 'CROSS_PROJECT');
  assert.equal(r.result, 'STOP');
}

// 8. A comment action on the Project Root repository is IN_SCOPE regardless of task-scope paths.
{
  const r = classifyScopeBoundary(base({
    requestedAction: 'CREATE_PR_COMMENT',
    requestedChangePaths: null,
    approvedTaskScopePaths: null,
  }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'IN_SCOPE');
}

// 9. A comment action must not declare requestedChangePaths.
{
  const r = classifyScopeBoundary(base({ requestedAction: 'CREATE_ISSUE_COMMENT' }));
  assert.equal(r.classification, 'UNKNOWN');
  assert.equal(r.code, 'SCOPE_BOUNDARY_PATHS_INVALID');
}

// 10. Unsupported schemaVersion fails closed as UNKNOWN.
{
  const r = classifyScopeBoundary(base({ schemaVersion: 2 }));
  assert.equal(r.classification, 'UNKNOWN');
  assert.equal(r.code, 'SCOPE_BOUNDARY_SCHEMA_UNSUPPORTED');
}

// 11. Extra/missing keys fail closed as UNKNOWN.
{
  const extra = { ...base(), extraField: 'x' };
  const r = classifyScopeBoundary(extra);
  assert.equal(r.classification, 'UNKNOWN');
  assert.equal(r.code, 'SCOPE_BOUNDARY_EVIDENCE_INVALID');
}

// 12. An invalid requestedAction fails closed.
{
  const r = classifyScopeBoundary(base({ requestedAction: 'DELETE_ISSUE' }));
  assert.equal(r.code, 'SCOPE_BOUNDARY_ACTION_INVALID');
}

// 13. A malformed target repository identifier fails closed.
{
  const r = classifyScopeBoundary(base({ requestedTargetRepository: 'not-a-repo' }));
  assert.equal(r.code, 'SCOPE_BOUNDARY_TARGET_REPO_INVALID');
}

// 14. The Project Root repository must never also appear in approvedRelatedRepositories.
{
  const r = classifyScopeBoundary(base({ approvedRelatedRepositories: [ROOT] }));
  assert.equal(r.code, 'SCOPE_BOUNDARY_RELATED_REPOS_INVALID');
}

// 15. Path traversal segments in requestedChangePaths fail closed.
{
  const r = classifyScopeBoundary(base({ requestedChangePaths: ['../OPERATIONS.md'] }));
  assert.equal(r.code, 'SCOPE_BOUNDARY_PATHS_INVALID');
}

// 16. explicitHumanScopeApproval=true without a decision id fails closed.
{
  const r = classifyScopeBoundary(base({ explicitHumanScopeApproval: true }));
  assert.equal(r.code, 'SCOPE_BOUNDARY_APPROVAL_DECISION_ID_MISSING');
}

// 17. A decision id supplied without the approval flag fails closed (inconsistent evidence).
{
  const r = classifyScopeBoundary(base({ humanApprovalDecisionId: 'decision-x' }));
  assert.equal(r.code, 'SCOPE_BOUNDARY_APPROVAL_FLAG_INCONSISTENT');
}

// 18. A trailing '/**' approved scope path covers a child file by the same closed ScopePaths syntax
// already certified by implementation-runner.mjs (positive wildcard match).
{
  const r = classifyScopeBoundary(base({
    approvedTaskScopePaths: ['.agents/skills/preflight-audit/**'],
    requestedChangePaths: ['.agents/skills/preflight-audit/example.mjs'],
  }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'IN_SCOPE');
}

// 19. An exact approved scope path covers only that exact requested path (exact match).
{
  const r = classifyScopeBoundary(base({
    approvedTaskScopePaths: ['.agents/skills/preflight-audit/example.mjs'],
    requestedChangePaths: ['.agents/skills/preflight-audit/example.mjs'],
  }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'IN_SCOPE');
}

// 20. A sibling directory that merely shares a string prefix with a '/**'-approved directory must not be
// treated as covered (sibling prefix collision); it correctly remains NEW_SCOPE and is blocked.
{
  const r = classifyScopeBoundary(base({
    approvedTaskScopePaths: ['.agents/skills/preflight-audit/**'],
    requestedChangePaths: ['.agents/skills/preflight-audit-sibling/example.mjs'],
  }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.classification, 'NEW_SCOPE');
}

// Issue #283 narrow certified correction: exact ScopePaths semantics audit
// matrix. These four cases must match implementation-runner.mjs's
// pathMatchesScopePattern EXACTLY -- never granting broader scope than that
// canonical helper would.

// 20b. approved 'src/**' -> requested 'src/a.js': PASS (directory wildcard covers child).
{
  const r = classifyScopeBoundary(base({
    approvedTaskScopePaths: ['src/**'],
    requestedChangePaths: ['src/a.js'],
  }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'IN_SCOPE');
}

// 20c. Negative regression: approved 'src' (no '/**') -> requested 'src/a.js' must FAIL
// (NEW_SCOPE, blocked). A bare directory path with no trailing '/**' covers ONLY the
// exact path 'src', never its children by prefix. This is the exact defect the prior
// audit found (previously incorrectly classified IN_SCOPE/PROCEED).
{
  const r = classifyScopeBoundary(base({
    approvedTaskScopePaths: ['src'],
    requestedChangePaths: ['src/a.js'],
  }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.classification, 'NEW_SCOPE');
  assert.equal(r.allowCreate, false);
}

// 20d. approved 'src' -> requested 'src': PASS (exact match of the bare path itself).
{
  const r = classifyScopeBoundary(base({
    approvedTaskScopePaths: ['src'],
    requestedChangePaths: ['src'],
  }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.classification, 'IN_SCOPE');
}

// 20e. approved 'src/**' -> requested 'src-other/a.js': PASS rejection (sibling prefix
// collision is never mistaken for a covered child; correctly NEW_SCOPE/blocked).
{
  const r = classifyScopeBoundary(base({
    approvedTaskScopePaths: ['src/**'],
    requestedChangePaths: ['src-other/a.js'],
  }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.classification, 'NEW_SCOPE');
  assert.equal(r.allowCreate, false);
}

// 21. CLI: a PROCEED case exits 0 and emits PROCEED JSON.
{
  const dir = mkdtempSync(join(tmpdir(), 'scope-boundary-'));
  try {
    const file = join(dir, 'evidence.json');
    writeFileSync(file, JSON.stringify(base()));
    const res = spawnSync(process.execPath, [scriptPath, '--evidence-file', file], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.result, 'PROCEED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 22. CLI: a STOP case exits non-zero.
{
  const dir = mkdtempSync(join(tmpdir(), 'scope-boundary-'));
  try {
    const file = join(dir, 'evidence.json');
    writeFileSync(file, JSON.stringify(base({ requestedChangePaths: ['OPERATIONS.md'] })));
    const res = spawnSync(process.execPath, [scriptPath, '--evidence-file', file], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.result, 'STOP');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 23. CLI: malformed/duplicated arguments fail closed as UNKNOWN.
{
  const res = spawnSync(process.execPath, [scriptPath, '--evidence-file', 'a', '--evidence-json', '{}'], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.classification, 'UNKNOWN');
}

console.log('scope-boundary-gate-selftest: all assertions passed');
