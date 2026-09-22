#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveProviderCommand } from './ai-provider-inventory.mjs';
import {
  isolateTrustedClaudeBinary,
  runnerSupport,
  subscriptionAuth,
  sanitizedChildEnv,
  unsafeProviderEnvPresent,
  run,
} from './claude-subscription-runner.mjs';

const SCHEMA_VERSION = 1;
const ROUTE_ID = 'claude-implementation-write';
export const ALLOWED_CAPABILITIES = new Set(['implementation', 'bugfix', 'refactor', 'testing']);
export const ALLOWED_DATA_CLASSES = new Set(['source-only', 'synthetic', 'public']);
const SHA_RE = /^[0-9a-f]{40}$/i;
const ALLOWED_KEYS = new Set(['schemaVersion', 'taskId', 'capability', 'dataClass', 'prompt', 'repoRoot', 'branch', 'allowedScope', 'forbiddenScope', 'repository']);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;
const SAFE_SUBSCRIPTIONS = new Set(['pro']);
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk']);

// GitHub HTTPS/SSH origin forms only. Anything else (a different host, a
// local filesystem remote, a proxy rewrite) is not recognized rather than
// loosely parsed, so repository identity verification fails closed instead
// of guessing at an unfamiliar remote shape.
const GITHUB_HTTPS_ORIGIN_RE = /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH_SCP_ORIGIN_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i;
const GITHUB_SSH_URL_ORIGIN_RE = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

// This runner intentionally allows only source-editing tools (no Bash, no git,
// no network). Commit/push/test-execution authority cannot yet be scoped
// robustly at the CLI permission boundary, so this phase narrows to source
// edit only rather than weakening the write boundary. See SKILL.md.
const IMPLEMENTATION_TOOLS = 'Read,Write,Edit,Glob,Grep';

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function branchToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value);
}
function stop(code, taskId = null) {
  return { schemaVersion: SCHEMA_VERSION, result: 'STOP', code, routeId: ROUTE_ID, taskId };
}

// A scope pattern is either an exact repo-relative path, or that same shape
// with a literal trailing '/**' meaning "this directory and everything
// under it". No other wildcard forms are accepted: this keeps matching a
// closed, auditable predicate instead of an arbitrary glob engine.
export function validScopePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) return false;
  if (pattern.includes('\\') || pattern.includes('\0')) return false;
  if (pattern.startsWith('/') || pattern.endsWith('/')) return false;
  if (pattern.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) return true;
  return pattern.endsWith('/**') && starIndex === pattern.length - 2 && pattern.slice(0, -3).indexOf('*') === -1;
}

function pathMatchesScopePattern(changedPath, pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return changedPath === prefix || changedPath.startsWith(`${prefix}/`);
  }
  return changedPath === pattern;
}

// Every changed path must be covered by at least one allowedScope pattern.
// Called only after Claude has already returned and before COMPLETED is
// reported, so an out-of-scope edit is caught before it is ever treated as
// a successful implementation.
export function changedPathsWithinScope(changedPaths, allowedScope) {
  return changedPaths.every((changedPath) => allowedScope.some((pattern) => pathMatchesScopePattern(changedPath, pattern)));
}

export function changedPathsInForbiddenScope(changedPaths, forbiddenScope = []) {
  return changedPaths.filter((changedPath) => forbiddenScope.some((pattern) => pathMatchesScopePattern(changedPath, pattern)));
}

function validRepository(repository) {
  return repository && typeof repository === 'object' && !Array.isArray(repository) &&
    Object.keys(repository).every((key) => key === 'owner' || key === 'name') &&
    safeToken(repository.owner) && safeToken(repository.name);
}

