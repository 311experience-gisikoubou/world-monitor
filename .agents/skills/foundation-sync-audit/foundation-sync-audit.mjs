#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import process from 'node:process';

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

function normalizeRelative(path) {
  return path.split(sep).join('/');
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function hashFile(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function collectFiles(startPath, prefix = '') {
  const files = new Map();
  if (!(await isDirectory(startPath))) return files;
  const entries = await readdir(startPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(startPath, entry.name);
    const rel = normalizeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(absolute, rel);
      for (const [k, v] of nested) files.set(k, v);
    } else if (entry.isFile()) {
      files.set(rel, await hashFile(absolute));
    }
  }
  return files;
}

async function collectCanonicalSyncSet(root) {
  const set = new Map();
  const agents = resolve(root, 'AGENTS.md');
  if (await isFile(agents)) set.set('AGENTS.md', await hashFile(agents));

  const skillsRoot = resolve(root, '.agents', 'skills');
  const skills = await collectFiles(skillsRoot, '.agents/skills');
  for (const [k, v] of skills) set.set(k, v);
  return set;
}

function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return {};
  const result = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '---') break;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

async function collectCanonicalSkillMetadata(root) {
  const skillsRoot = resolve(root, '.agents', 'skills');
  const result = new Map();
  if (!(await isDirectory(skillsRoot))) return result;
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = resolve(skillsRoot, entry.name, 'SKILL.md');
    if (!(await isFile(skillPath))) continue;
    const text = await readFile(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(text);
    result.set(entry.name, {
      name: frontmatter.name || '',
      description: frontmatter.description || '',
    });
  }
  return result;
}

