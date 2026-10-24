#!/usr/bin/env node
// Scope Boundary Gate (Issue #283, part A).
//
// Before an AI creates a new GitHub Issue/PR/comment, or acts on an existing
// one, classify the request against the active Project Context and the
// currently-approved task scope as exactly one of:
//   IN_SCOPE | CROSS_PROJECT | NEW_SCOPE | UNKNOWN
//
// This module is pure evaluation: it never calls GitHub, never creates an
// Issue/PR/comment itself, and never starts a provider/runner. It only turns
// already-available closed evidence into a classification plus an
// allow/deny decision for the caller (poller / orchestrator / human-facing
// packet renderer) to honor. Ambiguous scope expansion (CROSS_PROJECT or
// NEW_SCOPE) is blocked unless an explicit recorded human approval is
// supplied; it is never inferred from recent activity, repo similarity, or
// AI judgment alone.
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const CONTEXT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/;
const ACTIONS = new Set(['CREATE_ISSUE', 'CREATE_PR', 'CREATE_ISSUE_COMMENT', 'CREATE_PR_COMMENT']);
const COMMENT_ACTIONS = new Set(['CREATE_ISSUE_COMMENT', 'CREATE_PR_COMMENT']);
const ALLOWED_KEYS = [
  'schemaVersion', 'activeProjectContextId', 'activeProjectRootRepository', 'approvedRelatedRepositories',
  'requestedAction', 'requestedTargetRepository', 'approvedTaskScopePaths', 'requestedChangePaths',
  'explicitHumanScopeApproval', 'humanApprovalDecisionId',
];

function unknown(code, message, detail = {}) {
  return { result: 'STOP', classification: 'UNKNOWN', allowCreate: false, severity: 'SEVERE', code, message, ...detail };
}
function stopExpansion(code, message, detail = {}) {
  return { result: 'STOP', allowCreate: false, severity: 'SEVERE', code, message, ...detail };
}
function proceed(detail) {
  return { result: 'PROCEED', allowCreate: true, severity: 'NONE', code: 'SCOPE_BOUNDARY_CLEAR', ...detail };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
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
function cleanContextId(value) {
  const id = cleanText(value, 120);
  return id && CONTEXT_ID_RE.test(id) ? id : null;
}
function cleanRepoArray(value, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out = [];
  for (const entry of value) {
    const repo = cleanRepo(entry);
    if (!repo) return null;
    out.push(repo);
  }
  return out;
}
function cleanScopePath(value) {
  const text = cleanText(value, 500);
  if (!text) return null;
  const normalized = text.replace(/\\/g, '/');
  if (normalized !== text) return null;
  if (normalized.startsWith('/') || normalized.startsWith('./') || normalized === '.' ) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return normalized;
}
function cleanScopePathArray(value, maxItems) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return null;
  const out = [];
  for (const entry of value) {
    const path = cleanScopePath(entry);
    if (!path) return null;
    out.push(path);
  }
  return out;
}
// An approved scope path is either an exact repo-relative path, or that same
// shape with a literal trailing '/**' meaning "this directory and everything
// under it" -- the same closed ScopePaths syntax already certified by
// implementation-runner.mjs's pathMatchesScopePattern/validScopePattern, and
// matched here with EXACTLY the same semantics (never broader): a bare
// pattern with no trailing '/**' covers ONLY that exact requested path --
// it never covers children just because they share that directory as a
// prefix. Only an explicit trailing '/**' covers the directory itself and
// everything under it, and even then only at an exact path-segment boundary
// ('/'), so a sibling directory that merely shares a string prefix (e.g.
// '.../preflight-audit-other/x' against an approval for
// '.../preflight-audit/**') is never mistaken for a covered child.
function pathCovered(requestedPath, approvedPath) {
  if (approvedPath.endsWith('/**')) {
    const prefix = approvedPath.slice(0, -3);
    return requestedPath === prefix || requestedPath.startsWith(`${prefix}/`);
  }
  return requestedPath === approvedPath;
}

