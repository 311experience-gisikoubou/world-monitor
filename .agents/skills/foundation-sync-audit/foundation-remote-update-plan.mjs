#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function fail(code, detail = {}) {
  console.log(JSON.stringify({ result: 'STOP', code, ...detail }));
  process.exit(2);
}
function isSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }
function gitBlobSha(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}
function isCanonicalPath(path) {
  return path === 'AGENTS.md' || path.startsWith('.agents/skills/') || path.startsWith('.claude/skills/');
}
function normalizePath(path) {
  if (typeof path !== 'string') return '';
  const p = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.includes('/../') || p.startsWith('../') || p.endsWith('/..') || p.includes('//')) return '';
  return p;
}
function normalizeBranch(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^refs\/heads\//, '');
}

let raw = argValue('--manifest-json');
const manifestPath = argValue('--manifest');
if (raw && manifestPath) fail('FOUNDATION_REMOTE_PLAN_INPUT_AMBIGUOUS');
if (!raw && manifestPath) {
  try { raw = await readFile(manifestPath, 'utf8'); }
  catch (error) { fail('FOUNDATION_REMOTE_PLAN_MANIFEST_READ_FAILED', { message: String(error?.message || error) }); }
}
if (!raw && !process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  raw = Buffer.concat(chunks).toString('utf8');
}
if (!raw) fail('FOUNDATION_REMOTE_PLAN_MANIFEST_REQUIRED');

let manifest;
try { manifest = JSON.parse(raw); }
catch { fail('FOUNDATION_REMOTE_PLAN_MANIFEST_INVALID_JSON'); }

const { fromVersion, sourceVersion, fromCommit, sourceCommit, targetRepository, targetBranch, targetHead, targetBaseTree, entries } = manifest ?? {};
const targetBranchName = normalizeBranch(targetBranch);
if (typeof fromVersion !== 'string' || !fromVersion.trim()) fail('FOUNDATION_REMOTE_PLAN_FROM_VERSION_REQUIRED');
if (typeof sourceVersion !== 'string' || !sourceVersion.trim()) fail('FOUNDATION_REMOTE_PLAN_SOURCE_VERSION_REQUIRED');
if (fromVersion === sourceVersion) fail('FOUNDATION_REMOTE_PLAN_VERSION_NOT_ADVANCED', { version: sourceVersion });
if (!isSha(fromCommit)) fail('FOUNDATION_REMOTE_PLAN_FROM_COMMIT_INVALID');
if (!isSha(sourceCommit)) fail('FOUNDATION_REMOTE_PLAN_SOURCE_COMMIT_INVALID');
if (fromCommit === sourceCommit) fail('FOUNDATION_REMOTE_PLAN_SOURCE_COMMIT_NOT_ADVANCED');
if (typeof targetRepository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(targetRepository)) fail('FOUNDATION_REMOTE_PLAN_TARGET_REPOSITORY_INVALID');
if (!targetBranchName) fail('FOUNDATION_REMOTE_PLAN_TARGET_BRANCH_REQUIRED');
if (targetBranchName === 'main' || targetBranchName === 'master') fail('FOUNDATION_REMOTE_PLAN_PROTECTED_BRANCH', { branch: targetBranchName });
if (!isSha(targetHead)) fail('FOUNDATION_REMOTE_PLAN_TARGET_HEAD_INVALID');
if (!isSha(targetBaseTree)) fail('FOUNDATION_REMOTE_PLAN_TARGET_BASE_TREE_INVALID');
if (!Array.isArray(entries) || entries.length === 0) fail('FOUNDATION_REMOTE_PLAN_ENTRIES_REQUIRED');

const seen = new Set();
const operations = [];
const requiredBlobShas = new Set();
let unchangedCount = 0;
let createdCount = 0;
let replacedCount = 0;
let deletedCount = 0;

