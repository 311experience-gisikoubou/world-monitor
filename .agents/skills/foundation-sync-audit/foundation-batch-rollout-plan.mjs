#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { isManagedTargetPath } from './managed-surface.mjs';

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const singlePlanner = join(here, 'foundation-remote-update-plan.mjs');

function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function stop(code, detail = {}) {
  console.log(JSON.stringify({ result: 'STOP', code, ...detail }));
  process.exit(2);
}
function isSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }
function gitBlobSha(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}
function normalizePath(value) {
  if (typeof value !== 'string') return '';
  const p = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.includes('/../') || p.startsWith('../') || p.endsWith('/..') || p.includes('//')) return '';
  return p;
}
function isCanonicalPath(path) {
  return isManagedTargetPath(path);
}
function normalizeBranch(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^refs\/heads\//, '');
}
function isRepository(value) { return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value); }
function isBaselineId(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value); }
function parseSinglePlannerOutput(run, repository) {
  let parsed;
  try { parsed = JSON.parse(run.stdout || '{}'); }
  catch {
    stop('FOUNDATION_BATCH_SINGLE_PLAN_INVALID_OUTPUT', { repository, exitCode: run.status, stderr: (run.stderr || '').trim() || null });
  }
  if (run.status !== 0 || parsed?.result !== 'PASS') {
    stop('FOUNDATION_BATCH_SINGLE_PLAN_STOP', { repository, singlePlan: parsed ?? null, exitCode: run.status });
  }
  return parsed;
}

let raw = argValue('--manifest-json');
const manifestPath = argValue('--manifest');
if (raw && manifestPath) stop('FOUNDATION_BATCH_INPUT_AMBIGUOUS');
if (!raw && manifestPath) {
  try { raw = await readFile(manifestPath, 'utf8'); }
  catch (error) { stop('FOUNDATION_BATCH_MANIFEST_READ_FAILED', { message: String(error?.message || error) }); }
}
if (!raw && !process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  raw = Buffer.concat(chunks).toString('utf8');
}
if (!raw) stop('FOUNDATION_BATCH_MANIFEST_REQUIRED');

let manifest;
try { manifest = JSON.parse(raw); }
catch { stop('FOUNDATION_BATCH_MANIFEST_INVALID_JSON'); }

const { schemaVersion, release, targets } = manifest ?? {};
if (![1, 2].includes(schemaVersion)) stop('FOUNDATION_BATCH_SCHEMA_UNSUPPORTED', { schemaVersion: schemaVersion ?? null });
if (!Array.isArray(targets) || targets.length === 0) stop('FOUNDATION_BATCH_TARGETS_REQUIRED');
if (targets.length > 100) stop('FOUNDATION_BATCH_TARGETS_TOO_MANY', { count: targets.length });

function parseReleaseEntries(entries, context = {}) {
  if (!Array.isArray(entries) || entries.length === 0) stop('FOUNDATION_BATCH_RELEASE_ENTRIES_REQUIRED', context);
  if (entries.length > 1000) stop('FOUNDATION_BATCH_RELEASE_ENTRIES_TOO_MANY', { ...context, count: entries.length });
  const releasePaths = new Set();
  return entries.map((entry) => {
    const path = normalizePath(entry?.path);
    if (!path || !isCanonicalPath(path) || path === 'AGENTS.local.md') stop('FOUNDATION_BATCH_PATH_OUTSIDE_SHARED_SURFACE', { ...context, path: entry?.path ?? null });
    if (releasePaths.has(path)) stop('FOUNDATION_BATCH_DUPLICATE_RELEASE_PATH', { ...context, path });
    releasePaths.add(path);
    const oldSha = entry?.oldSha ?? null;
    const newSha = entry?.newSha ?? null;
    for (const [field, value] of [['oldSha', oldSha], ['newSha', newSha]]) {
      if (value !== null && !isSha(value)) stop('FOUNDATION_BATCH_RELEASE_SHA_INVALID', { ...context, path, field });
    }
    if (oldSha === null && newSha === null) stop('FOUNDATION_BATCH_EMPTY_RELEASE_ENTRY', { ...context, path });
    if (oldSha === newSha) stop('FOUNDATION_BATCH_UNCHANGED_RELEASE_ENTRY', { ...context, path });
    const hasNewContent = Object.prototype.hasOwnProperty.call(entry ?? {}, 'newContent');
    if (hasNewContent) {
      if (newSha === null || typeof entry.newContent !== 'string') stop('FOUNDATION_BATCH_SOURCE_CONTENT_INVALID', { ...context, path });
      const calculatedSha = gitBlobSha(entry.newContent);
      if (calculatedSha !== newSha) stop('FOUNDATION_BATCH_SOURCE_CONTENT_SHA_MISMATCH', { ...context, path, expectedNewSha: newSha, calculatedSha });
    }
    return { path, oldSha, newSha, ...(hasNewContent ? { newContent: entry.newContent } : {}) };
  });
}

let sourceVersion = null;
let sourceCommit = null;
const baselineMap = new Map();

