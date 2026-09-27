#!/usr/bin/env node
// Fail-closed LEGACY audit for implementation work that was actually completed
// before this file existed. This is a rescue-only corroboration route. It
// never produces implementation-runner executionEvidence, never weakens
// implementation-route-receipt, and never substitutes for the normal
// implementation-orchestrator -> implementation-runner -> receipt path. New
// work after LEGACY_ELIGIBILITY_CUTOFF_UTC MUST use that normal route; this
// module only audits commits whose own committer timestamp already predates
// the cutoff, so it cannot be used to launder new work through a "legacy"
// label.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  verifyFeatureRepository,
  verifyWorktreeClean,
  verifyRepositoryIdentity,
  readHeadSha,
  validScopePattern,
  changedPathsWithinScope,
  changedPathsInForbiddenScope,
} from './implementation-runner.mjs';

const SCHEMA = 'LEGACY_IMPLEMENTATION_AUDIT_V1';
const SCHEMA_VERSION = 1;
const EVIDENCE_NATURE = 'LEGACY_CORROBORATION_NOT_RUNNER_ATTESTATION';

// Conservative cutoff: this feature's own introduction time. Equivalent to
// 2026-09-25T23:59:59+09:00. Any audited implementation commit whose own
// committer timestamp is after this instant is ineligible for this route by
// design -- there is no exception path for "new work, but call it legacy".
export const LEGACY_ELIGIBILITY_CUTOFF_UTC = '2026-09-25T14:59:59Z';

export const LEGACY_REASONS = new Set(['PRE_RECEIPT_WORK', 'NORMAL_ENTRY_MISSED_BEFORE_ENFORCEMENT']);
const CLI_ENTRYPOINTS = new Set(['sdk-cli', 'cli']);
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk']);
const SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 32;
const MAX_SYNTH_ROOTS = 16;
const VERIFICATION_KEYS = ['testGate', 'canonicalContract', 'humanDecisionSync', 'finalRealityCheck'];

const ALLOWED_KEYS = new Set([
  'schemaVersion', 'taskId', 'repoRoot', 'branch', 'expectedHead', 'baseHead', 'repository',
  'allowedScope', 'forbiddenScope', 'expectedChangedPaths', 'implementationWindow',
  'legacyReason', 'implementationAI', 'claudeEvidenceFiles', 'expectedEvidenceSha256',
  'allowedSyntheticEvidenceRoots', 'currentHeadVerifications',
]);

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function branchToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value);
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function repoRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') &&
    !value.startsWith('/') && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}
function absolutePathString(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !value.includes('\0') &&
    (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value));
}
function validRepository(repository) {
  return repository && typeof repository === 'object' && !Array.isArray(repository) &&
    Object.keys(repository).every((key) => key === 'owner' || key === 'name') &&
    safeToken(repository.owner) && safeToken(repository.name);
}
function validVerification(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => key === 'status' || key === 'head') &&
    typeof value.status === 'string' && value.status.length > 0 && value.status.length <= 40 &&
    SHA_RE.test(value.head || '');
}

