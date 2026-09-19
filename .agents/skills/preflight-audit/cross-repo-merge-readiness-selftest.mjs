#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildMergeReadinessReport, collectMergeReadiness } from './cross-repo-merge-readiness.mjs';

const NOW = Date.parse('2026-09-17T08:00:00.000Z');
const fetchedAt = '2026-09-17T07:59:00.000Z';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const expected = { baseRef: 'main', baseSha: base, headSha: head, draft: true, changedFiles: ['a.mjs', 'b.mjs'] };
function readyTarget() {
  return {
    repository: 'acme/app', pr: 7, expected,
    prInfo: { state: 'open', draft: true, mergeable: true, baseRef: 'main', baseSha: base, headSha: head },
    liveBase: { ref: 'main', sha: base },
    changedFiles: ['b.mjs', 'a.mjs'],
    workflows: [], reviews: [], reviewThreads: [],
    queryComplete: { files: true, workflows: true, reviews: true, threads: true },
  };
}
function report(target = readyTarget()) {
  return buildMergeReadinessReport({ schemaVersion: 1, fetchedAt, targets: [target] }, { nowMs: NOW });
}
const ready = report();
assert.equal(ready.ok, true);
assert.equal(ready.overall, 'READY_FOR_FINAL_AUDIT');
assert.equal(ready.mergeAuthorized, false);
assert.equal(ready.finalAuditRequired, true);
assert.equal(ready.targets[0].status, 'READY_FOR_FINAL_AUDIT');
const movedHead = readyTarget();
movedHead.prInfo.headSha = 'c'.repeat(40);
assert(report(movedHead).targets[0].blockers.includes('HEAD_SHA_MISMATCH'));
const movedPrBase = readyTarget();
movedPrBase.prInfo.baseSha = 'd'.repeat(40);
assert(report(movedPrBase).targets[0].blockers.includes('PR_BASE_SHA_MISMATCH'));
const movedBase = readyTarget();
movedBase.liveBase.sha = 'd'.repeat(40);
assert(report(movedBase).targets[0].blockers.includes('LIVE_BASE_SHA_MISMATCH'));
const unknownMergeable = readyTarget();
unknownMergeable.prInfo.mergeable = null;
assert(report(unknownMergeable).targets[0].blockers.includes('PR_MERGEABILITY_UNKNOWN'));
const changed = readyTarget();
changed.changedFiles = ['a.mjs'];
assert(report(changed).targets[0].blockers.includes('CHANGED_FILES_MISMATCH'));
const workflow = readyTarget();
workflow.workflows = [{ status: 'completed', conclusion: 'failure' }];
assert(report(workflow).targets[0].blockers.includes('WORKFLOW_BLOCKER'));
const review = readyTarget();
review.reviews = [{ state: 'CHANGES_REQUESTED' }];
assert(report(review).targets[0].blockers.includes('REVIEW_BLOCKER'));
const thread = readyTarget();
thread.reviewThreads = [{ isResolved: false }];
assert(report(thread).targets[0].blockers.includes('REVIEW_THREAD_BLOCKER'));
const stale = { schemaVersion: 1, fetchedAt: '2026-09-17T07:40:00.000Z', targets: [readyTarget()] };
assert.equal(buildMergeReadinessReport(stale, { nowMs: NOW }).code, 'MERGE_READINESS_EVIDENCE_STALE');
const duplicate = { schemaVersion: 1, fetchedAt, targets: [readyTarget(), readyTarget()] };
assert.equal(buildMergeReadinessReport(duplicate, { nowMs: NOW }).code, 'MERGE_READINESS_TARGET_DUPLICATE');

const config = { schemaVersion: 1, targets: [{ repository: 'acme/app', pr: 7, expected }] };
function runner(command, args) {
  assert.equal(command, 'gh');
  const joined = args.join(' ');
  if (joined === 'api repos/acme/app/pulls/7') return { status: 0, stdout: JSON.stringify({ state: 'open', draft: true, mergeable: true, changed_files: 2, base: { ref: 'main', sha: base }, head: { sha: head } }) };
  if (joined.includes('/files?')) return { status: 0, stdout: JSON.stringify([[{ filename: 'a.mjs' }, { filename: 'b.mjs' }]]) };
  if (joined.includes('/reviews?')) return { status: 0, stdout: JSON.stringify([[]]) };
  if (joined.includes('/actions/runs?')) return { status: 0, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) };
  if (joined.includes('/branches/main')) return { status: 0, stdout: JSON.stringify({ name: 'main', commit: { sha: base } }) };
  if (args.includes('graphql')) return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  throw new Error(`unexpected gh args: ${joined}`);
}
const collected = collectMergeReadiness(config, { nowMs: NOW, runner });
assert.equal(collected.ok, true);
assert.equal(collected.targets[0].observed.changedFiles.length, 2);

function failingRunner(command, args) {
  if (args.join(' ') === 'api repos/acme/app/pulls/7') return { status: 1, stdout: '', stderr: 'offline' };
  return runner(command, args);
}
const unavailable = collectMergeReadiness(config, { nowMs: NOW, runner: failingRunner });
assert.equal(unavailable.ok, false);
assert(unavailable.targets[0].blockers.includes('GITHUB_QUERY_FAILED'));

const duplicateFilesConfig = structuredClone(config);
duplicateFilesConfig.targets[0].expected.changedFiles = ['a.mjs', 'a.mjs'];
assert.throws(() => collectMergeReadiness(duplicateFilesConfig, { nowMs: NOW, runner }), /MERGE_READINESS_CONFIG_EXPECTED_FILES_DUPLICATE/);

console.log('cross-repo-merge-readiness selftest: PASS');