export function validateImplementationTask(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['payload_not_object'];
  const errors = [];
  if (payload.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion_invalid');
  if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) errors.push('unknown_field');
  if (!safeToken(payload.taskId)) errors.push('taskId_invalid');
  if (!ALLOWED_CAPABILITIES.has(payload.capability)) errors.push('capability_invalid');
  if (!ALLOWED_DATA_CLASSES.has(payload.dataClass)) errors.push('dataClass_invalid');
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) errors.push('prompt_invalid');
  else if (Buffer.byteLength(payload.prompt, 'utf8') > MAX_INPUT_BYTES) errors.push('prompt_too_large');
  if (typeof payload.repoRoot !== 'string' || !payload.repoRoot.trim()) errors.push('repoRoot_invalid');
  if (!branchToken(payload.branch)) errors.push('branch_invalid');
  if (!Array.isArray(payload.allowedScope) || payload.allowedScope.length === 0 ||
      !payload.allowedScope.every((item) => validScopePattern(item))) {
    errors.push('allowedScope_invalid');
  }
  if (payload.forbiddenScope !== undefined && (!Array.isArray(payload.forbiddenScope) ||
      !payload.forbiddenScope.every((item) => validScopePattern(item)))) {
    errors.push('forbiddenScope_invalid');
  }
  if (!validRepository(payload.repository)) errors.push('repository_invalid');
  return errors;
}

function runGit(repoRoot, args, timeoutMs = 5000) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024,
  });
}

// Verifies the supplied repository is an actual local Git working tree, that
// its current branch exactly matches the expected feature branch (not
// detached, not a protected branch), and that it is not mid-merge/rebase/
// cherry-pick. Any ambiguity fails closed rather than guessing repo identity.
export function verifyFeatureRepository(repoRoot, branch, { statSync = fs.statSync, existsSync = fs.existsSync } = {}) {
  if (typeof branch !== 'string' || PROTECTED_BRANCHES.has(branch.toLowerCase())) {
    return { ok: false, code: 'PROTECTED_BRANCH_REJECTED' };
  }
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(repoRoot);
    if (!statSync(resolvedRoot).isDirectory()) return { ok: false, code: 'REPO_ROOT_NOT_DIRECTORY' };
  } catch {
    return { ok: false, code: 'REPO_ROOT_NOT_FOUND' };
  }

  const insideTree = runGit(resolvedRoot, ['rev-parse', '--is-inside-work-tree']);
  if (insideTree.error || insideTree.status !== 0 || String(insideTree.stdout || '').trim() !== 'true') {
    return { ok: false, code: 'REPO_NOT_GIT_WORK_TREE' };
  }

  const topLevel = runGit(resolvedRoot, ['rev-parse', '--show-toplevel']);
  if (topLevel.error || topLevel.status !== 0) return { ok: false, code: 'REPO_TOPLEVEL_UNKNOWN' };
  let resolvedTopLevel;
  try { resolvedTopLevel = fs.realpathSync(String(topLevel.stdout || '').trim()); } catch { return { ok: false, code: 'REPO_TOPLEVEL_UNKNOWN' }; }
  if (resolvedTopLevel !== resolvedRoot) return { ok: false, code: 'REPO_ROOT_MISMATCH' };

  const gitDir = runGit(resolvedRoot, ['rev-parse', '--git-dir']);
  if (gitDir.error || gitDir.status !== 0) return { ok: false, code: 'REPO_GIT_DIR_UNKNOWN' };
  const gitDirPath = path.isAbsolute(String(gitDir.stdout || '').trim())
    ? String(gitDir.stdout || '').trim()
    : path.join(resolvedRoot, String(gitDir.stdout || '').trim());
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    if (existsSync(path.join(gitDirPath, marker))) return { ok: false, code: 'REPO_STATE_UNSAFE_IN_PROGRESS_OPERATION' };
  }

  const branchRun = runGit(resolvedRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRun.error || branchRun.status !== 0) return { ok: false, code: 'REPO_BRANCH_UNKNOWN' };
  const currentBranch = String(branchRun.stdout || '').trim();
  if (currentBranch === 'HEAD') return { ok: false, code: 'REPO_DETACHED_HEAD_REJECTED' };
  if (currentBranch !== branch) return { ok: false, code: 'BRANCH_MISMATCH' };

  return { ok: true, resolvedRoot, branch: currentBranch };
}

