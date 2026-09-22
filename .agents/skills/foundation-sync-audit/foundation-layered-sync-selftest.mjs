#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeEntrypoints } from './entrypoint-renderer.mjs';
import { collectManagedSurface } from './managed-surface.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const audit = join(here, 'foundation-sync-audit.mjs');
const root = await mkdtemp(join(tmpdir(), 'foundation-layered-sync-'));
const source = join(root, 'source');
const target = join(root, 'target');

async function put(base, rel, content) {
  const path = join(base, ...rel.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}
function runAudit() {
  return spawnSync(process.execPath, [
    audit, '--json', '--source-root', source, '--target-root', target,
  ], { encoding: 'utf8' });
}
function expectPass() {
  const out = runAudit();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /FOUNDATION_SYNC_MATCH/);
}
function expectStop(code) {
  const out = runAudit();
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, new RegExp(code));
}
try {
  await put(source, 'VERSION', '1.0.0-test\n');
  await put(source, 'CORE.md', '# CORE.md\n\n## Safety\n\n- keep safety\n');
  await put(source, 'OPERATIONS.md', '# Operations\n');
  await put(source, 'PROJECT_COMPLETION.md', '# Completion\n');
  await put(source, '.agents/skills/README.md', '# Skills\n');
  await put(source, 'roles/GEMINI.md', '# Gemini role\n');
  await put(source, 'learnings/INDEX.md', '# Learnings\n');
  await put(source, 'templates/AGENTS.index.md.template', '## Index\n\n- read AGENTS.local.md\n');
  await put(
    source,
    'templates/.claude/CLAUDE.md.template',
    '# Claude\n\n@../AGENTS.md\n@../AGENTS.local.md\n',
  );
  await put(
    source,
    'templates/GEMINI.md.template',
    '# Gemini\n\n@./AGENTS.md\n@./AGENTS.local.md\n',
  );
  await writeEntrypoints(source);

  const localCompletion = '# Application completion\n\n- local source of truth\n';
  await put(target, 'PROJECT_COMPLETION.md', localCompletion);

  const managed = await collectManagedSurface(source);
  assert.equal(managed.has('PROJECT_COMPLETION.md'), false, 'application PROJECT_COMPLETION.md must stay repository-local');
  for (const [relative, sourcePath] of managed) {
    const destination = join(target, ...relative.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
  }

  expectPass();
  assert.equal(
    await readFile(join(target, 'PROJECT_COMPLETION.md'), 'utf8'),
    localCompletion,
    'Foundation sync must not overwrite application PROJECT_COMPLETION.md',
  );

  await unlink(join(target, 'GEMINI.md'));
  expectStop('FOUNDATION_SYNC_MISSING');
  await copyFile(join(source, 'templates', 'GEMINI.md.template'), join(target, 'GEMINI.md'));

  await writeFile(
    join(target, '.agents', 'rules', 'ai-foundation.md'),
    '# stale antigravity rule\n',
    'utf8',
  );
  expectStop('FOUNDATION_SYNC_STALE');

  console.log('foundation-layered-sync selftest: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
