#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { collectManagedSurface, isManagedTargetPath } from './managed-surface.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const fromRootRaw = argValue('--from-root');
const sourceRootRaw = argValue('--source-root');
const targetRootRaw = argValue('--target-root');
const apply = args.includes('--apply');
const jsonOnly = args.includes('--json');
const mixedBaselineManifestFlagPresent = args.includes('--mixed-baseline-manifest');
const mixedBaselineManifestRaw = mixedBaselineManifestFlagPresent ? argValue('--mixed-baseline-manifest') : null;

const findings = [];
function add(status, code, detail = {}) { findings.push({ status, code, ...detail }); }
function stop(code, detail = {}) { add('STOP', code, detail); }
function normalizeRelative(path) { return path.split(sep).join('/'); }

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
async function sameBytes(a, b) {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}
async function collectFiles(startPath, prefix = '') {
  const files = new Map();
  if (!(await isDirectory(startPath))) return files;
  const entries = await readdir(startPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = resolve(startPath, entry.name);
    const rel = normalizeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(absolute, rel);
      for (const [path, file] of nested) files.set(path, file);
    } else if (entry.isFile()) {
      files.set(rel, absolute);
    }
  }
  return files;
}
function git(targetRoot, gitArgs) {
  return spawnSync('git', ['-C', targetRoot, ...gitArgs], { encoding: 'utf8' });
}
function gitWithInput(targetRoot, gitArgs, input) {
  return spawnSync('git', ['-C', targetRoot, ...gitArgs], { input, encoding: 'utf8' });
}
function wrapperTemplateToTarget(relative) {
  const prefix = 'templates/.claude/skills/';
  const suffix = '/SKILL.md.template';
  if (!relative.startsWith(prefix) || !relative.endsWith(suffix)) return null;
  const skill = relative.slice(prefix.length, -suffix.length);
  if (!skill || skill.includes('/')) return null;
  return `.claude/skills/${skill}/SKILL.md`;
}
async function readVersion(root, codePrefix) {
  const path = resolve(root, 'VERSION');
  if (!(await isFile(path))) {
    stop(`${codePrefix}_VERSION_MISSING`);
    return null;
  }
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) stop(`${codePrefix}_VERSION_EMPTY`);
  return value || null;
}
async function collectCanonical(root) {
  return collectManagedSurface(root);
}
async function collectWrappers(root) {
  const templates = await collectFiles(resolve(root, 'templates', '.claude', 'skills'), 'templates/.claude/skills');
  const result = new Map();
  for (const [relative, absolute] of templates) {
    const targetPath = wrapperTemplateToTarget(relative);
    if (targetPath) result.set(targetPath, absolute);
  }
  return result;
}
function targetedSelftestsForPlan(entries, root) {
  const changed = new Set(entries.map(entry => entry.relative));
  const checks = [];
  const operationGate = '.agents/skills/preflight-audit/operation-preflight.mjs';
  const operationSelftest = '.agents/skills/preflight-audit/operation-preflight-selftest.mjs';
  if (changed.has(operationGate) || changed.has(operationSelftest)) {
    checks.push({
      id: 'operation-preflight',
      argv: [resolve(root, operationSelftest), resolve(root, operationGate)],
    });
  }
  return checks;
}
async function validateSource(root, prefix) {
  if (!(await isDirectory(root))) {
    stop(`${prefix}_ROOT_NOT_FOUND`);
    return;
  }
  if (!(await isFile(resolve(root, 'AGENTS.md')))) stop(`${prefix}_AGENTS_MISSING`);
  if (!(await isDirectory(resolve(root, '.agents', 'skills')))) stop(`${prefix}_SKILLS_MISSING`);
}

const HEX40_RE = /^[0-9a-fA-F]{40}$/;
function isHex40OrNull(value) {
  return value === null || (typeof value === 'string' && HEX40_RE.test(value));
}
function isSafeRelativeManifestPath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.includes('\u0000')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  const parts = value.split(/[\\/]/);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return false;
  }
  return true;
}
async function loadMixedBaselineManifest(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    stop('MIXED_MANIFEST_INVALID', { reason: 'MANIFEST_UNREADABLE' });
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    stop('MIXED_MANIFEST_INVALID', { reason: 'MANIFEST_NOT_JSON' });
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    stop('MIXED_MANIFEST_INVALID', { reason: 'MANIFEST_NOT_OBJECT' });
    return null;
  }
  if (data.schemaVersion !== 1) {
    stop('MIXED_MANIFEST_INVALID', { reason: 'SCHEMA_VERSION_INVALID' });
    return null;
  }
  if (typeof data.targetHead !== 'string' || !HEX40_RE.test(data.targetHead)) {
    stop('MIXED_MANIFEST_INVALID', { reason: 'TARGET_HEAD_INVALID' });
    return null;
  }
  if (typeof data.sourceHead !== 'string' || !HEX40_RE.test(data.sourceHead)) {
    stop('MIXED_MANIFEST_INVALID', { reason: 'SOURCE_HEAD_INVALID' });
    return null;
  }
  if (!Array.isArray(data.entries)) {
    stop('MIXED_MANIFEST_INVALID', { reason: 'ENTRIES_NOT_ARRAY' });
    return null;
  }
  const seenPaths = new Set();
  for (const entry of data.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      stop('MIXED_MANIFEST_INVALID', { reason: 'ENTRY_NOT_OBJECT' });
      return null;
    }
    const keys = Object.keys(entry).sort().join(',');
    if (keys !== 'originCommit,path,targetSha') {
      stop('MIXED_MANIFEST_INVALID', { reason: 'ENTRY_SHAPE_INVALID' });
      return null;
    }
    if (!isSafeRelativeManifestPath(entry.path)) {
      stop('MIXED_MANIFEST_INVALID', { reason: 'ENTRY_PATH_INVALID' });
      return null;
    }
    if (!isHex40OrNull(entry.targetSha)) {
      stop('MIXED_MANIFEST_INVALID', { reason: 'ENTRY_TARGET_SHA_INVALID' });
      return null;
    }
    if (!isHex40OrNull(entry.originCommit)) {
      stop('MIXED_MANIFEST_INVALID', { reason: 'ENTRY_ORIGIN_COMMIT_INVALID' });
      return null;
    }
    const normalizedPath = normalizeRelative(entry.path);
    if (seenPaths.has(normalizedPath)) {
      stop('MIXED_MANIFEST_INVALID', { reason: 'ENTRY_PATH_DUPLICATE' });
      return null;
    }
    seenPaths.add(normalizedPath);
  }
  return data;
}

