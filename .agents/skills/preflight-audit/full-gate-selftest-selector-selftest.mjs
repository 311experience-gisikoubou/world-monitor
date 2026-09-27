#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const selectorArg = process.argv[2];
if (!selectorArg) throw new Error('selector path required');
const selectorPath = resolve(selectorArg);
const selector = await import(pathToFileURL(selectorPath).href);
const classifier = await import(pathToFileURL(resolve(selectorPath, '..', 'fast-path-classifier.mjs')).href);
const live = classifier.observeLiveProjectContext();
if (live.result !== 'PROCEED') throw new Error('live project context required for selector selftest');
process.env.AI_ACTIVE_TASK_REPOSITORY=live.actualRepository;
process.env.AI_ACTIVE_PROJECT_CONTEXT_ID=live.projectContextId;
process.env.AI_ACTIVE_PROJECT_CONTEXT_FINGERPRINT=live.contextFingerprint;
const impactKeys = [
  'production','network','realDevice','installOrAdoption','dependency','securitySensitive','authOrCredential','mergeAuthority',
  'workflowOrDeployment','databaseOrMigration','externalDataRoute','recurringCost','lifecycle','businessPolicy','architecture',
];
function impacts(overrides = {}) {
  return Object.fromEntries(impactKeys.map(key => [key, overrides[key] ?? false]));
}
function projectGuard() { return { expectedRepository:live.actualRepository, expectedProjectIdentifier:live.projectContextId, expectedContextFingerprint:live.contextFingerprint, referenceRepository:null, targetIssueRepository:null, targetPrRepository:null, operationType:'product-implementation', route:{ selection:'not-applicable', selectedPathId:null, alternateReasonCode:null, alternateReason:null } }; }
function fixture(changedFiles, overrides = {}) {
  return { schemaVersion:3, evidenceComplete:true, changeClass:'implementation', dataMode:'source-only', executionScope:'local-dev', impacts:impacts(), changedFiles, wipReview:{ decision:'CONTINUE', evidenceFetchedAt:new Date(Date.now()-1000).toISOString() }, projectGuard:projectGuard(), ...overrides };
}
function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}
// Mirrors the selector's ordinary CORE (fast-path, security-preflight, full-gate-selector).
const CORE_SIZE = 3;
function select(files, overrides = {}) {
  return selector.selectSelftests(fixture(files, overrides));
}
const operationCodeOnly = select([
  '.agents/skills/preflight-audit/operation-preflight.mjs',
  '.agents/skills/preflight-audit/operation-preflight-selftest.mjs',
  'CHANGELOG.md','VERSION',
]);
assert(operationCodeOnly.selection === 'IMPACT_SCOPED', 'operation code-only change should be impact scoped');
assert(operationCodeOnly.commands.length === operationCodeOnly.selectedTests.length, 'commands must match selected test count');
assert(operationCodeOnly.commands.every((item,i) => item.id === operationCodeOnly.selectedTests[i] && item.argv[0] === 'node'), 'commands must align with selected tests');
for (const id of ['fast-path','security-preflight','full-gate-selector','operation-preflight']) {
  assert(operationCodeOnly.selectedTests.includes(id), `missing operation/core test ${id}`);
}
for (const id of ['merge-authorization','merge-execution']) {
  assert(!operationCodeOnly.selectedTests.includes(id), `merge-control test must not be in the ordinary CORE any more: ${id}`);
}
for (const id of ['claude-runner','foundation-update','stagnation','project-context','foundation-bootstrap']) {
  assert(!operationCodeOnly.selectedTests.includes(id), `unrelated slow test selected: ${id}`);
}
assert(operationCodeOnly.selectedTests.length === 4, `ordinary IMPACT_SCOPED CORE + one family should select exactly 4 tests, got ${operationCodeOnly.selectedTests.length}`);
assert(operationCodeOnly.selectedTestCount === operationCodeOnly.selectedTests.length, 'selectedTestCount must match selectedTests length');
assert(operationCodeOnly.reductionPercent > 0 && operationCodeOnly.reductionPercent <= 100, 'ordinary IMPACT_SCOPED reduction must be a positive percentage');

