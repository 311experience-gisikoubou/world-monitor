#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runMergeExecutionGate } from './merge-execution-gate.mjs';

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
function flattenPages(value) {
  if (!Array.isArray(value)) return null;
  if (value.every(item => Array.isArray(item))) return value.flat();
  return value;
}
function validExpected(expected) {
  return expected && typeof expected === 'object' && !Array.isArray(expected)
    && typeof expected.baseRef === 'string' && REF_RE.test(expected.baseRef)
    && SHA_RE.test(String(expected.baseSha ?? '').toLowerCase())
    && SHA_RE.test(String(expected.headSha ?? '').toLowerCase());
}
export function validateBatchConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1) {
    throw new Error('BATCH_MERGE_EXECUTION_CONFIG_INVALID');
  }
  if (!AUTHOR_RE.test(config.author ?? '')) {
    throw new Error('BATCH_MERGE_EXECUTION_CONFIG_AUTHOR_INVALID');
  }
  if (!Array.isArray(config.targets) || config.targets.length === 0 || config.targets.length > MAX_TARGETS) {
    throw new Error('BATCH_MERGE_EXECUTION_CONFIG_TARGETS_INVALID');
  }
  const seen = new Set();
  for (const target of config.targets) {
    if (!target || typeof target !== 'object' || !REPO_RE.test(target.repository ?? '')
      || !Number.isSafeInteger(target.pr) || target.pr <= 0 || !validExpected(target.expected)) {
      throw new Error('BATCH_MERGE_EXECUTION_CONFIG_TARGET_INVALID');
    }
    const key = `${target.repository}#${target.pr}`;
    if (seen.has(key)) throw new Error('BATCH_MERGE_EXECUTION_CONFIG_TARGET_DUPLICATE');
    seen.add(key);
  }
}
function collectTargetEvidence(target, { runner, nowMs }) {
  const { repository, pr, expected } = target;
  const basePath = `repos/${repository}`;

  const commentsResult = runJson(runner, [
    'api', '--paginate', '--slurp', `${basePath}/issues/${pr}/comments?per_page=100`,
  ]);
  if (!commentsResult.ok) return { collectionError: commentsResult.code };
  const comments = flattenPages(commentsResult.value);
  if (!Array.isArray(comments)) return { collectionError: 'GITHUB_COMMENTS_INVALID' };

  const prResult = runJson(runner, ['api', `${basePath}/pulls/${pr}`]);
  if (!prResult.ok) return { collectionError: prResult.code };

  const refPath = expected.baseRef.split('/').map(part => encodeURIComponent(part)).join('/');
  const baseResult = runJson(runner, ['api', `${basePath}/git/ref/heads/${refPath}`]);
  if (!baseResult.ok) return { collectionError: baseResult.code };

  const receiptComments = comments
    .filter(comment => typeof comment?.body === 'string'
      && comment.body.startsWith('MERGE_AUTHORIZATION_V1'))
    .map(comment => ({
      id: comment.id,
      body: comment.body,
      created_at: comment.created_at,
      user: { login: comment?.user?.login },
    }));
  const prJson = prResult.value;
  const baseJson = baseResult.value;
  return {
    evidence: {
      schemaVersion: 3,
      repository,
      fetchedAt: new Date(nowMs).toISOString(),
      pr: {
        number: prJson.number,
        state: prJson.state,
        merged_at: prJson.merged_at,
        draft: prJson.draft,
        base: { ref: prJson.base?.ref, sha: prJson.base?.sha },
        head: { sha: prJson.head?.sha },
      },
      liveBase: { ref: baseJson.ref, sha: baseJson.object?.sha },
      authorizationComments: receiptComments,
    },
  };
}

async function evaluateTarget(target, author, { runner, nowMs }) {
  const expected = {
    baseRef: target.expected.baseRef,
    baseSha: target.expected.baseSha.toLowerCase(),
    headSha: target.expected.headSha.toLowerCase(),
  };
  const collected = collectTargetEvidence({ ...target, expected }, { runner, nowMs });
  if (collected.collectionError) {
    return {
      repository: target.repository, pr: target.pr, status: 'STOP',
      blockers: [collected.collectionError], expected,
      gate: null,
    };
  }
  const gate = await runMergeExecutionGate({
    repo: target.repository,
    prNumber: target.pr,
    baseBranch: expected.baseRef,
    expectedBaseSha: expected.baseSha,
    author,
    nowMs,
    evidence: collected.evidence,
  });

  const blockers = [];
  if (!gate.pass) blockers.push(gate.finding || 'MERGE_EXECUTION_GATE_FAILED');
  if (gate.pass && gate.expectedHeadSha !== expected.headSha) {
    blockers.push('AUDITED_HEAD_SHA_MISMATCH');
  }
  if (gate.pass && gate.expectedBaseSha !== expected.baseSha) {
    blockers.push('AUDITED_BASE_SHA_MISMATCH');
  }
  return {
    repository: target.repository,
    pr: target.pr,
    status: blockers.length === 0 ? 'READY_FOR_MERGE_CALL' : 'STOP',
    blockers,
    expected,
    gate: {
      pass: gate.pass,
      finding: gate.finding,
      expectedBaseSha: gate.expectedBaseSha,
      expectedHeadSha: gate.expectedHeadSha,
      authorizationCommentId: gate.authorizationCommentId,
      authorizationSource: gate.authorizationSource,
    },
  };
}
export async function collectBatchMergeExecution(config, {
  nowMs = Date.now(), runner = defaultRunner,
} = {}) {
  validateBatchConfig(config);
  if (!Number.isFinite(nowMs)) throw new Error('BATCH_MERGE_EXECUTION_NOW_INVALID');

  const targets = [];
  for (const target of config.targets) {
    targets.push(await evaluateTarget(target, config.author, { runner, nowMs }));
  }
  const ready = targets.filter(target => target.status === 'READY_FOR_MERGE_CALL').length;
  const stop = targets.length - ready;
  return {
    ok: stop === 0,
    code: stop === 0 ? null : 'BATCH_MERGE_EXECUTION_BLOCKED',
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    overall: stop === 0 ? 'READY_FOR_MERGE_CALLS' : 'STOP',
    mergeAuthorized: stop === 0,
    mutationPerformed: false,
    totals: { targets: targets.length, ready, stop },
    summary: `${targets.length} PRs; ready for merge call ${ready}; stop ${stop}`,
    targets,
  };
}

async function main() {
  try {
    const index = process.argv.indexOf('--collect-config');
    if (index < 0 || !process.argv[index + 1]) {
      throw new Error('BATCH_MERGE_EXECUTION_CONFIG_REQUIRED');
    }
    const config = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
    const output = await collectBatchMergeExecution(config);
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) {
      console.error('BATCH_MERGE_EXECUTION_GATE=FAIL');
      process.exitCode = 2;
      return;
    }
    console.error('BATCH_MERGE_EXECUTION_GATE=PASS');
    for (const target of output.targets) {
      console.error(
        `TARGET=${target.repository}#${target.pr} `
        + `EXPECTED_BASE_SHA=${target.gate.expectedBaseSha} `
        + `EXPECTED_HEAD_SHA=${target.gate.expectedHeadSha}`,
      );
    }
  } catch (error) {
    const output = fail(error?.message || 'BATCH_MERGE_EXECUTION_INTERNAL_ERROR');
    console.log(JSON.stringify(output, null, 2));
    console.error('BATCH_MERGE_EXECUTION_GATE=FAIL');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
