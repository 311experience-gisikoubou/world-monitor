#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const SHA40_RE = /^[0-9a-f]{40}$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk']);
const MODES = new Set(['write', 'read-only']);

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}
function clean(value) { return String(value ?? '').trim(); }
function stop(code, detail = {}) {
  return { schemaVersion: 1, result: 'STOP', code, ...detail };
}
function validEvidence(e) {
  return e && MODES.has(e.mode) && typeof e.branch === 'string' &&
    typeof e.baseBranch === 'string' && /^[A-Za-z0-9._/-]+$/.test(e.baseBranch) &&
    SHA40_RE.test(e.headSha || '') && SHA40_RE.test(e.localBaseSha || '') &&
    SHA40_RE.test(e.liveBaseSha || '') && SHA40_RE.test(e.mergeBaseSha || '') &&
    typeof e.worktreeClean === 'boolean' &&
    ['CURRENT', 'STALE', 'UNKNOWN'].includes(e.agentsState);
}
export function evaluateWorkStart(evidence) {
  if (!validEvidence(evidence)) return stop('WORK_START_EVIDENCE_INVALID');
  const warnings = [];
  if (!evidence.worktreeClean) warnings.push('DIRTY_WORKTREE');
  if (PROTECTED_BRANCHES.has(evidence.branch)) warnings.push('PROTECTED_BRANCH');
  if (evidence.localBaseSha !== evidence.liveBaseSha) warnings.push('LOCAL_BASE_STALE');
  if (evidence.mergeBaseSha !== evidence.liveBaseSha) warnings.push('BRANCH_NOT_DERIVED_FROM_LIVE_BASE');
  if (evidence.agentsState !== 'CURRENT') warnings.push('AGENTS_NOT_CURRENT');

  if (evidence.mode === 'read-only') {
    return {
      schemaVersion: 1,
      result: 'PASS',
      code: 'WORK_START_READ_ONLY_INSPECTION',
      warnings,
      ...evidence,
    };
  }
  if (PROTECTED_BRANCHES.has(evidence.branch)) return stop('WORK_START_PROTECTED_BRANCH');
  if (!evidence.worktreeClean) return stop('WORK_START_DIRTY_WORKTREE');
  if (evidence.localBaseSha !== evidence.liveBaseSha) {
    return stop('WORK_START_LOCAL_BASE_STALE', {
      localBaseSha: evidence.localBaseSha,
      liveBaseSha: evidence.liveBaseSha,
    });
  }
  if (evidence.mergeBaseSha !== evidence.liveBaseSha) {
    return stop('WORK_START_BRANCH_NOT_CURRENT_BASE', {
      mergeBaseSha: evidence.mergeBaseSha,
      liveBaseSha: evidence.liveBaseSha,
    });
  }
  if (evidence.agentsState !== 'CURRENT') {
    return stop('WORK_START_AGENTS_NOT_CURRENT', { agentsState: evidence.agentsState });
  }
  return {
    schemaVersion: 1,
    result: 'PASS',
    code: 'WORK_START_READY',
    warnings: [],
    ...evidence,
  };
}

