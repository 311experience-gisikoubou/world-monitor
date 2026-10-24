#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

// This module only confirms that a given head-to-head range is a clean,
// linear, docs-only suffix. It never authorizes a merge: its result is
// explicitly named DOCS_ONLY_SUFFIX_CONFIRMED_NOT_MERGE_AUTHORIZATION so no
// caller can mistake "docs suffix verified" for "merge approved". No Git
// write commands are ever issued here.
const SHA_RE = /^[0-9a-f]{40}$/i;
const DOCS_EXT_RE = /\.(?:md|json|png)$/i;
const SPECIAL_ROOT_FILES = new Set(['CURRENT_STATUS.md', 'PROJECT_CONTEXT.json']);

function repoRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.startsWith('/') &&
    !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function stop(code) {
  return { result: 'STOP', code };
}

function runGit(repoRoot, args, timeoutMs = 10000) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
  });
}

function parsePathsZ(stdout) {
  return String(stdout || '').split('\0').filter((entry) => entry.length > 0);
}

// A changed path qualifies only as CURRENT_STATUS.md, PROJECT_CONTEXT.json,
// or a .md/.json/.png file strictly under docs/. Nothing else, regardless of
// extension or location, is ever treated as docs-only.
function qualifiesAsDocsPath(changedPath) {
  if (SPECIAL_ROOT_FILES.has(changedPath)) return true;
  return changedPath.startsWith('docs/') && DOCS_EXT_RE.test(changedPath);
}

export function verifyDocsOnlySuffix({ repoRoot, fromHead, toHead, allowedPaths }) {
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) return stop('REPO_ROOT_INVALID');
  if (!SHA_RE.test(fromHead || '') || !SHA_RE.test(toHead || '')) return stop('HEAD_SHA_INVALID');
  const normalizedFromHead = fromHead.toLowerCase();
  const normalizedToHead = toHead.toLowerCase();
  if (!Array.isArray(allowedPaths) || !allowedPaths.every((entry) => repoRelativePath(entry))) {
    return stop('ALLOWED_PATHS_INVALID');
  }

  const headResult = runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (headResult.error || headResult.status !== 0) return stop('REPO_HEAD_UNVERIFIABLE');
  if (String(headResult.stdout || '').trim().toLowerCase() !== normalizedToHead) return stop('CURRENT_HEAD_MISMATCH');

  const statusResult = runGit(repoRoot, ['status', '--porcelain=v1']);
  if (statusResult.error || statusResult.status !== 0) return stop('WORKTREE_STATUS_UNVERIFIABLE');
  if (String(statusResult.stdout || '').trim().length > 0) return stop('WORKTREE_NOT_CLEAN');

  const ancestorResult = runGit(repoRoot, ['merge-base', '--is-ancestor', normalizedFromHead, normalizedToHead]);
  if (ancestorResult.error) return stop('ANCESTRY_UNVERIFIABLE');
  if (ancestorResult.status !== 0) return stop('FROM_HEAD_NOT_ANCESTOR');

  const mergesResult = runGit(repoRoot, ['rev-list', '--min-parents=2', `${normalizedFromHead}..${normalizedToHead}`]);
  if (mergesResult.error || mergesResult.status !== 0) return stop('MERGE_HISTORY_UNVERIFIABLE');
  if (String(mergesResult.stdout || '').trim().length > 0) return stop('MERGED_COMMITS_PRESENT');

  const commitListResult = runGit(repoRoot, ['rev-list', '--reverse', `${normalizedFromHead}..${normalizedToHead}`]);
  if (commitListResult.error || commitListResult.status !== 0) return stop('COMMIT_LIST_UNVERIFIABLE');
  const commits = String(commitListResult.stdout || '').split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

  const changedPathsSet = new Set();

  for (const commit of commits) {
    if (!SHA_RE.test(commit)) return stop('COMMIT_SHA_INVALID');
    const normalizedCommit = commit.toLowerCase();

    const parentResult = runGit(repoRoot, ['rev-parse', `${normalizedCommit}^`]);
    if (parentResult.error || parentResult.status !== 0) return stop('COMMIT_PARENT_UNVERIFIABLE');
    const parent = String(parentResult.stdout || '').trim().toLowerCase();
    if (!SHA_RE.test(parent)) return stop('COMMIT_PARENT_INVALID');

    const commitDiffResult = runGit(repoRoot, ['diff', '--name-status', '--no-renames', '-z', parent, normalizedCommit]);
    if (commitDiffResult.error || commitDiffResult.status !== 0) return stop('DIFF_UNVERIFIABLE');
    const entries = parsePathsZ(commitDiffResult.stdout);

    for (let i = 0; i < entries.length; i += 2) {
      const status = entries[i];
      const changedPath = entries[i + 1];
      if (typeof status !== 'string' || typeof changedPath !== 'string') return stop('DIFF_UNVERIFIABLE');
      if (!repoRelativePath(changedPath)) return stop('CHANGED_PATH_INVALID');
      if (status.startsWith('D')) return stop('DOCS_DELETION_REFUSED');
      const explicitlyAllowed = allowedPaths.includes(changedPath);
      if (!explicitlyAllowed || !qualifiesAsDocsPath(changedPath)) return stop('OUT_OF_SCOPE_CHANGE');
      changedPathsSet.add(changedPath);
    }
  }

  const changedPaths = Array.from(changedPathsSet);

  return {
    result: 'DOCS_ONLY_SUFFIX_CONFIRMED_NOT_MERGE_AUTHORIZATION',
    fromHead: normalizedFromHead,
    toHead: normalizedToHead,
    changedPaths,
  };
}
