#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_TARGETS = 20;
const ALLOWED_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function fail(code, detail = {}) { return { ok: false, code, ...detail }; }
function parseJson(text) { try { return JSON.parse(String(text ?? '')); } catch { return null; } }
function defaultRunner(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}
function normalizeFiles(files) {
  return [...new Set(files.map(value => String(value).replaceAll('\\', '/'))) ].sort();
}
function sameArray(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function isoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
function validExpected(expected) {
  return expected && typeof expected === 'object' && !Array.isArray(expected)
    && typeof expected.baseRef === 'string' && expected.baseRef.length > 0
    && SHA_RE.test(expected.baseSha ?? '') && SHA_RE.test(expected.headSha ?? '')
    && typeof expected.draft === 'boolean'
    && Array.isArray(expected.changedFiles) && expected.changedFiles.length > 0
    && expected.changedFiles.every(path => typeof path === 'string' && path.length > 0);
}
function validateManifest(manifest, nowMs) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1) return 'MERGE_READINESS_MANIFEST_INVALID';
  const fetchedMs = isoMs(manifest.fetchedAt);
  if (fetchedMs === null) return 'MERGE_READINESS_FETCH_TIME_INVALID';
  if (fetchedMs > nowMs) return 'MERGE_READINESS_EVIDENCE_FROM_FUTURE';
  if (nowMs - fetchedMs > MAX_AGE_MS) return 'MERGE_READINESS_EVIDENCE_STALE';
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0 || manifest.targets.length > MAX_TARGETS) return 'MERGE_READINESS_TARGETS_INVALID';
  const seen = new Set();
  for (const target of manifest.targets) {
    if (!target || typeof target !== 'object' || !REPO_RE.test(target.repository ?? '') || !Number.isSafeInteger(target.pr) || target.pr <= 0 || !validExpected(target.expected)) return 'MERGE_READINESS_TARGET_INVALID';
    const key = `${target.repository}#${target.pr}`;
    if (seen.has(key)) return 'MERGE_READINESS_TARGET_DUPLICATE';
    seen.add(key);
    const expectedFiles = normalizeFiles(target.expected.changedFiles);
    if (expectedFiles.length !== target.expected.changedFiles.length) return 'MERGE_READINESS_EXPECTED_FILES_DUPLICATE';
  }
  return null;
}

function evaluateTarget(target) {
  const blockers = [];
  if (target.collectionError) blockers.push(target.collectionError);
  const pr = target.prInfo;
  const liveBase = target.liveBase;
  const complete = target.queryComplete;
  if (!pr || !liveBase || !complete) blockers.push('MERGE_READINESS_EVIDENCE_MISSING');
  else {
    if (pr.state !== 'open') blockers.push('PR_NOT_OPEN');
    if (pr.draft !== target.expected.draft) blockers.push('PR_DRAFT_STATE_MISMATCH');
    if (pr.baseRef !== target.expected.baseRef) blockers.push('BASE_REF_MISMATCH');
    if (pr.baseSha !== target.expected.baseSha) blockers.push('PR_BASE_SHA_MISMATCH');
    if (pr.headSha !== target.expected.headSha) blockers.push('HEAD_SHA_MISMATCH');
    if (pr.mergeable !== true) blockers.push(pr.mergeable === false ? 'PR_NOT_MERGEABLE' : 'PR_MERGEABILITY_UNKNOWN');
    if (liveBase.ref !== target.expected.baseRef) blockers.push('LIVE_BASE_REF_MISMATCH');
    if (liveBase.sha !== target.expected.baseSha) blockers.push('LIVE_BASE_SHA_MISMATCH');
    if (!Object.values(complete).every(value => value === true)) blockers.push('QUERY_INCOMPLETE');
  }
  const actualFiles = normalizeFiles(Array.isArray(target.changedFiles) ? target.changedFiles : []);
  const expectedFiles = normalizeFiles(target.expected.changedFiles);
  if (!sameArray(actualFiles, expectedFiles)) blockers.push('CHANGED_FILES_MISMATCH');
  if ((target.workflows ?? []).some(run => run.status !== 'completed' || !ALLOWED_CONCLUSIONS.has(run.conclusion))) blockers.push('WORKFLOW_BLOCKER');
  if ((target.reviews ?? []).some(review => String(review.state ?? '').toUpperCase() === 'CHANGES_REQUESTED')) blockers.push('REVIEW_BLOCKER');
  if ((target.reviewThreads ?? []).some(thread => thread.isResolved !== true)) blockers.push('REVIEW_THREAD_BLOCKER');
  const uniqueBlockers = [...new Set(blockers)];
  return {
    repository: target.repository,
    pr: target.pr,
    status: uniqueBlockers.length === 0 ? 'READY_FOR_FINAL_AUDIT' : 'STOP',
    blockers: uniqueBlockers,
    expected: { ...target.expected, changedFiles: expectedFiles },
    observed: {
      prInfo: pr ?? null,
      liveBase: liveBase ?? null,
      changedFiles: actualFiles,
      workflowRuns: (target.workflows ?? []).length,
      reviews: (target.reviews ?? []).length,
      reviewThreads: (target.reviewThreads ?? []).length,
    },
  };
}

