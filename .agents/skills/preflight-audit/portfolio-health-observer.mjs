#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReport as buildWipReport } from './wip-review-queue-observer.mjs';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_REPOS = 100;
const MAX_STAGNATION_FILES = 200;
const FOUNDATION_STATES = new Set(['CURRENT', 'UPDATE', 'PARTIAL_RESUME', 'STOP']);
const STAGNATION_RESULTS = new Set(['PROCEED', 'STOP', 'BLOCKED', 'WAIT_HUMAN']);
const here = fileURLToPath(new URL('.', import.meta.url));
const foundationAuditPath = resolve(here, '..', 'foundation-sync-audit', 'foundation-sync-audit.mjs');

function fail(code, detail = {}) { return { ok: false, code, ...detail }; }
function isoMs(value) {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
function validInt(value) { return Number.isSafeInteger(value) && value >= 0; }
function parseJson(text) { try { return JSON.parse(String(text ?? '')); } catch { return null; } }
function defaultRunner(command, args, { cwd } = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
}
function normalizeOrigin(url) {
  const value = String(url ?? '').trim().replace(/\.git$/, '');
  let match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) match = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (!match) match = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}
function stagnationResult(state) {
  const level = state?.level === 'PLATFORM_TURN_BOUNDARY'
    ? (state?.continuationCheckpoint?.level ?? 'CLEAR')
    : (state?.level ?? 'CLEAR');
  if (level === 'WAIT_HUMAN') return 'WAIT_HUMAN';
  if (['L1', 'L2', 'HARD_STOP'].includes(level)) return 'STOP';
  return 'PROCEED';
}