export function parseArgs(argv) {
  const out = { mode: 'write', repoRoot: '.', foundationRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) out.mode = argv[++i];
    else if (arg === '--base') throw new Error('BASE_OVERRIDE_FORBIDDEN');
    else if (arg === '--repo-root' && argv[i + 1]) out.repoRoot = argv[++i];
    else if (arg === '--foundation-root' && argv[i + 1]) out.foundationRoot = argv[++i];
    else if (arg === '--pretty') out.pretty = true;
    else throw new Error('ARGUMENT_INVALID');
  }
  if (!MODES.has(out.mode)) throw new Error('ARGUMENT_INVALID');
  return out;
}
export function parseRemoteDefault(text) {
  const remoteLines = String(text ?? '').trim().split(/\r?\n/).filter(Boolean);
  const refLine = remoteLines.find(line => line.startsWith('ref: refs/heads/') && /\sHEAD$/.test(line));
  const shaLine = remoteLines.find(line => SHA40_RE.test((line.split(/\s+/)[0] || '').toLowerCase()) && /\sHEAD$/.test(line));
  if (!refLine || !shaLine) return null;
  const baseBranch = refLine.match(/^ref: refs\/heads\/(.+)\s+HEAD$/)?.[1] ?? '';
  const liveBaseSha = clean(shaLine.split(/\s+/)[0]).toLowerCase();
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch) || !SHA40_RE.test(liveBaseSha)) return null;
  return { baseBranch, liveBaseSha };
}
function gitValue(root, args, code) {
  const r = run('git', args, root);
  if (r.status !== 0) throw new Error(code);
  return clean(r.stdout);
}
function observeAgentsState(root, foundationRoot) {
  const renderer = join(root, '.agents', 'skills', 'foundation-sync-audit', 'entrypoint-renderer.mjs');
  const isFoundation = existsSync(join(root, 'templates', 'AGENTS.index.md.template')) &&
    existsSync(join(root, 'CORE.md')) && existsSync(renderer);
  if (isFoundation) {
    const r = run(process.execPath, [renderer, '--root', root, '--check'], root);
    return r.status === 0 ? 'CURRENT' : 'STALE';
  }
  if (!foundationRoot) return 'UNKNOWN';
  const source = resolve(foundationRoot);
  const audit = join(source, '.agents', 'skills', 'foundation-sync-audit', 'foundation-sync-audit.mjs');
  if (!existsSync(audit)) return 'UNKNOWN';
  const r = run(process.execPath, [audit, '--source-root', source, '--target-root', root, '--json'], root);
  if (r.status !== 0) return 'STALE';
  try {
    return JSON.parse(r.stdout)?.result === 'PASS' ? 'CURRENT' : 'STALE';
  } catch {
    return 'STALE';
  }
}

export function observeWorkStart({ repoRoot, mode, foundationRoot }) {
  const root = resolve(repoRoot);
  const top = resolve(gitValue(root, ['rev-parse', '--show-toplevel'], 'REPOSITORY_INVALID'));
  if (top !== root) throw new Error('REPOSITORY_ROOT_MISMATCH');
  const branch = gitValue(root, ['branch', '--show-current'], 'BRANCH_UNAVAILABLE');
  if (!branch) throw new Error('DETACHED_HEAD');
  const headSha = gitValue(root, ['rev-parse', 'HEAD'], 'HEAD_UNAVAILABLE').toLowerCase();

  const remoteHead = run('git', ['ls-remote', '--symref', 'origin', 'HEAD'], root);
  if (remoteHead.status !== 0) throw new Error('REMOTE_DEFAULT_BRANCH_UNAVAILABLE');
  const remoteDefault = parseRemoteDefault(remoteHead.stdout);
  if (!remoteDefault) throw new Error('REMOTE_DEFAULT_BRANCH_INVALID');
  const { baseBranch, liveBaseSha } = remoteDefault;

  const localBaseSha = gitValue(root, ['rev-parse', `origin/${baseBranch}`], 'LOCAL_BASE_UNAVAILABLE').toLowerCase();
  const status = gitValue(root, ['status', '--porcelain'], 'STATUS_UNAVAILABLE');
  const worktreeClean = status.length === 0;
  const mergeBaseSha = gitValue(root, ['merge-base', 'HEAD', `origin/${baseBranch}`], 'MERGE_BASE_UNAVAILABLE').toLowerCase();
  return {
    schemaVersion: 1,
    mode,
    baseBranch,
    branch,
    headSha,
    localBaseSha,
    liveBaseSha,
    mergeBaseSha,
    worktreeClean,
    agentsState: observeAgentsState(root, foundationRoot),
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = observeWorkStart(args);
    const result = evaluateWorkStart(evidence);
    process.stdout.write(JSON.stringify(result, null, args.pretty ? 2 : 0) + '\n');
    process.exitCode = result.result === 'PASS' ? 0 : 2;
  } catch (error) {
    process.stdout.write(JSON.stringify(stop(error?.message || 'WORK_START_INTERNAL_ERROR')) + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
