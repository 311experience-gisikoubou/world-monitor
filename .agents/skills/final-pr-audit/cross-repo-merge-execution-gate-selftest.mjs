#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  collectBatchMergeExecution,
  validateBatchConfig,
} from './cross-repo-merge-execution-gate.mjs';

const NOW = Date.parse('2026-09-18T00:00:00.000Z');
const REPO = 'acme/app';
const PR = 7;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE_A = '1'.repeat(40);
const BASE_B = '2'.repeat(40);
const AUTHOR = 'owner';

function receipt(head = HEAD_A, pr = PR) {
  return [
    'MERGE_AUTHORIZATION_V1',
    `PR: ${pr}`,
    `HEAD: ${head}`,
    'AUTHORIZED: YES',
    'SOURCE: EXPLICIT_HUMAN',
  ].join('\n');
}
function comment({
  head = HEAD_A,
  createdAt = new Date(NOW - 60_000).toISOString(),
  author = AUTHOR,
} = {}) {
  return {
    id: 99, body: receipt(head), created_at: createdAt,
    user: { login: author },
  };
}
function config(expected = {}) {
  return {
    schemaVersion: 1,
    author: AUTHOR,
    targets: [{
      repository: REPO,
      pr: PR,
      expected: {
        baseRef: 'main',
        baseSha: BASE_A,
        headSha: HEAD_A,
        ...expected,
      },
    }],
  };
}
function makeRunner({
  head = HEAD_A,
  liveBase = BASE_A,
  reportedBase = BASE_A,
  draft = false,
  state = 'open',
  mergedAt = null,
  comments = [comment()],
  failAt = null,
  calls = [],
} = {}) {
  return (command, args) => {
    assert.equal(command, 'gh');
    const joined = args.join(' ');
    if (joined.includes('/issues/7/comments?')) {
      calls.push('comments');
      if (failAt === 'comments') return { status: 1, stdout: '', stderr: 'offline' };
      return { status: 0, stdout: JSON.stringify([comments]) };
    }
    if (joined === 'api repos/acme/app/pulls/7') {
      calls.push('pr');
      if (failAt === 'pr') return { status: 1, stdout: '', stderr: 'offline' };
      return {
        status: 0,
        stdout: JSON.stringify({
          number: PR, state, merged_at: mergedAt, draft,
          base: { ref: 'main', sha: reportedBase },
          head: { sha: head },
        }),
      };
    }
    if (joined === 'api repos/acme/app/git/ref/heads/main') {
      calls.push('base');
      if (failAt === 'base') return { status: 1, stdout: '', stderr: 'offline' };
      return {
        status: 0,
        stdout: JSON.stringify({
          ref: 'refs/heads/main',
          object: { sha: liveBase },
        }),
      };
    }
    throw new Error(`unexpected gh args: ${joined}`);
  };
}

const calls = [];
const ready = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({ calls }),
});
assert.equal(ready.ok, true);
assert.equal(ready.overall, 'READY_FOR_MERGE_CALLS');
assert.equal(ready.mergeAuthorized, true);
assert.equal(ready.mutationPerformed, false);
assert.equal(ready.targets[0].status, 'READY_FOR_MERGE_CALL');
assert.equal(ready.targets[0].gate.expectedHeadSha, HEAD_A);
assert.equal(ready.targets[0].gate.expectedBaseSha, BASE_A);
assert.deepEqual(calls, ['comments', 'pr', 'base']);

const movedHead = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({
    head: HEAD_B,
    comments: [comment({ head: HEAD_B })],
  }),
});
assert.equal(movedHead.ok, false);
assert(movedHead.targets[0].blockers.includes('AUDITED_HEAD_SHA_MISMATCH'));
const movedBase = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({ liveBase: BASE_B }),
});
assert.equal(movedBase.ok, false);
assert(movedBase.targets[0].blockers.includes('BASE_SHA_MISMATCH'));

const missingReceipt = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({ comments: [] }),
});
assert.equal(missingReceipt.ok, false);
assert(missingReceipt.targets[0].blockers.includes('AUTHORIZATION_RECEIPT_REQUIRED'));

const expiredReceipt = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({
    comments: [comment({
      createdAt: new Date(NOW - (31 * 60 * 1000)).toISOString(),
    })],
  }),
});
assert.equal(expiredReceipt.ok, false);
assert(expiredReceipt.targets[0].blockers.includes('AUTHORIZATION_RECEIPT_EXPIRED'));

const draft = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({ draft: true }),
});
assert.equal(draft.ok, false);
assert(draft.targets[0].blockers.includes('PR_DRAFT'));

const closed = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({ state: 'closed' }),
});
assert.equal(closed.ok, false);
assert(closed.targets[0].blockers.includes('PR_NOT_OPEN'));
const queryFailed = await collectBatchMergeExecution(config(), {
  nowMs: NOW,
  runner: makeRunner({ failAt: 'comments' }),
});
assert.equal(queryFailed.ok, false);
assert(queryFailed.targets[0].blockers.includes('GITHUB_QUERY_FAILED'));

const duplicate = config();
duplicate.targets.push(structuredClone(duplicate.targets[0]));
assert.throws(
  () => validateBatchConfig(duplicate),
  /BATCH_MERGE_EXECUTION_CONFIG_TARGET_DUPLICATE/,
);

const badHead = config({ headSha: 'not-a-sha' });
assert.throws(
  () => validateBatchConfig(badHead),
  /BATCH_MERGE_EXECUTION_CONFIG_TARGET_INVALID/,
);

const badAuthor = config();
badAuthor.author = 'bad author';
assert.throws(
  () => validateBatchConfig(badAuthor),
  /BATCH_MERGE_EXECUTION_CONFIG_AUTHOR_INVALID/,
);

console.log('cross-repo-merge-execution-gate selftest: PASS');
