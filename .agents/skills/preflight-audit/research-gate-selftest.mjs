#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('research-gate path required');
const gateUrl = pathToFileURL(path.resolve(gateArg)).href;
const {
  evaluateResearchGate,
  evaluateResearchGateBound,
  validateResearchGateInput,
  computeConstraintsDigest,
  blocksSourceWrite,
  CHECKLIST_IDS,
  MINIMAL_BYPASS_CHECKLIST_IDS,
  TRIGGER_KEYS,
} = await import(gateUrl);

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

// A single deterministic injected "now" used by every evaluator call below.
// Production code still defaults to the real clock when the caller omits
// `nowUtcMs`; only this test wrapper forces a fixed instant so a fixture
// authored against a fixed `assessedAtUtcMs` never goes stale purely
// because wall-clock time has moved on since the fixture was written. This
// is a test-isolation device, never a weakening of the production clock.
const NOW = 1_759_564_800_000; // fixed reference instant
const DAY = 24 * 60 * 60 * 1000;

function evaluate(input, expected = {}) {
  return evaluateResearchGate(input, { nowUtcMs: NOW, ...expected });
}

function noTriggers() {
  const out = {};
  for (const key of TRIGGER_KEYS) out[key] = false;
  return out;
}
function triggersWith(...activeKeys) {
  const out = noTriggers();
  for (const key of activeKeys) out[key] = true;
  return out;
}
function binding(overrides = {}) {
  const constraints = overrides.constraints ?? [];
  return {
    taskId: 'task-1',
    proposalId: 'proposal-1',
    repository: { owner: 'acme', name: 'widgets' },
    scope: ['src/feature/**'],
    constraints,
    constraintsDigestSha256: computeConstraintsDigest(constraints),
    assessedAtUtcMs: NOW,
    maxEvidenceAgeMs: DAY,
    ...overrides,
    ...(overrides.constraints ? { constraintsDigestSha256: overrides.constraintsDigestSha256 ?? computeConstraintsDigest(overrides.constraints) } : {}),
  };
}
function fullExpected(overrides = {}) {
  return {
    taskId: 'task-1',
    proposalId: 'proposal-1',
    repository: { owner: 'acme', name: 'widgets' },
    scope: ['src/feature/**'],
    constraints: [],
    nowUtcMs: NOW,
    ...overrides,
  };
}
function checklistItem(id, status, extra = {}) {
  const applicable = extra.applicable !== undefined ? extra.applicable : true;
  const base = { id, status, applicable, justification: `Justification for ${id}.` };
  if (applicable === true && (status === 'PASS' || status === 'FAIL')) base.primarySourceRef = 'https://example.invalid/evidence';
  if (applicable === false) base.inapplicableReason = `Not applicable for ${id} in this scenario.`;
  return { ...base, ...extra };
}
function fullChecklist(overrideMap = {}) {
  return CHECKLIST_IDS.map((id) => {
    const override = overrideMap[id];
    if (!override) return checklistItem(id, 'PASS');
    const status = override.applicable === false ? 'UNKNOWN' : (override.status ?? 'PASS');
    return checklistItem(id, status, override);
  });
}
function minimalChecklist(overrideMap = {}) {
  return MINIMAL_BYPASS_CHECKLIST_IDS.map((id) => {
    const override = overrideMap[id];
    if (!override) return checklistItem(id, 'PASS');
    const status = override.applicable === false ? 'UNKNOWN' : (override.status ?? 'PASS');
    return checklistItem(id, status, override);
  });
}
function noTriggerAssessment(reasonCode = 'PURE_CSS_OR_TEXT_CHANGE') {
  return { reasonCode, justification: 'No risk signal is present for this bounded local edit.' };
}
function deepResearchEvidence(primaryProvider, adversarialProvider, rationale) {
  return {
    primary: {
      providerId: primaryProvider,
      researchSessionRef: `research-session://primary/${primaryProvider}`,
      evidenceRef: 'research-note://primary',
    },
    adversarial: {
      present: true,
      providerId: adversarialProvider,
      researchSessionRef: `research-session://adversarial/${adversarialProvider}`,
      distinctFromPrimary: adversarialProvider !== primaryProvider,
      evidenceRef: 'research-note://adversarial',
      ...(adversarialProvider === primaryProvider ? { sameProviderRationale: rationale } : {}),
    },
  };
}
function baseInput(overrides = {}) {
  return {
    schemaVersion: 1,
    evidenceBinding: binding(),
    triggers: noTriggers(),
    noTriggerAssessment: noTriggerAssessment(),
    checklist: minimalChecklist(),
    humanTopConditions: [],
    deepResearch: null,
    ...overrides,
  };
}
function humanBasicResearcher(researcherId = 'human-reviewer-1') {
  return { researcherId, kind: 'HUMAN' };
}
function aiBasicResearcher(researcherId = 'provider-a', researchSessionRef = 'research-session://basic/provider-a') {
  return { researcherId, kind: 'AI_PROVIDER', researchSessionRef };
}

// --- Case C: pure CSS/text change bypasses research workload, not minimum safety ---
{
  const result = evaluate(baseInput());
  assert(result.result === 'BYPASS_LIGHT', `case C must bypass research workload: ${JSON.stringify(result)}`);
  assert(result.triggered === false, 'case C must not be triggered');
  assert(!blocksSourceWrite(result), 'BYPASS_LIGHT must not block source write');
}

// --- Case C negative: no-trigger bypass still enforces minimum safety ---
{
  const result = evaluate(baseInput({
    checklist: minimalChecklist({ safety: { status: 'FAIL' } }),
  }));
  assert(result.result === 'REJECT', `minimum safety FAIL must still REJECT on the bypass path: ${JSON.stringify(result)}`);
}

