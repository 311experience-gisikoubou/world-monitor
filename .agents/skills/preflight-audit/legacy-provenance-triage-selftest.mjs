// Pure, fail-closed self-test for diagnoseLegacyProvenance. Tests 1-6 below
// exercise only the shape/format checks that run before any git repository
// is touched, so no Git repository is created or inspected for those. Test 7
// adds one positive synthetic fixture: a real, test-owned temp Git
// repository with a fake (never-fetched) origin, used to prove the full
// read-only diagnosis path returns REPLAY_EQUIVALENT_NOT_ORIGINAL_AUTHORSHIP
// (never MERGE_READY) for a genuinely tree-identical replay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnoseLegacyProvenance } from './legacy-provenance-triage.mjs';
import { computeChangeSetSha256, readHeadSha } from './implementation-runner.mjs';
import { evaluateReceipt, verifyFinalReceipt } from './implementation-route-receipt.mjs';
import { computeConstraintsDigest } from './research-gate.mjs';

const VALID_HEAD = 'a'.repeat(40);
const OTHER_VALID_HEAD = 'b'.repeat(40);

function qualifiedAgentReceipt() {
  return {
    executor: { routeType: 'qualified-agent' },
    executionEvidence: {
      preHead: VALID_HEAD,
      changeSetSha256: 'c'.repeat(64),
      changedPaths: ['src/example.ts'],
    },
  };
}

function expectStop(result, code) {
  assert.equal(result.result, 'STOP');
  assert.equal(result.code, code);
  assert.equal(result.originalWriterProven, false);
}

// 1. Missing replay (no replayHead, no receipt).
expectStop(diagnoseLegacyProvenance({}), 'NEEDS_VERIFIABLE_REPLAY');

// 2. Direct-browser route is never an acceptable basis for a replay claim.
expectStop(diagnoseLegacyProvenance({
  replayHead: VALID_HEAD,
  receipt: { executor: { routeType: 'direct-browser' } },
}), 'EXECUTOR_ROUTE_TYPE_INVALID');

// 3. Missing executionEvidence on an otherwise-qualified receipt.
expectStop(diagnoseLegacyProvenance({
  replayHead: VALID_HEAD,
  receipt: { executor: { routeType: 'qualified-agent' } },
}), 'EXECUTION_EVIDENCE_INVALID');

// 4. Bad originalHead with a valid qualified-agent receipt.
expectStop(diagnoseLegacyProvenance({
  originalHead: 'not-a-sha',
  replayHead: VALID_HEAD,
  receipt: qualifiedAgentReceipt(),
}), 'ORIGINAL_HEAD_INVALID');

// 5. Bad replayHead with a valid qualified-agent receipt.
expectStop(diagnoseLegacyProvenance({
  originalHead: VALID_HEAD,
  replayHead: 'not-a-sha',
  receipt: qualifiedAgentReceipt(),
}), 'REPLAY_HEAD_INVALID');

// 6. Same valid 40-character head for original and replay proves nothing.
expectStop(diagnoseLegacyProvenance({
  originalHead: OTHER_VALID_HEAD,
  replayHead: OTHER_VALID_HEAD,
  receipt: qualifiedAgentReceipt(),
}), 'REPLAY_SAME_HEAD');

// 7. Positive synthetic fixture: a real, test-owned temp Git repository
// proves the full read-only diagnosis path (repository/branch identity,
// commit existence, related history, clean worktree, whole-tree equality,
// and final-receipt verification) all genuinely succeed for a tree-
// identical replay, and that the result is STILL only
// REPLAY_EQUIVALENT_NOT_ORIGINAL_AUTHORSHIP with originalWriterProven
// false -- never MERGE_READY, even though every sub-check actually passed.
//
// SYNTHETIC MOCK ONLY: nothing here invokes Claude or any other AI
// provider. The "final receipt" below is a locally-constructed, in-memory
// mock object run only through the existing evaluateReceipt/
// verifyFinalReceipt pure functions; it is not evidence of any real
// qualified-agent execution, and diagnoseLegacyProvenance's own output
// correctly refuses to treat it as proof of original authorship.
const FIXTURE_TASK_ID = 'legacy-provenance-fixture-task';
const FIXTURE_REPOSITORY = { owner: 'acme', name: 'fixture' };
const FIXTURE_BRANCH = 'feat/synthetic';
const FIXTURE_SCOPE = ['safe.txt'];