export function buildPortfolioReport(manifest, { nowMs = Date.now() } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1) return fail('PORTFOLIO_MANIFEST_INVALID');
  const fetchedMs = isoMs(manifest.fetchedAt);
  if (fetchedMs === null) return fail('PORTFOLIO_FETCH_TIME_INVALID');
  if (fetchedMs > nowMs) return fail('PORTFOLIO_EVIDENCE_FROM_FUTURE');
  if (nowMs - fetchedMs > MAX_AGE_MS) return fail('PORTFOLIO_EVIDENCE_STALE');
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0 || manifest.repositories.length > MAX_REPOS) return fail('PORTFOLIO_REPOSITORIES_INVALID');
  const seen = new Set();
  const repos = [];
  const totals = { repositories: manifest.repositories.length, wipStop: 0, wipUnknown: 0, stagnationStop: 0, stagnationWaitHuman: 0, foundationCurrent: 0, foundationUpdate: 0, foundationPartialResume: 0, foundationStop: 0, foundationUnknown: 0 };
  for (const item of manifest.repositories) {
    const repository = item?.repository;
    if (typeof repository !== 'string' || !REPO_RE.test(repository)) return fail('PORTFOLIO_REPOSITORY_INVALID', { repository: repository ?? null });
    if (seen.has(repository)) return fail('PORTFOLIO_REPOSITORY_DUPLICATE', { repository });
    seen.add(repository);
    const attention = [];
    let wip = { status: 'UNKNOWN', decision: null, pendingReviewCount: null, totalPendingDiffLines: null, code: 'WIP_EVIDENCE_MISSING' };
    if (item.wip && typeof item.wip === 'object' && !Array.isArray(item.wip)) {
      if (item.wip.repository !== repository) return fail('PORTFOLIO_WIP_REPOSITORY_MISMATCH', { repository });
      if (item.wip.ok === true && ['CONTINUE', 'STOP_NEW_WORK'].includes(item.wip.decision) && validInt(item.wip.pendingReviewCount) && validInt(item.wip.totalPendingDiffLines)) {
        wip = { status: 'CURRENT', decision: item.wip.decision, pendingReviewCount: item.wip.pendingReviewCount, totalPendingDiffLines: item.wip.totalPendingDiffLines, code: null };
        if (item.wip.decision === 'STOP_NEW_WORK') { totals.wipStop += 1; attention.push('WIP_STOP_NEW_WORK'); }
      } else wip.code = item.wip.code || 'WIP_EVIDENCE_INVALID';
    }
    if (wip.status === 'UNKNOWN') { totals.wipUnknown += 1; attention.push('WIP_UNKNOWN'); }
    const stagnation = { workItems: 0, proceed: 0, stop: 0, blocked: 0, waitHuman: 0, items: [] };
    if (!Array.isArray(item.stagnation)) return fail('PORTFOLIO_STAGNATION_INVALID', { repository });
    const workIds = new Set();
    for (const state of item.stagnation) {
      if (!state || typeof state !== 'object' || !STAGNATION_RESULTS.has(state.result) || typeof state.workId !== 'string' || !state.workId) return fail('PORTFOLIO_STAGNATION_ITEM_INVALID', { repository });
      if (workIds.has(state.workId)) return fail('PORTFOLIO_STAGNATION_WORK_DUPLICATE', { repository, workId: state.workId });
      workIds.add(state.workId);
      stagnation.workItems += 1;
      const key = state.result === 'WAIT_HUMAN' ? 'waitHuman' : state.result.toLowerCase();
      stagnation[key] += 1;
      stagnation.items.push({ workId: state.workId, result: state.result, code: state.code ?? null, level: state.nextState?.level ?? null, requiredAction: state.nextState?.requiredAction ?? null });
      if (state.result === 'STOP' || state.result === 'BLOCKED') { totals.stagnationStop += 1; attention.push(`STAGNATION_${state.result}:${state.workId}`); }
      if (state.result === 'WAIT_HUMAN') { totals.stagnationWaitHuman += 1; attention.push(`STAGNATION_WAIT_HUMAN:${state.workId}`); }
    }
    let foundation = { status: 'UNKNOWN', state: null, action: null, sourceVersion: null };
    if (item.foundation && typeof item.foundation === 'object' && !Array.isArray(item.foundation) && item.foundation.repository === repository && FOUNDATION_STATES.has(item.foundation.state)) {
      foundation = { status: 'CURRENT_EVIDENCE', state: item.foundation.state, action: item.foundation.action ?? null, sourceVersion: item.foundation.sourceVersion ?? null };
      if (item.foundation.state === 'CURRENT') totals.foundationCurrent += 1;
      if (item.foundation.state === 'UPDATE') { totals.foundationUpdate += 1; attention.push('FOUNDATION_UPDATE'); }
      if (item.foundation.state === 'PARTIAL_RESUME') { totals.foundationPartialResume += 1; attention.push('FOUNDATION_PARTIAL_RESUME'); }
      if (item.foundation.state === 'STOP') { totals.foundationStop += 1; attention.push('FOUNDATION_STOP'); }
    } else { totals.foundationUnknown += 1; attention.push('FOUNDATION_UNKNOWN'); }
    repos.push({ repository, wip, stagnation, foundation, attention: [...new Set(attention)] });
  }
  const attentionRepos = repos.filter(repo => repo.attention.length > 0).length;
  const summary = `${repos.length} repos; attention ${attentionRepos}; WIP stop ${totals.wipStop}; stagnation stop ${totals.stagnationStop}; Foundation update/partial/stop ${totals.foundationUpdate}/${totals.foundationPartialResume}/${totals.foundationStop}`;
  return { ok: true, code: null, schemaVersion: 1, fetchedAt: manifest.fetchedAt, generatedAt: new Date(nowMs).toISOString(), totals: { ...totals, attentionRepositories: attentionRepos }, summary, repositories: repos };
}
function validateCollectorConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1) throw new Error('PORTFOLIO_COLLECT_CONFIG_INVALID');
  if (!Array.isArray(config.repositories) || config.repositories.length === 0 || config.repositories.length > MAX_REPOS) throw new Error('PORTFOLIO_COLLECT_REPOSITORIES_INVALID');
  const seen = new Set();
  for (const item of config.repositories) {
    if (!item || typeof item !== 'object' || !REPO_RE.test(item.repository ?? '') || typeof item.localRoot !== 'string' || !item.localRoot.trim()) throw new Error('PORTFOLIO_COLLECT_REPOSITORY_INVALID');
    if (seen.has(item.repository)) throw new Error('PORTFOLIO_COLLECT_REPOSITORY_DUPLICATE');
    seen.add(item.repository);
  }
}
function wipEvidenceFromGh(repository, rows, fetchedAt) {
  if (!Array.isArray(rows) || rows.length > 200) return null;
  return { schemaVersion: 1, repository, fetchedAt, retrievalComplete: true, pullRequests: rows.map(pr => ({
    number: pr.number,
    state: String(pr.state ?? '').toLowerCase(),
    draft: pr.isDraft === true,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    baseRef: pr.baseRefName,
    headSha: String(pr.headRefOid ?? '').toLowerCase(),
  })) };
}
async function defaultReadStagnationStates(localRoot, { runner = defaultRunner } = {}) {
  const gitPath = runner('git', ['-C', localRoot, 'rev-parse', '--git-path', 'ai-dev-foundation/stagnation']);
  if (gitPath.status !== 0) throw new Error('PORTFOLIO_STAGNATION_GIT_PATH_FAILED');
  const rawPath = String(gitPath.stdout ?? '').trim();
  const directory = isAbsolute(rawPath) ? rawPath : resolve(localRoot, rawPath);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
  if (files.length > MAX_STAGNATION_FILES) throw new Error('PORTFOLIO_STAGNATION_FILES_EXCESSIVE');
  const states = [];
  for (const entry of files) {
    const state = parseJson(await readFile(resolve(directory, entry.name), 'utf8'));
    if (!state || state.schema !== 'ai-stagnation-state-v1' || typeof state.workId !== 'string' || !state.workId) throw new Error('PORTFOLIO_STAGNATION_STATE_INVALID');
    const result = stagnationResult(state);
    states.push({ workId: state.workId, result, code: `STAGNATION_STATE_${state.level ?? 'CLEAR'}`, nextState: state });
  }
  return states;
}
function verifyLocalIdentity(repository, localRoot, runner) {
  const top = runner('git', ['-C', localRoot, 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error('PORTFOLIO_LOCAL_REPOSITORY_INVALID');
  const origin = runner('git', ['-C', localRoot, 'config', '--get', 'remote.origin.url']);
  if (origin.status !== 0 || normalizeOrigin(origin.stdout) !== repository) throw new Error('PORTFOLIO_REPOSITORY_IDENTITY_MISMATCH');
}
function collectWip(repository, { runner, nowMs }) {
  const fetchedAt = new Date(nowMs).toISOString();
  const result = runner('gh', ['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '201', '--json', 'number,state,isDraft,additions,deletions,changedFiles,baseRefName,headRefOid']);
  if (result.status !== 0) return { ok: false, code: 'WIP_GITHUB_QUERY_FAILED', repository, generatedAt: fetchedAt, evidenceFetchedAt: null, wipMax: 2, decision: null, pendingReviewCount: null, totalPendingDiffLines: null, pendingPullRequests: null };
  const evidence = wipEvidenceFromGh(repository, parseJson(result.stdout), fetchedAt);
  if (!evidence) return { ok: false, code: 'WIP_GITHUB_EVIDENCE_INVALID', repository, generatedAt: fetchedAt, evidenceFetchedAt: null, wipMax: 2, decision: null, pendingReviewCount: null, totalPendingDiffLines: null, pendingPullRequests: null };
  return buildWipReport({ evidence, repo: repository, nowMs, generatedAt: fetchedAt });
}
function collectFoundation(repository, localRoot, { runner, sourceRoot }) {
  const result = runner(process.execPath, [foundationAuditPath, '--source-root', sourceRoot, '--target-root', localRoot, '--json']);
  const audit = parseJson(result.stdout);
  if (!audit || !['PASS', 'STOP'].includes(audit.result)) return null;
  return {
    repository,
    state: audit.result === 'PASS' ? 'CURRENT' : 'STOP',
    action: audit.result === 'PASS' ? 'NONE' : 'FOUNDATION_SYNC_AUDIT_STOP',
    sourceVersion: audit.sourceVersion ?? null,
    audit,
  };
}
export async function collectPortfolio(config, { sourceRoot, nowMs = Date.now(), runner = defaultRunner, readStagnationStates = defaultReadStagnationStates } = {}) {
  validateCollectorConfig(config);
  if (typeof sourceRoot !== 'string' || !sourceRoot.trim()) throw new Error('PORTFOLIO_SOURCE_ROOT_REQUIRED');
  const fetchedAt = new Date(nowMs).toISOString();
  const repositories = [];
  for (const item of config.repositories) {
    const localRoot = resolve(item.localRoot);
    verifyLocalIdentity(item.repository, localRoot, runner);
    const wip = collectWip(item.repository, { runner, nowMs });
    const stagnation = await readStagnationStates(localRoot, { runner });
    const foundation = collectFoundation(item.repository, localRoot, { runner, sourceRoot: resolve(sourceRoot) });
    repositories.push({ repository: item.repository, wip, stagnation, ...(foundation ? { foundation } : {}) });
  }
  return buildPortfolioReport({ schemaVersion: 1, fetchedAt, repositories }, { nowMs });
}

async function main() {
  try {
    const manifestIndex = process.argv.indexOf('--manifest');
    const collectIndex = process.argv.indexOf('--collect-config');
    if (manifestIndex >= 0 && collectIndex >= 0) throw new Error('PORTFOLIO_MODE_CONFLICT');
    let output;
    if (manifestIndex >= 0) {
      if (!process.argv[manifestIndex + 1]) throw new Error('PORTFOLIO_MANIFEST_REQUIRED');
      output = buildPortfolioReport(JSON.parse(await readFile(process.argv[manifestIndex + 1], 'utf8')));
    } else if (collectIndex >= 0) {
      if (!process.argv[collectIndex + 1]) throw new Error('PORTFOLIO_COLLECT_CONFIG_REQUIRED');
      const sourceIndex = process.argv.indexOf('--source-root');
      if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) throw new Error('PORTFOLIO_SOURCE_ROOT_REQUIRED');
      const config = JSON.parse(await readFile(process.argv[collectIndex + 1], 'utf8'));
      output = await collectPortfolio(config, { sourceRoot: process.argv[sourceIndex + 1] });
    } else throw new Error('PORTFOLIO_MODE_REQUIRED');
    console.log(JSON.stringify(output, null, 2));
    if (output.summary) console.error(`PORTFOLIO_HEALTH_SUMMARY=${output.summary}`);
    if (!output.ok) process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify(fail(error?.message || 'PORTFOLIO_INTERNAL_ERROR'), null, 2));
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
