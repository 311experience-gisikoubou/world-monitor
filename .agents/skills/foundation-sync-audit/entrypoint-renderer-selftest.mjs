#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENTS_MAX_BYTES,
  ANTIGRAVITY_TEMPLATE,
  CLAUDE_TEMPLATE,
  GEMINI_TEMPLATE,
  INDEX_TEMPLATE,
  coreBody,
  renderAgents,
  renderAntigravity,
  verifyEntrypointSources,
  writeEntrypoints,
} from './entrypoint-renderer.mjs';

const core = '# CORE.md\n\n## Safety\n\n- never weaken safety\n- no secrets\n';
const index = '### Index\n\n- read AGENTS.local.md\n';

assert.equal(coreBody(core).startsWith('## Safety'), true);
const agentsA = renderAgents(core, index);
const agentsB = renderAgents(core.replaceAll('\n', '\r\n'), index.replaceAll('\n', '\r\n'));
assert.equal(agentsA, agentsB);
assert.equal(agentsA.includes('never weaken safety'), true);
assert.equal(Buffer.byteLength(agentsA, 'utf8') < AGENTS_MAX_BYTES, true);
assert.equal(renderAntigravity(core).includes('no secrets'), true);

const root = await mkdtemp(join(tmpdir(), 'foundation-entrypoints-'));
try {
  async function put(rel, content) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  await put('CORE.md', core);
  await put(INDEX_TEMPLATE, index);
  await put(CLAUDE_TEMPLATE, '# Claude\n\n@../AGENTS.md\n@../AGENTS.local.md\n');
  await put(GEMINI_TEMPLATE, '# Gemini\n\n@./AGENTS.md\n@./AGENTS.local.md\n');

  const written = await writeEntrypoints(root);
  assert.equal(written.ok, true);
  assert.equal(written.code, 'ENTRYPOINT_SOURCE_CURRENT');
  const firstAgents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  const firstRule = await readFile(join(root, ANTIGRAVITY_TEMPLATE), 'utf8');
  const second = await writeEntrypoints(root);
  assert.equal(second.ok, true);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), firstAgents);
  assert.equal(await readFile(join(root, ANTIGRAVITY_TEMPLATE), 'utf8'), firstRule);

  await writeFile(join(root, 'AGENTS.md'), firstAgents + '\ndrift\n', 'utf8');
  const drift = await verifyEntrypointSources(root);
  assert.equal(drift.ok, false);
  assert.equal(drift.errors.includes('AGENTS_GENERATED_DRIFT'), true);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('ENTRYPOINT_RENDERER_SELFTEST=PASS');