// Reads the exact current commit the implementation task started from, so a
// later final receipt can bind "what Claude actually edited" to "what got
// committed" instead of trusting a self-reported HEAD value.
export function readHeadSha(repoRoot) {
  const result = runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (result.error || result.status !== 0) return null;
  const sha = String(result.stdout || '').trim();
  return SHA_RE.test(sha) ? sha.toLowerCase() : null;
}

// The worktree must be completely clean (no tracked modifications, no
// untracked files) before Claude is ever invoked. This is what makes every
// path that shows up dirty afterward attributable to this exact execution:
// without it, a pre-existing untracked file would be silently folded into
// the change-set evidence as if Claude had produced it.
export function verifyWorktreeClean(repoRoot) {
  const result = runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z']);
  if (result.error || result.status !== 0) return { ok: false, code: 'WORKTREE_STATUS_UNKNOWN' };
  const dirty = String(result.stdout || '').split('\0').some((entry) => entry.length > 0);
  if (dirty) return { ok: false, code: 'WORKTREE_NOT_CLEAN' };
  return { ok: true };
}

// Verifies the actual 'origin' remote resolves to the exact caller-claimed
// GitHub owner/name, instead of trusting the caller's repository fields on
// their own say-so. Only normal GitHub HTTPS and SSH origin forms are
// recognized; anything else fails closed rather than being loosely parsed.
export function verifyRepositoryIdentity(repoRoot, owner, name) {
  if (!safeToken(owner) || !safeToken(name)) return { ok: false, code: 'REPOSITORY_IDENTITY_INVALID' };
  const result = runGit(repoRoot, ['remote', 'get-url', 'origin']);
  if (result.error || result.status !== 0) return { ok: false, code: 'ORIGIN_REMOTE_UNKNOWN' };
  const url = String(result.stdout || '').trim();
  const match = GITHUB_HTTPS_ORIGIN_RE.exec(url) || GITHUB_SSH_SCP_ORIGIN_RE.exec(url) || GITHUB_SSH_URL_ORIGIN_RE.exec(url);
  if (!match) return { ok: false, code: 'ORIGIN_REMOTE_NOT_GITHUB_SHAPED' };
  const [, originOwner, originName] = match;
  if (originOwner.toLowerCase() !== owner.toLowerCase() || originName.toLowerCase() !== name.toLowerCase()) {
    return { ok: false, code: 'REPOSITORY_IDENTITY_MISMATCH' };
  }
  return { ok: true };
}

function parseStatusZ(stdout) {
  return String(stdout || '').split('\0').filter((entry) => entry.length > 0).map((entry) => ({
    code: entry.slice(0, 2),
    path: entry.slice(3),
  }));
}

// --name-status -z emits strictly alternating NUL-terminated tokens
// (status, path, status, path, ...) with no embedded dual-path ambiguity,
// unlike --raw's rename/copy record shape. --no-renames guarantees every
// status is a single latter (A/M/D/T), never a rename/copy score suffix.
function parseNameStatusZ(stdout) {
  const tokens = String(stdout || '').split('\0').filter((token) => token.length > 0);
  const entries = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i];
    const filePath = tokens[i + 1];
    if (filePath === undefined) break;
    entries.push({ status: status[0], path: filePath });
  }
  return entries;
}

function normalizeChangeRecords(rawRecords) {
  const records = [];
  for (const raw of rawRecords) {
    if (typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.includes('\0')) return null;
    if (raw.deleted) { records.push({ path: raw.path, deleted: true, blobOid: null }); continue; }
    if (!SHA_RE.test(raw.blobOid || '')) return null;
    records.push({ path: raw.path, deleted: false, blobOid: raw.blobOid.toLowerCase() });
  }
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return records;
}

function hashChangeRecords(records) {
  const canonical = records.map((r) => `${r.path} ${r.deleted ? 'D' : r.blobOid}`).join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toUpperCase();
}

