#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { classifyAuthorizationReceipt, parseAuthorizationReceipt } from './merge-execution-gate.mjs';
import { collectBatchMergeExecution } from './cross-repo-merge-execution-gate.mjs';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9._\/-]+$/;
const AUTHOR_RE = /^[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_TARGETS = 20;

function fail(code, detail = {}) { return { ok: false, code, ...detail }; }
function parseJson(text) {
  try { return JSON.parse(String(text ?? '')); } catch { return null; }
}
function defaultRunner(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
}
function runJson(runner, args) {
  const result = runner('gh', args);
  if (result.status !== 0) return { ok: false, code: 'GITHUB_QUERY_FAILED' };
  const value = parseJson(result.stdout);
  return value === null ? { ok: false, code: 'GITHUB_JSON_INVALID' } : { ok: true, value };
}
function runCommand(runner, args) {
  const result = runner('gh', args);
  return { ok: result.status === 0, status: result.status, stderr: String(result.stderr ?? '') };
}
function flattenPages(value) {
  if (!Array.isArray(value)) return null;
  if (value.every(item => Array.isArray(item))) return value.flat();
  return value;
}
function normalizeTarget(target) {
  return {
    repository: target.repository,
    pr: target.pr,
    expected: {
      baseRef: target.expected.baseRef,
      baseSha: target.expected.baseSha.toLowerCase(),
      headSha: target.expected.headSha.toLowerCase(),
      treeSha: target.expected.treeSha.toLowerCase(),
    },
  };
}
function validExpected(expected) {
  return expected && typeof expected === 'object' && !Array.isArray(expected)
    && typeof expected.baseRef === 'string' && REF_RE.test(expected.baseRef)
    && SHA_RE.test(String(expected.baseSha ?? '').toLowerCase())
    && SHA_RE.test(String(expected.headSha ?? '').toLowerCase())
    && SHA_RE.test(String(expected.treeSha ?? '').toLowerCase());
}
export function validateExecutorConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1) {
    throw new Error('BATCH_MERGE_EXECUTOR_CONFIG_INVALID');
  }
  if (!AUTHOR_RE.test(config.author ?? '')) {
    throw new Error('BATCH_MERGE_EXECUTOR_AUTHOR_INVALID');
  }
  if (config.mergeMethod !== 'squash') {
    throw new Error('BATCH_MERGE_EXECUTOR_MERGE_METHOD_UNSUPPORTED');
  }
  if (!Array.isArray(config.targets) || config.targets.length === 0 || config.targets.length > MAX_TARGETS) {
    throw new Error('BATCH_MERGE_EXECUTOR_TARGETS_INVALID');
  }
  const seenKeys = new Set();
  const seenRepos = new Set();
  for (const target of config.targets) {
    if (!target || typeof target !== 'object' || !REPO_RE.test(target.repository ?? '')
      || !Number.isSafeInteger(target.pr) || target.pr <= 0 || !validExpected(target.expected)) {
      throw new Error('BATCH_MERGE_EXECUTOR_TARGET_INVALID');
    }
    const key = `${target.repository}#${target.pr}`;
    if (seenKeys.has(key)) throw new Error('BATCH_MERGE_EXECUTOR_TARGET_DUPLICATE');
    if (seenRepos.has(target.repository)) throw new Error('BATCH_MERGE_EXECUTOR_REPOSITORY_DUPLICATE');
    seenKeys.add(key);
    seenRepos.add(target.repository);
  }
}
function encodeRefPath(ref) {
  return ref.split('/').map(part => encodeURIComponent(part)).join('/');
}
function collectComments(target, runner) {
  const result = runJson(runner, [
    'api', '--paginate', '--slurp',
    `repos/${target.repository}/issues/${target.pr}/comments?per_page=100`,
  ]);
  if (!result.ok) return result;
  const comments = flattenPages(result.value);
  return Array.isArray(comments)
    ? { ok: true, value: comments }
    : { ok: false, code: 'GITHUB_COMMENTS_INVALID' };
}
function verifyMergedTarget(target, prJson, { runner }) {
  const mergeSha = String(prJson?.merge_commit_sha ?? '').toLowerCase();
  const blockers = [];
  if (prJson?.state !== 'closed' || !prJson?.merged_at || !SHA_RE.test(mergeSha)) {
    blockers.push('MERGED_PR_STATE_INVALID');
    return { ok: false, blockers, mergeSha: mergeSha || null };
  }
  const refResult = runJson(runner, [
    'api', `repos/${target.repository}/git/ref/heads/${encodeRefPath(target.expected.baseRef)}`,
  ]);
  const commitResult = runJson(runner, [
    'api', `repos/${target.repository}/git/commits/${mergeSha}`,
  ]);
  if (!refResult.ok) blockers.push(refResult.code);
  if (!commitResult.ok) blockers.push(commitResult.code);
  if (blockers.length) return { ok: false, blockers, mergeSha };
  const liveSha = String(refResult.value?.object?.sha ?? '').toLowerCase();
  const treeSha = String(commitResult.value?.tree?.sha ?? '').toLowerCase();
  const parents = Array.isArray(commitResult.value?.parents) ? commitResult.value.parents : [];
  if (liveSha !== mergeSha) blockers.push('POST_MERGE_MAIN_SHA_MISMATCH');
  if (treeSha !== target.expected.treeSha) blockers.push('POST_MERGE_TREE_MISMATCH');
  if (parents.length !== 1) blockers.push('POST_MERGE_METHOD_MISMATCH');
  if (parents.length === 1 && String(parents[0]?.sha ?? '').toLowerCase() !== target.expected.baseSha) {
    blockers.push('BASE_SHA_DRIFT');
  }
  return {
    ok: blockers.length === 0,
    blockers,
    mergeSha,
    liveSha,
    treeSha,
    parentSha: parents.length === 1 ? String(parents[0]?.sha ?? '').toLowerCase() : null,
  };
}
function findMergedAuthorizationReceipt(comments, { author, prNumber, headSha, mergedAt }) {
  const mergedMs = Date.parse(String(mergedAt ?? ''));
  if (!Number.isFinite(mergedMs)) return { ok: false, code: 'MERGED_AT_INVALID' };
  const matches = comments.map(comment => ({
    comment,
    receipt: parseAuthorizationReceipt(comment?.body),
  })).filter(item => item.receipt
    && item.comment?.user?.login === author
    && item.receipt.prNumber === prNumber
    && item.receipt.headSha === headSha);
  const beforeMerge = matches.filter(item => {
    const createdMs = Date.parse(String(item.comment?.created_at ?? ''));
    return Number.isFinite(createdMs) && createdMs <= mergedMs;
  }).sort((a, b) => Date.parse(b.comment.created_at) - Date.parse(a.comment.created_at));
  return beforeMerge.length
    ? { ok: true, code: 'AUTHORIZATION_RECEIPT_VALID', item: beforeMerge[0] }
    : { ok: false, code: 'AUTHORIZATION_RECEIPT_REQUIRED_BEFORE_MERGE' };
}