async function collectClaudeTemplates(root) {
  const templateRoot = resolve(root, 'templates', '.claude', 'skills');
  const result = new Map();
  if (!(await isDirectory(templateRoot))) return result;
  const entries = await readdir(templateRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const templatePath = resolve(templateRoot, entry.name, 'SKILL.md.template');
    if (!(await isFile(templatePath))) continue;
    const text = await readFile(templatePath, 'utf8');
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
let claudeAdapterConfigured = false;
let claudeTemplateCount = 0;
let claudeTargetCount = 0;
let claudeMissingCount = 0;
let claudeStaleCount = 0;
let claudeExtraCount = 0;
let sourceClaudeWrapperMissingCount = 0;
let sourceClaudeWrapperDriftCount = 0;

if (!findings.some((f) => f.status === 'STOP')) {
  const sourceRoot = resolve(sourceRootRaw);
  const targetRoot = resolve(targetRootRaw);

  if (!(await isDirectory(sourceRoot))) add('STOP', 'FOUNDATION_SOURCE_ROOT_NOT_FOUND');
  if (!(await isDirectory(targetRoot))) add('STOP', 'FOUNDATION_TARGET_ROOT_NOT_FOUND');

  if (!findings.some((f) => f.status === 'STOP')) {
    const versionPath = resolve(sourceRoot, 'VERSION');
    if (!(await isFile(versionPath))) {
      add('STOP', 'FOUNDATION_SOURCE_VERSION_MISSING');
    } else {
      sourceVersion = (await readFile(versionPath, 'utf8')).trim();
      if (!sourceVersion) add('STOP', 'FOUNDATION_SOURCE_VERSION_EMPTY');
    }

    const source = await collectCanonicalSyncSet(sourceRoot);
    const target = await collectCanonicalSyncSet(targetRoot);
    sourceCount = source.size;
    targetCount = target.size;

    if (!source.has('AGENTS.md')) add('STOP', 'FOUNDATION_SOURCE_AGENTS_MISSING');
    if (![...source.keys()].some((p) => p.startsWith('.agents/skills/'))) {
      add('STOP', 'FOUNDATION_SOURCE_SKILLS_MISSING');
    }

    for (const [path, hash] of source) {
      if (!target.has(path)) missingCount += 1;
      else if (target.get(path) !== hash) staleCount += 1;
    }
    for (const path of target.keys()) {
      if (!source.has(path)) extraCount += 1;
    }

    if (missingCount > 0) add('STOP', 'FOUNDATION_SYNC_MISSING', { count: missingCount });
    if (staleCount > 0) add('STOP', 'FOUNDATION_SYNC_STALE', { count: staleCount });
    if (extraCount > 0) add('INFO', 'FOUNDATION_TARGET_EXTRA_PRESENT', { count: extraCount });

    const canonicalSkills = await collectCanonicalSkillMetadata(sourceRoot);
    const claudeTemplates = await collectClaudeTemplates(sourceRoot);
    claudeTemplateCount = claudeTemplates.size;

    for (const [skillName, canonical] of canonicalSkills) {
      const wrapper = claudeTemplates.get(skillName);
      if (!wrapper) {
        sourceClaudeWrapperMissingCount += 1;
        continue;
      }
      const expectedReference = `../../../.agents/skills/${skillName}/SKILL.md`;
      if (
        wrapper.frontmatter.name !== canonical.name
        || wrapper.frontmatter.description !== canonical.description
        || !wrapper.text.includes(expectedReference)
      ) {
        sourceClaudeWrapperDriftCount += 1;
      }
    }
    for (const skillName of claudeTemplates.keys()) {
      if (!canonicalSkills.has(skillName)) sourceClaudeWrapperDriftCount += 1;
    }

    if (sourceClaudeWrapperMissingCount > 0) {
      add('STOP', 'FOUNDATION_SOURCE_CLAUDE_WRAPPER_MISSING', { count: sourceClaudeWrapperMissingCount });
    }
    if (sourceClaudeWrapperDriftCount > 0) {
      add('STOP', 'FOUNDATION_SOURCE_CLAUDE_WRAPPER_DRIFT', { count: sourceClaudeWrapperDriftCount });
    }

    const targetClaudeRoot = resolve(targetRoot, '.claude', 'skills');
    claudeAdapterConfigured = await isDirectory(targetClaudeRoot) || await isFile(resolve(targetRoot, 'CLAUDE.md'));

    if (claudeAdapterConfigured && sourceClaudeWrapperMissingCount === 0 && sourceClaudeWrapperDriftCount === 0) {
      const targetClaudeFiles = await collectFiles(targetClaudeRoot, '.claude/skills');
      claudeTargetCount = targetClaudeFiles.size;
      const expectedPaths = new Map();
      for (const wrapper of claudeTemplates.values()) {
        expectedPaths.set(wrapper.expectedTargetPath, wrapper.hash);
      }

      for (const [path, hash] of expectedPaths) {
        if (!targetClaudeFiles.has(path)) claudeMissingCount += 1;
        else if (targetClaudeFiles.get(path) !== hash) claudeStaleCount += 1;
      }
      for (const path of targetClaudeFiles.keys()) {
        if (!expectedPaths.has(path)) claudeExtraCount += 1;
      }

      if (claudeMissingCount > 0) add('STOP', 'FOUNDATION_CLAUDE_ADAPTER_MISSING', { count: claudeMissingCount });
      if (claudeStaleCount > 0) add('STOP', 'FOUNDATION_CLAUDE_ADAPTER_STALE', { count: claudeStaleCount });
      if (claudeExtraCount > 0) add('INFO', 'FOUNDATION_CLAUDE_ADAPTER_EXTRA_PRESENT', { count: claudeExtraCount });
    } else if (!claudeAdapterConfigured) {
      add('INFO', 'FOUNDATION_CLAUDE_ADAPTER_NOT_CONFIGURED');
    }
  }
}

if (!findings.some((f) => f.status === 'STOP')) {
  add('PASS', 'FOUNDATION_SYNC_MATCH', {
    sourceVersion,
    synchronizedFiles: sourceCount,
    claudeAdapter: claudeAdapterConfigured ? 'CURRENT' : 'NOT_CONFIGURED',
    claudeWrappersChecked: claudeAdapterConfigured ? claudeTemplateCount : 0,
  });
}

const result = findings.some((f) => f.status === 'STOP') ? 'STOP' : 'PASS';
const output = {
  result,
  sourceVersion,
  sourceCount,
  targetCount,
  missingCount,
  staleCount,
  extraCount,
  claudeAdapterConfigured,
  claudeTemplateCount,
  claudeTargetCount,
  claudeMissingCount,
  claudeStaleCount,
  claudeExtraCount,
  sourceClaudeWrapperMissingCount,
  sourceClaudeWrapperDriftCount,
  findings,
};
console.log(JSON.stringify(output, null, jsonOnly ? 0 : 2));
process.exit(result === 'PASS' ? 0 : 2);