// Enumerates the exact working-tree change set relative to HEAD (which must
// still equal preHead, since the worktree was verified clean before Claude
// ran and nothing else may commit in between). Tracked modifications and
// deletions plus untracked new files are all covered -- this is the fix for
// the gap where 'git diff' alone is blind to untracked files. Each non-
// deleted path is hashed with the exact blob OID 'git add' would store
// (attribute/filter-aware), never raw file contents.
function workingTreeChangeRecords(repoRoot, preHead) {
  if (readHeadSha(repoRoot) !== preHead) return null;
  const statusResult = runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z']);
  if (statusResult.error || statusResult.status !== 0) return null;
  const raw = [];
  for (const { code, path: changedPath } of parseStatusZ(statusResult.stdout)) {
    if (!/^[ MAD?]{2}$/.test(code)) return null; // unmerged/unexpected status fails closed
    if (code[1] === 'D') { raw.push({ path: changedPath, deleted: true }); continue; }
    const hashResult = runGit(repoRoot, ['hash-object', changedPath]);
    if (hashResult.error || hashResult.status !== 0) return null;
    raw.push({ path: changedPath, deleted: false, blobOid: String(hashResult.stdout || '').trim() });
  }
  return normalizeChangeRecords(raw);
}

// Enumerates the exact change set actually committed between preHead and
// toRef. Paths/statuses come from 'git diff --name-status'; each non-deleted
// path's blob OID is resolved directly from the committed tree via
// 'git rev-parse toRef:path', so verification never re-derives evidence from
// working-tree state and never depends on --raw's rename/copy record shape.
function committedChangeRecords(repoRoot, preHead, toRef) {
  const diffResult = runGit(repoRoot, ['diff', '--name-status', '--no-renames', '-z', preHead, toRef], 15000);
  if (diffResult.error || diffResult.status !== 0) return null;
  const raw = [];
  for (const { status, path: changedPath } of parseNameStatusZ(diffResult.stdout)) {
    if (status === 'D') { raw.push({ path: changedPath, deleted: true }); continue; }
    if (!['A', 'M', 'T'].includes(status)) return null; // copy/rename/unmerged/unknown statuses fail closed
    const blobResult = runGit(repoRoot, ['rev-parse', '--verify', `${toRef}:${changedPath}`]);
    if (blobResult.error || blobResult.status !== 0) return null;
    raw.push({ path: changedPath, deleted: false, blobOid: String(blobResult.stdout || '').trim() });
  }
  return normalizeChangeRecords(raw);
}

// Deterministic change-set evidence: the sorted set of {path, deletion-marker
// or committed-equivalent blob OID}, hashed to SHA-256. Called twice across
// the lifecycle: once right after Claude edits source (preHead only,
// capturing the uncommitted working-tree change set) and once again at
// final-receipt verification time (preHead + implementationHead, over the
// actually committed change set). Equal hashes prove the committed change is
// exactly the same set of paths/content the runner produced -- including
// new/untracked files, which a textual diff hash alone would miss.
export function computeChangeSetSha256(repoRoot, preHead, toRef = null) {
  if (!SHA_RE.test(preHead || '')) return null;
  if (toRef !== null && toRef !== undefined && !SHA_RE.test(toRef)) return null;
  const records = toRef ? committedChangeRecords(repoRoot, preHead, toRef) : workingTreeChangeRecords(repoRoot, preHead);
  if (!records) return null;
  return { changeSetSha256: hashChangeRecords(records), changedPaths: records.map((r) => r.path) };
}

function buildGuardedImplementationPrompt(payload) {
  const forbidden = Array.isArray(payload.forbiddenScope) && payload.forbiddenScope.length > 0
    ? payload.forbiddenScope.join(', ')
    : '(none)';
  return [
    'The following paths are protected and must not be modified: ' + forbidden,
    'If this is approved-reference reproduction: provisional/development UI, old UI/screenshots, and AI memory are not visual authority. Use only the approved reference and prepared verified dimensions/style values. Existing implementation may be referenced only for logic, data flow, and state behavior. If its visual structure conflicts, rebuild that structure while preserving logic/data behavior. Do not redesign, improve, add, remove, reorder, or relax the prepared criteria.',
    payload.prompt,
  ].join('\n\n');
}