const operationWithSharedDoc = select([
  '.agents/skills/preflight-audit/operation-preflight.mjs',
  '.agents/skills/preflight-audit/SKILL.md',
]);
assert(operationWithSharedDoc.selection === 'IMPACT_SCOPED', 'ordinary instruction-only SKILL.md paired with mapped code must not force full suite');
assert(operationWithSharedDoc.selectedTests.includes('common-rule-health'), 'instruction-doc family must select common-rule-health');
assert(operationWithSharedDoc.selectedTests.includes('operation-preflight'), 'operation-preflight family must still be selected');
for (const id of ['merge-authorization','merge-execution']) {
  assert(!operationWithSharedDoc.selectedTests.includes(id), `generic instruction-doc change must not pull in merge-control test ${id}`);
}
const projectMemory = select(['.agents/skills/handoff/project-working-memory.mjs']);
assert(projectMemory.selection === 'IMPACT_SCOPED', 'project working memory code should be impact scoped');
for (const id of ['project-context','project-memory']) assert(projectMemory.selectedTests.includes(id), `project memory selection missing ${id}`);
const ruleHealth = select(['.agents/skills/common-rule-integration-audit/common-rule-health-audit.mjs']);
assert(ruleHealth.selection === 'IMPACT_SCOPED', 'common rule health code should be impact scoped');
assert(ruleHealth.selectedTests.includes('common-rule-health'), 'common rule health selftest missing');
const portfolioGovernance = select(['tools/portfolio-governance-audit.mjs']);
assert(portfolioGovernance.selection === 'IMPACT_SCOPED', 'portfolio governance code should be impact scoped');
for (const id of ['portfolio-governance','common-rule-health']) assert(portfolioGovernance.selectedTests.includes(id), `portfolio governance selection missing ${id}`);
const liveBase = select(['.agents/skills/preflight-audit/live-base-ref-guard.mjs']);
assert(liveBase.selection === 'IMPACT_SCOPED', 'live-base guard change should be impact scoped');
assert(liveBase.selectedTests.includes('live-base-ref'), 'live-base guard selftest missing');
const workStart = select(['.agents/skills/preflight-audit/work-start-guard.mjs']);
assert(workStart.selection === 'IMPACT_SCOPED', 'work-start guard change should be impact scoped');
assert(workStart.selectedTests.includes('work-start'), 'work-start guard selftest missing');
const actionsCost = select(['.agents/skills/preflight-audit/github-actions-cost-guard.mjs']);
assert(actionsCost.selection === 'IMPACT_SCOPED', 'Actions cost guard change should be impact scoped');
assert(actionsCost.selectedTests.includes('actions-cost'), 'Actions cost guard selftest missing');
const portfolio = select(['.agents/skills/preflight-audit/portfolio-health-observer.mjs']);
assert(portfolio.selection === 'IMPACT_SCOPED', 'portfolio observer should be impact scoped');
assert(portfolio.selectedTests.includes('portfolio-health'), 'portfolio observer selftest missing');
const turnWait = select(['.agents/skills/long-task-wait/turn-wait-budget.mjs']);
assert(turnWait.selection === 'IMPACT_SCOPED', 'turn wait budget should be impact scoped');
for (const id of ['long-task-wait','stagnation']) assert(turnWait.selectedTests.includes(id), `turn wait selection missing ${id}`);
const mergeReadiness = select(['.agents/skills/preflight-audit/cross-repo-merge-readiness.mjs']);
assert(mergeReadiness.selection === 'IMPACT_SCOPED', 'merge-readiness collector should be impact scoped');
assert(mergeReadiness.selectedTests.includes('merge-readiness'), 'merge-readiness selftest missing');
const mergeExecutionBatch = select(['.agents/skills/final-pr-audit/cross-repo-merge-execution-gate.mjs']);
assert(mergeExecutionBatch.selection === 'IMPACT_SCOPED', 'batch merge-execution gate should be impact scoped');
for (const id of ['merge-execution','merge-execution-batch']) assert(mergeExecutionBatch.selectedTests.includes(id), `batch merge-execution selection missing ${id}`);
const mergeExecutor = select(['.agents/skills/final-pr-audit/cross-repo-merge-executor.mjs']);
assert(mergeExecutor.selection === 'FULL_SUITE', 'merge executor is merge-authority high coupling and must use full suite');
assert(mergeExecutor.selectedTests.includes('merge-executor'), 'merge executor selftest missing');
assert(mergeExecutor.reasons.includes('HIGH_COUPLING_PATH_REQUIRES_FULL_SUITE'), 'merge executor high-coupling reason missing');
const routing = select(['.agents/skills/preflight-audit/ai-task-router.mjs']);
for (const id of ['ai-provider-inventory','ai-task-router','provider-qualification','provider-readiness']) {
  assert(routing.selectedTests.includes(id), `routing group missing ${id}`);
}
const implementationRunner = select(['.agents/skills/preflight-audit/implementation-runner.mjs']);
assert(implementationRunner.selection === 'IMPACT_SCOPED', 'implementation runner change should be impact scoped');
for (const id of ['implementation-runner','implementation-route-receipt','implementation-orchestrator','ai-provider-inventory','ai-task-router','provider-qualification','provider-readiness']) {
  assert(implementationRunner.selectedTests.includes(id), `implementation routing group missing ${id}`);
}
assert(!implementationRunner.selectedTests.includes('foundation-update'), 'implementation routing selection should not include unrelated foundation-update');
const implementationReceipt = select(['.agents/skills/preflight-audit/implementation-route-receipt.mjs']);
assert(implementationReceipt.selection === 'IMPACT_SCOPED', 'implementation route receipt change should be impact scoped');
assert(implementationReceipt.selectedTests.includes('implementation-route-receipt'), 'implementation route receipt selftest missing');
const implementationOrchestrator = select(['.agents/skills/preflight-audit/implementation-orchestrator.mjs']);
assert(implementationOrchestrator.selection === 'IMPACT_SCOPED', 'implementation orchestrator change should be impact scoped');
for (const id of ['implementation-runner','implementation-route-receipt','implementation-orchestrator']) {
  assert(implementationOrchestrator.selectedTests.includes(id), `implementation orchestrator selection missing ${id}`);
}
const foundation = select(['.agents/skills/foundation-sync-audit/foundation-update.mjs']);
for (const id of ['foundation-sync','foundation-bootstrap','foundation-update','foundation-remote-plan','foundation-batch-rollout']) {
  assert(foundation.selectedTests.includes(id), `foundation group missing ${id}`);
}
const batchRollout = select(['.agents/skills/foundation-sync-audit/foundation-batch-rollout-plan.mjs']);
assert(batchRollout.selection === 'IMPACT_SCOPED', 'batch rollout planner should be impact scoped');
for (const id of ['fast-path','security-preflight','full-gate-selector','foundation-sync','foundation-bootstrap','foundation-update','foundation-remote-plan','foundation-batch-rollout']) {
  assert(batchRollout.selectedTests.includes(id), `batch rollout selection missing ${id}`);
}
for (const id of ['merge-authorization','merge-execution']) {
  assert(!batchRollout.selectedTests.includes(id), `batch rollout selection must not pull in unrelated merge-control test ${id}`);
}
assert(!batchRollout.selectedTests.includes('claude-runner'), 'batch rollout selection should not include unrelated claude-runner');

