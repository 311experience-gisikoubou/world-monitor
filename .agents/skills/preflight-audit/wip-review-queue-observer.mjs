#!/usr/bin/env node
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const WIP_MAX = 2;
export const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
export const MAX_EVIDENCE_BYTES = 64 * 1024;
export const MAX_PULL_REQUESTS = 200;

const CLI_ARGUMENTS = new Set(['repo', 'evidence-file']);
const SHA_RE = /^[0-9a-f]{40}$/i;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const FETCHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ObserverError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined || value === '') {
      throw new ObserverError('CLI_ARGUMENTS_MALFORMED');
    }
    const name = key.slice(2);
    if (!CLI_ARGUMENTS.has(name)) throw new ObserverError('CLI_ARGUMENT_UNKNOWN');
    if (Object.hasOwn(out, name)) throw new ObserverError('CLI_ARGUMENT_DUPLICATE');
    out[name] = value;
  }
  return out;
}

function requireArg(args, name) {
  const value = args[name];
  if (!value) throw new ObserverError('CLI_ARGUMENT_MISSING');
  return value;
}
function parseRepo(value) {
  if (!REPO_RE.test(value)) throw new ObserverError('CLI_REPO_INVALID');
  return value;
}

export function parseEvidenceJson(raw) {
  const text = String(raw ?? '');
  const jsonText = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { throw new ObserverError('EVIDENCE_JSON_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ObserverError('EVIDENCE_JSON_INVALID');
  return parsed;
}

export async function readEvidenceFile(filePath, { readFileImpl = readFile } = {}) {
  let raw;
  try {
    raw = await readFileImpl(filePath, 'utf8');
  } catch {
    throw new ObserverError('EVIDENCE_FILE_READ_FAILED');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_EVIDENCE_BYTES) throw new ObserverError('EVIDENCE_FILE_TOO_LARGE');
  return parseEvidenceJson(raw);
}

function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isValidPullRequestShape(pr) {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return false;
  if (!isPositiveInt(pr.number)) return false;
  if (pr.state !== 'open' && pr.state !== 'closed') return false;
  if (typeof pr.draft !== 'boolean') return false;
  if (!isNonNegativeInt(pr.additions)) return false;
  if (!isNonNegativeInt(pr.deletions)) return false;
  if (!isNonNegativeInt(pr.changedFiles)) return false;
  if (typeof pr.baseRef !== 'string' || !REF_RE.test(pr.baseRef)) return false;
  if (typeof pr.headSha !== 'string' || !SHA_RE.test(pr.headSha)) return false;
  return true;
}

export function validateWipEvidence(evidence, { repo, nowMs }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (evidence.schemaVersion !== 1) return { ok: false, code: 'EVIDENCE_SCHEMA_UNSUPPORTED' };
  if (evidence.repository !== repo) return { ok: false, code: 'EVIDENCE_REPOSITORY_MISMATCH' };
  if (evidence.retrievalComplete !== true) return { ok: false, code: 'EVIDENCE_RETRIEVAL_INCOMPLETE' };
  if (typeof evidence.fetchedAt !== 'string' || !FETCHED_AT_RE.test(evidence.fetchedAt)) return { ok: false, code: 'EVIDENCE_FETCH_TIME_INVALID' };
  const fetchedMs = Date.parse(evidence.fetchedAt);
  if (!Number.isFinite(fetchedMs) || new Date(fetchedMs).toISOString() !== evidence.fetchedAt) return { ok: false, code: 'EVIDENCE_FETCH_TIME_INVALID' };
  if (fetchedMs > nowMs) return { ok: false, code: 'EVIDENCE_FROM_FUTURE' };
  const age = nowMs - fetchedMs;
  if (age > MAX_EVIDENCE_AGE_MS) return { ok: false, code: 'EVIDENCE_STALE' };
  if (!Array.isArray(evidence.pullRequests) || evidence.pullRequests.length > MAX_PULL_REQUESTS) {
    return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  }
  const seenNumbers = new Set();
  for (const pr of evidence.pullRequests) {
    if (!isValidPullRequestShape(pr)) return { ok: false, code: 'EVIDENCE_PULL_REQUEST_INVALID' };
    if (!Number.isSafeInteger(pr.additions + pr.deletions)) return { ok: false, code: 'EVIDENCE_DIFF_OVERFLOW_PER_PR' };
    if (seenNumbers.has(pr.number)) return { ok: false, code: 'EVIDENCE_PULL_REQUEST_DUPLICATE' };
    seenNumbers.add(pr.number);
  }
  return { ok: true, evidenceFetchedAt: evidence.fetchedAt, pullRequests: evidence.pullRequests };
}

export function aggregatePendingReview(pullRequests) {
  const pending = pullRequests
    .filter(pr => pr.state === 'open' && pr.draft === false)
    .map(pr => {
      const diffLines = pr.additions + pr.deletions;
      if (!Number.isSafeInteger(diffLines)) throw new ObserverError('EVIDENCE_DIFF_OVERFLOW_PER_PR');
      return {
        number: pr.number,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        diffLines,
        baseRef: pr.baseRef,
        headSha: pr.headSha.toLowerCase(),
      };
    });
  let totalPendingDiffLines = 0;
  for (const pr of pending) {
    totalPendingDiffLines += pr.diffLines;
    if (!Number.isSafeInteger(totalPendingDiffLines)) throw new ObserverError('EVIDENCE_DIFF_OVERFLOW_AGGREGATE');
  }
  return { pending, pendingReviewCount: pending.length, totalPendingDiffLines };
}

function failClosedReport({ code, repo, generatedAt }) {
  return {
    ok: false, code, repository: repo, generatedAt, evidenceFetchedAt: null,
    wipMax: WIP_MAX, decision: null, pendingReviewCount: null,
    totalPendingDiffLines: null, pendingPullRequests: null,
  };
}

export function buildReport({ evidence, repo, nowMs, generatedAt }) {
  const validated = validateWipEvidence(evidence, { repo, nowMs });
  if (!validated.ok) return failClosedReport({ code: validated.code, repo, generatedAt });
  let aggregate;
  try {
    aggregate = aggregatePendingReview(validated.pullRequests);
  } catch (error) {
    const code = error instanceof ObserverError ? error.code : 'EVIDENCE_AGGREGATION_FAILED';
    return failClosedReport({ code, repo, generatedAt });
  }
  const { pending, pendingReviewCount, totalPendingDiffLines } = aggregate;
  const decision = pendingReviewCount < WIP_MAX ? 'CONTINUE' : 'STOP_NEW_WORK';
  return {
    ok: true, code: null, schemaVersion: 1, repository: repo, generatedAt, evidenceFetchedAt: validated.evidenceFetchedAt,
    wipMax: WIP_MAX, decision, pendingReviewCount, totalPendingDiffLines,
    pendingPullRequests: pending,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const repo = parseRepo(requireArg(args, 'repo'));
    const evidence = await readEvidenceFile(requireArg(args, 'evidence-file'));
    const nowMs = Date.now();
    const report = buildReport({ evidence, repo, nowMs, generatedAt: new Date(nowMs).toISOString() });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      console.error('WIP_REVIEW_QUEUE_OBSERVER=FAIL');
      console.error(report.code);
      process.exitCode = 2;
      return;
    }
    console.log(`WIP_REVIEW_QUEUE_OBSERVER=${report.decision}`);
  } catch (error) {
    const code = error instanceof ObserverError ? error.code : 'INTERNAL_ERROR';
    console.error('WIP_REVIEW_QUEUE_OBSERVER=FAIL');
    console.error(code);
    process.exitCode = 2;
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await main();
