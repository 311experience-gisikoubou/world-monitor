#!/usr/bin/env node
// Read-only: proves a specific committed change set matches a specific final
// receipt's claims (parent, head, changed paths) and that the receipt itself
// independently verifies MERGE_READY via the existing final-receipt verifier.
// This does NOT prove who historically wrote the commit and does NOT
// authorize a merge; it only binds one commit to one qualified-agent receipt.
import { spawnSync } from 'node:child_process';
import { verifyFinalReceipt } from './implementation-route-receipt.mjs';
import {
  computeChangeSetSha256, verifyRepositoryIdentity, verifyFeatureRepository, changedPathsWithinScope,
} from './implementation-runner.mjs';
import { validateResearchEnvelopeShape, computeConstraintsDigest } from './research-gate.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const CHANGE_SET_SHA256_RE = /^[0-9A-Fa-f]{64}$/;

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}

function stop(code, extra = {}) {
  return { schemaVersion: 1, result: 'STOP', code, ...extra };
}

function runGit(repoRoot, args, timeoutMs = 10000) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
  });
}

// --name-status -z yields alternating NUL-terminated (status, path) tokens;
// --no-renames guarantees each status is a single letter, never a
// rename/copy score suffix, so no dual-path ambiguity exists here.
function parseNameStatusZ(stdout) {
  const tokens = String(stdout || '').split('\0').filter((token) => token.length > 0);
  const paths = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const filePath = tokens[i + 1];
    if (filePath === undefined) break;
    paths.push(filePath);
  }
  return paths;
}

function sortedUnique(paths) {
  return [...new Set(paths)].sort();
}

function pathsEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// Shared, read-only git binding check reused by both verifyQualifiedCommitReceipt
// (current-authorization path) and triageHistoricalCommitEvidence (diagnostic-only
// historical path) below, so the actual commit/parent/changed-paths matching logic
// is never duplicated or allowed to silently drift between the two entry points.
// Returns { ok: true, actualParent, actualChangedPaths } or { ok: false, code }.
function verifyCommittedChangeBinding(repoRoot, normalizedCommit, claimedPreHead, claimedChangedPaths) {
  const existsCheck = runGit(repoRoot, ['cat-file', '-e', `${normalizedCommit}^{commit}`]);
  if (existsCheck.error || existsCheck.status !== 0) return { ok: false, code: 'COMMIT_NOT_FOUND' };

  const parentsResult = runGit(repoRoot, ['rev-list', '--parents', '-n', '1', normalizedCommit]);
  if (parentsResult.error || parentsResult.status !== 0) return { ok: false, code: 'COMMIT_PARENTS_UNKNOWN' };
  const parts = String(parentsResult.stdout || '').trim().split(/\s+/).filter((part) => part.length > 0);
  const parents = parts.slice(1);
  if (parents.length !== 1) return { ok: false, code: 'COMMIT_NOT_EXACTLY_ONE_PARENT' };
  const actualParent = parents[0].toLowerCase();
  if (!SHA_RE.test(actualParent)) return { ok: false, code: 'COMMIT_PARENT_SHA_INVALID' };
  if (actualParent !== String(claimedPreHead || '').toLowerCase()) return { ok: false, code: 'PARENT_PRE_HEAD_MISMATCH' };

  const diffResult = runGit(repoRoot, ['diff', '--name-status', '--no-renames', '-z', actualParent, normalizedCommit]);
  if (diffResult.error || diffResult.status !== 0) return { ok: false, code: 'COMMIT_DIFF_UNKNOWN' };
  const actualChangedPaths = sortedUnique(parseNameStatusZ(diffResult.stdout));
  const claimedChangedPathsSorted = sortedUnique(claimedChangedPaths);
  if (!pathsEqual(actualChangedPaths, claimedChangedPathsSorted)) return { ok: false, code: 'CHANGED_PATHS_MISMATCH' };

  return { ok: true, actualParent, actualChangedPaths };
}

