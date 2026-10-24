#!/usr/bin/env node
// Writer Lease Guard (Issue #283, parts C and D).
//
// For one target Repo+PR (or Repo+Issue+job), advisorily evaluate "at most 1
// active writer at a time" across humans and AIs (chat sessions, Claude
// jobs, other AI runners) from caller-supplied evidence. This is NOT an
// atomic enforcement mechanism -- see the honesty-boundary paragraph below
// before describing this module as "enforcing" single-writer exclusion
// anywhere else. This module never starts, stops, or inspects a process
// itself; it only evaluates already-collected, caller-supplied evidence
// (for example an existing runner/LocalOps PID-lease record that the caller
// has already re-verified as live/dead). It never force-pushes, resets,
// cleans, or merges anything; it only returns a lease decision and an
// advisory merge-readiness flag for the caller's own merge-authorization
// path to honor.
//
// Honesty boundary (do not overclaim): this module is a pure function over caller-supplied `claims`. It
// holds no shared/persistent state and performs no atomic read-modify-write of any claim store. Two
// concurrent callers that each pass their own `claims: []` (because neither has yet observed the other's
// claim) will each legitimately receive LEASE_GRANTED_NEW_WRITER; that is correct behavior for this
// evaluator given the evidence it was handed, but it is NOT proof of mutual exclusion across real
// concurrent processes. Genuine single-writer enforcement additionally requires the caller to source
// `claims` from an atomic, shared, already-qualified claim-recording primitive that truly covers the same
// Repo+PR/Issue across separate process invocations. No such atomic primitive exists or is wired into
// this module yet, and as of this phase this module is not invoked by the launcher,
// implementation-orchestrator, or any push/PR path -- it is an advisory evaluation helper only, not
// enforcement, until a caller actually calls it with real atomic claim evidence at a real decision point.
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WRITER_KINDS = new Set(['AI_JOB', 'HUMAN', 'OTHER_AI']);
const EVIDENCE_KINDS = new Set(['PID_LEASE', 'DECLARED_ACTIVE_JOB', 'HUMAN_DECLARED']);
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const TOP_LEVEL_KEYS = [
  'schemaVersion', 'targetRepository', 'targetPrNumber', 'targetIssueNumber', 'nowMs', 'leaseTtlMs',
  'claims', 'requestedWriterId', 'requestedWriterKind', 'forceOverride', 'explicitHumanOverrideApproved',
  'mergeReadinessEvidence',
];
const CLAIM_KEYS = ['writerId', 'writerKind', 'claimedAtMs', 'evidenceKind', 'pid', 'processStartMs', 'live'];

function stop(code, message, detail = {}) {
  return { result: 'STOP', decision: 'BLOCKED', canMerge: false, severity: 'SEVERE', code, message, ...detail };
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  if (value !== value.trim()) return null;
  if (!value || value.length > maxLength) return null;
  if (/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(value)) return null;
  return value;
}
function cleanRepo(value) {
  const repo = cleanText(value, 200);
  if (!repo || !REPO_RE.test(repo)) return null;
  const [owner, name] = repo.split('/');
  if (owner.includes('--') || name === '.' || name === '..') return null;
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}
function isSafeInt(value, min, max) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function cleanNullablePositiveInt(value) {
  if (value === null) return { ok: true, value: null };
  if (!isSafeInt(value, 1, 2_147_483_647)) return { ok: false };
  return { ok: true, value };
}

