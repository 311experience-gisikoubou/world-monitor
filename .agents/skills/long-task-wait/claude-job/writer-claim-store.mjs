#!/usr/bin/env node
// Writer Claim Store (Issue #283, continuation job 005).
//
// A REAL, OS-atomic, fail-closed, cross-process single-writer claim for one canonical GitHub
// repository identity plus an explicit target PR number and/or pre-PR Issue number (and,
// when known, a branch name). This is deliberately NOT another copy of
// `preflight-audit/writer-lease-guard.mjs`: that module is a pure evaluator over
// caller-supplied evidence with no shared state, so two independently empty claims both
// legitimately PROCEED. This module instead performs a real `fs.openSync(path, 'wx')`
// (OS-atomic exclusive create; fails with EEXIST if the file already exists) under one
// canonical shared directory, so two separate local git clones/worktrees of the SAME
// repository on the SAME Windows user/PC cannot both win a claim for the same
// Repo+PR/Issue/branch target.
//
// Collision-resistant key: SHA-256 of a normalized `owner/repo` plus the PR/Issue number or
// branch name. A PR number and an Issue number that are numerically equal intentionally
// collapse to the SAME key, because GitHub PRs and Issues share one number sequence per
// repository -- an explicit PR-vs-pre-PR-Issue alias on the same number MUST collide and
// block, not silently coexist as two "different" targets.
//
// Honesty boundary (do not overclaim beyond this):
// - Coverage: this module only protects local clones/worktrees of the SAME repository on the
//   SAME Windows user/PC that go through this exact launcher
//   (`long-task-wait/claude-job/run-claude-job.ps1`). Other Windows users/PCs, other GitHub
//   connectors/UIs, other chat windows that bypass this launcher entirely, or any job created
//   before this launcher was updated to call this module, are explicitly OUT-OF-COVERAGE and
//   are never silently treated as guarded.
// - No time-based auto-reclaim, ever: a claim is removed ONLY by an explicit, verified
//   self-release (matching `ownerToken` + `jobId`) performed by the very run that created it
//   (normally from the launcher's own `finally`), or by a human directly deleting the local
//   claim file as a verified-safe manual recovery step. A claim whose owning process has
//   disappeared, is older than any notion of a TTL, or whose record is incomplete/malformed/
//   unreadable is NEVER auto-reclaimed or auto-repaired by this module -- it fails closed
//   (BLOCKED) exactly like a genuinely still-live foreign claim. There is no TTL parameter in
//   this module at all; "stale" and "valid-but-foreign" both simply block.
// - No second hosted DB/service/daemon: claim files are small local JSON files, one per
//   claimed key, under the current Windows user's own `%LOCALAPPDATA%\ai-dev-foundation\
//   writer-claims\` directory. Nothing here talks to the network, GitHub, or any other process.
import { createHash } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OWNER_TOKEN_RE = /^[A-Fa-f0-9]{16,64}$/;
const TICKS_RE = /^[0-9]{1,20}$/;

function sha256Hex(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isPositiveInt(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 2_147_483_647; }

export function normalizeRepo(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v !== value || !v || v.length > 200 || !REPO_RE.test(v)) return null;
  const [owner, name] = v.split('/');
  if (owner.includes('--') || name === '.' || name === '..') return null;
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function normalizeBranch(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v !== value || !v || v.length > 200 || !BRANCH_RE.test(v) || v.includes('..') || v.startsWith('/') || v.endsWith('/')) return null;
  return v;
}

export function defaultClaimsDir() {
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error('LOCALAPPDATA is not set; cannot resolve the canonical writer-claims directory.');
  return join(base, 'ai-dev-foundation', 'writer-claims');
}

// A PR number and an Issue number of the same value intentionally produce the SAME key.
export function claimKeyForNumber(repo, number) {
  return sha256Hex(`writer-claim:v1:${repo}:number:${number}`);
}
export function claimKeyForBranch(repo, branch) {
  return sha256Hex(`writer-claim:v1:${repo}:branch:${branch}`);
}

