#!/usr/bin/env node
// Phase 1 (Issue #280) bounded source-only slice.
//
// Given already-available sanitized local/synthetic Issue/PR + project
// metadata (never fetched by this module itself), identify new and
// unresolved improvement candidates, deduplicate them against caller-supplied
// known records, preserve each candidate's evidence/time/owner, and reject
// stale evidence, unknown/project-drift, owner mismatch, and protected data.
//
// This module never calls GitHub, never writes an Issue/PR comment, and
// never starts a provider/runner. A caller-supplied `runnerEvidence` on an
// Issue/PR item is itself just schema-shaped metadata copied from the
// Issue/PR -- it carries no authenticated job identity, owner claim,
// receipt, repo/branch/HEAD, or test/PR proof. So a claimed
// "executed"/"completed" item -- whether that claim comes from the
// issue/PR comment text alone, or from an accompanying `runnerEvidence`
// claiming DONE/READY_FOR_REVIEW -- is NEVER marked resolved by this module.
// It always stays a candidate that still needs independent verification
// (see Phase 2's `deriveExecutorReceipt`, which treats the same kind of
// caller-supplied runner claim as unverified for the same reason).
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
export const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
export const MAX_ITEM_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const MAX_EVIDENCE_BYTES = 64 * 1024;
export const MAX_ITEMS = 200;
export const MAX_KNOWN_RECORDS = 500;

const CLI_ARGUMENTS = new Set(['mode', 'repo', 'project-context-id', 'evidence-file', 'dispatch-file']);
const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const EVIDENCE_KEYS = new Set([
  'schemaVersion', 'repository', 'projectContextId', 'expectedOwner',
  'fetchedAt', 'retrievalComplete', 'knownRecords', 'items',
]);
const ITEM_KEYS = new Set([
  'id', 'sourceType', 'number', 'title', 'summary', 'owner', 'projectContextId',
  'createdAt', 'updatedAt', 'state', 'labels', 'protectedData',
  'claimedCompletion', 'runnerEvidence',
]);
const RUNNER_EVIDENCE_KEYS = new Set(['present', 'source', 'state']);

const SOURCE_TYPES = new Set(['issue', 'pr_comment']);
const ITEM_STATES = new Set(['open', 'closed']);
const QUALIFYING_LABELS = new Set(['improvement', 'enhancement']);
const RUNNER_SOURCES = new Set(['ai-job', 'work-state-report', 'test-gate']);
const RUNNER_STATES = new Set(['QUEUED', 'IMPLEMENTING', 'REVIEW', 'READY_FOR_REVIEW', 'DONE', 'FAILED']);

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
function parseProjectContextId(value) {
  if (!ID_RE.test(value)) throw new ObserverError('CLI_PROJECT_CONTEXT_ID_INVALID');
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

function closedObject(value, allowedKeys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key));
}

function cleanText(value, max) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  return true;
}