function normalizeClaim(entry) {
  if (!isPlainObject(entry)) return null;
  const keys = Object.keys(entry);
  if (keys.length !== CLAIM_KEYS.length || keys.some((k) => !CLAIM_KEYS.includes(k))) return null;
  const writerId = cleanText(entry.writerId, 200);
  if (!writerId || !WRITER_KINDS.has(entry.writerKind)) return null;
  if (!isSafeInt(entry.claimedAtMs, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!EVIDENCE_KINDS.has(entry.evidenceKind)) return null;
  if (entry.evidenceKind === 'PID_LEASE') {
    const pid = cleanNullablePositiveInt(entry.pid);
    if (!pid.ok || pid.value === null) return null;
    const startMs = isSafeInt(entry.processStartMs, 0, Number.MAX_SAFE_INTEGER) ? entry.processStartMs : null;
    if (startMs === null) return null;
    if (typeof entry.live !== 'boolean') return null;
    return { writerId, writerKind: entry.writerKind, claimedAtMs: entry.claimedAtMs, evidenceKind: entry.evidenceKind, pid: pid.value, processStartMs: startMs, live: entry.live };
  }
  // Non-PID evidence kinds carry no process identity; pid/processStartMs/live must be explicitly null and liveness is assumed true (declared, not process-observed).
  if (entry.pid !== null || entry.processStartMs !== null || entry.live !== null) return null;
  return { writerId, writerKind: entry.writerKind, claimedAtMs: entry.claimedAtMs, evidenceKind: entry.evidenceKind, pid: null, processStartMs: null, live: true };
}

function normalizeMergeReadiness(value) {
  if (value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return { ok: false };
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('testResult') || !keys.includes('branchMatches')) return { ok: false };
  if (!['PASS', 'FAIL', 'UNKNOWN', 'COVERAGE_UNKNOWN'].includes(value.testResult)) return { ok: false };
  if (typeof value.branchMatches !== 'boolean') return { ok: false };
  return { ok: true, value: { testResult: value.testResult, branchMatches: value.branchMatches } };
}

export function evaluateWriterLease(input) {
  if (!isPlainObject(input)) return stop('WRITER_LEASE_EVIDENCE_INVALID', 'Writer lease evidence must be a closed JSON object.');
  const keys = Object.keys(input);
  if (keys.length !== TOP_LEVEL_KEYS.length || keys.some((k) => !TOP_LEVEL_KEYS.includes(k))) {
    return stop('WRITER_LEASE_EVIDENCE_INVALID', 'Writer lease evidence must use exactly the closed schema v1 key set.');
  }
  if (input.schemaVersion !== 1) return stop('WRITER_LEASE_SCHEMA_UNSUPPORTED', 'Writer lease evidence schemaVersion=1 is required.');

  const targetRepository = cleanRepo(input.targetRepository);
  if (!targetRepository) return stop('WRITER_LEASE_TARGET_REPO_INVALID', 'targetRepository must be a valid owner/repo identifier.');
  const targetPrNumber = cleanNullablePositiveInt(input.targetPrNumber);
  const targetIssueNumber = cleanNullablePositiveInt(input.targetIssueNumber);
  if (!targetPrNumber.ok || !targetIssueNumber.ok) return stop('WRITER_LEASE_TARGET_INVALID', 'targetPrNumber and targetIssueNumber must each be null or a positive integer.');
  if (targetPrNumber.value === null && targetIssueNumber.value === null) return stop('WRITER_LEASE_TARGET_MISSING', 'A writer lease requires a targetPrNumber or targetIssueNumber.');

  if (!isSafeInt(input.nowMs, 0, Number.MAX_SAFE_INTEGER)) return stop('WRITER_LEASE_TIME_INVALID', 'nowMs must be an explicit caller-supplied timestamp.');
  if (!isSafeInt(input.leaseTtlMs, 1, MAX_LEASE_TTL_MS)) return stop('WRITER_LEASE_TTL_INVALID', `leaseTtlMs must be a positive integer up to ${MAX_LEASE_TTL_MS}ms.`);
  const nowMs = input.nowMs;
  const leaseTtlMs = input.leaseTtlMs;

  if (!Array.isArray(input.claims) || input.claims.length > 200) return stop('WRITER_LEASE_CLAIMS_INVALID', 'claims must be a closed array of at most 200 writer-lease claims.');
  const claims = [];
  for (const raw of input.claims) {
    const claim = normalizeClaim(raw);
    if (!claim) return stop('WRITER_LEASE_CLAIM_INVALID', 'A writer-lease claim is malformed or carries an inconsistent evidence shape.');
    claims.push(claim);
  }

  const requestedWriterId = cleanText(input.requestedWriterId, 200);
  if (!requestedWriterId || !WRITER_KINDS.has(input.requestedWriterKind)) return stop('WRITER_LEASE_REQUESTER_INVALID', 'requestedWriterId and requestedWriterKind are required.');
  if (typeof input.forceOverride !== 'boolean' || typeof input.explicitHumanOverrideApproved !== 'boolean') {
    return stop('WRITER_LEASE_OVERRIDE_FLAG_INVALID', 'forceOverride and explicitHumanOverrideApproved must be explicit booleans.');
  }
  if (input.explicitHumanOverrideApproved && !input.forceOverride) return stop('WRITER_LEASE_OVERRIDE_FLAG_INCONSISTENT', 'explicitHumanOverrideApproved must not be set without forceOverride.');

  const mergeReadiness = normalizeMergeReadiness(input.mergeReadinessEvidence);
  if (!mergeReadiness.ok) return stop('WRITER_LEASE_MERGE_EVIDENCE_INVALID', 'mergeReadinessEvidence must be null or a closed { testResult, branchMatches } object.');

  const activeClaims = claims.filter((claim) => {
    if (claim.claimedAtMs > nowMs) return false; // future-dated claim evidence is never trusted
    if (claim.evidenceKind === 'PID_LEASE') {
      // A PID-backed claim carries its own caller-reverified process-liveness signal, which is strictly
      // stronger ground truth than elapsed wall-clock age. A still-live process must never lose ownership
      // solely because claimedAtMs is older than leaseTtlMs; only an explicit live:false (or future-dated
      // claim, checked above) retires it.
      return claim.live === true;
    }
    // Non-PID evidence (DECLARED_ACTIVE_JOB, HUMAN_DECLARED) carries no independent liveness signal, so it
    // remains subject to leaseTtlMs expiry.
    return nowMs - claim.claimedAtMs <= leaseTtlMs;
  });
  const activeWriterIds = [...new Set(activeClaims.map((c) => c.writerId))];

  const canMerge = Boolean(mergeReadiness.value && mergeReadiness.value.testResult === 'PASS' && mergeReadiness.value.branchMatches === true);
  const base = { targetRepository, targetPrNumber: targetPrNumber.value, targetIssueNumber: targetIssueNumber.value, activeWriterCount: activeWriterIds.length, canMerge };

  if (activeWriterIds.length > 1) {
    return stop('WRITER_RACE_DETECTED', 'More than one writer lease is simultaneously active for this target; this must never happen and requires human resolution before any further write.', { ...base, conflictingWriterIds: activeWriterIds.sort() });
  }

  if (activeWriterIds.length === 1 && activeWriterIds[0] !== requestedWriterId) {
    const holderWriterId = activeWriterIds[0];
    if (input.forceOverride && input.explicitHumanOverrideApproved) {
      return { result: 'PROCEED', decision: 'OVERRIDE_GRANTED', severity: 'NONE', code: 'WRITER_LEASE_OVERRIDE_GRANTED', ...base, grantedWriterId: requestedWriterId, previousWriterId: holderWriterId };
    }
    return stop('WRITER_LEASE_HELD_BY_OTHER', 'Another writer already holds an active lease on this target; an explicit human-approved override is required to replace it.', { ...base, holderWriterId });
  }

  if (activeWriterIds.length === 1) {
    return { result: 'PROCEED', decision: 'CONTINUE_EXISTING_WRITER', severity: 'NONE', code: 'WRITER_LEASE_CONTINUED', ...base, grantedWriterId: requestedWriterId };
  }
  return { result: 'PROCEED', decision: 'LEASE_GRANTED_NEW_WRITER', severity: 'NONE', code: 'WRITER_LEASE_GRANTED', ...base, grantedWriterId: requestedWriterId };
}

function parseArgs(argv) {
  const valued = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pretty') continue;
    if (a !== '--evidence-file' && a !== '--evidence-json') return { error: 'invalid' };
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) return { error: 'invalid' };
    if (valued.has(a)) return { error: 'duplicate' };
    valued.set(a, argv[++i]);
  }
  return { valued };
}
async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stdout.write(`${JSON.stringify(stop('WRITER_LEASE_ARGUMENT_INVALID', 'Arguments are invalid or duplicated.'))}\n`);
    process.exitCode = 2;
    return;
  }
  const file = parsed.valued.get('--evidence-file');
  const json = parsed.valued.get('--evidence-json');
  if ((!file && !json) || (file && json)) {
    process.stdout.write(`${JSON.stringify(stop('WRITER_LEASE_ARGUMENT_INVALID', 'Use exactly one of --evidence-file or --evidence-json.'))}\n`);
    process.exitCode = 2;
    return;
  }
  let input;
  try { input = JSON.parse(file ? await readFile(file, 'utf8') : json); }
  catch { input = null; }
  const pretty = argv.includes('--pretty');
  const result = input === null ? stop('WRITER_LEASE_EVIDENCE_INVALID', 'Evidence JSON is missing or unreadable.') : evaluateWriterLease(input);
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
  if (result.result === 'STOP') process.exitCode = 2;
}
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main().catch(() => { process.stdout.write(`${JSON.stringify(stop('WRITER_LEASE_INTERNAL_ERROR', 'Writer lease guard failed closed.'))}\n`); process.exitCode = 2; });
