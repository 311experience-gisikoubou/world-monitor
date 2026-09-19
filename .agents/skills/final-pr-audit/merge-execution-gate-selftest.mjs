#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fetchJson, loadEvidenceFromCli, parseArgs, parseEvidenceJson, runMergeExecutionGate } from './merge-execution-gate.mjs';

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE_A = '1111111111111111111111111111111111111111';
const BASE_B = '2222222222222222222222222222222222222222';
const NOW = Date.parse('2026-09-08T10:30:00Z');
const AUTHOR = 'foundation-test-author';

function receipt({ pr = 52, head = HEAD_A, source = 'EXPLICIT_HUMAN' } = {}) {
  return [
    'MERGE_AUTHORIZATION_V1',
    `PR: ${pr}`,
    `HEAD: ${head}`,
    'AUTHORIZED: YES',
    `SOURCE: ${source}`,
  ].join('\n');
}

function makePr(overrides = {}) {
  return {
    number: 52,
    state: 'open',
    merged_at: null,
    draft: false,
    base: { ref: 'main', sha: BASE_A },
    head: { sha: HEAD_A },
    ...overrides,
  };
}
function comment(body, { login = AUTHOR, createdAt = '2026-09-08T10:25:00Z', id = 100 } = {}) {
  return { id, body, created_at: createdAt, user: { login } };
}

