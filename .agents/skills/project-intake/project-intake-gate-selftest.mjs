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
} from './project-intake-gate.mjs';

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
function brief(overrides = {}) {
  return {
    schemaVersion: 1,
    intakeId: 'demo-intake',
    intent: 'Build a small local helper.',
    scope: 'Create only the approved source-only helper.',
    assumptions: [],
    humanQuestions: [],
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

const noDecision = evaluateProjectIntake(brief({ status: 'APPROVED' }));
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

const packet = buildImplementationTaskPacket(approved, manifest());
assert.equal(packet.result, 'PROCEED');
assert.equal(packet.profile, 'LIGHT');
assert.equal(packet.approval.decisionId, 'approve-demo-intake');
assert(packet.downstreamGates.preflightAudit.includes('preflight-audit'));
assert(packet.downstreamGates.implementationRouting.includes('implementation-orchestrator'));
assert(packet.downstreamGates.stagedReality.includes('staged-reality-gate'));
assert(packet.downstreamGates.finalPrAudit.includes('final-pr-audit'));
assert(packet.downstreamGates.humanDecisionSync.includes('human-decision-sync'));

console.log('project-intake-gate selftest: PASS');