// Deterministic, deduplicated, sorted plan of claim keys for one acquisition request.
export function buildClaimPlan({ repo, prNumber, issueNumber, branch }) {
  const keys = new Map();
  if (prNumber !== null && prNumber !== undefined) {
    keys.set(claimKeyForNumber(repo, prNumber), { kind: 'NUMBER', number: prNumber, sources: ['pr'] });
  }
  if (issueNumber !== null && issueNumber !== undefined) {
    const k = claimKeyForNumber(repo, issueNumber);
    const existing = keys.get(k);
    if (existing) existing.sources.push('issue');
    else keys.set(k, { kind: 'NUMBER', number: issueNumber, sources: ['issue'] });
  }
  if (branch !== null && branch !== undefined) {
    keys.set(claimKeyForBranch(repo, branch), { kind: 'BRANCH', branch, sources: ['branch'] });
  }
  return [...keys.entries()]
    .map(([key, meta]) => ({ key, ...meta }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function readClaimRecord(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return { ok: false, reason: e && e.code === 'ENOENT' ? 'ABSENT' : 'UNREADABLE' }; }
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (
    !isPlainObject(obj)
    || obj.schemaVersion !== SCHEMA_VERSION
    || typeof obj.ownerToken !== 'string' || !OWNER_TOKEN_RE.test(obj.ownerToken)
    || typeof obj.jobId !== 'string' || !JOB_ID_RE.test(obj.jobId)
    || !isPositiveInt(obj.pid)
    || typeof obj.processStartUtcTicks !== 'string' || !TICKS_RE.test(obj.processStartUtcTicks)
    || typeof obj.repo !== 'string' || !normalizeRepo(obj.repo)
    || typeof obj.claimedAtIso !== 'string'
  ) {
    return { ok: false, reason: 'MALFORMED' };
  }
  return { ok: true, record: obj };
}

function writeClaimRecordExclusive(path, record) {
  const fd = openSync(path, 'wx'); // OS-atomic exclusive create; throws EEXIST if present.
  try { writeSync(fd, Buffer.from(JSON.stringify(record), 'utf8')); } finally { closeSync(fd); }
}

function selfOwnedRollback(paths, ownerToken, jobId) {
  for (const p of paths) {
    const existing = readClaimRecord(p);
    if (existing.ok && existing.record.ownerToken === ownerToken && existing.record.jobId === jobId) {
      try { unlinkSync(p); } catch { /* best-effort; a leftover self-owned file still just fails closed for everyone, never silently grants anything */ }
    }
  }
}

function validateCommon({ repo, prNumber, issueNumber, branch, jobId, ownerToken }) {
  const normRepo = normalizeRepo(repo);
  if (!normRepo) return { ok: false, code: 'WRITER_CLAIM_REPO_INVALID', message: 'repo must be a valid owner/repo identifier.' };
  const normPr = prNumber === undefined ? null : prNumber;
  const normIssue = issueNumber === undefined ? null : issueNumber;
  if (normPr !== null && !isPositiveInt(normPr)) return { ok: false, code: 'WRITER_CLAIM_PR_INVALID', message: 'prNumber must be null or a positive integer.' };
  if (normIssue !== null && !isPositiveInt(normIssue)) return { ok: false, code: 'WRITER_CLAIM_ISSUE_INVALID', message: 'issueNumber must be null or a positive integer.' };
  if (normPr === null && normIssue === null) return { ok: false, code: 'WRITER_CLAIM_TARGET_MISSING', message: 'A writer claim requires a prNumber and/or issueNumber.' };
  let normBranch = null;
  if (branch !== null && branch !== undefined) {
    normBranch = normalizeBranch(branch);
    if (!normBranch) return { ok: false, code: 'WRITER_CLAIM_BRANCH_INVALID', message: 'branch must be a safe, non-empty branch name.' };
  }
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return { ok: false, code: 'WRITER_CLAIM_JOB_ID_INVALID', message: 'jobId is invalid.' };
  if (typeof ownerToken !== 'string' || !OWNER_TOKEN_RE.test(ownerToken)) return { ok: false, code: 'WRITER_CLAIM_OWNER_TOKEN_INVALID', message: 'ownerToken must be a random hex token.' };
  return { ok: true, normRepo, normPr, normIssue, normBranch };
}

// Acquires every planned key in deterministic order. If any key is already held, every key
// this SAME call already created is rolled back (self-owned only) before returning BLOCKED,
// so a blocked duplicate writer is left holding nothing and has created zero source changes.
export function acquireClaim({ claimsDir, repo, prNumber, issueNumber, branch, jobId, ownerToken, pid, processStartUtcTicks }) {
  const common = validateCommon({ repo, prNumber, issueNumber, branch, jobId, ownerToken });
  if (!common.ok) return common;
  if (!isPositiveInt(pid)) return { ok: false, code: 'WRITER_CLAIM_PID_INVALID', message: 'pid must be a positive integer.' };
  const ticksStr = typeof processStartUtcTicks === 'string' ? processStartUtcTicks : String(processStartUtcTicks ?? '');
  if (!TICKS_RE.test(ticksStr)) return { ok: false, code: 'WRITER_CLAIM_PROCESS_START_INVALID', message: 'processStartUtcTicks must be a non-negative integer tick count (as a string or number).' };

  let dir;
  try { dir = claimsDir || defaultClaimsDir(); } catch (e) { return { ok: false, code: 'WRITER_CLAIM_DIR_UNRESOLVED', message: e.message }; }
  try { mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, code: 'WRITER_CLAIM_DIR_UNAVAILABLE', message: String(e && e.message || e) }; }

  const { normRepo, normPr, normIssue, normBranch } = common;
  const plan = buildClaimPlan({ repo: normRepo, prNumber: normPr, issueNumber: normIssue, branch: normBranch });
  const claimedAtIso = new Date().toISOString();
  const acquiredPaths = [];
  for (const entry of plan) {
    const path = join(dir, `${entry.key}.json`);
    const record = {
      schemaVersion: SCHEMA_VERSION, ownerToken, jobId, pid, processStartUtcTicks: ticksStr,
      repo: normRepo, prNumber: normPr, issueNumber: normIssue, branch: normBranch,
      claimKind: entry.kind, claimedAtIso,
    };
    try {
      writeClaimRecordExclusive(path, record);
      acquiredPaths.push(path);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        selfOwnedRollback(acquiredPaths, ownerToken, jobId);
        return { ok: false, code: 'WRITER_CLAIM_WRITE_FAILED', message: String(e && e.message || e) };
      }
      const existing = readClaimRecord(path);
      selfOwnedRollback(acquiredPaths, ownerToken, jobId);
      if (!existing.ok) {
        return {
          ok: false,
          code: 'WRITER_CLAIM_RECORD_MALFORMED',
          message: `An existing writer-claim record at key ${entry.key} is incomplete, malformed, or unreadable (${existing.reason}); failing closed rather than auto-repairing or auto-reclaiming it. Verified safe (human) recovery is required before retrying.`,
          blockedKey: entry.key,
        };
      }
      return {
        ok: false,
        code: 'WRITER_CLAIM_HELD_BY_OTHER',
        message: `Another writer already holds the claim for this target (key ${entry.key}, jobId ${existing.record.jobId}); this run is BLOCKED and created no source changes. This is never auto-reclaimed by elapsed time or by the owning process disappearing; it requires an explicit self-release by that same run, or verified-safe manual recovery.`,
        blockedKey: entry.key,
        holder: {
          jobId: existing.record.jobId,
          pid: existing.record.pid,
          processStartUtcTicks: existing.record.processStartUtcTicks,
          claimedAtIso: existing.record.claimedAtIso,
        },
      };
    }
  }
  return {
    ok: true,
    code: 'WRITER_CLAIM_GRANTED',
    repo: normRepo,
    prNumber: normPr,
    issueNumber: normIssue,
    branch: normBranch,
    jobId,
    ownerToken,
    acquiredKeys: plan.map((p) => p.key),
    claimFiles: acquiredPaths,
  };
}