const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-provenance-triage-selftest-'));
try {
  function git(args) {
    const result = spawnSync('git', ['-C', tempRepoRoot, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  }
  function writeSafeFile(content) {
    fs.writeFileSync(path.join(tempRepoRoot, 'safe.txt'), content, 'utf8');
  }
  function commit(content, message) {
    writeSafeFile(content);
    git(['add', '.']);
    git(['commit', '-q', '-m', message]);
    const head = readHeadSha(tempRepoRoot);
    assert.ok(head, `expected a resolvable HEAD after commit: ${message}`);
    return head;
  }

  // Local-only test identity and a fake, never-fetched GitHub-shaped origin:
  // 'git remote get-url origin' only ever reads this local config value, so
  // no network access occurs anywhere in this fixture.
  git(['init', '-q', '-b', FIXTURE_BRANCH]);
  git(['config', 'user.email', 'legacy-provenance-fixture@example.invalid']);
  git(['config', 'user.name', 'Legacy Provenance Fixture']);
  git(['remote', 'add', 'origin', 'https://github.com/acme/fixture.git']);

  const originalHead = commit('A', 'original: safe.txt = A');
  const intermediateHead = commit('B', 'intermediate: safe.txt = B');
  const replayHead = commit('A', 'replay: safe.txt = A (reverts to original content)');

  // Prove the fixture actually is tree-identical between original and
  // replay (never merely assumed) before diagnoseLegacyProvenance is asked
  // to independently re-derive the same fact.
  const originalTree = git(['rev-parse', `${originalHead}^{tree}`]).trim();
  const replayTree = git(['rev-parse', `${replayHead}^{tree}`]).trim();
  assert.equal(originalTree, replayTree, 'fixture original/replay whole-tree hashes must be equal');

  // The exact committed change set between the intermediate and replay
  // commits, computed with the real implementation-runner.mjs export --
  // never hand-constructed -- so the mock receipt below carries genuine,
  // independently-recomputable execution evidence.
  const changeSet = computeChangeSetSha256(tempRepoRoot, intermediateHead, replayHead);
  assert.ok(changeSet, 'expected a computable change-set hash between intermediate and replay');

  function fixtureInstructionClarity() {
    return {
      schemaVersion: 1,
      taskId: FIXTURE_TASK_ID,
      instructions: [{ id: 'human-1', kind: 'INSTRUCTION', summary: 'Synthetic fixture: revert safe.txt back to its original content.' }],
      unlistedAssumptionsPresent: false,
      ambiguities: [],
    };
  }

  // A minimal, fresh, honest research envelope bound to this exact
  // taskId/repository/scope -- the same convention
  // implementation-route-receipt-selftest.mjs uses -- with its
  // constraintsDigestSha256 computed via the real computeConstraintsDigest
  // export (never hand-typed), so the binding is genuinely recomputable.
  function fixtureResearch() {
    const constraints = [];
    const checklist = ['safety', 'dataPreservation', 'existingOverlap'].map((id) => ({
      id, status: 'PASS', applicable: true,
      justification: `${id} looks fine for this synthetic fixture edit.`,
      primarySourceRef: 'https://example.invalid/legacy-provenance-fixture',
    }));
    return {
      evidence: {
        schemaVersion: 1,
        evidenceBinding: {
          taskId: FIXTURE_TASK_ID,
          proposalId: 'legacy-provenance-fixture-proposal',
          repository: FIXTURE_REPOSITORY,
          scope: FIXTURE_SCOPE,
          constraints,
          constraintsDigestSha256: computeConstraintsDigest(constraints),
          assessedAtUtcMs: Date.now(),
          maxEvidenceAgeMs: 24 * 60 * 60 * 1000,
        },
        triggers: {
          newCloudApiServiceAppLibraryCliAccount: false,
          authNetworkPrivacySecurityEncryptionBackupStorageChange: false,
          protectedMedicalData: false,
          feeOrFreeQuota: false,
          osBrowserCompatibility: false,
          largeTransfer: false,
          irreversibleOperation: false,
          ongoingMaintenance: false,
        },
        noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Bounded local synthetic-fixture edit for the legacy-provenance-triage selftest.' },
        checklist,
        humanTopConditions: [],
        deepResearch: null,
      },
      context: {
        proposalId: 'legacy-provenance-fixture-proposal',
        constraints,
        humanTopConditions: [],
      },
    };
  }

  // SYNTHETIC MOCK ONLY: a syntactically valid qualified-agent final-receipt
  // INPUT, constructed in-memory for this test only. No Claude CLI or any
  // other AI provider is ever invoked to produce it or anywhere else in this
  // file; it is evaluated purely through the existing, already-shipped
  // evaluateReceipt/verifyFinalReceipt pure functions.
  const syntheticMockFinalReceiptInput = {
    schemaVersion: 1,
    stage: 'final',
    task: { id: FIXTURE_TASK_ID, kind: 'implementation' },
    executor: { id: 'synthetic-mock-agent', provider: 'synthetic-mock', routeType: 'qualified-agent' },
    repository: FIXTURE_REPOSITORY,
    branch: FIXTURE_BRANCH,
    allowedScope: FIXTURE_SCOPE,
    dataClass: 'source-only',
    costPolicy: 'no-new-cost',
    requestedAuthorities: [],
    instructionClarity: fixtureInstructionClarity(),
    research: fixtureResearch(),
    implementationHead: replayHead,
    executionEvidence: {
      preHead: intermediateHead,
      changeSetSha256: changeSet.changeSetSha256,
      changedPaths: changeSet.changedPaths,
    },
  };

  const syntheticMockDecision = evaluateReceipt(syntheticMockFinalReceiptInput);
  assert.equal(syntheticMockDecision.result, 'PASS', `expected the synthetic mock final receipt to PASS evaluateReceipt: ${JSON.stringify(syntheticMockDecision)}`);

  const syntheticMockVerified = verifyFinalReceipt(syntheticMockDecision, {
    owner: FIXTURE_REPOSITORY.owner, name: FIXTURE_REPOSITORY.name, branch: FIXTURE_BRANCH, head: replayHead, repoRoot: tempRepoRoot,
  });
  assert.equal(syntheticMockVerified.result, 'MERGE_READY', `expected verifyFinalReceipt to independently verify the synthetic mock receipt against the fixture repo: ${JSON.stringify(syntheticMockVerified)}`);

  // The actual assertion under test: even though every sub-check above
  // genuinely succeeded (verified repository/branch identity, existing
  // related commits, a clean worktree, equal whole-tree hashes, and a
  // MERGE_READY-verified final receipt), diagnoseLegacyProvenance must still
  // only ever report tree-equivalence -- never original authorship, and
  // never MERGE_READY.
  const legacyProvenanceResult = diagnoseLegacyProvenance({
    originalHead,
    replayHead,
    receipt: syntheticMockDecision,
    repoRoot: tempRepoRoot,
    repository: FIXTURE_REPOSITORY,
    branch: FIXTURE_BRANCH,
  });
  assert.equal(legacyProvenanceResult.result, 'REPLAY_EQUIVALENT_NOT_ORIGINAL_AUTHORSHIP',
    `expected exactly REPLAY_EQUIVALENT_NOT_ORIGINAL_AUTHORSHIP: ${JSON.stringify(legacyProvenanceResult)}`);
  assert.equal(legacyProvenanceResult.originalWriterProven, false,
    'originalWriterProven must be false even for a fully-verified tree-identical replay');
  assert.notEqual(legacyProvenanceResult.result, 'MERGE_READY', 'diagnoseLegacyProvenance must never return MERGE_READY');
} finally {
  // Clean only this test's own temp directory; nothing else on disk is
  // created, modified, or removed by this fixture.
  fs.rmSync(tempRepoRoot, { recursive: true, force: true });
}

console.log('PASS 7/7');
