#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, validateImprovementFollowupEvidence, buildDispatchReport } from './improvement-followup.mjs';

const scriptPath = fileURLToPath(new URL('./improvement-followup.mjs', import.meta.url));
const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const REPO = 'acme/app';
const PROJECT_CONTEXT_ID = 'ai-common-platform-v1';
const OWNER = 'maintainer-bot';
const FETCHED_AT = '2026-10-11T11:58:00.000Z';

function item(overrides = {}) {
  return {
    id: 'issue-100',
    sourceType: 'issue',
    number: 100,
    title: 'Improve WIP evidence message',
    summary: 'The WIP observer error message could cite the offending PR number.',
    owner: OWNER,
    projectContextId: PROJECT_CONTEXT_ID,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    state: 'open',
    labels: ['improvement'],
    protectedData: false,
    claimedCompletion: false,
    runnerEvidence: null,
    ...overrides,
  };
}

function evidence(items, overrides = {}) {
  return {
    schemaVersion: 1,
    repository: REPO,
    projectContextId: PROJECT_CONTEXT_ID,
    expectedOwner: OWNER,
    fetchedAt: FETCHED_AT,
    retrievalComplete: true,
    knownRecords: [],
    items,
    ...overrides,
  };
}

function run(items, overrides = {}) {
  return buildReport({
    evidence: evidence(items, overrides),
    repo: REPO,
    projectContextId: PROJECT_CONTEXT_ID,
    nowMs: NOW,
    generatedAt: new Date(NOW).toISOString(),
  });
}

