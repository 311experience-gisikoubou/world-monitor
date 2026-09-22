#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import process from 'node:process';
import { collectManagedSurface, MANAGED_DIRECTORY_ROOTS, isLayeredFoundation } from './managed-surface.mjs';
import { verifyEntrypointSources } from './entrypoint-renderer.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const sourceRootRaw = argValue('--source-root');
const targetRootRaw = argValue('--target-root');
const jsonOnly = args.includes('--json');

const findings = [];
function add(status, code, detail = {}) { findings.push({ status, code, ...detail }); }
function normalizeRelative(path) { return path.split(sep).join('/'); }
async function isFile(path) { try { return (await stat(path)).isFile(); } catch { return false; } }
async function isDirectory(path) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
async function collectFiles(startPath, prefix = '') {
  const files = new Map();
  if (!(await isDirectory(startPath))) return files;
  const entries = await readdir(startPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(startPath, entry.name);
    const rel = normalizeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of await collectFiles(absolute, rel)) files.set(k, v);
    } else if (entry.isFile()) files.set(rel, await hashFile(absolute));
  }
  return files;
}
function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return {};
  const result = {};
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') break;
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}
async function collectCanonicalSkillMetadata(root) {
  const result = new Map();
  const skillsRoot = resolve(root, '.agents', 'skills');
  if (!(await isDirectory(skillsRoot))) return result;
  for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = resolve(skillsRoot, entry.name, 'SKILL.md');
    if (!(await isFile(p))) continue;
    const fm = parseFrontmatter(await readFile(p, 'utf8'));
    result.set(entry.name, { name: fm.name || '', description: fm.description || '' });
  }
  return result;
}
async function collectClaudeTemplates(root) {
  const result = new Map();
  const templateRoot = resolve(root, 'templates', '.claude', 'skills');
  if (!(await isDirectory(templateRoot))) return result;
  for (const entry of await readdir(templateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = resolve(templateRoot, entry.name, 'SKILL.md.template');
    if (!(await isFile(p))) continue;
    const text = await readFile(p, 'utf8');
    result.set(entry.name, {
      hash: createHash('sha256').update(Buffer.from(text)).digest('hex'),
      text,
      frontmatter: parseFrontmatter(text),
      expectedTargetPath: `.claude/skills/${entry.name}/SKILL.md`,
    });
  }
  return result;
}

if (!sourceRootRaw) add('STOP', 'FOUNDATION_SOURCE_ROOT_REQUIRED');
if (!targetRootRaw) add('STOP', 'FOUNDATION_TARGET_ROOT_REQUIRED');

let sourceVersion = null;
let sourceCount = 0;
let targetCount = 0;
let missingCount = 0;
let staleCount = 0;
let extraCount = 0;
let entrypointModel = 'LEGACY';
let agentsBytes = null;
let claudeAdapterConfigured = false;
let claudeTemplateCount = 0;
let claudeTargetCount = 0;
let claudeMissingCount = 0;
let claudeStaleCount = 0;
let claudeExtraCount = 0;
let sourceClaudeWrapperMissingCount = 0;
let sourceClaudeWrapperDriftCount = 0;

if (!findings.some(f => f.status === 'STOP')) {
  const sourceRoot = resolve(sourceRootRaw);
  const targetRoot = resolve(targetRootRaw);
  const selfAudit = sourceRoot === targetRoot;
  if (!(await isDirectory(sourceRoot))) add('STOP', 'FOUNDATION_SOURCE_ROOT_NOT_FOUND');
  if (!(await isDirectory(targetRoot))) add('STOP', 'FOUNDATION_TARGET_ROOT_NOT_FOUND');

  if (!findings.some(f => f.status === 'STOP')) {
    const versionPath = resolve(sourceRoot, 'VERSION');
    if (!(await isFile(versionPath))) add('STOP', 'FOUNDATION_SOURCE_VERSION_MISSING');
    else {
      sourceVersion = (await readFile(versionPath, 'utf8')).trim();
      if (!sourceVersion) add('STOP', 'FOUNDATION_SOURCE_VERSION_EMPTY');
    }

    if (await isLayeredFoundation(sourceRoot)) {
      entrypointModel = 'LAYERED_V1';
      const entryCheck = await verifyEntrypointSources(sourceRoot);
      agentsBytes = entryCheck.agentsBytes ?? null;
      if (!entryCheck.ok) add('STOP', 'FOUNDATION_ENTRYPOINT_SOURCE_INVALID', { code: entryCheck.code, errors: entryCheck.errors ?? [] });
    }

    const source = await collectManagedSurface(sourceRoot);
    sourceCount = source.size;
    if (!source.has('AGENTS.md')) add('STOP', 'FOUNDATION_SOURCE_AGENTS_MISSING');
    if (![...source.keys()].some(p => p.startsWith('.agents/skills/'))) add('STOP', 'FOUNDATION_SOURCE_SKILLS_MISSING');

    const expectedPaths = new Set(source.keys());
    for (const [relative, sourcePath] of source) {
      const directSourcePath = resolve(sourceRoot, relative);
      if (selfAudit && directSourcePath !== sourcePath) continue;
      const targetPath = resolve(targetRoot, relative);
      if (!(await isFile(targetPath))) {
        missingCount += 1;
        continue;
      }
      targetCount += 1;
      if ((await hashFile(sourcePath)) !== (await hashFile(targetPath))) staleCount += 1;
    }

    if (!selfAudit) {
      for (const managedRoot of MANAGED_DIRECTORY_ROOTS) {
        const actual = await collectFiles(resolve(targetRoot, managedRoot), managedRoot);
        for (const path of actual.keys()) {
          if (!expectedPaths.has(path)) extraCount += 1;
        }
      }
    }
    if (missingCount > 0) add('STOP', 'FOUNDATION_SYNC_MISSING', { count: missingCount });
    if (staleCount > 0) add('STOP', 'FOUNDATION_SYNC_STALE', { count: staleCount });
    if (extraCount > 0) add('INFO', 'FOUNDATION_TARGET_EXTRA_PRESENT', { count: extraCount });

    const canonicalSkills = await collectCanonicalSkillMetadata(sourceRoot);
    const claudeTemplates = await collectClaudeTemplates(sourceRoot);
    claudeTemplateCount = claudeTemplates.size;
    for (const [skillName, canonical] of canonicalSkills) {
      const wrapper = claudeTemplates.get(skillName);
      if (!wrapper) { sourceClaudeWrapperMissingCount += 1; continue; }
      const expectedReference = `../../../.agents/skills/${skillName}/SKILL.md`;
      if (wrapper.frontmatter.name !== canonical.name
        || wrapper.frontmatter.description !== canonical.description
        || !wrapper.text.includes(expectedReference)) sourceClaudeWrapperDriftCount += 1;
    }
    for (const skillName of claudeTemplates.keys()) if (!canonicalSkills.has(skillName)) sourceClaudeWrapperDriftCount += 1;
    if (sourceClaudeWrapperMissingCount > 0) add('STOP', 'FOUNDATION_SOURCE_CLAUDE_WRAPPER_MISSING', { count: sourceClaudeWrapperMissingCount });
    if (sourceClaudeWrapperDriftCount > 0) add('STOP', 'FOUNDATION_SOURCE_CLAUDE_WRAPPER_DRIFT', { count: sourceClaudeWrapperDriftCount });

    const targetClaudeRoot = resolve(targetRoot, '.claude', 'skills');
    claudeAdapterConfigured = await isDirectory(targetClaudeRoot);
    if (!selfAudit && claudeAdapterConfigured && sourceClaudeWrapperMissingCount === 0 && sourceClaudeWrapperDriftCount === 0) {
      const targetClaudeFiles = await collectFiles(targetClaudeRoot, '.claude/skills');
      claudeTargetCount = targetClaudeFiles.size;
      const expected = new Map([...claudeTemplates.values()].map(v => [v.expectedTargetPath, v.hash]));
      for (const [path, hash] of expected) {
        if (!targetClaudeFiles.has(path)) claudeMissingCount += 1;
        else if (targetClaudeFiles.get(path) !== hash) claudeStaleCount += 1;
      }
      for (const path of targetClaudeFiles.keys()) if (!expected.has(path)) claudeExtraCount += 1;
      if (claudeMissingCount > 0) add('STOP', 'FOUNDATION_CLAUDE_ADAPTER_MISSING', { count: claudeMissingCount });
      if (claudeStaleCount > 0) add('STOP', 'FOUNDATION_CLAUDE_ADAPTER_STALE', { count: claudeStaleCount });
      if (claudeExtraCount > 0) add('INFO', 'FOUNDATION_CLAUDE_ADAPTER_EXTRA_PRESENT', { count: claudeExtraCount });
    } else if (!selfAudit && !claudeAdapterConfigured) {
      add('INFO', 'FOUNDATION_CLAUDE_ADAPTER_NOT_CONFIGURED');
    }
  }
}
if (!findings.some(f => f.status === 'STOP')) {
  add('PASS', 'FOUNDATION_SYNC_MATCH', {
    sourceVersion,
    synchronizedFiles: sourceCount,
    entrypointModel,
    agentsBytes,
    claudeSkillWrappers: claudeAdapterConfigured ? 'CURRENT' : 'NOT_CONFIGURED',
  });
}
const result = findings.some(f => f.status === 'STOP') ? 'STOP' : 'PASS';
console.log(JSON.stringify({
  result, sourceVersion, sourceCount, targetCount, missingCount, staleCount, extraCount,
  entrypointModel, agentsBytes,
  claudeAdapterConfigured, claudeTemplateCount, claudeTargetCount,
  claudeMissingCount, claudeStaleCount, claudeExtraCount,
  sourceClaudeWrapperMissingCount, sourceClaudeWrapperDriftCount, findings,
}, null, jsonOnly ? 0 : 2));
process.exit(result === 'PASS' ? 0 : 2);