// Instruction-only SKILL.md docs are scoped by family instead of forcing the full suite.
const handoffDoc = select(['.agents/skills/handoff/SKILL.md']);
assert(handoffDoc.selection === 'IMPACT_SCOPED', 'handoff skill documentation should be impact scoped, not full suite');
for (const id of ['common-rule-health','project-context','project-memory']) {
  assert(handoffDoc.selectedTests.includes(id), `handoff-doc family missing ${id}`);
}
assert(!handoffDoc.selectedTests.includes('merge-authorization'), 'handoff documentation must not pull in merge-control tests');
assert(handoffDoc.reasons.includes('IMPACT_FAMILY_HANDOFF_DOC'), 'handoff-doc family reason missing');

const mixedHandoffDoc = select([
  '.agents/skills/preflight-audit/operation-preflight.mjs',
  '.agents/skills/handoff/SKILL.md',
]);
assert(mixedHandoffDoc.selection === 'IMPACT_SCOPED', 'handoff skill documentation mixed with mapped code should be impact scoped');
for (const id of ['common-rule-health','project-context','project-memory','operation-preflight']) {
  assert(mixedHandoffDoc.selectedTests.includes(id), `mixed handoff selection missing ${id}`);
}

const mergeDocOnly = select(['.agents/skills/final-pr-audit/SKILL.md']);
assert(mergeDocOnly.selection === 'IMPACT_SCOPED', 'merge-control documentation should be impact scoped, not full suite');
for (const id of ['common-rule-health','merge-authorization','merge-execution']) {
  assert(mergeDocOnly.selectedTests.includes(id), `merge-control-doc family missing ${id}`);
}
assert(mergeDocOnly.reasons.includes('IMPACT_FAMILY_MERGE_CONTROL_DOC'), 'merge-control-doc family reason missing');

