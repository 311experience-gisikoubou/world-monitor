#!/usr/bin/env node
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { collectManagedSurface } from './managed-surface.mjs';

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