function preflightTarget(rawTarget, author, { runner, nowMs }) {
  const target = normalizeTarget(rawTarget);
  const commentsResult = collectComments(target, runner);
  if (!commentsResult.ok) {
    return { repository: target.repository, pr: target.pr, status: 'STOP', blockers: [commentsResult.code], expected: target.expected };
  }
  const prResult = runJson(runner, ['api', `repos/${target.repository}/pulls/${target.pr}`]);
  if (!prResult.ok) {
    return { repository: target.repository, pr: target.pr, status: 'STOP', blockers: [prResult.code], expected: target.expected };
  }
  const prJson = prResult.value;
  if (prJson?.merged_at || prJson?.state === 'closed') {
    const verified = verifyMergedTarget(target, prJson, { runner });
    const receipt = findMergedAuthorizationReceipt(commentsResult.value, {
      author,
      prNumber: target.pr,
      headSha: target.expected.headSha,
      mergedAt: prJson?.merged_at,
    });
    const blockers = [...verified.blockers];
    if (String(prJson?.head?.sha ?? '').toLowerCase() !== target.expected.headSha) {
      blockers.push('AUDITED_HEAD_SHA_MISMATCH');
    }
    if (!receipt.ok) blockers.push(receipt.code);
    return {
      repository: target.repository,
      pr: target.pr,
      status: blockers.length === 0 ? 'ALREADY_MERGED_VERIFIED' : 'STOP',
      blockers,
      expected: target.expected,
      initialDraft: false,
      merge: verified,
      authorizationCommentId: receipt.ok ? receipt.item.comment.id : null,
      authorizationSource: receipt.ok ? receipt.item.receipt.source : null,
    };
  }

  const refResult = runJson(runner, [
    'api', `repos/${target.repository}/git/ref/heads/${encodeRefPath(target.expected.baseRef)}`,
  ]);
  if (!refResult.ok) {
    return { repository: target.repository, pr: target.pr, status: 'STOP', blockers: [refResult.code], expected: target.expected };
  }

  const actualHead = String(prJson?.head?.sha ?? '').toLowerCase();
  const liveBase = String(refResult.value?.object?.sha ?? '').toLowerCase();
  const receipt = classifyAuthorizationReceipt(commentsResult.value, {
    author,
    prNumber: target.pr,
    headSha: target.expected.headSha,
    nowMs,
  });
  const blockers = [];
  if (prJson?.state !== 'open' || prJson?.merged_at) blockers.push('PR_NOT_OPEN');
  if (prJson?.base?.ref !== target.expected.baseRef) blockers.push('BASE_BRANCH_MISMATCH');
  if (refResult.value?.ref !== `refs/heads/${target.expected.baseRef}`) blockers.push('LIVE_BASE_REF_MISMATCH');
  if (liveBase !== target.expected.baseSha) blockers.push('BASE_SHA_MISMATCH');
  if (actualHead !== target.expected.headSha) blockers.push('AUDITED_HEAD_SHA_MISMATCH');
  if (receipt.code !== 'AUTHORIZATION_RECEIPT_VALID') blockers.push(receipt.code);

  return {
    repository: target.repository,
    pr: target.pr,
    status: blockers.length === 0 ? 'READY_TO_EXECUTE' : 'STOP',
    blockers,
    expected: target.expected,
    initialDraft: prJson?.draft === true,
    observedHeadSha: actualHead || null,
    observedBaseSha: liveBase || null,
    authorizationCommentId: receipt.code === 'AUTHORIZATION_RECEIPT_VALID' ? receipt.item.comment.id : null,
    authorizationSource: receipt.code === 'AUTHORIZATION_RECEIPT_VALID' ? receipt.item.receipt.source : null,
  };
}
export function planAuthorizedCrossRepoMerge(config, {
  nowMs = Date.now(), runner = defaultRunner,
} = {}) {
  validateExecutorConfig(config);
  if (!Number.isFinite(nowMs)) throw new Error('BATCH_MERGE_EXECUTOR_NOW_INVALID');
  const targets = config.targets.map(target => preflightTarget(target, config.author, { runner, nowMs }));
  const ready = targets.filter(target => target.status === 'READY_TO_EXECUTE').length;
  const alreadyMerged = targets.filter(target => target.status === 'ALREADY_MERGED_VERIFIED').length;
  const stop = targets.length - ready - alreadyMerged;
  return {
    ok: stop === 0,
    code: stop === 0 ? null : 'BATCH_MERGE_EXECUTOR_PREFLIGHT_BLOCKED',
    schemaVersion: 1,
    mode: 'plan',
    generatedAt: new Date(nowMs).toISOString(),
    overall: stop === 0 ? 'PLAN_READY' : 'STOP',
    mutationPerformed: false,
    totals: { targets: targets.length, ready, alreadyMerged, stop },
    targets,
  };
}
function markReady(target, runner) {
  return runCommand(runner, ['pr', 'ready', String(target.pr), '--repo', target.repository]);
}
function restoreDraft(target, runner) {
  return runCommand(runner, ['pr', 'ready', String(target.pr), '--undo', '--repo', target.repository]);
}
function rollbackChangedReady(changedReady, mergedKeys, runner) {
  const restored = [];
  const failures = [];
  for (const target of [...changedReady].reverse()) {
    const key = `${target.repository}#${target.pr}`;
    if (mergedKeys.has(key)) continue;
    const result = restoreDraft(target, runner);
    if (result.ok) restored.push(key);
    else failures.push(key);
  }
  return { ok: failures.length === 0, restored, failures };
}
function mergeTarget(target, runner) {
  return runJson(runner, [
    'api', '-X', 'PUT',
    `repos/${target.repository}/pulls/${target.pr}/merge`,
    '-f', 'merge_method=squash',
    '-f', `sha=${target.expected.headSha}`,
  ]);
}
function fetchPr(target, runner) {
  return runJson(runner, ['api', `repos/${target.repository}/pulls/${target.pr}`]);
}

