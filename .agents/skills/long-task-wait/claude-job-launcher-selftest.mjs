#!/usr/bin/env node
// Offline regression for run-claude-job.ps1: FAIL / UNKNOWN / missing /
// mismatched-repository-or-scope / mismatched-continuation-context Research
// Gate evidence must reject the job BEFORE any branch, worktree, background
// job, or continuation checkpoint mutation happens. This drives the REAL
// Windows PowerShell 5 launcher end to end (no mocked PowerShell, no real
// Claude/provider invocation, no GitHub/network access) against a temporary
// synthetic git repository seeded with the REAL research-gate.mjs module
// (copied verbatim from existing source into the same seed commit, so the
// launcher's own repo-relative gate lookup actually resolves) plus local
// fixture prompt/clarity/evidence files kept OUTSIDE the repository so they
// can never masquerade as dirty in-scope changes. Every rejection is also
// verified by comparing git HEAD/ref/worktree inventories before and after
// the launcher call. Windows-only; a no-op elsewhere.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeConstraintsDigest } from '../preflight-audit/research-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, 'claude-job', 'run-claude-job.ps1');
// research-gate.mjs has no imports of its own (only node builtins), so a
// single-file copy is its complete dependency closure.
const researchGateSource = join(here, '..', 'preflight-audit', 'research-gate.mjs');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_IDENTITY = { owner: 'example-owner', name: 'example-repo' };

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git failed: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout.trim();
}
function runLauncher(root, args) {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-RepoPath', root, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}
// Synthetic repo must contain the REAL Research Gate module (copied from
// existing source, not reimplemented) as a fixture seed inside the SAME
// baseline/seed commit, so the real launcher's own
// `.agents\skills\preflight-audit\research-gate.mjs` lookup (relative to
// -RepoPath, not to this selftest's own directory) actually resolves and the
// gate genuinely runs -- instead of hitting the unrelated
// "research-gate.mjs is missing in repository" failure before the Research
// Gate is ever reached.
function makeRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(['init', '-q', root]);
  git(['config', 'user.name', 'AI Test'], root);
  git(['config', 'user.email', 'ai-test@example.invalid'], root);
  git(['remote', 'add', 'origin', `https://github.com/${REPO_IDENTITY.owner}/${REPO_IDENTITY.name}.git`], root);
  writeFileSync(join(root, '.gitignore'), '.ai-jobs/\n');
  writeFileSync(join(root, 'README.md'), 'seed\n');
  const gateDir = join(root, '.agents', 'skills', 'preflight-audit');
  mkdirSync(gateDir, { recursive: true });
  copyFileSync(researchGateSource, join(gateDir, 'research-gate.mjs'));
  git(['add', '.gitignore', 'README.md', '.agents'], root);
  git(['commit', '-q', '-m', 'seed'], root);
  git(['branch', '-M', 'main'], root);
  return root;
}
// Fixture prompt/clarity/research files are written OUTSIDE the synthetic
// repository (a separate owned temp directory, cleaned up by the caller),
// never inside it. Writing them inside the repo would show up as untracked,
// out-of-scope dirty changes when the launcher's own continuation dirty-scan
// (`git ls-files --others --exclude-standard`) runs, which would make a
// dirty-checkpoint test (Test D) fail on an unrelated
// "out-of-scope changes exist" rejection instead of proving the exact
// intended Research Gate rejection.
function externalFixtureDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function promptFile(dir) {
  const p = join(dir, 'prompt.md');
  writeFileSync(p, 'Synthetic launcher-regression prompt.\n', 'utf8');
  return p;
}
function instructionClarityFile(dir, name, taskId = 'placeholder') {
  const p = join(dir, name);
  writeJson(p, {
    schemaVersion: 1,
    taskId,
    instructions: [{ id: 'instr-1', kind: 'INSTRUCTION', summary: 'Synthetic launcher-regression instruction.' }],
    unlistedAssumptionsPresent: false,
    ambiguities: [],
  });
  return p;
}
function checklistItem(id, status, overrides = {}) {
  const applicable = overrides.applicable ?? true;
  const item = { id, status, applicable, justification: overrides.justification || `Evaluated ${id}.` };
  if (applicable && (status === 'PASS' || status === 'FAIL')) item.primarySourceRef = 'https://example.invalid/evidence';
  if (!applicable) item.inapplicableReason = 'Not applicable for this scenario.';
  return item;
}
function minimalEvidence({ taskId, proposalId, constraints = [], checklistOverride = {} }) {
  const ids = ['safety', 'dataPreservation', 'existingOverlap'];
  const checklist = ids.map((id) => {
    const o = checklistOverride[id];
    return o ? checklistItem(id, o.status ?? 'PASS', o) : checklistItem(id, 'PASS');
  });
  return {
    schemaVersion: 1,
    evidenceBinding: {
      taskId,
      proposalId,
      repository: { ...REPO_IDENTITY },
      scope: ['src/demo/**'],
      constraints,
      constraintsDigestSha256: computeConstraintsDigest(constraints),
      assessedAtUtcMs: Date.now(),
      maxEvidenceAgeMs: DAY_MS,
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
    noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Synthetic launcher-regression fixture.' },
    checklist,
    humanTopConditions: [],
    deepResearch: null,
    basicResearcher: null,
  };
}
function researchEnvelopeFile(dir, name, evidence, proposalId, constraints = []) {
  const p = join(dir, name);
  writeJson(p, { evidence, context: { proposalId, constraints, humanTopConditions: [] } });
  return p;
}

function listJobBranches(root) {
  const raw = git(['branch', '--list', 'job/*'], root);
  if (!raw) return [];
  return raw.split('\n').map((line) => line.replace(/^\*?\s*/, '').trim()).filter(Boolean).sort();
}
// Compares git HEAD/ref/worktree inventories before/after a launcher
// invocation, so a rejection is proven to be the exact intended Research
// Gate stop rather than any other unrelated side effect/mutation.
function captureInventory(root) {
  return {
    head: git(['rev-parse', 'HEAD'], root),
    branches: listJobBranches(root),
    worktrees: git(['worktree', 'list', '--porcelain'], root),
  };
}
function assertInventoryUnchanged(before, after, label) {
  assert.equal(after.head, before.head, `${label}: HEAD must not move`);
  assert.deepEqual(after.branches, before.branches, `${label}: job branches must not change`);
  assert.equal(after.worktrees, before.worktrees, `${label}: worktree list must not change`);
}
function assertNoMutation(root, { jobsRootShouldExist = true, expectedSubdirs = [], expectedJobBranches = [] } = {}) {
  const jobsRoot = join(root, '.ai-jobs');
  if (jobsRootShouldExist) {
    assert.ok(existsSync(jobsRoot), '.ai-jobs root may exist (created before any rejection), but nothing inside it may be a real job mutation');
    const entries = readdirSync(jobsRoot).sort();
    assert.deepEqual(entries, [...expectedSubdirs].sort(), `no new job directory/lock may be created on rejection; found: ${JSON.stringify(entries)}`);
  } else {
    assert.equal(existsSync(jobsRoot), false, '.ai-jobs must not be created at all for this rejection path');
  }
  const worktreesSibling = join(dirname(root), `${basename(root)}.ai-worktrees`);
  assert.equal(existsSync(worktreesSibling), false, 'no sibling .ai-worktrees directory may be created before the Research Gate clears');
  assert.deepEqual(listJobBranches(root), [...expectedJobBranches].sort(), 'no new job/* branch may be created before the Research Gate clears');
  const commitCount = git(['rev-list', '--count', 'HEAD'], root);
  assert.equal(commitCount, '1', 'no checkpoint/implementation commit may be created before the Research Gate clears');
}

if (process.platform !== 'win32') {
  console.log('claude-job-launcher selftest: SKIPPED (non-Windows platform; run-claude-job.ps1 is Windows PowerShell only)');
} else {
  let assertions = 0;
  const wrap = (fn) => (...a) => { fn(...a); assertions += 1; };
  const ok = wrap(assert.ok);
  const match = wrap(assert.match);

  // --- Test A: FAIL evidence on a brand-new job rejects before any mutation ---
  {
    const root = makeRepo('claude-job-launcher-fail-');
    const fixtures = externalFixtureDir('claude-job-launcher-fail-fixtures-');
    try {
      const before = captureInventory(root);
      const prompt = promptFile(fixtures);
      const clarity = instructionClarityFile(fixtures, 'clarity.json');
      const evidence = minimalEvidence({
        taskId: 'placeholder', proposalId: 'proposal-fail',
        checklistOverride: { safety: { status: 'FAIL', justification: 'Synthetic FAIL: proves REJECT stops the launcher before any mutation.' } },
      });
      const research = researchEnvelopeFile(fixtures, 'research.json', evidence, 'proposal-fail');
      const result = runLauncher(root, [
        '-PromptFile', prompt, '-InstructionClarityFile', clarity, '-ResearchEvidenceFile', research,
        '-ScopePaths', 'src/demo/**', '-BaseRef', 'main',
      ]);
      ok(result.status !== 0, `FAIL evidence must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /Research Gate did not clear/, 'FAIL evidence surfaces the Research Gate rejection message');
      assertNoMutation(root);
      assertInventoryUnchanged(before, captureInventory(root), 'Test A (FAIL)');
      assertions += 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  }

  // --- Test B: UNKNOWN evidence rejects before any mutation (TRIAL_REQUIRED still blocks source work) ---
  {
    const root = makeRepo('claude-job-launcher-unknown-');
    const fixtures = externalFixtureDir('claude-job-launcher-unknown-fixtures-');
    try {
      const before = captureInventory(root);
      const prompt = promptFile(fixtures);
      const clarity = instructionClarityFile(fixtures, 'clarity.json');
      const evidence = minimalEvidence({
        taskId: 'placeholder', proposalId: 'proposal-unknown',
        checklistOverride: { safety: { status: 'UNKNOWN', justification: 'Synthetic UNKNOWN: a bounded trial, not a source-write-blocking pass, is the only authorized next step.' } },
      });
      const research = researchEnvelopeFile(fixtures, 'research.json', evidence, 'proposal-unknown');
      const result = runLauncher(root, [
        '-PromptFile', prompt, '-InstructionClarityFile', clarity, '-ResearchEvidenceFile', research,
        '-ScopePaths', 'src/demo/**', '-BaseRef', 'main',
      ]);
      ok(result.status !== 0, `UNKNOWN evidence must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /Research Gate did not clear/, 'UNKNOWN evidence surfaces the Research Gate rejection message');
      assertNoMutation(root);
      assertInventoryUnchanged(before, captureInventory(root), 'Test B (UNKNOWN)');
      assertions += 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  }

  // --- Test C: missing ResearchEvidenceFile on a new job rejects before any mutation ---
  {
    const root = makeRepo('claude-job-launcher-missing-');
    const fixtures = externalFixtureDir('claude-job-launcher-missing-fixtures-');
    try {
      const before = captureInventory(root);
      const prompt = promptFile(fixtures);
      const clarity = instructionClarityFile(fixtures, 'clarity.json');
      const result = runLauncher(root, [
        '-PromptFile', prompt, '-InstructionClarityFile', clarity,
        '-ScopePaths', 'src/demo/**', '-BaseRef', 'main',
      ]);
      ok(result.status !== 0, `missing ResearchEvidenceFile must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /ResearchEvidenceFile is required/, 'missing evidence surfaces the exact required-file message');
      // .ai-jobs itself is created early (job tracking root), but no job
      // directory or lock may exist for this early rejection.
      assertNoMutation(root);
      assertInventoryUnchanged(before, captureInventory(root), 'Test C (missing evidence)');
      assertions += 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  }

  // --- Test D: continuation with a changed proposal/constraints context rejects
  //     before the continuation checkpoint commit, leaving dirty in-scope
  //     changes uncommitted ---
  {
    const root = makeRepo('claude-job-launcher-mismatch-');
    const fixtures = externalFixtureDir('claude-job-launcher-mismatch-fixtures-');
    try {
      git(['checkout', '-b', 'job/prevjob-task'], root);
      const head = git(['rev-parse', 'HEAD'], root);
      const prevJobId = 'prevjob';
      const prevJobDir = join(root, '.ai-jobs', prevJobId);
      mkdirSync(prevJobDir, { recursive: true });
      writeJson(join(prevJobDir, 'status.json'), {
        job_id: prevJobId, task: 'demo', state: 'READY_FOR_REVIEW',
        repo: root, worktree: root, branch: 'job/prevjob-task', root_base_commit: head,
        scope_paths: ['src/demo/**'], test_command: 'echo ok',
        instruction_clarity_file: 'instruction-clarity.json', research_evidence_file: 'research.json',
        provider_timeout_minutes: 360, started_at: new Date().toISOString(), runner_pid: null,
      });
      const prevEvidence = minimalEvidence({ taskId: 'claude-job-prevjob', proposalId: 'proposal-prev' });
      writeJson(join(prevJobDir, 'research.json'), { evidence: prevEvidence, context: { proposalId: 'proposal-prev', constraints: [], humanTopConditions: [] } });

      // A real dirty, in-scope, uncommitted change that a successful
      // continuation would otherwise checkpoint-commit.
      mkdirSync(join(root, 'src', 'demo'), { recursive: true });
      writeFileSync(join(root, 'src', 'demo', 'change.txt'), 'synthetic in-progress change\n', 'utf8');

      const before = captureInventory(root);
      const prompt = promptFile(fixtures);
      const newEvidence = minimalEvidence({ taskId: 'placeholder', proposalId: 'proposal-new' });
      const newResearch = researchEnvelopeFile(fixtures, 'new-research.json', newEvidence, 'proposal-new');

      const result = runLauncher(root, [
        '-PromptFile', prompt, '-ResearchEvidenceFile', newResearch,
        '-ScopePaths', 'src/demo/**', '-ContinueJob', prevJobId,
      ]);
      ok(result.status !== 0, `changed proposal/context must reject continuation: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /Research Gate did not clear/, 'changed continuation context surfaces the Research Gate rejection message');

      // No checkpoint commit happened (assertNoMutation below confirms HEAD
      // is still exactly the seed commit); the dirty in-scope file must
      // remain uncommitted, not folded into a commit.
      // `git status --porcelain` is allowed to collapse an untracked directory
      // to `?? src/` on Windows, so it cannot prove one exact untracked file
      // survived. Ask Git for the exact untracked path list instead.
      const untracked = git(['ls-files', '--others', '--exclude-standard'], root).split(/\r?\n/u).filter(Boolean);
      ok(existsSync(join(root, 'src', 'demo', 'change.txt')), 'the dirty in-scope change file must still exist after Research Gate rejection');
      ok(untracked.includes('src/demo/change.txt'), 'the dirty in-scope change must remain untracked/uncommitted, not silently checkpointed');
      assertNoMutation(root, { jobsRootShouldExist: true, expectedSubdirs: [prevJobId], expectedJobBranches: ['job/prevjob-task'] });
      assertInventoryUnchanged(before, captureInventory(root), 'Test D (changed continuation context)');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  }

  // --- Test E: evidence bound to a mismatched scope (different from the
  //     actual -ScopePaths passed to a brand-new job) rejects before any
  //     mutation ---
  {
    const root = makeRepo('claude-job-launcher-scope-mismatch-');
    const fixtures = externalFixtureDir('claude-job-launcher-scope-mismatch-fixtures-');
    try {
      const before = captureInventory(root);
      const prompt = promptFile(fixtures);
      const clarity = instructionClarityFile(fixtures, 'clarity.json');
      const evidence = minimalEvidence({
        taskId: 'placeholder', proposalId: 'proposal-scope-mismatch',
        // Evidence is bound to a DIFFERENT scope than -ScopePaths below.
        constraints: [],
      });
      evidence.evidenceBinding.scope = ['src/other/**'];
      const research = researchEnvelopeFile(fixtures, 'research.json', evidence, 'proposal-scope-mismatch');
      const result = runLauncher(root, [
        '-PromptFile', prompt, '-InstructionClarityFile', clarity, '-ResearchEvidenceFile', research,
        '-ScopePaths', 'src/demo/**', '-BaseRef', 'main',
      ]);
      ok(result.status !== 0, `scope-mismatched evidence must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /Research Gate did not clear/, 'scope mismatch surfaces the Research Gate rejection message');
      assertNoMutation(root);
      assertInventoryUnchanged(before, captureInventory(root), 'Test E (scope mismatch)');
      assertions += 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  }

  // --- Test F: evidence bound to a mismatched repository (different from
  //     the actual origin remote owner/name) rejects before any mutation ---
  {
    const root = makeRepo('claude-job-launcher-repo-mismatch-');
    const fixtures = externalFixtureDir('claude-job-launcher-repo-mismatch-fixtures-');
    try {
      const before = captureInventory(root);
      const prompt = promptFile(fixtures);
      const clarity = instructionClarityFile(fixtures, 'clarity.json');
      const evidence = minimalEvidence({
        taskId: 'placeholder', proposalId: 'proposal-repo-mismatch',
        constraints: [],
      });
      evidence.evidenceBinding.repository = { owner: 'different-owner', name: 'different-repo' };
      const research = researchEnvelopeFile(fixtures, 'research.json', evidence, 'proposal-repo-mismatch');
      const result = runLauncher(root, [
        '-PromptFile', prompt, '-InstructionClarityFile', clarity, '-ResearchEvidenceFile', research,
        '-ScopePaths', 'src/demo/**', '-BaseRef', 'main',
      ]);
      ok(result.status !== 0, `repository-mismatched evidence must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /Research Gate did not clear/, 'repository mismatch surfaces the Research Gate rejection message');
      assertNoMutation(root);
      assertInventoryUnchanged(before, captureInventory(root), 'Test F (repository mismatch)');
      assertions += 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  }

  console.log(`claude-job-launcher selftest: PASS (${assertions} assertions)`);
}
