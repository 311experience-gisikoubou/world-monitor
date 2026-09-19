#!/usr/bin/env node
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

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
  const files = [];
  if (!(await isDirectory(startPath))) return files;
  const entries = await readdir(startPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = resolve(startPath, entry.name);
    const rel = normalizeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, rel));
    else if (entry.isFile()) files.push({ absolute, relative: rel });
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

if (!sourceRootRaw) stop('FOUNDATION_BOOTSTRAP_SOURCE_ROOT_REQUIRED');
if (!targetRootRaw) stop('FOUNDATION_BOOTSTRAP_TARGET_ROOT_REQUIRED');

let sourceRoot = null;
let targetRoot = null;
let sourceVersion = null;
let sourceCommit = null;
let targetBranch = null;
let claudeAdapterConfigured = false;
let plannedCount = 0;
let identicalCount = 0;
let createdCount = 0;
let canonicalCount = 0;
let claudeWrapperCount = 0;
const plan = [];

if (!findings.some((f) => f.status === 'STOP')) {
  sourceRoot = resolve(sourceRootRaw);
  targetRoot = resolve(targetRootRaw);
  if (sourceRoot === targetRoot) stop('FOUNDATION_BOOTSTRAP_SOURCE_TARGET_SAME');
  if (!(await isDirectory(sourceRoot))) stop('FOUNDATION_BOOTSTRAP_SOURCE_ROOT_NOT_FOUND');
  if (!(await isDirectory(targetRoot))) stop('FOUNDATION_BOOTSTRAP_TARGET_ROOT_NOT_FOUND');
}

if (!findings.some((f) => f.status === 'STOP')) {
  const versionPath = resolve(sourceRoot, 'VERSION');
  const agentsPath = resolve(sourceRoot, 'AGENTS.md');
  const skillsRoot = resolve(sourceRoot, '.agents', 'skills');
  if (!(await isFile(versionPath))) stop('FOUNDATION_BOOTSTRAP_SOURCE_VERSION_MISSING');
  else {
    sourceVersion = (await readFile(versionPath, 'utf8')).trim();
    if (!sourceVersion) stop('FOUNDATION_BOOTSTRAP_SOURCE_VERSION_EMPTY');
  }
  if (!(await isFile(agentsPath))) stop('FOUNDATION_BOOTSTRAP_SOURCE_AGENTS_MISSING');
  if (!(await isDirectory(skillsRoot))) stop('FOUNDATION_BOOTSTRAP_SOURCE_SKILLS_MISSING');
  const sourceGit = git(sourceRoot, ['rev-parse', 'HEAD']);
  if (sourceGit.status === 0) sourceCommit = sourceGit.stdout.trim() || null;
}

if (!findings.some((f) => f.status === 'STOP')) {
  const top = git(targetRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) stop('FOUNDATION_BOOTSTRAP_TARGET_NOT_GIT_REPOSITORY');
  else if (resolve(top.stdout.trim()) !== targetRoot) stop('FOUNDATION_BOOTSTRAP_TARGET_NOT_REPOSITORY_ROOT');

  const branch = git(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.status !== 0) stop('FOUNDATION_BOOTSTRAP_TARGET_BRANCH_UNKNOWN');
  else {
    targetBranch = branch.stdout.trim();
    if (!targetBranch || targetBranch === 'HEAD') stop('FOUNDATION_BOOTSTRAP_DETACHED_HEAD');
    else if (targetBranch === 'main' || targetBranch === 'master') stop('FOUNDATION_BOOTSTRAP_PROTECTED_BRANCH', { branch: targetBranch });
  }

  const status = git(targetRoot, ['status', '--porcelain']);
  if (status.status !== 0) stop('FOUNDATION_BOOTSTRAP_GIT_STATUS_FAILED');
  else if (status.stdout.trim()) stop('FOUNDATION_BOOTSTRAP_DIRTY_WORKTREE');
}