// --- Case A: Drive+iPad videos, free, triggered, all clear -> ADOPT ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    evidenceBinding: binding({ constraints: ['zero-additional-cost', 'billing-account-not-allowed'] }),
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ billingAccount: { requiresBillingAccount: false } }),
    humanTopConditions: [
      { id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' },
      { id: 'BILLING_ACCOUNT_NOT_ALLOWED', active: true, statement: 'No billing account may be created.' },
    ],
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.result === 'ADOPT', `case A free required path must ADOPT: ${JSON.stringify(result)}`);
}

// --- Case B: new simple local Python library needs basic Research, not Deep Research ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(result.deepResearchRequired === false, `local-low-risk library must not force deep research: ${JSON.stringify(result)}`);
  assert(result.result === 'ADOPT', `clean local-low-risk library matrix must ADOPT on basic research alone: ${JSON.stringify(result)}`);
  assert(result.report.basicResearcher?.researcherId === 'provider-a', 'report must honestly record the actual basic researcher');
}
// --- Basic (non-deep) triggered research must record its actual researcher, never claim a nonexistent provider execution ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const missing = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: null,
  }));
  assert(missing.result === 'STOP' && missing.code === 'SCHEMA_INVALID', `triggered basic research without a recorded researcher must STOP: ${JSON.stringify(missing)}`);

  const human = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: null,
    basicResearcher: humanBasicResearcher(),
  }));
  assert(human.result === 'ADOPT', `a human-performed basic research record must be accepted: ${JSON.stringify(human)}`);

  const aiWithoutSession = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: null,
    basicResearcher: { researcherId: 'provider-a', kind: 'AI_PROVIDER' },
  }));
  assert(aiWithoutSession.result === 'STOP' && aiWithoutSession.code === 'SCHEMA_INVALID',
    'an AI_PROVIDER basic researcher without a researchSessionRef must STOP, never implied execution');

  const forbidden = evaluate(baseInput());
  assert(forbidden.result === 'BYPASS_LIGHT', 'baseline sanity: untriggered bypass unaffected by basicResearcher');
  const forbiddenWithResearcher = evaluate(baseInput({ basicResearcher: humanBasicResearcher() }));
  assert(forbiddenWithResearcher.result === 'STOP' && forbiddenWithResearcher.code === 'SCHEMA_INVALID',
    'basicResearcher must be forbidden when not triggered');
}
// --- Case B: existing substitute overlap (existingOverlap FAIL) must REJECT a new install, even on the basic-research path ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ existingOverlap: { status: 'FAIL' }, security: { status: 'UNKNOWN', primarySourceRef: undefined } }),
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(result.result === 'REJECT', `case B existing-substitute overlap must REJECT: ${JSON.stringify(result)}`);
}
// --- Case B: a high-risk/external library profile still requires Deep-Research-equivalent evidence ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const missingDeep = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: null,
  }));
  assert(missingDeep.result === 'STOP' && missingDeep.code === 'SCHEMA_INVALID', `external/high-risk library profile must require deepResearch evidence: ${JSON.stringify(missingDeep)}`);
  const withDeep = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(withDeep.result === 'ADOPT' && withDeep.deepResearchRequired === true, `external/high-risk library profile with adversarial evidence must ADOPT: ${JSON.stringify(withDeep)}`);
}
// --- Library risk profile is schema-closed to its own trigger ---
{
  const forbidden = evaluate(baseInput({ newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK' }));
  assert(forbidden.result === 'STOP' && forbidden.code === 'SCHEMA_INVALID', 'library risk profile must be forbidden when its trigger is absent');
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const missingProfile = evaluate(baseInput({ triggers, noTriggerAssessment: null, checklist: fullChecklist(), deepResearch: null }));
  assert(missingProfile.result === 'STOP' && missingProfile.code === 'SCHEMA_INVALID', 'library risk profile must be required once its trigger is active');
}
// --- Protected-data/security/auth triggers cannot hide behind the library's simple risk profile ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount', 'protectedMedicalData');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: {
      primary: { providerId: 'provider-a', researchSessionRef: 'research-session://primary/provider-a', evidenceRef: 'research-note://primary' },
      adversarial: { present: false },
    },
  }));
  assert(result.deepResearchRequired === true, `protectedMedicalData must force deep research regardless of library profile: ${JSON.stringify(result)}`);
  assert(result.result === 'STOP' && result.code === 'ADVERSARIAL_RESEARCH_EVIDENCE_MISSING', 'protected-data trigger must still STOP without adversarial evidence');
}

// --- Case D: Firebase-style costs vs explicit zero-cost + billing-not-allowed top conditions -> REJECT ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount', 'feeOrFreeQuota');
  const result = evaluate(baseInput({
    evidenceBinding: binding({ constraints: ['zero-additional-cost', 'billing-account-not-allowed'] }),
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ billingAccount: { status: 'FAIL', requiresBillingAccount: true } }),
    humanTopConditions: [
      { id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' },
      { id: 'BILLING_ACCOUNT_NOT_ALLOWED', active: true, statement: 'No billing account may be created.' },
    ],
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.result === 'REJECT', `case D billing conflict must REJECT: ${JSON.stringify(result)}`);
  assert(['CHECKLIST_FAIL_PRESENT', 'TOP_CONDITION_BILLING_REQUIRED_CONFLICT', 'TOP_CONDITION_ZERO_COST_BILLING_CONFLICT'].includes(result.code),
    `case D must report a billing conflict code: ${result.code}`);
}

