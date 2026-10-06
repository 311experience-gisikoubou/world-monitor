#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseInput, validateEvidence } from './fast-path-classifier.mjs';

const CORE = ['fast-path','security-preflight','full-gate-selector'];
const ALL = [
  'merge-authorization','merge-execution','merge-execution-batch','merge-executor','foundation-sync','foundation-bootstrap','foundation-update','foundation-remote-plan','foundation-batch-rollout',
  'project-context','project-memory','common-rule-health','portfolio-governance','live-base-ref','work-start','ai-capacity','ai-provider-inventory','ai-task-router','claude-runner','fast-path','operation-preflight','actions-cost',
  'provider-qualification','provider-readiness','security-history','security-preflight','stagnation','wip-observer','portfolio-health','long-task-wait','merge-readiness','real-device','human-visual-review',
  'implementation-runner','implementation-route-receipt','implementation-orchestrator','research-gate','environment-lifecycle',
  'agent-cycle','agent-job-bridge','apps-script-fixture','claude-job-launcher','claude-job-launcher-prompt-envelope',
  'verification-scope','legacy-implementation-audit',
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
  'work-start':['node','.agents/skills/preflight-audit/work-start-guard-selftest.mjs'],
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
  'human-visual-review':['node','.agents/skills/test-gate/human-visual-review-gate-selftest.mjs'],
  'implementation-runner':['node','.agents/skills/preflight-audit/implementation-runner-selftest.mjs','.agents/skills/preflight-audit/implementation-runner.mjs'],
  'implementation-route-receipt':['node','.agents/skills/preflight-audit/implementation-route-receipt-selftest.mjs','.agents/skills/preflight-audit/implementation-route-receipt.mjs'],
  'implementation-orchestrator':['node','.agents/skills/preflight-audit/implementation-orchestrator-selftest.mjs','.agents/skills/preflight-audit/implementation-orchestrator.mjs'],
  'research-gate':['node','.agents/skills/preflight-audit/research-gate-selftest.mjs','.agents/skills/preflight-audit/research-gate.mjs'],
  'environment-lifecycle':['node','.agents/skills/preflight-audit/environment-lifecycle-audit-selftest.mjs','.agents/skills/preflight-audit/environment-lifecycle-audit.mjs'],
  'agent-cycle':['node','.agents/skills/preflight-audit/agent-cycle-selftest.mjs','.agents/skills/preflight-audit/agent-cycle.mjs'],
  'agent-job-bridge':['node','.agents/skills/preflight-audit/agent-job-bridge-selftest.mjs','.agents/skills/preflight-audit/agent-job-bridge.mjs'],
  'apps-script-fixture':['node','.agents/skills/preflight-audit/fixtures/apps-script-ipad-safari-redirect-fixture-selftest.mjs','.agents/skills/preflight-audit/fixtures/apps-script-ipad-safari-redirect-fixture.mjs'],
  'claude-job-launcher':['node','.agents/skills/long-task-wait/claude-job-launcher-selftest.mjs'],
  'claude-job-launcher-prompt-envelope':['node','.agents/skills/long-task-wait/claude-job-launcher-prompt-envelope-selftest.mjs'],
  'verification-scope':['node','.agents/skills/test-gate/verification-scope-gate-selftest.mjs'],
  'legacy-implementation-audit':['node','.agents/skills/preflight-audit/legacy-implementation-audit-selftest.mjs','.agents/skills/preflight-audit/legacy-implementation-audit.mjs'],
  'full-gate-selector':['node','.agents/skills/preflight-audit/full-gate-selftest-selector-selftest.mjs','.agents/skills/preflight-audit/full-gate-selftest-selector.mjs'],
};
const GROUPS = {
  'operation-preflight':['operation-preflight','environment-lifecycle','apps-script-fixture'],
  'actions-cost':['actions-cost'],
  'claude-runner':['claude-runner'],
  'stagnation':['stagnation'],
  'project-context':['project-context','project-memory'],
  'common-rule-health':['common-rule-health'],
  'portfolio-governance':['portfolio-governance','common-rule-health'],
  'live-base-ref':['live-base-ref'],
  'work-start':['work-start'],
  'security-history':['security-history'],
  'security-preflight':['security-preflight'],
  'wip-observer':['wip-observer'],
  'portfolio-health':['portfolio-health'],
  'long-task-wait':['long-task-wait','stagnation','claude-job-launcher','claude-job-launcher-prompt-envelope'],
  'merge-readiness':['merge-readiness'],
  'merge-execution-batch':['merge-execution','merge-execution-batch'],
  'real-device':['real-device','human-visual-review'],
  'ai-capacity':['ai-capacity'],
  'ai-routing':['ai-provider-inventory','ai-task-router','provider-qualification','provider-readiness','research-gate'],
  'implementation-routing':['implementation-runner','implementation-route-receipt','implementation-orchestrator','ai-provider-inventory','ai-task-router','provider-qualification','provider-readiness','research-gate','apps-script-fixture'],
  'agent-orchestration':['agent-cycle','agent-job-bridge','implementation-orchestrator','research-gate'],
  'foundation-sync':['foundation-sync','foundation-bootstrap','foundation-update','foundation-remote-plan','foundation-batch-rollout'],
  'verification-scope':['verification-scope'],
  'legacy-audit':['legacy-implementation-audit','implementation-route-receipt'],
  'instruction-doc':['common-rule-health'],
  'merge-control-doc':['common-rule-health','merge-authorization','merge-execution'],
  'handoff-doc':['common-rule-health','project-context','project-memory'],
};
function pair(path, dir, stem) {
  return path === `${dir}/${stem}.mjs` || path === `${dir}/${stem}-selftest.mjs`;
}
function isNeutral(path) {
  return path === 'CHANGELOG.md' || path === 'VERSION';
}
function isMetadataOnly(changedFiles) {
  return changedFiles.length > 0 && changedFiles.every(isNeutral);
}
function isHighCoupling(path) {
  return pair(path,'.agents/skills/preflight-audit','full-gate-selftest-selector') ||
    pair(path,'.agents/skills/preflight-audit','fast-path-classifier') ||
    pair(path,'.agents/skills/final-pr-audit','merge-authorization-gate') ||
    pair(path,'.agents/skills/final-pr-audit','merge-execution-gate') ||
    pair(path,'.agents/skills/final-pr-audit','cross-repo-merge-executor') ||
    // research-gate.mjs is a shared dependency of implementation-orchestrator,
    // implementation-runner, implementation-route-receipt, and ai-task-router:
    // a change to it is treated like fast-path-classifier/merge-* -- broad
    // enough coupling that scoped selection cannot safely bound its blast radius.
    pair(path,'.agents/skills/preflight-audit','research-gate');
}
function familyFor(path) {
  const pre = '.agents/skills/preflight-audit';
  const foundation = '.agents/skills/foundation-sync-audit';
  if (pair(path,pre,'operation-preflight') || pair(path,pre,'environment-lifecycle-audit')) return 'operation-preflight';
  if (pair(path,pre,'github-actions-cost-guard')) return 'actions-cost';
  if (pair(path,pre,'claude-subscription-runner')) return 'claude-runner';
  if (pair(path,pre,'stagnation-watch')) return 'stagnation';
  if (pair(path,'.agents/skills/handoff','project-context-guard') || pair(path,'.agents/skills/handoff','project-working-memory')) return 'project-context';
  if (pair(path,'.agents/skills/common-rule-integration-audit','common-rule-health-audit')) return 'common-rule-health';
  if (path === 'tools/portfolio-governance-audit.mjs' || path === 'tools/portfolio-governance-audit-selftest.mjs') return 'portfolio-governance';
  if (pair(path,pre,'live-base-ref-guard')) return 'live-base-ref';
  if (pair(path,pre,'work-start-guard')) return 'work-start';
  if (pair(path,pre,'security-history-audit')) return 'security-history';
  if (pair(path,pre,'security-preflight')) return 'security-preflight';
  if (pair(path,pre,'wip-review-queue-observer')) return 'wip-observer';
  if (pair(path,pre,'portfolio-health-observer')) return 'portfolio-health';
  if (['bounded-task-wait','turn-wait-budget'].some(stem => pair(path,'.agents/skills/long-task-wait',stem))) return 'long-task-wait';
  if (pair(path,'.agents/skills/long-task-wait','long-task-wait')) return 'long-task-wait';
  if (path === '.agents/skills/long-task-wait/claude-job-launcher-selftest.mjs') return 'long-task-wait';
  if (path === '.agents/skills/long-task-wait/claude-job-launcher-prompt-envelope-selftest.mjs') return 'long-task-wait';
  if (['run-claude-job','claude-job-runner','claude-job-runner-selftest','check-claude-job','stop-claude-job','claude-job-retry-policy'].some(stem => path === `.agents/skills/long-task-wait/claude-job/${stem}.ps1`)) return 'long-task-wait';
  if (path === '.agents/skills/preflight-audit/fixtures/apps-script-ipad-safari-redirect-fixture.mjs' ||
      path === '.agents/skills/preflight-audit/fixtures/apps-script-ipad-safari-redirect-fixture-selftest.mjs') return 'implementation-routing';
  if (pair(path,pre,'agent-cycle') || pair(path,pre,'agent-job-bridge')) return 'agent-orchestration';
  if (pair(path,pre,'cross-repo-merge-readiness')) return 'merge-readiness';
  if (pair(path,'.agents/skills/final-pr-audit','cross-repo-merge-execution-gate')) return 'merge-execution-batch';
  if (pair(path,'.agents/skills/test-gate','real-device-preparation-gate') || pair(path,'.agents/skills/test-gate','human-visual-review-gate')) return 'real-device';
  if (pair(path,pre,'ai-capacity-observer')) return 'ai-capacity';
  if (['ai-provider-inventory','ai-task-router','provider-adapter-qualification','provider-adapter-readiness'].some(stem => pair(path,pre,stem))) return 'ai-routing';
  if (['implementation-runner','implementation-route-receipt','implementation-orchestrator'].some(stem => pair(path,pre,stem))) return 'implementation-routing';
  if (['foundation-sync-audit','foundation-bootstrap','foundation-update','foundation-remote-update-plan','foundation-batch-rollout-plan'].some(stem => pair(path,foundation,stem))) return 'foundation-sync';
  if (pair(path,'.agents/skills/test-gate','verification-scope-gate')) return 'verification-scope';
  if (pair(path,pre,'legacy-implementation-audit')) return 'legacy-audit';
  if (path === '.agents/skills/final-pr-audit/SKILL.md') return 'merge-control-doc';
  if (path === '.agents/skills/handoff/SKILL.md') return 'handoff-doc';
  if (/^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(path)) return 'instruction-doc';
  return null;
}
function ordered(ids) {
  const wanted = new Set(ids);
  return ALL.filter(id => wanted.has(id));
}
function commandsFor(ids) {
  return ids.map(id => ({ id, argv: [...COMMANDS[id]] }));
}
function withObservability(result) {
  const fullSuiteTestCount = ALL.length;
  const selectedTestCount = result.selectedTests.length;
  const raw = fullSuiteTestCount > 0 ? ((fullSuiteTestCount - selectedTestCount) / fullSuiteTestCount) * 100 : 0;
  const reductionPercent = Math.min(100, Math.max(0, Math.round(raw)));
  return { ...result, selectedTestCount, fullSuiteTestCount, reductionPercent };
}
function fullSuite(reason, evidenceValid = true) {
  return withObservability({ schemaVersion:1, evidenceValid, selection:'FULL_SUITE', reasons:[reason], selectedTests:[...ALL], commands:commandsFor(ALL) });
}
function metadataOnly() {
  return withObservability({ schemaVersion:1, evidenceValid:true, selection:'METADATA_ONLY', reasons:['METADATA_ONLY_NO_EXECUTABLE_SELFTEST_REQUIRED'], selectedTests:[], commands:[] });
}
export function selectSelftests(evidence) {
  const validationError = validateEvidence(evidence);
  if (validationError) return fullSuite(validationError, false);
  if (!evidence.evidenceComplete) return fullSuite('EVIDENCE_INCOMPLETE');
  if (Object.values(evidence.impacts).some(Boolean)) return fullSuite('DECLARED_IMPACT_REQUIRES_FULL_SUITE');
  if (isMetadataOnly(evidence.changedFiles)) return metadataOnly();

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
  return withObservability({
    schemaVersion:1,
    evidenceValid:true,
    selection:'IMPACT_SCOPED',
    reasons:[...families].sort().map(name => `IMPACT_FAMILY_${name.toUpperCase().replaceAll('-', '_')}`),
    selectedTests,
    commands:commandsFor(selectedTests),
  });
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
