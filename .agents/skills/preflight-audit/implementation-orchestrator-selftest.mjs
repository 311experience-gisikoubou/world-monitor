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
const researchGateUrl = pathToFileURL(path.join(orchestratorDir, 'research-gate.mjs')).href;

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
  .replace("from './claude-subscription-runner.mjs';", `from '${pathToFileURL(patchedSubscriptionPath).href}';`)
  .replace("from './research-gate.mjs';", `from '${researchGateUrl}';`);
const patchedRunnerPath = path.join(tempRoot, 'implementation-runner.mjs');
fs.writeFileSync(patchedRunnerPath, runnerSource, 'utf8');
const patchedRunnerUrl = pathToFileURL(patchedRunnerPath).href;

const ai_task_router_url = pathToFileURL(path.join(orchestratorDir, 'ai-task-router.mjs')).href;
const receipt_url = pathToFileURL(path.join(orchestratorDir, 'implementation-route-receipt.mjs')).href;
const clarity_url = pathToFileURL(path.join(orchestratorDir, 'instruction-clarity-gate.mjs')).href;

let orchestratorSource = fs.readFileSync(orchestratorPath, 'utf8');
orchestratorSource = orchestratorSource
  .replace("from './ai-provider-inventory.mjs';", `from '${inventoryUrl}';`)
  .replace("from './ai-task-router.mjs';", `from '${ai_task_router_url}';`)
  .replace("from './implementation-route-receipt.mjs';", `from '${receipt_url}';`)
  .replace("from './instruction-clarity-gate.mjs';", `from '${clarity_url}';`)
  .replace("from './research-gate.mjs';", `from '${researchGateUrl}';`)
  .replace("from './implementation-runner.mjs';", `from '${patchedRunnerUrl}';`);
const patchedOrchestratorPath = path.join(tempRoot, 'implementation-orchestrator-under-test.mjs');
fs.writeFileSync(patchedOrchestratorPath, orchestratorSource, 'utf8');

const { runImplementationOrchestration, validateOrchestrationTask } = await import(pathToFileURL(patchedOrchestratorPath).href);
const { evaluateReceipt, verifyFinalReceipt } = await import(receipt_url);
const { readHeadSha, computeChangeSetSha256 } = await import(patchedRunnerUrl);
const { computeConstraintsDigest, CHECKLIST_IDS, TRIGGER_KEYS, BOUNDED_SYNTHETIC_TRIAL_WRITE_MODE } = await import(researchGateUrl);

