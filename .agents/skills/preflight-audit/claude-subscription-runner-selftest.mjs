#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable, PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const runnerArg = process.argv[2];
if (!runnerArg) throw new Error('runner path required');
const runnerPath = path.resolve(runnerArg);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runner-selftest-'));
function sha256File(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
const nodeHash = sha256File(process.execPath);
const trustedClaudeHash = '647E736F20C9FF0553C754624CBF8A6DCAC196E8595509D8F63DCE8BBE818757';
let testRunnerSource = fs.readFileSync(runnerPath, 'utf8');
if (!testRunnerSource.includes(trustedClaudeHash)) throw new Error('trusted Claude hash missing from runner');
const inventoryUrl = pathToFileURL(path.join(path.dirname(runnerPath), 'ai-provider-inventory.mjs')).href;
testRunnerSource = testRunnerSource
  .replace("from './ai-provider-inventory.mjs';", `from '${inventoryUrl}';`)
  .replace(trustedClaudeHash, nodeHash)
  .replace("return Boolean(desc) && typeof desc.file === 'string' && Array.isArray(desc.prefix) && desc.prefix.length === 0;", "return Boolean(desc) && typeof desc.file === 'string' && Array.isArray(desc.prefix);");
const testRunnerPath = path.join(tempRoot, 'runner-under-test.mjs');
fs.writeFileSync(testRunnerPath, testRunnerSource, 'utf8');
const prodRunner = await import(pathToFileURL(runnerPath).href);
const { validateClaudeTask, runClaudeSubscriptionTask, claudeRunnerEvidence, readBoundedTaskInput, unsafeProviderEnvPresent } = await import(pathToFileURL(testRunnerPath).href);
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function expectCode(promise, code) {
  try { await promise; } catch (error) { assert(error?.code === code, `expected ${code}, got ${error?.code}`); return; }
  throw new Error(`expected rejection ${code}`);
}
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
  fs.appendFileSync(logPath, JSON.stringify({ phase, args, cwd: process.cwd(), execPath: process.execPath, input, forbiddenEnv: forbiddenEnv() }) + '\\n');
}
if (args.join(' ') === 'auth status --json') {
  record('auth');
  const auth = mode === 'wrongauth'
    ? { loggedIn: true, subscriptionType: 'pro', authMethod: 'apiKey' }
    : { loggedIn: true, subscriptionType: 'pro', authMethod: 'claude.ai' };
  console.log(JSON.stringify(auth)); process.exit(0);
}
if (args.includes('--help')) {
  const phase = args.length === 1 && args[0] === '--help' ? 'help' : 'flag-parse';
  record(phase);
  let helpText = '--safe-mode --tools <tools...> Use \"\" to disable all --strict-mcp-config --mcp-config <configs...> --no-session-persistence --disable-slash-commands --no-chrome --permission-mode <mode> --input-format <format> --output-format <format> -p, --print --setting-sources <sources> --settings <file-or-json> --model <model> --system-prompt <prompt> CLAUDE.md skills plugins hooks MCP servers disabled';
  if (mode === 'partialhelp') helpText = helpText.replace('--mcp-config <configs...>', 'REMOVED');
  console.log(helpText);
  if (mode === 'badhelp') process.exit(4);
  if (mode === 'parsefail' && phase === 'flag-parse') process.exit(5);
  process.exit(0);
}
`;
fs.writeFileSync(fakeCli, fakeSource, 'utf8');
fs.appendFileSync(fakeCli, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  record('run', input);
  const required = [
    '--print','--input-format','text','--output-format','json','--safe-mode',
    '--setting-sources','--settings','{}','--tools','--strict-mcp-config','--mcp-config',
    '--disable-slash-commands','--no-chrome','--no-session-persistence',
    '--permission-mode','plan','--model','sonnet','--system-prompt',
  ];
  if (mode === 'fail') { console.error('SECRET_STDERR_SHOULD_NOT_LEAK'); process.exit(7); }
  if (mode === 'badjson') { console.log('not-json'); process.exit(0); }
  if (mode === 'huge') { process.stdout.write('x'.repeat(300000)); process.exit(0); }
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (mode === 'stringerror') { console.log(JSON.stringify({ type:'result', subtype:'success', is_error:'true', result:'SECRET_DIAGNOSTIC' })); process.exit(0); }
  if (mode === 'errorenvelope') { console.log(JSON.stringify({ type:'result', subtype:'error', is_error:true, result:'SECRET_ERROR_RESULT' })); process.exit(0); }
  if (mode === 'missingdisc') { console.log(JSON.stringify({ result:'SECRET_MISSING_DISCRIMINATOR' })); process.exit(0); }
  if (mode === 'consent') { console.log(JSON.stringify({ type:'result', subtype:'billing_required', is_error:true, result:'API credit consent required' })); process.exit(0); }
  if (forbiddenEnv().length || !required.every((token) => args.includes(token)) || args.filter((x) => x === '').length < 2 || input.length === 0) process.exit(9);
  console.log(JSON.stringify({ type:'result', subtype:'success', is_error:false, result:'FAKE_OK' }));
});
`, 'utf8');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|GCLOUD_|VERTEX_|AZURE_)/i.test(key)));
const payload = { schemaVersion: 1, taskId: 'test-1', capability: 'review', dataClass: 'synthetic', prompt: 'Review this synthetic input only.' };
const desc = (mode = 'ok') => ({ file: process.execPath, prefix: [fakeCli, mode] });