// --- Case D variant: billing account required but top conditions do not forbid it -> no generic universal FAIL ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount', 'feeOrFreeQuota');
  const result = evaluate(baseInput({
    evidenceBinding: binding({ constraints: ['included-quota-only'] }),
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ billingAccount: { requiresBillingAccount: true } }),
    humanTopConditions: [],
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.result === 'ADOPT', `billing account requirement alone (no explicit top condition) must not auto-REJECT: ${JSON.stringify(result)}`);
}

// --- BILLING_ACCOUNT_NOT_ALLOWED alone (without ZERO_ADDITIONAL_COST) must still REJECT a billing-required service ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ billingAccount: { requiresBillingAccount: true } }),
    humanTopConditions: [
      { id: 'BILLING_ACCOUNT_NOT_ALLOWED', active: true, statement: 'No billing account may be created.' },
    ],
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(result.result === 'REJECT' && result.code === 'TOP_CONDITION_BILLING_REQUIRED_CONFLICT',
    `billing-account-not-allowed alone must reject a billing-required service: ${JSON.stringify(result)}`);
}

// --- ZERO_ADDITIONAL_COST alone must reject on ACTUAL charge evidence (additionalCost/freeTier/automaticBilling FAIL), never on billing-account presence alone ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ additionalCost: { status: 'FAIL' } }),
    humanTopConditions: [
      { id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' },
    ],
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(result.result === 'REJECT' && result.code === 'TOP_CONDITION_ZERO_COST_CHARGE_EVIDENCE_CONFLICT',
    `zero-additional-cost alone must reject on actual charge evidence: ${JSON.stringify(result)}`);
}

// --- A billing account requirement ALONE (no actual charge evidence) must never be inferred as an actual charge for ZERO_ADDITIONAL_COST; account creation is a separate human gate ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ billingAccount: { requiresBillingAccount: true } }),
    humanTopConditions: [
      { id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' },
    ],
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(result.result === 'ADOPT',
    `a billing-account requirement alone must never be inferred as an actual charge for ZERO_ADDITIONAL_COST: ${JSON.stringify(result)}`);
}

// --- The user's strict no-billing scenario needs BOTH an explicit zero-cost condition and a no-billing-account condition ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ billingAccount: { requiresBillingAccount: true } }),
    humanTopConditions: [
      { id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' },
      { id: 'BILLING_ACCOUNT_NOT_ALLOWED', active: true, statement: 'No billing account may be created.' },
    ],
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(result.result === 'REJECT' && result.code === 'TOP_CONDITION_BILLING_REQUIRED_CONFLICT',
    `strict no-billing scenario (both conditions active) must reject a billing-required service via the explicit no-billing condition: ${JSON.stringify(result)}`);
}