export function buildMergeReadinessReport(manifest, { nowMs = Date.now() } = {}) {
  const validationError = validateManifest(manifest, nowMs);
  if (validationError) return fail(validationError);
  const targets = manifest.targets.map(evaluateTarget);
  const ready = targets.filter(target => target.status === 'READY_FOR_FINAL_AUDIT').length;
  const stop = targets.length - ready;
  return {
    ok: stop === 0,
    code: stop === 0 ? null : 'MERGE_READINESS_BLOCKED',
    schemaVersion: 1,
    fetchedAt: manifest.fetchedAt,
    generatedAt: new Date(nowMs).toISOString(),
    overall: stop === 0 ? 'READY_FOR_FINAL_AUDIT' : 'STOP',
    mergeAuthorized: false,
    finalAuditRequired: true,
    totals: { targets: targets.length, ready, stop },
    summary: `${targets.length} PRs; ready for final audit ${ready}; stop ${stop}`,
    targets,
  };
}
function flattenPages(value) {
  if (!Array.isArray(value)) return null;
  if (value.every(item => Array.isArray(item))) return value.flat();
  return value;
}
function runJson(runner, args) {
  const result = runner('gh', args);
  if (result.status !== 0) return { ok: false, code: 'GITHUB_QUERY_FAILED' };
  const value = parseJson(result.stdout);
  return value === null ? { ok: false, code: 'GITHUB_JSON_INVALID' } : { ok: true, value };
}
function splitRepo(repository) {
  const [owner, name] = repository.split('/');
  return { owner, name };
}
function threadsQuery() {
  return `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}`;
}

