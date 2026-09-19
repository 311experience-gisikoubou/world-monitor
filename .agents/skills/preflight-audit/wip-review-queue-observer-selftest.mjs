#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const observerArg = process.argv[2];
if (!observerArg) throw new Error('observer path required');
const observerPath = resolve(observerArg);
const observerUrl = pathToFileURL(observerPath).href;
const {
  parseArgs, parseEvidenceJson, readEvidenceFile, buildReport, WIP_MAX, MAX_EVIDENCE_BYTES,
} = await import(observerUrl);

const REPO = 'example/repository';
const NOW = Date.parse('2026-09-08T10:30:00Z');
const GENERATED_AT = '2026-09-08T10:30:00.000Z';
const FETCHED_AT = '2026-09-08T10:29:00.000Z';
const sha = ch => ch.repeat(40);
const HEAD_A = sha('a');
const HEAD_B = sha('b');
const HEAD_C = sha('c');

function makePr(overrides = {}) {
  return {
    number: 10,
    state: 'open',
    draft: false,
    additions: 40,
    deletions: 10,
    changedFiles: 3,
    baseRef: 'main',
    headSha: HEAD_A,
    ...overrides,
  };
}
function makeEvidence({
  repository = REPO, fetchedAt = FETCHED_AT, pullRequests = [makePr()], schemaVersion = 1,
  retrievalComplete = true,
} = {}) {
  return { schemaVersion, repository, fetchedAt, retrievalComplete, pullRequests };
}
function report(evidence, nowMs = NOW) {
  return buildReport({ evidence, repo: REPO, nowMs, generatedAt: GENERATED_AT });
}

// --- valid aggregation ---
const valid = report(makeEvidence({
  pullRequests: [
    makePr({ number: 10, additions: 40, deletions: 10, changedFiles: 3, baseRef: 'main', headSha: HEAD_A }),
    makePr({ number: 11, additions: 5, deletions: 2, changedFiles: 1, baseRef: 'develop', headSha: HEAD_B }),
  ],
}));
assert.equal(valid.ok, true);
assert.equal(valid.evidenceFetchedAt, FETCHED_AT, 'report must expose the validated source evidence timestamp');
assert.equal(valid.generatedAt, GENERATED_AT, 'report generation time remains separate metadata');
assert.equal(valid.pendingReviewCount, 2);
assert.equal(valid.totalPendingDiffLines, 57);
assert.equal(valid.decision, 'STOP_NEW_WORK');
assert.deepEqual(valid.pendingPullRequests[0], {
  number: 10, additions: 40, deletions: 10, changedFiles: 3, diffLines: 50, baseRef: 'main', headSha: HEAD_A,
});
assert.deepEqual(valid.pendingPullRequests[1], {
  number: 11, additions: 5, deletions: 2, changedFiles: 1, diffLines: 7, baseRef: 'develop', headSha: HEAD_B,
});

// --- draft/closed filtering ---
const filtered = report(makeEvidence({
  pullRequests: [
    makePr({ number: 1 }),
    makePr({ number: 2, draft: true, headSha: HEAD_B }),
    makePr({ number: 3, state: 'closed', headSha: HEAD_C }),
  ],
}));
assert.equal(filtered.ok, true);
assert.equal(filtered.pendingReviewCount, 1);
assert.equal(filtered.pendingPullRequests.length, 1);
assert.equal(filtered.pendingPullRequests[0].number, 1);
assert.equal(filtered.decision, 'CONTINUE');

// --- stale / future-skewed evidence ---
const stale = report(makeEvidence({ fetchedAt: '2026-09-08T10:00:00.000Z' }));
assert.equal(stale.ok, false);
assert.equal(stale.code, 'EVIDENCE_STALE');
assert.equal(stale.decision, null);
assert.equal(stale.evidenceFetchedAt, null, 'failed validation must not expose an untrusted evidence timestamp');
assert.equal(stale.pendingReviewCount, null);
assert.equal(stale.pendingPullRequests, null);