// --- An active top condition cannot be bypassed by marking its relevant row inapplicable ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const costBypass = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ billingAccount: { applicable: false } }),
    humanTopConditions: [{ id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' }],
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(costBypass.result === 'REJECT' && costBypass.code === 'TOP_CONDITION_ZERO_ADDITIONAL_COST_ROW_MARKED_INAPPLICABLE',
    `marking billingAccount inapplicable must not bypass ZERO_ADDITIONAL_COST: ${JSON.stringify(costBypass)}`);

  // feeOrFreeQuota (not a privacy/security-sensitive trigger) is used here so
  // this exercises the top-condition-level inapplicable-row bypass check in
  // isolation, distinct from the schema-level mandatory-applicability rule
  // for protectedMedicalData/auth-network-privacy-security triggers below.
  const privacyBypass = evaluate(baseInput({
    triggers: triggersWith('feeOrFreeQuota'),
    noTriggerAssessment: null,
    checklist: fullChecklist({ privacy: { applicable: false } }),
    humanTopConditions: [{ id: 'NO_PROTECTED_DATA_PERMITTED', active: true, statement: 'No protected data may be used.' }],
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(privacyBypass.result === 'REJECT' && privacyBypass.code === 'TOP_CONDITION_NO_PROTECTED_DATA_PERMITTED_ROW_MARKED_INAPPLICABLE',
    `marking privacy inapplicable must not bypass NO_PROTECTED_DATA_PERMITTED: ${JSON.stringify(privacyBypass)}`);
}

// --- A sensitive trigger (protectedMedicalData / auth-network-privacy-security) can never have its privacy/security rows declared inapplicable, schema-closed ---
{
  const triggers = triggersWith('protectedMedicalData');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist({ privacy: { applicable: false } }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.result === 'STOP' && result.code === 'SCHEMA_INVALID',
    `protectedMedicalData must force privacy row applicability, schema-closed: ${JSON.stringify(result)}`);
}

// --- NO_PROTECTED_DATA_PERMITTED directly contradicts a declared protectedMedicalData change; all-PASS rows cannot resolve the contradiction ---
{
  const triggers = triggersWith('protectedMedicalData');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    humanTopConditions: [{ id: 'NO_PROTECTED_DATA_PERMITTED', active: true, statement: 'No protected data may be used.' }],
    deepResearch: { primary: { providerId: 'provider-a', researchSessionRef: 'research-session://primary/provider-a', evidenceRef: 'research-note://primary' }, adversarial: { present: false } },
  }));
  assert(result.result === 'REJECT' && result.code === 'TOP_CONDITION_NO_PROTECTED_DATA_PERMITTED_CONTRADICTS_TRIGGER',
    `a protectedMedicalData change under NO_PROTECTED_DATA_PERMITTED must reject even with all-PASS rows: ${JSON.stringify(result)}`);
}

// --- The three mandatory minimum rows (safety/dataPreservation/existingOverlap) can never ALL be declared inapplicable to manufacture a BYPASS_LIGHT ---
{
  const result = evaluate(baseInput({
    checklist: minimalChecklist({
      safety: { applicable: false },
      dataPreservation: { applicable: false },
      existingOverlap: { applicable: false },
    }),
  }));
  assert(result.result === 'STOP' && result.code === 'SCHEMA_INVALID',
    `all three mandatory minimum rows marked inapplicable must never produce BYPASS_LIGHT: ${JSON.stringify(result)}`);
}

// --- The primary and adversarial researchSessionRef must differ, even under the same-provider fallback: names alone are not authenticated execution proof ---
{
  const triggers = triggersWith('protectedMedicalData');
  const sharedSession = 'research-session://shared/provider-a';
  const sameProviderSameSession = validateResearchGateInput({
    ...baseInput({ triggers, noTriggerAssessment: null, checklist: fullChecklist() }),
    deepResearch: {
      primary: { providerId: 'provider-a', researchSessionRef: sharedSession, evidenceRef: 'research-note://primary' },
      adversarial: { present: true, providerId: 'provider-a', researchSessionRef: sharedSession, distinctFromPrimary: false, sameProviderRationale: 'Only one provider available.', evidenceRef: 'research-note://adversarial' },
    },
  });
  assert(sameProviderSameSession.includes('deepResearch_adversarial_researchSessionRef_not_distinct_from_primary'),
    `reusing the exact same session for primary and adversarial (even same-provider) must fail schema closed: ${sameProviderSameSession}`);

  const differentProviderSameSession = validateResearchGateInput({
    ...baseInput({ triggers, noTriggerAssessment: null, checklist: fullChecklist() }),
    deepResearch: {
      primary: { providerId: 'provider-a', researchSessionRef: sharedSession, evidenceRef: 'research-note://primary' },
      adversarial: { present: true, providerId: 'provider-b', researchSessionRef: sharedSession, distinctFromPrimary: true, evidenceRef: 'research-note://adversarial' },
    },
  });
  assert(differentProviderSameSession.includes('deepResearch_adversarial_researchSessionRef_not_distinct_from_primary'),
    `a shared session reference must fail schema closed even across different providers: ${differentProviderSameSession}`);
}

// --- A human top condition of kind OTHER is never silently ignored, and never silently adopted unevaluated ---
{
  // Must be schema-linked to an existing checklist criterion.
  const unlinked = validateResearchGateInput({
    ...baseInput({ humanTopConditions: [{ id: 'OTHER', active: true, statement: 'Must stay inside the EU region.' }] }),
  });
  assert(unlinked.includes('topCondition_other_linkedChecklistId_required'),
    `an active OTHER condition without a linkedChecklistId must fail schema closed: ${unlinked}`);

  // Linked to an evaluated (applicable) row: surfaced, never blocking an otherwise clean matrix.
  const result = evaluate(baseInput({
    humanTopConditions: [{ id: 'OTHER', active: true, statement: 'Must stay inside the EU region.', linkedChecklistId: 'safety' }],
  }));
  assert(result.result === 'BYPASS_LIGHT', `an unrelated but evaluated OTHER condition must not block an otherwise clean matrix: ${JSON.stringify(result)}`);
  assert(result.decisionBasis.some((line) => line.includes('Must stay inside the EU region.')),
    `OTHER top condition statement must be surfaced, never silently dropped: ${JSON.stringify(result.decisionBasis)}`);

  // Linked to a row that was never evaluated (inapplicable): must block, never silently adopt.
  // (osBrowserCompatibility is used here, with deep-research evidence supplied, because the
  // no-trigger path's three mandatory minimum rows can never themselves be inapplicable.)
  const unevaluated = evaluate(baseInput({
    triggers: triggersWith('osBrowserCompatibility'),
    noTriggerAssessment: null,
    checklist: fullChecklist({ maintenance: { applicable: false } }),
    humanTopConditions: [{ id: 'OTHER', active: true, statement: 'Must stay inside the EU region.', linkedChecklistId: 'maintenance' }],
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(unevaluated.result === 'REJECT' && unevaluated.code === 'TOP_CONDITION_OTHER_UNEVALUATED',
    `an OTHER condition linked to a never-evaluated row must reject, not silently adopt: ${JSON.stringify(unevaluated)}`);
}

// --- Case B: existing substitute overlap (existingOverlap FAIL) must REJECT a new install ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const result = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist({ existingOverlap: { status: 'FAIL' }, security: { status: 'UNKNOWN', primarySourceRef: undefined } }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.result === 'REJECT', `case B existing-substitute overlap must REJECT: ${JSON.stringify(result)}`);
}

// --- Mixed FAIL + UNKNOWN: FAIL must win over TRIAL_REQUIRED ---
{
  const triggers = triggersWith('authNetworkPrivacySecurityEncryptionBackupStorageChange');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist({
      security: { status: 'FAIL' },
      privacy: { status: 'UNKNOWN', primarySourceRef: undefined },
    }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.result === 'REJECT', `FAIL must win over UNKNOWN: ${JSON.stringify(result)}`);
}

// --- Case F: a raw FAIL blocks BEFORE provider invocation and again at the final receipt re-check, from the same raw evidence ---
{
  const triggers = triggersWith('authNetworkPrivacySecurityEncryptionBackupStorageChange');
  const input = baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist({ security: { status: 'FAIL' } }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  });
  const preProviderInvocation = evaluate(input);
  const finalReceiptRecheck = evaluate(input);
  assert(blocksSourceWrite(preProviderInvocation), 'FAIL must block before provider invocation');
  assert(blocksSourceWrite(finalReceiptRecheck), 'FAIL must still block the final receipt re-check of the same raw evidence');
  assert(preProviderInvocation.code === 'CHECKLIST_FAIL_PRESENT' && finalReceiptRecheck.code === 'CHECKLIST_FAIL_PRESENT',
    'FAIL precedence must be deterministic across both checkpoints');
}

// --- FAIL takes precedence over an unrun second/adversarial research pass: a second AI not having run yet must never downgrade a FAIL to a trial suggestion ---
{
  const triggers = triggersWith('protectedMedicalData');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist({ security: { status: 'FAIL' } }),
    deepResearch: {
      primary: { providerId: 'provider-a', researchSessionRef: 'research-session://primary/provider-a', evidenceRef: 'research-note://primary' },
      adversarial: { present: false },
    },
  }));
  assert(result.result === 'REJECT' && result.code === 'CHECKLIST_FAIL_PRESENT',
    `FAIL must out-rank the missing-adversarial-evidence STOP, not be softened into a trial: ${JSON.stringify(result)}`);
}

