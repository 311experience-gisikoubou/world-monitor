#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  executeAuthorizedCrossRepoMerge,
  planAuthorizedCrossRepoMerge,
  validateExecutorConfig,
} from './cross-repo-merge-executor.mjs';

const NOW = Date.parse('2026-09-18T01:00:00.000Z');
const AUTHOR = 'owner';
const A = {
  repository: 'acme/a', pr: 11,
  base: '1'.repeat(40), head: 'a'.repeat(40), tree: '3'.repeat(40), merge: '5'.repeat(40),
};
const B = {
  repository: 'acme/b', pr: 22,
  base: '2'.repeat(40), head: 'b'.repeat(40), tree: '4'.repeat(40), merge: '6'.repeat(40),
};

function receipt(item) {
  return [
    'MERGE_AUTHORIZATION_V1',
    `PR: ${item.pr}`,
    `HEAD: ${item.head}`,
    'AUTHORIZED: YES',
    'SOURCE: EXPLICIT_HUMAN',
  ].join('\n');
}
function comment(item, createdAt = new Date(NOW - 60_000).toISOString()) {
  return {
    id: item.pr * 10,
    body: receipt(item),
    created_at: createdAt,
    user: { login: AUTHOR },
  };
}
function config(items = [A, B]) {
  return {
    schemaVersion: 1,
    author: AUTHOR,
    mergeMethod: 'squash',
    targets: items.map(item => ({
      repository: item.repository,
      pr: item.pr,
      expected: {
        baseRef: 'main',
        baseSha: item.base,
        headSha: item.head,
        treeSha: item.tree,
      },
    })),
  };
}
function makeState(item) {
  return {
    item,
    pr: {
      number: item.pr,
      state: 'open',
      merged_at: null,
      draft: true,
      merge_commit_sha: null,
      base: { ref: 'main', sha: item.base },
      head: { sha: item.head },
    },
    main: item.base,
    comments: [comment(item)],
    commits: new Map(),
    commentCalls: 0,
  };
}
function makeWorld({
  readyFailRepo = null,
  mergeFailRepo = null,
  batchQueryFailRepo = null,
  postTreeMismatchRepo = null,
  postParentMismatchRepo = null,
} = {}) {
  const states = new Map([[A.repository, makeState(A)], [B.repository, makeState(B)]]);
  const mutations = [];

  function endpointRepo(endpoint) {
    const match = /^repos\/([^/]+\/[^/]+)\//.exec(endpoint);
    if (!match) throw new Error(`bad endpoint: ${endpoint}`);
    return match[1];
  }
  function runner(command, args) {
    assert.equal(command, 'gh');
    if (args[0] === 'pr' && args[1] === 'ready') {
      const pr = Number(args[2]);
      const repo = args[args.indexOf('--repo') + 1];
      const undo = args.includes('--undo');
      const state = states.get(repo);
      assert(state && state.item.pr === pr);
      if (!undo && readyFailRepo === repo) {
        mutations.push(`ready-fail:${repo}`);
        return { status: 1, stdout: '', stderr: 'ready failed' };
      }
      state.pr.draft = undo;
      mutations.push(`${undo ? 'draft' : 'ready'}:${repo}`);
      return { status: 0, stdout: '', stderr: '' };
    }

    assert.equal(args[0], 'api');
    if (args[1] === '-X' && args[2] === 'PUT') {
      const endpoint = args[3];
      const repo = endpointRepo(endpoint);
      const state = states.get(repo);
      const shaArg = args.find(value => String(value).startsWith('sha='));
      assert.equal(shaArg, `sha=${state.item.head}`);
      assert(args.includes('merge_method=squash'));
      mutations.push(`merge:${repo}`);
      if (mergeFailRepo === repo) {
        return { status: 0, stdout: JSON.stringify({ merged: false, message: 'blocked' }), stderr: '' };
      }
      const mergedAt = new Date(NOW + 1_000).toISOString();
      state.pr.state = 'closed';
      state.pr.merged_at = mergedAt;
      state.pr.draft = false;
      state.pr.merge_commit_sha = state.item.merge;
      state.main = state.item.merge;
      state.commits.set(state.item.merge, {
        sha: state.item.merge,
        tree: { sha: postTreeMismatchRepo === repo ? '9'.repeat(40) : state.item.tree },
        parents: [{ sha: postParentMismatchRepo === repo ? '8'.repeat(40) : state.item.base }],
      });
      return { status: 0, stdout: JSON.stringify({ merged: true, sha: state.item.merge, message: 'merged' }), stderr: '' };
    }

    const endpoint = args.at(-1);
    const repo = endpointRepo(endpoint);
    const state = states.get(repo);
    if (endpoint.includes('/issues/') && endpoint.includes('/comments?')) {
      state.commentCalls += 1;
      if (batchQueryFailRepo === repo && state.commentCalls >= 2) {
        return { status: 1, stdout: '', stderr: 'offline' };
      }
      return { status: 0, stdout: JSON.stringify([state.comments]), stderr: '' };
    }
    if (endpoint === `repos/${repo}/pulls/${state.item.pr}`) {
      return { status: 0, stdout: JSON.stringify(state.pr), stderr: '' };
    }
    if (endpoint === `repos/${repo}/git/ref/heads/main`) {
      return {
        status: 0,
        stdout: JSON.stringify({ ref: 'refs/heads/main', object: { sha: state.main } }),
        stderr: '',
      };
    }
    if (endpoint.startsWith(`repos/${repo}/git/commits/`)) {
      const sha = endpoint.split('/').at(-1);
      const commit = state.commits.get(sha);
      return commit
        ? { status: 0, stdout: JSON.stringify(commit), stderr: '' }
        : { status: 1, stdout: '', stderr: 'missing commit' };
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  }
  function markMerged(item, {
    receiptCreatedAt = new Date(NOW - 10 * 60_000).toISOString(),
    mergedAt = new Date(NOW - 5 * 60_000).toISOString(),
  } = {}) {
    const state = states.get(item.repository);
    state.comments = [comment(item, receiptCreatedAt)];
    state.pr.state = 'closed';
    state.pr.merged_at = mergedAt;
    state.pr.draft = false;
    state.pr.merge_commit_sha = item.merge;
    state.main = item.merge;
    state.commits.set(item.merge, {
      sha: item.merge,
      tree: { sha: item.tree },
      parents: [{ sha: item.base }],
    });
  }

  return {
    runner,
    states,
    mutations,
    markMerged,
    setMergeFail(repo) { mergeFailRepo = repo; },
    clearMergeFail() { mergeFailRepo = null; },
  };
}

{
  const world = makeWorld();
  const plan = planAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(plan.ok, true);
  assert.equal(plan.overall, 'PLAN_READY');
  assert.equal(plan.mutationPerformed, false);
  assert.equal(plan.totals.ready, 2);
  assert.deepEqual(world.mutations, []);
}

{
  const world = makeWorld();
  const result = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, true);
  assert.equal(result.overall, 'MERGED_AND_VERIFIED');
  assert.equal(result.totals.newlyMerged, 2);
  assert.equal(world.states.get(A.repository).pr.state, 'closed');
  assert.equal(world.states.get(B.repository).pr.state, 'closed');
  assert.deepEqual(world.mutations, [
    `ready:${A.repository}`, `ready:${B.repository}`,
    `merge:${A.repository}`, `merge:${B.repository}`,
  ]);
}