async function collectTargetTrackedManagedPaths(targetRoot) {
  const result = git(targetRoot, ['ls-tree', '-r', '--name-only', 'HEAD']);
  if (result.status !== 0) return null;
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const managed = new Set();
  for (const line of lines) {
    const normalized = normalizeRelative(line);
    if (isManagedTargetPath(normalized)) managed.add(normalized);
  }
  return managed;
}
async function checkMixedManifestCoverage(manifest, fromRoot, sourceRoot, targetRoot) {
  const fromCanonical = await collectCanonical(fromRoot);
  const sourceCanonical = await collectCanonical(sourceRoot);
  const targetManaged = await collectTargetTrackedManagedPaths(targetRoot);
  if (targetManaged === null) {
    return { ok: false, detail: { reason: 'TARGET_LS_TREE_FAILED' } };
  }

  const union = new Set();
  for (const key of fromCanonical.keys()) if (isManagedTargetPath(key)) union.add(key);
  for (const key of sourceCanonical.keys()) if (isManagedTargetPath(key)) union.add(key);
  for (const key of targetManaged) union.add(key);

  const manifestPaths = new Set();
  for (const entry of manifest.entries) {
    const normalized = normalizeRelative(entry.path);
    if (!isManagedTargetPath(normalized)) {
      return { ok: false, detail: { reason: 'MANIFEST_PATH_NONCANONICAL', path: normalized } };
    }
    if (manifestPaths.has(normalized)) {
      return { ok: false, detail: { reason: 'MANIFEST_PATH_DUPLICATE', path: normalized } };
    }
    manifestPaths.add(normalized);
  }

  const missing = [...union].filter((path) => !manifestPaths.has(path)).sort();
  const extra = [...manifestPaths].filter((path) => !union.has(path)).sort();
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      detail: {
        reason: 'UNION_MISMATCH',
        missingCount: missing.length,
        extraCount: extra.length,
        missing: missing.slice(0, 20),
        extra: extra.slice(0, 20),
      },
    };
  }
  return { ok: true };
}

const GIT_LS_TREE_LINE_RE = /^([0-7]{6}) (\S+) ([0-9a-f]{40})\t(.+)$/;

// Parse the complete tracked tree in one command. Do not interpret a newline as a
// path boundary: Git -z uses NUL for precisely that reason. Unknown/ambiguous
// records must stop the operation rather than silently drop verification.
function checkedTree(root, revision) {
  const result = git(root, ['ls-tree', '-r', '-z', revision]);
  if (result.status !== 0 || result.error) return { ok: false, reason: 'LS_TREE_FAILED' };
  const records = new Map();
  const chunks = result.stdout.split('\0');
  if (chunks.pop() !== '' && result.stdout.length > 0) return { ok: false, reason: 'LS_TREE_PARSE_FAILED' };
  for (const line of chunks) {
    const record = GIT_LS_TREE_LINE_RE.exec(line);
    if (!record || records.has(record[4])) return { ok: false, reason: 'LS_TREE_PARSE_FAILED' };
    records.set(record[4], { mode: record[1], type: record[2], sha: record[3] });
  }
  return { ok: true, records };
}
async function checkMixedManifestTargetBlobs(manifest, targetRoot) {
  const tree = checkedTree(targetRoot, 'HEAD');
  if (!tree.ok) return { ok: false, detail: { reason: tree.reason } };
  const toHash = [];
  const expected = [];
  for (const entry of manifest.entries) {
    const relative = normalizeRelative(entry.path);
    const record = tree.records.get(relative) || null;
    const onDisk = await isFile(resolve(targetRoot, relative));
    if (!record) {
      if (entry.targetSha !== null || entry.originCommit !== null || onDisk) {
        return { ok: false, detail: { reason: 'MANIFEST_ABSENT_MISMATCH', path: relative } };
      }
      continue;
    }
    if (record.type !== 'blob') return { ok: false, detail: { reason: 'TARGET_ENTRY_NOT_BLOB', path: relative, type: record.type } };
    if (record.mode !== '100644' && record.mode !== '100755') {
      return { ok: false, detail: { reason: 'TARGET_ENTRY_MODE_DISALLOWED', path: relative, mode: record.mode } };
    }
    if (entry.targetSha === null || entry.originCommit === null) {
      return { ok: false, detail: { reason: 'MANIFEST_PRESENT_FIELDS_MISSING', path: relative } };
    }
    if (!onDisk) return { ok: false, detail: { reason: 'TARGET_WORKTREE_FILE_MISSING', path: relative } };
    if (record.sha !== entry.targetSha) {
      return { ok: false, detail: { reason: 'MANIFEST_TARGET_SHA_MISMATCH', path: relative } };
    }
    // stdin-paths is line-delimited. Explicitly reject paths that cannot be
    // represented without input injection; never interpret stdout as paths.
    if (/[\r\n\0]/.test(relative)) {
      return { ok: false, detail: { reason: 'HASH_OBJECT_INPUT_UNSAFE_PATH', path: relative } };
    }
    toHash.push(relative);
    expected.push(record.sha);
  }
  if (toHash.length === 0) return { ok: true };
  const hashes = gitWithInput(targetRoot, ['hash-object', '--stdin-paths'], toHash.join('\n') + '\n');
  if (hashes.status !== 0 || hashes.error) {
    return { ok: false, detail: { reason: 'HASH_OBJECT_FAILED' } };
  }
  const lines = hashes.stdout.trim().split(/\r?\n/);
  if (lines.length !== expected.length || lines.some((sha) => !HEX40_RE.test(sha))) {
    return { ok: false, detail: { reason: 'HASH_OBJECT_INVALID' } };
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (lines[i] !== expected[i]) return { ok: false, detail: { reason: 'TARGET_WORKTREE_MODIFIED', path: toHash[i] } };
  }
  return { ok: true };
}

