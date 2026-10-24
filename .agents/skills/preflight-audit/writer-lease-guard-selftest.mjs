#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateWriterLease } from './writer-lease-guard.mjs';

const scriptPath = fileURLToPath(new URL('./writer-lease-guard.mjs', import.meta.url));
const REPO = 'acme/app';
const NOW = 1_000_000_000;
const TTL = 3_600_000;

function base(overrides = {}) {
  return {
    schemaVersion: 1,
    targetRepository: REPO,
    targetPrNumber: 42,
    targetIssueNumber: null,
    nowMs: NOW,
    leaseTtlMs: TTL,
    claims: [],
    requestedWriterId: 'claude-job:job-1',
    requestedWriterKind: 'AI_JOB',
    forceOverride: false,
    explicitHumanOverrideApproved: false,
    mergeReadinessEvidence: null,
    ...overrides,
  };
}
function pidClaim(overrides = {}) {
  return { writerId: 'claude-job:job-1', writerKind: 'AI_JOB', claimedAtMs: NOW - 1000, evidenceKind: 'PID_LEASE', pid: 1234, processStartMs: NOW - 5000, live: true, ...overrides };
}
function declaredClaim(overrides = {}) {
  return { writerId: 'human:alice', writerKind: 'HUMAN', claimedAtMs: NOW - 1000, evidenceKind: 'HUMAN_DECLARED', pid: null, processStartMs: null, live: null, ...overrides };
}

// 1. No active claims: a new writer is granted a fresh lease.
{
  const r = evaluateWriterLease(base());
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'LEASE_GRANTED_NEW_WRITER');
  assert.equal(r.activeWriterCount, 0);
  assert.equal(r.canMerge, false);
}

