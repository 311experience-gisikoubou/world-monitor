#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const bootstrapArg = process.argv[2];
const auditArg = process.argv[3];
if (!bootstrapArg || !auditArg) throw new Error('bootstrap path and audit path required');
const bootstrap = resolve(bootstrapArg);
const auditGate = resolve(auditArg);

const root = await mkdtemp(join(tmpdir(), 'foundation-bootstrap-selftest-'));
const source = join(root, 'source');

function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${command} failed: ${r.stdout} ${r.stderr}`);
  return r.stdout.trim();
}
function git(cwd, ...args) { return run('git', args, cwd); }
function wrapper(name, description = `${name} description`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n../../../.agents/skills/${name}/SKILL.md\n`;
}
function canonical(name, description = `${name} description`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function seedSource() {
  await mkdir(join(source, '.agents', 'skills', 'foundation-sync-audit'), { recursive: true });
  await mkdir(join(source, '.agents', 'skills', 'preflight-audit'), { recursive: true });
  await mkdir(join(source, 'templates', '.claude', 'skills', 'foundation-sync-audit'), { recursive: true });
  await mkdir(join(source, 'templates', '.claude', 'skills', 'preflight-audit'), { recursive: true });
  await writeFile(join(source, 'VERSION'), '1.2.3\n');
  await writeFile(join(source, 'AGENTS.md'), '# agents\n');
  await writeFile(join(source, '.agents', 'skills', 'README.md'), '# skills\n');
  await writeFile(join(source, '.agents', 'skills', 'foundation-sync-audit', 'SKILL.md'), canonical('foundation-sync-audit'));
  await copyFile(auditGate, join(source, '.agents', 'skills', 'foundation-sync-audit', 'foundation-sync-audit.mjs'));
  await writeFile(join(source, '.agents', 'skills', 'preflight-audit', 'SKILL.md'), canonical('preflight-audit'));
  await writeFile(join(source, 'templates', '.claude', 'skills', 'foundation-sync-audit', 'SKILL.md.template'), wrapper('foundation-sync-audit'));
  await writeFile(join(source, 'templates', '.claude', 'skills', 'preflight-audit', 'SKILL.md.template'), wrapper('preflight-audit'));
  git(root, 'init', '-b', 'source', source);
  git(source, 'config', 'user.email', 'selftest@example.invalid');
  git(source, 'config', 'user.name', 'selftest');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'seed source');
}

let targetCounter = 0;
async function initTarget({ branch = 'feature/test', claude = true, local = true } = {}) {
  targetCounter += 1;
  const target = join(root, `target-${targetCounter}`);
  await mkdir(target, { recursive: true });
  git(root, 'init', '-b', branch, target);
  git(target, 'config', 'user.email', 'selftest@example.invalid');
  git(target, 'config', 'user.name', 'selftest');
  await writeFile(join(target, 'README.md'), '# target\n');
  if (claude) await writeFile(join(target, 'CLAUDE.md'), '# claude\n');
  if (local) await writeFile(join(target, 'AGENTS.local.md'), '# local must survive\n');
  git(target, 'add', '.');
  git(target, 'commit', '-m', 'seed target');
  return target;
}

function bootstrapRun(target, extra = []) {
  return spawnSync(process.execPath, [bootstrap, '--json', '--source-root', source, '--target-root', target, ...extra], { encoding: 'utf8' });
}
function expectPass(target, code, extra = []) {
  const r = bootstrapRun(target, extra);
  if (r.status !== 0 || !r.stdout.includes(code)) throw new Error(`expected PASS ${code}: ${r.stdout} ${r.stderr}`);
}
function expectStop(target, code, extra = []) {
  const r = bootstrapRun(target, extra);
  if (r.status === 0 || !r.stdout.includes(code)) throw new Error(`expected STOP ${code}: ${r.stdout} ${r.stderr}`);
}

try {
  await seedSource();

  const dryTarget = await initTarget();
  expectPass(dryTarget, 'FOUNDATION_BOOTSTRAP_PLAN_READY');
  if (await readFile(join(dryTarget, 'AGENTS.local.md'), 'utf8') !== '# local must survive\n') throw new Error('AGENTS.local.md changed during plan');
  try {
    await readFile(join(dryTarget, 'AGENTS.md'));
    throw new Error('dry-run wrote AGENTS.md');
  } catch (error) {
    if (error instanceof Error && error.message === 'dry-run wrote AGENTS.md') throw error;
  }

  const applyTarget = await initTarget();
  expectPass(applyTarget, 'FOUNDATION_BOOTSTRAP_APPLIED', ['--apply']);
  if (await readFile(join(applyTarget, 'AGENTS.md'), 'utf8') !== '# agents\n') throw new Error('AGENTS.md not copied');
  if (await readFile(join(applyTarget, 'AGENTS.local.md'), 'utf8') !== '# local must survive\n') throw new Error('AGENTS.local.md overwritten');
  const wrapperText = await readFile(join(applyTarget, '.claude', 'skills', 'preflight-audit', 'SKILL.md'), 'utf8');
  if (!wrapperText.includes('../../../.agents/skills/preflight-audit/SKILL.md')) throw new Error('Claude wrapper not copied');

  const noClaudeTarget = await initTarget({ claude: false });
  expectPass(noClaudeTarget, 'FOUNDATION_BOOTSTRAP_APPLIED', ['--apply']);
  try {
    await readFile(join(noClaudeTarget, '.claude', 'skills', 'preflight-audit', 'SKILL.md'));
    throw new Error('wrapper copied without Claude config');
  } catch (error) {
    if (error instanceof Error && error.message === 'wrapper copied without Claude config') throw error;
  }

  const mainTarget = await initTarget({ branch: 'main' });
  expectStop(mainTarget, 'FOUNDATION_BOOTSTRAP_PROTECTED_BRANCH', ['--apply']);

  const dirtyTarget = await initTarget();
  await writeFile(join(dirtyTarget, 'README.md'), '# dirty\n');
  expectStop(dirtyTarget, 'FOUNDATION_BOOTSTRAP_DIRTY_WORKTREE', ['--apply']);

  const conflictTarget = await initTarget();
  await writeFile(join(conflictTarget, 'AGENTS.md'), '# stale\n');
  git(conflictTarget, 'add', 'AGENTS.md');
  git(conflictTarget, 'commit', '-m', 'seed stale foundation');
  expectStop(conflictTarget, 'FOUNDATION_BOOTSTRAP_TARGET_CONFLICT', ['--apply']);
  if (await readFile(join(conflictTarget, 'AGENTS.md'), 'utf8') !== '# stale\n') throw new Error('conflict file overwritten');

  const rollbackTarget = await initTarget();
  const wrapperPath = join(source, 'templates', '.claude', 'skills', 'preflight-audit', 'SKILL.md.template');
  await writeFile(wrapperPath, wrapper('preflight-audit', 'drifted description'));
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'make wrapper drift');
  expectStop(rollbackTarget, 'FOUNDATION_BOOTSTRAP_POST_AUDIT_FAILED', ['--apply']);
  try {
    await readFile(join(rollbackTarget, 'AGENTS.md'));
    throw new Error('rollback left AGENTS.md');
  } catch (error) {
    if (error instanceof Error && error.message === 'rollback left AGENTS.md') throw error;
  }
  if (await readFile(join(rollbackTarget, 'README.md'), 'utf8') !== '# target\n') throw new Error('rollback touched repository file');

  console.log('foundation-bootstrap selftest: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
