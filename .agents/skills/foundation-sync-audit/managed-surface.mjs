import { readdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { INDEX_TEMPLATE } from './entrypoint-renderer.mjs';

function normalizeRelative(path) {
  return path.split(sep).join('/');
}
async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
async function collectDirectory(root, sourceRelative, targetRelative, entries) {
  const start = resolve(root, sourceRelative);
  if (!(await isDirectory(start))) return;
  const rows = await readdir(start, { withFileTypes: true });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  for (const row of rows) {
    const sourceChild = normalizeRelative(sourceRelative + '/' + row.name);
    const targetChild = normalizeRelative(targetRelative + '/' + row.name);
    if (row.isDirectory()) await collectDirectory(root, sourceChild, targetChild, entries);
    else if (row.isFile()) entries.set(targetChild, resolve(root, sourceChild));
  }
}
export async function isLayeredFoundation(root) {
  return isFile(resolve(root, INDEX_TEMPLATE));
}
export async function collectManagedSurface(rootRaw) {
  const root = resolve(rootRaw);
  const entries = new Map();
  const agents = resolve(root, 'AGENTS.md');
  if (await isFile(agents)) entries.set('AGENTS.md', agents);
  await collectDirectory(root, '.agents/skills', '.agents/skills', entries);

  if (!(await isLayeredFoundation(root))) return entries;

  for (const rel of ['CORE.md', 'OPERATIONS.md']) {
    const path = resolve(root, rel);
    if (await isFile(path)) entries.set(rel, path);
  }
  await collectDirectory(root, 'roles', 'roles', entries);
  await collectDirectory(root, 'learnings', 'learnings', entries);

  const adapters = [
    ['templates/.claude/CLAUDE.md.template', '.claude/CLAUDE.md'],
    ['templates/GEMINI.md.template', 'GEMINI.md'],
    ['templates/.agents/rules/ai-foundation.md.template', '.agents/rules/ai-foundation.md'],
  ];
  for (const [sourceRel, targetRel] of adapters) {
    const path = resolve(root, sourceRel);
    if (await isFile(path)) entries.set(targetRel, path);
  }
  return entries;
}
export const MANAGED_DIRECTORY_ROOTS = ['.agents/skills', 'roles', 'learnings'];

export const MANAGED_FIXED_TARGETS = new Set([
  'AGENTS.md',
  'CORE.md',
  'OPERATIONS.md',
  'GEMINI.md',
  '.claude/CLAUDE.md',
  '.agents/rules/ai-foundation.md',
]);
export const MANAGED_TARGET_PREFIXES = ['.agents/skills/', 'roles/', 'learnings/', '.claude/skills/'];

export function isManagedTargetPath(path) {
  return typeof path === 'string'
    && (MANAGED_FIXED_TARGETS.has(path) || MANAGED_TARGET_PREFIXES.some(prefix => path.startsWith(prefix)));
}
