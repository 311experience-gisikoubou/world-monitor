#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const KIND = 'VERIFICATION_EVIDENCE_V1';
const MODES = new Set(['issue', 'verify']);
const PROFILES = new Set([
  'DOCS_ONLY', 'GOVERNANCE_ONLY', 'FRONTEND_ONLY', 'BACKEND_ONLY',
  'DB_MIGRATION', 'DEPENDENCY_CHANGE', 'MIXED_RUNTIME', 'UNKNOWN'
]);
const SCOPE_DECISIONS = new Set(['PROCEED', 'PROCEED_ESCALATED']);
const CHECKS = new Set([
  'DIFF_HYGIENE', 'DOCS_CONSISTENCY', 'TARGETED_SELFTEST', 'FORMAT', 'LINT',
  'TYPECHECK', 'TARGETED_FRONTEND_TEST', 'FRONTEND_BUILD', 'FRONTEND_FULL_TEST',
  'TARGETED_BACKEND_TEST', 'BACKEND_BUILD', 'BACKEND_FULL_TEST', 'MIGRATION_TEST',
  'DEPENDENCY_AUDIT', 'REAL_DEVICE_OBJECTIVE', 'FULL_REPOSITORY_SUITE'
]);
const EVIDENCE_SOURCES = new Set(['local', 'remote', 'github-api', 'connector', 'device', 'provider']);

function fail(code, detail = null) {
  const result = { pass: false, decision: 'STOP', code };
  if (detail !== null) result.detail = detail;
  return result;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestReceiptCore(core) {
  return crypto.createHash('sha256').update(stableJson(core)).digest('hex');
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const out = [];
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0 || file.length > 512) return null;
    if (file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')) return null;
    out.push(file);
  }
  const unique = [...new Set(out)].sort();
  return unique.length === out.length ? unique : null;
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return null;
  if (!checks.every(c => typeof c === 'string' && CHECKS.has(c))) return null;
  const unique = [...new Set(checks)].sort();
  return unique.length === checks.length ? unique : null;
}

function normalizeResults(results, plannedChecks) {
  if (!Array.isArray(results) || results.length !== plannedChecks.length) return null;
  const map = new Map();
  for (const row of results) {
    if (!row || typeof row !== 'object') return null;
    if (!CHECKS.has(row.check) || !plannedChecks.includes(row.check)) return null;
    if (row.status !== 'success') return null;
    if (!EVIDENCE_SOURCES.has(row.evidenceSource)) return null;
    if (map.has(row.check)) return null;
    map.set(row.check, { check: row.check, status: 'success', evidenceSource: row.evidenceSource });
  }
  if (map.size !== plannedChecks.length) return null;
  return [...map.values()].sort((a, b) => a.check.localeCompare(b.check));
}