// Releases exactly the keys this same (ownerToken, jobId) pair would have acquired for the
// given target. A key whose file is already absent is treated as already-released (idempotent
// finally-block safe). A key whose file exists but does not match (ownerToken, jobId) is left
// untouched and reported, never force-deleted -- deleting a foreign claim is never performed by
// this module under any circumstance.
export function releaseClaim({ claimsDir, repo, prNumber, issueNumber, branch, jobId, ownerToken }) {
  const common = validateCommon({ repo, prNumber, issueNumber, branch, jobId, ownerToken });
  if (!common.ok) return common;
  let dir;
  try { dir = claimsDir || defaultClaimsDir(); } catch (e) { return { ok: false, code: 'WRITER_CLAIM_DIR_UNRESOLVED', message: e.message }; }
  const { normRepo, normPr, normIssue, normBranch } = common;
  const plan = buildClaimPlan({ repo: normRepo, prNumber: normPr, issueNumber: normIssue, branch: normBranch });
  const released = [];
  const left = [];
  for (const entry of plan) {
    const path = join(dir, `${entry.key}.json`);
    const existing = readClaimRecord(path);
    if (!existing.ok) {
      if (existing.reason === 'ABSENT') { released.push(entry.key); continue; }
      left.push({ key: entry.key, reason: existing.reason });
      continue;
    }
    if (existing.record.ownerToken !== ownerToken || existing.record.jobId !== jobId) {
      left.push({ key: entry.key, reason: 'FOREIGN_CLAIM_PRESENT' });
      continue;
    }
    try { unlinkSync(path); released.push(entry.key); } catch (e) { left.push({ key: entry.key, reason: String(e && e.message || e) }); }
  }
  return { ok: left.length === 0, released, left };
}