const TRUSTED_ORIGIN_RE = /^(?:https:\/\/github\.com\/311experience-gisikoubou\/ai-dev-foundation(?:\.git)?|git@github\.com:311experience-gisikoubou\/ai-dev-foundation(?:\.git)?)$/;
async function checkMixedManifestOriginProvenance(manifest, sourceRoot, trustedSourceHead) {
  const originUrlResult = git(sourceRoot, ['remote', 'get-url', 'origin']);
  if (originUrlResult.status !== 0) {
    return { ok: false, detail: { reason: 'SOURCE_ORIGIN_URL_UNAVAILABLE' } };
  }
  const originUrl = originUrlResult.stdout.trim();
  if (!TRUSTED_ORIGIN_RE.test(originUrl)) {
    return { ok: false, detail: { reason: 'SOURCE_ORIGIN_URL_UNTRUSTED' } };
  }

  const branchResult = git(sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchResult.status !== 0 || branchResult.stdout.trim() !== 'main') {
    return { ok: false, detail: { reason: 'SOURCE_BRANCH_NOT_MAIN' } };
  }

  const sourceHeadResult = git(sourceRoot, ['rev-parse', 'HEAD']);
  const sourceHeadValue = sourceHeadResult.status === 0 ? sourceHeadResult.stdout.trim() : null;
  if (!sourceHeadValue || !HEX40_RE.test(sourceHeadValue) || sourceHeadValue !== trustedSourceHead) {
    return { ok: false, detail: { reason: 'SOURCE_HEAD_MISMATCH' } };
  }

  const trackingResult = git(sourceRoot, ['rev-parse', 'origin/main']);
  const trackingValue = trackingResult.status === 0 ? trackingResult.stdout.trim() : null;
  if (!trackingValue || !HEX40_RE.test(trackingValue) || trackingValue !== trustedSourceHead) {
    return { ok: false, detail: { reason: 'SOURCE_TRACKING_MISMATCH' } };
  }

  const statusResult = git(sourceRoot, ['status', '--porcelain']);
  if (statusResult.status !== 0) {
    return { ok: false, detail: { reason: 'SOURCE_STATUS_FAILED' } };
  }
  if (statusResult.stdout.trim()) {
    return { ok: false, detail: { reason: 'SOURCE_WORKTREE_DIRTY' } };
  }

// Per-origin ancestry AND full tree are re-read every time this function is
  // called, including the independent pre-write recheck. No cross-phase cache.
  const originTrees = new Map();
  for (const entry of manifest.entries) {
    if (entry.targetSha === null) {
      if (entry.originCommit !== null) {
        return { ok: false, detail: { reason: 'ABSENT_ORIGIN_COMMIT_PRESENT', path: normalizeRelative(entry.path) } };
      }
      continue;
    }
    const originCommit = entry.originCommit;
    if (typeof originCommit !== 'string' || !HEX40_RE.test(originCommit)) {
      return { ok: false, detail: { reason: 'ORIGIN_COMMIT_MISSING', path: normalizeRelative(entry.path) } };
    }
    if (originTrees.has(originCommit)) continue;
    const ancestor = git(sourceRoot, ['merge-base', '--is-ancestor', originCommit, trustedSourceHead]);
    if (ancestor.status !== 0) {
      return { ok: false, detail: { reason: 'ORIGIN_COMMIT_NOT_ANCESTOR', path: normalizeRelative(entry.path) } };
    }
    const history = checkedTree(sourceRoot, originCommit);
    if (!history.ok) {
      return { ok: false, detail: { reason: 'ORIGIN_COMMIT_PATH_UNRESOLVED', path: normalizeRelative(entry.path) } };
    }
    originTrees.set(originCommit, history.records);
  }
  for (const entry of manifest.entries) {
    if (entry.targetSha === null) continue;
    const relative = normalizeRelative(entry.path);
    const historical = originTrees.get(entry.originCommit)?.get(relative);
    if (!historical) {
      return { ok: false, detail: { reason: 'ORIGIN_COMMIT_PATH_UNRESOLVED', path: relative } };
    }
    if (historical.type !== 'blob' || (historical.mode !== '100644' && historical.mode !== '100755') || historical.sha !== entry.targetSha) {
      return { ok: false, detail: { reason: 'ORIGIN_COMMIT_BLOB_MISMATCH', path: relative } };
    }
  }
  return { ok: true };
}

async function countMixedBaselineDrift(manifest, sourceRoot) {
  let driftCount = 0;
  for (const entry of manifest.entries) {
    const normalizedPath = normalizeRelative(entry.path);
    const blobResult = git(sourceRoot, ['rev-parse', '--verify', '--quiet', `HEAD:${normalizedPath}`]);
    const blobSha = blobResult.status === 0 ? blobResult.stdout.trim() : null;
    const sourceHeadBlob = (blobSha && HEX40_RE.test(blobSha)) ? blobSha : null;
    if (entry.targetSha !== sourceHeadBlob) driftCount += 1;
  }
  return driftCount;
}

