#!/usr/bin/env node
// Self-test: proves verifyQualifiedCommitReceipt STOPs on malformed/mismatched
// inputs using only synthetic example.invalid data. No real git repo needed.
//
// Also proves triageHistoricalCommitEvidence: (a) correctly STOPs on every
// malformed/mismatched/absent input just like verifyQualifiedCommitReceipt,
// using a REAL temporary git repository with real commits; (b) returns the
// explicit DIAGNOSTIC-ONLY positive result (originalWriterProven:false,
// currentMergeAuthorized:false) for a genuinely content-consistent historic
// commit even when its bound research evidence is now stale against the
// real current clock; and (c) never causes verifyQualifiedCommitReceipt
// itself to accept that same stale receipt as MERGE_READY -- the existing
// current-time research-staleness STOP is completely unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyQualifiedCommitReceipt, triageHistoricalCommitEvidence } from './qualified-commit-receipt-audit.mjs';
import { computeChangeSetSha256 } from './implementation-runner.mjs';
import { computeConstraintsDigest, TRIGGER_KEYS, MINIMAL_BYPASS_CHECKLIST_IDS } from './research-gate.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const NONEXISTENT_REPO_ROOT = 'C:/nonexistent-example-invalid-repo-xyz';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseArgs() {
  return {
    repoRoot: NONEXISTENT_REPO_ROOT,
    repository: { owner: 'example-invalid-owner', name: 'example-invalid-repo' },
    commit: SHA_A,
    receipt: {
      result: 'PASS',
      executor: { routeType: 'qualified-agent' },
      repository: { owner: 'example-invalid-owner', name: 'example-invalid-repo' },
      implementationHead: SHA_A,
      executionEvidence: { preHead: SHA_B, changedPaths: [] },
    },
  };
}

let cases = 0;
function expectStop(label, args, expectedCode) {
  cases += 1;
  const result = verifyQualifiedCommitReceipt(args);
  assert.equal(result.result, 'STOP', `${label}: expected STOP result`);
  assert.equal(result.code, expectedCode, `${label}: expected code ${expectedCode}`);
}

// 1. missing receipt
{
  const args = baseArgs();
  args.receipt = undefined;
  expectStop('missing receipt', args, 'RECEIPT_NOT_PASS');
}

// 2. direct route (not qualified-agent)
{
  const args = baseArgs();
  args.receipt.executor.routeType = 'direct';
  expectStop('direct route', args, 'RECEIPT_ROUTE_TYPE_NOT_QUALIFIED_AGENT');
}

// 3. invalid SHA
{
  const args = baseArgs();
  args.commit = 'not-a-valid-sha';
  expectStop('invalid SHA', args, 'COMMIT_SHA_INVALID');
}

// 4. repository mismatch
{
  const args = baseArgs();
  args.receipt.repository.name = 'different-example-invalid-repo';
  expectStop('repository mismatch', args, 'RECEIPT_REPOSITORY_MISMATCH');
}

// 5. wrong implementationHead
{
  const args = baseArgs();
  args.receipt.implementationHead = SHA_C;
  expectStop('wrong implementationHead', args, 'IMPLEMENTATION_HEAD_MISMATCH');
}

// 6. invalid preHead
{
  const args = baseArgs();
  args.receipt.executionEvidence.preHead = 'not-a-valid-sha';
  expectStop('invalid preHead', args, 'EXECUTION_EVIDENCE_PRE_HEAD_INVALID');
}

// 7. absent repoRoot
{
  const args = baseArgs();
  args.repoRoot = undefined;
  expectStop('absent repoRoot', args, 'REPO_ROOT_INVALID');
}

// 8. missing commit in nonexistent repo (otherwise valid-shaped receipt)
expectStop('missing commit in nonexistent repo', clone(baseArgs()), 'COMMIT_NOT_FOUND');

// --- triageHistoricalCommitEvidence: real, entirely SYNTHETIC temporary Git
// repository, synthetic owner/name/origin, a real feature branch (never
// main/master), two real commits, and a content-consistent historical
// finalReceipt + matching COMPLETED runnerResult whose bound research
// evidence is already stale (assessedAtUtcMs 72h old, maxEvidenceAgeMs 24h).
// No patient/finance data is ever used; the only filesystem writes are
// inside a freshly created, owned temp directory, removed in `finally`.
function gitSetup(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`synthetic selftest repo setup failed: git ${args.join(' ')} -> ${result.error || result.stderr}`);
  }
  return result.stdout;
}