// --- CLI -------------------------------------------------------------------------------------
const VALUED_FLAGS = new Set([
  '--claims-dir', '--repo', '--pr', '--issue', '--branch', '--job-id', '--owner-token', '--pid', '--process-start-ticks',
]);

function parseArgs(argv) {
  let mode = null;
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--acquire' || a === '--release') {
      if (mode) return { error: 'duplicate-mode' };
      mode = a === '--acquire' ? 'acquire' : 'release';
      continue;
    }
    if (!VALUED_FLAGS.has(a)) return { error: `unknown-arg:${a}` };
    if (i + 1 >= argv.length) return { error: `missing-value:${a}` };
    if (values.has(a)) return { error: `duplicate-arg:${a}` };
    values.set(a, argv[i + 1]);
    i += 1;
  }
  if (!mode) return { error: 'missing-mode' };
  return { mode, values };
}

function toIntOrNull(s) {
  if (s === undefined) return { ok: true, value: null };
  if (!/^[0-9]{1,10}$/.test(s)) return { ok: false };
  return { ok: true, value: Number(s) };
}

function fail(code, message) { return { ok: false, code, message }; }

export async function runCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { result: fail('WRITER_CLAIM_ARGUMENT_INVALID', parsed.error), exitCode: 2 };
  const v = parsed.values;
  const repo = v.get('--repo');
  const jobId = v.get('--job-id');
  const ownerToken = v.get('--owner-token');
  if (!repo || !jobId || !ownerToken) return { result: fail('WRITER_CLAIM_ARGUMENT_INVALID', '--repo, --job-id, and --owner-token are required.'), exitCode: 2 };
  const pr = toIntOrNull(v.get('--pr'));
  const issue = toIntOrNull(v.get('--issue'));
  if (!pr.ok || !issue.ok) return { result: fail('WRITER_CLAIM_ARGUMENT_INVALID', '--pr and --issue must be positive integers when present.'), exitCode: 2 };
  const branch = v.has('--branch') ? v.get('--branch') : null;
  const claimsDir = v.get('--claims-dir') || null;

  let result;
  if (parsed.mode === 'acquire') {
    if (!v.has('--pid') || !v.has('--process-start-ticks')) {
      return { result: fail('WRITER_CLAIM_ARGUMENT_INVALID', '--pid and --process-start-ticks are required for --acquire.'), exitCode: 2 };
    }
    const pidParsed = toIntOrNull(v.get('--pid'));
    if (!pidParsed.ok || pidParsed.value === null) return { result: fail('WRITER_CLAIM_ARGUMENT_INVALID', '--pid must be a positive integer.'), exitCode: 2 };
    result = acquireClaim({
      claimsDir, repo, prNumber: pr.value, issueNumber: issue.value, branch, jobId, ownerToken,
      pid: pidParsed.value, processStartUtcTicks: v.get('--process-start-ticks'),
    });
  } else {
    result = releaseClaim({ claimsDir, repo, prNumber: pr.value, issueNumber: issue.value, branch, jobId, ownerToken });
  }
  return { result, exitCode: result.ok ? 0 : 2 };
}

async function main() {
  const { result, exitCode } = await runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    process.stdout.write(`${JSON.stringify(fail('WRITER_CLAIM_INTERNAL_ERROR', String(e && e.message || e)))}\n`);
    process.exitCode = 2;
  });
}
