#!/usr/bin/env node
import assert from 'node:assert/strict';
import { issueReceipt, verifyReceipt } from './verification-evidence-receipt.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const issueInput = {
  schemaVersion: 1,
  mode: 'issue',
  baseSha: A,
  headSha: B,
  changedFiles: ['.agents/skills/test-gate/SKILL.md', 'VERSION'],
  profile: 'GOVERNANCE_ONLY',
  scopeDecision: 'PROCEED',
  plannedChecks: ['DIFF_HYGIENE', 'TARGETED_SELFTEST', 'DOCS_CONSISTENCY'],
  results: [
    { check: 'TARGETED_SELFTEST', status: 'success', evidenceSource: 'local' },
    { check: 'DIFF_HYGIENE', status: 'success', evidenceSource: 'local' },
    { check: 'DOCS_CONSISTENCY', status: 'success', evidenceSource: 'connector' },
  ],
};

const issued = issueReceipt(issueInput);
assert.equal(issued.pass, true);
assert.equal(issued.decision, 'ISSUED');
assert.match(issued.receipt.receiptId, /^[0-9a-f]{64}$/);
assert.deepEqual(issued.receipt.changedFiles, [...issueInput.changedFiles].sort());
assert.deepEqual(issued.receipt.plannedChecks, [...issueInput.plannedChecks].sort());

const verified = verifyReceipt({
  schemaVersion: 1,
  mode: 'verify',
  receipt: issued.receipt,
  current: { baseSha: A, headSha: B, changedFiles: [...issueInput.changedFiles].reverse() },
});
assert.equal(verified.pass, true);
assert.equal(verified.decision, 'REUSE');
assert.deepEqual(verified.reusableChecks, [...issueInput.plannedChecks].sort());

assert.equal(verifyReceipt({
  schemaVersion: 1, mode: 'verify', receipt: issued.receipt,
  current: { baseSha: C, headSha: B, changedFiles: issueInput.changedFiles },
}).code, 'BASE_SHA_MISMATCH');

assert.equal(verifyReceipt({
  schemaVersion: 1, mode: 'verify', receipt: issued.receipt,
  current: { baseSha: A, headSha: C, changedFiles: issueInput.changedFiles },
}).code, 'HEAD_SHA_MISMATCH');

assert.equal(verifyReceipt({
  schemaVersion: 1, mode: 'verify', receipt: issued.receipt,
  current: { baseSha: A, headSha: B, changedFiles: ['VERSION'] },
}).code, 'CHANGED_FILES_MISMATCH');

const tampered = structuredClone(issued.receipt);
tampered.results[0].evidenceSource = 'provider';
assert.equal(verifyReceipt({
  schemaVersion: 1, mode: 'verify', receipt: tampered,
  current: { baseSha: A, headSha: B, changedFiles: issueInput.changedFiles },
}).code, 'RECEIPT_TAMPERED');

const failureInput = structuredClone(issueInput);
failureInput.results[0].status = 'failure';
assert.equal(issueReceipt(failureInput).code, 'INCOMPLETE_OR_NONPASS_RESULTS');

const duplicateInput = structuredClone(issueInput);
duplicateInput.plannedChecks = ['DIFF_HYGIENE', 'DIFF_HYGIENE'];
assert.equal(issueReceipt(duplicateInput).code, 'INVALID_PLANNED_CHECKS');

const badSource = structuredClone(issueInput);
badSource.results[0].evidenceSource = 'caller-assertion';
assert.equal(issueReceipt(badSource).code, 'INCOMPLETE_OR_NONPASS_RESULTS');

const unknownScope = structuredClone(issueInput);
unknownScope.profile = 'UNKNOWN';
assert.equal(issueReceipt(unknownScope).code, 'INVALID_PROFILE');

const pathTraversal = structuredClone(issueInput);
pathTraversal.changedFiles = ['../secret'];
assert.equal(issueReceipt(pathTraversal).code, 'INVALID_CHANGED_FILES');

console.log('verification-evidence-receipt-selftest: PASS');