function isValidTimestamp(value, nowMs) {
  if (typeof value !== 'string' || !ISO_MS_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return false;
  if (typeof nowMs === 'number' && ms > nowMs) return false;
  return true;
}

function isValidRunnerEvidence(value) {
  if (value === null) return true;
  if (!closedObject(value, RUNNER_EVIDENCE_KEYS)) return false;
  if (typeof value.present !== 'boolean') return false;
  if (value.present) {
    if (!RUNNER_SOURCES.has(value.source)) return false;
    if (!RUNNER_STATES.has(value.state)) return false;
  } else if (value.source !== null || value.state !== null) {
    return false;
  }
  return true;
}

function isValidItemShape(item, nowMs) {
  if (!closedObject(item, ITEM_KEYS)) return false;
  if (!ID_RE.test(item.id ?? '')) return false;
  if (!SOURCE_TYPES.has(item.sourceType)) return false;
  if (!Number.isSafeInteger(item.number) || item.number < 1) return false;
  if (!cleanText(item.title, 300)) return false;
  if (!cleanText(item.summary, 2000)) return false;
  if (typeof item.owner !== 'string' || !OWNER_RE.test(item.owner)) return false;
  if (typeof item.projectContextId !== 'string' || !ID_RE.test(item.projectContextId)) return false;
  if (!isValidTimestamp(item.createdAt, nowMs)) return false;
  if (!isValidTimestamp(item.updatedAt, nowMs)) return false;
  if (Date.parse(item.updatedAt) < Date.parse(item.createdAt)) return false;
  if (!ITEM_STATES.has(item.state)) return false;
  if (!Array.isArray(item.labels) || item.labels.length > 20
    || !item.labels.every((label) => typeof label === 'string' && ID_RE.test(label))) return false;
  if (typeof item.protectedData !== 'boolean') return false;
  if (typeof item.claimedCompletion !== 'boolean') return false;
  if (!isValidRunnerEvidence(item.runnerEvidence ?? null)) return false;
  return true;
}

export function validateImprovementFollowupEvidence(evidence, { repo, projectContextId, nowMs }) {
  if (!closedObject(evidence, EVIDENCE_KEYS)) return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  if (evidence.schemaVersion !== SCHEMA_VERSION) return { ok: false, code: 'EVIDENCE_SCHEMA_UNSUPPORTED' };
  if (evidence.repository !== repo) return { ok: false, code: 'EVIDENCE_REPOSITORY_MISMATCH' };
  if (evidence.projectContextId !== projectContextId) return { ok: false, code: 'EVIDENCE_PROJECT_CONTEXT_MISMATCH' };
  if (typeof evidence.expectedOwner !== 'string' || !OWNER_RE.test(evidence.expectedOwner)) {
    return { ok: false, code: 'EVIDENCE_EXPECTED_OWNER_INVALID' };
  }
  if (evidence.retrievalComplete !== true) return { ok: false, code: 'EVIDENCE_RETRIEVAL_INCOMPLETE' };
  if (!isValidTimestamp(evidence.fetchedAt, undefined)) return { ok: false, code: 'EVIDENCE_FETCH_TIME_INVALID' };
  const fetchedMs = Date.parse(evidence.fetchedAt);
  if (fetchedMs > nowMs) return { ok: false, code: 'EVIDENCE_FROM_FUTURE' };
  if (nowMs - fetchedMs > MAX_EVIDENCE_AGE_MS) return { ok: false, code: 'EVIDENCE_STALE' };
  if (!Array.isArray(evidence.knownRecords) || evidence.knownRecords.length > MAX_KNOWN_RECORDS) {
    return { ok: false, code: 'EVIDENCE_KNOWN_RECORDS_INVALID' };
  }
  const knownIds = new Set();
  for (const id of evidence.knownRecords) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, code: 'EVIDENCE_KNOWN_RECORD_INVALID' };
    if (knownIds.has(id)) return { ok: false, code: 'EVIDENCE_KNOWN_RECORD_DUPLICATE' };
    knownIds.add(id);
  }
  if (!Array.isArray(evidence.items) || evidence.items.length > MAX_ITEMS) {
    return { ok: false, code: 'EVIDENCE_SHAPE_INVALID' };
  }
  const seenIds = new Set();
  for (const item of evidence.items) {
    if (!isValidItemShape(item, nowMs)) return { ok: false, code: 'EVIDENCE_ITEM_INVALID' };
    if (seenIds.has(item.id)) return { ok: false, code: 'EVIDENCE_ITEM_DUPLICATE' };
    seenIds.add(item.id);
  }
  return {
    ok: true,
    evidenceFetchedAt: evidence.fetchedAt,
    expectedOwner: evidence.expectedOwner,
    knownIds,
    items: evidence.items,
  };
}

function classifyItem(item, { knownIds, nowMs, projectContextId, expectedOwner }) {
  if (item.projectContextId !== projectContextId) return { code: 'PROJECT_CONTEXT_DRIFT' };
  if (item.owner !== expectedOwner) return { code: 'OWNER_MISMATCH' };
  if (item.protectedData !== false) return { code: 'PROTECTED_DATA_EXCLUDED' };
  if (knownIds.has(item.id)) return { code: 'DUPLICATE_KNOWN_RECORD' };
  const updatedMs = Date.parse(item.updatedAt);
  if (nowMs - updatedMs > MAX_ITEM_AGE_MS) return { code: 'STALE_EVIDENCE' };
  if (!item.labels.some((label) => QUALIFYING_LABELS.has(label))) return { code: 'NOT_IMPROVEMENT' };
  if (item.claimedCompletion === true) {
    // The issue/PR item claims "executed"/"completed", and may even carry a
    // schema-shaped `runnerEvidence` (for example source: work-state-report,
    // state: DONE or READY_FOR_REVIEW). But that `runnerEvidence` is only
    // caller-supplied Issue/PR metadata -- it has no authenticated job
    // identity, owner claim, receipt, repo/branch/HEAD, or test/PR proof
    // attached. It is never independent completion evidence by itself, so it
    // can never confirm resolution here. Always keep this as a candidate
    // that still needs independent verification -- never report it as
    // CONFIRMED_RESOLVED from this metadata alone.
    return { code: 'UNVERIFIED_COMPLETION_CLAIM', status: 'NEEDS_VERIFICATION' };
  }
  if (item.state === 'closed') return { code: 'CLOSED_NOT_ACTIONABLE' };
  return { code: 'NEW_CANDIDATE', status: 'NEW' };
}