export function verifyQualifiedCommitReceipt({ repoRoot, repository, commit, receipt }) {
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) return stop('REPO_ROOT_INVALID');
  if (!repository || typeof repository !== 'object' || Array.isArray(repository) ||
      !safeToken(repository.owner) || !safeToken(repository.name)) {
    return stop('REPOSITORY_INVALID');
  }
  if (!SHA_RE.test(commit || '')) return stop('COMMIT_SHA_INVALID');
  const normalizedCommit = commit.toLowerCase();

  if (!receipt || typeof receipt !== 'object' || receipt.result !== 'PASS') return stop('RECEIPT_NOT_PASS');
  if (!receipt.executor || receipt.executor.routeType !== 'qualified-agent') {
    return stop('RECEIPT_ROUTE_TYPE_NOT_QUALIFIED_AGENT');
  }
  if (!receipt.repository || receipt.repository.owner !== repository.owner ||
      receipt.repository.name !== repository.name) {
    return stop('RECEIPT_REPOSITORY_MISMATCH');
  }
  if (receipt.implementationHead !== normalizedCommit) return stop('IMPLEMENTATION_HEAD_MISMATCH');
  if (!receipt.executionEvidence || typeof receipt.executionEvidence !== 'object' ||
      !SHA_RE.test(receipt.executionEvidence.preHead || '')) {
    return stop('EXECUTION_EVIDENCE_PRE_HEAD_INVALID');
  }
  if (!Array.isArray(receipt.executionEvidence.changedPaths)) return stop('EXECUTION_EVIDENCE_CHANGED_PATHS_INVALID');

  const binding = verifyCommittedChangeBinding(
    repoRoot, normalizedCommit, receipt.executionEvidence.preHead, receipt.executionEvidence.changedPaths,
  );
  if (!binding.ok) return stop(binding.code);
  const { actualParent, actualChangedPaths } = binding;

  const finalVerification = verifyFinalReceipt(receipt, {
    owner: repository.owner, name: repository.name, branch: receipt.branch, head: normalizedCommit, repoRoot,
  });
  if (!finalVerification || finalVerification.result !== 'MERGE_READY') {
    return stop('FINAL_RECEIPT_VERIFICATION_FAILED', { finalVerification });
  }

  return {
    schemaVersion: 1,
    result: 'QUALIFIED_COMMIT_VERIFIED_NOT_MERGE_AUTHORIZATION',
    code: 'QUALIFIED_COMMIT_VERIFIED_NOT_MERGE_AUTHORIZATION',
    repository: { owner: repository.owner, name: repository.name },
    branch: receipt.branch,
    commit: normalizedCommit,
    parent: actualParent,
    changedPaths: actualChangedPaths,
  };
}