if (schemaVersion === 1) {
  const { fromVersion, sourceVersion: v1SourceVersion, fromCommit, sourceCommit: v1SourceCommit, entries } = release ?? {};
  if (typeof fromVersion !== 'string' || !fromVersion.trim()) stop('FOUNDATION_BATCH_FROM_VERSION_REQUIRED');
  if (typeof v1SourceVersion !== 'string' || !v1SourceVersion.trim()) stop('FOUNDATION_BATCH_SOURCE_VERSION_REQUIRED');
  if (fromVersion === v1SourceVersion) stop('FOUNDATION_BATCH_VERSION_NOT_ADVANCED', { version: v1SourceVersion });
  if (!isSha(fromCommit)) stop('FOUNDATION_BATCH_FROM_COMMIT_INVALID');
  if (!isSha(v1SourceCommit)) stop('FOUNDATION_BATCH_SOURCE_COMMIT_INVALID');
  if (fromCommit === v1SourceCommit) stop('FOUNDATION_BATCH_SOURCE_COMMIT_NOT_ADVANCED');
  sourceVersion = v1SourceVersion;
  sourceCommit = v1SourceCommit;
  baselineMap.set('default', { id: 'default', fromVersion, fromCommit, entries: parseReleaseEntries(entries) });
} else {
  const baselines = release?.baselines;
  sourceVersion = release?.sourceVersion;
  sourceCommit = release?.sourceCommit;
  if (typeof sourceVersion !== 'string' || !sourceVersion.trim()) stop('FOUNDATION_BATCH_SOURCE_VERSION_REQUIRED');
  if (!isSha(sourceCommit)) stop('FOUNDATION_BATCH_SOURCE_COMMIT_INVALID');
  if (!Array.isArray(baselines) || baselines.length === 0) stop('FOUNDATION_BATCH_BASELINES_REQUIRED');
  if (baselines.length > 100) stop('FOUNDATION_BATCH_BASELINES_TOO_MANY', { count: baselines.length });
  const finalShas = new Map();
  for (const baseline of baselines) {
    const id = baseline?.id;
    const fromVersion = baseline?.fromVersion;
    const fromCommit = baseline?.fromCommit;
    if (!isBaselineId(id)) stop('FOUNDATION_BATCH_BASELINE_ID_INVALID', { baselineId: id ?? null });
    if (baselineMap.has(id)) stop('FOUNDATION_BATCH_DUPLICATE_BASELINE_ID', { baselineId: id });
    if (typeof fromVersion !== 'string' || !fromVersion.trim()) stop('FOUNDATION_BATCH_FROM_VERSION_REQUIRED', { baselineId: id });
    if (fromVersion === sourceVersion) stop('FOUNDATION_BATCH_VERSION_NOT_ADVANCED', { baselineId: id, version: sourceVersion });
    if (!isSha(fromCommit)) stop('FOUNDATION_BATCH_FROM_COMMIT_INVALID', { baselineId: id });
    if (fromCommit === sourceCommit) stop('FOUNDATION_BATCH_SOURCE_COMMIT_NOT_ADVANCED', { baselineId: id });
    const entries = parseReleaseEntries(baseline?.entries, { baselineId: id });
    for (const entry of entries) {
      if (finalShas.has(entry.path) && finalShas.get(entry.path) !== entry.newSha) {
        stop('FOUNDATION_BATCH_BASELINE_SOURCE_MISMATCH', { baselineId: id, path: entry.path, expectedNewSha: finalShas.get(entry.path), newSha: entry.newSha });
      }
      finalShas.set(entry.path, entry.newSha);
    }
    baselineMap.set(id, { id, fromVersion, fromCommit, entries });
  }
}

const seenTargets = new Set();
const plannedTargets = [];
let currentCount = 0;
let updateCount = 0;
let partialCount = 0;
let branchRequiredCount = 0;
let readyPlanCount = 0;

