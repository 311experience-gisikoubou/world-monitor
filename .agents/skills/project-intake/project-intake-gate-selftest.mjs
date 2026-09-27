#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  RISK_SIGNAL_KEYS,
  buildImplementationTaskPacket,
  computeIntakeProfile,
  decisionTopicForIntake,
  evaluateProjectIntake,
  normalizeIntakeBrief,
  renderIntakeBriefMarkdown,
  renderAiJobIssue,
} from './project-intake-gate.mjs';
import { validateOrchestrationTask } from '../preflight-audit/implementation-orchestrator.mjs';

function risk(overrides = {}) {
  return {
    protectedOrPatientData: false,
    externalCommunication: false,
    addedCostOrPaidUsage: false,
    authOrIdentity: false,
    productionImpact: false,
    realDataImpact: false,
    ...overrides,
  };
}
function option(overrides = {}) {
  return {
    id: 'reuse-existing',
    decision: 'REUSE_EXISTING',
    summary: 'Reuse the existing helper.',
    assessment: {
      safety: 'No new authority.',
      accuracy: 'Existing verified behavior.',
      simplicity: 'No new parts.',
      humanOperations: 'No extra steps.',
      maintenance: 'None added.',
      reversibility: 'Nothing to revert.',
      existingOverlap: 'Fully reuses existing.',
    },
    ...overrides,
  };
}
function review(overrides = {}) {
  return { options: [option()], selectedOptionId: 'reuse-existing', extendRationale: null, ...overrides };
}
function brief(overrides = {}) {
  return {
    schemaVersion: 1,
    intakeId: 'demo-intake',
    intent: 'Build a small local helper.',
    scope: 'Create only the approved source-only helper.',
    assumptions: [],
    humanQuestions: [],
    solutionReview: review(),
    riskSignals: risk(),
    status: 'DRAFT',
    decisionId: null,
    ...overrides,
  };
}
function manifest(status = 'CONFIRMED', { topic = decisionTopicForIntake('demo-intake'), source = 'EXPLICIT_HUMAN' } = {}) {
  return {
    schemaVersion: 1,
    projectContextId: 'demo-project',
    projectName: 'Demo Project',
    projectRootRepository: 'example/demo',
    finalObjective: 'Exercise project intake safely.',
    thisRepository: 'example/demo',
    repositoryRole: 'ROOT',
    canonicalContract: {
      schemaVersion: 1,
      contractId: 'demo-contract',
      contractVersion: '1',
      approved: true,
      artifacts: [{ id: 'governance-v1', kind: 'GOVERNANCE', slot: 'governance', status: 'CURRENT', sources: ['OPERATIONS.md'] }],
      protectedDecisions: [],
      requiredValidation: ['canonical-contract-gate', 'human-decision-sync'],
    },
    humanDecisionSync: {
      schemaVersion: 1,
      decisions: [{
        id: 'approve-demo-intake',
        topic,
        status,
        summary: 'Approve the bounded demo intake.',
        decidedAt: '2026-09-22',
        source,
        type: 'GOVERNANCE',
        replaces: null,
        artifactIds: [],
      }],
      currentState: 'The demo intake decision is tracked.',
      nextAction: 'Use only current confirmed authority.',
    },
  };
}

assert.equal(computeIntakeProfile(risk()), 'LIGHT');
for (const key of RISK_SIGNAL_KEYS) {
  assert.equal(computeIntakeProfile(risk({ [key]: true })), 'FULL', key + ' must force FULL');
}