function fakeFetch(pr, comments, options = {}) {
  const liveBaseSha = options.liveBaseSha ?? pr?.base?.sha ?? BASE_A;
  const liveBaseRef = options.liveBaseRef ?? 'refs/heads/main';
  return async url => {
    if (url.includes('/issues/52/comments')) {
      const page = new URL(url).searchParams.get('page');
      return { ok: true, status: 200, json: async () => (page === '1' ? comments : []) };
    }
    if (url.includes('/pulls/52')) return { ok: true, status: 200, json: async () => pr };
    if (url.includes('/git/ref/heads/')) return { ok: true, status: 200, json: async () => ({ ref: liveBaseRef, object: { sha: liveBaseSha } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function run(pr, comments, expectedBaseSha = BASE_A, liveOptions = {}) {
  return runMergeExecutionGate({
    repo: 'example/repository', prNumber: 52, baseBranch: 'main', expectedBaseSha, author: AUTHOR, nowMs: NOW,
    fetchImpl: fakeFetch(pr, comments, liveOptions),
  });
}

function makeEvidence({ repository = 'example/repository', fetchedAt = '2026-09-08T10:29:00Z', pr = makePr(), liveBase = { ref: 'refs/heads/main', sha: BASE_A }, authorizationComments = [comment(receipt())], schemaVersion = 3 } = {}) {
  return { schemaVersion, repository, fetchedAt, pr, liveBase, authorizationComments };
}

async function runEvidence(evidence) {
  return runMergeExecutionGate({
    repo: 'example/repository',
    prNumber: 52,
    baseBranch: 'main',
    expectedBaseSha: BASE_A,
    author: AUTHOR,
    nowMs: NOW,
    evidence,
  });
}

async function expectEvidenceFail(evidence, code) {
  const result = await runEvidence(evidence);
  assert.equal(result.pass, false);
  assert.equal(result.finding, code);
  assert.equal(result.expectedHeadSha, null);
}

async function expectFail(pr, comments, code) {
  const result = await run(pr, comments);
  assert.equal(result.pass, false);
  assert.equal(result.finding, code);
  assert.equal(result.expectedHeadSha, null);
}
const valid = await run(makePr(), [comment(receipt())]);
assert.equal(valid.pass, true);
assert.equal(valid.expectedHeadSha, HEAD_A);
assert.equal(valid.expectedBaseSha, BASE_A);
assert.equal(valid.actualBaseSha, BASE_A);
assert.equal(valid.reportedPrBaseSha, BASE_A);
assert.equal(valid.authorizationCommentId, 100);
assert.equal(valid.authorizationSource, 'EXPLICIT_HUMAN');

const BASE_WITH_LETTERS = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
const uppercaseExpectedBase = await run(makePr({ base: { ref: 'main', sha: BASE_WITH_LETTERS } }), [comment(receipt())], BASE_WITH_LETTERS.toUpperCase());
assert.equal(uppercaseExpectedBase.pass, true, 'expected base SHA is normalized case-insensitively');
await assert.rejects(
  runMergeExecutionGate({ repo: 'example/repository', prNumber: 52, baseBranch: 'main', author: AUTHOR, nowMs: NOW, fetchImpl: fakeFetch(makePr(), [comment(receipt())]) }),
  /Invalid expected base SHA/,
);
await assert.rejects(
  runMergeExecutionGate({ repo: 'example/repository', prNumber: 52, baseBranch: 'main', expectedBaseSha: 'not-a-sha', author: AUTHOR, nowMs: NOW, fetchImpl: fakeFetch(makePr(), [comment(receipt())]) }),
  /Invalid expected base SHA/,
);

const persisted = await run(makePr(), [comment(receipt({ source: 'PERSISTED_AFTER_AUDIT' }))]);
assert.equal(persisted.pass, true);
assert.equal(persisted.authorizationSource, 'PERSISTED_AFTER_AUDIT');

await expectFail(makePr(), [], 'AUTHORIZATION_RECEIPT_REQUIRED');
await expectFail(makePr(), [comment(receipt({ head: HEAD_B }))], 'AUTHORIZATION_HEAD_MISMATCH');
await expectFail(makePr(), [comment(receipt({ pr: 51 }))], 'AUTHORIZATION_PR_MISMATCH');
await expectFail(makePr(), [comment(receipt(), { login: 'someone-else' })], 'AUTHORIZATION_AUTHOR_MISMATCH');
await expectFail(
  makePr(),
  [comment(receipt(), { createdAt: '2026-09-08T09:00:00Z' })],
  'AUTHORIZATION_RECEIPT_EXPIRED',
);

const merged = await run(makePr({ state: 'closed', merged_at: '2026-09-08T10:29:00Z' }), [comment(receipt())]);
assert.equal(merged.pass, false);
assert.equal(merged.checks.prOpen, false);
assert.equal(merged.expectedHeadSha, null);
const draft = await run(makePr({ draft: true }), [comment(receipt())]);
assert.equal(draft.pass, false);
assert.equal(draft.checks.notDraft, false);

const wrongBase = await run(makePr({ base: { ref: 'release', sha: BASE_A } }), [comment(receipt())]);
assert.equal(wrongBase.pass, false);
assert.equal(wrongBase.checks.baseBranch, false);
assert.equal(wrongBase.finding, 'BASE_BRANCH_MISMATCH');

const mismatchedLiveRef = await run(makePr(), [comment(receipt())], BASE_A, { liveBaseRef: 'refs/heads/release' });
assert.equal(mismatchedLiveRef.pass, false, 'returned live ref must match the requested base branch');
assert.equal(mismatchedLiveRef.finding, 'BASE_BRANCH_MISMATCH');

const malformedLiveRef = await run(makePr(), [comment(receipt())], BASE_A, { liveBaseSha: '' });
assert.equal(malformedLiveRef.pass, false, 'malformed live ref SHA must fail closed');
assert.equal(malformedLiveRef.finding, 'BASE_SHA_MISMATCH');

const slashPr = makePr({ base: { ref: 'release/hotfix', sha: BASE_A } });
const slashDelegate = fakeFetch(slashPr, [comment(receipt())], { liveBaseRef: 'refs/heads/release/hotfix', liveBaseSha: BASE_A });
const slashUrls = [];
const slashResult = await runMergeExecutionGate({
  repo: 'example/repository', prNumber: 52, baseBranch: 'release/hotfix', expectedBaseSha: BASE_A, author: AUTHOR, nowMs: NOW,
  fetchImpl: async (url, options) => { slashUrls.push(url); return slashDelegate(url, options); },
});
assert.equal(slashResult.pass, true, 'slash-containing base branch should use a valid live-ref route');
assert.equal(slashUrls.at(-1), 'https://api.github.com/repos/example/repository/git/ref/heads/release/hotfix');

const refFetchFailure = await assert.rejects(
  runMergeExecutionGate({
    repo: 'example/repository', prNumber: 52, baseBranch: 'main', expectedBaseSha: BASE_A, author: AUTHOR, nowMs: NOW,
    fetchImpl: async url => {
      if (url.includes('/issues/52/comments')) return { ok: true, status: 200, json: async () => [comment(receipt())] };
      if (url.includes('/pulls/52')) return { ok: true, status: 200, json: async () => makePr() };
      return { ok: false, status: 503, json: async () => ({}) };
    },
  }),
  /GitHub API HTTP 503/,
);

const stalePrBase = await run(makePr(), [comment(receipt())], BASE_A, { liveBaseSha: BASE_B });
assert.equal(stalePrBase.pass, false, 'stale PR base.sha must not hide a live target-branch advance');
assert.equal(stalePrBase.finding, 'BASE_SHA_MISMATCH');
assert.equal(stalePrBase.reportedPrBaseSha, BASE_A);
assert.equal(stalePrBase.actualBaseSha, BASE_B);

const stalePrBaseRefreshedAudit = await run(makePr(), [comment(receipt({ source: 'PERSISTED_AFTER_AUDIT' }))], BASE_B, { liveBaseSha: BASE_B });
assert.equal(stalePrBaseRefreshedAudit.pass, true, 'fresh audit may bind to live base even while PR base.sha remains stale');
assert.equal(stalePrBaseRefreshedAudit.reportedPrBaseSha, BASE_A);
assert.equal(stalePrBaseRefreshedAudit.actualBaseSha, BASE_B);

const advancedBase = await run(makePr({ base: { ref: 'main', sha: BASE_B } }), [comment(receipt())]);
assert.equal(advancedBase.pass, false);
assert.equal(advancedBase.checks.baseSha, false);
assert.equal(advancedBase.finding, 'BASE_SHA_MISMATCH');
assert.equal(advancedBase.actualBaseSha, BASE_B);
assert.equal(advancedBase.expectedBaseSha, BASE_A);
assert.equal(advancedBase.expectedHeadSha, null);

const refreshedBase = await run(makePr({ base: { ref: 'main', sha: BASE_B } }), [comment(receipt({ source: 'PERSISTED_AFTER_AUDIT' }))], BASE_B);
assert.equal(refreshedBase.pass, true, 'fresh audit may bind the same authorized HEAD to the refreshed base');
assert.equal(refreshedBase.expectedBaseSha, BASE_B);
assert.equal(refreshedBase.authorizationSource, 'PERSISTED_AFTER_AUDIT');

let livePr = makePr();
const fetchOrder = [];
const driftDuringCommentFetch = async url => {
  if (url.includes('/issues/52/comments')) {
    fetchOrder.push('comments');
    livePr = makePr({ base: { ref: 'main', sha: BASE_B } });
    return { ok: true, status: 200, json: async () => [comment(receipt())] };
  }
  if (url.includes('/pulls/52')) {
    fetchOrder.push('pr');
    return { ok: true, status: 200, json: async () => livePr };
  }
  if (url.includes('/git/ref/heads/main')) {
    fetchOrder.push('live-base');
    return { ok: true, status: 200, json: async () => ({ ref: 'refs/heads/main', object: { sha: livePr.base.sha } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const lateBaseDrift = await runMergeExecutionGate({
  repo: 'example/repository', prNumber: 52, baseBranch: 'main', expectedBaseSha: BASE_A, author: AUTHOR,
  nowMs: NOW, fetchImpl: driftDuringCommentFetch,
});
assert.equal(lateBaseDrift.pass, false, 'base drift during receipt retrieval must be seen by the final live target-branch snapshot');
assert.equal(lateBaseDrift.finding, 'BASE_SHA_MISMATCH');
assert.deepEqual(fetchOrder, ['comments', 'pr', 'live-base'], 'live route fetches comments, PR state, then live base ref last');

const beforeDrift = await run(makePr(), [comment(receipt())]);
assert.equal(beforeDrift.pass, true);
const afterDrift = await run(makePr({ head: { sha: HEAD_B } }), [comment(receipt())]);
assert.equal(afterDrift.pass, false);
assert.equal(afterDrift.finding, 'AUTHORIZATION_HEAD_MISMATCH');

assert.deepEqual(
  parseArgs(['--repo', 'example/repository', '--pr', '52', '--base', 'main', '--base-sha', BASE_A, '--author', AUTHOR]),
  { repo: 'example/repository', pr: '52', base: 'main', 'base-sha': BASE_A, author: AUTHOR },
  'strict CLI argument parsing',
);
assert.throws(() => parseArgs(['--repo', 'a/b', '--repo', 'c/d']), /Duplicate argument/);
assert.throws(() => parseArgs(['--reop', 'a/b']), /Unknown argument/);
assert.throws(() => parseArgs(['--evidence-file', '']), /Invalid arguments/);
assert.equal(parseArgs(['--evidence-stdin'])['evidence-stdin'], true, 'stdin evidence flag parses without a value');
assert.throws(() => parseArgs(['--evidence-stdin', '--evidence-stdin']), /Duplicate argument/);

const bomEvidence = makeEvidence();
assert.deepEqual(parseEvidenceJson(`\uFEFF${JSON.stringify(bomEvidence)}`), bomEvidence, 'BOM evidence parsing');
assert.throws(() => parseEvidenceJson('not-json'), /Invalid evidence JSON/);
assert.throws(() => parseEvidenceJson('null'), /Invalid evidence JSON/);

const evidenceJson = JSON.stringify(makeEvidence());
const stdinLoaded = await loadEvidenceFromCli({ 'evidence-stdin': true }, { stdin: Readable.from([evidenceJson]) });
const fileLoaded = await loadEvidenceFromCli({ 'evidence-file': 'fixture.json' }, { readFileImpl: async () => evidenceJson });
assert.deepEqual(stdinLoaded, fileLoaded, 'stdin and file evidence parse to the same schema-v3 object');
assert.deepEqual(await runEvidence(stdinLoaded), await runEvidence(fileLoaded), 'equivalent stdin/file evidence yields identical gate decision');
await assert.rejects(loadEvidenceFromCli({ 'evidence-stdin': true }, { stdin: Readable.from(['not-json']) }), /Invalid evidence JSON/);
await assert.rejects(loadEvidenceFromCli({ 'evidence-file': 'fixture.json', 'evidence-stdin': true }, { stdin: Readable.from([evidenceJson]), readFileImpl: async () => evidenceJson }), /only one/);
await assert.rejects(loadEvidenceFromCli({ 'evidence-stdin': true }, { stdin: Readable.from([]) }), /empty/);
await assert.rejects(loadEvidenceFromCli({ 'evidence-stdin': true }, { stdin: Readable.from(['x'.repeat(64 * 1024 + 1)]) }), /too large/);

let delayedClock = Date.parse('2026-09-08T10:20:00Z');
const delayedFetchBase = fakeFetch(makePr(), [comment(receipt(), { createdAt: '2026-09-08T10:00:00Z' })]);
const delayedFetch = async (url, options) => {
  const result = await delayedFetchBase(url, options);
  delayedClock = Date.parse('2026-09-08T10:31:00Z');
  return result;
};
const delayedExpiry = await runMergeExecutionGate({
  repo: 'example/repository', prNumber: 52, baseBranch: 'main', expectedBaseSha: BASE_A, author: AUTHOR,
  nowFn: () => delayedClock, fetchImpl: delayedFetch,
});
assert.equal(delayedExpiry.pass, false, 'receipt expires after fetch delay');
assert.equal(delayedExpiry.finding, 'AUTHORIZATION_RECEIPT_EXPIRED');

let stalledBodyAborted = false;
await assert.rejects(
  fetchJson('https://example.invalid/test', async (_url, options) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { stalledBodyAborted = true; reject(new Error('stalled response body aborted')); }, { once: true });
    }),
  }), 20),
  /stalled response body aborted/,
);
assert.equal(stalledBodyAborted, true);

let sawAbortSignal = false;
const signalFetchBase = fakeFetch(makePr(), [comment(receipt())]);
const signalFetch = async (url, options) => {
  sawAbortSignal ||= options?.signal instanceof AbortSignal;
  return signalFetchBase(url, options);
};
const signalResult = await runMergeExecutionGate({
  repo: 'example/repository', prNumber: 52, baseBranch: 'main', expectedBaseSha: BASE_A, author: AUTHOR,
  nowMs: NOW, fetchImpl: signalFetch,
});
assert.equal(signalResult.pass, true);
assert.equal(sawAbortSignal, true, 'GitHub fetch receives abort signal');

let nullEvidenceFetchCalled = false;
const nullEvidence = await runMergeExecutionGate({
  repo: 'example/repository', prNumber: 52, baseBranch: 'main', expectedBaseSha: BASE_A, author: AUTHOR,
  nowMs: NOW, evidence: null,
  fetchImpl: async () => { nullEvidenceFetchCalled = true; throw new Error('must not fetch'); },
});
assert.equal(nullEvidence.pass, false, 'explicit null evidence must not fetch');
assert.equal(nullEvidence.finding, 'EVIDENCE_SHAPE_INVALID');
assert.equal(nullEvidenceFetchCalled, false);

const validEvidence = await runEvidence(makeEvidence());
assert.equal(validEvidence.pass, true);
assert.equal(validEvidence.expectedHeadSha, HEAD_A);

const stalePrivatePrBase = await runEvidence(makeEvidence({ pr: makePr(), liveBase: { ref: 'refs/heads/main', sha: BASE_B } }));
assert.equal(stalePrivatePrBase.pass, false);
assert.equal(stalePrivatePrBase.finding, 'BASE_SHA_MISMATCH');
assert.equal(stalePrivatePrBase.reportedPrBaseSha, BASE_A);
assert.equal(stalePrivatePrBase.actualBaseSha, BASE_B);

await expectEvidenceFail(makeEvidence({ repository: 'example/other' }), 'EVIDENCE_REPOSITORY_MISMATCH');
await expectEvidenceFail(makeEvidence({ schemaVersion: 2 }), 'EVIDENCE_SCHEMA_UNSUPPORTED');
await expectEvidenceFail(makeEvidence({ schemaVersion: 1 }), 'EVIDENCE_SCHEMA_UNSUPPORTED');
await expectEvidenceFail(makeEvidence({ fetchedAt: '2026-09-08T10:00:00Z' }), 'EVIDENCE_STALE');
await expectEvidenceFail(makeEvidence({ fetchedAt: '2026-09-08T10:40:00Z' }), 'EVIDENCE_FROM_FUTURE');
await expectEvidenceFail(makeEvidence({ pr: makePr({ number: 51 }) }), 'EVIDENCE_PR_MISMATCH');
await expectEvidenceFail(makeEvidence({ pr: makePr({ base: { ref: 'main' } }) }), 'EVIDENCE_SHAPE_INVALID');
await expectEvidenceFail(makeEvidence({ pr: makePr({ head: {} }) }), 'EVIDENCE_SHAPE_INVALID');
await expectEvidenceFail(makeEvidence({ liveBase: null }), 'EVIDENCE_SHAPE_INVALID');
await expectEvidenceFail(makeEvidence({ liveBase: { ref: 'refs/heads/main', sha: 'bad' } }), 'EVIDENCE_SHAPE_INVALID');
await expectEvidenceFail(makeEvidence({ authorizationComments: [{ body: receipt(), created_at: '2026-09-08T10:25:00Z', user: {} }] }), 'EVIDENCE_SHAPE_INVALID');

const malformed = `${receipt()}\nEXTRA: no`;
await expectFail(makePr(), [comment(malformed)], 'AUTHORIZATION_RECEIPT_REQUIRED');

console.log('merge-execution-gate selftest: PASS');
