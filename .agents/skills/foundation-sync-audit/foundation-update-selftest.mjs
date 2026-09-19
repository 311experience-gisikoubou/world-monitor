#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const updaterArg = process.argv[2];
const auditArg = process.argv[3];
if (!updaterArg || !auditArg) throw new Error('update path and audit path required');
const updater = resolve(updaterArg);
const auditGate = resolve(auditArg);

const root = await mkdtemp(join(tmpdir(), 'foundation-update-selftest-'));
let caseCounter = 0;

function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${command} failed: ${r.stdout} ${r.stderr}`);
  return r.stdout.trim();
}
function git(cwd, ...args) { return run('git', args, cwd); }
function canonical(name, description = `${name} description`, body = '') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${body}`;
}
function wrapper(name, description = `${name} description`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n../../../.agents/skills/${name}/SKILL.md\n`;
}
function operationSelftest(expected) {
  return `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconst gate = process.argv[2];\nif (!gate || !readFileSync(gate, 'utf8').includes('${expected}')) process.exit(2);\nconsole.log('operation-preflight selftest: PASS');\n`;
}
async function writeSkill(source, name, description, body = '') {
  await mkdir(join(source, '.agents', 'skills', name), { recursive: true });
  await writeFile(join(source, '.agents', 'skills', name, 'SKILL.md'), canonical(name, description, body));
  await mkdir(join(source, 'templates', '.claude', 'skills', name), { recursive: true });
  await writeFile(join(source, 'templates', '.claude', 'skills', name, 'SKILL.md.template'), wrapper(name, description));
}
async function initSource(kind) {
  const source = join(root, `source-${kind}`);
  await mkdir(join(source, '.agents', 'skills', 'foundation-sync-audit'), { recursive: true });
  await writeFile(join(source, 'VERSION'), kind === 'old' ? '1.0.0\n' : '2.0.0\n');
  await writeFile(join(source, 'AGENTS.md'), kind === 'old' ? '# agents old\n' : '# agents new\n');
  await writeFile(join(source, '.agents', 'skills', 'README.md'), kind === 'old' ? '# skills old\n' : '# skills new\n');
  await writeSkill(source, 'foundation-sync-audit', 'sync audit description');
  await copyFile(auditGate, join(source, '.agents', 'skills', 'foundation-sync-audit', 'foundation-sync-audit.mjs'));
  await writeSkill(source, 'preflight-audit', 'preflight description', kind === 'old' ? 'old\n' : 'new\n');
  const preflightDir = join(source, '.agents', 'skills', 'preflight-audit');
  const operationMarker = kind === 'old' ? 'old-operation-gate' : 'new-operation-gate';
  await writeFile(join(preflightDir, 'operation-preflight.mjs'), `export const marker = '${operationMarker}';\n`);
  await writeFile(join(preflightDir, 'operation-preflight-selftest.mjs'), operationSelftest(operationMarker));
  if (kind === 'old') await writeSkill(source, 'obsolete-skill', 'obsolete description', 'old only\n');
  else await writeSkill(source, 'new-skill', 'new description', 'new only\n');
  git(root, 'init', '-b', kind, source);
  git(source, 'config', 'user.email', 'selftest@example.invalid');
  git(source, 'config', 'user.name', 'selftest');
  git(source, 'add', '.');
  git(source, 'commit', '-m', `seed ${kind}`);
  return source;
}
async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}
async function copyTreeFromOld(oldSource, target, claude) {
  await copyFile(join(oldSource, 'AGENTS.md'), join(target, 'AGENTS.md'));
  await copyDir(join(oldSource, '.agents', 'skills'), join(target, '.agents', 'skills'));
  if (claude) {
    for (const name of ['foundation-sync-audit', 'preflight-audit', 'obsolete-skill']) {
      await mkdir(join(target, '.claude', 'skills', name), { recursive: true });
      await copyFile(
        join(oldSource, 'templates', '.claude', 'skills', name, 'SKILL.md.template'),
        join(target, '.claude', 'skills', name, 'SKILL.md'),
      );
    }
  }
}
async function initTarget(oldSource, { branch = 'feature/update', claude = true } = {}) {
  caseCounter += 1;
  const target = join(root, `target-${caseCounter}`);
  await mkdir(target, { recursive: true });
  git(root, 'init', '-b', branch, target);
  git(target, 'config', 'user.email', 'selftest@example.invalid');
  git(target, 'config', 'user.name', 'selftest');
  await writeFile(join(target, 'README.md'), '# app\n');
  await writeFile(join(target, 'AGENTS.local.md'), '# local survives\n');
  if (claude) await writeFile(join(target, 'CLAUDE.md'), '# claude\n');
  await copyTreeFromOld(oldSource, target, claude);
  await mkdir(join(target, '.agents', 'skills', 'local-only'), { recursive: true });
  await writeFile(join(target, '.agents', 'skills', 'local-only', 'SKILL.md'), '# local-only\n');
  if (claude) {
    await mkdir(join(target, '.claude', 'skills', 'local-only'), { recursive: true });
    await writeFile(join(target, '.claude', 'skills', 'local-only', 'SKILL.md'), '# local claude\n');
  }
  git(target, 'add', '.');
  git(target, 'commit', '-m', 'seed target');
  return target;
}
function updateRun(oldSource, newSource, target, extra = []) {
  return spawnSync(process.execPath, [
    updater, '--json', '--from-root', oldSource, '--source-root', newSource, '--target-root', target, ...extra,
  ], { encoding: 'utf8' });
}
function expectPass(oldSource, newSource, target, code, extra = []) {
  const r = updateRun(oldSource, newSource, target, extra);
  if (r.status !== 0 || !r.stdout.includes(code)) throw new Error(`expected PASS ${code}: ${r.stdout} ${r.stderr}`);
}
function expectStop(oldSource, newSource, target, code, extra = []) {
  const r = updateRun(oldSource, newSource, target, extra);
  if (r.status === 0 || !r.stdout.includes(code)) throw new Error(`expected STOP ${code}: ${r.stdout} ${r.stderr}`);
}

try {
  const oldSource = await initSource('old');
  const newSource = await initSource('new');

  const dry = await initTarget(oldSource);
  expectPass(oldSource, newSource, dry, 'FOUNDATION_UPDATE_PLAN_READY');
  if (await readFile(join(dry, 'AGENTS.md'), 'utf8') !== '# agents old\n') throw new Error('dry-run changed AGENTS.md');
  if (await readFile(join(dry, 'AGENTS.local.md'), 'utf8') !== '# local survives\n') throw new Error('dry-run changed local rules');

  const applied = await initTarget(oldSource);
  expectPass(oldSource, newSource, applied, 'FOUNDATION_UPDATE_APPLIED', ['--apply']);
  if (await readFile(join(applied, 'AGENTS.md'), 'utf8') !== '# agents new\n') throw new Error('AGENTS.md not updated');
  if (!(await readFile(join(applied, '.agents', 'skills', 'preflight-audit', 'SKILL.md'), 'utf8')).includes('new\n')) throw new Error('changed skill not updated');
  if (!(await readFile(join(applied, '.agents', 'skills', 'new-skill', 'SKILL.md'), 'utf8')).includes('new only')) throw new Error('new skill not created');
  try {
    await readFile(join(applied, '.agents', 'skills', 'obsolete-skill', 'SKILL.md'));
    throw new Error('obsolete skill not removed');
  } catch (error) {
    if (error instanceof Error && error.message === 'obsolete skill not removed') throw error;
  }
  if (await readFile(join(applied, 'AGENTS.local.md'), 'utf8') !== '# local survives\n') throw new Error('AGENTS.local.md changed');
  if (await readFile(join(applied, '.agents', 'skills', 'local-only', 'SKILL.md'), 'utf8') !== '# local-only\n') throw new Error('target-only skill changed');
  if (!(await readFile(join(applied, '.claude', 'skills', 'new-skill', 'SKILL.md'), 'utf8')).includes('new-skill')) throw new Error('new Claude wrapper missing');
  if (await readFile(join(applied, '.claude', 'skills', 'local-only', 'SKILL.md'), 'utf8') !== '# local claude\n') throw new Error('local Claude skill changed');

  const noClaude = await initTarget(oldSource, { claude: false });
  expectPass(oldSource, newSource, noClaude, 'FOUNDATION_UPDATE_APPLIED', ['--apply']);
  try {
    await readFile(join(noClaude, '.claude', 'skills', 'new-skill', 'SKILL.md'));
    throw new Error('Claude wrapper added without Claude config');
  } catch (error) {
    if (error instanceof Error && error.message === 'Claude wrapper added without Claude config') throw error;
  }

  const mainTarget = await initTarget(oldSource, { branch: 'main' });
  expectStop(oldSource, newSource, mainTarget, 'FOUNDATION_UPDATE_PROTECTED_BRANCH', ['--apply']);

  const dirty = await initTarget(oldSource);
  await writeFile(join(dirty, 'README.md'), '# dirty\n');
  expectStop(oldSource, newSource, dirty, 'FOUNDATION_UPDATE_DIRTY_WORKTREE', ['--apply']);

  const drift = await initTarget(oldSource);
  await writeFile(join(drift, 'AGENTS.md'), '# app changed canonical\n');
  git(drift, 'add', 'AGENTS.md');
  git(drift, 'commit', '-m', 'drift canonical');
  expectStop(oldSource, newSource, drift, 'FOUNDATION_UPDATE_TARGET_DRIFT', ['--apply']);
  if (await readFile(join(drift, 'AGENTS.md'), 'utf8') !== '# app changed canonical\n') throw new Error('drift file overwritten');

  const missing = await initTarget(oldSource);
  await rm(join(missing, '.agents', 'skills', 'preflight-audit', 'SKILL.md'));
  git(missing, 'add', '-A');
  git(missing, 'commit', '-m', 'remove old canonical');
  expectStop(oldSource, newSource, missing, 'FOUNDATION_UPDATE_TARGET_MISSING_OLD', ['--apply']);

  const collision = await initTarget(oldSource);
  await mkdir(join(collision, '.agents', 'skills', 'new-skill'), { recursive: true });
  await writeFile(join(collision, '.agents', 'skills', 'new-skill', 'SKILL.md'), '# local collision\n');
  git(collision, 'add', '.');
  git(collision, 'commit', '-m', 'collide new canonical');
  expectStop(oldSource, newSource, collision, 'FOUNDATION_UPDATE_NEW_PATH_CONFLICT', ['--apply']);

  const rollbackTarget = await initTarget(oldSource);
  const auditPath = join(newSource, '.agents', 'skills', 'foundation-sync-audit', 'foundation-sync-audit.mjs');
  await writeFile(auditPath, `#!/usr/bin/env node\nconst a=process.argv; const s=a[a.indexOf('--source-root')+1]; const t=a[a.indexOf('--target-root')+1]; console.log('{}'); process.exit(s===t?0:2);\n`);
  git(newSource, 'add', '.');
  git(newSource, 'commit', '-m', 'make audit fail only post-update');
  expectStop(oldSource, newSource, rollbackTarget, 'FOUNDATION_UPDATE_POST_AUDIT_FAILED', ['--apply']);
  if (await readFile(join(rollbackTarget, 'AGENTS.md'), 'utf8') !== '# agents old\n') throw new Error('rollback did not restore AGENTS.md');
  if (!(await readFile(join(rollbackTarget, '.agents', 'skills', 'preflight-audit', 'SKILL.md'), 'utf8')).includes('old\n')) throw new Error('rollback did not restore skill');
  if (await readFile(join(rollbackTarget, 'AGENTS.local.md'), 'utf8') !== '# local survives\n') throw new Error('rollback changed local rules');

  await copyFile(auditGate, auditPath);
  git(newSource, 'add', '.');
  git(newSource, 'commit', '-m', 'restore audit before targeted selftest failure');
  const targetedFailureTarget = await initTarget(oldSource);
  const newTargetedSelftest = join(newSource, '.agents', 'skills', 'preflight-audit', 'operation-preflight-selftest.mjs');
  await writeFile(newTargetedSelftest, '#!/usr/bin/env node\nprocess.exit(2);\n');
  git(newSource, 'add', '.');
  git(newSource, 'commit', '-m', 'make targeted selftest fail');
  expectStop(oldSource, newSource, targetedFailureTarget, 'FOUNDATION_UPDATE_TARGET_SELFTEST_FAILED', ['--apply']);
  if (await readFile(join(targetedFailureTarget, 'AGENTS.md'), 'utf8') !== '# agents old\n') throw new Error('targeted selftest rollback did not restore AGENTS.md');
  if (!(await readFile(join(targetedFailureTarget, '.agents', 'skills', 'preflight-audit', 'operation-preflight.mjs'), 'utf8')).includes('old-operation-gate')) throw new Error('targeted selftest rollback did not restore operation gate');

  console.log('foundation-update selftest: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