{
  const world = makeWorld();
  world.states.get(A.repository).comments = [];
  const result = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BATCH_MERGE_EXECUTOR_PREFLIGHT_BLOCKED');
  assert.deepEqual(world.mutations, []);
}
{
  const world = makeWorld();
  world.states.get(A.repository).comments = [
    comment(A, new Date(NOW - 31 * 60_000).toISOString()),
  ];
  const result = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, false);
  assert(result.targets[0].blockers.includes('AUTHORIZATION_RECEIPT_EXPIRED'));
  assert.deepEqual(world.mutations, []);
}

{
  const world = makeWorld();
  world.states.get(A.repository).pr.head.sha = 'f'.repeat(40);
  const result = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, false);
  assert(result.targets[0].blockers.includes('AUDITED_HEAD_SHA_MISMATCH'));
  assert.deepEqual(world.mutations, []);
}

{
  const world = makeWorld({ readyFailRepo: B.repository });
  const result = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'READY_MUTATION_FAILED');
  assert.equal(world.states.get(A.repository).pr.draft, true);
  assert.equal(world.states.get(B.repository).pr.draft, true);
  assert(world.mutations.includes(`draft:${A.repository}`));
  assert(!world.mutations.some(value => value.startsWith('merge:')));
}

{
  const world = makeWorld({ batchQueryFailRepo: B.repository });
  const result = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BATCH_MERGE_EXECUTION_GATE_FAILED');
  assert.equal(world.states.get(A.repository).pr.draft, true);
  assert.equal(world.states.get(B.repository).pr.draft, true);
  assert(world.mutations.includes(`draft:${A.repository}`));
  assert(world.mutations.includes(`draft:${B.repository}`));
  assert(!world.mutations.some(value => value.startsWith('merge:')));
}
{
  const world = makeWorld({ mergeFailRepo: B.repository });
  const first = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'MERGE_CALL_FAILED');
  assert.equal(world.states.get(A.repository).pr.state, 'closed');
  assert.equal(world.states.get(B.repository).pr.state, 'open');
  assert.equal(world.states.get(B.repository).pr.draft, true);
  assert(world.mutations.includes(`merge:${A.repository}`));
  assert(world.mutations.includes(`merge:${B.repository}`));
  assert(world.mutations.includes(`draft:${B.repository}`));

  world.clearMergeFail();
  const beforeResumeMutations = world.mutations.length;
  const resumed = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.totals.alreadyMerged, 1);
  assert.equal(resumed.totals.newlyMerged, 1);
  const resumeMutations = world.mutations.slice(beforeResumeMutations);
  assert(!resumeMutations.includes(`merge:${A.repository}`));
  assert(resumeMutations.includes(`merge:${B.repository}`));
}

