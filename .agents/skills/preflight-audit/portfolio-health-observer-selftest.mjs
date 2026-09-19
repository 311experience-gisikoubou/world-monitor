#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildPortfolioReport, collectPortfolio } from './portfolio-health-observer.mjs';

const NOW = Date.parse('2026-09-17T02:55:00.000Z');
const fetchedAt = '2026-09-17T02:54:00.000Z';
function wip(repo, decision, count = 0) { return { ok: true, repository: repo, decision, pendingReviewCount: count, totalPendingDiffLines: count * 10, evidenceFetchedAt: fetchedAt }; }
function stag(workId, result = 'PROCEED', code = 'ACTIVE_EXECUTION_IN_PROGRESS') { return { workId, result, code, nextState: { level: result === 'STOP' ? 'L1' : 'CLEAR', requiredAction: result === 'STOP' ? 'root-cause-analysis' : 'continue' } }; }
function foundation(repository, state = 'CURRENT', action = 'NONE') { return { repository, state, action, sourceVersion: '1.0.0-dev.90' }; }
const manifest = { schemaVersion: 1, fetchedAt, repositories: [
  { repository: 'acme/current', wip: wip('acme/current', 'CONTINUE'), stagnation: [stag('issue-1')], foundation: foundation('acme/current') },
  { repository: 'acme/attention', wip: wip('acme/attention', 'STOP_NEW_WORK', 2), stagnation: [stag('issue-2', 'STOP'), stag('issue-3', 'WAIT_HUMAN', 'WAITING_AT_VALID_HUMAN_GATE')], foundation: foundation('acme/attention', 'PARTIAL_RESUME', 'APPLY_REMOTE_PLAN') },
] };
const out = buildPortfolioReport(manifest, { nowMs: NOW });
assert.equal(out.ok, true);
assert.equal(out.totals.repositories, 2);
assert.equal(out.totals.attentionRepositories, 1);
assert.equal(out.totals.wipStop, 1);
assert.equal(out.totals.stagnationStop, 1);
assert.equal(out.totals.stagnationWaitHuman, 1);
assert.equal(out.totals.foundationCurrent, 1);
assert.equal(out.totals.foundationPartialResume, 1);
assert.deepEqual(out.repositories[0].attention, []);
assert(out.repositories[1].attention.includes('WIP_STOP_NEW_WORK'));
assert(out.repositories[1].attention.includes('FOUNDATION_PARTIAL_RESUME'));
const stale = structuredClone(manifest);
stale.fetchedAt = '2026-09-17T02:40:00.000Z';
assert.equal(buildPortfolioReport(stale, { nowMs: NOW }).code, 'PORTFOLIO_EVIDENCE_STALE');
const duplicate = structuredClone(manifest);
duplicate.repositories[1].repository = 'acme/current';
assert.equal(buildPortfolioReport(duplicate, { nowMs: NOW }).code, 'PORTFOLIO_REPOSITORY_DUPLICATE');
const mismatch = structuredClone(manifest);
mismatch.repositories[0].wip.repository = 'acme/other';
assert.equal(buildPortfolioReport(mismatch, { nowMs: NOW }).code, 'PORTFOLIO_WIP_REPOSITORY_MISMATCH');
const duplicateWork = structuredClone(manifest);
duplicateWork.repositories[0].stagnation = [stag('same'), stag('same')];
assert.equal(buildPortfolioReport(duplicateWork, { nowMs: NOW }).code, 'PORTFOLIO_STAGNATION_WORK_DUPLICATE');
const unknown = structuredClone(manifest);
delete unknown.repositories[0].foundation;
const unknownReport = buildPortfolioReport(unknown, { nowMs: NOW });
assert.equal(unknownReport.ok, true);
assert.equal(unknownReport.totals.foundationUnknown, 1);

const config = { schemaVersion: 1, repositories: [{ repository: 'acme/app', localRoot: 'C:/repos/app' }] };
const calls = [];
function runner(command, args) {
  calls.push([command, args]);
  if (command === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: 'C:/repos/app\n' };
  if (command === 'git' && args.includes('remote.origin.url')) return { status: 0, stdout: 'https://github.com/acme/app.git\n' };
  if (command === 'gh') return { status: 0, stdout: JSON.stringify([{ number: 7, state: 'OPEN', isDraft: false, additions: 5, deletions: 2, changedFiles: 1, baseRefName: 'main', headRefOid: 'a'.repeat(40) }]) };
  if (command === process.execPath) return { status: 0, stdout: JSON.stringify({ result: 'PASS', sourceVersion: '1.0.0-dev.90' }) };
  throw new Error(`unexpected command ${command} ${args.join(' ')}`);
}
async function readStagnationStates() {
  return [{ workId: 'issue-9', result: 'PROCEED', code: 'STAGNATION_STATE_CLEAR', nextState: { level: 'CLEAR', requiredAction: 'continue' } }];
}
const collected = await collectPortfolio(config, { sourceRoot: 'C:/foundation', nowMs: NOW, runner, readStagnationStates });
assert.equal(collected.ok, true);
assert.equal(collected.repositories[0].wip.pendingReviewCount, 1);
assert.equal(collected.repositories[0].foundation.state, 'CURRENT');
assert.equal(collected.repositories[0].stagnation.workItems, 1);
assert(calls.some(([command]) => command === 'gh'));
assert(calls.some(([command]) => command === process.execPath));

function badIdentity(command, args) {
  if (command === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: 'C:/repos/app\n' };
  if (command === 'git' && args.includes('remote.origin.url')) return { status: 0, stdout: 'https://github.com/acme/other.git\n' };
  return runner(command, args);
}
await assert.rejects(
  () => collectPortfolio(config, { sourceRoot: 'C:/foundation', nowMs: NOW, runner: badIdentity, readStagnationStates }),
  /PORTFOLIO_REPOSITORY_IDENTITY_MISMATCH/,
);
function ghUnavailable(command, args) {
  if (command === 'gh') return { status: 1, stdout: '', stderr: 'offline' };
  return runner(command, args);
}
const degraded = await collectPortfolio(config, { sourceRoot: 'C:/foundation', nowMs: NOW, runner: ghUnavailable, readStagnationStates });
assert.equal(degraded.ok, true);
assert.equal(degraded.totals.wipUnknown, 1);
assert(degraded.repositories[0].attention.includes('WIP_UNKNOWN'));

console.log('portfolio-health-observer selftest: PASS');