try {
  assert(prodRunner.isNativeClaudeDescriptor({ file: 'claude.exe', prefix: [] }) === true, 'native Claude descriptor with empty prefix expected');
  assert(prodRunner.isNativeClaudeDescriptor({ file: 'claude.exe', prefix: ['unexpected'] }) === false, 'production runner must reject non-empty prefix');
  assert(validateClaudeTask(payload).length === 0, 'valid task rejected');
  assert(validateClaudeTask({ ...payload, extra: true }).includes('unknown_field'), 'unknown field must stop');
  assert(validateClaudeTask({ ...payload, dataClass: 'protected' }).includes('dataClass_invalid'), 'protected data must stop');
  assert(validateClaudeTask({ ...payload, prompt: 'x'.repeat(70000) }).includes('prompt_too_large'), 'oversized prompt must stop');

  const bounded = await readBoundedTaskInput(Readable.from(['abc']), { maxBytes: 10, timeoutMs: 100 });
  assert(bounded === 'abc', 'bounded input must read valid stream');
  await expectCode(readBoundedTaskInput(Readable.from(['x'.repeat(20)]), { maxBytes: 10, timeoutMs: 100 }), 'INPUT_TOO_LARGE');
  const never = new PassThrough();
  await expectCode(readBoundedTaskInput(never, { maxBytes: 10, timeoutMs: 25 }), 'INPUT_TIMEOUT');
  never.destroy();

  const ok = runClaudeSubscriptionTask(payload, { desc: desc(), envSource: cleanEnv, timeoutMs: 5000 });
  assert(ok.result === 'COMPLETED' && ok.output === 'FAKE_OK', JSON.stringify(ok));
  assert(ok.evidence.toolBoundary === 'NO_LOCAL_TOOLS_ENFORCED', 'tool evidence not closed');
  assert(ok.evidence.dataBoundary === 'EXPLICIT_SAFE_PAYLOAD_ONLY', 'data evidence not closed');
  assert(ok.evidence.incrementalCostBoundary === 'INCLUDED_ONLY_ENFORCED', 'cost evidence not closed');
  assert(ok.evidence.fallbackBehavior === 'STOP_BEFORE_COST_OR_PERMISSION_EXPANSION', 'fallback evidence not closed');
  const records = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const first = records.slice(0, 3);
  assert(first.map((x) => x.phase).join(',') === 'help,auth,run', 'trusted-binary help/auth/run order expected');
  for (const record of first) {
    assert(record.cwd !== process.cwd() && record.cwd.startsWith(os.tmpdir()), `${record.phase} cwd must be isolated`);
    assert(path.dirname(record.execPath) === record.cwd, `${record.phase} must execute the isolated attested binary copy`);
    assert(record.forbiddenEnv.length === 0, `${record.phase} inherited provider/cloud env`);
  }
  assert(first[2].input === payload.prompt, 'prompt must arrive by stdin');
  assert(first[2].args.includes('--tools') && first[2].args.filter((x) => x === '').length >= 2, 'tools/settings sources must be empty');
  assert(first[2].args.includes('--strict-mcp-config') && first[2].args.includes('{"mcpServers":{}}'), 'MCP must be empty and strict');
  assert(first[2].args.includes('--settings') && first[2].args.includes('{}'), 'settings must be explicit empty JSON');
  assert(!fs.existsSync(first[2].cwd), 'temporary runner directory must be removed');

  const noInvokeBaseline = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  for (const [key, value] of [['ANTHROPIC_API_KEY','SECRET'],['anthropic_auth_token','SECRET'],['Aws_Access_Key_Id','SECRET'],['google_application_credentials','SECRET'],['GcLoUd_Project','SECRET'],['vErTeX_Project','SECRET'],['AzUrE_Client_Id','SECRET'],['Claude_Config_Dir','SECRET']]) {
    const unsafe = runClaudeSubscriptionTask(payload, { desc: desc(), envSource: { ...cleanEnv, [key]: value } });
    assert(unsafe.code === 'UNSAFE_PROVIDER_ENV_PRESENT' && !JSON.stringify(unsafe).includes('SECRET'), `${key} must fail before provider invocation`);
  }
  const afterUnsafeCount = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  assert(afterUnsafeCount === noInvokeBaseline, 'unsafe env rejection must not invoke Claude');
  const prodHashStop = prodRunner.runClaudeSubscriptionTask(payload, { desc: { file: process.execPath, prefix: [] }, envSource: cleanEnv });
  assert(prodHashStop.code === 'RUNNER_BINARY_OR_FLAGS_UNTRUSTED', 'empty-prefix unattested binary hash must stop before auth/model invocation');
  const afterHashCount = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  assert(afterHashCount === noInvokeBaseline, 'unattested binary rejection must not invoke Claude');
  assert(runClaudeSubscriptionTask(payload, { desc: desc('wrongauth'), envSource: cleanEnv }).code === 'SUBSCRIPTION_AUTH_NOT_VERIFIED', 'wrong auth must stop');
  assert(runClaudeSubscriptionTask(payload, { desc: desc('badhelp'), envSource: cleanEnv }).code === 'RUNNER_BINARY_OR_FLAGS_UNTRUSTED', 'failed help capability probe must stop');
  assert(runClaudeSubscriptionTask(payload, { desc: desc('partialhelp'), envSource: cleanEnv }).code === 'RUNNER_BINARY_OR_FLAGS_UNTRUSTED', 'missing required CLI capability must stop');
  const failed = runClaudeSubscriptionTask(payload, { desc: desc('fail'), envSource: cleanEnv, timeoutMs: 5000 });
  assert(failed.code === 'PROVIDER_STOPPED' && !JSON.stringify(failed).includes('SECRET_STDERR_SHOULD_NOT_LEAK'), 'stderr must not leak');
  assert(runClaudeSubscriptionTask(payload, { desc: desc('badjson'), envSource: cleanEnv, timeoutMs: 5000 }).code === 'PROVIDER_OUTPUT_INVALID', 'bad JSON must stop');
  for (const mode of ['stringerror','errorenvelope','missingdisc','consent']) {
    const stopped = runClaudeSubscriptionTask(payload, { desc: desc(mode), envSource: cleanEnv, timeoutMs: 5000 });
    assert(stopped.code === 'PROVIDER_OUTPUT_INVALID', `${mode} must fail strict success validation`);
    assert(!JSON.stringify(stopped).includes('SECRET_') && !JSON.stringify(stopped).includes('API credit consent'), `${mode} provider text must not leak`);
  }
  assert(runClaudeSubscriptionTask(payload, { desc: desc('huge'), envSource: cleanEnv, timeoutMs: 5000 }).code === 'PROVIDER_OUTPUT_TOO_LARGE', 'large output must stop');
  assert(runClaudeSubscriptionTask(payload, { desc: desc('timeout'), envSource: cleanEnv, timeoutMs: 1000 }).code === 'PROVIDER_TIMEOUT', 'provider timeout must stop');

  const noCost = claudeRunnerEvidence({
    auth: { loggedIn: true, subscriptionType: 'pro', authMethod: 'claude.ai' }, credentialEnvAbsent: true, runnerSupported: true,
  });
  assert(noCost.incrementalCostBoundary === 'INCLUDED_ONLY_ENFORCED', 'subscription-only evidence expected');
  const unknownCost = claudeRunnerEvidence({
    auth: { loggedIn: true, subscriptionType: 'pro', authMethod: 'claude.ai' }, credentialEnvAbsent: false, runnerSupported: true,
  });
  assert(unknownCost.incrementalCostBoundary === 'UNKNOWN', 'credential ambiguity must fail closed');
  const omittedSupport = claudeRunnerEvidence({
    auth: { loggedIn: true, subscriptionType: 'pro', authMethod: 'claude.ai' }, credentialEnvAbsent: true,
  });
  assert(omittedSupport.toolBoundary === 'UNKNOWN' && omittedSupport.incrementalCostBoundary === 'UNKNOWN', 'omitted runner support must fail closed');
  assert(unsafeProviderEnvPresent({ anthropic_api_key: 'x' }) === true, 'unsafe env detection must be case-insensitive');
  assert(unsafeProviderEnvPresent({ Aws_Access_Key_Id: 'x' }) === true, 'cloud env must be rejected');
  assert(unsafeProviderEnvPresent({ PATH: 'safe' }) === false, 'ordinary env must not be rejected');

  console.log('claude-subscription-runner selftest: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