const mergeDoc = select([
  '.agents/skills/preflight-audit/operation-preflight.mjs',
  '.agents/skills/final-pr-audit/SKILL.md',
]);
assert(mergeDoc.selection === 'IMPACT_SCOPED', 'merge-control documentation mixed with mapped code should be impact scoped');
for (const id of ['common-rule-health','merge-authorization','merge-execution','operation-preflight']) {
  assert(mergeDoc.selectedTests.includes(id), `mixed merge-control doc selection missing ${id}`);
}

const verificationScope = select(['.agents/skills/test-gate/verification-scope-gate.mjs']);
assert(verificationScope.selection === 'IMPACT_SCOPED', 'verification-scope gate change should be impact scoped');
assert(verificationScope.selectedTests.includes('verification-scope'), 'verification-scope selftest missing');
assert(
  verificationScope.selectedTests.length === CORE_SIZE + 1,
  `verification-scope family should only add verification-scope on top of CORE, got ${JSON.stringify(verificationScope.selectedTests)}`,
);

const legacyAudit = select(['.agents/skills/preflight-audit/legacy-implementation-audit.mjs']);
assert(legacyAudit.selection === 'IMPACT_SCOPED', 'legacy-implementation-audit change should be impact scoped');
for (const id of ['legacy-implementation-audit','implementation-route-receipt']) {
  assert(legacyAudit.selectedTests.includes(id), `legacy-audit family missing ${id}`);
}
assert(
  legacyAudit.selectedTests.length === CORE_SIZE + 2,
  `legacy-audit family should only add legacy-implementation-audit + implementation-route-receipt on top of CORE, got ${JSON.stringify(legacyAudit.selectedTests)}`,
);
const declaredImpact = select(
  ['.agents/skills/preflight-audit/operation-preflight.mjs'],
  { impacts: impacts({ dependency:true }) },
);
assert(declaredImpact.selection === 'FULL_SUITE', 'declared impact must use full suite');
assert(declaredImpact.reasons.includes('DECLARED_IMPACT_REQUIRES_FULL_SUITE'), 'declared impact reason missing');
const architectureImpact = select(
  ['.agents/skills/preflight-audit/operation-preflight.mjs'],
  { impacts: impacts({ architecture:true }) },
);
assert(architectureImpact.selection === 'FULL_SUITE', 'architecture impact must use full suite');

const unknown = select(['.agents/skills/preflight-audit/new-unknown-gate.mjs']);
assert(unknown.selection === 'FULL_SUITE', 'unknown governance path must use full suite');
assert(unknown.reasons.includes('UNMAPPED_CHANGED_PATH_REQUIRES_FULL_SUITE'), 'unknown path reason missing');
const highCoupling = select(['.agents/skills/preflight-audit/fast-path-classifier.mjs']);
assert(highCoupling.selection === 'FULL_SUITE', 'fast-path classifier change must use full suite');
assert(highCoupling.selectedTests.length === highCoupling.commands.length && highCoupling.selectedTests.includes('work-start'), 'full suite must include the complete current selftest set');
assert(highCoupling.reasons.includes('HIGH_COUPLING_PATH_REQUIRES_FULL_SUITE'), 'high coupling reason missing');
for (const id of ['verification-scope','legacy-implementation-audit']) {
  assert(highCoupling.selectedTests.includes(id), `full suite must include newly registered test ${id}`);
}
assert(highCoupling.reductionPercent === 0, 'FULL_SUITE reductionPercent must be 0');
assert(highCoupling.selectedTestCount === highCoupling.selectedTests.length, 'FULL_SUITE selectedTestCount must match selectedTests length');
assert(highCoupling.fullSuiteTestCount === highCoupling.selectedTests.length, 'FULL_SUITE fullSuiteTestCount must equal ALL length');

const mergeAuthorizationCodeHighCoupling = select(['.agents/skills/final-pr-audit/merge-authorization-gate.mjs']);
assert(mergeAuthorizationCodeHighCoupling.selection === 'FULL_SUITE', 'actual merge-authorization gate code change must use full suite');
assert(mergeAuthorizationCodeHighCoupling.reasons.includes('HIGH_COUPLING_PATH_REQUIRES_FULL_SUITE'), 'merge-authorization gate high-coupling reason missing');