const normalized = normalizeIntakeBrief(brief());
assert(normalized.value, 'empty assumptions are allowed when there are no AI assumptions');
assert.equal(normalizeIntakeBrief(brief({ assumptions: ['UNKNOWN'] })).error.code, 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(normalizeIntakeBrief({ ...brief(), extra: true }).error.code, 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(normalizeIntakeBrief(brief({ humanQuestions: ['q1', 'q2', 'q3', 'q4'] })).error.code, 'PROJECT_INTAKE_QUESTIONS_EXCEEDED');

const invalid = (sr) => normalizeIntakeBrief(brief({ solutionReview: sr })).error?.code;
assert.equal(normalizeIntakeBrief({ ...brief(), solutionReview: undefined }).error.code, 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(null), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ options: [] })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ options: ['a', 'b', 'c', 'd'].map((id) => option({ id })), selectedOptionId: 'a' })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ selectedOptionId: 'missing' })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ options: [option({ decision: 'REWRITE' })] })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ options: [option(), option()] })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ options: [option({ assessment: { ...option().assessment, safety: 'TBD' } })] })), 'PROJECT_INTAKE_BRIEF_INVALID');
const missingCriterion = option(); delete missingCriterion.assessment.reversibility;
assert.equal(invalid(review({ options: [missingCriterion] })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ extendRationale: 'not allowed for reuse' })), 'PROJECT_INTAKE_BRIEF_INVALID');
const extend = option({ id: 'extend', decision: 'EXTEND_REQUIRED', summary: 'Add a new gate.' });
assert.equal(invalid(review({ options: [extend], selectedOptionId: 'extend' })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ options: [extend], selectedOptionId: 'extend', extendRationale: 'UNKNOWN' })), 'PROJECT_INTAKE_BRIEF_INVALID');
assert.equal(invalid(review({ options: [extend], selectedOptionId: 'extend', extendRationale: 'Existing gates cannot express this check.' })), 'PROJECT_INTAKE_BRIEF_INVALID', 'single EXTEND_REQUIRED option with valid rationale fails closed');
assert(normalizeIntakeBrief(brief({ solutionReview: review({ options: [option(), extend], selectedOptionId: 'extend', extendRationale: 'Existing gates cannot express this check.' }) })).value, 'EXTEND_REQUIRED with rationale is accepted');
assert(normalizeIntakeBrief(brief({ solutionReview: review({ options: [option(), option({ id: 'min', decision: 'MINIMAL_CHANGE' }), option({ id: 'simp', decision: 'SIMPLIFY_EXISTING' })] }) })).value, 'three options are accepted');

const noDecision =evaluateProjectIntake(brief({ status: 'APPROVED' }));
assert.equal(noDecision.code, 'PROJECT_INTAKE_APPROVAL_REQUIRES_DECISION');
const approved = brief({ status: 'APPROVED', decisionId: 'approve-demo-intake' });
assert.equal(evaluateProjectIntake(approved).code, 'PROJECT_INTAKE_CONTEXT_REQUIRED');

for (const status of ['PROPOSED', 'UNRESOLVED', 'DEPRECATED']) {
  const source = status === 'PROPOSED' ? 'AI_PROPOSAL' : 'EXPLICIT_HUMAN';
  const out = evaluateProjectIntake(approved, manifest(status, { source }));
  assert.equal(out.result, 'STOP', status + ' must not authorize approval');
}
assert.equal(evaluateProjectIntake(approved, manifest('CONFIRMED', { topic: 'project-intake:other' })).code, 'PROJECT_INTAKE_DECISION_TOPIC_MISMATCH');

const accepted = evaluateProjectIntake(approved, manifest());
assert.equal(accepted.result, 'PROCEED');
assert.equal(accepted.profile, 'LIGHT');
assert.equal(accepted.decisionId, 'approve-demo-intake');
assert.match(accepted.humanDecisionFingerprint, /^[0-9a-f]{64}$/);

const rendered1 = renderIntakeBriefMarkdown(brief({ assumptions: ['Assume local-only operation.'] }));
const rendered2 = renderIntakeBriefMarkdown(brief({ assumptions: ['Assume local-only operation.'] }));
assert.equal(rendered1.result, 'PROCEED');
assert.equal(rendered1.markdown, rendered2.markdown);
assert(rendered1.markdown.includes('Profile: LIGHT'));
assert(rendered1.markdown.includes('## Solution Review'));

const packet = buildImplementationTaskPacket(approved, manifest());
assert.equal(packet.result, 'PROCEED');
assert.equal(packet.profile, 'LIGHT');
assert.equal(packet.approval.decisionId, 'approve-demo-intake');
assert.equal(packet.solutionReview.selectedOptionId, 'reuse-existing');
assert(packet.downstreamGates.preflightAudit.includes('preflight-audit'));
assert(packet.downstreamGates.implementationRouting.includes('implementation-orchestrator'));
assert(packet.downstreamGates.stagedReality.includes('staged-reality-gate'));
assert(packet.downstreamGates.finalPrAudit.includes('final-pr-audit'));
assert(packet.downstreamGates.humanDecisionSync.includes('human-decision-sync'));