function implementationClaudeArgs(emptyMcpConfig) {
  return [
    '--print', '--input-format', 'text', '--output-format', 'json',
    '--setting-sources', '', '--settings', '{}',
    '--tools', IMPLEMENTATION_TOOLS,
    '--strict-mcp-config', '--mcp-config', emptyMcpConfig,
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--model', 'sonnet',
    '--system-prompt', 'Edit only source files inside the current working directory on the current git branch. Do not run shell commands, do not access the network, do not touch git state (commit, push, checkout, reset, merge), and do not read or write any path outside the working directory. Return a short summary of the files changed.',
  ];
}

export function implementationRunnerEvidence({ auth, credentialEnvAbsent, runnerSupported = false, repoVerified = false } = {}) {
  const authOk = auth?.loggedIn === true && SAFE_SUBSCRIPTIONS.has(auth?.subscriptionType) && auth?.authMethod === 'claude.ai';
  const closed = authOk && credentialEnvAbsent === true && runnerSupported === true && repoVerified === true;
  return {
    authentication: authOk ? 'VERIFIED' : 'UNKNOWN',
    repositoryBoundary: closed ? 'FEATURE_BRANCH_ONLY_VERIFIED' : 'UNKNOWN',
    toolBoundary: closed ? 'SOURCE_EDIT_ONLY_ENFORCED' : 'UNKNOWN',
    dataBoundary: closed ? 'EXPLICIT_SAFE_PAYLOAD_ONLY' : 'UNKNOWN',
    incrementalCostBoundary: closed ? 'INCLUDED_ONLY_ENFORCED' : 'UNKNOWN',
    fallbackBehavior: closed ? 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION' : 'UNKNOWN',
    scope: 'SOURCE_EDIT_AND_TEST_ONLY_NO_GIT_NO_BASH',
  };
}