function buildCandidate(item, classification) {
  return {
    id: item.id,
    sourceType: item.sourceType,
    number: item.number,
    title: item.title,
    summary: item.summary,
    owner: item.owner,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    status: classification.status,
  };
}

export function aggregateCandidates(items, opts) {
  const candidates = [];
  const excluded = [];
  for (const item of items) {
    const classification = classifyItem(item, opts);
    if (classification.status) candidates.push(buildCandidate(item, classification));
    else excluded.push({ id: item.id, code: classification.code });
  }
  return { candidates, excluded };
}

function failClosedReport({ code, repo, projectContextId, generatedAt }) {
  return {
    schemaVersion: SCHEMA_VERSION, ok: false, code, repository: repo, projectContextId, generatedAt,
    evidenceFetchedAt: null, decision: null, newCandidateCount: null, needsVerificationCount: null,
    candidates: null, excluded: null,
  };
}

export function buildReport({ evidence, repo, projectContextId, nowMs, generatedAt }) {
  const validated = validateImprovementFollowupEvidence(evidence, { repo, projectContextId, nowMs });
  if (!validated.ok) return failClosedReport({ code: validated.code, repo, projectContextId, generatedAt });
  const { candidates, excluded } = aggregateCandidates(validated.items, {
    knownIds: validated.knownIds, nowMs, projectContextId, expectedOwner: validated.expectedOwner,
  });
  const newCandidateCount = candidates.filter((c) => c.status === 'NEW').length;
  const needsVerificationCount = candidates.filter((c) => c.status === 'NEEDS_VERIFICATION').length;
  const decision = (newCandidateCount > 0 || needsVerificationCount > 0) ? 'HAS_FOLLOWUP' : 'NO_FOLLOWUP';
  return {
    schemaVersion: SCHEMA_VERSION, ok: true, code: null, repository: repo, projectContextId, generatedAt,
    evidenceFetchedAt: validated.evidenceFetchedAt, decision, newCandidateCount, needsVerificationCount,
    candidates, excluded,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 (Issue #280) bounded source-only dispatch classification slice.
//
// Given a HUMAN-approved active-task identity snapshot (exact source
// project/repository, Issue number, branch, worktree, job, HEAD), a live
// Project Root/owner snapshot, and already-sanitized improvement candidates
// (each carrying the dispatch-specific fields validated below), classify
// every candidate as IN_SCOPE / CROSS_PROJECT / NEW_SCOPE / UNKNOWN relative
// to the active task. This never mutates the active task, current branch,
// current worktree, or current repository files -- it only ever returns a
// plan. For a CROSS_PROJECT technical bugfix, or a relevant IN_SCOPE
// technical bugfix, it builds a concrete seven-part executable handoff
// instruction and a deduplicated append-vs-new-issue decision against a
// caller-supplied fresh/complete existing-Issue list. NEW_SCOPE is planned
// as a proposal only, not recorded externally (no source change). UNKNOWN (unrecognized owner or
// project), protected data, and stale dispatch evidence block only that one
// candidate -- never the rest of the batch, and never an external handoff.
//
// This module still never calls GitHub, never posts/creates an Issue or PR
// comment, and never starts a provider/runner. The batch-level `decision`
// and every per-item `dispatchStatus` are restricted to
// PLAN_READY / NOT_STARTED / UNKNOWN -- never POSTED, RUNNING, or DONE --
// because this slice only ever produces a plan. Caller-supplied runner claims are retained as unverified metadata in
// `executorReceipt`: no authentic job receipt is available to this local
// source-only classifier. A claimed running/completed state stays UNKNOWN
// until a separate qualified work-state verification explicitly proves it.
export const MAX_SNAPSHOT_AGE_MS = MAX_EVIDENCE_AGE_MS;
export const MAX_OWNED_REPOSITORIES = 100;
export const MAX_EXISTING_ISSUES = 200;
export const MAX_DISPATCH_CANDIDATES = 200;
export const MAX_DISPATCH_PATHS = 20;

const SHA40_RE = /^[0-9a-f]{40}$/;
const SAFE_GIT_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;
function isSafeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 260 && SAFE_PATH_RE.test(value);
}

const ACTIVE_TASK_KEYS = new Set(['projectContextId', 'repository', 'issueNumber', 'branch', 'worktree', 'headSha', 'jobId', 'capturedAt']);
const PROJECT_SNAPSHOT_KEYS = new Set(['projectContextId', 'projectRootRepository', 'owner', 'ownedRepositories', 'capturedAt']);
const EXISTING_ISSUES_BATCH_KEYS = new Set(['fetchedAt', 'retrievalComplete', 'entries']);
const EXISTING_ISSUE_ENTRY_KEYS = new Set(['number', 'repository', 'dedupKey', 'branch', 'worktree', 'headSha']);
const DISPATCH_CANDIDATE_KEYS = new Set([
  'id', 'subjectOwner', 'subjectRepository', 'relatedIssueNumber', 'title', 'kind',
  'protectedData', 'capturedAt', 'causeVerified', 'causeDescription', 'desiredOutcome',
  'allowedPaths', 'forbiddenPaths', 'reproductionCommand', 'testCommand', 'dedupKey', 'runnerEvidence',
]);
const CANDIDATE_KINDS = new Set(['technical_bugfix', 'feature', 'other']);

function freshTimestamp(value, nowMs) {
  if (!isValidTimestamp(value, nowMs)) return null;
  return Date.parse(value);
}

export function validateActiveTask(value, nowMs) {
  if (!closedObject(value, ACTIVE_TASK_KEYS)) return { ok: false, code: 'ACTIVE_TASK_SHAPE_INVALID' };
  if (typeof value.projectContextId !== 'string' || !ID_RE.test(value.projectContextId)) return { ok: false, code: 'ACTIVE_TASK_PROJECT_CONTEXT_INVALID' };
  if (!REPO_RE.test(value.repository ?? '')) return { ok: false, code: 'ACTIVE_TASK_REPOSITORY_INVALID' };
  if (!Number.isSafeInteger(value.issueNumber) || value.issueNumber < 1) return { ok: false, code: 'ACTIVE_TASK_ISSUE_NUMBER_INVALID' };
  if (typeof value.branch !== 'string' || value.branch.length > 250 || !SAFE_GIT_BRANCH_RE.test(value.branch) || value.branch.includes('..')) return { ok: false, code: 'ACTIVE_TASK_BRANCH_INVALID' };
  if (!cleanText(value.worktree, 400)) return { ok: false, code: 'ACTIVE_TASK_WORKTREE_INVALID' };
  if (typeof value.headSha !== 'string' || !SHA40_RE.test(value.headSha)) return { ok: false, code: 'ACTIVE_TASK_HEAD_SHA_INVALID' };
  if (typeof value.jobId !== 'string' || !ID_RE.test(value.jobId)) return { ok: false, code: 'ACTIVE_TASK_JOB_ID_INVALID' };
  const capturedMs = freshTimestamp(value.capturedAt, nowMs);
  if (capturedMs === null) return { ok: false, code: 'ACTIVE_TASK_SNAPSHOT_TIME_INVALID' };
  if (nowMs - capturedMs > MAX_SNAPSHOT_AGE_MS) return { ok: false, code: 'ACTIVE_TASK_SNAPSHOT_STALE' };
  return {
    ok: true,
    value: {
      projectContextId: value.projectContextId, repository: value.repository, issueNumber: value.issueNumber,
      branch: value.branch, worktree: value.worktree, headSha: value.headSha, jobId: value.jobId, capturedAt: value.capturedAt,
    },
  };
}

export function validateProjectSnapshot(value, nowMs) {
  if (!closedObject(value, PROJECT_SNAPSHOT_KEYS)) return { ok: false, code: 'PROJECT_SNAPSHOT_SHAPE_INVALID' };
  if (typeof value.projectContextId !== 'string' || !ID_RE.test(value.projectContextId)) return { ok: false, code: 'PROJECT_SNAPSHOT_PROJECT_CONTEXT_INVALID' };
  if (!REPO_RE.test(value.projectRootRepository ?? '')) return { ok: false, code: 'PROJECT_SNAPSHOT_ROOT_REPOSITORY_INVALID' };
  if (typeof value.owner !== 'string' || !OWNER_RE.test(value.owner)) return { ok: false, code: 'PROJECT_SNAPSHOT_OWNER_INVALID' };
  if (value.projectRootRepository.split('/')[0] !== value.owner) return { ok: false, code: 'PROJECT_SNAPSHOT_ROOT_REPOSITORY_OWNER_MISMATCH' };
  if (!Array.isArray(value.ownedRepositories) || value.ownedRepositories.length > MAX_OWNED_REPOSITORIES) {
    return { ok: false, code: 'PROJECT_SNAPSHOT_OWNED_REPOSITORIES_INVALID' };
  }
  const seenRepos = new Set();
  for (const repo of value.ownedRepositories) {
    if (!REPO_RE.test(repo) || repo.split('/')[0] !== value.owner) return { ok: false, code: 'PROJECT_SNAPSHOT_OWNED_REPOSITORY_INVALID' };
    if (seenRepos.has(repo)) return { ok: false, code: 'PROJECT_SNAPSHOT_OWNED_REPOSITORY_DUPLICATE' };
    seenRepos.add(repo);
  }
  const capturedMs = freshTimestamp(value.capturedAt, nowMs);
  if (capturedMs === null) return { ok: false, code: 'PROJECT_SNAPSHOT_TIME_INVALID' };
  if (nowMs - capturedMs > MAX_SNAPSHOT_AGE_MS) return { ok: false, code: 'PROJECT_SNAPSHOT_STALE' };
  return {
    ok: true,
    value: {
      projectContextId: value.projectContextId, projectRootRepository: value.projectRootRepository,
      owner: value.owner, ownedRepositories: [...value.ownedRepositories], capturedAt: value.capturedAt,
    },
  };
}

export function validateExistingIssuesBatch(value, nowMs) {
  if (!closedObject(value, EXISTING_ISSUES_BATCH_KEYS)) return { ok: false, code: 'EXISTING_ISSUES_SHAPE_INVALID' };
  if (value.retrievalComplete !== true) return { ok: false, code: 'EXISTING_ISSUES_RETRIEVAL_INCOMPLETE' };
  const fetchedMs = freshTimestamp(value.fetchedAt, nowMs);
  if (fetchedMs === null) return { ok: false, code: 'EXISTING_ISSUES_FETCH_TIME_INVALID' };
  if (nowMs - fetchedMs > MAX_SNAPSHOT_AGE_MS) return { ok: false, code: 'EXISTING_ISSUES_STALE' };
  if (!Array.isArray(value.entries) || value.entries.length > MAX_EXISTING_ISSUES) return { ok: false, code: 'EXISTING_ISSUES_ENTRIES_INVALID' };
  const seen = new Set();
  const entries = [];
  for (const entry of value.entries) {
    if (!closedObject(entry, EXISTING_ISSUE_ENTRY_KEYS)) return { ok: false, code: 'EXISTING_ISSUE_SHAPE_INVALID' };
    if (!Number.isSafeInteger(entry.number) || entry.number < 1) return { ok: false, code: 'EXISTING_ISSUE_NUMBER_INVALID' };
    if (!REPO_RE.test(entry.repository ?? '')) return { ok: false, code: 'EXISTING_ISSUE_REPOSITORY_INVALID' };
    if (typeof entry.dedupKey !== 'string' || !ID_RE.test(entry.dedupKey)) return { ok: false, code: 'EXISTING_ISSUE_DEDUP_KEY_INVALID' };
    if (entry.branch !== null && (typeof entry.branch !== 'string' || !ID_RE.test(entry.branch))) return { ok: false, code: 'EXISTING_ISSUE_BRANCH_INVALID' };
    if (entry.worktree !== null && !cleanText(entry.worktree, 400)) return { ok: false, code: 'EXISTING_ISSUE_WORKTREE_INVALID' };
    if (entry.headSha !== null && (typeof entry.headSha !== 'string' || !SHA40_RE.test(entry.headSha))) return { ok: false, code: 'EXISTING_ISSUE_HEAD_SHA_INVALID' };
    const key = `${entry.repository}#${entry.number}`;
    if (seen.has(key)) return { ok: false, code: 'EXISTING_ISSUE_DUPLICATE' };
    seen.add(key);
    entries.push({ number: entry.number, repository: entry.repository, dedupKey: entry.dedupKey, branch: entry.branch, worktree: entry.worktree, headSha: entry.headSha });
  }
  return { ok: true, value: entries };
}

function validateDispatchCandidateShape(item, nowMs) {
  if (!closedObject(item, DISPATCH_CANDIDATE_KEYS)) return false;
  if (!ID_RE.test(item.id ?? '')) return false;
  if (typeof item.subjectOwner !== 'string' || !OWNER_RE.test(item.subjectOwner)) return false;
  if (!REPO_RE.test(item.subjectRepository ?? '') || item.subjectRepository.split('/')[0] !== item.subjectOwner) return false;
  if (item.relatedIssueNumber !== null && (!Number.isSafeInteger(item.relatedIssueNumber) || item.relatedIssueNumber < 1)) return false;
  if (!cleanText(item.title, 300)) return false;
  if (!CANDIDATE_KINDS.has(item.kind)) return false;
  if (typeof item.protectedData !== 'boolean') return false;
  if (!isValidTimestamp(item.capturedAt, nowMs)) return false;
  if (typeof item.causeVerified !== 'boolean') return false;
  if (!cleanText(item.causeDescription, 2000)) return false;
  if (!cleanText(item.desiredOutcome, 1000)) return false;
  if (!Array.isArray(item.allowedPaths) || item.allowedPaths.length === 0 || item.allowedPaths.length > MAX_DISPATCH_PATHS
    || !item.allowedPaths.every(isSafeRelativePath)) return false;
  if (!Array.isArray(item.forbiddenPaths) || item.forbiddenPaths.length > MAX_DISPATCH_PATHS
    || !item.forbiddenPaths.every(isSafeRelativePath)) return false;
  if (!cleanText(item.reproductionCommand, 1000)) return false;
  if (!cleanText(item.testCommand, 1000)) return false;
  if (typeof item.dedupKey !== 'string' || !ID_RE.test(item.dedupKey)) return false;
  if (!isValidRunnerEvidence(item.runnerEvidence ?? null)) return false;
  return true;
}

export function validateDispatchCandidates(items, nowMs) {
  if (!Array.isArray(items) || items.length > MAX_DISPATCH_CANDIDATES) return { ok: false, code: 'DISPATCH_CANDIDATES_INVALID' };
  const seen = new Set();
  for (const item of items) {
    if (!validateDispatchCandidateShape(item, nowMs)) return { ok: false, code: 'DISPATCH_CANDIDATE_INVALID' };
    if (seen.has(item.id)) return { ok: false, code: 'DISPATCH_CANDIDATE_DUPLICATE' };
    seen.add(item.id);
  }
  return { ok: true, value: items };
}

function deriveExecutorReceipt(runnerEvidence) {
  // Caller-supplied evidence is NOT an attested job receipt; Phase 2
  // cannot authenticate a runner state, even if it claims DONE.
  if (!runnerEvidence || runnerEvidence.present !== true) {
    return { runnerStatus: 'NOT_STARTED', source: null, claimedRunnerStatus: null, evidenceVerified: false };
  }
  return { runnerStatus: 'UNKNOWN', source: null, claimedRunnerStatus: runnerEvidence.state,
    claimedSource: runnerEvidence.source, evidenceVerified: false };
}

// The seven required executable-instruction parts: (1) verified vs
// unverified cause/evidence, (2) desired outcome, (3) owner/target repo/
// allowed paths, (4) forbidden paths/authority, (5) reproduction and test
// command, (6) independent audit and draft PR outcome, (7) executor/runner
// state and actual receipt pointer (only real evidence, never fabricated).
function buildInstruction(candidate, { targetRepository, action, existingIssueNumber }) {
  return {
    causeEvidence: candidate.causeVerified
      ? { verified: candidate.causeDescription, unverified: null }
      : { verified: null, unverified: candidate.causeDescription },
    desiredOutcome: candidate.desiredOutcome,
    ownerTargetRepoAllowedPaths: { owner: candidate.subjectOwner, targetRepository, allowedPaths: [...candidate.allowedPaths] },
    forbiddenPathsAndAuthority: {
      forbiddenPaths: [...candidate.forbiddenPaths],
      authority: 'Executor performs source edits only; no auto-merge/auto-push/provider-start. An independent reviewer audits and opens a Draft PR; human merge approval is required.',
    },
    reproductionAndTestCommand: { reproductionCommand: candidate.reproductionCommand, testCommand: candidate.testCommand },
    auditAndDraftPrOutcome: action === 'APPEND_EXISTING'
      ? `Append this instruction to existing Issue #${existingIssueNumber} in ${targetRepository}; independent reviewer audits and opens a Draft PR against that Issue.`
      : `Open a new Issue in ${targetRepository} with this instruction; independent reviewer audits and opens a Draft PR against that Issue.`,
    executorReceipt: deriveExecutorReceipt(candidate.runnerEvidence),
  };
}

function buildDispatchPlan(candidate, { activeTask, classification, existingIssuesByRepo }) {
  const eligible = classification === 'CROSS_PROJECT' || (classification === 'IN_SCOPE' && candidate.kind === 'technical_bugfix');
  if (!eligible) return { dispatchStatus: 'NOT_STARTED', code: 'NOT_ELIGIBLE_FOR_DISPATCH_PLAN', dispatch: null };
  const targetRepository = classification === 'CROSS_PROJECT' ? candidate.subjectRepository : activeTask.repository;
  const matches = (existingIssuesByRepo.get(targetRepository) ?? []).filter((entry) => entry.dedupKey === candidate.dedupKey);
  // More than one existing-Issue record claiming the same dedup key in the
  // same repository is an unresolved conflict (for example two worktrees
  // both claiming ownership with different branch/worktree/head identity):
  // fail closed for this one candidate rather than guessing which record is
  // authoritative.
  if (matches.length > 1) return { dispatchStatus: 'UNKNOWN', code: 'EXISTING_ISSUE_DEDUP_CONFLICT', dispatch: null };
  const existingIssueNumber = matches.length === 1 ? matches[0].number : null;
  const action = existingIssueNumber ? 'APPEND_EXISTING' : 'NEW_ISSUE';
  const instruction = buildInstruction(candidate, { targetRepository, action, existingIssueNumber });
  return {
    dispatchStatus: 'PLAN_READY',
    code: 'DISPATCH_PLAN_READY',
    dispatch: { action, targetRepository, dedupKey: candidate.dedupKey, existingIssueNumber, instruction },
  };
}

export function classifyDispatchCandidate(candidate, { activeTask, projectSnapshot, knownRepos, existingIssuesByRepo, nowMs }) {
  // Protected data, unrecognized owner/project, and stale dispatch evidence
  // block only this one candidate (UNKNOWN) and never produce a plan/
  // external handoff; they never fail the rest of the batch.
  if (candidate.protectedData === true) {
    return { id: candidate.id, classification: 'UNKNOWN', code: 'PROTECTED_DATA_EXCLUDED', dispatchStatus: 'NOT_STARTED', dispatch: null, proposal: null };
  }
  const capturedMs = Date.parse(candidate.capturedAt);
  if (nowMs - capturedMs > MAX_SNAPSHOT_AGE_MS) {
    return { id: candidate.id, classification: 'UNKNOWN', code: 'DISPATCH_EVIDENCE_STALE', dispatchStatus: 'NOT_STARTED', dispatch: null, proposal: null };
  }
  const recognized = knownRepos.has(candidate.subjectRepository) && candidate.subjectOwner === projectSnapshot.owner;
  if (!recognized) {
    return { id: candidate.id, classification: 'UNKNOWN', code: 'OWNER_OR_PROJECT_UNRECOGNIZED', dispatchStatus: 'NOT_STARTED', dispatch: null, proposal: null };
  }
  if (candidate.subjectRepository === activeTask.repository) {
    // Same repository as the active task: either it is the very thing the
    // active task's Issue already covers (IN_SCOPE), or it is a different,
    // unrelated issue/feature in the same repository (NEW_SCOPE). NEW_SCOPE
    // never changes source; it is recorded as a proposal only.
    if (candidate.relatedIssueNumber === activeTask.issueNumber) {
      const plan = buildDispatchPlan(candidate, { activeTask, classification: 'IN_SCOPE', existingIssuesByRepo });
      return { id: candidate.id, classification: 'IN_SCOPE', code: plan.code, dispatchStatus: plan.dispatchStatus, dispatch: plan.dispatch, proposal: null };
    }
    return {
      id: candidate.id, classification: 'NEW_SCOPE', code: 'NEW_SCOPE_PROPOSAL_ONLY', dispatchStatus: 'NOT_STARTED',
      dispatch: null, proposal: { recorded: false, planned: true, note: 'NEW_SCOPE_NO_SOURCE_CHANGE' },
    };
  }
  // Different repository than the active task, but a recognized owner/
  // project: a cross-project finding. The active task, its branch, and its
  // repository files are never touched for this classification.
  if (candidate.kind !== 'technical_bugfix') {
    return { id: candidate.id, classification: 'CROSS_PROJECT', code: 'CROSS_PROJECT_PROPOSAL_ONLY',
      dispatchStatus: 'NOT_STARTED', dispatch: null,
      proposal: { recorded: false, planned: true, note: 'REQUIRES_HUMAN_DECISION' } };
  }
  const plan = buildDispatchPlan(candidate, { activeTask, classification: 'CROSS_PROJECT', existingIssuesByRepo });
  return { id: candidate.id, classification: 'CROSS_PROJECT', code: plan.code, dispatchStatus: plan.dispatchStatus, dispatch: plan.dispatch, proposal: null };
}

function failClosedDispatchReport({ code, generatedAt }) {
  return { schemaVersion: SCHEMA_VERSION, ok: false, code, generatedAt, activeTaskSnapshot: null, decision: null, items: null };
}

// Top-level Phase 2 entry point. `decision` and every item's `dispatchStatus`
// are restricted to PLAN_READY / NOT_STARTED / UNKNOWN; this function never
// posts to GitHub, never starts a provider/runner, and never mutates
// `activeTask` (the validated snapshot is echoed back verbatim).
export function buildDispatchReport({ candidates, activeTask, projectSnapshot, existingIssues, nowMs, generatedAt }) {
  const activeTaskValidated = validateActiveTask(activeTask, nowMs);
  if (!activeTaskValidated.ok) return failClosedDispatchReport({ code: activeTaskValidated.code, generatedAt });
  const snapshotValidated = validateProjectSnapshot(projectSnapshot, nowMs);
  if (!snapshotValidated.ok) return failClosedDispatchReport({ code: snapshotValidated.code, generatedAt });
  if (activeTaskValidated.value.projectContextId !== snapshotValidated.value.projectContextId) {
    return failClosedDispatchReport({ code: 'DISPATCH_PROJECT_CONTEXT_MISMATCH', generatedAt });
  }
  const allowedTaskRepos = new Set([snapshotValidated.value.projectRootRepository, ...snapshotValidated.value.ownedRepositories]);
  if (!allowedTaskRepos.has(activeTaskValidated.value.repository)) {
    return failClosedDispatchReport({ code: 'DISPATCH_ACTIVE_REPOSITORY_OUT_OF_SCOPE', generatedAt });
  }
  const existingValidated = validateExistingIssuesBatch(existingIssues, nowMs);
  if (!existingValidated.ok) return failClosedDispatchReport({ code: existingValidated.code, generatedAt });
  const candidatesValidated = validateDispatchCandidates(candidates, nowMs);
  if (!candidatesValidated.ok) return failClosedDispatchReport({ code: candidatesValidated.code, generatedAt });

  const knownRepos = new Set([snapshotValidated.value.projectRootRepository, ...snapshotValidated.value.ownedRepositories]);
  const existingIssuesByRepo = new Map();
  for (const entry of existingValidated.value) {
    if (!existingIssuesByRepo.has(entry.repository)) existingIssuesByRepo.set(entry.repository, []);
    existingIssuesByRepo.get(entry.repository).push(entry);
  }
  const items = candidatesValidated.value.map((candidate) => classifyDispatchCandidate(candidate, {
    activeTask: activeTaskValidated.value, projectSnapshot: snapshotValidated.value, knownRepos, existingIssuesByRepo, nowMs,
  }));
  const decision = items.some((item) => item.dispatchStatus === 'PLAN_READY')
    ? 'PLAN_READY'
    : items.some((item) => item.dispatchStatus === 'UNKNOWN')
      ? 'UNKNOWN'
      : 'NOT_STARTED';
  return {
    schemaVersion: SCHEMA_VERSION, ok: true, code: null, generatedAt,
    activeTaskSnapshot: { ...activeTaskValidated.value }, decision, items,
  };
}

async function runFollowupCli(args) {
  const repo = parseRepo(requireArg(args, 'repo'));
  const projectContextId = parseProjectContextId(requireArg(args, 'project-context-id'));
  const evidence = await readEvidenceFile(requireArg(args, 'evidence-file'));
  const nowMs = Date.now();
  const report = buildReport({
    evidence, repo, projectContextId, nowMs, generatedAt: new Date(nowMs).toISOString(),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('IMPROVEMENT_FOLLOWUP=FAIL');
    console.error(report.code);
    process.exitCode = 2;
    return;
  }
  console.log(`IMPROVEMENT_FOLLOWUP=${report.decision}`);
}

async function runDispatchCli(args) {
  const input = await readEvidenceFile(requireArg(args, 'dispatch-file'));
  const nowMs = Date.now();
  const report = buildDispatchReport({
    candidates: input?.candidates, activeTask: input?.activeTask,
    projectSnapshot: input?.projectSnapshot, existingIssues: input?.existingIssues,
    nowMs, generatedAt: new Date(nowMs).toISOString(),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('IMPROVEMENT_FOLLOWUP_DISPATCH=FAIL');
    console.error(report.code);
    process.exitCode = 2;
    return;
  }
  console.log(`IMPROVEMENT_FOLLOWUP_DISPATCH=${report.decision}`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const mode = args.mode ?? 'followup';
    if (mode === 'dispatch') { await runDispatchCli(args); return; }
    if (mode !== 'followup') throw new ObserverError('CLI_MODE_INVALID');
    await runFollowupCli(args);
  } catch (error) {
    const code = error instanceof ObserverError ? error.code : 'INTERNAL_ERROR';
    console.error('IMPROVEMENT_FOLLOWUP=FAIL');
    console.error(code);
    process.exitCode = 2;
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await main();
