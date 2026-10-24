// Read-only triage for "legacy" provenance claims that assert a replay
// commit proves who historically wrote some already-merged work. A replay
// can at most prove two git trees are byte-identical; it can never prove
// who authored history that already exists. This module never returns
// MERGE_READY and never claims original authorship -- it only ever returns
// STOP (with a specific code) or REPLAY_EQUIVALENT_NOT_ORIGINAL_AUTHORSHIP,
// with originalWriterProven always false. It never writes, commits, stages,
// or otherwise mutates any file or git state; every git invocation below is
// a read-only inspection command only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { verifyFinalReceipt } from './implementation-route-receipt.mjs';
import { verifyFeatureRepository, verifyRepositoryIdentity } from './implementation-runner.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const CHANGE_SET_SHA256_RE = /^[0-9a-f]{64}$/i;

function stop(code, extra = {}) {
  return { schemaVersion: 1, result: 'STOP', code, originalWriterProven: false, ...extra };
}

function git(repoRoot, args, timeoutMs = 8000) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
}

function commitExists(repoRoot, sha) {
  const result = git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
  return !result.error && result.status === 0;
}

function treeOf(repoRoot, sha) {
  const result = git(repoRoot, ['rev-parse', '--verify', `${sha}^{tree}`]);
  if (result.error || result.status !== 0) return null;
  const tree = String(result.stdout || '').trim().toLowerCase();
  return SHA_RE.test(tree) ? tree : null;
}