if (!findings.some((f) => f.status === 'STOP')) {
  const canonical = [
    { absolute: resolve(sourceRoot, 'AGENTS.md'), relative: 'AGENTS.md' },
    ...await collectFiles(resolve(sourceRoot, '.agents', 'skills'), '.agents/skills'),
  ];
  canonicalCount = canonical.length;
  claudeAdapterConfigured = await isFile(resolve(targetRoot, 'CLAUDE.md'))
    || await isDirectory(resolve(targetRoot, '.claude', 'skills'));

  const wrapperTemplates = claudeAdapterConfigured
    ? await collectFiles(resolve(sourceRoot, 'templates', '.claude', 'skills'), 'templates/.claude/skills')
    : [];
  const wrappers = [];
  for (const entry of wrapperTemplates) {
    const targetRelative = wrapperTemplateToTarget(entry.relative);
    if (targetRelative) wrappers.push({ absolute: entry.absolute, relative: targetRelative });
  }
  claudeWrapperCount = wrappers.length;

  for (const entry of [...canonical, ...wrappers]) {
    const destination = resolve(targetRoot, entry.relative);
    if (await isFile(destination)) {
      if (await sameBytes(entry.absolute, destination)) {
        identicalCount += 1;
        continue;
      }
      stop('FOUNDATION_BOOTSTRAP_TARGET_CONFLICT', { path: entry.relative });
      continue;
    }
    if (await isDirectory(destination)) {
      stop('FOUNDATION_BOOTSTRAP_TARGET_PATH_CONFLICT', { path: entry.relative });
      continue;
    }
    plan.push({ source: entry.absolute, destination, relative: entry.relative });
  }
  plannedCount = plan.length;
}

async function rollbackCreated(created) {
  for (const file of [...created].reverse()) {
    try { await rm(file, { force: true }); } catch { /* best effort */ }
  }
}

if (!findings.some((f) => f.status === 'STOP')) {
  if (!apply) {
    add('PASS', 'FOUNDATION_BOOTSTRAP_PLAN_READY', {
      sourceVersion,
      targetBranch,
      plannedFiles: plannedCount,
      identicalFiles: identicalCount,
      claudeAdapter: claudeAdapterConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    });
  } else {
    const created = [];
    try {
      for (const entry of plan) {
        await mkdir(dirname(entry.destination), { recursive: true });
        await copyFile(entry.source, entry.destination);
        created.push(entry.destination);
      }
      createdCount = created.length;

      const auditPath = resolve(sourceRoot, '.agents', 'skills', 'foundation-sync-audit', 'foundation-sync-audit.mjs');
      if (!(await isFile(auditPath))) {
        await rollbackCreated(created);
        createdCount = 0;
        stop('FOUNDATION_BOOTSTRAP_AUDIT_GATE_MISSING');
      } else {
        const audit = spawnSync(process.execPath, [auditPath, '--json', '--source-root', sourceRoot, '--target-root', targetRoot], { encoding: 'utf8' });
        if (audit.status !== 0) {
          await rollbackCreated(created);
          createdCount = 0;
          stop('FOUNDATION_BOOTSTRAP_POST_AUDIT_FAILED', {
            auditExit: audit.status,
            auditResult: audit.stdout.trim().slice(0, 4000),
          });
        } else {
          add('PASS', 'FOUNDATION_BOOTSTRAP_APPLIED', {
            sourceVersion,
            sourceCommit,
            targetBranch,
            createdFiles: createdCount,
            identicalFiles: identicalCount,
            claudeAdapter: claudeAdapterConfigured ? 'CURRENT' : 'NOT_CONFIGURED',
          });
        }
      }
    } catch (error) {
      await rollbackCreated(created);
      createdCount = 0;
      stop('FOUNDATION_BOOTSTRAP_COPY_FAILED', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}

const result = findings.some((f) => f.status === 'STOP') ? 'STOP' : 'PASS';
console.log(JSON.stringify({
  result,
  apply,
  sourceVersion,
  sourceCommit,
  targetBranch,
  canonicalCount,
  claudeAdapterConfigured,
  claudeWrapperCount,
  plannedCount,
  identicalCount,
  createdCount,
  findings,
}, null, jsonOnly ? 0 : 2));
process.exit(result === 'PASS' ? 0 : 2);