// Read-only, DIAGNOSTIC-ONLY historical evidence triage. This exists for the
// narrow case where a genuine historic commit's final receipt and matching
// COMPLETED runner result both independently and currently re-verify as
// content-consistent with the actual repository, but the receipt's bound
// research evidence is now aged past its own maxEvidenceAgeMs window, so
// verifyQualifiedCommitReceipt's unmodified verifyFinalReceipt call correctly
// STOPs on CURRENT re-evaluation (it recomputes research freshness against
// the real current clock every time, by design -- see implementation-route-
// receipt.mjs / research-gate.mjs). That STOP is CORRECT and is never
// relaxed, bypassed, or re-decided here, and this function NEVER forges a
// past "now" to manufacture a fresh research PASS for old evidence.
//
// This function instead answers a strictly narrower, read-only question:
// "does the current actual committed change set in this exact repository
// still match what the final receipt claims AND what an actual qualified-
// agent runner result already recorded as COMPLETED, independent of whether
// today's research freshness window has since lapsed?" A positive result is
// explicitly labeled DIAGNOSTIC ONLY, never implies current merge authority,
// and never claims to prove who historically typed the commit: a mutable
// saved JSON receipt/result file and a Git commit timestamp are both
// editable after the fact and are never, by themselves, proof of actual
// Claude authorship. originalWriterProven and currentMergeAuthorized are
// therefore always false on every path, including the positive one.
export function triageHistoricalCommitEvidence({
  repoRoot, repository, commit, finalReceipt, runnerResult, preImplementationReceipt,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    return stop('REPO_ROOT_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!repository || typeof repository !== 'object' || Array.isArray(repository) ||
      !safeToken(repository.owner) || !safeToken(repository.name)) {
    return stop('REPOSITORY_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!SHA_RE.test(commit || '')) return stop('COMMIT_SHA_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  const normalizedCommit = commit.toLowerCase();

  // --- final receipt: shape + identity binding, never its own PASS text alone ---
  if (!finalReceipt || typeof finalReceipt !== 'object' || Array.isArray(finalReceipt)) {
    return stop('FINAL_RECEIPT_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (finalReceipt.result !== 'PASS') return stop('FINAL_RECEIPT_NOT_PASS', { originalWriterProven: false, currentMergeAuthorized: false });
  if (!finalReceipt.executor || finalReceipt.executor.routeType !== 'qualified-agent') {
    return stop('FINAL_RECEIPT_ROUTE_TYPE_NOT_QUALIFIED_AGENT', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!finalReceipt.repository || finalReceipt.repository.owner !== repository.owner ||
      finalReceipt.repository.name !== repository.name) {
    return stop('FINAL_RECEIPT_REPOSITORY_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (finalReceipt.implementationHead !== normalizedCommit) {
    return stop('FINAL_RECEIPT_IMPLEMENTATION_HEAD_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  const finalEvidence = finalReceipt.executionEvidence;
  if (!finalEvidence || typeof finalEvidence !== 'object' || Array.isArray(finalEvidence) ||
      !SHA_RE.test(finalEvidence.preHead || '') ||
      !CHANGE_SET_SHA256_RE.test(finalEvidence.changeSetSha256 || '') ||
      !Array.isArray(finalEvidence.changedPaths)) {
    return stop('FINAL_RECEIPT_EXECUTION_EVIDENCE_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }

  // The research envelope must be WELL-FORMED (shape only). This deliberately
  // never calls evaluateResearchGateBound / blocksSourceWrite: doing so would
  // re-decide the research gate's result against the current clock (exactly
  // what verifyFinalReceipt already does, correctly, and which this function
  // must never duplicate or launder into a fresh PASS for aged evidence).
  const researchShapeErrors = validateResearchEnvelopeShape(finalReceipt.research);
  if (researchShapeErrors.length > 0) {
    return stop('FINAL_RECEIPT_RESEARCH_ENVELOPE_MALFORMED', {
      errors: researchShapeErrors, originalWriterProven: false, currentMergeAuthorized: false,
    });
  }
  if (!Array.isArray(finalReceipt.allowedScope) || finalReceipt.allowedScope.length === 0 ||
      !finalReceipt.allowedScope.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    return stop('FINAL_RECEIPT_ALLOWED_SCOPE_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }

  // The research envelope's raw evidenceBinding must be bound EXACTLY to this
  // final receipt's own task/repository/scope and to its own research.context
  // proposal/constraints/digest. validateResearchEnvelopeShape above only
  // confirms gross shape (evidence is an object; context is well-formed); it
  // never confirms evidenceBinding's substantive identity fields, so without
  // this an unrelated repository/task/scope could otherwise be swapped into
  // evidenceBinding while finalReceipt's own top-level fields still look
  // correct. This is diagnostic re-verification only and never re-decides
  // research freshness/outcome -- that stays exclusively verifyFinalReceipt's
  // job, unmodified, and current human top conditions stay governed only by
  // validateResearchContextShape (via validateResearchEnvelopeShape above),
  // untouched here.
  const researchContext = finalReceipt.research.context;
  const evidenceBinding = finalReceipt.research.evidence && typeof finalReceipt.research.evidence === 'object'
    ? finalReceipt.research.evidence.evidenceBinding
    : undefined;
  if (!evidenceBinding || typeof evidenceBinding !== 'object' || Array.isArray(evidenceBinding)) {
    return stop('FINAL_RECEIPT_RESEARCH_EVIDENCE_BINDING_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!safeToken(evidenceBinding.taskId) || evidenceBinding.taskId !== finalReceipt.taskId) {
    return stop('RESEARCH_EVIDENCE_BINDING_TASK_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  const bindingRepository = evidenceBinding.repository;
  if (!bindingRepository || typeof bindingRepository !== 'object' || Array.isArray(bindingRepository) ||
      bindingRepository.owner !== repository.owner || bindingRepository.name !== repository.name) {
    return stop('RESEARCH_EVIDENCE_BINDING_REPOSITORY_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!Array.isArray(evidenceBinding.scope) ||
      !pathsEqual(sortedUnique(evidenceBinding.scope), sortedUnique(finalReceipt.allowedScope))) {
    return stop('RESEARCH_EVIDENCE_BINDING_SCOPE_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (typeof evidenceBinding.proposalId !== 'string' || evidenceBinding.proposalId !== researchContext.proposalId) {
    return stop('RESEARCH_EVIDENCE_BINDING_PROPOSAL_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!Array.isArray(evidenceBinding.constraints) || !Array.isArray(researchContext.constraints) ||
      !pathsEqual(sortedUnique(evidenceBinding.constraints), sortedUnique(researchContext.constraints))) {
    return stop('RESEARCH_EVIDENCE_BINDING_CONSTRAINTS_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!CHANGE_SET_SHA256_RE.test(evidenceBinding.constraintsDigestSha256 || '') ||
      computeConstraintsDigest(evidenceBinding.constraints).toUpperCase() !== String(evidenceBinding.constraintsDigestSha256).toUpperCase()) {
    return stop('RESEARCH_EVIDENCE_BINDING_DIGEST_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }

  // --- branch: reuse the existing runner helper to bind the actual current
  // local branch to exactly what the final receipt claims, instead of
  // trusting finalReceipt.branch on text alone.
  const branchCheck = verifyFeatureRepository(repoRoot, finalReceipt.branch);
  if (!branchCheck.ok) return stop(branchCheck.code, { originalWriterProven: false, currentMergeAuthorized: false });

  // --- original pre-implementation receipt, if supplied: distinguished from the final receipt, never trusted on text alone ---
  let preImplementationReceiptSummary = null;
  if (preImplementationReceipt !== undefined) {
    if (!preImplementationReceipt || typeof preImplementationReceipt !== 'object' || Array.isArray(preImplementationReceipt)) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    // A genuine pre-implementation receipt is produced BEFORE any commit
    // exists: it always carries result 'PROCEED' and a null implementationHead
    // (see decide() in implementation-route-receipt.mjs). A caller supplying a
    // relabeled final receipt here -- to manufacture two independent-looking
    // "PASS" artifacts out of one single actual event -- is rejected rather
    // than silently accepted as if it were a distinct earlier step.
    if (preImplementationReceipt.result !== 'PROCEED') {
      return stop('PRE_IMPLEMENTATION_RECEIPT_NOT_PROCEED', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    if (preImplementationReceipt.implementationHead !== null) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_IMPLEMENTATION_HEAD_FORBIDDEN', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    if (preImplementationReceipt.executionEvidence !== null) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_EXECUTION_EVIDENCE_FORBIDDEN', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    if (!preImplementationReceipt.executor || preImplementationReceipt.executor.routeType !== finalReceipt.executor.routeType) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_EXECUTOR_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    if (!preImplementationReceipt.repository || preImplementationReceipt.repository.owner !== repository.owner ||
        preImplementationReceipt.repository.name !== repository.name) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_REPOSITORY_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    // Cross-bound to the exact same task/branch/scope as the final receipt:
    // a genuinely distinct earlier pre-implementation step for THIS task
    // never carries a different task id, a different branch, or a different
    // allowed scope than the final receipt it is supposed to precede.
    if (preImplementationReceipt.taskId !== finalReceipt.taskId) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_TASK_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    if (preImplementationReceipt.branch !== finalReceipt.branch) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_BRANCH_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    if (!Array.isArray(preImplementationReceipt.allowedScope) ||
        !pathsEqual(sortedUnique(preImplementationReceipt.allowedScope), sortedUnique(finalReceipt.allowedScope))) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_SCOPE_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
    }
    const preResearchShapeErrors = validateResearchEnvelopeShape(preImplementationReceipt.research);
    if (preResearchShapeErrors.length > 0) {
      return stop('PRE_IMPLEMENTATION_RECEIPT_RESEARCH_ENVELOPE_MALFORMED', {
        errors: preResearchShapeErrors, originalWriterProven: false, currentMergeAuthorized: false,
      });
    }
    // Surfaced for the human reader's context only: a well-formed, correctly
    // staged pre-implementation receipt is NEVER treated as additional proof
    // of authorship or of current authorization, and its own 'PROCEED' text
    // is never re-trusted beyond this shape/identity binding.
    preImplementationReceiptSummary = {
      present: true,
      taskId: preImplementationReceipt.taskId ?? null,
      distinctFromFinalReceipt: true,
      trustedBeyondShapeAndIdentityBinding: false,
    };
  }

  // --- runner result: must be an actual COMPLETED execution, matched to the receipt's own claims ---
  if (!runnerResult || typeof runnerResult !== 'object' || Array.isArray(runnerResult)) {
    return stop('RUNNER_RESULT_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (runnerResult.result !== 'COMPLETED') {
    return stop('RUNNER_RESULT_NOT_COMPLETED', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (runnerResult.routeId !== 'claude-implementation-write') {
    return stop('RUNNER_RESULT_ROUTE_ID_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  const runnerEvidence = runnerResult.executionEvidence;
  if (!runnerEvidence || typeof runnerEvidence !== 'object' || Array.isArray(runnerEvidence) ||
      !SHA_RE.test(runnerEvidence.preHead || '') ||
      !CHANGE_SET_SHA256_RE.test(runnerEvidence.changeSetSha256 || '') ||
      !Array.isArray(runnerEvidence.changedPaths)) {
    return stop('RUNNER_RESULT_EXECUTION_EVIDENCE_INVALID', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (runnerEvidence.preHead.toLowerCase() !== finalEvidence.preHead.toLowerCase()) {
    return stop('RUNNER_FINAL_PRE_HEAD_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (runnerEvidence.changeSetSha256.toUpperCase() !== finalEvidence.changeSetSha256.toUpperCase()) {
    return stop('RUNNER_FINAL_CHANGE_SET_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!pathsEqual(sortedUnique(runnerEvidence.changedPaths), sortedUnique(finalEvidence.changedPaths))) {
    return stop('RUNNER_FINAL_CHANGED_PATHS_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  // Cross-bound to the exact same task/branch/scope as the final receipt:
  // an actual COMPLETED runner execution for a DIFFERENT task, branch, or
  // outside the final receipt's own allowed scope is never accepted as
  // evidence for THIS final receipt's claims, even if its preHead/digest/
  // paths happen to coincide.
  if (runnerResult.taskId !== finalReceipt.taskId) {
    return stop('RUNNER_FINAL_TASK_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (runnerResult.branch !== finalReceipt.branch) {
    return stop('RUNNER_FINAL_BRANCH_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  if (!changedPathsWithinScope(runnerEvidence.changedPaths, finalReceipt.allowedScope)) {
    return stop('RUNNER_FINAL_SCOPE_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }

  // --- repository identity: reuse the existing runner helper exactly as it allows today ---
  const identityCheck = verifyRepositoryIdentity(repoRoot, repository.owner, repository.name);
  if (!identityCheck.ok) return stop(identityCheck.code, { originalWriterProven: false, currentMergeAuthorized: false });

  // --- current actual committed change set: independently re-derived from the exact repository, never trusted from any receipt/result text ---
  const binding = verifyCommittedChangeBinding(repoRoot, normalizedCommit, finalEvidence.preHead, finalEvidence.changedPaths);
  if (!binding.ok) return stop(binding.code, { originalWriterProven: false, currentMergeAuthorized: false });

  const recomputed = computeChangeSetSha256(repoRoot, binding.actualParent, normalizedCommit);
  if (!recomputed) return stop('EXECUTION_EVIDENCE_UNVERIFIABLE', { originalWriterProven: false, currentMergeAuthorized: false });
  if (recomputed.changeSetSha256.toUpperCase() !== finalEvidence.changeSetSha256.toUpperCase()) {
    return stop('CHANGE_SET_DIGEST_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }
  const recomputedChangedPaths = recomputed.changedPaths;
  const claimedChangedPaths = finalEvidence.changedPaths;
  if (claimedChangedPaths.length !== recomputedChangedPaths.length ||
      claimedChangedPaths.some((changedPath, index) => changedPath !== recomputedChangedPaths[index])) {
    return stop('CHANGE_SET_DIGEST_MISMATCH', { originalWriterProven: false, currentMergeAuthorized: false });
  }

  // Everything above is CONTENT consistency only: current actual commit <->
  // final receipt claims <-> actual COMPLETED runner result, all bound to
  // this exact repository owner/name. None of it is, or is ever claimed to
  // be, proof of WHO wrote the commit. The result is therefore explicitly
  // DIAGNOSTIC ONLY, with both authorship and current merge authorization
  // hard-set to false; current merge authorization remains decided
  // exclusively by the unmodified verifyQualifiedCommitReceipt / verifyFinalReceipt
  // path against the real current clock.
  return {
    schemaVersion: 1,
    result: 'HISTORICAL_COMMIT_CONTENT_CONSISTENT_NOT_CURRENT_AUTHORIZATION',
    code: 'HISTORICAL_COMMIT_CONTENT_CONSISTENT_NOT_CURRENT_AUTHORIZATION',
    diagnosticOnly: true,
    originalWriterProven: false,
    currentMergeAuthorized: false,
    repository: { owner: repository.owner, name: repository.name },
    branch: finalReceipt.branch ?? null,
    commit: normalizedCommit,
    parent: binding.actualParent,
    changedPaths: binding.actualChangedPaths,
    preImplementationReceipt: preImplementationReceiptSummary,
    notes: [
      'This result only confirms the current actual committed change set, one-parent linkage, preHead, changed paths, and change-set digest still match the supplied final receipt and an actual COMPLETED runner result.',
      'This result does NOT prove who historically authored the commit: mutable saved JSON and Git commit timestamps are not authorship proof by themselves.',
      'This result does NOT authorize a current merge. Current merge authorization is decided exclusively by verifyQualifiedCommitReceipt / verifyFinalReceipt, unmodified, against the current clock.',
    ],
  };
}