export function issueReceipt(input) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1 || input.mode !== 'issue') {
    return fail('INVALID_ISSUE_SCHEMA');
  }
  if (!SHA_RE.test(input.baseSha ?? '') || !SHA_RE.test(input.headSha ?? '')) return fail('INVALID_SHA');
  if (!PROFILES.has(input.profile) || input.profile === 'UNKNOWN') return fail('INVALID_PROFILE');
  if (!SCOPE_DECISIONS.has(input.scopeDecision)) return fail('INVALID_SCOPE_DECISION');
  const changedFiles = normalizeFiles(input.changedFiles);
  const plannedChecks = normalizeChecks(input.plannedChecks);
  if (!changedFiles) return fail('INVALID_CHANGED_FILES');
  if (!plannedChecks) return fail('INVALID_PLANNED_CHECKS');
  const results = normalizeResults(input.results, plannedChecks);
  if (!results) return fail('INCOMPLETE_OR_NONPASS_RESULTS');

  const core = {
    schemaVersion: 1,
    kind: KIND,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedFiles,
    profile: input.profile,
    scopeDecision: input.scopeDecision,
    plannedChecks,
    results,
  };
  const receiptId = digestReceiptCore(core);
  return { pass: true, decision: 'ISSUED', receipt: { ...core, receiptId } };
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || receipt.schemaVersion !== 1 || receipt.kind !== KIND) {
    return fail('INVALID_RECEIPT_SCHEMA');
  }
  if (!SHA_RE.test(receipt.baseSha ?? '') || !SHA_RE.test(receipt.headSha ?? '')) return fail('INVALID_RECEIPT_SHA');
  if (!PROFILES.has(receipt.profile) || receipt.profile === 'UNKNOWN' || !SCOPE_DECISIONS.has(receipt.scopeDecision)) return fail('INVALID_RECEIPT_SCOPE');
  const changedFiles = normalizeFiles(receipt.changedFiles);
  const plannedChecks = normalizeChecks(receipt.plannedChecks);
  if (!changedFiles || !plannedChecks) return fail('INVALID_RECEIPT_SET');
  const results = normalizeResults(receipt.results, plannedChecks);
  if (!results) return fail('INVALID_RECEIPT_RESULTS');
  const core = {
    schemaVersion: 1,
    kind: KIND,
    baseSha: receipt.baseSha,
    headSha: receipt.headSha,
    changedFiles,
    profile: receipt.profile,
    scopeDecision: receipt.scopeDecision,
    plannedChecks,
    results,
  };
  const expected = digestReceiptCore(core);
  if (receipt.receiptId !== expected) return fail('RECEIPT_TAMPERED');
  return { pass: true, core, receiptId: expected };
}

export function verifyReceipt(input) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1 || input.mode !== 'verify') {
    return fail('INVALID_VERIFY_SCHEMA');
  }
  const checked = validateReceipt(input.receipt);
  if (!checked.pass) return checked;
  const current = input.current;
  if (!current || typeof current !== 'object') return fail('INVALID_CURRENT_STATE');
  if (!SHA_RE.test(current.baseSha ?? '') || !SHA_RE.test(current.headSha ?? '')) return fail('INVALID_CURRENT_SHA');
  const currentFiles = normalizeFiles(current.changedFiles);
  if (!currentFiles) return fail('INVALID_CURRENT_CHANGED_FILES');
  if (current.baseSha !== checked.core.baseSha) return fail('BASE_SHA_MISMATCH');
  if (current.headSha !== checked.core.headSha) return fail('HEAD_SHA_MISMATCH');
  if (stableJson(currentFiles) !== stableJson(checked.core.changedFiles)) return fail('CHANGED_FILES_MISMATCH');
  return {
    pass: true,
    decision: 'REUSE',
    receiptId: checked.receiptId,
    reusableChecks: checked.core.plannedChecks,
    profile: checked.core.profile,
    scopeDecision: checked.core.scopeDecision,
  };
}

function readStdin(maxBytes = 65536) {
  const data = fs.readFileSync(0);
  if (data.length === 0) throw new Error('EMPTY_STDIN');
  if (data.length > maxBytes) throw new Error('STDIN_TOO_LARGE');
  return JSON.parse(data.toString('utf8'));
}

function main() {
  let input;
  try {
    input = readStdin();
  } catch (error) {
    console.log(JSON.stringify(fail(error?.message === 'STDIN_TOO_LARGE' ? 'STDIN_TOO_LARGE' : 'INVALID_JSON')));
    process.exitCode = 2;
    return;
  }
  if (!MODES.has(input?.mode)) {
    console.log(JSON.stringify(fail('INVALID_MODE')));
    process.exitCode = 2;
    return;
  }
  const result = input.mode === 'issue' ? issueReceipt(input) : verifyReceipt(input);
  console.log(JSON.stringify(result, null, 2));
  console.log(result.pass
    ? `VERIFICATION_EVIDENCE_RECEIPT=${result.decision}`
    : `VERIFICATION_EVIDENCE_RECEIPT=STOP:${result.code}`);
  process.exitCode = result.pass ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