const docsOnly = select(['CHANGELOG.md','VERSION']);
assert(docsOnly.selection === 'METADATA_ONLY', 'metadata-only VERSION/CHANGELOG change must be a distinct METADATA_ONLY selection');
assert(docsOnly.evidenceValid === true, 'metadata-only selection must still report evidenceValid true');
assert(docsOnly.reasons.includes('METADATA_ONLY_NO_EXECUTABLE_SELFTEST_REQUIRED'), 'metadata-only reason missing');
assert(docsOnly.selectedTests.length === 0 && docsOnly.commands.length === 0, 'metadata-only selection must have zero selected tests/commands');
assert(docsOnly.selectedTestCount === 0, 'metadata-only selectedTestCount must be 0');
assert(docsOnly.reductionPercent === 100, 'metadata-only reductionPercent must be 100');
const changelogOnly = select(['CHANGELOG.md']);
assert(changelogOnly.selection === 'METADATA_ONLY', 'CHANGELOG.md-only change must be METADATA_ONLY');
const versionOnly = select(['VERSION']);
assert(versionOnly.selection === 'METADATA_ONLY', 'VERSION-only change must be METADATA_ONLY');

const skillOnly = select(['.agents/skills/preflight-audit/SKILL.md']);
assert(skillOnly.selection === 'IMPACT_SCOPED', 'generic instruction-only skill documentation should be scoped, not full suite');
assert(skillOnly.selectedTests.includes('common-rule-health'), 'instruction-doc family must select common-rule-health');
assert(
  skillOnly.selectedTests.length === CORE_SIZE + 1,
  `instruction-doc family should only add common-rule-health on top of CORE, got ${JSON.stringify(skillOnly.selectedTests)}`,
);
const incomplete = select(
  ['.agents/skills/preflight-audit/operation-preflight.mjs'],
  { evidenceComplete:false },
);
assert(incomplete.selection === 'FULL_SUITE' && incomplete.evidenceValid === true, 'incomplete evidence must safely use full suite');
const blockedWip = select(['.agents/skills/preflight-audit/operation-preflight.mjs'], { wipReview:{ decision:'STOP_NEW_WORK', evidenceFetchedAt:new Date(Date.now()-1000).toISOString() } });
assert(blockedWip.selection === 'FULL_SUITE' && blockedWip.evidenceValid === false, 'blocked WIP must stop before selftest selection');
assert(blockedWip.reasons.includes('WIP_REVIEW_BLOCKED'), 'blocked WIP reason missing');
const invalid = selector.selectSelftests({ schemaVersion:2 });
assert(invalid.selection === 'FULL_SUITE' && invalid.evidenceValid === false, 'invalid evidence must fail closed');
assert(invalid.reductionPercent === 0, 'invalid-evidence FULL_SUITE reductionPercent must be 0');

// Observability fields must be internally consistent on every result shape.
for (const result of [operationCodeOnly, handoffDoc, mergeDocOnly, verificationScope, legacyAudit, highCoupling, docsOnly, skillOnly]) {
  assert(Number.isInteger(result.selectedTestCount), 'selectedTestCount must be an integer');
  assert(Number.isInteger(result.fullSuiteTestCount) && result.fullSuiteTestCount > 0, 'fullSuiteTestCount must be a positive integer');
  assert(result.selectedTestCount === result.selectedTests.length, 'selectedTestCount must match selectedTests length');
  assert(result.reductionPercent >= 0 && result.reductionPercent <= 100, 'reductionPercent must be clamped 0..100');
  const expected = Math.min(100, Math.max(0, Math.round(((result.fullSuiteTestCount - result.selectedTestCount) / result.fullSuiteTestCount) * 100)));
  assert(result.reductionPercent === expected, `reductionPercent must match computed reduction, got ${result.reductionPercent} expected ${expected}`);
}

const cli = spawnSync(
  process.execPath,
  [selectorPath],
  { input:JSON.stringify(fixture(['.agents/skills/preflight-audit/operation-preflight.mjs'])), encoding:'utf8' },
);
assert(cli.status === 0, `selector CLI should pass: ${cli.stderr}`);
assert(JSON.parse(cli.stdout).selection === 'IMPACT_SCOPED', 'CLI selection mismatch');
const badCli = spawnSync(process.execPath, [selectorPath,'--bogus'], { input:'{}', encoding:'utf8' });
assert(badCli.status === 2, 'unsupported CLI args must exit 2');
console.log('full-gate-selftest-selector selftest: PASS');