{
  const world = makeWorld({ postTreeMismatchRepo: A.repository });
  const result = await executeAuthorizedCrossRepoMerge(config(), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POST_MERGE_VERIFICATION_FAILED');
  assert(result.verification.blockers.includes('POST_MERGE_TREE_MISMATCH'));
  assert.equal(world.states.get(A.repository).pr.state, 'closed');
  assert.equal(world.states.get(B.repository).pr.draft, true);
  assert(world.mutations.includes(`draft:${B.repository}`));
}

{
  const world = makeWorld({ postParentMismatchRepo: A.repository });
  const result = await executeAuthorizedCrossRepoMerge(config([A]), { nowMs: NOW, runner: world.runner });
  assert.equal(result.ok, false);
  assert(result.verification.blockers.includes('BASE_SHA_DRIFT'));
}
{
  const world = makeWorld();
  world.markMerged(A, {
    receiptCreatedAt: new Date(NOW - 60 * 60_000).toISOString(),
    mergedAt: new Date(NOW - 55 * 60_000).toISOString(),
  });
  const plan = planAuthorizedCrossRepoMerge(config([A]), { nowMs: NOW, runner: world.runner });
  assert.equal(plan.ok, true);
  assert.equal(plan.targets[0].status, 'ALREADY_MERGED_VERIFIED');
  assert.deepEqual(world.mutations, []);
}

{
  const world = makeWorld();
  world.markMerged(A, {
    receiptCreatedAt: new Date(NOW - 50 * 60_000).toISOString(),
    mergedAt: new Date(NOW - 55 * 60_000).toISOString(),
  });
  const plan = planAuthorizedCrossRepoMerge(config([A]), { nowMs: NOW, runner: world.runner });
  assert.equal(plan.ok, false);
  assert(plan.targets[0].blockers.includes('AUTHORIZATION_RECEIPT_REQUIRED_BEFORE_MERGE'));
}

{
  const duplicateRepo = config([A, { ...A, pr: 99, head: 'd'.repeat(40), tree: 'e'.repeat(40) }]);
  assert.throws(
    () => validateExecutorConfig(duplicateRepo),
    /BATCH_MERGE_EXECUTOR_REPOSITORY_DUPLICATE/,
  );
  const badMethod = config([A]);
  badMethod.mergeMethod = 'merge';
  assert.throws(
    () => validateExecutorConfig(badMethod),
    /BATCH_MERGE_EXECUTOR_MERGE_METHOD_UNSUPPORTED/,
  );
}

console.log('cross-repo-merge-executor selftest: PASS');