// 1. known improvement: a fresh, labeled, open item becomes a NEW candidate,
//    with evidence/time/owner preserved verbatim.
{
  const report = run([item()]);
  assert.equal(report.ok, true);
  assert.equal(report.decision, 'HAS_FOLLOWUP');
  assert.equal(report.newCandidateCount, 1);
  assert.equal(report.needsVerificationCount, 0);
  assert.equal(report.excluded.length, 0);
  const [candidate] = report.candidates;
  assert.equal(candidate.status, 'NEW');
  assert.equal(candidate.owner, OWNER);
  assert.equal(candidate.createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(candidate.updatedAt, '2026-10-10T00:00:00.000Z');
}

// 2. no improvement: a qualifying-label-free item is excluded, never counted
//    as a candidate.
{
  const report = run([item({ id: 'issue-101', labels: ['bug'] })]);
  assert.equal(report.ok, true);
  assert.equal(report.decision, 'NO_FOLLOWUP');
  assert.equal(report.candidates.length, 0);
  assert.deepEqual(report.excluded, [{ id: 'issue-101', code: 'NOT_IMPROVEMENT' }]);
}

// 3. duplicates: an item id already present in knownRecords is deduplicated
//    away rather than re-reported as new.
{
  const report = run([item()], { knownRecords: ['issue-100'] });
  assert.equal(report.ok, true);
  assert.equal(report.decision, 'NO_FOLLOWUP');
  assert.deepEqual(report.excluded, [{ id: 'issue-100', code: 'DUPLICATE_KNOWN_RECORD' }]);
}

// 4. stale evidence: an item whose own updatedAt is far older than the
//    staleness threshold is excluded rather than resurfaced as new.
{
  const report = run([item({
    id: 'issue-102',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  })]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.excluded, [{ id: 'issue-102', code: 'STALE_EVIDENCE' }]);
}

// 5a. wrong project: an item claiming a different project context than the
//     active one is rejected as drift, never silently adopted.
{
  const report = run([item({ id: 'issue-103', projectContextId: 'some-other-project' })]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.excluded, [{ id: 'issue-103', code: 'PROJECT_CONTEXT_DRIFT' }]);
}

// 5b. wrong owner: an item whose owner does not match the expected owner is
//     rejected rather than silently attributed.
{
  const report = run([item({ id: 'issue-104', owner: 'someone-else' })]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.excluded, [{ id: 'issue-104', code: 'OWNER_MISMATCH' }]);
}

// 6. protected data: an item flagged as carrying protected data is excluded,
//    and its content is never echoed back (only id + reason code).
{
  const report = run([item({ id: 'issue-105', protectedData: true })]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.excluded, [{ id: 'issue-105', code: 'PROTECTED_DATA_EXCLUDED' }]);
  assert.equal(JSON.stringify(report.excluded).includes('summary'), false);
}

// 7. issue-only without start proof: the item text claims the work is
//    executed/completed, but no actual runner evidence backs that claim.
//    It must stay a NEEDS_VERIFICATION candidate, never a resolved one.
{
  const report = run([item({ id: 'issue-106', claimedCompletion: true, runnerEvidence: null })]);
  assert.equal(report.ok, true);
  assert.equal(report.needsVerificationCount, 1);
  assert.equal(report.newCandidateCount, 0);
  const [candidate] = report.candidates;
  assert.equal(candidate.status, 'NEEDS_VERIFICATION');
  assert.equal(report.excluded.length, 0);
}
{
  // Also unverified when runnerEvidence is present but not a completed state.
  const report = run([item({
    id: 'issue-107', claimedCompletion: true,
    runnerEvidence: { present: true, source: 'ai-job', state: 'IMPLEMENTING' },
  })]);
  assert.equal(report.candidates[0].status, 'NEEDS_VERIFICATION');
}
{
  // A caller-supplied runnerEvidence claiming a canonical completed state
  // (source: work-state-report, state: DONE) is still only schema-shaped
  // Issue/PR metadata -- no authenticated job identity, owner claim,
  // receipt, repo/branch/HEAD, or test/PR proof backs it. It must NEVER be
  // silently reported as CONFIRMED_RESOLVED; it stays NEEDS_VERIFICATION.
  const report = run([item({
    id: 'issue-108', claimedCompletion: true,
    runnerEvidence: { present: true, source: 'work-state-report', state: 'DONE' },
  })]);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].status, 'NEEDS_VERIFICATION');
  assert.equal(report.excluded.length, 0);
}
{
  // Same false-attribution bug, but with READY_FOR_REVIEW and
  // claimedCompletion carried alongside: still unverified metadata only.
  const report = run([item({
    id: 'issue-109', claimedCompletion: true,
    runnerEvidence: { present: true, source: 'work-state-report', state: 'READY_FOR_REVIEW' },
  })]);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].status, 'NEEDS_VERIFICATION');
  assert.equal(report.excluded.length, 0);
}
{
  // A forged/untrusted "ai-job" source claiming DONE is likewise never
  // sufficient to confirm resolution by itself.
  const report = run([item({
    id: 'issue-110', claimedCompletion: true,
    runnerEvidence: { present: true, source: 'ai-job', state: 'DONE' },
  })]);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].status, 'NEEDS_VERIFICATION');
}
{
  // An incomplete claim (claimedCompletion true, but no runnerEvidence at
  // all, already covered by issue-106 above) plus a closed source item:
  // closed state must not override the unverified-completion classification
  // when a completion claim is present.
  const report = run([item({
    id: 'issue-111', state: 'closed', claimedCompletion: true, runnerEvidence: null,
  })]);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].status, 'NEEDS_VERIFICATION');
}
{
  // A closed source item with no completion claim at all is simply not
  // actionable (unaffected by this fix).
  const report = run([item({
    id: 'issue-112', state: 'closed', claimedCompletion: false, runnerEvidence: null,
  })]);
  assert.equal(report.candidates.length, 0);
  assert.deepEqual(report.excluded, [{ id: 'issue-112', code: 'CLOSED_NOT_ACTIONABLE' }]);
}

// Batch-level fail-closed checks.
assert.equal(run([item()], { repository: 'acme/other' }).code, 'EVIDENCE_REPOSITORY_MISMATCH');
assert.equal(run([item()], { projectContextId: 'other-project' }).code, 'EVIDENCE_PROJECT_CONTEXT_MISMATCH');
assert.equal(run([item()], { retrievalComplete: false }).code, 'EVIDENCE_RETRIEVAL_INCOMPLETE');
assert.equal(run([item()], { fetchedAt: '2026-10-11T11:30:00.000Z' }).code, 'EVIDENCE_STALE');
assert.equal(run([item()], { fetchedAt: '2026-10-11T12:30:00.000Z' }).code, 'EVIDENCE_FROM_FUTURE');
assert.equal(run([item()], { schemaVersion: 2 }).code, 'EVIDENCE_SCHEMA_UNSUPPORTED');
assert.equal(run([item()], { expectedOwner: 'bad owner!' }).code, 'EVIDENCE_EXPECTED_OWNER_INVALID');
assert.equal(run([item()], { unknownField: true }).code, 'EVIDENCE_SHAPE_INVALID');
assert.equal(run([item(), item()]).code, 'EVIDENCE_ITEM_DUPLICATE');
assert.equal(run([item({ title: '' })]).code, 'EVIDENCE_ITEM_INVALID');
assert.equal(run([item({ updatedAt: '2025-09-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' })]).code, 'EVIDENCE_ITEM_INVALID');
assert.equal(run([item()], { knownRecords: ['issue-100', 'issue-100'] }).code, 'EVIDENCE_KNOWN_RECORD_DUPLICATE');
assert.equal(run(new Array(201).fill(0).map((_, i) => item({ id: `issue-${i}` }))).code, 'EVIDENCE_SHAPE_INVALID');