// --- Case E: GAS anonymous Safari/multi-login, unsupported fact -> UNKNOWN -> TRIAL_REQUIRED, synthetic only ---
{
  const triggers = triggersWith('authNetworkPrivacySecurityEncryptionBackupStorageChange', 'osBrowserCompatibility');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist({ auth: { status: 'UNKNOWN', primarySourceRef: undefined } }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.result === 'TRIAL_REQUIRED', `case E unsupported fact must require a bounded trial: ${JSON.stringify(result)}`);
  assert(result.trialAuthorization.permitted === true, 'trial must be permitted');
  assert(result.trialAuthorization.scope === 'SYNTHETIC_BOUNDED_MINIMAL_ONLY', 'trial must be synthetic/bounded/minimal only');
  assert(result.trialAuthorization.generalImplementationAuthorized === false, 'trial must never authorize general implementation');
  assert(result.trialAuthorization.realDataPermitted === false, 'trial must never permit real data');
}

// --- Security/privacy UNKNOWN never permits real data (flag surfaced even on an otherwise clean matrix) ---
{
  const triggers = triggersWith('authNetworkPrivacySecurityEncryptionBackupStorageChange');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist({ privacy: { status: 'UNKNOWN', primarySourceRef: undefined } }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.securityOrPrivacyUnknown === true, 'privacy UNKNOWN must be flagged');
  assert(result.trialAuthorization.realDataPermitted === false, 'real data must never be permitted on UNKNOWN security/privacy');
}

// --- An inapplicable (not merely UNKNOWN) privacy/security row must not itself raise the UNKNOWN flag or require a trial ---
// (feeOrFreeQuota is used here, not a protectedMedicalData/auth-network-privacy-security
// trigger, because those sensitive triggers now mandate privacy/security applicability.)
{
  const triggers = triggersWith('feeOrFreeQuota');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist({ privacy: { applicable: false } }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(result.securityOrPrivacyUnknown === false, `a genuinely inapplicable privacy row must not be flagged as UNKNOWN: ${JSON.stringify(result)}`);
  assert(result.result === 'ADOPT', `an otherwise-clean matrix with one genuinely inapplicable row must still ADOPT: ${JSON.stringify(result)}`);
}

// --- Deep research required but adversarial evidence missing -> STOP, never faked ---
{
  const triggers = triggersWith('protectedMedicalData');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: {
      primary: { providerId: 'provider-a', researchSessionRef: 'research-session://primary/provider-a', evidenceRef: 'research-note://primary' },
      adversarial: { present: false },
    },
  }));
  assert(result.result === 'STOP' && result.code === 'ADVERSARIAL_RESEARCH_EVIDENCE_MISSING',
    `missing adversarial evidence must STOP: ${JSON.stringify(result)}`);
  assert(blocksSourceWrite(result), 'STOP must block source write');

  // An entirely absent deepResearch object (not even an honest present:false
  // declaration) fails schema-closed before the decision stage is reached.
  const absent = evaluate(baseInput({ triggers, noTriggerAssessment: null, checklist: fullChecklist(), deepResearch: null }));
  assert(absent.result === 'STOP' && absent.code === 'SCHEMA_INVALID', `entirely absent deepResearch must schema-STOP: ${JSON.stringify(absent)}`);
}

// --- A bare providerId/evidenceRef pair without a distinct researchSessionRef is not authenticated execution proof ---
{
  const triggers = triggersWith('protectedMedicalData');
  const errors = validateResearchGateInput({
    ...baseInput({ triggers, noTriggerAssessment: null, checklist: fullChecklist() }),
    deepResearch: {
      primary: { providerId: 'provider-a', evidenceRef: 'research-note://primary' },
      adversarial: { present: true, providerId: 'provider-b', researchSessionRef: 'research-session://adversarial/provider-b', distinctFromPrimary: true, evidenceRef: 'research-note://adversarial' },
    },
  });
  assert(errors.includes('deepResearch_primary_invalid'), `a bare providerId/evidenceRef pair without researchSessionRef must fail schema closed: ${errors}`);
}

// --- Same-provider adversarial research requires an explicit rationale, not assumed safe ---
{
  const triggers = triggersWith('protectedMedicalData');
  const schemaErrors = validateResearchGateInput({
    ...baseInput({ triggers, noTriggerAssessment: null, checklist: fullChecklist() }),
    deepResearch: {
      primary: { providerId: 'provider-a', researchSessionRef: 'research-session://primary/provider-a', evidenceRef: 'research-note://primary' },
      adversarial: { present: true, providerId: 'provider-a', researchSessionRef: 'research-session://adversarial/provider-a', distinctFromPrimary: false, evidenceRef: 'research-note://adversarial' },
    },
  });
  assert(schemaErrors.includes('deepResearch_adversarial_sameProviderRationale_required'),
    `same-provider adversarial research without rationale must fail schema closed: ${schemaErrors}`);

  const withRationale = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: deepResearchEvidence('provider-a', 'provider-a', 'Only one independently qualified provider is currently available; this route uses a distinct safe-mode configuration for the adversarial pass.'),
  }));
  assert(withRationale.result === 'ADOPT', `same-provider adversarial research with an explicit rationale must be accepted: ${JSON.stringify(withRationale)}`);
}

