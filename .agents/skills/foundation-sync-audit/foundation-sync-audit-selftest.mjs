#!/usr/bin/env node
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gate = resolve(gateArg);

const root = await mkdtemp(join(tmpdir(), 'foundation-sync-audit-'));
const source = join(root, 'source');
const target = join(root, 'target');

function wrapper(name, description = `${name} description`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name} wrapper\n\n../../../.agents/skills/${name}/SKILL.md\n`;
}
function canonical(name, description = `${name} description`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function seedSource() {
  await mkdir(join(source, '.agents', 'skills', 'preflight-audit'), { recursive: true });
  await mkdir(join(source, '.agents', 'skills', 'test-gate'), { recursive: true });
  await mkdir(join(source, 'templates', '.claude', 'skills', 'preflight-audit'), { recursive: true });
  await mkdir(join(source, 'templates', '.claude', 'skills', 'test-gate'), { recursive: true });
  await writeFile(join(source, 'VERSION'), '1.2.3\n');
  await writeFile(join(source, 'AGENTS.md'), '# agents\n');
  await writeFile(join(source, '.agents', 'skills', 'README.md'), '# skills\n');
  await writeFile(join(source, '.agents', 'skills', 'preflight-audit', 'SKILL.md'), canonical('preflight-audit'));
  await writeFile(join(source, '.agents', 'skills', 'test-gate', 'SKILL.md'), canonical('test-gate'));
  await writeFile(join(source, 'templates', '.claude', 'skills', 'preflight-audit', 'SKILL.md.template'), wrapper('preflight-audit'));
  await writeFile(join(source, 'templates', '.claude', 'skills', 'test-gate', 'SKILL.md.template'), wrapper('test-gate'));
}

async function syncTarget({ claude = true } = {}) {
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, '.agents', 'skills', 'preflight-audit'), { recursive: true });
  await mkdir(join(target, '.agents', 'skills', 'test-gate'), { recursive: true });
  await copyFile(join(source, 'AGENTS.md'), join(target, 'AGENTS.md'));
  await copyFile(join(source, '.agents', 'skills', 'README.md'), join(target, '.agents', 'skills', 'README.md'));
  await copyFile(join(source, '.agents', 'skills', 'preflight-audit', 'SKILL.md'), join(target, '.agents', 'skills', 'preflight-audit', 'SKILL.md'));
  await copyFile(join(source, '.agents', 'skills', 'test-gate', 'SKILL.md'), join(target, '.agents', 'skills', 'test-gate', 'SKILL.md'));
  await writeFile(join(target, 'AGENTS.local.md'), '# local only\n');
  if (claude) {
    await mkdir(join(target, '.claude', 'skills', 'preflight-audit'), { recursive: true });
    await mkdir(join(target, '.claude', 'skills', 'test-gate'), { recursive: true });
    await copyFile(join(source, 'templates', '.claude', 'skills', 'preflight-audit', 'SKILL.md.template'), join(target, '.claude', 'skills', 'preflight-audit', 'SKILL.md'));
    await copyFile(join(source, 'templates', '.claude', 'skills', 'test-gate', 'SKILL.md.template'), join(target, '.claude', 'skills', 'test-gate', 'SKILL.md'));
  }
}

function run(src = source, dst = target) {
  return spawnSync(process.execPath, [gate, '--json', '--source-root', src, '--target-root', dst], { encoding: 'utf8' });
}
function expectPass(code = 'FOUNDATION_SYNC_MATCH') {
  const r = run();
  if (r.status !== 0 || !r.stdout.includes(code)) {
    throw new Error(`expected PASS: ${r.stdout} ${r.stderr}`);
  }
}
function expectStop(code) {
  const r = run();
  if (r.status === 0) throw new Error(`expected STOP for ${code}`);
  if (!r.stdout.includes(code)) throw new Error(`missing ${code}: ${r.stdout}`);
}

try {
  await seedSource();
  await syncTarget();
  expectPass();

  await writeFile(join(target, '.agents', 'skills', 'preflight-audit', 'SKILL.md'), '# stale\n');
  expectStop('FOUNDATION_SYNC_STALE');

  await syncTarget();
  await rm(join(target, '.agents', 'skills', 'preflight-audit', 'SKILL.md'));
  expectStop('FOUNDATION_SYNC_MISSING');

  await syncTarget();
  await writeFile(join(target, '.agents', 'skills', 'local-only.md'), '# repository-local skill\n');
  expectPass();

  await syncTarget();
  await writeFile(join(target, '.claude', 'skills', 'preflight-audit', 'SKILL.md'), '# stale wrapper\n');
  expectStop('FOUNDATION_CLAUDE_ADAPTER_STALE');

  await syncTarget();
  await rm(join(target, '.claude', 'skills', 'test-gate', 'SKILL.md'));
  expectStop('FOUNDATION_CLAUDE_ADAPTER_MISSING');

  await syncTarget();
  await mkdir(join(target, '.claude', 'skills', 'local-only'), { recursive: true });
  await writeFile(join(target, '.claude', 'skills', 'local-only', 'SKILL.md'), '# local wrapper\n');
  expectPass();

  await syncTarget({ claude: false });
  expectPass('FOUNDATION_CLAUDE_ADAPTER_NOT_CONFIGURED');

  await syncTarget();
  await rm(join(source, 'templates', '.claude', 'skills', 'test-gate', 'SKILL.md.template'));
  expectStop('FOUNDATION_SOURCE_CLAUDE_WRAPPER_MISSING');

  await writeFile(join(source, 'templates', '.claude', 'skills', 'test-gate', 'SKILL.md.template'), wrapper('test-gate', 'stale description'));
  expectStop('FOUNDATION_SOURCE_CLAUDE_WRAPPER_DRIFT');

  await writeFile(join(source, 'templates', '.claude', 'skills', 'test-gate', 'SKILL.md.template'), wrapper('test-gate'));
  await rm(join(source, 'VERSION'));
  expectStop('FOUNDATION_SOURCE_VERSION_MISSING');

  console.log('foundation-sync-audit selftest: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
