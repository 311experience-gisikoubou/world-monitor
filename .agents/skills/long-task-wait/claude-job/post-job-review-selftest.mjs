#!/usr/bin/env node
// Post-Job Review self-test (Issue #332). FIXTURE, not real E2E: the actual
// Claude audit reviewer and the actual Windows process observer are
// replaced with injectable mocks (see `runPostJobReview`'s options object).
// Everything else is real: a real temporary Git root, a real registered
// `git worktree`, a real `.ai-jobs/YYYYMMDD-001` job directory (ignored via
// a real `.gitignore`), real `computeChangeSetSha256`/`readHeadSha`
// evidence derived from one real file edit, and real atomic writer-claim
// acquire/release via `writer-claim-store.mjs`. No provider, GitHub, or
// scheduler is ever touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { runPostJobReview, verifyPostJobCompletion, AUDIT_PROMPT_JSON_EXAMPLES, computeAuditTimeoutMs } from './post-job-review.mjs';
import { computeChangeSetSha256, readHeadSha } from '../../preflight-audit/implementation-runner.mjs';
import { computeConstraintsDigest } from '../../preflight-audit/research-gate.mjs';
import {
  acquireClaim, releaseClaim, normalizeRepo, buildClaimPlan, defaultClaimsDir,
} from './writer-claim-store.mjs';

const EXECUTOR_ID = 'claude-implementation-write';
const AUDIT_ROUTE_ID = 'claude-safe-prompt';
// Realistic, non-rounded .NET DateTime ticks (18 digits): deliberately far
// past Number.MAX_SAFE_INTEGER (16 digits), so a legacy bare-JSON-number
// emission would already have lost precision before any comparison here.
const BIG_TICKS = '638712345678901234';

let passCount = 0;
let failCount = 0;
let skipCount = 0;
function report(name, ok, detail) {
  if (ok) { passCount += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
function skip(name, reason) { skipCount += 1; console.log(`SKIP ${name} (${reason})`); }

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return String(r.stdout || '').trim();
}
function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); }