export function classifyScopeBoundary(input) {
  if (!isPlainObject(input)) return unknown('SCOPE_BOUNDARY_EVIDENCE_INVALID', 'Scope boundary evidence must be a closed JSON object.');
  const keys = Object.keys(input);
  if (keys.length !== ALLOWED_KEYS.length || keys.some((key) => !ALLOWED_KEYS.includes(key))) {
    return unknown('SCOPE_BOUNDARY_EVIDENCE_INVALID', 'Scope boundary evidence must use exactly the closed schema v1 key set.');
  }
  if (input.schemaVersion !== 1) return unknown('SCOPE_BOUNDARY_SCHEMA_UNSUPPORTED', 'Scope boundary evidence schemaVersion=1 is required.');

  const activeProjectContextId = cleanContextId(input.activeProjectContextId);
  const activeProjectRootRepository = cleanRepo(input.activeProjectRootRepository);
  if (!activeProjectContextId || !activeProjectRootRepository) {
    return unknown('SCOPE_BOUNDARY_IDENTITY_MISSING', 'Active Project Context ID and root repository are required.');
  }
  const approvedRelatedRepositories = cleanRepoArray(input.approvedRelatedRepositories, 50);
  if (!approvedRelatedRepositories) return unknown('SCOPE_BOUNDARY_RELATED_REPOS_INVALID', 'approvedRelatedRepositories must be a closed array of owner/repo identifiers.');
  if (approvedRelatedRepositories.includes(activeProjectRootRepository)) return unknown('SCOPE_BOUNDARY_RELATED_REPOS_INVALID', 'Project Root must never also be listed as an approved related repository.');

  if (typeof input.requestedAction !== 'string' || !ACTIONS.has(input.requestedAction)) {
    return unknown('SCOPE_BOUNDARY_ACTION_INVALID', 'requestedAction must be one of CREATE_ISSUE, CREATE_PR, CREATE_ISSUE_COMMENT, CREATE_PR_COMMENT.');
  }
  const requestedAction = input.requestedAction;
  const requestedTargetRepository = cleanRepo(input.requestedTargetRepository);
  if (!requestedTargetRepository) return unknown('SCOPE_BOUNDARY_TARGET_REPO_INVALID', 'requestedTargetRepository must be a valid owner/repo identifier.');

  const isComment = COMMENT_ACTIONS.has(requestedAction);
  if (isComment) {
    if (input.requestedChangePaths !== null) return unknown('SCOPE_BOUNDARY_PATHS_INVALID', 'A comment action must not declare requestedChangePaths; comments do not expand code scope.');
  } else if (input.requestedChangePaths !== null && cleanScopePathArray(input.requestedChangePaths, 500) === null) {
    return unknown('SCOPE_BOUNDARY_PATHS_INVALID', 'requestedChangePaths must be null or a closed array of normalized relative paths.');
  }
  const requestedChangePaths = isComment ? null : (input.requestedChangePaths === null ? null : cleanScopePathArray(input.requestedChangePaths, 500));

  let approvedTaskScopePaths = null;
  if (input.approvedTaskScopePaths !== null) {
    approvedTaskScopePaths = cleanScopePathArray(input.approvedTaskScopePaths, 500);
    if (approvedTaskScopePaths === null) return unknown('SCOPE_BOUNDARY_APPROVED_SCOPE_INVALID', 'approvedTaskScopePaths must be null or a closed array of normalized relative paths.');
  }

  if (typeof input.explicitHumanScopeApproval !== 'boolean') return unknown('SCOPE_BOUNDARY_APPROVAL_FLAG_INVALID', 'explicitHumanScopeApproval must be an explicit boolean.');
  const explicitHumanScopeApproval = input.explicitHumanScopeApproval;
  let humanApprovalDecisionId = null;
  if (input.humanApprovalDecisionId !== null) {
    humanApprovalDecisionId = cleanText(input.humanApprovalDecisionId, 200);
    if (!humanApprovalDecisionId) return unknown('SCOPE_BOUNDARY_APPROVAL_DECISION_ID_INVALID', 'humanApprovalDecisionId must be null or a non-empty resolved identifier.');
  }
  if (explicitHumanScopeApproval && !humanApprovalDecisionId) return unknown('SCOPE_BOUNDARY_APPROVAL_DECISION_ID_MISSING', 'explicitHumanScopeApproval=true requires a traceable humanApprovalDecisionId.');
  if (!explicitHumanScopeApproval && humanApprovalDecisionId) return unknown('SCOPE_BOUNDARY_APPROVAL_FLAG_INCONSISTENT', 'A humanApprovalDecisionId must not be supplied without explicitHumanScopeApproval=true.');

  const repoClass = requestedTargetRepository === activeProjectRootRepository
    ? 'ROOT'
    : (approvedRelatedRepositories.includes(requestedTargetRepository) ? 'RELATED_APPROVED' : 'UNAPPROVED');

  let classification;
  if (repoClass === 'UNAPPROVED') {
    classification = 'CROSS_PROJECT';
  } else if (isComment) {
    classification = 'IN_SCOPE';
  } else if (requestedChangePaths === null || approvedTaskScopePaths === null) {
    classification = 'NEW_SCOPE';
  } else {
    const scopeCovered = requestedChangePaths.every((path) => approvedTaskScopePaths.some((approved) => pathCovered(path, approved)));
    classification = scopeCovered ? 'IN_SCOPE' : 'NEW_SCOPE';
  }

  const base = { classification, repoClass, requestedAction, requestedTargetRepository, activeProjectContextId, activeProjectRootRepository };
  if (classification === 'IN_SCOPE') return proceed(base);
  if (explicitHumanScopeApproval && humanApprovalDecisionId) {
    return proceed({ ...base, code: 'SCOPE_EXPANSION_HUMAN_APPROVED', humanApprovalDecisionId });
  }
  return stopExpansion('SCOPE_EXPANSION_REQUIRES_HUMAN_CONFIRMATION', `${classification} scope expansion requires an explicit recorded human approval before ${requestedAction} may proceed.`, base);
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
    process.stdout.write(`${JSON.stringify(unknown('SCOPE_BOUNDARY_ARGUMENT_INVALID', 'Arguments are invalid or duplicated.'))}\n`);
    process.exitCode = 2;
    return;
  }
  const file = parsed.valued.get('--evidence-file');
  const json = parsed.valued.get('--evidence-json');
  if ((!file && !json) || (file && json)) {
    process.stdout.write(`${JSON.stringify(unknown('SCOPE_BOUNDARY_ARGUMENT_INVALID', 'Use exactly one of --evidence-file or --evidence-json.'))}\n`);
    process.exitCode = 2;
    return;
  }
  let input;
  try { input = JSON.parse(file ? await readFile(file, 'utf8') : json); }
  catch { input = null; }
  const pretty = argv.includes('--pretty');
  const result = input === null ? unknown('SCOPE_BOUNDARY_EVIDENCE_INVALID', 'Evidence JSON is missing or unreadable.') : classifyScopeBoundary(input);
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
  if (result.result === 'STOP') process.exitCode = 2;
}
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main().catch(() => { process.stdout.write(`${JSON.stringify(unknown('SCOPE_BOUNDARY_INTERNAL_ERROR', 'Scope boundary gate failed closed.'))}\n`); process.exitCode = 2; });
