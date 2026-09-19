#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gate = resolve(gateArg);
function run(extra, cwd = process.cwd()) {
  return spawnSync(process.execPath, [gate, '--json', ...extra], { encoding:'utf8', cwd });
}
function expectStop(extra, code, cwd) {
  const r = run(extra, cwd);
  if (r.status === 0) throw new Error(`expected STOP for ${code}`);
  if (!r.stdout.includes(code)) throw new Error(`missing ${code}: ${r.stdout} ${r.stderr}`);
}
function expectProceed(extra, code = 'ACTIONS_COST_ROUTE_ACCEPTABLE', cwd) {
  const r = run(extra, cwd);
  if (r.status !== 0 || !r.stdout.includes(code)) throw new Error(`expected PROCEED/${code}: ${r.stdout} ${r.stderr}`);
}
const workflowPath = '.github/workflows/windows-fixture-gate.yml';
const persistentReviews = ['--trigger-review','pass','--path-filter-review','pass','--concurrency-review','pass','--matrix-review','pass'];
const repoHead = spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
expectProceed(['--repo-visibility','private','--route','local']);
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','temporary-one-shot','--equivalent-safe-route','available','--quota-percent','75','--workflow-path',workflowPath], 'ACTIONS_PRIVATE_ONE_SHOT_SAFE_ROUTE_AVAILABLE');
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','temporary-one-shot','--equivalent-safe-route','unknown','--quota-percent','75','--workflow-path',workflowPath], 'ACTIONS_EQUIVALENT_ROUTE_UNKNOWN');
expectProceed(['--repo-visibility','private','--route','github-hosted','--workflow-mode','temporary-one-shot','--equivalent-safe-route','unavailable','--quota-percent','75','--workflow-path',workflowPath]);
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','70','--workflow-path',workflowPath,
  '--trigger-review','fail','--path-filter-review','pass','--concurrency-review','pass','--matrix-review','pass'], 'ACTIONS_TRIGGER_REVIEW_REQUIRED');
expectProceed(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','70','--workflow-path',workflowPath,...persistentReviews]);
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','available','--quota-percent','70','--workflow-path',workflowPath,...persistentReviews], 'ACTIONS_PRIVATE_HOSTED_SAFE_ROUTE_AVAILABLE');
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','90.1','--workflow-path',workflowPath,...persistentReviews], 'ACTIONS_QUOTA_PRESSURE_NONREQUIRED_HOSTED_ROUTE_BLOCKED');
const tempRoot = mkdtempSync(join(tmpdir(), 'actions-cost-guard-'));
function git(cwd, gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd, encoding:'utf8', windowsHide:true });
  if (r.status !== 0) throw new Error(`git failed: ${gitArgs.join(' ')}\n${r.stdout}\n${r.stderr}`);
}
try {
  mkdirSync(join(tempRoot, '.github', 'workflows'), { recursive:true });
  writeFileSync(join(tempRoot, '.github', 'workflows', 'windows-fixture-gate.yml'), 'name: Windows fixture gate\non: pull_request\njobs: {}\n');
  git(tempRoot, ['init','-b','main']);
  git(tempRoot, ['config','user.email','selftest@example.invalid']);
  git(tempRoot, ['config','user.name','Foundation Selftest']);
  git(tempRoot, ['add','.']);
  git(tempRoot, ['commit','-m','fixture without registry']);

  const requiredBase = ['--repo-visibility','private','--route','github-hosted','--workflow-mode','required-independent','--equivalent-safe-route','unavailable','--quota-percent','90.1','--workflow-path',workflowPath,...persistentReviews];
  expectStop(requiredBase, 'ACTIONS_REQUIRED_GATE_REGISTRY_MISSING', tempRoot);

  mkdirSync(join(tempRoot, '.agents'), { recursive:true });
  writeFileSync(join(tempRoot, '.agents', 'github-actions-required-gates.json'), JSON.stringify({ schemaVersion:1, gates:[{ workflowPath, status:'required-independent', reason:'Independent clean Windows runner evidence.' }] }, null, 2));
  git(tempRoot, ['add','.agents/github-actions-required-gates.json']);
  git(tempRoot, ['commit','-m','register required gate']);
  expectProceed(requiredBase, 'ACTIONS_QUOTA_PRESSURE_REQUIRED_GATE_PRESERVED', tempRoot);
  expectStop([...requiredBase,'--equivalent-safe-route','available'], 'ACTIONS_REQUIRED_GATE_EQUIVALENT_ROUTE_NOT_EXCLUDED', tempRoot);
  expectStop([...requiredBase,'--quota-percent','100'], 'ACTIONS_INCLUDED_QUOTA_EXHAUSTED', tempRoot);
  expectProceed([...requiredBase,'--quota-percent','100','--paid-overage','human-approved'], 'ACTIONS_COST_ROUTE_ACCEPTABLE', tempRoot);
  writeFileSync(join(tempRoot, '.agents', 'github-actions-required-gates.json'), JSON.stringify({ schemaVersion:1, gates:[] }, null, 2));
  expectProceed(requiredBase, 'ACTIONS_REQUIRED_GATE_COMMITTED_POLICY_MATCH', tempRoot);
  git(tempRoot, ['add','.agents/github-actions-required-gates.json']);
  git(tempRoot, ['commit','-m','remove required registration']);
  expectStop(requiredBase, 'ACTIONS_REQUIRED_GATE_NOT_REGISTERED', tempRoot);
} finally {
  rmSync(tempRoot, { recursive:true, force:true });
}

expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','101','--workflow-path',workflowPath,...persistentReviews], 'ACTIONS_PRIVATE_QUOTA_EVIDENCE_REQUIRED');
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','70','--workflow-path',workflowPath,...persistentReviews,'--paid-overage','yes'], 'ACTIONS_PAID_OVERAGE_VALUE_INVALID');
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','70','--workflow-path','../bad.yml',...persistentReviews], 'ACTIONS_WORKFLOW_PATH_REQUIRED');
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','70','--workflow-path',workflowPath,...persistentReviews,'--retry-scope','full','--failed-only-rerun-available','yes','--rerun-capability-evidence','connector'], 'ACTIONS_FAILED_ONLY_RERUN_REQUIRED');
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','70','--workflow-path',workflowPath,...persistentReviews,'--retry-scope','full','--failed-only-rerun-available','yes','--rerun-capability-evidence','unknown'], 'ACTIONS_RERUN_CAPABILITY_EVIDENCE_REQUIRED');
expectProceed(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--quota-percent','70','--workflow-path',workflowPath,...persistentReviews,'--retry-scope','failed-only','--failed-only-rerun-available','yes','--rerun-capability-evidence','connector']);
expectProceed(['--repo-visibility','public','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews]);
expectStop(['--repo-visibility','private','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews], 'ACTIONS_PRIVATE_QUOTA_EVIDENCE_REQUIRED');

expectStop(['--repo-visibility','public','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews,'--verification-phase','pre-merge','--same-property-already-passed','unknown'], 'ACTIONS_DUPLICATE_VERIFICATION_EVIDENCE_REQUIRED');
expectStop(['--repo-visibility','public','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews,'--verification-phase','pre-merge','--same-property-already-passed','yes'], 'ACTIONS_PRIOR_PASS_EVIDENCE_REQUIRED');
expectStop(['--repo-visibility','public','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews,'--verification-phase','pre-merge','--same-property-already-passed','yes','--prior-pass-evidence-source','connector','--prior-pass-head','0'.repeat(40)], 'ACTIONS_PRIOR_PASS_HEAD_MISMATCH');
expectStop(['--repo-visibility','public','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews,'--verification-phase','pre-merge','--same-property-already-passed','yes','--prior-pass-evidence-source','connector','--prior-pass-head',repoHead], 'ACTIONS_DUPLICATE_VERIFICATION_ALREADY_PROVEN');
expectProceed(['--repo-visibility','public','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews,'--verification-phase','pre-merge','--same-property-already-passed','no']);
expectProceed(['--repo-visibility','public','--route','github-hosted','--workflow-mode','persistent','--equivalent-safe-route','unavailable','--workflow-path',workflowPath,...persistentReviews,'--verification-phase','post-merge-required','--same-property-already-passed','yes']);

console.log('github-actions-cost-guard selftest: PASS');