// Same closed scope-pattern shape as implementation-runner (exact path, or
// exact path + literal trailing '/**'). Reused via validScopePattern; this
// module never redefines or loosens that predicate.
export function validateLegacyAuditInput(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['payload_not_object'];
  const errors = [];
  if (payload.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion_invalid');
  if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) errors.push('unknown_field');
  if (payload.taskId !== undefined && !safeToken(payload.taskId)) errors.push('taskId_invalid');
  if (!nonEmptyString(payload.repoRoot) || payload.repoRoot.length > 4096) errors.push('repoRoot_invalid');
  if (!branchToken(payload.branch)) errors.push('branch_invalid');
  if (!SHA_RE.test(payload.expectedHead || '')) errors.push('expectedHead_invalid');
  if (!SHA_RE.test(payload.baseHead || '')) errors.push('baseHead_invalid');
  if (!validRepository(payload.repository)) errors.push('repository_invalid');
  if (!Array.isArray(payload.allowedScope) || payload.allowedScope.length === 0 || payload.allowedScope.length > 200 ||
      !payload.allowedScope.every((item) => validScopePattern(item))) {
    errors.push('allowedScope_invalid');
  }
  if (payload.forbiddenScope !== undefined && (!Array.isArray(payload.forbiddenScope) || payload.forbiddenScope.length > 200 ||
      !payload.forbiddenScope.every((item) => validScopePattern(item)))) {
    errors.push('forbiddenScope_invalid');
  }
  if (payload.expectedChangedPaths !== undefined && (!Array.isArray(payload.expectedChangedPaths) ||
      payload.expectedChangedPaths.length === 0 || payload.expectedChangedPaths.length > 2000 ||
      !payload.expectedChangedPaths.every((item) => repoRelativePath(item)))) {
    errors.push('expectedChangedPaths_invalid');
  }
  const win = payload.implementationWindow;
  if (!win || typeof win !== 'object' || Array.isArray(win) ||
      Object.keys(win).some((key) => key !== 'startUtc' && key !== 'endUtc') ||
      !ISO_UTC_RE.test(win.startUtc || '') || !ISO_UTC_RE.test(win.endUtc || '') ||
      Date.parse(win.startUtc) > Date.parse(win.endUtc)) {
    errors.push('implementationWindow_invalid');
  }
  if (!LEGACY_REASONS.has(payload.legacyReason)) errors.push('legacyReason_invalid');
  if (payload.implementationAI !== 'claude-cli') errors.push('implementationAI_invalid');
  if (!Array.isArray(payload.claudeEvidenceFiles) || payload.claudeEvidenceFiles.length === 0 ||
      payload.claudeEvidenceFiles.length > MAX_EVIDENCE_FILES ||
      !payload.claudeEvidenceFiles.every((item) => absolutePathString(item))) {
    errors.push('claudeEvidenceFiles_invalid');
  }
  if (payload.expectedEvidenceSha256 !== undefined) {
    const map = payload.expectedEvidenceSha256;
    if (!map || typeof map !== 'object' || Array.isArray(map) ||
        !Object.entries(map).every(([key, value]) => absolutePathString(key) && SHA256_RE.test(value || ''))) {
      errors.push('expectedEvidenceSha256_invalid');
    }
  }
  if (payload.allowedSyntheticEvidenceRoots !== undefined && (!Array.isArray(payload.allowedSyntheticEvidenceRoots) ||
      payload.allowedSyntheticEvidenceRoots.length > MAX_SYNTH_ROOTS ||
      !payload.allowedSyntheticEvidenceRoots.every((item) => absolutePathString(item)))) {
    errors.push('allowedSyntheticEvidenceRoots_invalid');
  }
  const verifications = payload.currentHeadVerifications;
  if (!verifications || typeof verifications !== 'object' || Array.isArray(verifications) ||
      Object.keys(verifications).some((key) => !VERIFICATION_KEYS.includes(key)) ||
      !VERIFICATION_KEYS.every((key) => validVerification(verifications[key]))) {
    errors.push('currentHeadVerifications_invalid');
  }
  return errors;
}

function stop(code, extra = {}) {
  return { schema: SCHEMA, result: 'STOP', code, evidenceNature: EVIDENCE_NATURE, ...extra };
}

function git(repoRoot, args, timeoutMs = 8000) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
}

// Single canonicalization primitive for every cross-spelling absolute-path
// comparison in this module. On Windows-style paths it folds the three
// equivalent JSONL spellings Claude Code actually emits on Windows/MSYS
// (`C:\foo`, `C:/foo`, `/c/foo`) down to one `c:/foo` form, case-insensitively
// on the drive letter only. It deliberately does NOT touch ordinary POSIX
// paths (e.g. `/tmp/foo`) -- the MSYS pattern only matches a single-letter
// first path segment, so multi-letter POSIX roots are never reinterpreted as
// a Windows drive.
export function toCanonicalPath(value) {
  if (typeof value !== 'string') return '';
  let normalized = value.replace(/\\/g, '/');
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(normalized);
  if (msys) normalized = `${msys[1]}:/${msys[2]}`;
  const drive = /^([a-zA-Z]):(.*)$/.exec(normalized);
  if (drive) normalized = `${drive[1].toLowerCase()}:${drive[2]}`;
  return normalized;
}

function normalizeForCompare(value) {
  if (typeof value !== 'string') return '';
  let normalized = toCanonicalPath(value);
  normalized = path.posix.normalize(normalized);
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

function resolvePathAgainst(base, candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return null;
  const normalizedCandidate = toCanonicalPath(candidate);
  const isAbsolute = /^[a-zA-Z]:\//.test(normalizedCandidate) || normalizedCandidate.startsWith('/');
  if (isAbsolute) {
    const resolved = path.posix.normalize(normalizedCandidate);
    return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
  }
  const baseNorm = typeof base === 'string' && base.length > 0 ? toCanonicalPath(base).replace(/\/$/, '') : '/';
  return path.posix.normalize(`${baseNorm}/${normalizedCandidate}`);
}

function pathInsideRootCI(resolvedRaw, rootRaw) {
  const a = toCanonicalPath(resolvedRaw).toLowerCase();
  const b = toCanonicalPath(rootRaw).toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

function relativeFromRoot(resolvedRaw, rootRaw) {
  const resolved = toCanonicalPath(resolvedRaw);
  const root = toCanonicalPath(rootRaw);
  if (!pathInsideRootCI(resolved, root)) return null;
  if (resolved.toLowerCase() === root.toLowerCase()) return '';
  return resolved.slice(root.length + 1);
}

function extractPathCandidates(input) {
  if (!input || typeof input !== 'object') return [];
  const out = [];
  for (const field of ['file_path', 'path', 'notebook_path', 'directory']) {
    if (typeof input[field] === 'string' && input[field].trim()) out.push(input[field]);
  }
  return out;
}

const SECRET_EXEMPT_RE = /\.env\.(example|sample|template)$/i;
const SECRET_PATTERNS = [
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.[^/]+$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.azure(\/|$)/i,
  /(^|\/)\.gcloud(\/|$)/i,
  /(^|\/)gcloud(\/|$)/i,
  /(^|\/)\.kube(\/|$)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /credentials?(\/|$|\.[a-z0-9]+$)/i,
  /secrets?(\/|$|\.[a-z0-9]+$)/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.[a-z0-9]+)?$/i,
  /\.(pem|pfx|p12|key)$/i,
  /keychain/i,
  /(^|\/)(login data|cookies|web data)$/i,
  /tokens?\.(json|txt|ya?ml)$/i,
];
export function isSecretPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  if (SECRET_EXEMPT_RE.test(normalized)) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
}