function minimalPassChecklist() {
  return ['safety', 'dataPreservation', 'existingOverlap'].map((id) => ({
    id, status: 'PASS', applicable: true,
    justification: `${id} looks fine for this bounded fixture edit.`,
    primarySourceRef: 'https://example.invalid/evidence',
  }));
}
// A minimal, honest BYPASS_LIGHT-shaped research envelope. The orchestrator
// (before any provider probe), the raw runner (before invoking Claude), and
// the route receipt (pre AND final) all independently re-evaluate this raw
// evidence from scratch; none of them trust a caller-asserted result.
function researchFor(taskId, overrides = {}) {
  const repository = overrides.repository || { owner: 'acme', name: 'widgets' };
  const scope = overrides.scope || ['src/**'];
  const constraints = overrides.constraints || [];
  const checklist = overrides.checklist || minimalPassChecklist();
  return {
    evidence: {
      schemaVersion: 1,
      evidenceBinding: {
        taskId, proposalId: 'proposal-1', repository, scope, constraints,
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
      noTriggerAssessment: { reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL', justification: 'Bounded local source edit fixture for orchestrator selftest.' },
      checklist,
      humanTopConditions: [],
      deepResearch: null,
    },
    context: { proposalId: 'proposal-1', constraints, humanTopConditions: [] },
  };
}
function trialResearchFor(taskId, overrides = {}) {
  const repository = overrides.repository || { owner: 'acme', name: 'widgets' };
  const scope = overrides.scope || ['src/**'];
  const constraints = overrides.constraints || [];
  return {
    evidence: {
      schemaVersion: 1,
      evidenceBinding: { taskId, proposalId: 'proposal-1', repository, scope, constraints, constraintsDigestSha256: computeConstraintsDigest(constraints), assessedAtUtcMs: Date.now(), maxEvidenceAgeMs: 24 * 60 * 60 * 1000 },
      triggers: Object.fromEntries(TRIGGER_KEYS.map((key) => [key, key === 'osBrowserCompatibility'])),
      noTriggerAssessment: null,
      checklist: CHECKLIST_IDS.map((id) => ({ id, status: id === 'browserCompatibility' ? 'UNKNOWN' : 'PASS', applicable: true, justification: `Trial evidence for ${id}.`, ...(id === 'browserCompatibility' ? {} : { primarySourceRef: 'https://example.invalid/evidence' }) })),
      humanTopConditions: [],
      deepResearch: { primary: { providerId: 'provider-a', researchSessionRef: 'research-session://primary/a', evidenceRef: 'research-note://primary' }, adversarial: { present: true, providerId: 'provider-b', researchSessionRef: 'research-session://adversarial/b', distinctFromPrimary: true, evidenceRef: 'research-note://adversarial' } },
    },
    context: { proposalId: 'proposal-1', constraints, humanTopConditions: [] },
  };
}

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
  if (mode === 'forbidden') {
    fs.writeFileSync('src/widget.ts', 'export const widget = 999;\\n', 'utf8');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Edited a protected file' }));
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
    instructionClarity: {
      schemaVersion: 1,
      taskId: 'orch-1',
      instructions: [{ id: 'human-1', kind: 'INSTRUCTION', summary: 'Update the bounded widget implementation.' }],
      unlistedAssumptionsPresent: false,
      ambiguities: [],
    },
    research: researchFor('orch-1'),
  };
  const payloadWithTaskId = (taskId, extra = {}) => ({
    ...basePayload,
    ...extra,
    taskId,
    instructionClarity: {
      ...basePayload.instructionClarity,
      ...(extra.instructionClarity || {}),
      taskId,
    },
    research: extra.research || researchFor(taskId, {
      repository: extra.repository || basePayload.repository,
      scope: extra.allowedScope || basePayload.allowedScope,
    }),
  });
  assert(validateOrchestrationTask(basePayload).length === 0, 'valid orchestration payload rejected');
  assert(validateOrchestrationTask({ ...basePayload, forbiddenScope: ['src/protected-reference.ts'] }).length === 0, 'valid forbiddenScope must be accepted');
  assert(validateOrchestrationTask({ ...basePayload, forbiddenScope: ['src/*.ts'] }).includes('forbiddenScope_invalid'), 'unsupported forbiddenScope wildcard must fail closed');
  assert(validateOrchestrationTask({ ...basePayload, dataClass: 'synthetic', trialWriteMode: BOUNDED_SYNTHETIC_TRIAL_WRITE_MODE, research: trialResearchFor('orch-1') }).length === 0,
    'exact bounded synthetic trial mode must be accepted by the orchestrator schema');
  assert(validateOrchestrationTask({ ...basePayload, trialWriteMode: 'UNBOUNDED' }).includes('trialWriteMode_invalid'),
    'unknown trial mode must be rejected by the orchestrator schema');

  // --- clarity negatives: material ambiguity / hidden assumption stop before Claude invocation ---
  const materialStop = runImplementationOrchestration({
    ...basePayload,
    taskId: 'orch-material',
    instructionClarity: {
      ...basePayload.instructionClarity,
      taskId: 'orch-material',
      ambiguities: [{
        id: 'visual-choice',
        summary: 'Two interpretations visibly change the requested result.',
        category: 'user-visible-design-behavior',
        materiality: 'MATERIAL',
        classificationReason: 'The choice changes user-visible behavior and requires human intent.',
        decisionOwner: 'HUMAN',
        resolution: 'UNRESOLVED',
      }],
    },
  }, { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(materialStop.result === 'STOP' && materialStop.code === 'INSTRUCTION_CLARITY_NOT_CONFIRMED',
    `material ambiguity must STOP: ${JSON.stringify(materialStop)}`);

  const hiddenStop = runImplementationOrchestration({
    ...basePayload,
    taskId: 'orch-hidden',
    instructionClarity: {
      ...basePayload.instructionClarity,
      taskId: 'orch-hidden',
      unlistedAssumptionsPresent: true,
    },
  }, { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(hiddenStop.result === 'STOP' && hiddenStop.code === 'INSTRUCTION_CLARITY_NOT_CONFIRMED',
    `hidden assumption must STOP: ${JSON.stringify(hiddenStop)}`);
  assert(!fs.existsSync(logPath), 'clarity STOPs must happen before the Claude probe/runner is invoked');

  // --- Research Gate: a raw checklist FAIL must block BEFORE any provider probe/invocation ---
  const researchFailStop = runImplementationOrchestration(
    payloadWithTaskId('orch-research-fail', {
      research: researchFor('orch-research-fail', { checklist: [
        { id: 'safety', status: 'FAIL', applicable: true, justification: 'A real safety concern exists.', primarySourceRef: 'https://example.invalid/evidence' },
        { id: 'dataPreservation', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
        { id: 'existingOverlap', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
      ] }),
    }),
    { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 },
  );
  assert(researchFailStop.result === 'STOP' && researchFailStop.code === 'RESEARCH_GATE_BLOCKED',
    `a raw research-gate FAIL must STOP before the Claude probe is ever invoked: ${JSON.stringify(researchFailStop)}`);
  assert(!fs.existsSync(logPath), 'a research-gate block must never invoke the Claude probe/runner');

  const trialNoModeStop = runImplementationOrchestration(payloadWithTaskId('orch-trial-no-mode', {
    dataClass: 'synthetic', research: trialResearchFor('orch-trial-no-mode'),
  }), { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(trialNoModeStop.code === 'RESEARCH_GATE_BLOCKED', 'TRIAL_REQUIRED without mode must block before probe');
  const trialPublicStop = runImplementationOrchestration(payloadWithTaskId('orch-trial-public', {
    dataClass: 'public', trialWriteMode: BOUNDED_SYNTHETIC_TRIAL_WRITE_MODE, research: trialResearchFor('orch-trial-public'),
  }), { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(trialPublicStop.code === 'RESEARCH_GATE_BLOCKED', 'trial mode with public data must block before probe');

  // Omitting the research envelope entirely must fail schema-closed, never silently bypass the orchestrator.
  const { research: _omittedResearch, ...payloadWithoutResearch } = payloadWithTaskId('orch-research-missing');
  const researchMissingStop = runImplementationOrchestration(payloadWithoutResearch, { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(researchMissingStop.result === 'STOP' && researchMissingStop.code === 'TASK_SCHEMA_INVALID',
    `an omitted research envelope must fail schema-closed: ${JSON.stringify(researchMissingStop)}`);
  assert(!fs.existsSync(logPath), 'a schema-invalid task must never invoke the Claude probe/runner');

  // A caller cannot assert its own 'ADOPT' on the raw evidence: the schema has no such field, so it is rejected
  // by the independent re-evaluation and blocks rather than silently passing through (direct/bare-result bypass).
  const bareResultEvidence = researchFor('orch-research-bare-result');
  const researchBareResultStop = runImplementationOrchestration(
    payloadWithTaskId('orch-research-bare-result', {
      research: { evidence: { ...bareResultEvidence.evidence, result: 'ADOPT' }, context: bareResultEvidence.context },
    }),
    { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 },
  );
  assert(researchBareResultStop.result === 'STOP' && researchBareResultStop.code === 'RESEARCH_GATE_BLOCKED',
    `a smuggled bare 'result' field on raw evidence must never be trusted: ${JSON.stringify(researchBareResultStop)}`);

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
    instructionClarity: basePayload.instructionClarity,
    research: basePayload.research,
    implementationHead,
    executionEvidence: routed.executionEvidence,
  };
  const finalDecision = evaluateReceipt(finalReceiptInput);
  assert(finalDecision.result === 'PASS', `final receipt must PASS: ${JSON.stringify(finalDecision)}`);
  const verified = verifyFinalReceipt(finalDecision, {
    owner: 'acme', name: 'widgets', branch: 'feat/widget', head: implementationHead, repoRoot: repoDir,
  });
  assert(verified.result === 'MERGE_READY', `expected MERGE_READY: ${JSON.stringify(verified)}`);

  // --- negative: a raw research-gate FAIL at the FINAL receipt stage must block MERGE_READY, never trust say-so ---
  const finalResearchFail = evaluateReceipt({
    ...finalReceiptInput,
    research: researchFor(basePayload.taskId, { checklist: [
      { id: 'safety', status: 'FAIL', applicable: true, justification: 'A real safety concern exists.', primarySourceRef: 'https://example.invalid/evidence' },
      { id: 'dataPreservation', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
      { id: 'existingOverlap', status: 'PASS', applicable: true, justification: 'Fine.', primarySourceRef: 'https://example.invalid/evidence' },
    ] }),
  });
  assert(finalResearchFail.result === 'STOP' && finalResearchFail.code === 'RESEARCH_GATE_BLOCKED',
    `a raw research-gate FAIL at the final receipt must block, never PASS: ${JSON.stringify(finalResearchFail)}`);

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
  const unavailable = runImplementationOrchestration(payloadWithTaskId('orch-2'), { desc: null, envSource: cleanEnv, timeoutMs: 5000 });
  assert(unavailable.result === 'STOP', 'missing Claude CLI must STOP the orchestration');
  assert(unavailable.routing?.result === 'STOP' && unavailable.routing?.code === 'NO_EXECUTOR_AVAILABLE', `expected NO_EXECUTOR_AVAILABLE routing: ${JSON.stringify(unavailable)}`);
  assert(unavailable.runner === null, 'the runner must never be invoked when no route was authorized');

  // --- negative: wrong repository identity (origin mismatch) must STOP before Claude is invoked ---
  const wrongIdentity = runImplementationOrchestration(
    payloadWithTaskId('orch-3', { repository: { owner: 'someone-else', name: 'widgets' } }),
    { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 },
  );
  assert(wrongIdentity.result === 'STOP' && wrongIdentity.code === 'REPOSITORY_IDENTITY_MISMATCH', `wrong repository identity must STOP: ${JSON.stringify(wrongIdentity)}`);

  // --- negative: pre-run dirty worktree must STOP before Claude is invoked ---
  fs.writeFileSync(path.join(repoDir, 'PRE_EXISTING_UNTRACKED.txt'), 'was already here\n', 'utf8');
  const dirtyStop = runImplementationOrchestration(payloadWithTaskId('orch-4'), { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(dirtyStop.result === 'STOP' && dirtyStop.code === 'WORKTREE_NOT_CLEAN', `dirty worktree must STOP: ${JSON.stringify(dirtyStop)}`);
  fs.rmSync(path.join(repoDir, 'PRE_EXISTING_UNTRACKED.txt'));

  // --- negative: protected path must STOP even when it is inside allowedScope ---
  const forbidden = runImplementationOrchestration(
    payloadWithTaskId('orch-protected', { forbiddenScope: ['src/widget.ts'] }),
    { desc: desc('forbidden'), envSource: cleanEnv, timeoutMs: 5000 },
  );
  assert(forbidden.result === 'STOP' && forbidden.runner?.code === 'FORBIDDEN_SCOPE_VIOLATION', `protected edit must STOP: ${JSON.stringify(forbidden)}`);
  assert(forbidden.runner?.forbiddenChangedPaths?.includes('src/widget.ts'), 'protected STOP must identify the changed protected path');
  git(repoDir, ['checkout', '--', 'src/widget.ts']);

  // --- negative: out-of-scope edit must STOP after Claude returns, before success is reported ---
  const outOfScope = runImplementationOrchestration(
    payloadWithTaskId('orch-5', { allowedScope: ['src/widget.ts'] }),
    { desc: desc('outofscope'), envSource: cleanEnv, timeoutMs: 5000 },
  );
  assert(outOfScope.result === 'STOP' && outOfScope.runner?.code === 'ALLOWED_SCOPE_VIOLATION', `out-of-scope edit must STOP: ${JSON.stringify(outOfScope)}`);
  fs.rmSync(path.join(repoDir, 'src', 'not-in-scope.ts'), { force: true });

  const records = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const runRecords = records.filter((r) => r.phase === 'run');
  assert(runRecords.length === 3, `fake Claude must run exactly for the golden path, protected-scope negative, and out-of-scope negative: ${runRecords.length}`);

  // === SYNTHETIC CLI entrypath check (NOT a real-provider E2E A/B/C test) ===
  // Proves the actual `main()` CLI execution/exit path -- not just the
  // exported `runImplementationOrchestration` function used above -- really
  // invokes the EXISTING stagnation-watch.mjs as a real child process bound
  // to a synthesized temporary repository's actual branch/HEAD, using only a
  // fake stand-in Claude provider. Never touches a real provider, real repo,
  // or real network.
  const cliRepoDir = path.join(tempRoot, 'repo-cli-entrypath');
  fs.mkdirSync(cliRepoDir, { recursive: true });
  git(cliRepoDir, ['init', '-q']);
  git(cliRepoDir, ['config', 'user.email', 'test@example.invalid']);
  git(cliRepoDir, ['config', 'user.name', 'Test']);
  git(cliRepoDir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  fs.mkdirSync(path.join(cliRepoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cliRepoDir, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  git(cliRepoDir, ['add', '.']);
  git(cliRepoDir, ['commit', '-q', '-m', 'init']);
  git(cliRepoDir, ['branch', '-m', 'main']);
  git(cliRepoDir, ['checkout', '-q', '-b', 'feat/widget']);

  const cliLogPath = path.join(tempRoot, 'fake-cli-entrypath-log.jsonl');
  const cliFakeCli = path.join(tempRoot, 'fake-claude-cli-entrypath.mjs');
  fs.writeFileSync(cliFakeCli, fakeSource.replace(JSON.stringify(logPath), JSON.stringify(cliLogPath)), 'utf8');

  // A fake, provider-neutral stand-in for `resolveProviderCommand('claude')`
  // itself -- the one piece of the real orchestrator that would otherwise
  // probe a real locally-installed Claude CLI when invoked as a genuine CLI
  // subprocess (main() calls it with no desc/envSource override, unlike the
  // in-process calls above). This guarantees the CLI-entrypath check below
  // can never reach a real external provider regardless of what is or is not
  // actually installed on the machine running this selftest.
  const fakeResolverSource = `export function resolveProviderCommand(kind) {
  if (kind !== 'claude') return null;
  return { file: ${JSON.stringify(process.execPath)}, prefix: [${JSON.stringify(cliFakeCli)}, 'ok'] };
}
`;
  const fakeResolverPath = path.join(tempRoot, 'fake-ai-provider-inventory-for-cli.mjs');
  fs.writeFileSync(fakeResolverPath, fakeResolverSource, 'utf8');
  const fakeResolverUrl = pathToFileURL(fakeResolverPath).href;

  let cliOrchestratorSource = fs.readFileSync(orchestratorPath, 'utf8');
  cliOrchestratorSource = cliOrchestratorSource
    .replace("from './ai-provider-inventory.mjs';", `from '${fakeResolverUrl}';`)
    .replace("from './ai-task-router.mjs';", `from '${ai_task_router_url}';`)
    .replace("from './implementation-route-receipt.mjs';", `from '${receipt_url}';`)
    .replace("from './instruction-clarity-gate.mjs';", `from '${clarity_url}';`)
    .replace("from './research-gate.mjs';", `from '${researchGateUrl}';`)
    .replace("from './implementation-runner.mjs';", `from '${patchedRunnerUrl}';`)
    // Point the production stagnation-watch path resolution at the real,
    // completely unmodified stagnation-watch.mjs (this copy of the
    // orchestrator source otherwise lives under a temp directory where no
    // sibling stagnation-watch.mjs exists).
    .replace('path.dirname(fileURLToPath(import.meta.url))', JSON.stringify(orchestratorDir));
  assert(cliOrchestratorSource.includes(JSON.stringify(orchestratorDir)), 'stagnation-watch path patch must have applied');
  const cliOrchestratorPath = path.join(tempRoot, 'implementation-orchestrator-cli-entrypath-under-test.mjs');
  fs.writeFileSync(cliOrchestratorPath, cliOrchestratorSource, 'utf8');

  const cliTaskId = 'orch-cli-entrypath';
  const cliPayload = {
    schemaVersion: 1,
    taskId: cliTaskId,
    kind: 'implementation',
    objective: 'Bump the widget constant via the real CLI entrypath.',
    prompt: 'Update src/widget.ts to change widget from 1 to 2, and add a helper file.',
    repoRoot: cliRepoDir,
    branch: 'feat/widget',
    allowedScope: ['src/**'],
    dataClass: 'source-only',
    repository: { owner: 'acme', name: 'widgets' },
    instructionClarity: {
      schemaVersion: 1,
      taskId: cliTaskId,
      instructions: [{ id: 'human-1', kind: 'INSTRUCTION', summary: 'Update the bounded widget implementation.' }],
      unlistedAssumptionsPresent: false,
      ambiguities: [],
    },
    research: researchFor(cliTaskId, { repository: { owner: 'acme', name: 'widgets' }, scope: ['src/**'] }),
  };

  function runCli() {
    const r = spawnSync(process.execPath, [cliOrchestratorPath, '--pretty'], {
      input: JSON.stringify(cliPayload),
      encoding: 'utf8',
      env: cleanEnv,
      cwd: cliRepoDir,
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* leave null, asserted below */ }
    return { status: r.status, parsed, stdout: r.stdout, stderr: r.stderr };
  }

  const cliFirst = runCli();
  assert(cliFirst.status === 0, `expected CLI exit 0 on the first accepted-task run: ${cliFirst.status} ${cliFirst.stdout} ${cliFirst.stderr}`);
  assert(cliFirst.parsed?.result === 'COMPLETED', `expected the real CLI entrypath to reach COMPLETED via the fake provider: ${JSON.stringify(cliFirst.parsed)}`);
  const firstCheckpoint = cliFirst.parsed?.stagnationCheckpoint;
  assert(firstCheckpoint?.ok === true, `expected the first real stagnation checkpoint to PROCEED: ${JSON.stringify(firstCheckpoint)}`);
  assert(firstCheckpoint?.code === 'STAGNATION_BASELINE_CREATED', `expected a real baseline checkpoint, not a fabricated one: ${JSON.stringify(firstCheckpoint)}`);
  assert(firstCheckpoint?.terminalState === 'AI_CONTINUES', `incomplete work must never be reported as a fake PRE_MERGE_READY terminal state: ${JSON.stringify(firstCheckpoint)}`);
  assert(firstCheckpoint?.preMergeTechnicalReady === false, `the orchestrator must never assert fake PRE_MERGE_READY: ${JSON.stringify(firstCheckpoint)}`);
  assert(firstCheckpoint?.turnCloseReceipt === null, `the orchestrator must never request/return a terminal close receipt: ${JSON.stringify(firstCheckpoint)}`);

  // Prove the checkpoint state file is a REAL branch+HEAD-bound artifact
  // written by the real stagnation-watch.mjs (not a mocked/forged result).
  const cliStateGitPath = git(cliRepoDir, ['rev-parse', '--git-path', `ai-dev-foundation/stagnation/${cliTaskId}.json`]).trim();
  const cliStateFile = path.join(cliRepoDir, cliStateGitPath);
  assert(fs.existsSync(cliStateFile), 'the real stagnation-watch.mjs must have written a real checkpoint state file bound to this repo');
  const cliState = JSON.parse(fs.readFileSync(cliStateFile, 'utf8'));
  assert(cliState.schema === 'ai-stagnation-state-v1' && cliState.workId === cliTaskId,
    `the persisted checkpoint must be the real stagnation-watch schema/workId: ${JSON.stringify(cliState)}`);
  const cliHeadSha = git(cliRepoDir, ['rev-parse', 'HEAD']).trim();
  assert(/^[0-9a-f]{40}$/.test(cliHeadSha), 'expected a real resolvable HEAD for the checkpoint binding');

  // Simulate a genuinely-already-stagnant prior checkpoint (backdated,
  // 2 prior unchanged checkpoints, same real fingerprint) so the next real
  // invocation legitimately STOPs on repeated unchanged progress, without
  // fabricating stagnation-watch's own internal result.
  const backdated = {
    ...cliState,
    lastCheckpointAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    unchangedCheckpoints: 2,
  };
  fs.writeFileSync(cliStateFile, `${JSON.stringify(backdated, null, 2)}\n`, 'utf8');

  // Restore only the temporary synthetic fixture files before replay.
  // The fake provider recreates exactly the same changed-content fingerprint
  // against the same HEAD; unlike a dirty source worktree, this allows the
  // real qualified entrypath to run and the existing stagnation gate to
  // detect repeated unchanged progress honestly.
  git(cliRepoDir, ['checkout', '--', 'src/widget.ts']);
  fs.rmSync(path.join(cliRepoDir, 'src', 'widget-helper.ts'), { force: true });

  const cliSecond = runCli();
  assert(cliSecond.parsed?.result === 'COMPLETED', `the Claude execution itself must still be reported honestly as COMPLETED: ${JSON.stringify(cliSecond.parsed)}`);
  const secondCheckpoint = cliSecond.parsed?.stagnationCheckpoint;
  assert(secondCheckpoint?.ok === false, `a real repeated-unchanged-progress checkpoint must fail, never be silently reported as a qualified successful end: ${JSON.stringify(secondCheckpoint)}`);
  assert(secondCheckpoint?.code === 'STAGNATION_HARD_STOP_ROUTE_CHANGE_REQUIRED', `expected the real stagnation hard-stop code: ${JSON.stringify(secondCheckpoint)}`);
  assert(secondCheckpoint?.handoffClass === 'AI_OWNED', `a technical stagnation hard-stop must never be mislabeled human-required: ${JSON.stringify(secondCheckpoint)}`);
  assert(secondCheckpoint?.terminalState !== 'PRE_MERGE_READY', `must never assert fake PRE_MERGE_READY: ${JSON.stringify(secondCheckpoint)}`);
  assert(secondCheckpoint?.preMergeTechnicalReady === false, `must never assert fake PRE_MERGE_READY: ${JSON.stringify(secondCheckpoint)}`);
  assert(secondCheckpoint?.turnCloseReceipt === null, `must never request/return a terminal close receipt: ${JSON.stringify(secondCheckpoint)}`);
  assert(cliSecond.status !== 0, `the CLI exit path must surface a failed checkpoint gate rather than silently reporting a qualified successful end: exit ${cliSecond.status}`);

  console.log('implementation-orchestrator selftest: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