export async function executeAuthorizedCrossRepoMerge(config, {
  nowMs = Date.now(), runner = defaultRunner,
} = {}) {
  const plan = planAuthorizedCrossRepoMerge(config, { nowMs, runner });
  if (!plan.ok) return { ...plan, mode: 'execute', overall: 'STOP' };

  const normalized = config.targets.map(normalizeTarget);
  const byKey = new Map(normalized.map(target => [`${target.repository}#${target.pr}`, target]));
  const openTargets = plan.targets
    .filter(target => target.status === 'READY_TO_EXECUTE')
    .map(target => byKey.get(`${target.repository}#${target.pr}`));
  const alreadyMerged = plan.targets.filter(target => target.status === 'ALREADY_MERGED_VERIFIED');
  const changedReady = [];
  const mergedKeys = new Set(alreadyMerged.map(target => `${target.repository}#${target.pr}`));
  const merged = alreadyMerged.map(target => ({
    repository: target.repository, pr: target.pr,
    status: 'ALREADY_MERGED_VERIFIED', merge: target.merge,
  }));

  for (const target of openTargets) {
    const planTarget = plan.targets.find(item => item.repository === target.repository && item.pr === target.pr);
    if (!planTarget.initialDraft) continue;
    const readyResult = markReady(target, runner);
    if (!readyResult.ok) {
      const rollback = rollbackChangedReady(changedReady, mergedKeys, runner);
      return fail('READY_MUTATION_FAILED', {
        schemaVersion: 1, mode: 'execute', overall: 'STOP',
        mutationPerformed: changedReady.length > 0,
        failedTarget: `${target.repository}#${target.pr}`,
        merged, rollback, plan,
      });
    }
    changedReady.push(target);
  }

  if (openTargets.length > 0) {
    const gateConfig = {
      schemaVersion: 1,
      author: config.author,
      targets: openTargets.map(target => ({
        repository: target.repository,
        pr: target.pr,
        expected: {
          baseRef: target.expected.baseRef,
          baseSha: target.expected.baseSha,
          headSha: target.expected.headSha,
        },
      })),
    };
    const gate = await collectBatchMergeExecution(gateConfig, { nowMs, runner });
    if (!gate.ok) {
      const rollback = rollbackChangedReady(changedReady, mergedKeys, runner);
      return fail('BATCH_MERGE_EXECUTION_GATE_FAILED', {
        schemaVersion: 1, mode: 'execute', overall: 'STOP',
        mutationPerformed: changedReady.length > 0,
        merged, rollback, gate, plan,
      });
    }
  }
  for (const target of openTargets) {
    const key = `${target.repository}#${target.pr}`;
    const mergeResult = mergeTarget(target, runner);
    const mergeSha = String(mergeResult.value?.sha ?? '').toLowerCase();
    if (!mergeResult.ok || mergeResult.value?.merged !== true || !SHA_RE.test(mergeSha)) {
      const rollback = rollbackChangedReady(changedReady, mergedKeys, runner);
      return fail('MERGE_CALL_FAILED', {
        schemaVersion: 1, mode: 'execute', overall: 'STOP',
        mutationPerformed: true, failedTarget: key,
        merged, rollback, plan,
      });
    }

    const prResult = fetchPr(target, runner);
    if (!prResult.ok) {
      mergedKeys.add(key);
      const rollback = rollbackChangedReady(changedReady, mergedKeys, runner);
      return fail('POST_MERGE_QUERY_FAILED', {
        schemaVersion: 1, mode: 'execute', overall: 'STOP',
        mutationPerformed: true, failedTarget: key,
        mergeSha, merged, rollback, plan,
      });
    }
    const verified = verifyMergedTarget(target, prResult.value, { runner });
    mergedKeys.add(key);
    if (!verified.ok || verified.mergeSha !== mergeSha) {
      const rollback = rollbackChangedReady(changedReady, mergedKeys, runner);
      return fail('POST_MERGE_VERIFICATION_FAILED', {
        schemaVersion: 1, mode: 'execute', overall: 'STOP',
        mutationPerformed: true, failedTarget: key,
        mergeSha, verification: verified, merged, rollback, plan,
      });
    }
    merged.push({
      repository: target.repository,
      pr: target.pr,
      status: 'MERGED_VERIFIED',
      merge: verified,
    });
  }

  return {
    ok: true,
    code: null,
    schemaVersion: 1,
    mode: 'execute',
    overall: 'MERGED_AND_VERIFIED',
    mutationPerformed: openTargets.length > 0,
    totals: {
      targets: normalized.length,
      mergedOrVerified: merged.length,
      newlyMerged: merged.filter(item => item.status === 'MERGED_VERIFIED').length,
      alreadyMerged: merged.filter(item => item.status === 'ALREADY_MERGED_VERIFIED').length,
      stop: 0,
    },
    merged,
    rollback: { ok: true, restored: [], failures: [] },
    plan,
  };
}

async function main() {
  try {
    const configIndex = process.argv.indexOf('--config');
    if (configIndex < 0 || !process.argv[configIndex + 1]) {
      throw new Error('BATCH_MERGE_EXECUTOR_CONFIG_REQUIRED');
    }
    const execute = process.argv.includes('--execute');
    const config = JSON.parse(await readFile(process.argv[configIndex + 1], 'utf8'));
    const output = execute
      ? await executeAuthorizedCrossRepoMerge(config)
      : planAuthorizedCrossRepoMerge(config);
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) {
      console.error('CROSS_REPO_MERGE_EXECUTOR=STOP');
      process.exitCode = 2;
      return;
    }
    console.error(`CROSS_REPO_MERGE_EXECUTOR=${execute ? 'MERGED_AND_VERIFIED' : 'PLAN_READY'}`);
  } catch (error) {
    const output = fail(error?.message || 'BATCH_MERGE_EXECUTOR_INTERNAL_ERROR');
    console.log(JSON.stringify(output, null, 2));
    console.error('CROSS_REPO_MERGE_EXECUTOR=STOP');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