async function checkMixedManifestTargetSafety(manifest, fromRoot, sourceRoot, targetRoot) {
  const top = git(targetRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    return { ok: false, detail: { reason: 'TARGET_NOT_GIT_REPOSITORY' } };
  }
  if (resolve(top.stdout.trim()) !== targetRoot) {
    return { ok: false, detail: { reason: 'TARGET_NOT_REPOSITORY_ROOT' } };
  }

  const branch = git(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.status !== 0) {
    return { ok: false, detail: { reason: 'TARGET_BRANCH_UNKNOWN' } };
  }
  const branchName = branch.stdout.trim();
  if (!branchName || branchName === 'HEAD') {
    return { ok: false, detail: { reason: 'TARGET_DETACHED_HEAD' } };
  }
  if (branchName === 'main' || branchName === 'master') {
    return { ok: false, detail: { reason: 'TARGET_PROTECTED_BRANCH', branch: branchName } };
  }

  const status = git(targetRoot, ['status', '--porcelain']);
  if (status.status !== 0) {
    return { ok: false, detail: { reason: 'TARGET_STATUS_FAILED' } };
  }
  if (status.stdout.trim()) {
    return { ok: false, detail: { reason: 'TARGET_WORKTREE_DIRTY' } };
  }

  if (targetRoot === fromRoot || targetRoot === sourceRoot) {
    return { ok: false, detail: { reason: 'TARGET_OVERLAPS_SOURCE' } };
  }

  const headResult = git(targetRoot, ['rev-parse', 'HEAD']);
  if (headResult.status !== 0) {
    return { ok: false, detail: { reason: 'TARGET_HEAD_UNKNOWN' } };
  }
  const headValue = headResult.stdout.trim();
  if (!HEX40_RE.test(headValue) || headValue !== manifest.targetHead) {
    return { ok: false, detail: { reason: 'TARGET_HEAD_MISMATCH' } };
  }

  return { ok: true };
}

async function lstatSafe(path) {
  try { return await lstat(path); } catch { return null; }
}
async function detectSymlinkInPath(root, relative) {
  const parts = relative.split('/');
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstatSafe(current);
    if (info && info.isSymbolicLink()) return true;
  }
  return false;
}

async function buildMixedApplyPlan(manifest, sourceCanonical, targetRoot) {
  const planEntries = [];
  for (const entry of manifest.entries) {
    const normalizedPath = normalizeRelative(entry.path);
    if (!isManagedTargetPath(normalizedPath)) {
      return { ok: false, detail: { reason: 'PLAN_PATH_NONCANONICAL', path: normalizedPath } };
    }
    if (await detectSymlinkInPath(targetRoot, normalizedPath)) {
      return { ok: false, detail: { reason: 'PLAN_PATH_SYMLINK', path: normalizedPath } };
    }
    const destination = resolve(targetRoot, normalizedPath);
    const destInfo = await lstatSafe(destination);
    if (destInfo && !destInfo.isFile()) {
      return { ok: false, detail: { reason: 'PLAN_PATH_NOT_REGULAR_FILE', path: normalizedPath } };
    }

    const sourceAbsolute = sourceCanonical.get(normalizedPath) || null;
    if (sourceAbsolute) {
      const sourceInfo = await lstatSafe(sourceAbsolute);
      if (!sourceInfo || !sourceInfo.isFile()) {
        return { ok: false, detail: { reason: 'PLAN_SOURCE_NOT_REGULAR_FILE', path: normalizedPath } };
      }
    }

    if (sourceAbsolute && entry.targetSha === null) {
      if (destInfo) {
        return { ok: false, detail: { reason: 'PLAN_PATH_UNEXPECTED_EXISTS', path: normalizedPath } };
      }
      planEntries.push({ op: 'create', relative: normalizedPath, destination, sourceAbsolute });
      continue;
    }

    if (sourceAbsolute && entry.targetSha !== null) {
      if (!destInfo) {
        return { ok: false, detail: { reason: 'PLAN_PATH_UNEXPECTED_MISSING', path: normalizedPath } };
      }
      const same = await sameBytes(sourceAbsolute, destination);
      if (!same) {
        planEntries.push({ op: 'replace', relative: normalizedPath, destination, sourceAbsolute });
      }
      continue;
    }

    if (!sourceAbsolute && entry.targetSha !== null) {
      if (!destInfo) {
        return { ok: false, detail: { reason: 'PLAN_PATH_UNEXPECTED_MISSING', path: normalizedPath } };
      }
      planEntries.push({ op: 'delete', relative: normalizedPath, destination, sourceAbsolute: null });
      continue;
    }
    // !sourceAbsolute && entry.targetSha === null -> both absent, no change recorded.
  }
  return { ok: true, planEntries };
}