// General readiness probe: verifies binary trust, CLI capability, and
// subscription auth only. It intentionally cannot prove `repositoryBoundary`
// because that is task-specific (exact repoRoot/branch); every actual
// invocation independently re-verifies the repository through
// verifyFeatureRepository before Claude is ever invoked, so a probe-time
// "ready" does not by itself grant write authority for any given task.
export function probeClaudeImplementationRunner({
  desc = resolveProviderCommand('claude'), envSource = process.env, timeoutMs = 5000,
} = {}) {
  if (!desc) return { ready: false, evidence: implementationRunnerEvidence(), blockers: ['CLAUDE_CLI_UNAVAILABLE'] };
  const credentialEnvAbsent = !unsafeProviderEnvPresent(envSource);
  if (!credentialEnvAbsent) {
    return { ready: false, evidence: implementationRunnerEvidence({ credentialEnvAbsent: false }), blockers: ['UNSAFE_PROVIDER_ENV_PRESENT'] };
  }
  const env = sanitizedChildEnv(envSource);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-claude-impl-probe-'));
  try {
    const isolatedDesc = isolateTrustedClaudeBinary(desc, tempRoot);
    const supported = Boolean(isolatedDesc) && runnerSupport(isolatedDesc, env, tempRoot);
    const auth = supported ? subscriptionAuth(isolatedDesc, env, timeoutMs, tempRoot) : null;
    const authOk = auth?.loggedIn === true && SAFE_SUBSCRIPTIONS.has(auth?.subscriptionType) && auth?.authMethod === 'claude.ai';
    const evidence = implementationRunnerEvidence({ auth, credentialEnvAbsent: true, runnerSupported: supported, repoVerified: false });
    const blockers = [];
    if (!supported) blockers.push('RUNNER_BINARY_OR_FLAGS_UNTRUSTED');
    if (supported && !authOk) blockers.push('SUBSCRIPTION_AUTH_NOT_VERIFIED');
    blockers.push('REPOSITORY_BOUNDARY_VERIFIED_PER_TASK_ONLY');
    return {
      ready: false,
      generalEvidenceReady: supported && authOk,
      evidence,
      blockers,
      subscriptionType: SAFE_SUBSCRIPTIONS.has(auth?.subscriptionType) ? auth.subscriptionType : null,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function runClaudeImplementationTask(payload, {
  desc = resolveProviderCommand('claude'),
  envSource = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const taskId = safeToken(payload?.taskId) ? payload.taskId : null;
  const errors = validateImplementationTask(payload);
  if (errors.length > 0) return stop('TASK_SCHEMA_INVALID', taskId);
  if (!desc) return stop('CLAUDE_CLI_UNAVAILABLE', taskId);
  if (unsafeProviderEnvPresent(envSource)) return stop('UNSAFE_PROVIDER_ENV_PRESENT', taskId);

  const repoCheck = verifyFeatureRepository(payload.repoRoot, payload.branch);
  if (!repoCheck.ok) return stop(repoCheck.code, taskId);

  // The worktree must be clean before Claude is ever invoked: only then is
  // every path that shows up dirty afterward attributable to this exact
  // execution rather than to pre-existing uncommitted/untracked state.
  const cleanCheck = verifyWorktreeClean(repoCheck.resolvedRoot);
  if (!cleanCheck.ok) return stop(cleanCheck.code, taskId);

  // Independently confirms the actual 'origin' remote before Claude ever
  // runs, rather than trusting the caller-supplied repository fields alone.
  const identityCheck = verifyRepositoryIdentity(repoCheck.resolvedRoot, payload.repository.owner, payload.repository.name);
  if (!identityCheck.ok) return stop(identityCheck.code, taskId);

  // Captured before Claude ever runs, so the eventual change-set hash is
  // bound to the exact commit this task started from rather than a
  // caller-supplied value that could be chosen to make an unrelated diff
  // look legitimate.
  const preHead = readHeadSha(repoCheck.resolvedRoot);
  if (!preHead) return stop('PRE_HEAD_UNKNOWN', taskId);

  const env = sanitizedChildEnv(envSource);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-claude-impl-'));
  try {
    const isolatedDesc = isolateTrustedClaudeBinary(desc, tempRoot);
    if (!isolatedDesc || !runnerSupport(isolatedDesc, env, tempRoot)) return stop('RUNNER_BINARY_OR_FLAGS_UNTRUSTED', taskId);
    const auth = subscriptionAuth(isolatedDesc, env, timeoutMs, tempRoot);
    if (!auth?.loggedIn || !SAFE_SUBSCRIPTIONS.has(auth.subscriptionType) || auth.authMethod !== 'claude.ai') {
      return stop('SUBSCRIPTION_AUTH_NOT_VERIFIED', taskId);
    }
    const result = run(isolatedDesc, implementationClaudeArgs('{"mcpServers":{}}'), {
      cwd: repoCheck.resolvedRoot, env, input: buildGuardedImplementationPrompt(payload), timeout: timeoutMs,
    });
    if (result.error?.code === 'ETIMEDOUT') return stop('PROVIDER_TIMEOUT', taskId);
    if (result.error?.code === 'ENOBUFS') return stop('PROVIDER_OUTPUT_TOO_LARGE', taskId);
    if (result.error || result.status !== 0) return stop('PROVIDER_STOPPED', taskId);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return stop('PROVIDER_OUTPUT_INVALID', taskId); }
    if (parsed?.type !== 'result' || parsed?.subtype !== 'success' || parsed?.is_error !== false || typeof parsed?.result !== 'string') return stop('PROVIDER_OUTPUT_INVALID', taskId);
    if (Buffer.byteLength(parsed.result, 'utf8') > MAX_OUTPUT_BYTES) return stop('PROVIDER_OUTPUT_TOO_LARGE', taskId);

    // Computed immediately after Claude finishes, over the exact uncommitted
    // change set (tracked modifications/deletions plus untracked new files)
    // it just produced. Nothing else runs between "Claude exits" and this
    // computation, so the value cannot capture changes from anywhere else. A
    // later commit that reproduces this exact change set will hash
    // identically at final-receipt verification time; anything else stops.
    const changeSet = computeChangeSetSha256(repoCheck.resolvedRoot, preHead);
    if (!changeSet) return stop('EXECUTION_EVIDENCE_UNAVAILABLE', taskId);
    if (changeSet.changedPaths.length === 0) return stop('NO_SOURCE_CHANGES_PRODUCED', taskId);

    // Protected/reference/test inputs are a stricter boundary than allowedScope.
    // A path may be inside the implementation area but still be immutable for this task.
    const forbiddenChangedPaths = changedPathsInForbiddenScope(changeSet.changedPaths, payload.forbiddenScope ?? []);
    if (forbiddenChangedPaths.length > 0) {
      return { ...stop('FORBIDDEN_SCOPE_VIOLATION', taskId), changedPaths: changeSet.changedPaths, forbiddenChangedPaths, preHead };
    }

    // Enforced after Claude has already returned and before COMPLETED is
    // reported: every changed path must be covered by allowedScope. This
    // never rolls back Claude's edits automatically -- it fails closed and
    // leaves the evidence (repoRoot/preHead/changedPaths) for deterministic
    // cleanup rather than silently reporting success outside scope.
    if (!changedPathsWithinScope(changeSet.changedPaths, payload.allowedScope)) {
      return { ...stop('ALLOWED_SCOPE_VIOLATION', taskId), changedPaths: changeSet.changedPaths, preHead };
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      result: 'COMPLETED',
      routeId: ROUTE_ID,
      taskId,
      capability: payload.capability,
      dataClass: payload.dataClass,
      repoRoot: repoCheck.resolvedRoot,
      branch: repoCheck.branch,
      output: parsed.result,
      evidence: implementationRunnerEvidence({ auth, credentialEnvAbsent: true, runnerSupported: true, repoVerified: true }),
      executionEvidence: { preHead, changeSetSha256: changeSet.changeSetSha256, changedPaths: changeSet.changedPaths },
      forbiddenScope: [...(payload.forbiddenScope ?? [])],
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function readBoundedTaskInput(stream = process.stdin, { maxBytes = MAX_INPUT_BYTES * 2, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false; let bytes = 0; const chunks = [];
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.removeListener('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const fail = (code) => { const error = new Error(code); error.code = code; try { stream.pause(); } catch {} finish(error); };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); bytes += buffer.length;
      if (bytes > maxBytes) { fail('INPUT_TOO_LARGE'); return; }
      chunks.push(buffer);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const onError = () => fail('INPUT_STREAM_ERROR');
    const timer = setTimeout(() => fail('INPUT_TIMEOUT'), timeoutMs);
    stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError);
  });
}

function parseArgs(argv) {
  let pretty = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pretty') pretty = true;
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 600000) return { valid: false };
      timeoutMs = parsed;
    } else return { valid: false };
  }
  return { valid: true, pretty, timeoutMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) { process.stdout.write(`${JSON.stringify(stop('ARGUMENT_INVALID'))}\n`); process.exitCode = 2; return; }
  try {
    const raw = await readBoundedTaskInput(process.stdin);
    const payload = JSON.parse(raw);
    const result = runClaudeImplementationTask(payload, { timeoutMs: args.timeoutMs });
    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    if (result.result !== 'COMPLETED') process.exitCode = 1;
  } catch (error) {
    const code = ['INPUT_TOO_LARGE', 'INPUT_TIMEOUT', 'INPUT_STREAM_ERROR'].includes(error?.code) ? error.code : 'INPUT_READ_OR_PARSE_FAILED';
    process.stdout.write(`${JSON.stringify(stop(code))}\n`); process.exitCode = 2;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(() => { process.stdout.write(`${JSON.stringify(stop('RUNNER_INTERNAL_ERROR'))}\n`); process.exitCode = 2; });