for (const entry of entries) {
  const path = normalizePath(entry?.path);
  if (!path || !isCanonicalPath(path) || path === 'AGENTS.local.md') fail('FOUNDATION_REMOTE_PLAN_PATH_OUTSIDE_SHARED_SURFACE', { path: entry?.path ?? null });
  if (seen.has(path)) fail('FOUNDATION_REMOTE_PLAN_DUPLICATE_PATH', { path });
  seen.add(path);
  const oldSha = entry.oldSha ?? null;
  const newSha = entry.newSha ?? null;
  const targetSha = entry.targetSha ?? null;
  const hasNewContent = Object.prototype.hasOwnProperty.call(entry ?? {}, 'newContent');
  const newContent = hasNewContent ? entry.newContent : null;
  for (const [name, value] of [['oldSha', oldSha], ['newSha', newSha], ['targetSha', targetSha]]) {
    if (value !== null && !isSha(value)) fail('FOUNDATION_REMOTE_PLAN_SHA_INVALID', { path, field: name });
  }
  if (hasNewContent && typeof newContent !== 'string') fail('FOUNDATION_REMOTE_PLAN_SOURCE_CONTENT_INVALID', { path });
  if (newSha === null && hasNewContent) fail('FOUNDATION_REMOTE_PLAN_SOURCE_CONTENT_WITHOUT_NEW_SHA', { path });
  if (newSha !== null && hasNewContent) {
    const calculatedSha = gitBlobSha(newContent);
    if (calculatedSha !== newSha) fail('FOUNDATION_REMOTE_PLAN_SOURCE_CONTENT_SHA_MISMATCH', { path, expectedNewSha: newSha, calculatedSha });
  }
  if (oldSha === null && newSha === null) fail('FOUNDATION_REMOTE_PLAN_EMPTY_ENTRY', { path });

  if (oldSha !== null && newSha !== null) {
    if (targetSha === null) fail('FOUNDATION_REMOTE_PLAN_TARGET_MISSING_OLD', { path });
    if (targetSha !== oldSha) fail('FOUNDATION_REMOTE_PLAN_TARGET_DRIFT', { path, expectedOldSha: oldSha, targetSha });
    if (oldSha === newSha) unchangedCount += 1;
    else {
      operations.push({ op: 'replace', path, oldSha, newSha, targetSha, ...(hasNewContent ? { newContent } : {}) });
      requiredBlobShas.add(newSha);
      replacedCount += 1;
    }
    continue;
  }
  if (oldSha !== null && newSha === null) {
    if (targetSha === null) fail('FOUNDATION_REMOTE_PLAN_TARGET_MISSING_OLD', { path });
    if (targetSha !== oldSha) fail('FOUNDATION_REMOTE_PLAN_TARGET_DRIFT', { path, expectedOldSha: oldSha, targetSha });
    operations.push({ op: 'delete', path, oldSha, newSha: null, targetSha });
    deletedCount += 1;
    continue;
  }
  if (oldSha === null && newSha !== null) {
    if (targetSha === null) {
      operations.push({ op: 'create', path, oldSha: null, newSha, targetSha: null, ...(hasNewContent ? { newContent } : {}) });
      requiredBlobShas.add(newSha);
      createdCount += 1;
    } else if (targetSha === newSha) unchangedCount += 1;
    else fail('FOUNDATION_REMOTE_PLAN_NEW_PATH_CONFLICT', { path, newSha, targetSha });
  }
}

const treeElements = operations.map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: entry.op === 'delete' ? null : entry.newSha }));
const writeOperations = operations.map((entry) => {
  if (entry.op === 'replace') return { op: 'replace', method: 'update_file', path: entry.path, expectedCurrentSha: entry.oldSha, expectedResultSha: entry.newSha, ...(Object.prototype.hasOwnProperty.call(entry, 'newContent') ? { content: entry.newContent } : {}) };
  if (entry.op === 'create') return { op: 'create', method: 'create_file', path: entry.path, expectedCurrentSha: null, expectedResultSha: entry.newSha, ...(Object.prototype.hasOwnProperty.call(entry, 'newContent') ? { content: entry.newContent } : {}) };
  return { op: 'delete', method: 'delete_file', path: entry.path, expectedCurrentSha: entry.oldSha, expectedResultSha: null };
});
const contentsApiAvailable = writeOperations.every((entry) => entry.op === 'delete' || typeof entry.content === 'string');

const output = {
  result: 'PASS', code: 'FOUNDATION_REMOTE_UPDATE_PLAN_READY', fromVersion, sourceVersion, fromCommit, sourceCommit,
  targetRepository, targetBranch: targetBranchName, expectedHead: targetHead, baseTreeSha: targetBaseTree,
  counts: { entries: entries.length, planned: operations.length, created: createdCount, replaced: replacedCount, deleted: deletedCount, unchanged: unchangedCount },
  requiredBlobShas: [...requiredBlobShas].sort(), operations,
  preferredTransport: contentsApiAvailable ? 'contents-api' : 'git-data',
  contentsApiContract: {
    available: contentsApiAvailable,
    reason: contentsApiAvailable ? 'READY' : 'SOURCE_CONTENT_REQUIRED',
    branchName: targetBranchName,
    expectedStartingHead: targetHead,
    sequentialWritesRequired: true,
    verifyBranchHeadBeforeFirstWrite: true,
    verifyPathAfterEachWrite: true,
    verifyFinalDiffOnlyContainsPlannedPaths: true,
    postWriteAuditRequired: true,
    operations: writeOperations,
  },
  gitDataContract: {
    createBlobsFirst: true,
    verifyCreatedBlobShaMatchesSource: true,
    createTree: { baseTreeSha: targetBaseTree, treeElements },
    createCommit: { parentSha: targetHead },
    updateRef: { branchName: targetBranchName, force: false, expectedCurrentHead: targetHead },
    postWriteAuditRequired: true,
  },
};
console.log(JSON.stringify(output, null, 2));