async function rollbackMixedApply(applied) {
  for (const entry of [...applied].reverse()) {
    try {
      if (entry.preimage === null) {
        await rm(entry.destination, { force: true });
      } else {
        await mkdir(dirname(entry.destination), { recursive: true });
        await writeFile(entry.destination, entry.preimage);
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function verifyOriginalBufferMatchesManifest(targetRoot, relative, buffer, expectedTargetSha) {
  const hashResult = gitWithInput(targetRoot, ['hash-object', `--path=${relative}`, '--stdin'], buffer);
  if (hashResult.status !== 0) {
    return { ok: false, detail: { reason: 'ORIGINAL_BUFFER_HASH_FAILED', path: relative } };
  }
  const bufferSha = hashResult.stdout.trim();
  if (!HEX40_RE.test(bufferSha)) {
    return { ok: false, detail: { reason: 'ORIGINAL_BUFFER_HASH_INVALID', path: relative } };
  }

  const headBlobResult = git(targetRoot, ['rev-parse', '--verify', '--quiet', `HEAD:${relative}`]);
  const headBlobSha = headBlobResult.status === 0 ? headBlobResult.stdout.trim() : null;
  if (!headBlobSha || !HEX40_RE.test(headBlobSha)) {
    return { ok: false, detail: { reason: 'ORIGINAL_BUFFER_HEAD_BLOB_UNRESOLVED', path: relative } };
  }
  if (bufferSha !== headBlobSha) {
    return { ok: false, detail: { reason: 'ORIGINAL_BUFFER_HEAD_MISMATCH', path: relative, bufferSha, headBlobSha } };
  }
  if (expectedTargetSha !== null && bufferSha !== expectedTargetSha) {
    return { ok: false, detail: { reason: 'ORIGINAL_BUFFER_TARGET_SHA_MISMATCH', path: relative, bufferSha, expectedTargetSha } };
  }

  return { ok: true, sha: bufferSha };
}

async function runMixedBaselineApply(manifest, fromRoot, sourceRoot, targetRoot) {
  const targetSafetyRecheck = await checkMixedManifestTargetSafety(manifest, fromRoot, sourceRoot, targetRoot);
  if (!targetSafetyRecheck.ok) {
    stop('MIXED_BASELINE_APPLY_PRECHECK_FAILED', { stage: 'TARGET_SAFETY', ...targetSafetyRecheck.detail });
    return;
  }
  const blobRecheck = await checkMixedManifestTargetBlobs(manifest, targetRoot);
  if (!blobRecheck.ok) {
    stop('MIXED_BASELINE_APPLY_PRECHECK_FAILED', { stage: 'TARGET_BLOBS', ...blobRecheck.detail });
    return;
  }
  const provenanceRecheck = await checkMixedManifestOriginProvenance(manifest, sourceRoot, manifest.sourceHead);
  if (!provenanceRecheck.ok) {
    stop('MIXED_BASELINE_APPLY_PRECHECK_FAILED', { stage: 'SOURCE_PROVENANCE', ...provenanceRecheck.detail });
    return;
  }

  const sourceCanonical = await collectCanonical(sourceRoot);
  const planResult = await buildMixedApplyPlan(manifest, sourceCanonical, targetRoot);
  if (!planResult.ok) {
    stop('MIXED_BASELINE_APPLY_PLAN_FAILED', planResult.detail);
    return;
  }
  const planEntries = planResult.planEntries;
  const manifestByPath = new Map(manifest.entries.map((entry) => [normalizeRelative(entry.path), entry]));

  // Build immutable in-memory snapshots for every planned entry BEFORE any write occurs.
  // This guarantees the original-buffer verification for each file happens against its
  // true pre-apply bytes, never against bytes that a prior entry's write may have mutated.
  const snapshots = [];
  for (const entry of planEntries) {
    if (entry.op === 'create') {
      const stillAbsent = await lstatSafe(entry.destination);
      if (stillAbsent) {
        stop('MIXED_BASELINE_APPLY_SNAPSHOT_FAILED', { reason: 'CREATE_PATH_NOW_EXISTS', path: entry.relative });
        return;
      }
      snapshots.push({ entry, preimage: null });
      continue;
    }
    let preimage;
    try {
      preimage = await readFile(entry.destination);
    } catch {
      stop('MIXED_BASELINE_APPLY_SNAPSHOT_FAILED', { reason: 'SNAPSHOT_READ_FAILED', path: entry.relative });
      return;
    }
    const manifestEntry = manifestByPath.get(entry.relative) || null;
    const expectedTargetSha = manifestEntry ? manifestEntry.targetSha : null;
    const verify = await verifyOriginalBufferMatchesManifest(targetRoot, entry.relative, preimage, expectedTargetSha);
    if (!verify.ok) {
      stop('MIXED_BASELINE_APPLY_ORIGINAL_BUFFER_MISMATCH', verify.detail);
      return;
    }
    snapshots.push({ entry, preimage });
  }

  // Re-validate target safety, target blobs, and source ancestry immediately before the
  // first write, using the now-confirmed-untampered snapshot set as the basis of trust.
  const targetSafetyPreWrite = await checkMixedManifestTargetSafety(manifest, fromRoot, sourceRoot, targetRoot);
  if (!targetSafetyPreWrite.ok) {
    stop('MIXED_BASELINE_APPLY_PRECHECK_FAILED', { stage: 'TARGET_SAFETY_PRE_WRITE', ...targetSafetyPreWrite.detail });
    return;
  }
  const blobPreWrite = await checkMixedManifestTargetBlobs(manifest, targetRoot);
  if (!blobPreWrite.ok) {
    stop('MIXED_BASELINE_APPLY_PRECHECK_FAILED', { stage: 'TARGET_BLOBS_PRE_WRITE', ...blobPreWrite.detail });
    return;
  }
  const provenancePreWrite = await checkMixedManifestOriginProvenance(manifest, sourceRoot, manifest.sourceHead);
  if (!provenancePreWrite.ok) {
    stop('MIXED_BASELINE_APPLY_PRECHECK_FAILED', { stage: 'SOURCE_PROVENANCE_PRE_WRITE', ...provenancePreWrite.detail });
    return;
  }

  const applied = [];
  try {
    for (const snapshot of snapshots) {
      const { entry, preimage } = snapshot;
      applied.push({ destination: entry.destination, preimage, relative: entry.relative });
      if (entry.op === 'delete') {
        await rm(entry.destination, { force: true });
      } else {
        await mkdir(dirname(entry.destination), { recursive: true });
        await copyFile(entry.sourceAbsolute, entry.destination);
      }
    }
  } catch (error) {
    const rolledBack = await rollbackMixedApply(applied);
    if (!rolledBack) {
      stop('MIXED_BASELINE_APPLY_ROLLBACK_FAILED', { reason: 'WRITE_FAILED', message: error instanceof Error ? error.message : String(error) });
    } else {
      stop('MIXED_BASELINE_APPLY_FAILED', { message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const mixedAuditPath = resolve(sourceRoot, '.agents', 'skills', 'foundation-sync-audit', 'foundation-sync-audit.mjs');
  const audit = spawnSync(process.execPath, [mixedAuditPath, '--json', '--source-root', sourceRoot, '--target-root', targetRoot], { encoding: 'utf8' });
  if (audit.status !== 0) {
    const rolledBack = await rollbackMixedApply(applied);
    if (!rolledBack) {
      stop('MIXED_BASELINE_APPLY_ROLLBACK_FAILED', { reason: 'POST_AUDIT_FAILED', auditExit: audit.status });
    } else {
      stop('MIXED_BASELINE_APPLY_POST_AUDIT_FAILED', {
        auditExit: audit.status,
        auditResult: audit.stdout.trim().slice(0, 4000),
      });
    }
    return;
  }

  const targetedChecks = targetedSelftestsForPlan(planEntries, targetRoot);
  for (const check of targetedChecks) {
    const selftest = spawnSync(process.execPath, check.argv, { cwd: targetRoot, encoding: 'utf8' });
    if (selftest.status !== 0) {
      const rolledBack = await rollbackMixedApply(applied);
      const detail = {
        id: check.id,
        selftestExit: selftest.status,
        selftestResult: `${selftest.stdout ?? ''}${selftest.stderr ?? ''}`.trim().slice(0, 4000),
        selftestError: selftest.error ? selftest.error.message : null,
      };
      if (!rolledBack) {
        stop('MIXED_BASELINE_APPLY_ROLLBACK_FAILED', { reason: 'TARGET_SELFTEST_FAILED', ...detail });
      } else {
        stop('MIXED_BASELINE_APPLY_TARGET_SELFTEST_FAILED', detail);
      }
      return;
    }
  }

  add('PASS', 'MIXED_BASELINE_APPLIED', {
    appliedCount: planEntries.length,
    create: planEntries.filter((entry) => entry.op === 'create').length,
    replace: planEntries.filter((entry) => entry.op === 'replace').length,
    delete: planEntries.filter((entry) => entry.op === 'delete').length,
    targetedSelftests: targetedChecks.map((check) => check.id),
  });
}

if (mixedBaselineManifestFlagPresent) {
  if (!mixedBaselineManifestRaw) {
    stop('MIXED_MANIFEST_INVALID', { reason: 'MANIFEST_PATH_REQUIRED' });
  } else {
    const manifest = await loadMixedBaselineManifest(resolve(mixedBaselineManifestRaw));
    if (manifest) {
      const mixedFromRoot = fromRootRaw ? resolve(fromRootRaw) : null;
      const mixedSourceRoot = sourceRootRaw ? resolve(sourceRootRaw) : null;
      const mixedTargetRoot = targetRootRaw ? resolve(targetRootRaw) : null;
      const mixedSourceHeadResult = mixedSourceRoot ? git(mixedSourceRoot, ['rev-parse', 'HEAD']) : null;
      const mixedTargetHeadResult = mixedTargetRoot ? git(mixedTargetRoot, ['rev-parse', 'HEAD']) : null;
      const mixedSourceHeadValue = mixedSourceHeadResult && mixedSourceHeadResult.status === 0
        ? mixedSourceHeadResult.stdout.trim()
        : null;
      const mixedTargetHeadValue = mixedTargetHeadResult && mixedTargetHeadResult.status === 0
        ? mixedTargetHeadResult.stdout.trim()
        : null;
      const sourceHeadMatches = typeof mixedSourceHeadValue === 'string'
        && HEX40_RE.test(mixedSourceHeadValue)
        && mixedSourceHeadValue === manifest.sourceHead;
      const targetHeadMatches = typeof mixedTargetHeadValue === 'string'
        && HEX40_RE.test(mixedTargetHeadValue)
        && mixedTargetHeadValue === manifest.targetHead;
      if (!sourceHeadMatches || !targetHeadMatches) {
        stop('MIXED_MANIFEST_HEAD_MISMATCH');
      } else if (!mixedFromRoot) {
        stop('MIXED_MANIFEST_COVERAGE_MISMATCH', { reason: 'FROM_ROOT_REQUIRED' });
      } else {
        const coverage = await checkMixedManifestCoverage(manifest, mixedFromRoot, mixedSourceRoot, mixedTargetRoot);
        if (!coverage.ok) {
          stop('MIXED_MANIFEST_COVERAGE_MISMATCH', coverage.detail);
        } else {
          const blobCheck = await checkMixedManifestTargetBlobs(manifest, mixedTargetRoot);
          if (!blobCheck.ok) {
            stop('MIXED_MANIFEST_TARGET_BLOB_MISMATCH', blobCheck.detail);
          } else {
            const provenance = await checkMixedManifestOriginProvenance(manifest, mixedSourceRoot, manifest.sourceHead);
            if (!provenance.ok) {
              stop('MIXED_MANIFEST_ORIGIN_NOT_TRUSTED', provenance.detail);
            } else {
              const targetSafety = await checkMixedManifestTargetSafety(manifest, mixedFromRoot, mixedSourceRoot, mixedTargetRoot);
              if (!targetSafety.ok) {
                stop('MIXED_MANIFEST_TARGET_UNSAFE', targetSafety.detail);
              } else if (apply) {
                await runMixedBaselineApply(manifest, mixedFromRoot, mixedSourceRoot, mixedTargetRoot);
              } else {
                const driftCount = await countMixedBaselineDrift(manifest, mixedSourceRoot);
                add('PASS', 'MIXED_BASELINE_PLAN_READY', { driftCount });
              }
            }
          }
        }
      }
    }
  }
}

if (mixedBaselineManifestFlagPresent) {
  const mixedStopFinding = findings.find((f) => f.status === 'STOP');
  const mixedPassFinding = findings.find((f) => f.status === 'PASS'
    && (f.code === 'MIXED_BASELINE_APPLIED' || f.code === 'MIXED_BASELINE_PLAN_READY'));
  if (!mixedStopFinding && !mixedPassFinding) {
    stop('MIXED_BASELINE_NO_FINAL_RESULT');
  }
  const mixedResult = findings.some((f) => f.status === 'STOP') ? 'STOP' : 'PASS';
  console.log(JSON.stringify({ result: mixedResult, findings }, null, jsonOnly ? 0 : 2));
  process.exit(mixedResult === 'PASS' ? 0 : 2);
}

if (!fromRootRaw) stop('FOUNDATION_UPDATE_FROM_ROOT_REQUIRED');
if (!sourceRootRaw) stop('FOUNDATION_UPDATE_SOURCE_ROOT_REQUIRED');
if (!targetRootRaw) stop('FOUNDATION_UPDATE_TARGET_ROOT_REQUIRED');

let fromRoot = null;
let sourceRoot = null;
let targetRoot = null;
let fromVersion = null;
let sourceVersion = null;
let fromCommit = null;
let sourceCommit = null;
let targetBranch = null;
let claudeAdapterConfigured = false;
let canonicalFromCount = 0;
let canonicalSourceCount = 0;
let claudeFromCount = 0;
let claudeSourceCount = 0;
let createdCount = 0;
let replacedCount = 0;
let deletedCount = 0;
let unchangedCount = 0;
let targetedSelftestCount = 0;
const targetedSelftestIds = [];
const plan = [];

if (!findings.some((f) => f.status === 'STOP')) {
  fromRoot = resolve(fromRootRaw);
  sourceRoot = resolve(sourceRootRaw);
  targetRoot = resolve(targetRootRaw);
  if (fromRoot === sourceRoot) stop('FOUNDATION_UPDATE_SOURCE_VERSIONS_SAME_ROOT');
  if (targetRoot === fromRoot || targetRoot === sourceRoot) stop('FOUNDATION_UPDATE_TARGET_OVERLAPS_SOURCE');
  await validateSource(fromRoot, 'FOUNDATION_UPDATE_FROM');
  await validateSource(sourceRoot, 'FOUNDATION_UPDATE_SOURCE');
  if (!(await isDirectory(targetRoot))) stop('FOUNDATION_UPDATE_TARGET_ROOT_NOT_FOUND');
}

let auditPath = null;
if (!findings.some((f) => f.status === 'STOP')) {
  fromVersion = await readVersion(fromRoot, 'FOUNDATION_UPDATE_FROM');
  sourceVersion = await readVersion(sourceRoot, 'FOUNDATION_UPDATE_SOURCE');
  if (fromVersion && sourceVersion && fromVersion === sourceVersion) {
    stop('FOUNDATION_UPDATE_VERSION_NOT_ADVANCED', { version: sourceVersion });
  }
  const fromGit = git(fromRoot, ['rev-parse', 'HEAD']);
  if (fromGit.status === 0) fromCommit = fromGit.stdout.trim() || null;
  const sourceGit = git(sourceRoot, ['rev-parse', 'HEAD']);
  if (sourceGit.status === 0) sourceCommit = sourceGit.stdout.trim() || null;

  auditPath = resolve(sourceRoot, '.agents', 'skills', 'foundation-sync-audit', 'foundation-sync-audit.mjs');
  if (!(await isFile(auditPath))) stop('FOUNDATION_UPDATE_AUDIT_GATE_MISSING');
}

if (!findings.some((f) => f.status === 'STOP')) {
  const oldSelfAudit = spawnSync(process.execPath, [auditPath, '--json', '--source-root', fromRoot, '--target-root', fromRoot], { encoding: 'utf8' });
  if (oldSelfAudit.status !== 0) stop('FOUNDATION_UPDATE_FROM_SOURCE_INVALID', { auditResult: oldSelfAudit.stdout.trim().slice(0, 4000) });
  const newSelfAudit = spawnSync(process.execPath, [auditPath, '--json', '--source-root', sourceRoot, '--target-root', sourceRoot], { encoding: 'utf8' });
  if (newSelfAudit.status !== 0) stop('FOUNDATION_UPDATE_SOURCE_INVALID', { auditResult: newSelfAudit.stdout.trim().slice(0, 4000) });
}

if (!findings.some((f) => f.status === 'STOP')) {
  const top = git(targetRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) stop('FOUNDATION_UPDATE_TARGET_NOT_GIT_REPOSITORY');
  else if (resolve(top.stdout.trim()) !== targetRoot) stop('FOUNDATION_UPDATE_TARGET_NOT_REPOSITORY_ROOT');

  const branch = git(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.status !== 0) stop('FOUNDATION_UPDATE_TARGET_BRANCH_UNKNOWN');
  else {
    targetBranch = branch.stdout.trim();
    if (!targetBranch || targetBranch === 'HEAD') stop('FOUNDATION_UPDATE_DETACHED_HEAD');
    else if (targetBranch === 'main' || targetBranch === 'master') stop('FOUNDATION_UPDATE_PROTECTED_BRANCH', { branch: targetBranch });
  }

  const status = git(targetRoot, ['status', '--porcelain']);
  if (status.status !== 0) stop('FOUNDATION_UPDATE_GIT_STATUS_FAILED');
  else if (status.stdout.trim()) stop('FOUNDATION_UPDATE_DIRTY_WORKTREE');
}

async function planSurface(oldMap, newMap, surface) {
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  for (const relative of paths) {
    const oldSource = oldMap.get(relative) || null;
    const newSource = newMap.get(relative) || null;
    const destination = resolve(targetRoot, relative);
    const destinationFile = await isFile(destination);
    const destinationDir = await isDirectory(destination);

    if (oldSource && newSource) {
      if (!destinationFile) {
        stop(destinationDir ? 'FOUNDATION_UPDATE_TARGET_PATH_CONFLICT' : 'FOUNDATION_UPDATE_TARGET_MISSING_OLD', { path: relative, surface });
        continue;
      }
      if (!(await sameBytes(oldSource, destination))) {
        stop('FOUNDATION_UPDATE_TARGET_DRIFT', { path: relative, surface });
        continue;
      }
      if (await sameBytes(oldSource, newSource)) {
        unchangedCount += 1;
      } else {
        plan.push({ op: 'replace', relative, destination, oldSource, newSource, surface });
        replacedCount += 1;
      }
      continue;
    }

    if (oldSource && !newSource) {
      if (!destinationFile) {
        stop(destinationDir ? 'FOUNDATION_UPDATE_TARGET_PATH_CONFLICT' : 'FOUNDATION_UPDATE_TARGET_MISSING_OLD', { path: relative, surface });
        continue;
      }
      if (!(await sameBytes(oldSource, destination))) {
        stop('FOUNDATION_UPDATE_TARGET_DRIFT', { path: relative, surface });
        continue;
      }
      plan.push({ op: 'delete', relative, destination, oldSource, newSource: null, surface });
      deletedCount += 1;
      continue;
    }

    if (!oldSource && newSource) {
      if (destinationDir) {
        stop('FOUNDATION_UPDATE_NEW_PATH_CONFLICT', { path: relative, surface });
        continue;
      }
      if (destinationFile) {
        if (await sameBytes(newSource, destination)) {
          unchangedCount += 1;
        } else {
          stop('FOUNDATION_UPDATE_NEW_PATH_CONFLICT', { path: relative, surface });
        }
        continue;
      }
      plan.push({ op: 'create', relative, destination, oldSource: null, newSource, surface });
      createdCount += 1;
    }
  }
}

if (!findings.some((f) => f.status === 'STOP')) {
  const oldCanonical = await collectCanonical(fromRoot);
  const newCanonical = await collectCanonical(sourceRoot);
  canonicalFromCount = oldCanonical.size;
  canonicalSourceCount = newCanonical.size;
  await planSurface(oldCanonical, newCanonical, 'canonical');

  claudeAdapterConfigured = await isFile(resolve(targetRoot, 'CLAUDE.md')) || await isDirectory(resolve(targetRoot, '.claude', 'skills'));
  if (claudeAdapterConfigured && !findings.some((f) => f.status === 'STOP')) {
    const oldWrappers = await collectWrappers(fromRoot);
    const newWrappers = await collectWrappers(sourceRoot);
    claudeFromCount = oldWrappers.size;
    claudeSourceCount = newWrappers.size;
    await planSurface(oldWrappers, newWrappers, 'claude');
  }
}

async function rollback(applied) {
  for (const entry of [...applied].reverse()) {
    try {
      if (entry.op === 'create') {
        await rm(entry.destination, { force: true });
      } else {
        await mkdir(dirname(entry.destination), { recursive: true });
        await copyFile(entry.oldSource, entry.destination);
      }
    } catch { /* best effort */ }
  }
}

if (!findings.some((f) => f.status === 'STOP')) {
  if (!apply) {
    add('PASS', 'FOUNDATION_UPDATE_PLAN_READY', {
      fromVersion,
      sourceVersion,
      targetBranch,
      plannedFiles: plan.length,
      create: createdCount,
      replace: replacedCount,
      delete: deletedCount,
      unchanged: unchangedCount,
      claudeAdapter: claudeAdapterConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    });
  } else {
    const applied = [];
    try {
      for (const entry of plan) {
        if (entry.op === 'delete') {
          await rm(entry.destination, { force: true });
        } else {
          await mkdir(dirname(entry.destination), { recursive: true });
          await copyFile(entry.newSource, entry.destination);
        }
        applied.push(entry);
      }

      const audit = spawnSync(process.execPath, [auditPath, '--json', '--source-root', sourceRoot, '--target-root', targetRoot], { encoding: 'utf8' });
      if (audit.status !== 0) {
        await rollback(applied);
        stop('FOUNDATION_UPDATE_POST_AUDIT_FAILED', {
          auditExit: audit.status,
          auditResult: audit.stdout.trim().slice(0, 4000),
        });
      } else {
        const targetedChecks = targetedSelftestsForPlan(plan, targetRoot);
        let targetedFailure = null;
        for (const check of targetedChecks) {
          targetedSelftestCount += 1;
          targetedSelftestIds.push(check.id);
          const selftest = spawnSync(process.execPath, check.argv, { cwd: targetRoot, encoding: 'utf8' });
          if (selftest.status !== 0) {
            targetedFailure = {
              id: check.id,
              selftestExit: selftest.status,
              selftestResult: `${selftest.stdout ?? ''}${selftest.stderr ?? ''}`.trim().slice(0, 4000),
              selftestError: selftest.error ? selftest.error.message : null,
            };
            break;
          }
        }
        if (targetedFailure) {
          await rollback(applied);
          stop('FOUNDATION_UPDATE_TARGET_SELFTEST_FAILED', targetedFailure);
        } else {
          if (targetedChecks.length > 0) {
            add('PASS', 'FOUNDATION_UPDATE_TARGET_SELFTESTS_PASS', {
              targetedSelftests: targetedChecks.map(check => check.id),
            });
          }
          add('PASS', 'FOUNDATION_UPDATE_APPLIED', {
            fromVersion,
            sourceVersion,
            fromCommit,
            sourceCommit,
            targetBranch,
            updatedFiles: plan.length,
            create: createdCount,
            replace: replacedCount,
            delete: deletedCount,
            unchanged: unchangedCount,
            claudeAdapter: claudeAdapterConfigured ? 'CURRENT' : 'NOT_CONFIGURED',
          });
        }
      }
    } catch (error) {
      await rollback(applied);
      stop('FOUNDATION_UPDATE_APPLY_FAILED', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}

const result = findings.some((f) => f.status === 'STOP') ? 'STOP' : 'PASS';
console.log(JSON.stringify({
  result,
  apply,
  fromVersion,
  sourceVersion,
  fromCommit,
  sourceCommit,
  targetBranch,
  canonicalFromCount,
  canonicalSourceCount,
  claudeAdapterConfigured,
  claudeFromCount,
  claudeSourceCount,
  plannedCount: plan.length,
  createdCount,
  replacedCount,
  deletedCount,
  unchangedCount,
  targetedSelftestCount,
  targetedSelftestIds,
  findings,
}, null, jsonOnly ? 0 : 2));
process.exit(result === 'PASS' ? 0 : 2);