function buildSyntheticHistoricalRepo() {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qcra-selftest-repo-')));
  const owner = 'example-synthetic-owner';
  const name = 'example-synthetic-repo';
  const branch = 'feature/historical-evidence-synthetic';
  const filePath = path.join(repoRoot, 'synthetic-note.md');

  gitSetup(repoRoot, ['init']);
  gitSetup(repoRoot, ['checkout', '-b', branch]);
  gitSetup(repoRoot, ['config', 'user.email', 'synthetic-selftest@example.invalid']);
  gitSetup(repoRoot, ['config', 'user.name', 'Synthetic Selftest']);
  gitSetup(repoRoot, ['config', 'commit.gpgsign', 'false']);
  gitSetup(repoRoot, ['remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`]);

  fs.writeFileSync(filePath, 'synthetic historical evidence note: initial\n', 'utf8');
  gitSetup(repoRoot, ['add', '--all']);
  gitSetup(repoRoot, ['commit', '-m', 'synthetic initial commit']);
  const parentSha = gitSetup(repoRoot, ['rev-parse', 'HEAD']).trim().toLowerCase();

  fs.writeFileSync(filePath, 'synthetic historical evidence note: initial\nupdated synthetic content\n', 'utf8');
  gitSetup(repoRoot, ['add', '--all']);
  gitSetup(repoRoot, ['commit', '-m', 'synthetic second commit']);
  const headSha = gitSetup(repoRoot, ['rev-parse', 'HEAD']).trim().toLowerCase();

  return { repoRoot, owner, name, branch, parentSha, headSha };
}

let historicalCases = 0;
function expectHistoricalStop(label, triageArgs) {
  historicalCases += 1;
  let result;
  try {
    result = triageHistoricalCommitEvidence(triageArgs);
  } catch (error) {
    assert.fail(`${label}: triageHistoricalCommitEvidence must never throw, threw: ${error && error.message}`);
    return;
  }
  assert.equal(result.result, 'STOP', `${label}: expected STOP result`);
  assert.equal(result.originalWriterProven, false, `${label}: originalWriterProven must be false`);
  assert.equal(result.currentMergeAuthorized, false, `${label}: currentMergeAuthorized must be false`);
}

{
  const repo = buildSyntheticHistoricalRepo();
  try {
    const taskId = 'historical-task-001';
    const proposalId = 'historical-proposal-001';
    const constraints = ['No destructive git operations.', 'Synthetic data only.'];
    const allowedScope = ['synthetic-note.md'];

    const changeSet = computeChangeSetSha256(repo.repoRoot, repo.parentSha, repo.headSha);
    assert.ok(changeSet, 'synthetic repo setup: committed change set must be computable');

    const nowUtcMs = Date.now();
    const evidenceBinding = {
      taskId,
      proposalId,
      repository: { owner: repo.owner, name: repo.name },
      scope: [...allowedScope],
      constraints: [...constraints],
      constraintsDigestSha256: computeConstraintsDigest(constraints),
      assessedAtUtcMs: nowUtcMs - (72 * 60 * 60 * 1000),
      maxEvidenceAgeMs: 24 * 60 * 60 * 1000,
    };
    const researchEvidence = {
      schemaVersion: 1,
      evidenceBinding,
      triggers: Object.fromEntries(TRIGGER_KEYS.map((key) => [key, false])),
      noTriggerAssessment: {
        reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL',
        justification: 'Synthetic local-only edit with no external risk signal.',
      },
      checklist: MINIMAL_BYPASS_CHECKLIST_IDS.map((id) => ({
        id,
        status: 'PASS',
        applicable: true,
        justification: `${id} evaluated for synthetic historical evidence selftest.`,
        primarySourceRef: `synthetic-source-${id}`,
      })),
    };
    const research = {
      evidence: researchEvidence,
      context: { proposalId, constraints: [...constraints], humanTopConditions: [] },
    };

    const finalReceipt = {
      schemaVersion: 1,
      result: 'PASS',
      taskId,
      taskKind: 'implementation',
      executor: { id: 'synthetic-executor', provider: 'synthetic-provider', routeType: 'qualified-agent' },
      repository: { owner: repo.owner, name: repo.name },
      branch: repo.branch,
      allowedScope: [...allowedScope],
      implementationHead: repo.headSha,
      executionEvidence: {
        preHead: repo.parentSha, changeSetSha256: changeSet.changeSetSha256, changedPaths: [...changeSet.changedPaths],
      },
      research,
    };
    const runnerResult = {
      schemaVersion: 1,
      result: 'COMPLETED',
      routeId: 'claude-implementation-write',
      taskId,
      branch: repo.branch,
      executionEvidence: {
        preHead: repo.parentSha, changeSetSha256: changeSet.changeSetSha256, changedPaths: [...changeSet.changedPaths],
      },
    };

    function baseTriageArgs() {
      return {
        repoRoot: repo.repoRoot,
        repository: { owner: repo.owner, name: repo.name },
        commit: repo.headSha,
        finalReceipt: clone(finalReceipt),
        runnerResult: clone(runnerResult),
      };
    }

    // The genuine content-consistent historical case: STOP is never issued,
    // and the result is explicitly diagnostic-only, never MERGE_READY.
    {
      historicalCases += 1;
      const result = triageHistoricalCommitEvidence(baseTriageArgs());
      assert.equal(result.result, 'HISTORICAL_COMMIT_CONTENT_CONSISTENT_NOT_CURRENT_AUTHORIZATION');
      assert.equal(result.code, 'HISTORICAL_COMMIT_CONTENT_CONSISTENT_NOT_CURRENT_AUTHORIZATION');
      assert.equal(result.originalWriterProven, false);
      assert.equal(result.currentMergeAuthorized, false);
      assert.notEqual(result.result, 'MERGE_READY');
    }

    // 1. finalReceipt.branch foreign (not the actually checked-out branch)
    {
      const args = baseTriageArgs();
      args.finalReceipt.branch = 'feature/foreign-branch-not-checked-out';
      expectHistoricalStop('historical: finalReceipt.branch foreign', args);
    }

    // 2. research.evidenceBinding.repository wrong
    {
      const args = baseTriageArgs();
      args.finalReceipt.research.evidence.evidenceBinding.repository = { owner: 'foreign-owner-example', name: 'foreign-repo-example' };
      expectHistoricalStop('historical: evidenceBinding.repository wrong', args);
    }

    // 3. taskId wrong (research.evidenceBinding.taskId)
    {
      const args = baseTriageArgs();
      args.finalReceipt.research.evidence.evidenceBinding.taskId = 'foreign-task-999';
      expectHistoricalStop('historical: evidenceBinding.taskId wrong', args);
    }

    // 4. scope wrong (research.evidenceBinding.scope)
    {
      const args = baseTriageArgs();
      args.finalReceipt.research.evidence.evidenceBinding.scope = ['unexpected-foreign-scope.md'];
      expectHistoricalStop('historical: evidenceBinding.scope wrong', args);
    }

    // 5. proposal wrong (research.evidenceBinding.proposalId)
    {
      const args = baseTriageArgs();
      args.finalReceipt.research.evidence.evidenceBinding.proposalId = 'foreign-proposal-999';
      expectHistoricalStop('historical: evidenceBinding.proposalId wrong', args);
    }

    // 6. constraints wrong (research.evidenceBinding.constraints)
    {
      const args = baseTriageArgs();
      args.finalReceipt.research.evidence.evidenceBinding.constraints = [...constraints, 'An extra unexpected constraint.'];
      expectHistoricalStop('historical: evidenceBinding.constraints wrong', args);
    }

    // 7. runner missing
    {
      const args = baseTriageArgs();
      args.runnerResult = undefined;
      expectHistoricalStop('historical: runner missing', args);
    }

    // 8. runner STOP (not COMPLETED)
    {
      const args = baseTriageArgs();
      args.runnerResult.result = 'STOP';
      expectHistoricalStop('historical: runner STOP', args);
    }

    // 9. runner digest forged
    {
      const args = baseTriageArgs();
      args.runnerResult.executionEvidence.changeSetSha256 = 'f'.repeat(64);
      expectHistoricalStop('historical: runner digest forged', args);
    }

    // 10. HEAD wrong (caller-supplied commit does not match finalReceipt.implementationHead)
    {
      const args = baseTriageArgs();
      args.commit = repo.parentSha;
      expectHistoricalStop('historical: HEAD wrong', args);
    }

    // 11. parent wrong (claimed preHead forged consistently in both receipt and
    // runner result, so it is internally self-consistent but does not match
    // the actual Git parent of the real committed change set)
    {
      const args = baseTriageArgs();
      const forgedPreHead = 'd'.repeat(40);
      args.finalReceipt.executionEvidence.preHead = forgedPreHead;
      args.runnerResult.executionEvidence.preHead = forgedPreHead;
      expectHistoricalStop('historical: parent wrong', args);
    }

    // 12. owner wrong (caller-supplied repository param foreign to the
    // receipt's own, otherwise-correct repository claim)
    {
      const args = baseTriageArgs();
      args.repository = { owner: 'foreign-owner-param-example', name: repo.name };
      expectHistoricalStop('historical: owner wrong', args);
    }
  } finally {
    // Cleanup ONLY the owned, freshly created temp repository.
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
  }
}

console.log(`PASS qualified-commit-receipt-audit-selftest (${cases} legacy cases, ${historicalCases} historical-evidence cases)`);