const fromFuture = report(makeEvidence({ fetchedAt: '2026-09-08T10:40:00.000Z' }));
assert.equal(fromFuture.ok, false);
assert.equal(fromFuture.code, 'EVIDENCE_FROM_FUTURE');

// no skew tolerance: even one second in the future must fail closed
const barelyFuture = report(makeEvidence({ fetchedAt: '2026-09-08T10:30:01.000Z' }));
assert.equal(barelyFuture.ok, false);
assert.equal(barelyFuture.code, 'EVIDENCE_FROM_FUTURE');

// fetchedAt exactly equal to now is not "future" and remains valid
const exactlyNow = report(makeEvidence({ fetchedAt: '2026-09-08T10:30:00.000Z' }));
assert.equal(exactlyNow.ok, true);
assert.equal(exactlyNow.evidenceFetchedAt, '2026-09-08T10:30:00.000Z');

const subMillisecondFuture = report(makeEvidence({ fetchedAt: '2026-09-08T10:30:00.0001Z' }));
assert.equal(subMillisecondFuture.ok, false);
assert.equal(subMillisecondFuture.code, 'EVIDENCE_FETCH_TIME_INVALID');

const invalidCalendarTime = report(makeEvidence({ fetchedAt: '2026-02-31T10:30:00.000Z' }));
assert.equal(invalidCalendarTime.ok, false);
assert.equal(invalidCalendarTime.code, 'EVIDENCE_FETCH_TIME_INVALID');

const invalidFetchTime = report(makeEvidence({ fetchedAt: 'not-a-date' }));
assert.equal(invalidFetchTime.ok, false);
assert.equal(invalidFetchTime.code, 'EVIDENCE_FETCH_TIME_INVALID');

// --- repository mismatch ---
const mismatch = report(makeEvidence({ repository: 'example/other-repository' }));
assert.equal(mismatch.ok, false);
assert.equal(mismatch.code, 'EVIDENCE_REPOSITORY_MISMATCH');

const unsupportedSchema = report(makeEvidence({ schemaVersion: 2 }));
assert.equal(unsupportedSchema.ok, false);
assert.equal(unsupportedSchema.code, 'EVIDENCE_SCHEMA_UNSUPPORTED');

// --- retrievalComplete must be explicitly true; missing/false fails closed ---
const missingRetrievalComplete = report({ ...makeEvidence(), retrievalComplete: undefined });
assert.equal(missingRetrievalComplete.ok, false);
assert.equal(missingRetrievalComplete.code, 'EVIDENCE_RETRIEVAL_INCOMPLETE');

const falseRetrievalComplete = report(makeEvidence({ retrievalComplete: false }));
assert.equal(falseRetrievalComplete.ok, false);
assert.equal(falseRetrievalComplete.code, 'EVIDENCE_RETRIEVAL_INCOMPLETE');

const truthyButNotBooleanRetrievalComplete = report(makeEvidence({ retrievalComplete: 'true' }));
assert.equal(truthyButNotBooleanRetrievalComplete.ok, false);
assert.equal(truthyButNotBooleanRetrievalComplete.code, 'EVIDENCE_RETRIEVAL_INCOMPLETE');

// --- duplicate PR numbers fail closed ---
const duplicatePrNumbers = report(makeEvidence({
  pullRequests: [
    makePr({ number: 7, headSha: HEAD_A }),
    makePr({ number: 7, headSha: HEAD_B }),
  ],
}));
assert.equal(duplicatePrNumbers.ok, false);
assert.equal(duplicatePrNumbers.code, 'EVIDENCE_PULL_REQUEST_DUPLICATE');