function task(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'demo-task',
    kind: 'implementation',
    objective: 'Build a small local helper.',
    prompt: 'Implement the helper.\nKeep it small.',
    repoRoot: '/tmp/demo',
    branch: 'ai/demo',
    allowedScope: ['src/helper.mjs', 'docs/**'],
    forbiddenScope: ['.github/workflows/**'],
    doneConditions: ['Helper exists.'],
    requiredTests: ['node src/helper-selftest.mjs'],
    dataClass: 'source-only',
    repository: { owner: 'example', name: 'demo' },
    ...overrides,
  };
}
const jobCode = (t, b = approved) => renderAiJobIssue(b, manifest(), t).code;
const okTask = task();
assert.deepEqual(validateOrchestrationTask(okTask), [], 'fixture task must be a valid orchestrator payload');
{
  const job = renderAiJobIssue(approved, manifest(), okTask);
  assert.equal(job.result, 'PROCEED');
  for (const name of ['目的', '変更してよいパス', '完了条件', 'テストコマンド', '禁止事項']) assert(job.markdown.includes('## ' + name + '\n'), name);
  assert(job.markdown.includes('- src/helper.mjs\n- docs/**'));
  assert(job.markdown.includes('## テストコマンド\nnode src/helper-selftest.mjs\n'));
  assert.equal(job.markdown, renderAiJobIssue(approved, manifest(), okTask).markdown);
  assert.equal(renderAiJobIssue(brief(), manifest(), okTask).result, 'STOP', 'unapproved intake must not render');
  assert.equal(jobCode(task({ objective: 'Different objective.' })), 'PROJECT_INTAKE_JOB_OBJECTIVE_MISMATCH');
  {
    const escaped = renderAiJobIssue(approved, manifest(), task({ prompt: 'ok\n## injected\n  ### two\n<!-- c -->' }));
    assert.equal(escaped.result, 'PROCEED');
    assert(escaped.markdown.includes('> ## injected\n> ' + '  ### two\n&lt;!-- c --&gt;'));
    assert.equal(escaped.markdown.split('\n').filter((l) => /^\s*#{2,3}(?:\s|#|$)/u.test(l)).length, 5, 'only the 5 poller headings remain');
    assert.equal(escaped.markdown, renderAiJobIssue(approved, manifest(), task({ prompt: 'ok\n## injected\n  ### two\n<!-- c -->' })).markdown);
  }
  assert.equal(jobCode(task({ prompt: 'ok\u0001bad' })), 'PROJECT_INTAKE_JOB_PROMPT_UNSAFE');
  for (const doneConditions of [undefined, []]) {
    const noDone = renderAiJobIssue(approved, manifest(), task({ doneConditions }));
    assert.equal(noDone.result, 'PROCEED');
    assert(noDone.markdown.includes('## 完了条件\n- Source edits are limited to allowedScope.\n'));
  }
  assert.equal(jobCode(task({ requiredTests: [] })), 'PROJECT_INTAKE_JOB_TEST_COMMAND_INVALID');
  assert.equal(jobCode(task({ requiredTests: ['a', 'b'] })), 'PROJECT_INTAKE_JOB_TEST_COMMAND_INVALID');
  assert.equal(jobCode(task({ requiredTests: ['a\nb'] })), 'PROJECT_INTAKE_JOB_TEST_COMMAND_INVALID');
  assert.equal(jobCode(task({ requiredTests: ['なし'] })), 'PROJECT_INTAKE_JOB_TEST_COMMAND_INVALID');
  for (const forbiddenScope of [[], undefined]) {
    const noForbidden = renderAiJobIssue(approved, manifest(), task({ forbiddenScope }));
    assert.equal(noForbidden.result, 'PROCEED');
    assert(noForbidden.markdown.includes('## 禁止事項\n- 変更許可パス外を変更しない\n'));
  }
  assert.equal(jobCode(task({ forbiddenScope: ['.git/**'] })), 'PROJECT_INTAKE_JOB_FORBIDDEN_SCOPE_REQUIRED');
  assert.equal(jobCode(task({ allowedScope: ['.git/**'] })), 'PROJECT_INTAKE_JOB_ALLOWED_SCOPE_INVALID');
  assert.equal(jobCode(task({ extra: 1 })), 'PROJECT_INTAKE_JOB_TASK_INVALID');
}

console.log('project-intake-gate selftest: PASS');