// Pure, read-only diagnosis. Takes the exact {originalHead, replayHead,
// receipt, repoRoot, repository, branch} the caller is claiming, and
// independently re-verifies every part of that claim against the actual
// repository on disk and the existing final-receipt verifier -- it never
// trusts any part of the claim on say-so alone.
export function diagnoseLegacyProvenance({
  originalHead, replayHead, receipt, repoRoot, repository, branch,
} = {}) {
  if (!replayHead || !receipt) return stop('NEEDS_VERIFIABLE_REPLAY');

  // Hardening (2): a replay can only ever be trusted if it was produced by a
  // qualified, runner-attested execution with real executionEvidence. A
  // direct-browser executor (or any receipt missing/forging this shape) is
  // never an acceptable basis for a replay claim, so it is rejected here on
  // its own shape before any git inspection is ever performed.
  if (receipt?.executor?.routeType !== 'qualified-agent') return stop('EXECUTOR_ROUTE_TYPE_INVALID');
  const claimedExecutionEvidence = receipt?.executionEvidence;
  if (!claimedExecutionEvidence || typeof claimedExecutionEvidence !== 'object' || Array.isArray(claimedExecutionEvidence) ||
      !SHA_RE.test(String(claimedExecutionEvidence.preHead || '')) ||
      !CHANGE_SET_SHA256_RE.test(String(claimedExecutionEvidence.changeSetSha256 || '')) ||
      !Array.isArray(claimedExecutionEvidence.changedPaths) || claimedExecutionEvidence.changedPaths.length === 0 ||
      !claimedExecutionEvidence.changedPaths.every((p) => typeof p === 'string' && p.length > 0)) {
    return stop('EXECUTION_EVIDENCE_INVALID');
  }

  const original = String(originalHead || '').toLowerCase();
  const replay = String(replayHead || '').toLowerCase();
  if (!SHA_RE.test(original)) return stop('ORIGINAL_HEAD_INVALID');
  if (!SHA_RE.test(replay)) return stop('REPLAY_HEAD_INVALID');

  // Hardening (4): a replay that is literally the same commit as "original"
  // proves nothing (there is no independent second execution to compare),
  // so it is refused outright rather than trivially "matching".
  if (original === replay) return stop('REPLAY_SAME_HEAD');

  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) return stop('REPO_ROOT_INVALID');
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(repoRoot);
    if (!fs.statSync(resolvedRoot).isDirectory()) return stop('REPO_ROOT_NOT_DIRECTORY');
  } catch {
    return stop('REPO_ROOT_NOT_FOUND');
  }
  const insideTree = git(resolvedRoot, ['rev-parse', '--is-inside-work-tree']);
  if (insideTree.error || insideTree.status !== 0 || String(insideTree.stdout || '').trim() !== 'true') {
    return stop('REPO_NOT_GIT_WORK_TREE');
  }

  // Hardening (1): independently re-verify the caller-claimed repository and
  // branch identity against the actual repository on disk, using the exact
  // same verifiers the runner/receipt path relies on, instead of trusting
  // the repository/branch fields on say-so. Any missing/incorrect
  // owner/name/branch (including a protected, detached, or mismatched
  // branch, or a repository whose origin does not resolve to the claimed
  // owner/name) fails closed here, before either head is ever treated as
  // belonging to this repository/branch.
  const repoCheck = verifyFeatureRepository(repoRoot, branch);
  if (!repoCheck.ok) return stop(repoCheck.code);
  if (repoCheck.resolvedRoot !== resolvedRoot) return stop('REPO_ROOT_MISMATCH');
  const identityCheck = verifyRepositoryIdentity(resolvedRoot, repository?.owner, repository?.name);
  if (!identityCheck.ok) return stop(identityCheck.code);

  if (!commitExists(resolvedRoot, original)) return stop('ORIGINAL_HEAD_NOT_FOUND');
  if (!commitExists(resolvedRoot, replay)) return stop('REPLAY_HEAD_NOT_FOUND');

  // Hardening (4): originalHead and replayHead must share actual commit
  // history. 'git merge-base' only succeeds when the two commits have a
  // common ancestor; unrelated histories (e.g. a replay built from an
  // orphan/unrelated branch that merely happens to produce the same tree)
  // are never accepted as a legacy-provenance replay claim.
  const mergeBase = git(resolvedRoot, ['merge-base', original, replay]);
  if (mergeBase.error || mergeBase.status !== 0 || !SHA_RE.test(String(mergeBase.stdout || '').trim())) {
    return stop('UNRELATED_COMMIT_HISTORY');
  }

  const status = git(resolvedRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z']);
  if (status.error || status.status !== 0) return stop('WORKTREE_STATUS_UNKNOWN');
  if (String(status.stdout || '').split('\0').some((entry) => entry.length > 0)) return stop('WORKTREE_NOT_CLEAN');

  const originalTree = treeOf(resolvedRoot, original);
  const replayTree = treeOf(resolvedRoot, replay);
  if (!originalTree || !replayTree) return stop('TREE_UNKNOWN');
  if (originalTree !== replayTree) return stop('TREES_UNEQUAL', { originalTree, replayTree });

  // Hardening (3): verifyFinalReceipt is an external verifier this module
  // does not control; any exception it throws (malformed receipt shape,
  // unexpected field access, etc.) must never propagate as an uncaught
  // error or be mistaken for a passing result -- it fails closed as
  // RECEIPT_NOT_VERIFIED exactly like a verifier that returned non-PASS.
  let verified;
  try {
    verified = verifyFinalReceipt(receipt, {
      owner: repository?.owner, name: repository?.name, branch, head: replay, repoRoot: resolvedRoot,
    });
  } catch {
    return stop('RECEIPT_NOT_VERIFIED', { receiptResult: null, receiptCode: 'RECEIPT_VERIFICATION_THREW' });
  }
  if (!verified || verified.result !== 'MERGE_READY') {
    return stop('RECEIPT_NOT_VERIFIED', { receiptResult: verified?.result ?? null, receiptCode: verified?.code ?? null });
  }

  return {
    schemaVersion: 1,
    result: 'REPLAY_EQUIVALENT_NOT_ORIGINAL_AUTHORSHIP',
    code: 'REPLAY_TREE_MATCHES_ORIGINAL_TREE',
    originalWriterProven: false,
    originalHead: original,
    replayHead: replay,
    tree: replayTree,
    notice: 'A_VERIFIED_REPLAY_PROVES_TREE_EQUIVALENCE_ONLY_NEVER_HISTORICAL_AUTHORSHIP',
  };
}