// --- malformed numeric / shape fields fail closed ---
const malformedPrCases = [
  { additions: '40' },
  { additions: -1 },
  { additions: 1.5 },
  { deletions: null },
  { changedFiles: 'three' },
  { number: 0 },
  { number: '5' },
  { number: 1.5 },
  { draft: 'no' },
  { state: 'merged' },
  { baseRef: 'bad ref!' },
  { headSha: 'not-a-sha' },
  { headSha: HEAD_A.slice(0, 39) },
  // unsafe integer inputs
  { additions: Number.MAX_SAFE_INTEGER + 1 },
  { number: Number.MAX_SAFE_INTEGER + 1 },
  { additions: Infinity },
  { deletions: -Infinity },
  { changedFiles: NaN },
  { number: Infinity },
];
for (const overrides of malformedPrCases) {
  const result = report(makeEvidence({ pullRequests: [makePr(overrides)] }));
  assert.equal(result.ok, false, `expected failure for ${JSON.stringify(overrides)}`);
  assert.equal(result.code, 'EVIDENCE_PULL_REQUEST_INVALID', `expected EVIDENCE_PULL_REQUEST_INVALID for ${JSON.stringify(overrides)}`);
}
assert.equal(report(makeEvidence({ pullRequests: 'not-an-array' })).code, 'EVIDENCE_SHAPE_INVALID');
assert.equal(report({ ...makeEvidence(), pr: 'unexpected' }).ok, true, 'unknown top-level fields are ignored, not fatal');

const oversizedList = Array.from({ length: 201 }, (_, i) => makePr({ number: i + 1, headSha: sha(((i % 9) + 1).toString()) }));
assert.equal(report(makeEvidence({ pullRequests: oversizedList })).code, 'EVIDENCE_SHAPE_INVALID');

// --- per-PR diff overflow: additions + deletions individually safe but summed unsafe ---
const perPrOverflow = report(makeEvidence({
  pullRequests: [makePr({ number: 1, additions: Number.MAX_SAFE_INTEGER, deletions: 1 })],
}));
assert.equal(perPrOverflow.ok, false);
assert.equal(perPrOverflow.code, 'EVIDENCE_DIFF_OVERFLOW_PER_PR');
assert.equal(perPrOverflow.pendingReviewCount, null);

for (const excludedState of [{ draft: true }, { state: 'closed' }]) {
  const excludedOverflow = report(makeEvidence({
    pullRequests: [makePr({ number: 8, additions: Number.MAX_SAFE_INTEGER, deletions: 1, ...excludedState })],
  }));
  assert.equal(excludedOverflow.ok, false);
  assert.equal(excludedOverflow.code, 'EVIDENCE_DIFF_OVERFLOW_PER_PR');
}

// --- aggregate diff overflow: each PR's diffLines is safe, but the running total is not ---
const aggregateOverflow = report(makeEvidence({
  pullRequests: [
    makePr({ number: 1, additions: Number.MAX_SAFE_INTEGER - 1, deletions: 0, headSha: HEAD_A }),
    makePr({ number: 2, additions: 2, deletions: 0, headSha: HEAD_B }),
  ],
}));
assert.equal(aggregateOverflow.ok, false);
assert.equal(aggregateOverflow.code, 'EVIDENCE_DIFF_OVERFLOW_AGGREGATE');
assert.equal(aggregateOverflow.pendingReviewCount, null);

// --- limit boundary (WIP_MAX = 2) ---
assert.equal(WIP_MAX, 2);
const zeroOpen = report(makeEvidence({ pullRequests: [] }));
assert.equal(zeroOpen.pendingReviewCount, 0);
assert.equal(zeroOpen.decision, 'CONTINUE');
const oneOpen = report(makeEvidence({ pullRequests: [makePr({ number: 1 })] }));
assert.equal(oneOpen.pendingReviewCount, 1);
assert.equal(oneOpen.decision, 'CONTINUE');
const twoOpen = report(makeEvidence({ pullRequests: [makePr({ number: 1 }), makePr({ number: 2, headSha: HEAD_B })] }));
assert.equal(twoOpen.pendingReviewCount, 2);
assert.equal(twoOpen.decision, 'STOP_NEW_WORK');
const threeOpen = report(makeEvidence({
  pullRequests: [makePr({ number: 1 }), makePr({ number: 2, headSha: HEAD_B }), makePr({ number: 3, headSha: HEAD_C })],
}));
assert.equal(threeOpen.pendingReviewCount, 3);
assert.equal(threeOpen.decision, 'STOP_NEW_WORK');