function collectTarget(target, { runner }) {
  const { repository, pr, expected } = target;
  const basePath = `repos/${repository}`;
  const prResult = runJson(runner, ['api', `${basePath}/pulls/${pr}`]);
  if (!prResult.ok) return { repository, pr, expected, collectionError: prResult.code };
  const prJson = prResult.value;
  const filesResult = runJson(runner, ['api', '--paginate', '--slurp', `${basePath}/pulls/${pr}/files?per_page=100`]);
  const reviewsResult = runJson(runner, ['api', '--paginate', '--slurp', `${basePath}/pulls/${pr}/reviews?per_page=100`]);
  const workflowResult = runJson(runner, ['api', `${basePath}/actions/runs?head_sha=${expected.headSha}&event=pull_request&per_page=100`]);
  const branchResult = runJson(runner, ['api', `${basePath}/branches/${encodeURIComponent(expected.baseRef)}`]);
  const { owner, name } = splitRepo(repository);
  const threadResult = runJson(runner, ['api', 'graphql', '-f', `query=${threadsQuery()}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]);
  for (const item of [filesResult, reviewsResult, workflowResult, branchResult, threadResult]) {
    if (!item.ok) return { repository, pr, expected, collectionError: item.code };
  }
  const files = flattenPages(filesResult.value);
  const reviews = flattenPages(reviewsResult.value);
  const workflowRuns = workflowResult.value?.workflow_runs;
  const threadNode = threadResult.value?.data?.repository?.pullRequest?.reviewThreads;
  const queryComplete = {
    files: Array.isArray(files) && Number.isSafeInteger(prJson.changed_files) && files.length === prJson.changed_files,
    workflows: Array.isArray(workflowRuns) && Number.isSafeInteger(workflowResult.value?.total_count) && workflowRuns.length === workflowResult.value.total_count,
    reviews: Array.isArray(reviews),
    threads: Array.isArray(threadNode?.nodes) && threadNode?.pageInfo?.hasNextPage === false,
  };
  return {
    repository,
    pr,
    expected,
    prInfo: {
      state: String(prJson.state ?? '').toLowerCase(),
      draft: prJson.draft === true,
      mergeable: typeof prJson.mergeable === 'boolean' ? prJson.mergeable : null,
      baseRef: prJson.base?.ref ?? null,
      baseSha: String(prJson.base?.sha ?? '').toLowerCase() || null,
      headSha: String(prJson.head?.sha ?? '').toLowerCase() || null,
    },
    liveBase: { ref: branchResult.value?.name ?? null, sha: String(branchResult.value?.commit?.sha ?? '').toLowerCase() || null },
    changedFiles: Array.isArray(files) ? files.map(file => file.filename) : [],
    workflows: Array.isArray(workflowRuns) ? workflowRuns.map(run => ({ status: run.status, conclusion: run.conclusion })) : [],
    reviews: Array.isArray(reviews) ? reviews.map(review => ({ state: review.state })) : [],
    reviewThreads: Array.isArray(threadNode?.nodes) ? threadNode.nodes.map(thread => ({ isResolved: thread.isResolved === true })) : [],
    queryComplete,
  };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1) throw new Error('MERGE_READINESS_CONFIG_INVALID');
  if (!Array.isArray(config.targets) || config.targets.length === 0 || config.targets.length > MAX_TARGETS) throw new Error('MERGE_READINESS_CONFIG_TARGETS_INVALID');
  const probe = { schemaVersion: 1, fetchedAt: new Date().toISOString(), targets: config.targets.map(target => ({ ...target, prInfo: {}, liveBase: {}, queryComplete: {} })) };
  const error = validateManifest(probe, Date.now());
  if (error) throw new Error(error.replace('MERGE_READINESS_', 'MERGE_READINESS_CONFIG_'));
}
export function collectMergeReadiness(config, { nowMs = Date.now(), runner = defaultRunner } = {}) {
  validateConfig(config);
  const fetchedAt = new Date(nowMs).toISOString();
  const targets = config.targets.map(target => collectTarget({ ...target, expected: { ...target.expected, changedFiles: normalizeFiles(target.expected.changedFiles) } }, { runner }));
  return buildMergeReadinessReport({ schemaVersion: 1, fetchedAt, targets }, { nowMs });
}

async function main() {
  try {
    const manifestIndex = process.argv.indexOf('--manifest');
    const collectIndex = process.argv.indexOf('--collect-config');
    if (manifestIndex >= 0 && collectIndex >= 0) throw new Error('MERGE_READINESS_MODE_CONFLICT');
    let output;
    if (manifestIndex >= 0) {
      if (!process.argv[manifestIndex + 1]) throw new Error('MERGE_READINESS_MANIFEST_REQUIRED');
      output = buildMergeReadinessReport(JSON.parse(await readFile(process.argv[manifestIndex + 1], 'utf8')));
    } else if (collectIndex >= 0) {
      if (!process.argv[collectIndex + 1]) throw new Error('MERGE_READINESS_CONFIG_REQUIRED');
      const config = JSON.parse(await readFile(process.argv[collectIndex + 1], 'utf8'));
      output = collectMergeReadiness(config);
    } else throw new Error('MERGE_READINESS_MODE_REQUIRED');
    console.log(JSON.stringify(output, null, 2));
    console.error(`CROSS_REPO_MERGE_READINESS=${output.overall ?? 'STOP'}`);
    if (!output.ok) process.exitCode = 2;
  } catch (error) {
    const output = fail(error?.message || 'MERGE_READINESS_INTERNAL_ERROR');
    console.log(JSON.stringify(output, null, 2));
    console.error('CROSS_REPO_MERGE_READINESS=STOP');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