// validateImprovementFollowupEvidence is independently usable and returns the
// same fail-closed code as buildReport for malformed input.
{
  const validated = validateImprovementFollowupEvidence(evidence([item()]), {
    repo: REPO, projectContextId: PROJECT_CONTEXT_ID, nowMs: NOW,
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.expectedOwner, OWNER);
}

// CLI smoke test: happy path and malformed-evidence fail-closed exit code.
// The CLI subprocess uses the real wall-clock Date.now(), unlike the
// in-process tests above (which bind an explicit fixed nowMs), so this
// fixture uses clock-relative timestamps rather than fixed calendar dates.
{
  const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
  const liveGoodItem = item({
    createdAt: isoAgo(2 * 24 * 60 * 60 * 1000),
    updatedAt: isoAgo(60 * 60 * 1000),
  });
  const liveEvidence = evidence([liveGoodItem], { fetchedAt: isoAgo(60 * 1000) });
  const dir = mkdtempSync(join(tmpdir(), 'improvement-followup-selftest-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(liveEvidence));
    const goodRun = spawnSync(process.execPath, [scriptPath, '--repo', REPO, '--project-context-id', PROJECT_CONTEXT_ID, '--evidence-file', good], { encoding: 'utf8' });
    assert.equal(goodRun.status, 0);
    assert(goodRun.stdout.includes('IMPROVEMENT_FOLLOWUP=HAS_FOLLOWUP') || goodRun.stderr.includes('IMPROVEMENT_FOLLOWUP=HAS_FOLLOWUP'));

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ schemaVersion: 1 }));
    const badRun = spawnSync(process.execPath, [scriptPath, '--repo', REPO, '--project-context-id', PROJECT_CONTEXT_ID, '--evidence-file', bad], { encoding: 'utf8' });
    assert.equal(badRun.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase 2 (Issue #280) dispatch classification regression tests: given a
// HUMAN-approved active task snapshot and a live Project Root/owner
// snapshot, every synthetic candidate below is classified as
// IN_SCOPE / CROSS_PROJECT / NEW_SCOPE / UNKNOWN without ever mutating the
// active task, current branch, or current repository files. All fixtures
// are synthetic source/app-repository metadata; none involve patient,
// clinic, or billing records.

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function activeTask(overrides = {}) {
  return {
    projectContextId: PROJECT_CONTEXT_ID,
    repository: 'acme/app-b',
    issueNumber: 500,
    branch: 'feature-500',
    worktree: '/work/app-b-500',
    headSha: SHA_A,
    jobId: 'job-b-1',
    capturedAt: new Date(NOW - 60 * 1000).toISOString(),
    ...overrides,
  };
}

function projectSnapshot(overrides = {}) {
  return {
    projectContextId: PROJECT_CONTEXT_ID,
    projectRootRepository: 'acme/app-b',
    owner: 'acme',
    ownedRepositories: ['acme/app-a', 'acme/app-b', 'acme/ai-dev-foundation'],
    capturedAt: new Date(NOW - 60 * 1000).toISOString(),
    ...overrides,
  };
}

function dispatchCandidate(overrides = {}) {
  return {
    id: 'finding-1',
    subjectOwner: 'acme',
    subjectRepository: 'acme/app-b',
    relatedIssueNumber: 500,
    title: 'Null check missing in parser',
    kind: 'technical_bugfix',
    protectedData: false,
    capturedAt: new Date(NOW - 60 * 1000).toISOString(),
    causeVerified: true,
    causeDescription: 'Stack trace shows parser.js:42 dereferences undefined without a guard.',
    desiredOutcome: 'Parser should return a safe default instead of throwing.',
    allowedPaths: ['src/parser.js'],
    forbiddenPaths: ['src/billing'],
    reproductionCommand: 'node tools/repro.js --case parser-null',
    testCommand: 'npm test -- parser.spec.js',
    dedupKey: 'parser-null-guard-1',
    runnerEvidence: null,
    ...overrides,
  };
}

function existingIssueEntry(overrides = {}) {
  return {
    number: 42,
    repository: 'acme/app-a',
    dedupKey: 'parser-null-guard-1',
    branch: null,
    worktree: null,
    headSha: null,
    ...overrides,
  };
}

function existingIssuesBatch(entries = [], overrides = {}) {
  return {
    fetchedAt: new Date(NOW - 60 * 1000).toISOString(),
    retrievalComplete: true,
    entries,
    ...overrides,
  };
}

function dispatch(candidates, { task = activeTask(), snapshot = projectSnapshot(), existing = existingIssuesBatch() } = {}) {
  return buildDispatchReport({
    candidates, activeTask: task, projectSnapshot: snapshot, existingIssues: existing,
    nowMs: NOW, generatedAt: new Date(NOW).toISOString(),
  });
}

// D1. A app finding in B: the active task is in app-b; the finding is about
// app-a (a different, recognized/owned repository) -> CROSS_PROJECT, and a
// fresh dedup key with no existing Issue plans a brand-new Issue.
{
  const candidate = dispatchCandidate({ id: 'cross-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null });
  const report = dispatch([candidate]);
  assert.equal(report.ok, true);
  assert.equal(report.items[0].classification, 'CROSS_PROJECT');
  assert.equal(report.items[0].dispatchStatus, 'PLAN_READY');
  assert.equal(report.items[0].dispatch.action, 'NEW_ISSUE');
  assert.equal(report.items[0].dispatch.targetRepository, 'acme/app-a');
  assert.equal(report.items[0].dispatch.existingIssueNumber, null);
}

// D2. A task unchanged: the active task snapshot is echoed back verbatim and
// the caller's input object is never mutated by classification.
{
  const task = activeTask();
  const taskBefore = JSON.stringify(task);
  const candidate = dispatchCandidate({ id: 'cross-2', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'other-key' });
  const report = dispatch([candidate], { task });
  assert.equal(JSON.stringify(task), taskBefore);
  assert.deepEqual(report.activeTaskSnapshot, task);
}

// D3. Foundation issue found in app: the active task is in app-a; the
// finding is about the Foundation repository itself (a different,
// recognized repository under the same owner) -> CROSS_PROJECT.
{
  const task = activeTask({ repository: 'acme/app-a', issueNumber: 10, branch: 'feature-10', worktree: '/work/app-a-10', jobId: 'job-a-1' });
  const candidate = dispatchCandidate({ id: 'cross-3', subjectRepository: 'acme/ai-dev-foundation', relatedIssueNumber: null, dedupKey: 'foundation-key-1' });
  const report = dispatch([candidate], { task });
  assert.equal(report.items[0].classification, 'CROSS_PROJECT');
  assert.equal(report.items[0].dispatch.targetRepository, 'acme/ai-dev-foundation');
}

// D4. Same-repo NEW_SCOPE: the finding is in the active task's own
// repository but about a different Issue/feature -> proposal only; no
// dispatch plan, no source change.
{
  const candidate = dispatchCandidate({ id: 'new-scope-1', subjectRepository: 'acme/app-b', relatedIssueNumber: 999 });
  const report = dispatch([candidate]);
  assert.equal(report.items[0].classification, 'NEW_SCOPE');
  assert.equal(report.items[0].dispatchStatus, 'NOT_STARTED');
  assert.equal(report.items[0].dispatch, null);
  assert.deepEqual(report.items[0].proposal, { recorded: false, planned: true, note: 'NEW_SCOPE_NO_SOURCE_CHANGE' });
}

// D5. Unknown owner/project: a repository that is neither the Project Root
// nor in ownedRepositories blocks only that one candidate.
{
  const candidate = dispatchCandidate({ id: 'unknown-1', subjectOwner: 'someone-else', subjectRepository: 'someone-else/other-app' });
  const report = dispatch([candidate]);
  assert.equal(report.items[0].classification, 'UNKNOWN');
  assert.equal(report.items[0].code, 'OWNER_OR_PROJECT_UNRECOGNIZED');
  assert.equal(report.items[0].dispatch, null);
}

// D6. Stale dispatch evidence: a capturedAt far older than the freshness
// window blocks only that one candidate, never the whole batch.
{
  const stale = dispatchCandidate({ id: 'stale-1', capturedAt: new Date(NOW - 60 * 60 * 1000).toISOString() });
  const fresh = dispatchCandidate({ id: 'fresh-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'fresh-key-1' });
  const report = dispatch([stale, fresh]);
  assert.equal(report.ok, true);
  assert.equal(report.items.find((i) => i.id === 'stale-1').classification, 'UNKNOWN');
  assert.equal(report.items.find((i) => i.id === 'stale-1').code, 'DISPATCH_EVIDENCE_STALE');
  assert.equal(report.items.find((i) => i.id === 'fresh-1').classification, 'CROSS_PROJECT');
}

// D7. Protected data: blocked without ever echoing candidate content.
{
  const candidate = dispatchCandidate({ id: 'protected-1', protectedData: true });
  const report = dispatch([candidate]);
  assert.equal(report.items[0].classification, 'UNKNOWN');
  assert.equal(report.items[0].code, 'PROTECTED_DATA_EXCLUDED');
  assert.equal(JSON.stringify(report.items[0]).includes('causeDescription'), false);
}

// D8. Existing-issue dedup: a matching existing Issue by (repository,
// dedupKey) appends instead of creating a new Issue.
{
  const existing = existingIssuesBatch([existingIssueEntry()]);
  const candidate = dispatchCandidate({ id: 'dedup-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'parser-null-guard-1' });
  const report = dispatch([candidate], { existing });
  assert.equal(report.items[0].dispatch.action, 'APPEND_EXISTING');
  assert.equal(report.items[0].dispatch.existingIssueNumber, 42);
}

// D9. Missing issue: no existing record with a matching dedup key plans a
// brand-new Issue instead.
{
  const existing = existingIssuesBatch([existingIssueEntry({ dedupKey: 'unrelated-key' })]);
  const candidate = dispatchCandidate({ id: 'new-issue-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'parser-null-guard-1' });
  const report = dispatch([candidate], { existing });
  assert.equal(report.items[0].dispatch.action, 'NEW_ISSUE');
  assert.equal(report.items[0].dispatch.existingIssueNumber, null);
}

// D10. No runner / delayed poller: without real runner evidence, the
// executor receipt stays NOT_STARTED -- never POSTED/RUNNING/DONE.
{
  const candidate = dispatchCandidate({ id: 'no-runner-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'no-runner-key', runnerEvidence: null });
  const report = dispatch([candidate]);
  assert.equal(report.items[0].dispatch.instruction.executorReceipt.runnerStatus, 'NOT_STARTED');
  assert.equal(report.items[0].dispatch.instruction.executorReceipt.source, null);
}

// D11. Receipt-aware runner status: real caller-supplied runner evidence is
// passed through verbatim, honestly reflecting already-existing reality
// instead of being fabricated from the plan.
{
  const candidate = dispatchCandidate({
    id: 'receipt-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'receipt-key',
    runnerEvidence: { present: true, source: 'ai-job', state: 'IMPLEMENTING' },
  });
  const report = dispatch([candidate]);
  assert.equal(report.items[0].dispatch.instruction.executorReceipt.runnerStatus, 'UNKNOWN');
  assert.equal(report.items[0].dispatch.instruction.executorReceipt.source, null);
  assert.equal(report.items[0].dispatch.instruction.executorReceipt.claimedRunnerStatus, 'IMPLEMENTING');
  assert.equal(report.items[0].dispatch.instruction.executorReceipt.evidenceVerified, false);
  // The batch-level decision is never upgraded by this module to a posting/
  // execution status; it stays bounded to PLAN_READY/NOT_STARTED/UNKNOWN.
  assert.equal(report.decision, 'PLAN_READY');
}

// D12. A/B parallel jobs: two independently dispatched batches for two
// different active tasks never mix identity; each call only ever reflects
// its own job/branch/worktree/head.
{
  const taskA = activeTask({ repository: 'acme/app-b', issueNumber: 500, branch: 'feature-500', worktree: '/work/app-b-500', headSha: SHA_A, jobId: 'job-b-1' });
  const taskB = activeTask({ repository: 'acme/app-a', issueNumber: 700, branch: 'feature-700', worktree: '/work/app-a-700', headSha: SHA_B, jobId: 'job-a-7' });
  const candidateForA = dispatchCandidate({ id: 'parallel-a', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'parallel-key-a' });
  const candidateForB = dispatchCandidate({ id: 'parallel-b', subjectRepository: 'acme/app-b', relatedIssueNumber: null, dedupKey: 'parallel-key-b' });
  const reportA = dispatch([candidateForA], { task: taskA });
  const reportB = dispatch([candidateForB], { task: taskB });
  assert.equal(reportA.activeTaskSnapshot.jobId, 'job-b-1');
  assert.equal(reportB.activeTaskSnapshot.jobId, 'job-a-7');
  assert.notEqual(reportA.activeTaskSnapshot.jobId, reportB.activeTaskSnapshot.jobId);
  assert.equal(reportA.items[0].dispatch.targetRepository, 'acme/app-a');
  assert.equal(reportB.items[0].dispatch.targetRepository, 'acme/app-b');
}

// D13. Conflicting same-issue worktrees: two existing-Issue records sharing
// the same (repository, dedupKey) but different branch/worktree/head
// identity are an unresolved conflict; fail closed for only that candidate.
{
  const existing = existingIssuesBatch([
    existingIssueEntry({ number: 42, branch: 'worker-a', worktree: '/work/one', headSha: SHA_A }),
    existingIssueEntry({ number: 43, branch: 'worker-b', worktree: '/work/two', headSha: SHA_B }),
  ]);
  const candidate = dispatchCandidate({ id: 'conflict-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'parser-null-guard-1' });
  const report = dispatch([candidate], { existing });
  assert.equal(report.items[0].dispatchStatus, 'UNKNOWN');
  assert.equal(report.items[0].code, 'EXISTING_ISSUE_DEDUP_CONFLICT');
  assert.equal(report.items[0].dispatch, null);
}

// IN_SCOPE technical-bugfix candidates (directly about the active task's own
// Issue) are also eligible for a dispatch plan, not only CROSS_PROJECT ones.
{
  const candidate = dispatchCandidate({ id: 'in-scope-bugfix', subjectRepository: 'acme/app-b', relatedIssueNumber: 500, dedupKey: 'in-scope-key' });
  const report = dispatch([candidate]);
  assert.equal(report.items[0].classification, 'IN_SCOPE');
  assert.equal(report.items[0].dispatchStatus, 'PLAN_READY');
  assert.equal(report.items[0].dispatch.targetRepository, 'acme/app-b');
}

// IN_SCOPE non-bugfix candidates (for example a feature idea) are not
// eligible for a dispatch plan; the safe main task continues unchanged.
{
  const candidate = dispatchCandidate({ id: 'in-scope-feature', subjectRepository: 'acme/app-b', relatedIssueNumber: 500, kind: 'feature' });
  const report = dispatch([candidate]);
  assert.equal(report.items[0].classification, 'IN_SCOPE');
  assert.equal(report.items[0].dispatchStatus, 'NOT_STARTED');
  assert.equal(report.items[0].dispatch, null);
}

// Batch-level fail-closed checks for the dispatch snapshot/evidence shapes.
assert.equal(dispatch([dispatchCandidate()], { task: { ...activeTask(), extra: true } }).code, 'ACTIVE_TASK_SHAPE_INVALID');
assert.equal(dispatch([dispatchCandidate()], { snapshot: projectSnapshot({ capturedAt: new Date(NOW - 60 * 60 * 1000).toISOString() }) }).code, 'PROJECT_SNAPSHOT_STALE');
assert.equal(dispatch([dispatchCandidate()], { existing: existingIssuesBatch([], { retrievalComplete: false }) }).code, 'EXISTING_ISSUES_RETRIEVAL_INCOMPLETE');
assert.equal(dispatch([dispatchCandidate({ id: 'dup' }), dispatchCandidate({ id: 'dup' })]).code, 'DISPATCH_CANDIDATE_DUPLICATE');

// CLI smoke test: dispatch mode happy path and malformed-evidence fail-closed
// exit code. The CLI subprocess uses the real wall-clock Date.now(), so this
// fixture uses clock-relative timestamps rather than fixed calendar dates.
{
  const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
  const liveTask = activeTask({ capturedAt: isoAgo(60 * 1000) });
  const liveSnapshot = projectSnapshot({ capturedAt: isoAgo(60 * 1000) });
  const liveCandidate = dispatchCandidate({
    id: 'cli-1', subjectRepository: 'acme/app-a', relatedIssueNumber: null, dedupKey: 'cli-key', capturedAt: isoAgo(60 * 1000),
  });
  const liveExisting = existingIssuesBatch([], { fetchedAt: isoAgo(60 * 1000) });
  const dispatchDir = mkdtempSync(join(tmpdir(), 'improvement-followup-dispatch-selftest-'));
  try {
    const good = join(dispatchDir, 'dispatch-good.json');
    writeFileSync(good, JSON.stringify({ activeTask: liveTask, projectSnapshot: liveSnapshot, existingIssues: liveExisting, candidates: [liveCandidate] }));
    const goodRun = spawnSync(process.execPath, [scriptPath, '--mode', 'dispatch', '--dispatch-file', good], { encoding: 'utf8' });
    assert.equal(goodRun.status, 0);
    assert(goodRun.stdout.includes('IMPROVEMENT_FOLLOWUP_DISPATCH=PLAN_READY') || goodRun.stderr.includes('IMPROVEMENT_FOLLOWUP_DISPATCH=PLAN_READY'));

    const bad = join(dispatchDir, 'dispatch-bad.json');
    writeFileSync(bad, JSON.stringify({ activeTask: liveTask }));
    const badRun = spawnSync(process.execPath, [scriptPath, '--mode', 'dispatch', '--dispatch-file', bad], { encoding: 'utf8' });
    assert.equal(badRun.status, 2);
  } finally {
    rmSync(dispatchDir, { recursive: true, force: true });
  }
}

// Independent negative audit regressions: source-only, synthetic metadata.
{
  const task = activeTask({ branch: 'job/20261011-002-issue280phase2' });
  assert.equal(dispatch([dispatchCandidate()], { task }).ok, true);
  assert.equal(dispatch([dispatchCandidate()], { task: activeTask({ branch: '../unsafe' }) }).code, 'ACTIVE_TASK_BRANCH_INVALID');
}
{
  const mismatch = dispatch([dispatchCandidate()], { snapshot: projectSnapshot({ projectContextId: 'other-project' }) });
  assert.equal(mismatch.code, 'DISPATCH_PROJECT_CONTEXT_MISMATCH');
  const alien = dispatch([dispatchCandidate()], { task: activeTask({ repository: 'other/private-repo' }) });
  assert.equal(alien.code, 'DISPATCH_ACTIVE_REPOSITORY_OUT_OF_SCOPE');
}
{
  const feature = dispatchCandidate({ subjectRepository: 'acme/app-a', relatedIssueNumber: null, kind: 'feature' });
  const result = dispatch([feature]).items[0];
  assert.equal(result.classification, 'CROSS_PROJECT');
  assert.equal(result.dispatchStatus, 'NOT_STARTED');
  assert.equal(result.dispatch, null);
  assert.equal(result.proposal.recorded, false);
}
{
  const other = dispatchCandidate({ subjectRepository: 'acme/app-b', relatedIssueNumber: 999 });
  const result = dispatch([other]).items[0];
  assert.equal(result.classification, 'NEW_SCOPE');
  assert.equal(result.proposal.recorded, false);
  assert.equal(result.proposal.planned, true);
}
{
  const forged = dispatchCandidate({ subjectRepository: 'acme/app-a', relatedIssueNumber: null, runnerEvidence: { present: true, source: 'ai-job', state: 'DONE' } });
  const r = dispatch([forged]).items[0].dispatch.instruction.executorReceipt;
  assert.equal(r.runnerStatus, 'UNKNOWN');
  assert.equal(r.evidenceVerified, false);
  assert.equal(r.claimedRunnerStatus, 'DONE');
}
await import('./improvement-followup-synthetic-selftest.mjs');
console.log('improvement-followup selftest: PASS');