for (const target of targets) {
  const repository = target?.repository;
  const branch = normalizeBranch(target?.branch);
  const head = target?.head;
  const baseTree = target?.baseTree;
  const targetShas = target?.targetShas;
  if (!isRepository(repository)) stop('FOUNDATION_BATCH_TARGET_REPOSITORY_INVALID', { repository: repository ?? null });
  if (!branch) stop('FOUNDATION_BATCH_TARGET_BRANCH_REQUIRED', { repository });
  if (!isSha(head)) stop('FOUNDATION_BATCH_TARGET_HEAD_INVALID', { repository });
  if (!isSha(baseTree)) stop('FOUNDATION_BATCH_TARGET_BASE_TREE_INVALID', { repository });
  if (!targetShas || typeof targetShas !== 'object' || Array.isArray(targetShas)) stop('FOUNDATION_BATCH_TARGET_SHAS_REQUIRED', { repository });
  const targetKey = repository;
  if (seenTargets.has(targetKey)) stop('FOUNDATION_BATCH_DUPLICATE_TARGET', { repository, branch });
  seenTargets.add(targetKey);

  let baseline;
  let baselineOutput = {};
  if (schemaVersion === 1) {
    baseline = baselineMap.get('default');
  } else {
    const baselineId = target?.baselineId;
    if (!isBaselineId(baselineId)) stop('FOUNDATION_BATCH_TARGET_BASELINE_REQUIRED', { repository, baselineId: baselineId ?? null });
    baseline = baselineMap.get(baselineId);
    if (!baseline) stop('FOUNDATION_BATCH_TARGET_BASELINE_UNKNOWN', { repository, baselineId });
    baselineOutput = { baseline: { id: baseline.id, fromVersion: baseline.fromVersion, fromCommit: baseline.fromCommit } };
  }
  const { fromVersion, fromCommit, entries: releaseEntries } = baseline;

  const pendingEntries = [];
  const currentPaths = [];
  for (const entry of releaseEntries) {
    if (!Object.prototype.hasOwnProperty.call(targetShas, entry.path)) stop('FOUNDATION_BATCH_TARGET_PATH_EVIDENCE_MISSING', { repository, path: entry.path });
    const targetSha = targetShas[entry.path];
    if (targetSha !== null && !isSha(targetSha)) stop('FOUNDATION_BATCH_TARGET_SHA_INVALID', { repository, path: entry.path });
    if (targetSha === entry.newSha) {
      currentPaths.push(entry.path);
      continue;
    }
    if (targetSha === entry.oldSha) {
      pendingEntries.push({ ...entry, targetSha });
      continue;
    }
    stop('FOUNDATION_BATCH_TARGET_DRIFT', {
      repository, branch, path: entry.path, expectedOldSha: entry.oldSha, expectedNewSha: entry.newSha, targetSha,
    });
  }

  if (pendingEntries.length === 0) {
    currentCount += 1;
    plannedTargets.push({
      repository, branch, head, baseTree, ...baselineOutput, state: 'CURRENT', action: 'NONE',
      counts: { releaseEntries: releaseEntries.length, current: currentPaths.length, pending: 0 },
    });
    continue;
  }

  const partial = currentPaths.length > 0;
  if (partial) partialCount += 1;
  else updateCount += 1;
  const state = partial ? 'PARTIAL_RESUME' : 'UPDATE';
  const protectedBranch = branch === 'main' || branch === 'master';
  if (protectedBranch) {
    branchRequiredCount += 1;
    plannedTargets.push({
      repository, branch, head, baseTree, ...baselineOutput, state, action: 'CREATE_FEATURE_BRANCH', branchFromSha: head,
      counts: { releaseEntries: releaseEntries.length, current: currentPaths.length, pending: pendingEntries.length },
      pendingPaths: pendingEntries.map((entry) => entry.path),
    });
    continue;
  }

  const singleManifest = {
    fromVersion, sourceVersion, fromCommit, sourceCommit,
    targetRepository: repository, targetBranch: branch, targetHead: head, targetBaseTree: baseTree,
    entries: pendingEntries,
  };
  const run = spawnSync(process.execPath, [singlePlanner], {
    input: JSON.stringify(singleManifest), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (run.error) stop('FOUNDATION_BATCH_SINGLE_PLAN_EXEC_FAILED', { repository, message: String(run.error?.message || run.error) });
  const remotePlan = parseSinglePlannerOutput(run, repository);
  readyPlanCount += 1;
  plannedTargets.push({
    repository, branch, head, baseTree, ...baselineOutput, state, action: 'APPLY_REMOTE_PLAN',
    counts: { releaseEntries: releaseEntries.length, current: currentPaths.length, pending: pendingEntries.length },
    pendingPaths: pendingEntries.map((entry) => entry.path), remotePlan,
  });
}

const output = {
  result: 'PASS',
  code: 'FOUNDATION_BATCH_ROLLOUT_PLAN_READY',
  release: schemaVersion === 1
    ? { fromVersion: baselineMap.get('default').fromVersion, sourceVersion, fromCommit: baselineMap.get('default').fromCommit, sourceCommit, changedPaths: baselineMap.get('default').entries.length }
    : {
        sourceVersion, sourceCommit, baselineCount: baselineMap.size,
        baselines: [...baselineMap.values()].map((baseline) => ({
          id: baseline.id, fromVersion: baseline.fromVersion, fromCommit: baseline.fromCommit, changedPaths: baseline.entries.length,
        })),
      },
  counts: {
    targets: targets.length, current: currentCount, update: updateCount, partialResume: partialCount,
    branchRequired: branchRequiredCount, readyPlans: readyPlanCount,
  },
  targets: plannedTargets,
  contract: {
    createFeatureBranchesOnlyForAction: 'CREATE_FEATURE_BRANCH',
    rerunPlannerAfterBranchCreation: true,
    applyOnlyAction: 'APPLY_REMOTE_PLAN',
    postWriteFullSyncAuditRequired: true,
    applicationPrMergeAuthorizationRequired: true,
  },
};
console.log(JSON.stringify(output, null, 2));