// 2. The same writer already holding the only active lease continues.
{
  const r = evaluateWriterLease(base({ claims: [pidClaim()] }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'CONTINUE_EXISTING_WRITER');
  assert.equal(r.activeWriterCount, 1);
}

// 3. A different active writer blocks the request without override.
{
  const r = evaluateWriterLease(base({ claims: [declaredClaim()] }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.code, 'WRITER_LEASE_HELD_BY_OTHER');
  assert.equal(r.holderWriterId, 'human:alice');
}

// 4. The same case proceeds as an explicit human-approved override.
{
  const r = evaluateWriterLease(base({ claims: [declaredClaim()], forceOverride: true, explicitHumanOverrideApproved: true }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'OVERRIDE_GRANTED');
  assert.equal(r.previousWriterId, 'human:alice');
  assert.equal(r.grantedWriterId, 'claude-job:job-1');
}

// 5. Given pre-supplied evidence that already names two distinct simultaneously-active claims, the pure
// evaluator fails closed with WRITER_RACE_DETECTED, even when the requester is one of them. This checks
// the STOP branch of a single evaluator call against fixed input; it is NOT a test of real concurrent
// processes racing to acquire a lease and proves no atomic mutual exclusion (see test 5b below, and the
// honesty-boundary comment at the top of writer-lease-guard.mjs).
{
  const r = evaluateWriterLease(base({ claims: [pidClaim(), declaredClaim()] }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.code, 'WRITER_RACE_DETECTED');
  assert.deepEqual(r.conflictingWriterIds, ['claude-job:job-1', 'human:alice'].sort());
}

// 5b. Documented non-atomicity: this module holds no shared state. Two different requesters calling the
// pure function concurrently, each unaware of the other because neither yet has the other's claim in its
// own `claims` evidence, each legitimately receive LEASE_GRANTED_NEW_WRITER. This is NOT an actual race
// test and must never be read as proof of atomic single-writer enforcement; it documents the known
// limitation so it cannot be silently reinterpreted as a passing concurrency guarantee.
{
  const rA = evaluateWriterLease(base({ requestedWriterId: 'claude-job:job-A', claims: [] }));
  const rB = evaluateWriterLease(base({ requestedWriterId: 'claude-job:job-B', claims: [] }));
  assert.equal(rA.decision, 'LEASE_GRANTED_NEW_WRITER');
  assert.equal(rB.decision, 'LEASE_GRANTED_NEW_WRITER');
}

// 6. An expired claim from another writer no longer blocks a new lease.
{
  const r = evaluateWriterLease(base({ claims: [declaredClaim({ claimedAtMs: NOW - TTL - 1 })] }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'LEASE_GRANTED_NEW_WRITER');
}

// 7. A PID lease claim with live=false is not active.
{
  const r = evaluateWriterLease(base({ claims: [pidClaim({ writerId: 'claude-job:job-2', live: false })] }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'LEASE_GRANTED_NEW_WRITER');
}

// 7b. A still-live PID lease claim MUST NOT lose ownership solely because its age exceeds leaseTtlMs.
// Liveness (already caller-reverified) is ground truth for PID_LEASE claims, independent of elapsed time.
{
  const r = evaluateWriterLease(base({ claims: [pidClaim({ claimedAtMs: NOW - TTL - 1_000_000, live: true })] }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'CONTINUE_EXISTING_WRITER');
  assert.equal(r.activeWriterCount, 1);
}

// 7c. By contrast, a declared (non-PID) claim with no independent liveness signal still expires by age,
// confirming the TTL fix narrows correctly to only the evidence kinds that lack process-liveness proof.
{
  const r = evaluateWriterLease(base({ claims: [declaredClaim({ claimedAtMs: NOW - TTL - 1_000_000 })] }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'LEASE_GRANTED_NEW_WRITER');
}

// 8. A future-dated claim is never trusted as active.
{
  const r = evaluateWriterLease(base({ claims: [declaredClaim({ claimedAtMs: NOW + 1 })] }));
  assert.equal(r.result, 'PROCEED');
  assert.equal(r.decision, 'LEASE_GRANTED_NEW_WRITER');
}

// 9. A FAIL test result blocks merge readiness even on a clean lease grant.
{
  const r = evaluateWriterLease(base({ mergeReadinessEvidence: { testResult: 'FAIL', branchMatches: true } }));
  assert.equal(r.canMerge, false);
}

// 10. A PASS test result plus matching branch allows merge readiness.
{
  const r = evaluateWriterLease(base({ mergeReadinessEvidence: { testResult: 'PASS', branchMatches: true } }));
  assert.equal(r.canMerge, true);
}

// 11. COVERAGE_UNKNOWN blocks merge readiness.
{
  const r = evaluateWriterLease(base({ mergeReadinessEvidence: { testResult: 'COVERAGE_UNKNOWN', branchMatches: true } }));
  assert.equal(r.canMerge, false);
}

// 12. A branch mismatch blocks merge readiness even with PASS tests.
{
  const r = evaluateWriterLease(base({ mergeReadinessEvidence: { testResult: 'PASS', branchMatches: false } }));
  assert.equal(r.canMerge, false);
}

// 13. A malformed claim (extra key) fails the whole evaluation closed.
{
  const r = evaluateWriterLease(base({ claims: [{ ...pidClaim(), extra: true }] }));
  assert.equal(r.result, 'STOP');
  assert.equal(r.code, 'WRITER_LEASE_CLAIM_INVALID');
}

// 14. explicitHumanOverrideApproved without forceOverride is inconsistent evidence.
{
  const r = evaluateWriterLease(base({ explicitHumanOverrideApproved: true }));
  assert.equal(r.code, 'WRITER_LEASE_OVERRIDE_FLAG_INCONSISTENT');
}

// 15. leaseTtlMs of 0 is invalid.
{
  const r = evaluateWriterLease(base({ leaseTtlMs: 0 }));
  assert.equal(r.code, 'WRITER_LEASE_TTL_INVALID');
}

// 16. No PR and no Issue target is invalid.
{
  const r = evaluateWriterLease(base({ targetPrNumber: null, targetIssueNumber: null }));
  assert.equal(r.code, 'WRITER_LEASE_TARGET_MISSING');
}

// 17. An unexpected top-level key fails closed.
{
  const r = evaluateWriterLease({ ...base(), extraField: 1 });
  assert.equal(r.code, 'WRITER_LEASE_EVIDENCE_INVALID');
}

// 18. A non-PID evidence kind must not carry pid/processStartMs/live.
{
  const r = evaluateWriterLease(base({ claims: [{ ...declaredClaim(), pid: 1 }] }));
  assert.equal(r.code, 'WRITER_LEASE_CLAIM_INVALID');
}

// 19. CLI: PROCEED exits 0.
{
  const dir = mkdtempSync(join(tmpdir(), 'writer-lease-'));
  try {
    const file = join(dir, 'evidence.json');
    writeFileSync(file, JSON.stringify(base()));
    const res = spawnSync(process.execPath, [scriptPath, '--evidence-file', file], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).result, 'PROCEED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 20. CLI: STOP exits non-zero.
{
  const dir = mkdtempSync(join(tmpdir(), 'writer-lease-'));
  try {
    const file = join(dir, 'evidence.json');
    writeFileSync(file, JSON.stringify(base({ claims: [declaredClaim()] })));
    const res = spawnSync(process.execPath, [scriptPath, '--evidence-file', file], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.equal(JSON.parse(res.stdout).result, 'STOP');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('writer-lease-guard-selftest: all assertions passed');