// --- Known provider-vendor aliases must never be mistaken for independent adversarial coverage ---
{
  const triggers = triggersWith('protectedMedicalData');
  const aliasedSameVendor = validateResearchGateInput({
    ...baseInput({ triggers, noTriggerAssessment: null, checklist: fullChecklist() }),
    deepResearch: {
      primary: { providerId: 'claude', researchSessionRef: 'research-session://primary/claude', evidenceRef: 'research-note://primary' },
      adversarial: { present: true, providerId: 'anthropic', researchSessionRef: 'research-session://adversarial/anthropic', distinctFromPrimary: true, evidenceRef: 'research-note://adversarial' },
    },
  });
  assert(aliasedSameVendor.includes('deepResearch_adversarial_distinctFromPrimary_mismatch'),
    `'claude' primary + 'anthropic' adversarial is the same vendor and must require distinctFromPrimary=false + rationale: ${aliasedSameVendor}`);

  const honestAliasedPair = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: {
      primary: { providerId: 'gemini', researchSessionRef: 'research-session://primary/gemini', evidenceRef: 'research-note://primary' },
      adversarial: {
        present: true, providerId: 'google', researchSessionRef: 'research-session://adversarial/google',
        distinctFromPrimary: false, sameProviderRationale: 'Only one independently qualified provider is currently available.',
        evidenceRef: 'research-note://adversarial',
      },
    },
  }));
  assert(honestAliasedPair.result === 'ADOPT', `an honestly-declared same-vendor aliased pair with rationale must be accepted: ${JSON.stringify(honestAliasedPair)}`);
  assert(honestAliasedPair.report.usedAI.primaryProviderId === 'gemini' && honestAliasedPair.report.usedAI.adversarialProviderId === 'google',
    'original provider labels must be preserved in the report, never rewritten to the normalized vendor key');
}

// --- Ordinary changes are never forced into deep research ---
{
  const triggers = triggersWith('irreversibleOperation', 'ongoingMaintenance');
  const result = evaluate(baseInput({
    triggers,
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  }));
  assert(result.deepResearchRequired === false, 'irreversible/maintenance-only triggers must not force deep research');
  assert(result.result === 'ADOPT', `ordinary triggered change with clean matrix must ADOPT: ${JSON.stringify(result)}`);
}

// --- Regression: malicious/malformed/unknown-field input fails schema-closed ---
{
  assert(evaluate(null).result === 'STOP', 'null input must STOP');
  assert(evaluate({ ...baseInput(), extraField: 'x' }).result === 'STOP', 'unknown top-level field must STOP');
  assert(evaluate({ ...baseInput(), schemaVersion: 2 }).result === 'STOP', 'wrong schema version must STOP');
  const badTriggers = evaluate({ ...baseInput(), triggers: { ...noTriggers(), extra: true } });
  assert(badTriggers.result === 'STOP', 'unknown trigger key must STOP');
  const incompleteTriggers = noTriggers();
  delete incompleteTriggers.largeTransfer;
  const missingTrigger = evaluate({ ...baseInput(), triggers: incompleteTriggers });
  assert(missingTrigger.result === 'STOP', 'incomplete trigger set must STOP');
  const badStatus = evaluate(baseInput({ checklist: minimalChecklist({ safety: { status: 'MAYBE' } }) }));
  assert(badStatus.result === 'STOP', 'unknown checklist status must STOP');
  const legacyNotApplicable = evaluate(baseInput({ checklist: minimalChecklist({ safety: { status: 'NOT_APPLICABLE' } }) }));
  assert(legacyNotApplicable.result === 'STOP', 'the retired 4-valued NOT_APPLICABLE status must never be accepted again');
  const padded = evaluate(baseInput({ checklist: [...minimalChecklist(), checklistItem('privacy', 'PASS')] }));
  assert(padded.result === 'STOP', 'padding an unrequested checklist id must STOP, never silently accepted');
  const missingRef = evaluate(baseInput({ checklist: minimalChecklist({ safety: { primarySourceRef: undefined } }) }));
  assert(missingRef.result === 'STOP', 'PASS without a primary-source ref must STOP, never invented PASS');
  const missingApplicable = evaluate(baseInput({ checklist: minimalChecklist({ safety: { applicable: undefined } }) }));
  assert(missingApplicable.result === 'STOP', 'a missing/unknown applicable determination must never be silently treated as PASS');
  const inapplicableStillPass = evaluate(baseInput({
    checklist: minimalChecklist({ safety: { applicable: false, status: 'PASS', primarySourceRef: undefined } }),
  }));
  assert(inapplicableStillPass.result === 'STOP', 'an inapplicable row must never carry a PASS/FAIL claim');
  const inapplicableNoReason = evaluate(baseInput({
    checklist: minimalChecklist({ safety: { applicable: false, inapplicableReason: undefined } }),
  }));
  assert(inapplicableNoReason.result === 'STOP', 'an inapplicable row must carry an explicit inapplicableReason');
  const billingFlagMisplaced = evaluate(baseInput({ checklist: minimalChecklist({ safety: { requiresBillingAccount: true } }) }));
  assert(billingFlagMisplaced.result === 'STOP', 'requiresBillingAccount must only be meaningful on the billingAccount row');
}

// --- Regression: stale evidence fails closed ---
{
  const result = evaluateResearchGate(baseInput({
    evidenceBinding: binding({ assessedAtUtcMs: NOW - (2 * DAY) }),
  }), { nowUtcMs: NOW });
  assert(result.result === 'STOP' && result.code === 'EVIDENCE_STALE', `stale evidence must STOP: ${JSON.stringify(result)}`);
}

