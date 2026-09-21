#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const runnerArg = process.argv[2];
if (!runnerArg) throw new Error('runner path required');
const runnerPath = path.resolve(runnerArg);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'implementation-runner-selftest-'));
function sha256File(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
const nodeHash = sha256File(process.execPath);
const trustedClaudeHash = '647E736F20C9FF0553C754624CBF8A6DCAC196E8595509D8F63DCE8BBE818757';

const runnerDir = path.dirname(runnerPath);
const subscriptionRunnerPath = path.join(runnerDir, 'claude-subscription-runner.mjs');
let subscriptionSource = fs.readFileSync(subscriptionRunnerPath, 'utf8');
if (!subscriptionSource.includes(trustedClaudeHash)) throw new Error('trusted Claude hash missing from subscription runner');
const inventoryUrl = pathToFileURL(path.join(runnerDir, 'ai-provider-inventory.mjs')).href;
subscriptionSource = subscriptionSource
  .replace("from './ai-provider-inventory.mjs';", `from '${inventoryUrl}';`)
  .replace(trustedClaudeHash, nodeHash)
  .replace("return Boolean(desc) && typeof desc.file === 'string' && Array.isArray(desc.prefix) && desc.prefix.length === 0;", "return Boolean(desc) && typeof desc.file === 'string' && Array.isArray(desc.prefix);");
const testSubscriptionPath = path.join(tempRoot, 'claude-subscription-runner.mjs');
fs.writeFileSync(testSubscriptionPath, subscriptionSource, 'utf8');

let implSource = fs.readFileSync(runnerPath, 'utf8');
implSource = implSource
  .replace("from './ai-provider-inventory.mjs';", `from '${inventoryUrl}';`)
  .replace("from './claude-subscription-runner.mjs';", `from '${pathToFileURL(testSubscriptionPath).href}';`);
const testImplPath = path.join(tempRoot, 'implementation-runner-under-test.mjs');
fs.writeFileSync(testImplPath, implSource, 'utf8');

const {
  validateImplementationTask, runClaudeImplementationTask, implementationRunnerEvidence,
  readBoundedTaskInput, verifyFeatureRepository, verifyWorktreeClean, verifyRepositoryIdentity,
  readHeadSha, computeChangeSetSha256, validScopePattern, changedPathsWithinScope,
} = await import(pathToFileURL(testImplPath).href);

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

async function expectCode(promise, code) {
  try { await promise; } catch (error) { assert(error?.code === code, `expected ${code}, got ${error?.code}`); return; }
  throw new Error(`expected rejection ${code}`);
}

try {
  // --- schema validation ---
  const basePayload = {
    schemaVersion: 1, taskId: 'impl-1', capability: 'implementation', dataClass: 'source-only',
    prompt: 'Fix the bug in source only.', repoRoot: tempRoot, branch: 'feat/example',
    allowedScope: ['README.md', 'src/**'], repository: { owner: 'acme', name: 'widgets' },
  };
  assert(validateImplementationTask(basePayload).length === 0, 'valid payload rejected');
  assert(validateImplementationTask({ ...basePayload, extra: 1 }).includes('unknown_field'), 'unknown field must stop');
  assert(validateImplementationTask({ ...basePayload, dataClass: 'protected' }).includes('dataClass_invalid'), 'protected data must stop');
  assert(validateImplementationTask({ ...basePayload, branch: 'main' }).length === 0, 'branch schema does not itself reject protected names (repo check does)');
  assert(validateImplementationTask({ ...basePayload, branch: '../evil' }).includes('branch_invalid'), 'unsafe branch token must stop');
  assert(validateImplementationTask({ ...basePayload, allowedScope: [] }).includes('allowedScope_invalid'), 'empty allowedScope must stop');
  assert(validateImplementationTask({ ...basePayload, repository: { owner: 'acme' } }).includes('repository_invalid'), 'incomplete repository must stop');

  // --- scope pattern validation: exact paths and one trailing '/**' form only ---
  assert(validScopePattern('src/widget.ts') === true, 'exact path must be a valid scope pattern');
  assert(validScopePattern('src/**') === true, 'directory-prefix scope pattern must be valid');
  assert(validScopePattern('src/*.ts') === false, 'unsupported mid-pattern wildcard must be rejected');
  assert(validScopePattern('**/*.ts') === false, 'unsupported leading wildcard must be rejected');
  assert(validScopePattern('../escape') === false, 'path traversal must be rejected');
  assert(validateImplementationTask({ ...basePayload, allowedScope: ['src/*.ts'] }).includes('allowedScope_invalid'), 'unsupported wildcard must fail task validation, not silent glob interpretation');
  assert(changedPathsWithinScope(['src/widget.ts', 'src/nested/widget.ts'], ['src/**']) === true, 'directory-prefix scope must cover nested paths');
  assert(changedPathsWithinScope(['other/widget.ts'], ['src/**']) === false, 'out-of-scope path must not match');

  const bounded = await readBoundedTaskInput((await import('node:stream')).Readable.from(['abc']), { maxBytes: 10, timeoutMs: 100 });
  assert(bounded === 'abc', 'bounded input must read valid stream');
  await expectCode(readBoundedTaskInput((await import('node:stream')).Readable.from(['x'.repeat(20)]), { maxBytes: 10, timeoutMs: 100 }), 'INPUT_TOO_LARGE');

  // --- repository verification with a real temporary git repo ---
  const repoDir = path.join(tempRoot, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'test@example.invalid']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'init']);
  git(repoDir, ['branch', '-m', 'main']);
  git(repoDir, ['checkout', '-q', '-b', 'feat/example']);
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);

  const okRepo = verifyFeatureRepository(repoDir, 'feat/example');
  assert(okRepo.ok === true, `expected repo verification pass: ${JSON.stringify(okRepo)}`);

  const wrongBranch = verifyFeatureRepository(repoDir, 'feat/other');
  assert(wrongBranch.ok === false && wrongBranch.code === 'BRANCH_MISMATCH', 'wrong branch must fail closed');

  const protectedBranchCheck = verifyFeatureRepository(repoDir, 'main');
  assert(protectedBranchCheck.ok === false && protectedBranchCheck.code === 'PROTECTED_BRANCH_REJECTED', 'main branch must be rejected');

  const notGitDir = path.join(tempRoot, 'not-a-repo');
  fs.mkdirSync(notGitDir, { recursive: true });
  const notGitCheck = verifyFeatureRepository(notGitDir, 'feat/example');
  assert(notGitCheck.ok === false && notGitCheck.code === 'REPO_NOT_GIT_WORK_TREE', 'non-git directory must fail closed');

  const missingRepoCheck = verifyFeatureRepository(path.join(tempRoot, 'does-not-exist'), 'feat/example');
  assert(missingRepoCheck.ok === false && missingRepoCheck.code === 'REPO_ROOT_NOT_FOUND', 'missing repo root must fail closed');

  git(repoDir, ['checkout', '-q', '-b', 'feat/mid-merge']);
  fs.mkdirSync(path.join(repoDir, '.git', 'rebase-merge'), { recursive: true });
  const inProgressCheck = verifyFeatureRepository(repoDir, 'feat/mid-merge');
  assert(inProgressCheck.ok === false && inProgressCheck.code === 'REPO_STATE_UNSAFE_IN_PROGRESS_OPERATION', 'in-progress rebase must fail closed');
  fs.rmSync(path.join(repoDir, '.git', 'rebase-merge'), { recursive: true, force: true });
  git(repoDir, ['checkout', '-q', 'feat/example']);
  git(repoDir, ['branch', '-D', 'feat/mid-merge']);

  // --- worktree-clean and repository-identity checks ---
  const cleanNow = verifyWorktreeClean(repoDir);
  assert(cleanNow.ok === true, `expected clean worktree: ${JSON.stringify(cleanNow)}`);
  fs.writeFileSync(path.join(repoDir, 'UNTRACKED_BEFORE_RUN.txt'), 'pre-existing untracked file\n', 'utf8');
  const dirtyNow = verifyWorktreeClean(repoDir);
  assert(dirtyNow.ok === false && dirtyNow.code === 'WORKTREE_NOT_CLEAN', 'a pre-existing untracked file must be detected as dirty');
  fs.rmSync(path.join(repoDir, 'UNTRACKED_BEFORE_RUN.txt'));
  assert(verifyWorktreeClean(repoDir).ok === true, 'worktree must be clean again after removing the stray file');

  const identityOk = verifyRepositoryIdentity(repoDir, 'acme', 'widgets');
  assert(identityOk.ok === true, `expected repository identity match: ${JSON.stringify(identityOk)}`);
  const identityCaseInsensitive = verifyRepositoryIdentity(repoDir, 'ACME', 'WIDGETS');
  assert(identityCaseInsensitive.ok === true, 'GitHub owner/repo comparison must be case-insensitive');
  const identityWrong = verifyRepositoryIdentity(repoDir, 'someone-else', 'widgets');
  assert(identityWrong.ok === false && identityWrong.code === 'REPOSITORY_IDENTITY_MISMATCH', 'wrong owner must fail closed');

  const sshRepoDir = path.join(tempRoot, 'ssh-repo');
  fs.mkdirSync(sshRepoDir, { recursive: true });
  git(sshRepoDir, ['init', '-q']);
  git(sshRepoDir, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  const identitySsh = verifyRepositoryIdentity(sshRepoDir, 'acme', 'widgets');
  assert(identitySsh.ok === true, `expected scp-style SSH origin to be recognized: ${JSON.stringify(identitySsh)}`);

  const nonGithubRepoDir = path.join(tempRoot, 'non-github-repo');
  fs.mkdirSync(nonGithubRepoDir, { recursive: true });
  git(nonGithubRepoDir, ['init', '-q']);
  git(nonGithubRepoDir, ['remote', 'add', 'origin', 'https://example.invalid/acme/widgets.git']);
  const identityNonGithub = verifyRepositoryIdentity(nonGithubRepoDir, 'acme', 'widgets');
  assert(identityNonGithub.ok === false && identityNonGithub.code === 'ORIGIN_REMOTE_NOT_GITHUB_SHAPED', 'a non-GitHub-shaped origin must fail closed rather than being loosely parsed');

  // --- fake CLI end-to-end run against the real repo: modifies an existing file AND creates a new one ---
  const logPath = path.join(tempRoot, 'fake-log.jsonl');
  const fakeCli = path.join(tempRoot, 'fake-claude.mjs');
  const logLiteral = JSON.stringify(logPath);
  const fakeSource = `
import fs from 'node:fs';
const mode = process.argv[2];
const args = process.argv.slice(3);
const logPath = ${logLiteral};
function forbiddenEnv() {
  return Object.keys(process.env).filter((key) => /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|GCLOUD_|VERTEX_|AZURE_)/i.test(key) && key.toUpperCase() !== 'CLAUDE_CODE_SAFE_MODE');
}
function record(phase, input = '') {
  fs.appendFileSync(logPath, JSON.stringify({ phase, args, cwd: process.cwd(), input, forbiddenEnv: forbiddenEnv() }) + '\\n');
}
if (args.join(' ') === 'auth status --json') {
  record('auth');
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'pro', authMethod: 'claude.ai' })); process.exit(0);
}
if (args.includes('--help')) {
  record('help');
  const helpText = '--safe-mode --tools <tools...> Use "" to disable all --strict-mcp-config --mcp-config <configs...> --no-session-persistence --disable-slash-commands --no-chrome --permission-mode <mode> --input-format <format> --output-format <format> -p, --print --setting-sources <sources> --settings <file-or-json> --model <model> --system-prompt <prompt> CLAUDE.md skills plugins hooks MCP servers disabled';
  console.log(helpText); process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  record('run', input);
  if (mode === 'fail') { console.error('SECRET_STDERR_SHOULD_NOT_LEAK'); process.exit(7); }
  if (mode === 'outofscope') {
    fs.writeFileSync('OUT_OF_SCOPE.txt', 'not allowed\\n', 'utf8');
    console.log(JSON.stringify({ type:'result', subtype:'success', is_error:false, result:'Edited an out-of-scope file' }));
    return;
  }
  if (forbiddenEnv().length) process.exit(9);
  // Really edits an existing tracked file AND creates a brand-new untracked
  // file, so the resulting change-set evidence must cover both a modified
  // path and a genuinely new path, not just a textual diff of tracked files.
  fs.writeFileSync('README.md', 'hello, edited\\n', 'utf8');
  fs.writeFileSync('IMPL_TOUCHED.txt', 'implemented\\n', 'utf8');
  console.log(JSON.stringify({ type:'result', subtype:'success', is_error:false, result:'Edited README.md and added IMPL_TOUCHED.txt' }));
});
`;
  fs.writeFileSync(fakeCli, fakeSource, 'utf8');
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|GCLOUD_|VERTEX_|AZURE_)/i.test(key)));
  const desc = (mode = 'ok') => ({ file: process.execPath, prefix: [fakeCli, mode] });

  const implPayload = {
    schemaVersion: 1, taskId: 'impl-1', capability: 'implementation', dataClass: 'source-only',
    prompt: 'Fix the bug in source only.', repoRoot: repoDir, branch: 'feat/example',
    allowedScope: ['README.md', 'IMPL_TOUCHED.txt'], repository: { owner: 'acme', name: 'widgets' },
  };

  const ok = runClaudeImplementationTask(implPayload, { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(ok.result === 'COMPLETED', JSON.stringify(ok));
  assert(ok.output === 'Edited README.md and added IMPL_TOUCHED.txt', JSON.stringify(ok));
  assert(ok.evidence.toolBoundary === 'SOURCE_EDIT_ONLY_ENFORCED', 'tool evidence not closed');
  assert(ok.evidence.repositoryBoundary === 'FEATURE_BRANCH_ONLY_VERIFIED', 'repository evidence not closed');
  assert(ok.evidence.incrementalCostBoundary === 'INCLUDED_ONLY_ENFORCED', 'cost evidence not closed');

  // --- execution evidence: change-set bound to the actual modified + new files the fake Claude produced ---
  const preHeadBeforeRun = readHeadSha(repoDir);
  assert(/^[0-9a-f]{40}$/.test(ok.executionEvidence?.preHead || ''), 'preHead must be a real 40-char sha');
  assert(ok.executionEvidence.preHead === preHeadBeforeRun, 'preHead must equal HEAD at task start (nothing committed yet)');
  assert(/^[0-9A-F]{64}$/.test(ok.executionEvidence?.changeSetSha256 || ''), 'changeSetSha256 must be a 64-char hex digest');
  assert(Array.isArray(ok.executionEvidence.changedPaths) &&
    ok.executionEvidence.changedPaths.includes('README.md') && ok.executionEvidence.changedPaths.includes('IMPL_TOUCHED.txt'),
    'changedPaths must include both the modified tracked file and the new untracked file');
  assert(fs.existsSync(path.join(repoDir, 'IMPL_TOUCHED.txt')), 'fake Claude must really write a new file, not just claim success');
  assert(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8') === 'hello, edited\n', 'fake Claude must really modify the existing tracked file');
  const recomputedWorkingTree = computeChangeSetSha256(repoDir, ok.executionEvidence.preHead);
  assert(recomputedWorkingTree.changeSetSha256 === ok.executionEvidence.changeSetSha256, 'recomputed working-tree change set must match reported evidence');

  // Simulate a commit that faithfully records the exact change set Claude
  // produced, then prove the two-ref recompute (used by final-receipt
  // verification) reproduces the identical hash, including the new file.
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'implementation']);
  const implementationHead = readHeadSha(repoDir);
  const committedChangeSet = computeChangeSetSha256(repoDir, ok.executionEvidence.preHead, implementationHead);
  assert(committedChangeSet.changeSetSha256 === ok.executionEvidence.changeSetSha256, 'committed change set must hash identically to the pre-commit runner evidence');

  // A tampered/mismatched commit (different content than what Claude
  // produced) must not reproduce the original hash, proving the check
  // actually detects substitution rather than always passing.
  fs.writeFileSync(path.join(repoDir, 'IMPL_TOUCHED.txt'), 'not what claude wrote\n', 'utf8');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'tampered']);
  const tamperedHead = readHeadSha(repoDir);
  const tamperedChangeSet = computeChangeSetSha256(repoDir, ok.executionEvidence.preHead, tamperedHead);
  assert(tamperedChangeSet.changeSetSha256 !== ok.executionEvidence.changeSetSha256, 'tampered commit must not match the original runner evidence hash');

  // An untracked file added after Claude ran but committed together with
  // Claude's real changes must also change the hash: proves the fix for the
  // original bug (untracked files invisible to a textual diff hash).
  fs.writeFileSync(path.join(repoDir, 'IMPL_TOUCHED.txt'), 'implemented\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'SNEAKED_IN.txt'), 'not produced by claude\n', 'utf8');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'sneaked extra file']);
  const sneakedHead = readHeadSha(repoDir);
  const sneakedChangeSet = computeChangeSetSha256(repoDir, ok.executionEvidence.preHead, sneakedHead);
  assert(sneakedChangeSet.changeSetSha256 !== ok.executionEvidence.changeSetSha256, 'an extra committed untracked file must change the change-set hash');

  const records = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const runRecord = records.find((r) => r.phase === 'run');
  assert(runRecord, 'expected a run record');
  assert(path.resolve(runRecord.cwd) === path.resolve(repoDir), 'implementation run must execute with cwd=repoRoot for real edits');
  assert(runRecord.args.includes('--tools') && runRecord.args.includes('Read,Write,Edit,Glob,Grep'), 'bounded source-only tool set expected');
  assert(!runRecord.args.includes('Bash'), 'Bash must never be included in the tool boundary');
  assert(!runRecord.args.join(' ').includes('dangerously-skip-permissions') && !runRecord.args.join(' ').includes('bypassPermissions'), 'no permission-bypass flags allowed');
  assert(runRecord.forbiddenEnv.length === 0, 'provider/cloud env must not reach the child process');

  // --- rejection paths ---
  const wrongBranchStop = runClaudeImplementationTask({ ...implPayload, branch: 'feat/other' }, { desc: desc(), envSource: cleanEnv });
  assert(wrongBranchStop.code === 'BRANCH_MISMATCH', 'branch mismatch must stop before invoking Claude');
  const protectedStop = runClaudeImplementationTask({ ...implPayload, branch: 'main' }, { desc: desc(), envSource: cleanEnv });
  assert(protectedStop.code === 'PROTECTED_BRANCH_REJECTED', 'main branch must stop before invoking Claude');
  const notRepoStop = runClaudeImplementationTask({ ...implPayload, repoRoot: notGitDir }, { desc: desc(), envSource: cleanEnv });
  assert(notRepoStop.code === 'REPO_NOT_GIT_WORK_TREE', 'non-git repoRoot must stop before invoking Claude');

  const wrongRepoIdentityStop = runClaudeImplementationTask({ ...implPayload, repository: { owner: 'not-acme', name: 'widgets' } }, { desc: desc(), envSource: cleanEnv });
  assert(wrongRepoIdentityStop.code === 'REPOSITORY_IDENTITY_MISMATCH', 'wrong repository identity must stop before invoking Claude');

  const baselineCount = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  for (const [key, value] of [['ANTHROPIC_API_KEY', 'SECRET'], ['AWS_ACCESS_KEY_ID', 'SECRET']]) {
    const unsafe = runClaudeImplementationTask(implPayload, { desc: desc(), envSource: { ...cleanEnv, [key]: value } });
    assert(unsafe.code === 'UNSAFE_PROVIDER_ENV_PRESENT', `${key} must fail before provider invocation`);
  }
  const afterUnsafeCount = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  assert(afterUnsafeCount === baselineCount, 'unsafe env rejection must not invoke Claude');

  // --- dirty-worktree STOP: a pre-existing untracked file must block invocation before Claude ever runs ---
  const dirtyRunCountBefore = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  fs.writeFileSync(path.join(repoDir, 'PRE_EXISTING_UNTRACKED.txt'), 'was already here\n', 'utf8');
  const dirtyWorktreeStop = runClaudeImplementationTask(implPayload, { desc: desc(), envSource: cleanEnv });
  assert(dirtyWorktreeStop.result === 'STOP' && dirtyWorktreeStop.code === 'WORKTREE_NOT_CLEAN', `dirty worktree must stop before Claude runs: ${JSON.stringify(dirtyWorktreeStop)}`);
  const dirtyRunCountAfter = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  assert(dirtyRunCountAfter === dirtyRunCountBefore, 'dirty-worktree rejection must never invoke Claude');
  fs.rmSync(path.join(repoDir, 'PRE_EXISTING_UNTRACKED.txt'));
  assert(verifyWorktreeClean(repoDir).ok === true, 'worktree must be clean again for the remaining tests');

  const failed = runClaudeImplementationTask(implPayload, { desc: desc('fail'), envSource: cleanEnv, timeoutMs: 5000 });
  assert(failed.code === 'PROVIDER_STOPPED' && !JSON.stringify(failed).includes('SECRET_STDERR_SHOULD_NOT_LEAK'), 'stderr must not leak');
  assert(verifyWorktreeClean(repoDir).ok === true, 'worktree must be clean again before the scope-violation test');

  // --- out-of-scope edit STOP: enforced after Claude returns, before COMPLETED is reported ---
  const outOfScopeStop = runClaudeImplementationTask(implPayload, { desc: desc('outofscope'), envSource: cleanEnv, timeoutMs: 5000 });
  assert(outOfScopeStop.result === 'STOP' && outOfScopeStop.code === 'ALLOWED_SCOPE_VIOLATION', `out-of-scope edit must stop: ${JSON.stringify(outOfScopeStop)}`);
  assert(Array.isArray(outOfScopeStop.changedPaths) && outOfScopeStop.changedPaths.includes('OUT_OF_SCOPE.txt'), 'scope-violation evidence must record which paths changed for deterministic cleanup');
  fs.rmSync(path.join(repoDir, 'OUT_OF_SCOPE.txt'));
  assert(verifyWorktreeClean(repoDir).ok === true, 'worktree must be clean again after manual cleanup of the out-of-scope test');

  const noAuth = implementationRunnerEvidence({});
  assert(noAuth.authentication === 'UNKNOWN' && noAuth.toolBoundary === 'UNKNOWN', 'unproven evidence must stay UNKNOWN');

  console.log('implementation-runner selftest: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