// --- oversized evidence file fails closed before parsing ---
const tempRoot = await mkdtemp(join(tmpdir(), 'wip-review-queue-observer-selftest-'));
try {
  const bigFile = join(tempRoot, 'oversized-evidence.json');
  const padded = `${JSON.stringify(makeEvidence())}${' '.repeat(MAX_EVIDENCE_BYTES + 100)}`;
  await writeFile(bigFile, padded, 'utf8');
  await assert.rejects(readEvidenceFile(bigFile), /EVIDENCE_FILE_TOO_LARGE/);

  const okFile = join(tempRoot, 'ok-evidence.json');
  await writeFile(okFile, JSON.stringify(makeEvidence()), 'utf8');
  const readBack = await readEvidenceFile(okFile);
  assert.deepEqual(readBack, makeEvidence());

  // --- unreadable evidence file: no raw filesystem message/path is leaked ---
  const missingFile = join(tempRoot, 'does-not-exist.json');
  await assert.rejects(readEvidenceFile(missingFile), (error) => {
    assert.equal(error.code, 'EVIDENCE_FILE_READ_FAILED');
    assert.equal(error.message.includes(tempRoot), false, 'file path leaked into error message');
    return true;
  });

  // --- safe output: extra/sensitive PR fields never propagate ---
  const secretPr = makePr({ number: 5 });
  secretPr.title = 'SECRET_TITLE';
  secretPr.body = 'SECRET_BODY';
  secretPr.author = { login: 'SECRET_AUTHOR', email: 'secret@example.invalid' };
  secretPr.token = 'SECRET_TOKEN';
  const secretFile = join(tempRoot, 'secret-evidence.json');
  await writeFile(secretFile, JSON.stringify(makeEvidence({ pullRequests: [secretPr] })), 'utf8');
  const safeResult = report(await readEvidenceFile(secretFile));
  assert.equal(safeResult.ok, true);
  const safeText = JSON.stringify(safeResult);
  for (const forbidden of ['SECRET_TITLE', 'SECRET_BODY', 'SECRET_AUTHOR', 'secret@example.invalid', 'SECRET_TOKEN']) {
    assert.equal(safeText.includes(forbidden), false, `sensitive fixture leaked: ${forbidden}`);
  }

  // --- CLI end-to-end: exit codes and machine-readable status lines ---
  const passFile = join(tempRoot, 'cli-pass.json');
  const passFetchedAt = new Date().toISOString();
  await writeFile(passFile, JSON.stringify(makeEvidence({ fetchedAt: passFetchedAt })), 'utf8');
  const passRun = spawnSync(process.execPath, [observerPath, '--repo', REPO, '--evidence-file', passFile], { encoding: 'utf8' });
  assert.equal(passRun.status, 0, passRun.stderr);
  assert.match(passRun.stdout, /WIP_REVIEW_QUEUE_OBSERVER=CONTINUE/);
  assert.equal(passRun.stdout.includes(`"evidenceFetchedAt": "${passFetchedAt}"`), true, 'CLI must expose the validated evidence timestamp');

  const stopFile = join(tempRoot, 'cli-stop.json');
  await writeFile(stopFile, JSON.stringify(makeEvidence({
    fetchedAt: new Date().toISOString(),
    pullRequests: [makePr({ number: 1 }), makePr({ number: 2, headSha: HEAD_B })],
  })), 'utf8');
  const stopRun = spawnSync(process.execPath, [observerPath, '--repo', REPO, '--evidence-file', stopFile], { encoding: 'utf8' });
  assert.equal(stopRun.status, 0, stopRun.stderr);
  assert.match(stopRun.stdout, /WIP_REVIEW_QUEUE_OBSERVER=STOP_NEW_WORK/);

  const failRun = spawnSync(process.execPath, [observerPath, '--repo', REPO, '--evidence-file', bigFile], { encoding: 'utf8' });
  assert.equal(failRun.status, 2);
  assert.match(failRun.stderr, /WIP_REVIEW_QUEUE_OBSERVER=FAIL/);
  assert.match(failRun.stderr, /EVIDENCE_FILE_TOO_LARGE/);

  const mismatchFile = join(tempRoot, 'cli-mismatch.json');
  await writeFile(mismatchFile, JSON.stringify(makeEvidence({ repository: 'example/other-repository', fetchedAt: new Date().toISOString() })), 'utf8');
  const mismatchRun = spawnSync(process.execPath, [observerPath, '--repo', REPO, '--evidence-file', mismatchFile], { encoding: 'utf8' });
  assert.equal(mismatchRun.status, 2);
  assert.match(mismatchRun.stderr, /WIP_REVIEW_QUEUE_OBSERVER=FAIL/);
  assert.match(mismatchRun.stdout, /EVIDENCE_REPOSITORY_MISMATCH/);

  // --- CLI failure paths never echo raw exception content (paths, arbitrary args) ---
  const missingCliFile = join(tempRoot, 'definitely-does-not-exist.json');
  const missingCliRun = spawnSync(process.execPath, [observerPath, '--repo', REPO, '--evidence-file', missingCliFile], { encoding: 'utf8' });
  assert.equal(missingCliRun.status, 2);
  assert.match(missingCliRun.stderr, /EVIDENCE_FILE_READ_FAILED/);
  assert.equal(missingCliRun.stderr.includes(missingCliFile), false, 'CLI leaked evidence file path in failure output');
  assert.equal(missingCliRun.stderr.includes(tempRoot), false, 'CLI leaked evidence file path in failure output');

  const unknownArgRun = spawnSync(process.execPath, [observerPath, '--repo', REPO, '--evidence-file', passFile, '--secret-flag-name', 'x'], { encoding: 'utf8' });
  assert.equal(unknownArgRun.status, 2);
  assert.match(unknownArgRun.stderr, /CLI_ARGUMENT_UNKNOWN/);
  assert.equal(unknownArgRun.stderr.includes('secret-flag-name'), false, 'CLI leaked arbitrary argument name in failure output');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

// --- CLI argument parsing: fixed allow-listed error codes only ---
assert.deepEqual(
  parseArgs(['--repo', REPO, '--evidence-file', 'evidence.json']),
  { repo: REPO, 'evidence-file': 'evidence.json' },
);
assert.throws(() => parseArgs(['--repo', REPO, '--repo', REPO]), (error) => error.code === 'CLI_ARGUMENT_DUPLICATE');
assert.throws(() => parseArgs(['--reop', REPO]), (error) => error.code === 'CLI_ARGUMENT_UNKNOWN');
assert.throws(() => parseArgs(['--evidence-file', '']), (error) => error.code === 'CLI_ARGUMENTS_MALFORMED');

// --- evidence JSON parsing (BOM handling, invalid JSON) ---
const bomEvidence = makeEvidence();
const bomPrefixedJson = String.fromCharCode(0xFEFF) + JSON.stringify(bomEvidence);
assert.deepEqual(parseEvidenceJson(bomPrefixedJson), bomEvidence, 'BOM evidence parsing');
assert.throws(() => parseEvidenceJson('not-json'), (error) => error.code === 'EVIDENCE_JSON_INVALID');
assert.throws(() => parseEvidenceJson('null'), (error) => error.code === 'EVIDENCE_JSON_INVALID');
assert.throws(() => parseEvidenceJson('[]'), (error) => error.code === 'EVIDENCE_JSON_INVALID');

console.log('wip-review-queue-observer selftest: PASS');
