#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, 'foundation-batch-rollout-plan.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const F = 'f'.repeat(40);
const G = '1'.repeat(40);
const H = '2'.repeat(40);

function gitBlobSha(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

const release = {
  fromVersion: '1.0.0-dev.86', sourceVersion: '1.0.0-dev.87', fromCommit: E, sourceCommit: F,
  entries: [
    { path: '.agents/skills/example/SKILL.md', oldSha: A, newSha: B },
    { path: '.agents/skills/new/SKILL.md', oldSha: null, newSha: C },
    { path: '.agents/skills/old/SKILL.md', oldSha: D, newSha: null },
  ],
};
const staleShas = {
  '.agents/skills/example/SKILL.md': A,
  '.agents/skills/new/SKILL.md': null,
  '.agents/skills/old/SKILL.md': D,
};
const currentShas = {
  '.agents/skills/example/SKILL.md': B,
  '.agents/skills/new/SKILL.md': C,
  '.agents/skills/old/SKILL.md': null,
};
function target(repository, branch, shas) {
  return { repository, branch, head: A, baseTree: B, targetShas: shas };
}
function manifest(targets, releaseOverride = release) {
  return { schemaVersion: 1, release: releaseOverride, targets };
}
function run(input, expectedStatus = 0) {
  const r = spawnSync(process.execPath, [helper], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, expectedStatus, `unexpected exit ${r.status}: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

const mixed = run(manifest([
  target('acme/current', 'main', currentShas),
  target('acme/stale', 'refs/heads/main', staleShas),
  target('acme/feature', 'foundation/dev87', staleShas),
  target('acme/partial', 'foundation/dev87', {
    '.agents/skills/example/SKILL.md': B,
    '.agents/skills/new/SKILL.md': null,
    '.agents/skills/old/SKILL.md': D,
  }),
]));
assert.equal(mixed.result, 'PASS');
assert.equal(mixed.code, 'FOUNDATION_BATCH_ROLLOUT_PLAN_READY');
assert.deepEqual(mixed.counts, { targets: 4, current: 1, update: 2, partialResume: 1, branchRequired: 1, readyPlans: 2 });
assert.equal(mixed.targets[0].state, 'CURRENT');
assert.equal(mixed.targets[0].action, 'NONE');
assert.equal(mixed.targets[1].state, 'UPDATE');
assert.equal(mixed.targets[1].action, 'CREATE_FEATURE_BRANCH');
assert.equal(mixed.targets[1].branchFromSha, A);
assert.equal(mixed.targets[2].action, 'APPLY_REMOTE_PLAN');
assert.equal(mixed.targets[2].remotePlan.result, 'PASS');
assert.equal(mixed.targets[2].remotePlan.counts.planned, 3);
assert.equal(mixed.targets[3].state, 'PARTIAL_RESUME');
assert.equal(mixed.targets[3].remotePlan.counts.planned, 2);
assert.deepEqual(mixed.targets[3].pendingPaths.sort(), ['.agents/skills/new/SKILL.md', '.agents/skills/old/SKILL.md'].sort());

const drift = run(manifest([target('acme/drift', 'foundation/dev87', { ...staleShas, '.agents/skills/example/SKILL.md': C })]), 2);
assert.equal(drift.code, 'FOUNDATION_BATCH_TARGET_DRIFT');
assert.equal(drift.repository, 'acme/drift');
assert.equal(drift.path, '.agents/skills/example/SKILL.md');

const missing = structuredClone(staleShas);
delete missing['.agents/skills/new/SKILL.md'];
assert.equal(run(manifest([target('acme/missing', 'main', missing)]), 2).code, 'FOUNDATION_BATCH_TARGET_PATH_EVIDENCE_MISSING');

assert.equal(run(manifest([
  target('acme/dup', 'main', staleShas), target('acme/dup', 'foundation/other', staleShas),
]), 2).code, 'FOUNDATION_BATCH_DUPLICATE_TARGET');

const duplicatePathRelease = structuredClone(release);
duplicatePathRelease.entries.push({ ...duplicatePathRelease.entries[0] });
assert.equal(run(manifest([target('acme/x', 'main', staleShas)], duplicatePathRelease), 2).code, 'FOUNDATION_BATCH_DUPLICATE_RELEASE_PATH');

const outsideRelease = structuredClone(release);
outsideRelease.entries = [{ path: 'src/app.ts', oldSha: A, newSha: B }];
assert.equal(run(manifest([target('acme/x', 'main', { 'src/app.ts': A })], outsideRelease), 2).code, 'FOUNDATION_BATCH_PATH_OUTSIDE_SHARED_SURFACE');

const layeredRelease = {
  fromVersion: '1.0.0-dev.86', sourceVersion: '1.0.0-dev.87', fromCommit: E, sourceCommit: F,
  entries: [
    { path: 'CORE.md', oldSha: null, newSha: A },
    { path: 'GEMINI.md', oldSha: null, newSha: B },
    { path: '.claude/CLAUDE.md', oldSha: null, newSha: C },
    { path: '.agents/rules/ai-foundation.md', oldSha: null, newSha: D },
    { path: 'roles/GEMINI.md', oldSha: null, newSha: G },
    { path: 'learnings/L-test.md', oldSha: null, newSha: H },
  ],
};
const layeredTargetShas = Object.fromEntries(layeredRelease.entries.map(entry => [entry.path, null]));
const layeredBatch = run(manifest([target('acme/layered', 'foundation/dev87', layeredTargetShas)], layeredRelease));
assert.equal(layeredBatch.targets[0].remotePlan.counts.created, layeredRelease.entries.length);
assert.equal(layeredBatch.targets[0].remotePlan.counts.planned, layeredRelease.entries.length);

const unchangedRelease = structuredClone(release);
unchangedRelease.entries = [{ path: 'AGENTS.md', oldSha: A, newSha: A }];
assert.equal(run(manifest([target('acme/x', 'main', { 'AGENTS.md': A })], unchangedRelease), 2).code, 'FOUNDATION_BATCH_UNCHANGED_RELEASE_ENTRY');

const badContentRelease = structuredClone(release);
badContentRelease.entries = [{ path: 'AGENTS.md', oldSha: A, newSha: B, newContent: 'not-b-sha' }];
assert.equal(run(manifest([target('acme/x', 'main', { 'AGENTS.md': A })], badContentRelease), 2).code, 'FOUNDATION_BATCH_SOURCE_CONTENT_SHA_MISMATCH');

const largeContent = 'x'.repeat(40_000);
const largeSha = gitBlobSha(largeContent);
const largeRelease = {
  fromVersion: '1.0.0-dev.92', sourceVersion: '1.0.0-dev.93', fromCommit: E, sourceCommit: F,
  entries: [{ path: 'AGENTS.md', oldSha: A, newSha: largeSha, newContent: largeContent }],
};
const largePayload = run(manifest([target('acme/large', 'foundation/dev93', { 'AGENTS.md': A })], largeRelease));
assert.equal(largePayload.result, 'PASS');
assert.equal(largePayload.targets[0].remotePlan.contentsApiContract.available, true);
assert.equal(largePayload.targets[0].remotePlan.contentsApiContract.operations[0].content.length, 40_000);

const badSingleTarget = target('acme/single-stop', 'foundation/dev87', staleShas);
badSingleTarget.baseTree = 'not-a-sha';
assert.equal(run(manifest([badSingleTarget]), 2).code, 'FOUNDATION_BATCH_TARGET_BASE_TREE_INVALID');


const heterogeneousManifest = {
  schemaVersion: 2,
  release: {
    sourceVersion: '1.0.0-dev.90', sourceCommit: F,
    baselines: [
      {
        id: 'dev88', fromVersion: '1.0.0-dev.88', fromCommit: E,
        entries: [{ path: '.agents/skills/example/SKILL.md', oldSha: A, newSha: B }],
      },
      {
        id: 'dev85', fromVersion: '1.0.0-dev.85', fromCommit: D,
        entries: [
          { path: '.agents/skills/example/SKILL.md', oldSha: G, newSha: B },
          { path: '.agents/skills/new/SKILL.md', oldSha: null, newSha: C },
        ],
      },
    ],
  },
  targets: [
    { ...target('acme/recent', 'main', { '.agents/skills/example/SKILL.md': A }), baselineId: 'dev88' },
    { ...target('acme/old', 'foundation/dev90', {
      '.agents/skills/example/SKILL.md': G,
      '.agents/skills/new/SKILL.md': null,
    }), baselineId: 'dev85' },
  ],
};
const heterogeneous = run(heterogeneousManifest);
assert.deepEqual(heterogeneous.counts, { targets: 2, current: 0, update: 2, partialResume: 0, branchRequired: 1, readyPlans: 1 });
assert.equal(heterogeneous.release.baselineCount, 2);
assert.equal(heterogeneous.targets[0].baseline.id, 'dev88');
assert.equal(heterogeneous.targets[0].action, 'CREATE_FEATURE_BRANCH');
assert.equal(heterogeneous.targets[1].baseline.id, 'dev85');
assert.equal(heterogeneous.targets[1].remotePlan.fromVersion, '1.0.0-dev.85');
assert.equal(heterogeneous.targets[1].remotePlan.counts.planned, 2);

const unknownBaseline = structuredClone(heterogeneousManifest);
unknownBaseline.targets[0].baselineId = 'missing';
assert.equal(run(unknownBaseline, 2).code, 'FOUNDATION_BATCH_TARGET_BASELINE_UNKNOWN');

const duplicateBaseline = structuredClone(heterogeneousManifest);
duplicateBaseline.release.baselines.push(structuredClone(duplicateBaseline.release.baselines[0]));
assert.equal(run(duplicateBaseline, 2).code, 'FOUNDATION_BATCH_DUPLICATE_BASELINE_ID');

const inconsistentSource = structuredClone(heterogeneousManifest);
inconsistentSource.release.baselines[1].entries[0].newSha = H;
assert.equal(run(inconsistentSource, 2).code, 'FOUNDATION_BATCH_BASELINE_SOURCE_MISMATCH');

console.log('foundation-batch-rollout-plan selftest: PASS');
