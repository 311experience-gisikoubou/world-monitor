#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const orchestratorArg = process.argv[2];
if (!orchestratorArg) throw new Error('orchestrator path required');
const orchestratorPath = path.resolve(orchestratorArg);
const orchestratorDir = path.dirname(orchestratorPath);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'implementation-orchestrator-selftest-'));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function sha256File(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// --- Build a patched claude-subscription-runner + implementation-runner
// chain so a fake, non-Claude executable can stand in for Claude without
// weakening the real trust check the production code applies. This mirrors
// implementation-runner-selftest.mjs exactly; the orchestrator itself and
// ai-task-router/implementation-route-receipt are used UNPATCHED because
// they never touch the Claude binary directly.
const nodeHash = sha256File(process.execPath);
const trustedClaudeHash = '647E736F20C9FF0553C754624CBF8A6DCAC196E8595509D8F63DCE8BBE818757';
const inventoryUrl = pathToFileURL(path.join(orchestratorDir, 'ai-provider-inventory.mjs')).href;

let subscriptionSource = fs.readFileSync(path.join(orchestratorDir, 'claude-subscription-runner.mjs'), 'utf8');
if (!subscriptionSource.includes(trustedClaudeHash)) throw new Error('trusted Claude hash missing from subscription runner');
subscriptionSource = subscriptionSource
  .replace("from './ai-provider-inventory.mjs';", `from '${inventoryUrl}';`)
  .replace(trustedClaudeHash, nodeHash)
  .replace("return Boolean(desc) && typeof desc.file === 'string' && Array.isArray(desc.prefix) && desc.prefix.length === 0;", "return Boolean(desc) && typeof desc.file === 'string' && Array.isArray(desc.prefix);");
const patchedSubscriptionPath = path.join(tempRoot, 'claude-subscription-runner.mjs');
fs.writeFileSync(patchedSubscriptionPath, subscriptionSource, 'utf8');

let runnerSource = fs.readFileSync(path.join(orchestratorDir, 'implementation-runner.mjs'), 'utf8');
runnerSource = runnerSource
  .replace("from './ai-provider-inventory.mjs';", `from '${inventoryUrl}';`)
  .replace("from './claude-subscription-runner.mjs';", `from '${pathToFileURL(patchedSubscriptionPath).href}';`);
const patchedRunnerPath = path.join(tempRoot, 'implementation-runner.mjs');
fs.writeFileSync(patchedRunnerPath, runnerSource, 'utf8');
const patchedRunnerUrl = pathToFileURL(patchedRunnerPath).href;

const ai_task_router_url = pathToFileURL(path.join(orchestratorDir, 'ai-task-router.mjs')).href;
const receipt_url = pathToFileURL(path.join(orchestratorDir, 'implementation-route-receipt.mjs')).href;

let orchestratorSource = fs.readFileSync(orchestratorPath, 'utf8');
orchestratorSource = orchestratorSource
  .replace("from './ai-provider-inventory.mjs';", `from '${inventoryUrl}';`)
  .replace("from './ai-task-router.mjs';", `from '${ai_task_router_url}';`)
  .replace("from './implementation-route-receipt.mjs';", `from '${receipt_url}';`)
  .replace("from './implementation-runner.mjs';", `from '${patchedRunnerUrl}';`);
const patchedOrchestratorPath = path.join(tempRoot, 'implementation-orchestrator-under-test.mjs');
fs.writeFileSync(patchedOrchestratorPath, orchestratorSource, 'utf8');

const { runImplementationOrchestration, validateOrchestrationTask } = await import(pathToFileURL(patchedOrchestratorPath).href);
const { evaluateReceipt, verifyFinalReceipt } = await import(receipt_url);
const { readHeadSha, computeChangeSetSha256 } = await import(patchedRunnerUrl);

try {
  // --- real temp git repo, feature branch, GitHub-shaped origin (no network call is made or needed) ---
  const repoDir = path.join(tempRoot, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'test@example.invalid']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'init']);
  git(repoDir, ['branch', '-m', 'main']);
  git(repoDir, ['checkout', '-q', '-b', 'feat/widget']);

  // --- fake Claude CLI that really edits a harmless existing file and adds a new one ---
  const logPath = path.join(tempRoot, 'fake-log.jsonl');
  const fakeCli = path.join(tempRoot, 'fake-claude.mjs');
  const fakeSource = `
import fs from 'node:fs';
const mode = process.argv[2];
const args = process.argv.slice(3);
const logPath = ${JSON.stringify(logPath)};
function record(phase) { fs.appendFileSync(logPath, JSON.stringify({ phase, args, cwd: process.cwd() }) + '\\n'); }
if (args.join(' ') === 'auth status --json') { record('auth'); console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'pro', authMethod: 'claude.ai' })); process.exit(0); }
if (args.includes('--help')) {
  record('help');
  console.log('--safe-mode --tools <tools...> Use "" to disable all --strict-mcp-config --mcp-config <configs...> --no-session-persistence --disable-slash-commands --no-chrome --permission-mode <mode> --input-format <format> --output-format <format> -p, --print --setting-sources <sources> --settings <file-or-json> --model <model> --system-prompt <prompt> CLAUDE.md skills plugins hooks MCP servers disabled');
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  record('run');
  if (mode === 'fail') { console.error('boom'); process.exit(7); }
  if (mode === 'outofscope') {
    fs.writeFileSync('src/not-in-scope.ts', 'export const rogue = true;\\n', 'utf8');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Edited an out-of-scope file' }));
    return;
  }
  fs.writeFileSync('src/widget.ts', 'export const widget = 2;\\n', 'utf8');
  fs.writeFileSync('src/widget-helper.ts', 'export const helper = true;\\n', 'utf8');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Updated src/widget.ts and added src/widget-helper.ts' }));
});
`;
  fs.writeFileSync(fakeCli, fakeSource, 'utf8');
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|GCLOUD_|VERTEX_|AZURE_)/i.test(key)));
  const desc = (mode = 'ok') => ({ file: process.execPath, prefix: [fakeCli, mode] });

  const basePayload = {
    schemaVersion: 1,
    taskId: 'orch-1',
    kind: 'implementation',
    objective: 'Bump the widget constant.',
    prompt: 'Update src/widget.ts to change widget from 1 to 2, and add a helper file.',
    repoRoot: repoDir,
    branch: 'feat/widget',
    allowedScope: ['src/**'],
    dataClass: 'source-only',
    repository: { owner: 'acme', name: 'widgets' },
  };
  assert(validateOrchestrationTask(basePayload).length === 0, 'valid orchestration payload rejected');

  // --- golden path: route selection -> runner -> real edit (modified + new file) -> proof ---
  const routed = runImplementationOrchestration(basePayload, { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(routed.result === 'COMPLETED', `expected COMPLETED: ${JSON.stringify(routed)}`);
  assert(routed.routing.selectedExecutor.id === 'claude-implementation-write', 'must route to the Claude implementation-write executor');
  assert(!JSON.stringify(routed.routing).toLowerCase().includes('chatgpt'), 'orchestrator must never silently offer a direct-browser/chatgpt route');
  assert(routed.preImplementationReceipt.result === 'PROCEED', 'pre-implementation receipt must authorize before the runner ever ran');
  assert(routed.runner.result === 'COMPLETED', 'runner must have actually executed');
  assert(/^[0-9a-f]{40}$/.test(routed.executionEvidence.preHead), 'orchestrator must surface a real preHead');
  assert(/^[0-9A-F]{64}$/.test(routed.executionEvidence.changeSetSha256), 'orchestrator must surface a real change-set hash');
  assert(routed.executionEvidence.changedPaths.includes('src/widget.ts') && routed.executionEvidence.changedPaths.includes('src/widget-helper.ts'),
    'change-set evidence must cover both the modified tracked file and the new untracked file');
  assert(fs.readFileSync(path.join(repoDir, 'src', 'widget.ts'), 'utf8').includes('widget = 2'), 'fake Claude must really have edited the file on disk');
  assert(fs.existsSync(path.join(repoDir, 'src', 'widget-helper.ts')), 'fake Claude must really have created the new file on disk');

  // --- commit exactly what the runner produced, then prove the final receipt PASSes and verifies MERGE_READY ---
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'implement widget change']);
  const implementationHead = readHeadSha(repoDir);
  assert(implementationHead, 'expected a resolvable implementation head after commit');

  const finalReceiptInput = {
    schemaVersion: 1,
    stage: 'final',
    task: { id: basePayload.taskId, kind: basePayload.kind },
    executor: { id: 'claude-implementation-write', provider: 'claude', routeType: 'qualified-agent' },
    repository: basePayload.repository,
    branch: basePayload.branch,
    allowedScope: [...basePayload.allowedScope],
    dataClass: basePayload.dataClass,
    costPolicy: 'no-new-cost',
    requestedAuthorities: [],
    implementationHead,
    executionEvidence: routed.executionEvidence,
  };
  const finalDecision = evaluateReceipt(finalReceiptInput);
  assert(finalDecision.result === 'PASS', `final receipt must PASS: ${JSON.stringify(finalDecision)}`);
  const verified = verifyFinalReceipt(finalDecision, {
    owner: 'acme', name: 'widgets', branch: 'feat/widget', head: implementationHead, repoRoot: repoDir,
  });
  assert(verified.result === 'MERGE_READY', `expected MERGE_READY: ${JSON.stringify(verified)}`);

  // --- negative: tampered post-Claude commit/change set must not verify ---
  const tamperedVerified = verifyFinalReceipt(evaluateReceipt({
    ...finalReceiptInput,
    executionEvidence: { ...routed.executionEvidence, changeSetSha256: 'f'.repeat(64) },
  }), { owner: 'acme', name: 'widgets', branch: 'feat/widget', head: implementationHead, repoRoot: repoDir });
  assert(tamperedVerified.code === 'EXECUTION_EVIDENCE_CHANGE_SET_MISMATCH', `tampered change set must be rejected: ${JSON.stringify(tamperedVerified)}`);

  // --- negative: wrong branch/head at verification time ---
  const wrongBranch = verifyFinalReceipt(finalDecision, {
    owner: 'acme', name: 'widgets', branch: 'feat/other', head: implementationHead, repoRoot: repoDir,
  });
  assert(wrongBranch.code === 'BRANCH_MISMATCH', 'wrong branch must fail closed');
  const wrongHead = verifyFinalReceipt(finalDecision, {
    owner: 'acme', name: 'widgets', branch: 'feat/widget', head: 'f'.repeat(40), repoRoot: repoDir,
  });
  assert(wrongHead.code === 'HEAD_MISMATCH', 'wrong head must fail closed');

  // --- negative: direct ChatGPT/browser executor without exception must STOP, never a silent pass ---
  const directNoException = evaluateReceipt({
    ...finalReceiptInput,
    executor: { id: 'chatgpt-web', provider: 'chatgpt', routeType: 'direct-browser' },
    executionEvidence: undefined,
  });
  assert(directNoException.result === 'STOP' && directNoException.code === 'DIRECT_EXECUTOR_EXCEPTION_REQUIRED', 'unexplained direct-browser executor must STOP');

  // --- negative: unavailable executor (Claude CLI missing) must STOP, never silently substitute another route ---
  const unavailable = runImplementationOrchestration({ ...basePayload, taskId: 'orch-2' }, { desc: null, envSource: cleanEnv, timeoutMs: 5000 });
  assert(unavailable.result === 'STOP', 'missing Claude CLI must STOP the orchestration');
  assert(unavailable.routing?.result === 'STOP' && unavailable.routing?.code === 'NO_EXECUTOR_AVAILABLE', `expected NO_EXECUTOR_AVAILABLE routing: ${JSON.stringify(unavailable)}`);
  assert(unavailable.runner === null, 'the runner must never be invoked when no route was authorized');

  // --- negative: wrong repository identity (origin mismatch) must STOP before Claude is invoked ---
  const wrongIdentity = runImplementationOrchestration(
    { ...basePayload, taskId: 'orch-3', repository: { owner: 'someone-else', name: 'widgets' } },
    { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 },
  );
  assert(wrongIdentity.result === 'STOP' && wrongIdentity.code === 'REPOSITORY_IDENTITY_MISMATCH', `wrong repository identity must STOP: ${JSON.stringify(wrongIdentity)}`);

  // --- negative: pre-run dirty worktree must STOP before Claude is invoked ---
  fs.writeFileSync(path.join(repoDir, 'PRE_EXISTING_UNTRACKED.txt'), 'was already here\n', 'utf8');
  const dirtyStop = runImplementationOrchestration({ ...basePayload, taskId: 'orch-4' }, { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(dirtyStop.result === 'STOP' && dirtyStop.code === 'WORKTREE_NOT_CLEAN', `dirty worktree must STOP: ${JSON.stringify(dirtyStop)}`);
  fs.rmSync(path.join(repoDir, 'PRE_EXISTING_UNTRACKED.txt'));

  // --- negative: out-of-scope edit must STOP after Claude returns, before success is reported ---
  const outOfScope = runImplementationOrchestration(
    { ...basePayload, taskId: 'orch-5', allowedScope: ['src/widget.ts'] },
    { desc: desc('outofscope'), envSource: cleanEnv, timeoutMs: 5000 },
  );
  assert(outOfScope.result === 'STOP' && outOfScope.runner?.code === 'ALLOWED_SCOPE_VIOLATION', `out-of-scope edit must STOP: ${JSON.stringify(outOfScope)}`);
  fs.rmSync(path.join(repoDir, 'src', 'not-in-scope.ts'), { force: true });

  const records = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const runRecords = records.filter((r) => r.phase === 'run');
  assert(runRecords.length === 2, `fake Claude must run exactly for the golden path and the out-of-scope negative: ${runRecords.length}`);

  console.log('implementation-orchestrator selftest: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
