#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseInput, validateEvidence } from './fast-path-classifier.mjs';

const CORE = ['merge-authorization','merge-execution','fast-path','security-preflight','full-gate-selector'];
const ALL = [
  'merge-authorization','merge-execution','merge-execution-batch','merge-executor','foundation-sync','foundation-bootstrap','foundation-update','foundation-remote-plan','foundation-batch-rollout',
  'project-context','project-memory','common-rule-health','portfolio-governance','live-base-ref','ai-capacity','ai-provider-inventory','ai-task-router','claude-runner','fast-path','operation-preflight','actions-cost',
  'provider-qualification','provider-readiness','security-history','security-preflight','stagnation','wip-observer','portfolio-health','long-task-wait','merge-readiness','real-device',
  'full-gate-selector',
];
const COMMANDS = {
  'merge-authorization':['node','.agents/skills/final-pr-audit/merge-authorization-gate-selftest.mjs','.agents/skills/final-pr-audit/merge-authorization-gate.mjs'],
  'merge-execution':['node','.agents/skills/final-pr-audit/merge-execution-gate-selftest.mjs'],
  'merge-execution-batch':['node','.agents/skills/final-pr-audit/cross-repo-merge-execution-gate-selftest.mjs'],
  'merge-executor':['node','.agents/skills/final-pr-audit/cross-repo-merge-executor-selftest.mjs'],
  'foundation-sync':['node','.agents/skills/foundation-sync-audit/foundation-sync-audit-selftest.mjs','.agents/skills/foundation-sync-audit/foundation-sync-audit.mjs'],
  'foundation-bootstrap':['node','.agents/skills/foundation-sync-audit/foundation-bootstrap-selftest.mjs','.agents/skills/foundation-sync-audit/foundation-bootstrap.mjs','.agents/skills/foundation-sync-audit/foundation-sync-audit.mjs'],
  'foundation-update':['node','.agents/skills/foundation-sync-audit/foundation-update-selftest.mjs','.agents/skills/foundation-sync-audit/foundation-update.mjs','.agents/skills/foundation-sync-audit/foundation-sync-audit.mjs'],
  'foundation-remote-plan':['node','.agents/skills/foundation-sync-audit/foundation-remote-update-plan-selftest.mjs','.agents/skills/foundation-sync-audit/foundation-remote-update-plan.mjs'],
  'foundation-batch-rollout':['node','.agents/skills/foundation-sync-audit/foundation-batch-rollout-plan-selftest.mjs'],
  'project-context':['node','.agents/skills/handoff/project-context-guard-selftest.mjs','.agents/skills/handoff/project-context-guard.mjs'],
  'project-memory':['node','.agents/skills/handoff/project-working-memory-selftest.mjs','.agents/skills/handoff/project-working-memory.mjs'],
  'common-rule-health':['node','.agents/skills/common-rule-integration-audit/common-rule-health-audit-selftest.mjs','.agents/skills/common-rule-integration-audit/common-rule-health-audit.mjs'],
  'portfolio-governance':['node','tools/portfolio-governance-audit-selftest.mjs'],
  'live-base-ref':['node','.agents/skills/preflight-audit/live-base-ref-guard-selftest.mjs','.agents/skills/preflight-audit/live-base-ref-guard.mjs'],
  'ai-capacity':['node','.agents/skills/preflight-audit/ai-capacity-observer-selftest.mjs','.agents/skills/preflight-audit/ai-capacity-observer.mjs'],
  'ai-provider-inventory':['node','.agents/skills/preflight-audit/ai-provider-inventory-selftest.mjs','.agents/skills/preflight-audit/ai-provider-inventory.mjs','.agents/skills/preflight-audit/ai-task-router.mjs'],
  'ai-task-router':['node','.agents/skills/preflight-audit/ai-task-router-selftest.mjs','.agents/skills/preflight-audit/ai-task-router.mjs'],
  'claude-runner':['node','.agents/skills/preflight-audit/claude-subscription-runner-selftest.mjs','.agents/skills/preflight-audit/claude-subscription-runner.mjs'],
  'fast-path':['node','.agents/skills/preflight-audit/fast-path-classifier-selftest.mjs','.agents/skills/preflight-audit/fast-path-classifier.mjs'],
  'operation-preflight':['node','.agents/skills/preflight-audit/operation-preflight-selftest.mjs','.agents/skills/preflight-audit/operation-preflight.mjs'],
  'actions-cost':['node','.agents/skills/preflight-audit/github-actions-cost-guard-selftest.mjs','.agents/skills/preflight-audit/github-actions-cost-guard.mjs'],
  'provider-qualification':['node','.agents/skills/preflight-audit/provider-adapter-qualification-selftest.mjs','.agents/skills/preflight-audit/provider-adapter-qualification.mjs','.agents/skills/preflight-audit/ai-task-router.mjs'],
  'provider-readiness':['node','.agents/skills/preflight-audit/provider-adapter-readiness-selftest.mjs','.agents/skills/preflight-audit/provider-adapter-readiness.mjs'],
  'security-history':['node','.agents/skills/preflight-audit/security-history-audit-selftest.mjs','.agents/skills/preflight-audit/security-history-audit.mjs'],
  'security-preflight':['node','.agents/skills/preflight-audit/security-preflight-selftest.mjs','.agents/skills/preflight-audit/security-preflight.mjs'],
  'stagnation':['node','.agents/skills/preflight-audit/stagnation-watch-selftest.mjs','.agents/skills/preflight-audit/stagnation-watch.mjs'],
  'wip-observer':['node','.agents/skills/preflight-audit/wip-review-queue-observer-selftest.mjs','.agents/skills/preflight-audit/wip-review-queue-observer.mjs'],
  'portfolio-health':['node','.agents/skills/preflight-audit/portfolio-health-observer-selftest.mjs'],
  'long-task-wait':['node','.agents/skills/long-task-wait/long-task-wait-selftest.mjs'],
  'merge-readiness':['node','.agents/skills/preflight-audit/cross-repo-merge-readiness-selftest.mjs'],
  'real-device':['node','.agents/skills/test-gate/real-device-preparation-gate-selftest.mjs','.agents/skills/test-gate/real-device-preparation-gate.mjs'],
  'full-gate-selector':['node','.agents/skills/preflight-audit/full-gate-selftest-selector-selftest.mjs','.agents/skills/preflight-audit/full-gate-selftest-selector.mjs'],
};
const GROUPS = {
  'operation-preflight':['operation-preflight'],
  'actions-cost':['actions-cost'],
  'claude-runner':['claude-runner'],
  'stagnation':['stagnation'],
  'project-context':['project-context','project-memory'],
  'common-rule-health':['common-rule-health'],
  'portfolio-governance':['portfolio-governance','common-rule-health'],
  'live-base-ref':['live-base-ref'],
  'security-history':['security-history'],
  'security-preflight':['security-preflight'],
  'wip-observer':['wip-observer'],
  'portfolio-health':['portfolio-health'],
  'long-task-wait':['long-task-wait','stagnation'],
  'merge-readiness':['merge-readiness'],
  'merge-execution-batch':['merge-execution-batch'],
  'real-device':['real-device'],
  'ai-capacity':['ai-capacity'],
  'ai-routing':['ai-provider-inventory','ai-task-router','provider-qualification','provider-readiness'],
  'foundation-sync':['foundation-sync','foundation-bootstrap','foundation-update','foundation-remote-plan','foundation-batch-rollout'],
};
function pair(path, dir, stem) {
  return path === `${dir}/${stem}.mjs` || path === `${dir}/${stem}-selftest.mjs`;
}
function isNeutral(path) {
  return path === 'CHANGELOG.md' || path === 'VERSION';
}
function isHighCoupling(path) {
  if (/^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(path)) return true;
  return pair(path,'.agents/skills/preflight-audit','full-gate-selftest-selector') ||
    pair(path,'.agents/skills/preflight-audit','fast-path-classifier') ||
    pair(path,'.agents/skills/final-pr-audit','merge-authorization-gate') ||
    pair(path,'.agents/skills/final-pr-audit','merge-execution-gate') ||
    pair(path,'.agents/skills/final-pr-audit','cross-repo-merge-executor');
}
function familyFor(path) {
  const pre = '.agents/skills/preflight-audit';
  const foundation = '.agents/skills/foundation-sync-audit';
  if (pair(path,pre,'operation-preflight')) return 'operation-preflight';
  if (pair(path,pre,'github-actions-cost-guard')) return 'actions-cost';
  if (pair(path,pre,'claude-subscription-runner')) return 'claude-runner';
  if (pair(path,pre,'stagnation-watch')) return 'stagnation';
  if (pair(path,'.agents/skills/handoff','project-context-guard') || pair(path,'.agents/skills/handoff','project-working-memory')) return 'project-context';
  if (pair(path,'.agents/skills/common-rule-integration-audit','common-rule-health-audit')) return 'common-rule-health';
  if (path === 'tools/portfolio-governance-audit.mjs' || path === 'tools/portfolio-governance-audit-selftest.mjs') return 'portfolio-governance';
  if (pair(path,pre,'live-base-ref-guard')) return 'live-base-ref';
  if (pair(path,pre,'security-history-audit')) return 'security-history';
  if (pair(path,pre,'security-preflight')) return 'security-preflight';
  if (pair(path,pre,'wip-review-queue-observer')) return 'wip-observer';
  if (pair(path,pre,'portfolio-health-observer')) return 'portfolio-health';
  if (['bounded-task-wait','turn-wait-budget'].some(stem => pair(path,'.agents/skills/long-task-wait',stem))) return 'long-task-wait';
  if (pair(path,'.agents/skills/long-task-wait','long-task-wait')) return 'long-task-wait';
  if (pair(path,pre,'cross-repo-merge-readiness')) return 'merge-readiness';
  if (pair(path,'.agents/skills/final-pr-audit','cross-repo-merge-execution-gate')) return 'merge-execution-batch';
  if (pair(path,'.agents/skills/test-gate','real-device-preparation-gate')) return 'real-device';
  if (pair(path,pre,'ai-capacity-observer')) return 'ai-capacity';
  if (['ai-provider-inventory','ai-task-router','provider-adapter-qualification','provider-adapter-readiness'].some(stem => pair(path,pre,stem))) return 'ai-routing';
  if (['foundation-sync-audit','foundation-bootstrap','foundation-update','foundation-remote-update-plan','foundation-batch-rollout-plan'].some(stem => pair(path,foundation,stem))) return 'foundation-sync';
  return null;
}
function ordered(ids) {
  const wanted = new Set(ids);
  return ALL.filter(id => wanted.has(id));
}
function commandsFor(ids) {
  return ids.map(id => ({ id, argv: [...COMMANDS[id]] }));
}
function fullSuite(reason, evidenceValid = true) {
  return { schemaVersion:1, evidenceValid, selection:'FULL_SUITE', reasons:[reason], selectedTests:[...ALL], commands:commandsFor(ALL) };
}
export function selectSelftests(evidence) {
  const validationError = validateEvidence(evidence);
  if (validationError) return fullSuite(validationError, false);
  if (!evidence.evidenceComplete) return fullSuite('EVIDENCE_INCOMPLETE');
  if (Object.values(evidence.impacts).some(Boolean)) return fullSuite('DECLARED_IMPACT_REQUIRES_FULL_SUITE');

  const families = new Set();
  let mappedImplementationCount = 0;
  for (const path of evidence.changedFiles) {
    if (isHighCoupling(path)) return fullSuite('HIGH_COUPLING_PATH_REQUIRES_FULL_SUITE');
    if (isNeutral(path)) continue;
    const family = familyFor(path);
    if (!family) return fullSuite('UNMAPPED_CHANGED_PATH_REQUIRES_FULL_SUITE');
    families.add(family);
    mappedImplementationCount += 1;
  }
  if (mappedImplementationCount === 0) return fullSuite('NO_MAPPED_IMPLEMENTATION_CHANGE');
  const selected = new Set(CORE);
  for (const family of families) for (const test of GROUPS[family]) selected.add(test);
  const selectedTests = ordered(selected);
  return {
    schemaVersion:1,
    evidenceValid:true,
    selection:'IMPACT_SCOPED',
    reasons:[...families].sort().map(name => `IMPACT_FAMILY_${name.toUpperCase().replaceAll('-', '_')}`),
    selectedTests,
    commands:commandsFor(selectedTests),
  };
}
function cliError(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 1 && argv[0] === '--pretty') return null;
  return 'CLI_ARGUMENT_INVALID';
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return parseInput(chunks.join(''));
}
async function main() {
  const argError = cliError(process.argv.slice(2));
  let report;
  if (argError) report = fullSuite(argError, false);
  else {
    const input = await readStdin();
    report = input.error ? fullSuite(input.error, false) : selectSelftests(input.value);
  }
  console.log(JSON.stringify(report, null, process.argv.includes('--pretty') ? 2 : 0));
  console.error(`FULL_GATE_SELFTEST_SELECTION=${report.selection}`);
  if (!report.evidenceValid) process.exitCode = 2;
}
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await main();