// Builds one complete, real, PASS-eligible fixture: source root + worktree +
// job directory + one real source edit + a real writer claim. Returns every
// handle a test needs plus a `cleanup()` that releases the claim and
// removes the whole temp tree.
function buildFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pjr-selftest-'));
  const sourceRoot = path.join(tempRoot, 'source');
  fs.mkdirSync(sourceRoot);
  git(sourceRoot, ['init', '-q', '-b', 'main']);
  git(sourceRoot, ['config', 'user.email', 'selftest@example.invalid']);
  git(sourceRoot, ['config', 'user.name', 'PostJobReview Selftest']);
  git(sourceRoot, ['remote', 'add', 'origin', 'https://github.com/test-owner/test-repo.git']);
  fs.writeFileSync(path.join(sourceRoot, '.gitignore'), '.ai-jobs/\n');
  fs.mkdirSync(path.join(sourceRoot, 'src'));
  fs.writeFileSync(path.join(sourceRoot, 'src', 'widget.js'), 'module.exports = 1;\n');
  git(sourceRoot, ['add', '-A']);
  git(sourceRoot, ['commit', '-q', '-m', 'initial']);

  const today = new Date();
  const ymd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
  const jobId = `${ymd}-001`;
  const branch = `job/${jobId}-task`;
  const worktreePath = path.join(tempRoot, 'worktree');
  git(sourceRoot, ['worktree', 'add', '-q', '-b', branch, worktreePath, 'main']);

  const preHead = readHeadSha(worktreePath);
  fs.writeFileSync(path.join(worktreePath, 'src', 'widget.js'), 'module.exports = 2;\n');
  const executionEvidence = { preHead, ...computeChangeSetSha256(worktreePath, preHead) };

  const jobDir = path.join(sourceRoot, '.ai-jobs', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const expectedTaskId = `claude-job-${jobId}`;
  const owner = 'test-owner';
  const name = 'test-repo';
  const scopePaths = ['src/widget.js'];
  const targetIssueNumber = 332;
  const pid = 999999;

  const instructionClarity = {
    schemaVersion: 1, taskId: expectedTaskId,
    instructions: [{ id: 'i1', kind: 'INSTRUCTION', summary: 'Bump widget version constant.' }],
    unlistedAssumptionsPresent: false, ambiguities: [],
  };

  const constraints = ['no-new-cost'];
  const research = {
    evidence: {
      schemaVersion: 1,
      evidenceBinding: {
        taskId: expectedTaskId, proposalId: 'proposal-332', repository: { owner, name },
        scope: scopePaths, constraints, constraintsDigestSha256: computeConstraintsDigest(constraints),
        assessedAtUtcMs: Date.now(), maxEvidenceAgeMs: 60 * 60 * 1000,
      },
      triggers: {
        newCloudApiServiceAppLibraryCliAccount: false,
        authNetworkPrivacySecurityEncryptionBackupStorageChange: false,
        protectedMedicalData: false, feeOrFreeQuota: false, osBrowserCompatibility: false,
        largeTransfer: false, irreversibleOperation: false, ongoingMaintenance: false,
      },
      noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Local text-only constant edit.' },
      checklist: ['safety', 'dataPreservation', 'existingOverlap'].map((id) => ({
        id, status: 'PASS', applicable: true, justification: 'No risk.', primarySourceRef: 'local-inspection',
      })),
    },
    context: { proposalId: 'proposal-332', constraints, humanTopConditions: [] },
  };

  const task = {
    schemaVersion: 1, taskId: expectedTaskId, kind: 'implementation', objective: 'task',
    prompt: 'Bump the widget version constant.', repoRoot: worktreePath, branch,
    allowedScope: scopePaths, forbiddenScope: [], doneConditions: ['Implement only the requested task within allowedScope.'],
    requiredTests: [], dataClass: 'source-only', repository: { owner, name },
    instructionClarity, research,
  };
  writeJson(path.join(jobDir, 'task.json'), task);
  writeJson(path.join(jobDir, 'instruction-clarity.json'), instructionClarity);
  writeJson(path.join(jobDir, 'research.json'), research);

  const orch = {
    result: 'COMPLETED', taskId: expectedTaskId,
    preImplementationReceipt: {
      result: 'PROCEED', taskId: expectedTaskId, repository: { owner, name }, branch,
      executor: { id: EXECUTOR_ID, provider: 'claude', routeType: 'qualified-agent' }, allowedScope: scopePaths,
    },
    runner: { result: 'COMPLETED', routeId: EXECUTOR_ID, executionEvidence },
    executionEvidence,
  };
  writeJson(path.join(jobDir, 'orchestrator.json'), orch);

  fs.writeFileSync(path.join(jobDir, 'test.log'), '$ run-tests --marker=DO-NOT-RERUN-SELFTEST\nALL TESTS PASSED\n', 'utf8');
  fs.writeFileSync(path.join(jobDir, 'DONE'), 'judged_by=outer_runner\n', 'utf8');
  writeJson(path.join(jobDir, 'result.json'), {
    job_id: jobId, final_state: 'READY_FOR_REVIEW',
    gates: { orchestrator_exit: 'PASS', claude_result: 'PASS', scope: 'PASS', test: 'PASS' },
    changed_files: executionEvidence.changedPaths,
  });

  const localAppData = path.join(tempRoot, 'localappdata');
  const status = {
    job_id: jobId, repository_owner: owner, repository_name: name, repo: sourceRoot, worktree: worktreePath,
    branch, root_base_commit: preHead, scope_paths: scopePaths, test_command: 'npm test', target_pr_number: 0, target_issue_number: targetIssueNumber,
    runner_pid: pid, runner_process_start_utc_ticks: BIG_TICKS, state: 'READY_FOR_REVIEW', post_job_review: true,
  };
  writeJson(path.join(jobDir, 'status.json'), status);

  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  const repo = normalizeRepo(`${owner}/${name}`);
  const ownerToken = randomBytes(16).toString('hex');
  const claim = acquireClaim({
    repo, prNumber: null, issueNumber: targetIssueNumber, branch, jobId, ownerToken, pid, processStartUtcTicks: BIG_TICKS,
  });
  if (!claim.ok) { process.env.LOCALAPPDATA = priorLocalAppData; throw new Error(`fixture claim acquire failed: ${claim.code}`); }

  const cleanup = () => {
    try { releaseClaim({ repo, prNumber: null, issueNumber: targetIssueNumber, branch, jobId, ownerToken }); } catch { /* best-effort */ }
    process.env.LOCALAPPDATA = priorLocalAppData;
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  return {
    tempRoot, sourceRoot, worktreePath, jobDir, jobId, branch, executionEvidence, pid, ownerToken, localAppData,
    cleanup, deps: { observeProcessStartTicks: (p) => (p === pid ? BIG_TICKS : null), launcherPid: pid },
  };
}

function baseReviewerResult() {
  return {
    result: 'COMPLETED', taskId: undefined, capability: 'audit', dataClass: 'source-only', routeId: AUDIT_ROUTE_ID,
    output: JSON.stringify({ verdict: 'PASS', findings: [] }),
    evidence: {
      authentication: 'VERIFIED', toolBoundary: 'NO_LOCAL_TOOLS_ENFORCED', dataBoundary: 'EXPLICIT_SAFE_PAYLOAD_ONLY',
      incrementalCostBoundary: 'INCLUDED_ONLY_ENFORCED', fallbackBehavior: 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION',
    },
  };
}
// A real reviewer call binds result.taskId to payload.taskId; this mock does the same.
function reviewerFor(buildOutput) {
  return (payload) => ({ ...baseReviewerResult(), taskId: payload.taskId, output: JSON.stringify(buildOutput()) });
}

async function main() {
  // 0) The audit prompt's own embedded example replies must themselves be
  // real, valid JSON (verified via JSON.parse, never brittle string
  // scanning) AND already satisfy the exact verdict/findings contract the
  // audit response validator enforces below.
  {
    const ALLOWED_VERDICTS = new Set(['PASS', 'CONCERNS', 'FAIL']);
    let allValid = Array.isArray(AUDIT_PROMPT_JSON_EXAMPLES) && AUDIT_PROMPT_JSON_EXAMPLES.length >= 2;
    for (const example of allValid ? AUDIT_PROMPT_JSON_EXAMPLES : []) {
      let parsed;
      try { parsed = JSON.parse(example); } catch { allValid = false; break; }
      const keys = Object.keys(parsed).sort();
      if (keys.length !== 2 || keys[0] !== 'findings' || keys[1] !== 'verdict' ||
          !ALLOWED_VERDICTS.has(parsed.verdict) ||
          !Array.isArray(parsed.findings) ||
          !parsed.findings.every((f) => typeof f === 'string')) {
        allValid = false; break;
      }
    }
    report('audit-prompt-json-examples-are-valid-and-contract-compliant', allValid);
  }

  // 1) One normal run: real commit + exact final receipt.
  {
    const f = buildFixture();
    try {
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: reviewerFor(() => ({ verdict: 'PASS', findings: [] })),
        observeProcessStartTicks: f.deps.observeProcessStartTicks,
        launcherPid: f.deps.launcherPid,
      });
      const headAfter = readHeadSha(f.worktreePath);
      report('normal-run-completed', result.ok === true && result.result === 'COMPLETED', JSON.stringify(result));
      report('normal-run-next-owner', result.nextOwner === 'DRAFT_PR_HANDOFF_REQUIRED', result.nextOwner);
      report('normal-run-committed', headAfter === result.headAfter && headAfter !== f.executionEvidence.preHead);
      report('normal-run-receipt-persisted', fs.existsSync(path.join(f.jobDir, 'post-job-review-receipt.json')));
      writeStatusField(f, 'post_job_review_state', 'COMPLETED');
      writeStatusField(f, 'post_job_review_code', 'POST_JOB_REVIEW_FINAL_RECEIPT_ISSUED');
      const bind = { jobDir: f.jobDir, repository: 'test-owner/test-repo', issueNumber: 332, branch: f.branch, head: headAfter };
      const verified = verifyPostJobCompletion(bind);
      report('publication-real-committed-bytes-verified', verified.ok === true, JSON.stringify(verified));
      report('publication-wrong-issue-rejected', verifyPostJobCompletion({ ...bind, issueNumber: 333 }).code === 'PUBLICATION_JOB_BINDING_MISMATCH');
      report('publication-stale-head-rejected', verifyPostJobCompletion({ ...bind, head: f.executionEvidence.preHead }).ok === false);
      writeStatusField(f, 'post_job_review_state', 'STOP');
      report('publication-review-stop-rejected', verifyPostJobCompletion(bind).code === 'PUBLICATION_REVIEW_NOT_COMPLETED');
      writeStatusField(f, 'post_job_review_state', 'COMPLETED');
      const receiptFile = path.join(f.jobDir, 'post-job-review-receipt.json');
      const originalReceipt = fs.readFileSync(receiptFile, 'utf8');
      mutateJson(receiptFile, (r) => { r.auditInvocation.findings = ['blocking finding']; });
      report('publication-findings-rejected', verifyPostJobCompletion(bind).code === 'PUBLICATION_AUDIT_EVIDENCE_INVALID');
      fs.writeFileSync(receiptFile, originalReceipt);
      fs.appendFileSync(path.join(f.jobDir, 'test.log'), 'unexpected evidence drift');
      report('publication-test-log-drift-rejected', verifyPostJobCompletion(bind).code === 'PUBLICATION_TEST_EVIDENCE_MISMATCH');
      report('normal-run-test-log-untouched', fs.readFileSync(path.join(f.jobDir, 'test.log'), 'utf8').includes('DO-NOT-RERUN-SELFTEST'));
    } finally { f.cleanup(); }
  }

  // 2) Table-driven STOP-before-commit scenarios: each mutates one fresh
  // fixture, then asserts the exact code and that NOTHING was committed.
  const mutations = [
    ['existing-receipt-output', (f) => fs.writeFileSync(path.join(f.jobDir,'post-job-review-receipt.json'), 'existing sentinel'), 'RECEIPT_OUTPUT_ALREADY_EXISTS_OR_UNSAFE'],
    ['hardlinked-receipt-output', (f) => {
      const sentinel = path.join(f.tempRoot,'outside-sentinel.txt');
      fs.writeFileSync(sentinel,'outside sentinel');
      fs.linkSync(sentinel,path.join(f.jobDir,'post-job-review-receipt.json'));
    }, 'RECEIPT_OUTPUT_ALREADY_EXISTS_OR_UNSAFE'],
    ['missing-required-gate', (f) => mutateJson(path.join(f.jobDir, 'result.json'), (r) => { r.gates = { scope: 'PASS' }; }), 'RESULT_REQUIRED_GATE_MISSING'],
    ['additional-failing-gate', (f) => mutateJson(path.join(f.jobDir, 'result.json'), (r) => { r.gates.extra = 'SKIPPED'; }), 'RESULT_GATE_NOT_PASS'],
    ['unsupported-retry-chain', (f) => mutateJson(path.join(f.jobDir, 'result.json'), (r) => { r.attempt = 2; r.retry_checkpoints = [f.executionEvidence.preHead]; }), 'POST_JOB_HISTORY_REQUIRES_QUALIFIED_CHAIN'],
    ['unsupported-continuation-chain', (f) => writeStatusField(f, 'continued_from', '20260101-002'), 'POST_JOB_HISTORY_REQUIRES_QUALIFIED_CHAIN'],
    ['tracked-binary', (f) => {
      fs.writeFileSync(path.join(f.worktreePath, 'src/widget.js'), Buffer.from([0,1,2,3]));
      refreshEvidence(f);
    }, 'BINARY_CONTENT_CANNOT_BE_AUTO_APPROVED'],
    ['opaque-diff-attribute', (f) => {
      fs.writeFileSync(path.join(f.worktreePath, '.gitattributes'), 'src/widget.js -diff\n');
      git(f.worktreePath, ['add', '--', '.gitattributes']);
      git(f.worktreePath, ['commit', '-q', '-m', 'fixture attribute baseline']);
      refreshEvidence(f);
      writeStatusField(f, 'root_base_commit', readHeadSha(f.worktreePath));
    }, 'BINARY_CONTENT_CANNOT_BE_AUTO_APPROVED'],
    ['missing-test-log', (f) => fs.rmSync(path.join(f.jobDir, 'test.log')), 'TEST_LOG_MISSING_OR_UNSAFE'],
    ['missing-done', (f) => fs.rmSync(path.join(f.jobDir, 'DONE')), 'DONE_FILE_MISSING_OR_UNSAFE'],
    ['disabled-opt-in', (f) => writeStatusField(f, 'post_job_review', false), 'STATUS_POST_JOB_REVIEW_NOT_OPTED_IN'],
    ['outer-not-ready', (f) => writeStatusField(f, 'state', 'RUNNING'), 'STATUS_STATE_NOT_READY_FOR_REVIEW'],
    ['missing-target', (f) => { writeStatusField(f, 'target_issue_number', 0); writeStatusField(f, 'target_pr_number', 0); }, 'STATUS_TARGET_IDENTITY_MISSING'],
    ['legacy-numeric-ticks', (f) => writeStatusField(f, 'runner_process_start_utc_ticks', Number(BIG_TICKS)), 'STATUS_RUNNER_TICKS_INVALID'],
    ['fake-task-id', (f) => mutateJson(path.join(f.jobDir, 'task.json'), (t) => { t.taskId = 'claude-job-forged'; }), 'TASK_TASK_ID_MISMATCH'],
    ['stale-head', (f) => git(f.worktreePath, ['commit', '--allow-empty', '-q', '-m', 'unexpected extra commit']), 'SOURCE_CHANGED_SINCE_EXECUTION'],
    // A syntactically valid (64-hex) but WRONG digest is not caught by the
    // shape-only ORCH_EXECUTION_EVIDENCE_INVALID check; it is caught by the
    // real recomputation in verifySourceStillMatchesExecutionEvidence.
    ['stale-digest', (f) => mutateJson(path.join(f.jobDir, 'orchestrator.json'), (o) => { o.executionEvidence.changeSetSha256 = o.executionEvidence.changeSetSha256.replace(/^./, (c) => (c === '0' ? '1' : '0')); o.runner.executionEvidence = o.executionEvidence; }), 'SOURCE_CHANGED_SINCE_EXECUTION'],
    ['no-claim-held', (f) => { releaseClaim({ repo: normalizeRepo('test-owner/test-repo'), prNumber: null, issueNumber: 332, branch: f.branch, jobId: f.jobId, ownerToken: f.ownerToken }); }, 'WRITER_CLAIM_NOT_HELD'],
    ['launcher-ppid-mismatch', null, 'LAUNCHER_PPID_MISMATCH'],
  ];

  for (const [name, mutate, expectedCode] of mutations) {
    const f = buildFixture();
    try {
      if (mutate) mutate(f);
      const headBeforeCall = readHeadSha(f.worktreePath);
      const launcherPid = name === 'launcher-ppid-mismatch' ? f.pid + 1 : f.deps.launcherPid;
      let reviewerCalls = 0;
      const mock = reviewerFor(() => ({ verdict: 'PASS', findings: [] }));
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: (payload) => { reviewerCalls++; return mock(payload); },
        observeProcessStartTicks: f.deps.observeProcessStartTicks,
        launcherPid,
      });
      const headAfter = readHeadSha(f.worktreePath);
      report(name, result.ok === false && result.code === expectedCode, JSON.stringify(result));
      report(`${name}-no-commit-made`, headAfter === headBeforeCall);
      report(`${name}-provider-not-invoked`, reviewerCalls === 0);
      if (name === 'hardlinked-receipt-output') {
        report('outside-linked-sentinel-preserved', fs.readFileSync(path.join(f.tempRoot,'outside-sentinel.txt'),'utf8') === 'outside sentinel');
      }
    } catch (e) { report(name, false, e.message); } finally { f.cleanup(); }
  }

  // 3) Audit-output rejections (PASS-with-findings; extra JSON key).
  {
    const f = buildFixture();
    try {
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: reviewerFor(() => ({ verdict: 'PASS', findings: ['unexpected change'] })),
        observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      report('pass-with-findings-rejected', result.ok === false && result.code === 'AUDIT_PASS_WITH_FINDINGS_REJECTED', JSON.stringify(result));
    } finally { f.cleanup(); }
  }
  {
    const f = buildFixture();
    try {
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: reviewerFor(() => ({ verdict: 'PASS', findings: [], extra: 'unexpected' })),
        observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      report('extra-json-key-rejected', result.ok === false && result.code === 'AUDIT_OUTPUT_INVALID', JSON.stringify(result));
    } finally { f.cleanup(); }
  }
  {
    // Markdown-fenced output (untrusted/non-conforming provider reply):
    // must never be unwrapped or otherwise tolerated -- it is rejected by
    // the same strict JSON.parse as any other malformed text.
    const f = buildFixture();
    try {
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: (payload) => ({
          ...baseReviewerResult(), taskId: payload.taskId,
          output: '```json\n' + JSON.stringify({ verdict: 'PASS', findings: [] }) + '\n```',
        }),
        observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      report('markdown-fenced-output-rejected', result.ok === false && result.code === 'AUDIT_OUTPUT_INVALID', JSON.stringify(result));
    } finally { f.cleanup(); }
  }
  {
    // Fully malformed/untrusted non-JSON text output.
    const f = buildFixture();
    try {
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: (payload) => ({
          ...baseReviewerResult(), taskId: payload.taskId, output: 'Sure, looks fine to me.',
        }),
        observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      report('malformed-non-json-output-rejected', result.ok === false && result.code === 'AUDIT_OUTPUT_INVALID', JSON.stringify(result));
    } finally { f.cleanup(); }
  }

  // 4) Owner lost DURING audit: the reviewer's own call deletes this job's
  // claim as a side effect before returning a normal PASS payload.
  {
    const f = buildFixture();
    try {
      const repo = normalizeRepo('test-owner/test-repo');
      const plan = buildClaimPlan({ repo, prNumber: null, issueNumber: 332, branch: f.branch });
      const claimsDir = defaultClaimsDir();
      const reviewer = (payload) => {
        fs.rmSync(path.join(claimsDir, `${plan[0].key}.json`), { force: true });
        return { ...baseReviewerResult(), taskId: payload.taskId, output: JSON.stringify({ verdict: 'PASS', findings: [] }) };
      };
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: reviewer, observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      const headAfter = readHeadSha(f.worktreePath);
      report('owner-lost-during-audit', result.ok === false && result.code === 'WRITER_CLAIM_LOST_BEFORE_COMMIT', JSON.stringify(result));
      report('owner-lost-during-audit-no-commit', headAfter === f.executionEvidence.preHead);
    } finally { f.cleanup(); }
  }

  // 5) Staged-content drift: source bytes change DURING the audit window
  // (as a side effect of the reviewer call), caught before git add/commit.
  {
    const f = buildFixture();
    try {
      const reviewer = (payload) => {
        fs.writeFileSync(path.join(f.worktreePath, 'src', 'widget.js'), 'module.exports = 999;\n');
        return { ...baseReviewerResult(), taskId: payload.taskId, output: JSON.stringify({ verdict: 'PASS', findings: [] }) };
      };
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: reviewer, observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      const headAfter = readHeadSha(f.worktreePath);
      report('staged-content-drift-rejected', result.ok === false && result.code === 'SOURCE_CHANGED_SINCE_EXECUTION', JSON.stringify(result));
      report('staged-content-drift-no-commit', headAfter === f.executionEvidence.preHead);
    } finally { f.cleanup(); }
  }

  // 6) Ancestor junction (Windows directory junction, no admin required):
  // status.worktree resolves THROUGH a junction and must be rejected.
  if (process.platform === 'win32') {
    const f = buildFixture();
    try {
      const junctionPath = path.join(f.tempRoot, 'worktree-junction');
      fs.symlinkSync(f.worktreePath, junctionPath, 'junction');
      writeStatusField(f, 'worktree', junctionPath);
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: reviewerFor(() => ({ verdict: 'PASS', findings: [] })),
        observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      report('ancestor-junction-rejected', result.ok === false && result.code === 'STATUS_WORKTREE_PATH_UNSAFE', JSON.stringify(result));
    } finally { f.cleanup(); }
  } else {
    skip('ancestor-junction-rejected', 'non-Windows platform');
  }

  // 7) Deterministic audit time budget (Issue #332): exact synthetic
  // boundary values derived from the defined parameters (60000 base,
  // 10KiB free allowance, 8ms/extra-byte, hard-clamped to 300000), never a
  // loose/inexact bound.
  report('timeout-1kib-exact-60000', computeAuditTimeoutMs(1024) === 60000);
  // 42KiB: 60000 + max(0, (42-10)*1024)*8 = 60000 + 262144 = 322144, hard
  // clamped to the 300000 ceiling -- an exact expected value, not merely
  // "> 120000".
  report('timeout-42kib-clamped-exact-300000', computeAuditTimeoutMs(42 * 1024) === 300000);
  report('timeout-huge-exact-300000', computeAuditTimeoutMs(10 * 1024 * 1024) === 300000);
  report('timeout-supplied-clamped-low-exact-60000', computeAuditTimeoutMs(0, 10) === 60000);
  report('timeout-supplied-clamped-high-exact-300000', computeAuditTimeoutMs(0, 999999) === 300000);
  // Monotonic: a strictly larger diff never yields a smaller derived budget.
  report('timeout-monotonic-non-decreasing',
    computeAuditTimeoutMs(1024) <= computeAuditTimeoutMs(20 * 1024) &&
    computeAuditTimeoutMs(20 * 1024) <= computeAuditTimeoutMs(42 * 1024));

  // 8) The chosen timeoutMs is actually threaded through to the reviewer
  // call, and a non-COMPLETED (e.g. provider timeout) audit result STOPs
  // with no receipt ever written.
  {
    const f = buildFixture();
    try {
      let seenTimeoutMs;
      const result = runPostJobReview({ jobDir: f.jobDir }, {
        runAuditReviewer: (payload, opts) => { seenTimeoutMs = opts.timeoutMs; return { result: 'FAILED', code: 'PROVIDER_TIMEOUT' }; },
        observeProcessStartTicks: f.deps.observeProcessStartTicks, launcherPid: f.deps.launcherPid,
      });
      report('timeout-threaded-to-reviewer', seenTimeoutMs === 60000, String(seenTimeoutMs));
      report('provider-timeout-stop-no-receipt', result.ok === false && result.code === 'AUDIT_INVOCATION_NOT_COMPLETED' &&
        !fs.existsSync(path.join(f.jobDir, 'post-job-review-receipt.json')));
    } finally { f.cleanup(); }
  }

  console.log(`\nPASS=${passCount} FAIL=${failCount} SKIP=${skipCount}`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

function refreshEvidence(f) {
  const preHead = readHeadSha(f.worktreePath);
  const executionEvidence = { preHead, ...computeChangeSetSha256(f.worktreePath, preHead) };
  mutateJson(path.join(f.jobDir, 'orchestrator.json'), (o) => {
    o.executionEvidence = executionEvidence; o.runner.executionEvidence = executionEvidence;
  });
  mutateJson(path.join(f.jobDir, 'result.json'), (r) => { r.changed_files = executionEvidence.changedPaths; });
}
function writeStatusField(fixture, field, value) {
  mutateJson(path.join(fixture.jobDir, 'status.json'), (s) => { s[field] = value; });
}
function mutateJson(file, mutate) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(obj);
  writeJson(file, obj);
}

main().catch((e) => { console.error(`FATAL ${e.stack || e}`); process.exitCode = 2; });