const SUSPECT_SYNTH_ROOT_RE = /(patient|clinic|customer|medical|\bphi\b|\bpii\b|production|prod-data|real-data|business-data)/i;

function isLoopbackHost(host) {
  const h = host.split('/')[0].split(':')[0].toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OBFUSCATION_RE = /\$\(|`|\beval\b|\biex\b|base64\s+-d|Invoke-Expression/i;
const NETWORK_TOOL_RE = /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|ncat|netcat|\bnc\b|telnet|ftp)\b/i;

// Absolute-filesystem-path helpers for Bash command classification. These
// are intentionally narrow, regex-based heuristics (consistent with the
// rest of this classifier) rather than a full shell parser.
const DEVICE_PATH_RE = /^\/dev\/(null|stdin|stdout|stderr|zero)$/i;
const EXEC_EXT_RE = /\.(exe|cmd|bat|com|ps1|sh)$/i;
const SYSTEM_EXEC_DIR_RE = /(?:[\\/]program files(?: \(x86\))?[\\/])|(?:[\\/]system32[\\/])|(?:[\\/]programdata[\\/])|(?:\/usr\/(?:local\/)?s?bin\/)|(?:\/s?bin\/)|(?:\/opt\/)/i;
const GH_REPO_FLAG_RE = /^--repo=(.+)$/i;

function isAbsolutePathLike(candidate) {
  return typeof candidate === 'string' && candidate.length > 0 &&
    (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('/'));
}

function splitCommandSegments(command) {
  return command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

function tokenizeSegment(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return tokens;
}

function candidatePathsForToken(token) {
  const out = [token];
  const eqIdx = token.indexOf('=');
  if (eqIdx > 0 && eqIdx < token.length - 1) out.push(token.slice(eqIdx + 1));
  return out;
}

function normalizeRepoRef(ref) {
  return ref
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

// Classifies a single `gh` invocation. gh commands that rely on the current
// repo cwd (no explicit repo reference) are permitted. Any explicit repo
// reference (-R/--repo, or a `gh repo <owner>/<name>` positional argument)
// must exactly match the repository this audit is bound to. `gh api` must
// be scoped to that same repository's REST namespace.
function classifyGhCommand(tokens, repository) {
  const repoFull = repository && repository.owner && repository.name
    ? `${repository.owner}/${repository.name}`.toLowerCase() : null;
  const sub = (tokens[1] || '').toLowerCase();

  let explicitRepo = null;
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if ((t === '-R' || t === '--repo') && tokens[i + 1]) { explicitRepo = tokens[i + 1]; break; }
    const eqMatch = GH_REPO_FLAG_RE.exec(t);
    if (eqMatch) { explicitRepo = eqMatch[1]; break; }
  }
  if (sub === 'repo' && !explicitRepo) {
    const positional = tokens.slice(2).find((t) => !t.startsWith('-') && /^[^\s/]+\/[^\s/]+$/.test(t));
    if (positional) explicitRepo = positional;
  }
  if (explicitRepo) {
    if (!repoFull || normalizeRepoRef(explicitRepo) !== repoFull) {
      return { ok: false, code: 'GITHUB_REPOSITORY_MISMATCH' };
    }
  }

  if (sub === 'api') {
    const endpoint = tokens.slice(2).find((t) => !t.startsWith('-'));
    if (!repoFull || !endpoint) return { ok: false, code: 'GITHUB_REPOSITORY_MISMATCH' };
    let endpointPath = endpoint;
    if (/^https?:\/\//i.test(endpoint)) {
      if (!/^https:\/\/api\.github\.com\//i.test(endpoint)) return { ok: false, code: 'GITHUB_REPOSITORY_MISMATCH' };
      endpointPath = endpoint.replace(/^https:\/\/api\.github\.com\//i, '');
    }
    endpointPath = endpointPath.replace(/^\//, '');
    const scopedRe = new RegExp(`^repos/${escapeRegExp(repository.owner)}/${escapeRegExp(repository.name)}(/|$|\\?)`, 'i');
    if (!scopedRe.test(endpointPath)) return { ok: false, code: 'GITHUB_REPOSITORY_MISMATCH' };
  }

  return { ok: true };
}

// Classifies a single Bash tool_use command against the narrow permitted
// surface: loopback test traffic, git/gh operations against the same
// GitHub origin/repository already bound to this audit, and filesystem
// operands confined to repoRoot or an explicitly allow-listed synthetic
// evidence root. Anything unclear fails closed rather than being assumed
// safe. Absolute paths that are themselves the invoked executable (command
// position, recognized executable extension/system directory) are not
// treated as business-data reads/writes.
export function classifyBashCommand(command, repository, repoRoot, allowedSyntheticEvidenceRoots = []) {
  if (typeof command !== 'string' || command.trim().length === 0) return { ok: false, code: 'BASH_COMMAND_UNREADABLE' };
  if (OBFUSCATION_RE.test(command)) return { ok: false, code: 'BASH_COMMAND_AMBIGUOUS_UNSAFE' };
  const urlMatches = [...command.matchAll(/https?:\/\/([^\s"'/]+)/gi)].map((m) => m[1]);
  if (NETWORK_TOOL_RE.test(command) || urlMatches.length > 0) {
    if (urlMatches.length === 0) return { ok: false, code: 'BASH_COMMAND_AMBIGUOUS_UNSAFE' };
    for (const host of urlMatches) {
      if (isLoopbackHost(host)) continue;
      if (/^([\w.-]+@)?github\.com(:\d+)?$/i.test(host.split('/')[0])) {
        const ownerName = repository && repository.owner && repository.name
          ? new RegExp(`${escapeRegExp(repository.owner)}\\/${escapeRegExp(repository.name)}`, 'i')
          : null;
        if (ownerName && ownerName.test(command)) continue;
        if (!ownerName) continue;
        return { ok: false, code: 'NETWORK_ACCESS_NON_LOOPBACK' };
      }
      return { ok: false, code: 'NETWORK_ACCESS_NON_LOOPBACK' };
    }
  }

  const repoRootRaw = typeof repoRoot === 'string' && repoRoot.trim().length > 0 ? repoRoot : null;
  const repoRootNorm = repoRootRaw ? toCanonicalPath(repoRootRaw).replace(/\/$/, '') : null;
  const allowedRootsNorm = (Array.isArray(allowedSyntheticEvidenceRoots) ? allowedSyntheticEvidenceRoots : [])
    .filter((r) => typeof r === 'string' && r.trim().length > 0)
    .map((r) => toCanonicalPath(r).replace(/\/$/, ''));

  const segments = splitCommandSegments(command);
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    if (tokens.length > 0 && /^gh(\.exe)?$/i.test(tokens[0])) {
      const ghResult = classifyGhCommand(tokens, repository);
      if (!ghResult.ok) return ghResult;
    }
    for (let i = 0; i < tokens.length; i += 1) {
      const rawToken = tokens[i];
      if (rawToken.length > 2 && isSecretPath(rawToken)) return { ok: false, code: 'SECRET_PATH_ACCESS_REJECTED' };
      for (const candidate of candidatePathsForToken(rawToken)) {
        if (!isAbsolutePathLike(candidate)) continue;
        const resolved = resolvePathAgainst('/', toCanonicalPath(candidate));
        if (resolved === null) return { ok: false, code: 'BASH_COMMAND_AMBIGUOUS_UNSAFE' };
        if (isSecretPath(resolved)) return { ok: false, code: 'SECRET_PATH_ACCESS_REJECTED' };
        if (DEVICE_PATH_RE.test(resolved)) continue;
        const isExecutablePosition = i === 0 && candidate === rawToken;
        const looksLikeExecutable = EXEC_EXT_RE.test(resolved) || SYSTEM_EXEC_DIR_RE.test(resolved);
        if (isExecutablePosition && looksLikeExecutable) continue;
        const insideRepo = repoRootNorm ? pathInsideRootCI(resolved, repoRootNorm) : false;
        const insideAllowed = allowedRootsNorm.some((root) => pathInsideRootCI(resolved, root));
        if (!insideRepo && !insideAllowed) return { ok: false, code: 'PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED' };
      }
    }
  }

  return { ok: true };
}

function safeExtractHost(url) {
  const match = /^https?:\/\/([^\s"'/]+)/i.exec(url || '');
  return match ? match[1] : null;
}

function extractToolResultText(item) {
  const content = item?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

// Reads and hashes every declared evidence file, bounded per-file and total.
// Never discovers arbitrary user history: only the explicit files supplied.
function loadEvidenceFiles(claudeEvidenceFiles, statSyncImpl, readFileSyncImpl) {
  let totalBytes = 0;
  const hashesByResolvedPath = {};
  const buffersByResolvedPath = {};
  for (const filePath of claudeEvidenceFiles) {
    const resolved = path.resolve(filePath);
    let st;
    try { st = statSyncImpl(resolved); } catch { return { error: 'EVIDENCE_FILE_UNREADABLE', file: filePath }; }
    if (!st.isFile()) return { error: 'EVIDENCE_FILE_NOT_REGULAR', file: filePath };
    if (st.size > MAX_EVIDENCE_FILE_BYTES) return { error: 'EVIDENCE_FILE_TOO_LARGE', file: filePath };
    totalBytes += st.size;
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) return { error: 'EVIDENCE_TOTAL_TOO_LARGE', file: filePath };
    let buffer;
    try { buffer = readFileSyncImpl(resolved); } catch { return { error: 'EVIDENCE_FILE_UNREADABLE', file: filePath }; }
    hashesByResolvedPath[resolved] = createHash('sha256').update(buffer).digest('hex');
    buffersByResolvedPath[resolved] = buffer;
  }
  return { hashesByResolvedPath, buffersByResolvedPath };
}

// Single entry point. Takes the closed input above; returns exactly one of
// PROCEED (this exact legacy work is corroborated) or STOP (a specific code).
// This function never returns a normal executionEvidence object and never
// marks implementation-route-receipt as verified.
export function runLegacyImplementationAudit(payload, {
  statSyncImpl = fs.statSync, readFileSyncImpl = fs.readFileSync,
} = {}) {
  const taskId = safeToken(payload?.taskId) ? payload.taskId : null;
  const errors = validateLegacyAuditInput(payload);
  if (errors.length > 0) return stop('SCHEMA_INVALID', { taskId, errors });

  if (PROTECTED_BRANCHES.has(payload.branch.toLowerCase())) {
    return stop('PROTECTED_BRANCH_REJECTED', { taskId, branch: payload.branch });
  }

  const repoCheck = verifyFeatureRepository(payload.repoRoot, payload.branch);
  if (!repoCheck.ok) return stop(repoCheck.code, { taskId });

  const cleanCheck = verifyWorktreeClean(repoCheck.resolvedRoot);
  if (!cleanCheck.ok) return stop(cleanCheck.code, { taskId });

  const identityCheck = verifyRepositoryIdentity(repoCheck.resolvedRoot, payload.repository.owner, payload.repository.name);
  if (!identityCheck.ok) return stop(identityCheck.code, { taskId });

  const actualHead = readHeadSha(repoCheck.resolvedRoot);
  if (!actualHead) return stop('CURRENT_HEAD_UNKNOWN', { taskId });
  const expectedHead = payload.expectedHead.toLowerCase();
  if (actualHead !== expectedHead) return stop('EXPECTED_HEAD_MISMATCH', { taskId });

  const baseHead = payload.baseHead.toLowerCase();
  const baseExists = git(repoCheck.resolvedRoot, ['cat-file', '-e', `${baseHead}^{commit}`]);
  if (baseExists.error || baseExists.status !== 0) return stop('BASE_HEAD_UNKNOWN', { taskId });
  const ancestorCheck = git(repoCheck.resolvedRoot, ['merge-base', '--is-ancestor', baseHead, expectedHead]);
  if (ancestorCheck.error || ancestorCheck.status !== 0) return stop('BASE_HEAD_NOT_ANCESTOR', { taskId });

  const diffResult = git(repoCheck.resolvedRoot, ['diff', '--name-only', '--no-renames', baseHead, expectedHead], 20000);
  if (diffResult.error || diffResult.status !== 0) return stop('CHANGED_PATHS_UNKNOWN', { taskId });
  const changedPaths = String(diffResult.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).sort();
  if (changedPaths.length === 0) return stop('CHANGED_PATHS_EMPTY', { taskId });

  if (Array.isArray(payload.expectedChangedPaths)) {
    const expectedSorted = [...payload.expectedChangedPaths].sort();
    if (JSON.stringify(expectedSorted) !== JSON.stringify(changedPaths)) {
      return stop('CHANGED_PATHS_MISMATCH', { taskId, changedPaths });
    }
  }

  const forbiddenHit = changedPathsInForbiddenScope(changedPaths, payload.forbiddenScope ?? []);
  if (forbiddenHit.length > 0) return stop('FORBIDDEN_SCOPE_VIOLATION', { taskId, forbiddenChangedPaths: forbiddenHit });
  if (!changedPathsWithinScope(changedPaths, payload.allowedScope)) {
    return stop('ALLOWED_SCOPE_VIOLATION', { taskId, changedPaths });
  }

  const revListResult = git(repoCheck.resolvedRoot, ['rev-list', '--reverse', `${baseHead}..${expectedHead}`], 20000);
  if (revListResult.error || revListResult.status !== 0) return stop('COMMITS_UNKNOWN', { taskId });
  const commits = String(revListResult.stdout || '').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (commits.length === 0) return stop('COMMITS_EMPTY', { taskId });

  const cutoffMs = Date.parse(LEGACY_ELIGIBILITY_CUTOFF_UTC);
  const windowStartMs = Date.parse(payload.implementationWindow.startUtc);
  const windowEndMs = Date.parse(payload.implementationWindow.endUtc);
  if (windowEndMs > cutoffMs) return stop('IMPLEMENTATION_WINDOW_AFTER_CUTOFF', { taskId });

  for (const sha of commits) {
    const showResult = git(repoCheck.resolvedRoot, ['show', '-s', '--format=%cI', sha]);
    if (showResult.error || showResult.status !== 0) return stop('COMMIT_TIMESTAMP_UNKNOWN', { taskId, commit: sha });
    const iso = String(showResult.stdout || '').trim();
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return stop('COMMIT_TIMESTAMP_UNKNOWN', { taskId, commit: sha });
    if (ms > cutoffMs) return stop('COMMIT_AFTER_CUTOFF', { taskId, commit: sha });
    if (ms < windowStartMs || ms > windowEndMs) return stop('COMMIT_OUTSIDE_IMPLEMENTATION_WINDOW', { taskId, commit: sha });
  }

  for (const key of VERIFICATION_KEYS) {
    const verification = payload.currentHeadVerifications[key];
    if (!verification || verification.status !== 'PASS' || verification.head.toLowerCase() !== expectedHead) {
      return stop('CURRENT_HEAD_VERIFICATION_INVALID', { taskId, verification: key });
    }
  }

  const loaded = loadEvidenceFiles(payload.claudeEvidenceFiles, statSyncImpl, readFileSyncImpl);
  if (loaded.error) return stop(loaded.error, { taskId, file: loaded.file });
  const { hashesByResolvedPath, buffersByResolvedPath } = loaded;

  if (payload.expectedEvidenceSha256) {
    const providedResolved = new Set(payload.claudeEvidenceFiles.map((f) => path.resolve(f)));
    const mapResolved = Object.keys(payload.expectedEvidenceSha256).map((f) => path.resolve(f));
    if (mapResolved.length !== providedResolved.size || !mapResolved.every((p) => providedResolved.has(p))) {
      return stop('EVIDENCE_TAMPERED', { taskId });
    }
    for (const [rawPath, expectedHash] of Object.entries(payload.expectedEvidenceSha256)) {
      const resolved = path.resolve(rawPath);
      const actualHash = hashesByResolvedPath[resolved];
      if (!actualHash || actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        return stop('EVIDENCE_TAMPERED', { taskId, file: rawPath });
      }
    }
  }

  // A synthetic evidence root is a caller assertion, not a verified fact. It
  // is rejected on its own name alone when it looks like it could be real
  // business/patient data rather than a synthetic fixture, since no such
  // path may ever be allow-listed as "synthetic" here.
  for (const root of payload.allowedSyntheticEvidenceRoots ?? []) {
    if (SUSPECT_SYNTH_ROOT_RE.test(root)) return stop('SYNTHETIC_EVIDENCE_ROOT_SUSPECT', { taskId, root });
  }

  const repoRootRaw = toCanonicalPath(repoCheck.resolvedRoot).replace(/\/$/, '');
  const allowedSynthRootsRaw = (payload.allowedSyntheticEvidenceRoots ?? [])
    .map((r) => toCanonicalPath(path.resolve(r)).replace(/\/$/, ''));

  const allRecords = [];
  for (const filePath of payload.claudeEvidenceFiles) {
    const resolved = path.resolve(filePath);
    const text = buffersByResolvedPath[resolved].toString('utf8');
    const lines = text.split(/\r?\n/);
    const fileRecords = [];
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { return stop('EVIDENCE_JSON_MALFORMED', { taskId, file: filePath }); }
      fileRecords.push(parsed);
    }
    const sessionIds = new Set(
      fileRecords.filter((r) => typeof r?.sessionId === 'string' && r.sessionId).map((r) => r.sessionId),
    );
    if (sessionIds.size > 1) return stop('EVIDENCE_SESSION_CONTRADICTION', { taskId, file: filePath });
    for (const record of fileRecords) {
      if (typeof record?.cwd === 'string' && record.cwd) {
        // A real Claude Code session's cwd legitimately moves around inside
        // the same repository (repoRoot itself, a nested docs/reference
        // subdirectory, src-tauri, etc.) across different JSONL records in
        // the same session -- that is still the same repository, not a
        // different one. Accept repoRoot itself or any path strictly inside
        // it (after '..'-normalization via the same canonical
        // path/root-boundary helper used for every other path-containment
        // check in this module); still fail closed for sibling directories
        // that merely share a string prefix (e.g. repoRoot2), different
        // drives, and any other path that does not resolve inside repoRoot.
        const resolvedCwd = resolvePathAgainst('/', record.cwd);
        if (resolvedCwd === null || !pathInsideRootCI(resolvedCwd, repoRootRaw)) {
          return stop('EVIDENCE_CWD_MISMATCH', { taskId, file: filePath });
        }
      }
      if (typeof record?.gitBranch === 'string' && record.gitBranch) {
        if (record.gitBranch !== repoCheck.branch) return stop('EVIDENCE_BRANCH_MISMATCH', { taskId, file: filePath });
      }
    }
    for (const [index, record] of fileRecords.entries()) allRecords.push({ file: filePath, index, record });
  }

  const changedPathSet = new Set(changedPaths);
  let sawAssistantToolUse = false;
  let editTouchedChangedPath = false;
  const bashCommitToolUses = [];
  const toolResultsByKey = new Map();

  for (const { file, index, record } of allRecords) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    const isAssistant = record.type === 'assistant' && record?.message?.role === 'assistant';
    const isUser = record.type === 'user' && record?.message?.role === 'user';
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'tool_use' && isAssistant) {
        sawAssistantToolUse = true;
        const name = item.name;
        const claudeVersion = typeof record.version === 'string' ? record.version.trim() : '';
        const proofValid = claudeVersion.length > 0 && CLI_ENTRYPOINTS.has(record.entrypoint);
        if (['Edit', 'Write', 'MultiEdit'].includes(name)) {
          if (!proofValid) return stop('EVIDENCE_CLAUDE_PROOF_INVALID', { taskId, file, index });
          for (const candidatePath of extractPathCandidates(item.input)) {
            const resolved = resolvePathAgainst(record.cwd || repoRootRaw, candidatePath);
            if (resolved === null) return stop('EVIDENCE_PATH_UNRESOLVABLE', { taskId, file, index });
            if (isSecretPath(resolved)) return stop('SECRET_PATH_ACCESS_REJECTED', { taskId, file, index });
            const insideRepo = pathInsideRootCI(resolved, repoRootRaw);
            const insideSynth = allowedSynthRootsRaw.some((root) => pathInsideRootCI(resolved, root));
            if (!insideRepo && !insideSynth) return stop('PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED', { taskId, file, index });
            if (insideRepo) {
              const relative = relativeFromRoot(resolved, repoRootRaw);
              if (relative && changedPathSet.has(relative)) editTouchedChangedPath = true;
            }
          }
        } else if (name === 'Bash') {
          if (!proofValid) return stop('EVIDENCE_CLAUDE_PROOF_INVALID', { taskId, file, index });
          const command = typeof item.input?.command === 'string' ? item.input.command : '';
          const classification = classifyBashCommand(command, payload.repository, repoRootRaw, allowedSynthRootsRaw);
          if (!classification.ok) return stop(classification.code, { taskId, file, index });
          if (/\bgit\s+(?:\S+\s+)*commit\b/i.test(command)) {
            bashCommitToolUses.push({
              file, toolUseId: item.id, sessionId: record.sessionId, cwd: record.cwd, gitBranch: record.gitBranch,
            });
          }
        } else {
          for (const candidatePath of extractPathCandidates(item.input)) {
            const resolved = resolvePathAgainst(record.cwd || repoRootRaw, candidatePath);
            if (resolved === null) continue;
            if (isSecretPath(resolved)) return stop('SECRET_PATH_ACCESS_REJECTED', { taskId, file, index });
            const insideRepo = pathInsideRootCI(resolved, repoRootRaw);
            const insideSynth = allowedSynthRootsRaw.some((root) => pathInsideRootCI(resolved, root));
            if (!insideRepo && !insideSynth) return stop('PATH_OUTSIDE_REPO_ROOT_UNAUTHORIZED', { taskId, file, index });
          }
          if (typeof item.input?.url === 'string') {
            const host = safeExtractHost(item.input.url);
            const isGithub = host && /^([\w.-]+@)?github\.com(:\d+)?$/i.test(host);
            if (!host || (!isLoopbackHost(host) && !isGithub)) {
              return stop('NETWORK_ACCESS_NON_LOOPBACK', { taskId, file, index });
            }
          }
        }
      } else if (item.type === 'tool_result' && isUser) {
        const key = `${file}|${item.tool_use_id}`;
        toolResultsByKey.set(key, {
          text: extractToolResultText(item), sessionId: record.sessionId, cwd: record.cwd, gitBranch: record.gitBranch,
        });
      }
    }
  }

  if (!sawAssistantToolUse) return stop('NO_CLAUDE_ASSISTANT_EVIDENCE', { taskId });
  if (!editTouchedChangedPath) return stop('NO_CLAUDE_EDIT_ON_CHANGED_PATH', { taskId });

  // Abbreviated commit IDs (>=7 and <40 hex chars) bind only when the audited
  // full SHA starts with the token AND Git in the audited repository itself
  // resolves `<token>^{commit}` to exactly that full SHA. A prefix string is
  // never trusted alone; ambiguous/unresolvable/non-commit tokens do not bind.
  const abbrevCache = new Map();
  function abbreviationResolvesTo(token, fullSha) {
    const cacheKey = `${token}|${fullSha}`;
    if (abbrevCache.has(cacheKey)) return abbrevCache.get(cacheKey);
    let ok = false;
    if (token.length >= 7 && token.length < 40 && fullSha.startsWith(token)) {
      const resolved = git(repoCheck.resolvedRoot, ['rev-parse', '--verify', '--quiet', `${token}^{commit}`]);
      ok = !resolved.error && resolved.status === 0 && String(resolved.stdout || '').trim().toLowerCase() === fullSha;
    }
    abbrevCache.set(cacheKey, ok);
    return ok;
  }
  function textBindsCommit(text, fullSha) {
    const lower = text.toLowerCase();
    if (lower.includes(fullSha)) return true;
    const tokens = lower.match(/(?<![0-9a-f])[0-9a-f]{7,39}(?![0-9a-f])/g) || [];
    return tokens.some((token) => abbreviationResolvesTo(token, fullSha));
  }

  for (const sha of commits) {
    let bound = false;
    for (const use of bashCommitToolUses) {
      const result = toolResultsByKey.get(`${use.file}|${use.toolUseId}`);
      if (!result) continue;
      if (use.sessionId && result.sessionId && use.sessionId !== result.sessionId) continue;
      if (use.cwd && result.cwd && normalizeForCompare(use.cwd) !== normalizeForCompare(result.cwd)) continue;
      if (use.gitBranch && result.gitBranch && use.gitBranch !== result.gitBranch) continue;
      if (typeof result.text === 'string' && textBindsCommit(result.text, sha)) { bound = true; break; }
    }
    if (!bound) return stop('COMMIT_NOT_BOUND_TO_CLAUDE', { taskId, commit: sha });
  }

  return {
    schema: SCHEMA,
    result: 'PROCEED',
    code: 'LEGACY_IMPLEMENTATION_AUDIT_PASSED',
    evidenceNature: EVIDENCE_NATURE,
    taskId,
    repository: { owner: payload.repository.owner, name: payload.repository.name },
    branch: repoCheck.branch,
    baseHead,
    expectedHead,
    changedPaths,
    commits,
    legacyReason: payload.legacyReason,
    implementationAI: payload.implementationAI,
    implementationWindow: { startUtc: payload.implementationWindow.startUtc, endUtc: payload.implementationWindow.endUtc },
    legacyEligibilityCutoffUtc: LEGACY_ELIGIBILITY_CUTOFF_UTC,
    evidence: {
      files: payload.claudeEvidenceFiles.map((f) => {
        const resolved = path.resolve(f);
        return { path: resolved, sha256: hashesByResolvedPath[resolved] };
      }),
    },
    currentHeadVerifications: Object.fromEntries(VERIFICATION_KEYS.map((key) => [
      key,
      { status: payload.currentHeadVerifications[key].status, head: payload.currentHeadVerifications[key].head.toLowerCase() },
    ])),
    notice: 'RESCUE_ONLY_FOR_PRE_EXISTENCE_WORK_NEW_WORK_AFTER_CUTOFF_MUST_USE_IMPLEMENTATION_ORCHESTRATOR',
  };
}

function parseArgs(argv) {
  let inputPath = null;
  let pretty = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input' && argv[i + 1]) { inputPath = argv[++i]; }
    else if (argv[i] === '--pretty') pretty = true;
    else return { valid: false };
  }
  if (!nonEmptyString(inputPath)) return { valid: false };
  return { valid: true, inputPath, pretty };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) { process.stdout.write(`${JSON.stringify(stop('ARGUMENT_INVALID'))}\n`); process.exitCode = 2; return; }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.resolve(args.inputPath), 'utf8'));
  } catch {
    process.stdout.write(`${JSON.stringify(stop('INPUT_READ_OR_PARSE_FAILED'))}\n`);
    process.exitCode = 2;
    return;
  }
  const result = runLegacyImplementationAudit(payload);
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  process.exitCode = result.result === 'PROCEED' ? 0 : 1;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