// --- Regression: wrong task / wrong proposal / wrong repository / wrong scope / wrong constraints fail closed ---
{
  const wrongTask = evaluate(baseInput(), { taskId: 'other-task' });
  assert(wrongTask.result === 'STOP' && wrongTask.code === 'TASK_MISMATCH', 'wrong task must STOP');
  const wrongProposal = evaluate(baseInput(), { proposalId: 'other-proposal' });
  assert(wrongProposal.result === 'STOP' && wrongProposal.code === 'PROPOSAL_MISMATCH', 'wrong proposal must STOP');
  const wrongRepo = evaluate(baseInput(), { repository: { owner: 'someone-else', name: 'widgets' } });
  assert(wrongRepo.result === 'STOP' && wrongRepo.code === 'REPOSITORY_MISMATCH', 'wrong repository must STOP');
  const wrongScope = evaluate(baseInput(), { scope: ['other/**'] });
  assert(wrongScope.result === 'STOP' && wrongScope.code === 'SCOPE_MISMATCH', 'wrong scope must STOP');
  const wrongConstraints = evaluate(
    baseInput({ evidenceBinding: binding({ constraints: ['zero-additional-cost'] }) }),
    { constraints: ['billing-account-not-allowed'] },
  );
  assert(wrongConstraints.result === 'STOP' && wrongConstraints.code === 'CONSTRAINTS_MISMATCH', 'wrong constraints must STOP');
  const droppedTopCondition = evaluate(baseInput({
    humanTopConditions: [{ id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' }],
  }), { requiredActiveTopConditions: [
    { id: 'ZERO_ADDITIONAL_COST', statement: 'Must stay fully free.' },
    { id: 'BILLING_ACCOUNT_NOT_ALLOWED', statement: 'No billing account may be created.' },
  ] });
  assert(droppedTopCondition.result === 'STOP' && droppedTopCondition.code === 'TOP_CONDITION_DROPPED_OR_REPLACED',
    `a dropped/replaced human top condition must STOP: ${JSON.stringify(droppedTopCondition)}`);

  // Same ID, changed statement: a condition that was quietly reworded between
  // approval and evaluation is stale authority, not still-authoritative.
  const changedStatement = evaluate(baseInput({
    humanTopConditions: [{ id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free, no exceptions.' }],
  }), { requiredActiveTopConditions: [{ id: 'ZERO_ADDITIONAL_COST', statement: 'Must stay fully free.' }] });
  assert(changedStatement.result === 'STOP' && changedStatement.code === 'TOP_CONDITION_DROPPED_OR_REPLACED',
    `a reworded top condition sharing the same ID must STOP, never be treated as still-authoritative: ${JSON.stringify(changedStatement)}`);

  const matchingStatement = evaluate(baseInput({
    humanTopConditions: [{ id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'Must stay fully free.' }],
  }), { requiredActiveTopConditions: [{ id: 'ZERO_ADDITIONAL_COST', statement: 'Must stay fully free.' }] });
  assert(matchingStatement.result === 'BYPASS_LIGHT', `an exactly-matching current top condition must not be blocked: ${JSON.stringify(matchingStatement)}`);
}

// --- Regression: a falsy-but-present malformed `expected` field must never silently bypass its comparison ---
{
  const boolScope = evaluate(baseInput(), { scope: true });
  assert(boolScope.result === 'STOP' && boolScope.code === 'EXPECTED_BINDING_MALFORMED', `a boolean expected.scope must fail closed, never bypass: ${JSON.stringify(boolScope)}`);
  const emptyStringScope = evaluate(baseInput(), { scope: '' });
  assert(emptyStringScope.result === 'STOP' && emptyStringScope.code === 'EXPECTED_BINDING_MALFORMED', `an empty-string expected.scope must fail closed, never silently skip the check: ${JSON.stringify(emptyStringScope)}`);
  const emptyStringConstraints = evaluate(baseInput(), { constraints: '' });
  assert(emptyStringConstraints.result === 'STOP' && emptyStringConstraints.code === 'EXPECTED_BINDING_MALFORMED', `an empty-string expected.constraints must fail closed: ${JSON.stringify(emptyStringConstraints)}`);
  const emptyTaskId = evaluate(baseInput(), { taskId: '' });
  assert(emptyTaskId.result === 'STOP' && emptyTaskId.code === 'EXPECTED_BINDING_MALFORMED', `an empty-string expected.taskId must fail closed: ${JSON.stringify(emptyTaskId)}`);
  const malformedTopConditions = evaluate(baseInput(), { requiredActiveTopConditions: [{ id: 'ZERO_ADDITIONAL_COST' }] });
  assert(malformedTopConditions.result === 'STOP' && malformedTopConditions.code === 'EXPECTED_BINDING_MALFORMED',
    `a requiredActiveTopConditions entry missing a statement must fail closed: ${JSON.stringify(malformedTopConditions)}`);
}

// --- Regression: forged/tampered constraints digest fails closed ---
{
  const forged = evaluate(baseInput({
    evidenceBinding: { ...binding({ constraints: ['zero-additional-cost'] }), constraintsDigestSha256: 'f'.repeat(64) },
  }));
  assert(forged.result === 'STOP' && forged.code === 'SCHEMA_INVALID', 'tampered constraints digest must STOP');
}

// --- Orchestrator/receipt binding entry point requires the full expected-binding contract, never partial/self-validated evidence ---
{
  const missingExpected = evaluateResearchGateBound(baseInput(), undefined);
  assert(missingExpected.result === 'STOP' && missingExpected.code === 'EXPECTED_BINDING_REQUIRED',
    'evaluateResearchGateBound must refuse to run without an expected-binding object');
  const partialExpected = evaluateResearchGateBound(baseInput(), { taskId: 'task-1', proposalId: 'proposal-1' });
  assert(partialExpected.result === 'STOP' && partialExpected.code === 'EXPECTED_BINDING_INCOMPLETE',
    `evaluateResearchGateBound must refuse a partial expected binding: ${JSON.stringify(partialExpected)}`);
  assert(Array.isArray(partialExpected.missing) && partialExpected.missing.includes('repository'),
    'incomplete expected binding must report which fields were missing');
  const boundOk = evaluateResearchGateBound(baseInput(), fullExpected());
  assert(boundOk.result === 'BYPASS_LIGHT', `a complete expected binding must evaluate normally: ${JSON.stringify(boundOk)}`);
  const boundMismatch = evaluateResearchGateBound(baseInput(), fullExpected({ taskId: 'other-task' }));
  assert(boundMismatch.result === 'STOP' && boundMismatch.code === 'TASK_MISMATCH', 'the bound entry point must still enforce the same identity checks');
}

// --- Output never echoes unrelated raw fields beyond the closed contract ---
{
  const result = evaluate(baseInput());
  const text = JSON.stringify(result);
  assert(!text.includes('extraField'), 'output must not leak arbitrary caller fields');
}

// --- The report is derived from the raw evidence itself, never from an arbitrary caller-supplied result ---
{
  const triggers = triggersWith('newCloudApiServiceAppLibraryCliAccount', 'feeOrFreeQuota');
  const adopted = evaluate(baseInput({
    triggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(adopted.report.blocker === null, 'ADOPT must report a null blocker');
  assert(adopted.report.recommendation === 'ADOPT', 'report recommendation must mirror the actual result');
  assert(adopted.report.usedAI.primaryProviderId === 'provider-a' && adopted.report.usedAI.adversarialProviderId === 'provider-b',
    'report must list the actual research providers used');
  assert(adopted.report.sourceList.length >= CHECKLIST_IDS.length, 'report source list must include the checklist primary-source references');
  assert(adopted.report.statusCounts.PASS === CHECKLIST_IDS.length, 'report status counts must reflect the raw checklist');
  for (const field of ['humanOperations', 'cost', 'installsAccounts', 'maintenance', 'removal']) {
    assert(adopted.report[field] !== undefined, `report must include required field ${field}`);
  }
  assert(adopted.report.installsAccounts.newCloudApiServiceAppLibraryCliAccountTriggered === true, 'report must reflect the install/account trigger honestly');
  assert(adopted.report.proposalId === 'proposal-1', 'report must record the bound proposal');
  assert(adopted.report.assessedAtUtcMs === NOW, 'report must record the evaluation date');
  assert(adopted.report.passIds.length === CHECKLIST_IDS.length && adopted.report.failIds.length === 0 && adopted.report.unknownIds.length === 0,
    'report must list explicit PASS/FAIL/UNKNOWN checklist IDs');
  assert(adopted.report.usedAI.primaryResearchSessionRef && adopted.report.usedAI.adversarialResearchSessionRef,
    'report must record the actual primary/adversarial research session refs, not just provider IDs');

  const triggers2 = triggersWith('authNetworkPrivacySecurityEncryptionBackupStorageChange');
  const rejected = evaluate(baseInput({
    triggers: triggers2,
    noTriggerAssessment: null,
    checklist: fullChecklist({ security: { status: 'FAIL' } }),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  }));
  assert(rejected.report.blocker && rejected.report.blocker.code === 'CHECKLIST_FAIL_PRESENT', 'REJECT must report a non-null blocker with the real code');
  assert(rejected.report.recommendation === 'REJECT', 'report recommendation must mirror REJECT');
  assert(rejected.report.failIds.includes('security'), 'report must list the actual failing checklist ID');

  const basicTriggers = triggersWith('newCloudApiServiceAppLibraryCliAccount');
  const basicAdopted = evaluate(baseInput({
    triggers: basicTriggers,
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    noTriggerAssessment: null,
    checklist: fullChecklist(),
    deepResearch: null,
    basicResearcher: humanBasicResearcher('reviewer-jane'),
  }));
  assert(basicAdopted.report.basicResearcher?.researcherId === 'reviewer-jane' && basicAdopted.report.basicResearcher?.kind === 'HUMAN',
    `basic (non-deep) research must honestly record its actual researcher in the report: ${JSON.stringify(basicAdopted.report.basicResearcher)}`);
}

// Mandatory minimums also apply to triggered proposals; a valid inapplicable
// UNKNOWN row is not a substitute for assessing safety or preservation.
{
  const candidate = baseInput({
    triggers: triggersWith('newCloudApiServiceAppLibraryCliAccount'),
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    noTriggerAssessment: null, checklist: fullChecklist(),
    deepResearch: deepResearchEvidence('provider-a', 'provider-b'),
  });
  for (const id of MINIMAL_BYPASS_CHECKLIST_IDS) {
    const omitted = structuredClone(candidate);
    omitted.checklist = omitted.checklist.map((row) => row.id === id
      ? checklistItem(id, 'UNKNOWN', { applicable: false }) : row);
    assert(evaluate(omitted).result === 'STOP', `triggered mandatory row ${id} cannot be inapplicable`);
  }
  candidate.humanTopConditions = [
    { id: 'OTHER', active: true, statement: 'Check the approved criterion.', linkedChecklistId: 'safety' },
  ];
  assert(evaluate(candidate, { requiredActiveTopConditions: [
    { id: 'OTHER', statement: 'Check the approved criterion.', linkedChecklistId: 'dataPreservation' },
  ] }).code === 'TOP_CONDITION_DROPPED_OR_REPLACED', 'full human condition criterion must be identity-bound');
}

console.log('research-gate selftest: PASS');