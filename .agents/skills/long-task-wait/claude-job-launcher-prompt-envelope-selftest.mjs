#!/usr/bin/env node
// E2E regression for the launcher's bounded embedded-research-envelope
// fallback (run-claude-job.ps1): the real Issue->poller->launcher path loses
// evidence because scripts/ai-job-poller/poll-once.ps1 only ever passes
// -PromptFile to the launcher (no -InstructionClarityFile/-ResearchEvidenceFile).
// When those are absent, the EXISTING launcher must recover the exact
// evidence from the unique embedded AGENT_CYCLE_JOB_RESEARCH_V1 envelope
// inside PromptFile, via the existing agent-job-bridge.mjs parser -- and
// must still fail closed (malformed / duplicate / missing envelope, or a
// scope mismatch) BEFORE any worktree/branch/background-job/checkpoint
// mutation, exactly like an explicit-file rejection. This drives the REAL
// Windows PowerShell 5 launcher end to end (no mocked PowerShell, no real
// Claude/provider invocation, no GitHub/network access) against a temporary
// synthetic git repository seeded with the REAL preflight-audit/
// project-intake/handoff modules (and their real transitive imports) copied
// verbatim from this repository, so agent-job-bridge.mjs's own dependency
// closure actually resolves inside the synthetic repo. It intentionally
// never drives a VALID envelope all the way to claude-job-runner.ps1 (that
// would probe/invoke a real provider); the "reaches gates/launcher
// qualification without a real provider invocation" proof for a valid
// envelope lives in agent-job-bridge-selftest.mjs instead, using the exact
// same real gate functions with zero PowerShell/runner involvement.
// Windows-only; a no-op elsewhere.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeConstraintsDigest } from '../preflight-audit/research-gate.mjs';
import { prepareAiJobIssue } from '../preflight-audit/agent-job-bridge.mjs';
import { renderPollerIssueFromTask } from '../project-intake/project-intake-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const launcher = join(here, 'claude-job', 'run-claude-job.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_IDENTITY = { owner: 'example-owner', name: 'example-repo' };
const SCOPE = ['src/demo/**'];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git failed: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout.trim();
}
function runLauncher(root, args) {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-RepoPath', root, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
// Seeds the REAL preflight-audit/project-intake/handoff module trees
// (verbatim copies, not rewritten fixtures) so agent-job-bridge.mjs's own
// real imports (readBoundedTaskInput, renderPollerIssueFromTask,
// validateResearchEnvelopeShape, validateInstructionClarityInput, and their
// own transitive imports) actually resolve inside the synthetic repo, the
// same way they resolve inside the real repository the launcher normally
// runs against.
function makeRepoWithRealGates(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(['init', '-q', root]);
  git(['config', 'user.name', 'AI Test'], root);
  git(['config', 'user.email', 'ai-test@example.invalid'], root);
  git(['remote', 'add', 'origin', `https://github.com/${REPO_IDENTITY.owner}/${REPO_IDENTITY.name}.git`], root);
  writeFileSync(join(root, '.gitignore'), '.ai-jobs/\n');
  writeFileSync(join(root, 'README.md'), 'seed\n');
  for (const rel of ['preflight-audit', 'project-intake', 'handoff']) {
    const src = join(repoRoot, '.agents', 'skills', rel);
    const dest = join(root, '.agents', 'skills', rel);
    cpSync(src, dest, { recursive: true });
  }
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'seed'], root);
  git(['branch', '-M', 'main'], root);
  return root;
}
function promptFile(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function instructionClarityFor(taskId) {
  return {
    schemaVersion: 1,
    taskId,
    instructions: [{ id: 'instr-1', kind: 'INSTRUCTION', summary: 'Synthetic prompt-envelope regression instruction.' }],
    unlistedAssumptionsPresent: false,
    ambiguities: [],
  };
}
function researchFor(taskId, { scope = SCOPE, constraints = [] } = {}) {
  return {
    evidence: {
      schemaVersion: 1,
      evidenceBinding: {
        taskId, proposalId: 'proposal-1', repository: { ...REPO_IDENTITY }, scope, constraints,
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
      noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Synthetic prompt-envelope regression fixture.' },
      checklist: ['safety', 'dataPreservation', 'existingOverlap'].map((id) => ({
        id, status: 'PASS', applicable: true,
        justification: `${id} looks fine for this bounded synthetic fixture.`,
        primarySourceRef: 'https://example.invalid/evidence',
      })),
      humanTopConditions: [],
      deepResearch: null,
    },
    context: { proposalId: 'proposal-1', constraints, humanTopConditions: [] },
  };
}
function task(overrides = {}) {
  const taskId = overrides.taskId || 'job-task-1';
  const allowedScope = overrides.allowedScope || SCOPE;
  const researchScope = overrides.researchScope || allowedScope;
  return {
    schemaVersion: 1, taskId, kind: 'implementation',
    objective: 'Synthetic prompt-envelope regression task.',
    prompt: 'Edit only the allowed files.',
    repoRoot: 'C:\\repo', branch: 'feat/demo',
    allowedScope,
    forbiddenScope: ['.github/workflows/**'],
    doneConditions: ['Bridge works.'],
    requiredTests: ['node src/demo-selftest.mjs'],
    dataClass: 'source-only',
    repository: { ...REPO_IDENTITY },
    instructionClarity: instructionClarityFor(taskId),
    research: researchFor(taskId, { scope: researchScope }),
  };
}
function cycle(overrides = {}) {
  const orchestrationTask = task(overrides);
  return {
    schemaVersion: 1, result: 'HANDOFF', code: 'LONG_TASK_HANDOFF_REQUIRED',
    goalId: 'goal-1', currentNextStep: 'Run the long implementation task.',
    selected: {
      id: 'candidate-1', priority: 1, executionMode: 'LONG_TASK',
      taskId: orchestrationTask.taskId, expectedNextStep: 'Run the long implementation task.', onSuccessNextStep: null,
    },
    orchestrationTask,
    authority: { autoMerge: false, autoPush: false, newPaidRoute: false },
  };
}
function realPollerStylePromptBody(overrides = {}) {
  const prepared = prepareAiJobIssue(cycle(overrides), { renderTask: renderPollerIssueFromTask });
  assert.equal(prepared.result, 'PROCEED', `fixture setup: real bridge render must succeed: ${JSON.stringify(prepared)}`);
  return prepared.issue.body;
}

function listJobBranches(root) {
  const raw = git(['branch', '--list', 'job/*'], root);
  if (!raw) return [];
  return raw.split('\n').map((line) => line.replace(/^\*?\s*/, '').trim()).filter(Boolean).sort();
}
function captureInventory(root) {
  return {
    head: git(['rev-parse', 'HEAD'], root),
    branches: listJobBranches(root),
    worktrees: git(['worktree', 'list', '--porcelain'], root),
  };
}
function assertNoMutation(root, before) {
  const after = captureInventory(root);
  assert.equal(after.head, before.head, 'HEAD must not move');
  assert.deepEqual(after.branches, before.branches, 'job branches must not change');
  assert.equal(after.worktrees, before.worktrees, 'worktree list must not change');
  const jobsRoot = join(root, '.ai-jobs');
  if (existsSync(jobsRoot)) {
    const entries = readdirSync(jobsRoot);
    assert.deepEqual(entries, [], `no job directory/lock may be created on rejection; found: ${JSON.stringify(entries)}`);
  }
  const worktreesSibling = join(dirname(root), `${basename(root)}.ai-worktrees`);
  assert.equal(existsSync(worktreesSibling), false, 'no sibling .ai-worktrees directory may be created');
  const commitCount = git(['rev-list', '--count', 'HEAD'], root);
  assert.equal(commitCount, '1', 'no checkpoint/implementation commit may be created');
}

if (process.platform !== 'win32') {
  console.log('claude-job-launcher-prompt-envelope selftest: SKIPPED (non-Windows platform; run-claude-job.ps1 is Windows PowerShell only)');
} else {
  let assertions = 0;
  const wrap = (fn) => (...a) => { fn(...a); assertions += 1; };
  const ok = wrap(assert.ok);
  const match = wrap(assert.match);

  // --- Test A: missing embedded envelope (plain prompt, no marker at all) ---
  {
    const root = makeRepoWithRealGates('claude-job-launcher-envelope-missing-');
    try {
      const prompt = promptFile(root, 'prompt.md', 'Synthetic poller-delivered prompt with no embedded research envelope.\n');
      const before = captureInventory(root);
      const result = runLauncher(root, ['-PromptFile', prompt, '-ScopePaths', 'src/demo/**', '-BaseRef', 'main']);
      ok(result.status !== 0, `missing embedded envelope must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /no unique embedded research envelope was found in PromptFile/, 'missing-envelope rejection surfaces the embedded-envelope-fallback message');
      assertNoMutation(root, before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test B: duplicate embedded envelope markers ---
  {
    const root = makeRepoWithRealGates('claude-job-launcher-envelope-duplicate-');
    try {
      const body = realPollerStylePromptBody();
      const prompt = promptFile(root, 'prompt.md', `${body}\n${body}`);
      const before = captureInventory(root);
      const result = runLauncher(root, ['-PromptFile', prompt, '-ScopePaths', 'src/demo/**', '-BaseRef', 'main']);
      ok(result.status !== 0, `duplicate embedded envelope must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /no unique embedded research envelope was found in PromptFile/, 'duplicate-envelope rejection surfaces the embedded-envelope-fallback message');
      assertNoMutation(root, before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test C: malformed embedded envelope (valid marker syntax, undecodable payload) ---
  {
    const root = makeRepoWithRealGates('claude-job-launcher-envelope-malformed-');
    try {
      const prompt = promptFile(root, 'prompt.md', '<!-- AGENT_CYCLE_JOB_RESEARCH_V1 YWJjZGVmZ2g -->\n## 目的\nSynthetic malformed-envelope prompt.\n');
      const before = captureInventory(root);
      const result = runLauncher(root, ['-PromptFile', prompt, '-ScopePaths', 'src/demo/**', '-BaseRef', 'main']);
      ok(result.status !== 0, `malformed embedded envelope must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /no unique embedded research envelope was found in PromptFile/, 'malformed-envelope rejection surfaces the embedded-envelope-fallback message');
      assertNoMutation(root, before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // --- Test D: a VALID, unique embedded envelope whose bound scope does not
  //     match the actual -ScopePaths passed to the launcher must still STOP
  //     at the Research Gate (SCOPE_MISMATCH), before any mutation ---
  {
    const root = makeRepoWithRealGates('claude-job-launcher-envelope-scope-mismatch-');
    try {
      const body = realPollerStylePromptBody({ allowedScope: SCOPE, researchScope: ['src/other/**'] });
      const prompt = promptFile(root, 'prompt.md', body);
      const before = captureInventory(root);
      const result = runLauncher(root, ['-PromptFile', prompt, '-ScopePaths', 'src/demo/**', '-BaseRef', 'main']);
      ok(result.status !== 0, `scope-mismatched embedded envelope must reject the launcher: ${result.stdout}\n${result.stderr}`);
      match(result.stdout, /Research Gate did not clear/, 'scope-mismatched envelope is extracted successfully but still rejected by the real Research Gate');
      assertNoMutation(root, before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  console.log(`claude-job-launcher-prompt-envelope selftest: PASS (${assertions} assertions)`);
}
