#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Research Gate: a closed structured risk-assessment checkpoint that sits
// AFTER Project Intake and BEFORE any source writer / install / account /
// config / external adoption. It never invokes a provider and never grants
// write/install/merge authority itself; it only decides whether the caller
// may proceed to ADOPT (subject to the other existing gates), is restricted
// to a narrow synthetic TRIAL, or must REJECT/STOP before any such step.
//
// Evidence is bound to the exact task/proposal/repository/scope/constraints
// via caller-recomputable fields, and to freshness via an explicit max-age
// window, so a stale, mismatched, or forged evaluation cannot be reused. A
// recomputable digest proves the recorded input was not silently altered;
// it is never treated here as proof that an AI actually executed research
// or that an underlying real-world/official fact is true. Those are
// evidence-quality claims only a genuine primary source or an honest
// execution/session record can support, and this module never fabricates
// either.

const SCHEMA_VERSION = 1;

export const CHECKLIST_IDS = [
  'safety', 'dataPreservation', 'privacy', 'security', 'additionalCost',
  'freeTierExceedBehavior', 'billingAccount', 'automaticBilling',
  'browserCompatibility', 'osCompatibility', 'auth', 'account',
  'corsCommunication', 'quota', 'size', 'time', 'retention', 'region',
  'failure', 'resend', 'ack', 'recovery', 'serviceEnd', 'terms',
  'humanOperations', 'maintenance', 'removal', 'existingOverlap',
];
const CHECKLIST_ID_SET = new Set(CHECKLIST_IDS);
export const MINIMAL_BYPASS_CHECKLIST_IDS = ['safety', 'dataPreservation', 'existingOverlap'];

// Exactly three record statuses. Applicability is a *separate* boolean so a
// row that is genuinely out of scope can be recorded honestly without
// inventing a fourth status, and so "inapplicable" can never be silently
// read downstream as "PASS". A row marked inapplicable carries no PASS/FAIL
// claim: its status is forced to UNKNOWN because nothing was evaluated.
const STATUS_VALUES = new Set(['PASS', 'FAIL', 'UNKNOWN']);
const CHECKLIST_ITEM_KEYS = new Set([
  'id', 'status', 'applicable', 'justification', 'inapplicableReason',
  'primarySourceRef', 'requiresBillingAccount',
]);

export const TRIGGER_KEYS = [
  'newCloudApiServiceAppLibraryCliAccount',
  'authNetworkPrivacySecurityEncryptionBackupStorageChange',
  'protectedMedicalData',
  'feeOrFreeQuota',
  'osBrowserCompatibility',
  'largeTransfer',
  'irreversibleOperation',
  'ongoingMaintenance',
];
// Triggers for which an ordinary change genuinely needs a Deep-Research-
// equivalent (complex/multi-service/provider-dependent/security/medical/
// auth/fees/large-transfer/browser-risk). irreversibleOperation and
// ongoingMaintenance alone do not force it: an irreversible-but-local Git
// operation or routine maintenance labeling is not automatically a research
// workload. This is capability-based, never a marketing-name check.
const DEEP_RESEARCH_TRIGGER_KEYS = new Set([
  'newCloudApiServiceAppLibraryCliAccount',
  'authNetworkPrivacySecurityEncryptionBackupStorageChange',
  'protectedMedicalData',
  'feeOrFreeQuota',
  'osBrowserCompatibility',
  'largeTransfer',
]);

// A new local dependency (e.g. a plain Python library with no external
// service/account/network/auth footprint) still needs ordinary/basic
// Research (the full triggered checklist below), but must not be forced
// into the Deep-Research-equivalent workload that external/high-risk
// services require. This closed risk/complexity profile is the ONLY lever
// that can relax the deep-research requirement, and it applies ONLY to the
// newCloudApiServiceAppLibraryCliAccount trigger. Every other deep-research
// trigger (auth/security/protected-medical-data/fees/large-transfer/
// browser-risk) stays mandatory regardless of this profile, so a genuinely
// high-risk change cannot hide behind a "simple dependency" declaration.
export const LIBRARY_RISK_PROFILE_VALUES = new Set(['LOCAL_LOW_RISK', 'EXTERNAL_OR_HIGH_RISK']);

const NO_TRIGGER_REASONS = new Set([
  'PURE_CSS_OR_TEXT_CHANGE',
  'KNOWN_IN_SCOPE_EXISTING_BUG',
  'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL',
]);

export const TOP_CONDITION_IDS = new Set([
  'ZERO_ADDITIONAL_COST',
  'BILLING_ACCOUNT_NOT_ALLOWED',
  'NO_PROTECTED_DATA_PERMITTED',
  'OTHER',
]);

// Checklist rows that can carry cost/billing exposure for the
// ZERO_ADDITIONAL_COST / BILLING_ACCOUNT_NOT_ALLOWED top conditions, and the
// privacy/security rows for NO_PROTECTED_DATA_PERMITTED. An active top
// condition can never be bypassed by marking its relevant row inapplicable:
// that is treated as a conflict, not a pass-through.
const COST_RELATED_CHECKLIST_IDS = ['additionalCost', 'freeTierExceedBehavior', 'billingAccount', 'automaticBilling'];
// Deliberately excludes billingAccount: a billing account's mere existence
// or requirement is not itself proof of an actual charge. Only these three
// rows carry real cost-outcome evidence for the ZERO_ADDITIONAL_COST
// condition; billingAccount is evaluated separately, only against the
// BILLING_ACCOUNT_NOT_ALLOWED condition, and account creation stays its own
// separate human gate.
const COST_EVIDENCE_CHECKLIST_IDS = ['additionalCost', 'freeTierExceedBehavior', 'automaticBilling'];
const PRIVACY_RELATED_CHECKLIST_IDS = ['privacy', 'security'];

const EVIDENCE_BINDING_KEYS = new Set([
  'taskId', 'proposalId', 'repository', 'scope', 'constraints',
  'constraintsDigestSha256', 'assessedAtUtcMs', 'maxEvidenceAgeMs',
]);
const TOP_KEYS = new Set([
  'schemaVersion', 'evidenceBinding', 'triggers',
  'newCloudApiServiceAppLibraryCliAccountRiskProfile',
  'noTriggerAssessment', 'checklist', 'humanTopConditions', 'deepResearch',
  'basicResearcher',
]);
const BASIC_RESEARCHER_KINDS = new Set(['HUMAN', 'AI_PROVIDER']);

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function boundedString(value, max) {
  return nonEmptyString(value) && value.trim().length <= max;
}
function stringArray(value, max = 50) {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 200);
}
function closedObject(value, allowedKeys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key));
}
function sameStringSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const value of sa) if (!sb.has(value)) return false;
  return true;
}

export function computeConstraintsDigest(constraints) {
  const sorted = [...constraints].map((item) => String(item)).sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').toUpperCase();
}

function stop(code, extra = {}) {
  return { schemaVersion: SCHEMA_VERSION, result: 'STOP', code, taskId: null, ...extra };
}

// Known provider-id aliases normalized to a single vendor key, so a primary
// of 'claude' and an adversarial of 'anthropic' (the same underlying vendor
// under a different label) are never mistaken for independent coverage. The
// ORIGINAL providerId strings are always preserved everywhere in the
// evidence/report; this normalization is used ONLY for the same-vendor
// comparison below.
const PROVIDER_VENDOR_ALIASES = new Map([
  ['claude', 'anthropic'], ['anthropic', 'anthropic'],
  ['chatgpt', 'openai'], ['codex', 'openai'], ['openai', 'openai'],
  ['gemini', 'google'], ['antigravity', 'google'], ['google', 'google'],
]);
export function providerVendorKey(providerId) {
  const key = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  return PROVIDER_VENDOR_ALIASES.get(key) || key;
}

function validateEvidenceBinding(binding) {
  const errors = [];
  if (!closedObject(binding, EVIDENCE_BINDING_KEYS)) return ['evidenceBinding_not_object_or_unknown_field'];
  if (!safeToken(binding.taskId)) errors.push('taskId_invalid');
  if (!safeToken(binding.proposalId)) errors.push('proposalId_invalid');
  const repo = binding.repository;
  if (!repo || typeof repo !== 'object' || Array.isArray(repo) ||
      !safeToken(repo.owner) || !safeToken(repo.name) ||
      Object.keys(repo).some((key) => key !== 'owner' && key !== 'name')) {
    errors.push('repository_invalid');
  }
  if (!stringArray(binding.scope, 50)) errors.push('scope_invalid');
  if (!stringArray(binding.constraints, 50)) errors.push('constraints_invalid');
  else if (!/^[0-9A-Fa-f]{64}$/.test(String(binding.constraintsDigestSha256))) errors.push('constraintsDigestSha256_invalid');
  else if (computeConstraintsDigest(binding.constraints) !== String(binding.constraintsDigestSha256).toUpperCase()) {
    errors.push('constraintsDigestSha256_mismatch');
  }
  if (!Number.isInteger(binding.assessedAtUtcMs) || binding.assessedAtUtcMs < 0) errors.push('assessedAtUtcMs_invalid');
  if (!Number.isInteger(binding.maxEvidenceAgeMs) || binding.maxEvidenceAgeMs <= 0 || binding.maxEvidenceAgeMs > 7 * 24 * 60 * 60 * 1000) {
    errors.push('maxEvidenceAgeMs_invalid');
  }
  return errors;
}

function validateChecklistItem(item, allowedIds) {
  const errors = [];
  if (!closedObject(item, CHECKLIST_ITEM_KEYS)) return ['item_not_object_or_unknown_field'];
  if (!CHECKLIST_ID_SET.has(item.id) || !allowedIds.has(item.id)) errors.push('id_invalid');
  if (typeof item.applicable !== 'boolean') errors.push('applicable_required_boolean');
  if (!STATUS_VALUES.has(item.status)) errors.push('status_invalid');
  if (!boundedString(item.justification, 1000)) errors.push('justification_invalid');

  if (item.applicable === false) {
    // Never treat a missing/unknown applicability determination as PASS: an
    // inapplicable row carries no PASS/FAIL claim and must be excluded from
    // the decision instead of silently counted as clean.
    if (item.status !== 'UNKNOWN') errors.push('inapplicable_status_must_be_unknown');
    if (!boundedString(item.inapplicableReason, 500)) errors.push('inapplicableReason_required');
    if (item.primarySourceRef !== undefined) errors.push('primarySourceRef_forbidden_when_inapplicable');
  } else if (item.applicable === true) {
    if (item.inapplicableReason !== undefined) errors.push('inapplicableReason_forbidden_when_applicable');
    if (item.status === 'PASS' || item.status === 'FAIL') {
      if (!boundedString(item.primarySourceRef, 500)) errors.push('primarySourceRef_required');
    } else if (item.primarySourceRef !== undefined) {
      errors.push('primarySourceRef_forbidden_for_unknown');
    }
  }
  if (item.requiresBillingAccount !== undefined) {
    if (typeof item.requiresBillingAccount !== 'boolean') errors.push('requiresBillingAccount_invalid');
    if (item.id !== 'billingAccount') errors.push('requiresBillingAccount_forbidden_for_non_billing_item');
  }
  return errors;
}

function validateChecklist(checklist, allowedIdList) {
  const allowedIds = new Set(allowedIdList);
  if (!Array.isArray(checklist)) return ['checklist_not_array'];
  const errors = [];
  const seen = new Set();
  for (const item of checklist) {
    const itemErrors = validateChecklistItem(item, allowedIds);
    if (itemErrors.length > 0) { errors.push(...itemErrors); continue; }
    if (seen.has(item.id)) errors.push('checklist_duplicate_id');
    seen.add(item.id);
  }
  for (const id of allowedIdList) if (!seen.has(id)) errors.push(`checklist_missing_${id}`);
  for (const id of seen) if (!allowedIds.has(id)) errors.push(`checklist_unexpected_${id}`);
  return errors;
}

// An active OTHER top condition is a human-authored requirement outside the
// four closed IDs. It must never be adopted on the strength of its text
// alone: it is required to name an existing checklist criterion it binds to
// (linkedChecklistId), and evaluateTopConditions below independently
// confirms that row was actually evaluated (applicable === true, which the
// checklist schema already forces to carry an explicit PASS/FAIL/UNKNOWN
// status). An active OTHER with no link, or linked to a row that was never
// evaluated, is treated as an unevaluated human requirement and blocks
// instead of silently adopting.
function validateHumanTopConditions(conditions) {
  if (conditions === undefined) return [];
  if (!Array.isArray(conditions) || conditions.length > 20) return ['humanTopConditions_invalid'];
  const errors = [];
  const seen = new Set();
  for (const item of conditions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('topCondition_not_object'); continue; }
    const keys = Object.keys(item);
    if (keys.some((key) => !['id', 'active', 'statement', 'linkedChecklistId'].includes(key))) errors.push('topCondition_unknown_field');
    if (!TOP_CONDITION_IDS.has(item.id)) errors.push('topCondition_id_invalid');
    else if (item.id !== 'OTHER' && seen.has(item.id)) errors.push('topCondition_duplicate_id');
    else seen.add(item.id);
    if (typeof item.active !== 'boolean') errors.push('topCondition_active_invalid');
    if (!boundedString(item.statement, 500)) errors.push('topCondition_statement_invalid');
    if (item.id === 'OTHER' && item.active === true) {
      if (!CHECKLIST_ID_SET.has(item.linkedChecklistId)) errors.push('topCondition_other_linkedChecklistId_required');
    } else if (item.linkedChecklistId !== undefined) {
      errors.push('topCondition_linkedChecklistId_forbidden_unless_active_other');
    }
  }
  return errors;
}

function computeDeepResearchRequired(input) {
  return TRIGGER_KEYS.filter((key) => DEEP_RESEARCH_TRIGGER_KEYS.has(key)).some((key) => {
    if (input.triggers[key] !== true) return false;
    if (key === 'newCloudApiServiceAppLibraryCliAccount') {
      return input.newCloudApiServiceAppLibraryCliAccountRiskProfile === 'EXTERNAL_OR_HIGH_RISK';
    }
    return true;
  });
}

function validateLibraryRiskProfile(input) {
  const required = input.triggers.newCloudApiServiceAppLibraryCliAccount === true;
  const value = input.newCloudApiServiceAppLibraryCliAccountRiskProfile;
  if (!required) {
    return value === undefined ? [] : ['libraryRiskProfile_forbidden_when_trigger_absent'];
  }
  return LIBRARY_RISK_PROFILE_VALUES.has(value) ? [] : ['libraryRiskProfile_required_and_invalid'];
}

// Bare provider-id/evidenceRef strings are not authenticated execution
// proof by themselves: anyone could type a plausible-looking string. The
// schema therefore separately requires a researchSessionRef (the research
// run/session/route identifier for that specific execution) alongside the
// evidenceRef (the primary-source/content reference the research produced).
// This module can only check that both are present, well-formed, and
// distinct in purpose; it has no way to verify that a provider actually ran
// or that the underlying claim is officially true, and it never claims
// otherwise.
function validateDeepResearch(deepResearch, required) {
  if (!required) {
    if (deepResearch !== null && deepResearch !== undefined) return ['deepResearch_forbidden_when_not_required'];
    return [];
  }
  if (!deepResearch || typeof deepResearch !== 'object' || Array.isArray(deepResearch)) return ['deepResearch_required'];
  const errors = [];
  const keys = Object.keys(deepResearch);
  if (keys.some((key) => !['primary', 'adversarial'].includes(key))) errors.push('deepResearch_unknown_field');

  const primary = deepResearch.primary;
  const primaryKeys = ['providerId', 'researchSessionRef', 'evidenceRef'];
  if (!primary || typeof primary !== 'object' || Array.isArray(primary) ||
      !safeToken(primary.providerId) || !boundedString(primary.researchSessionRef, 500) ||
      !boundedString(primary.evidenceRef, 500) ||
      Object.keys(primary).some((key) => !primaryKeys.includes(key))) {
    errors.push('deepResearch_primary_invalid');
  }

  const adversarial = deepResearch.adversarial;
  if (!adversarial || typeof adversarial !== 'object' || Array.isArray(adversarial)) {
    errors.push('deepResearch_adversarial_invalid');
    return errors;
  }
  const allowedAdversarialKeys = ['present', 'providerId', 'researchSessionRef', 'distinctFromPrimary', 'sameProviderRationale', 'evidenceRef'];
  if (Object.keys(adversarial).some((key) => !allowedAdversarialKeys.includes(key))) errors.push('deepResearch_adversarial_unknown_field');
  if (typeof adversarial.present !== 'boolean') errors.push('deepResearch_adversarial_present_invalid');
  if (adversarial.present === true) {
    if (!safeToken(adversarial.providerId)) errors.push('deepResearch_adversarial_providerId_invalid');
    if (!boundedString(adversarial.researchSessionRef, 500)) errors.push('deepResearch_adversarial_researchSessionRef_invalid');
    if (!boundedString(adversarial.evidenceRef, 500)) errors.push('deepResearch_adversarial_evidenceRef_invalid');
    if (typeof adversarial.distinctFromPrimary !== 'boolean') errors.push('deepResearch_adversarial_distinctFromPrimary_invalid');
    // A session reference names a run, not the fact that the run actually
    // happened; it is never execution-authenticating proof by itself. But
    // the primary and adversarial passes must never share the exact same
    // session, even when they share the same provider (the fallback case):
    // reusing one session for both roles cannot evidence two independent
    // passes, so this is checked unconditionally, not only when the
    // provider IDs differ.
    if (primary && boundedString(primary.researchSessionRef, 500) && boundedString(adversarial.researchSessionRef, 500) &&
        primary.researchSessionRef === adversarial.researchSessionRef) {
      errors.push('deepResearch_adversarial_researchSessionRef_not_distinct_from_primary');
    }
    if (primary && safeToken(primary.providerId) && safeToken(adversarial.providerId)) {
      // Alias-normalized: 'claude'/'anthropic', 'chatgpt'/'codex'/'openai',
      // and 'gemini'/'antigravity'/'google' are each the same vendor, so a
      // relabeled same-vendor pair cannot masquerade as independent coverage.
      const sameProvider = providerVendorKey(adversarial.providerId) === providerVendorKey(primary.providerId);
      if (sameProvider && adversarial.distinctFromPrimary !== false) errors.push('deepResearch_adversarial_distinctFromPrimary_mismatch');
      if (!sameProvider && adversarial.distinctFromPrimary !== true) errors.push('deepResearch_adversarial_distinctFromPrimary_mismatch');
      if (sameProvider && !boundedString(adversarial.sameProviderRationale, 500)) {
        errors.push('deepResearch_adversarial_sameProviderRationale_required');
      }
      if (!sameProvider && adversarial.sameProviderRationale !== undefined) {
        errors.push('deepResearch_adversarial_sameProviderRationale_forbidden');
      }
    }
  } else if (adversarial.providerId !== undefined || adversarial.researchSessionRef !== undefined ||
      adversarial.distinctFromPrimary !== undefined || adversarial.sameProviderRationale !== undefined ||
      adversarial.evidenceRef !== undefined) {
    errors.push('deepResearch_adversarial_fields_forbidden_when_absent');
  }
  return errors;
}

export function validateResearchGateInput(input) {
  if (!closedObject(input, TOP_KEYS)) return ['input_not_object_or_unknown_field'];
  const errors = [];
  if (input.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion_invalid');
  errors.push(...validateEvidenceBinding(input.evidenceBinding));

  if (!input.triggers || typeof input.triggers !== 'object' || Array.isArray(input.triggers) ||
      Object.keys(input.triggers).length !== TRIGGER_KEYS.length ||
      TRIGGER_KEYS.some((key) => typeof input.triggers[key] !== 'boolean')) {
    errors.push('triggers_invalid');
    return errors;
  }
  const triggered = TRIGGER_KEYS.some((key) => input.triggers[key] === true);

  errors.push(...validateLibraryRiskProfile(input));

  if (!triggered) {
    const na = input.noTriggerAssessment;
    if (!na || typeof na !== 'object' || Array.isArray(na) ||
        Object.keys(na).some((key) => !['reasonCode', 'justification'].includes(key)) ||
        !NO_TRIGGER_REASONS.has(na.reasonCode) || !boundedString(na.justification, 1000)) {
      errors.push('noTriggerAssessment_required_and_invalid');
    }
    errors.push(...validateChecklist(input.checklist, MINIMAL_BYPASS_CHECKLIST_IDS));
    // The three mandatory minimum rows can never ALL be declared
    // inapplicable to manufacture a BYPASS_LIGHT: at least these rows must
    // actually be evaluated (applicable === true) for the no-trigger path to
    // ever reach the bypass decision.
    if (Array.isArray(input.checklist)) {
      for (const id of MINIMAL_BYPASS_CHECKLIST_IDS) {
        const item = input.checklist.find((entry) => entry && entry.id === id);
        if (item && item.applicable !== true) errors.push(`checklist_minimum_row_must_be_applicable_${id}`);
      }
    }
  } else {
    if (input.noTriggerAssessment !== null && input.noTriggerAssessment !== undefined) {
      errors.push('noTriggerAssessment_forbidden_when_triggered');
    }
    errors.push(...validateChecklist(input.checklist, CHECKLIST_IDS));
    for (const id of MINIMAL_BYPASS_CHECKLIST_IDS) {
      const row = Array.isArray(input.checklist) && input.checklist.find((entry) => entry?.id === id);
      if (row && row.applicable !== true) errors.push(`checklist_minimum_row_must_be_applicable_${id}`);
    }
    // Sensitive triggers (protected medical data, or an
    // auth/network/privacy/security/encryption/backup/storage change) can
    // never have their relevant privacy/security rows declared inapplicable:
    // that would evade exactly the evidence this trigger exists to force.
    if (Array.isArray(input.checklist) &&
        (input.triggers.protectedMedicalData === true ||
         input.triggers.authNetworkPrivacySecurityEncryptionBackupStorageChange === true)) {
      for (const id of PRIVACY_RELATED_CHECKLIST_IDS) {
        const item = input.checklist.find((entry) => entry && entry.id === id);
        if (item && item.applicable !== true) errors.push(`checklist_sensitive_row_must_be_applicable_${id}`);
      }
    }
  }

  errors.push(...validateHumanTopConditions(input.humanTopConditions));

  const deepResearchRequired = computeDeepResearchRequired(input);
  errors.push(...validateDeepResearch(input.deepResearch, deepResearchRequired));
  errors.push(...validateBasicResearcher(input.basicResearcher, triggered && !deepResearchRequired));

  return errors;
}

// Ordinary/basic Research (triggered but not deep-research-required) must
// still name who actually performed it -- a human or a genuinely invoked AI
// provider/session -- so a triggered change can never silently imply a
// provider ran basic research when in fact nobody did. This is intentionally
// much lighter than the deepResearch primary/adversarial contract: it is not
// claiming independent/adversarial coverage, only an honest record of the
// actual researcher.
function validateBasicResearcher(basicResearcher, required) {
  if (!required) {
    if (basicResearcher !== null && basicResearcher !== undefined) return ['basicResearcher_forbidden_when_not_required'];
    return [];
  }
  if (!basicResearcher || typeof basicResearcher !== 'object' || Array.isArray(basicResearcher)) return ['basicResearcher_required'];
  const errors = [];
  const keys = Object.keys(basicResearcher);
  if (keys.some((key) => !['researcherId', 'kind', 'researchSessionRef'].includes(key))) errors.push('basicResearcher_unknown_field');
  if (!safeToken(basicResearcher.researcherId)) errors.push('basicResearcher_researcherId_invalid');
  if (!BASIC_RESEARCHER_KINDS.has(basicResearcher.kind)) errors.push('basicResearcher_kind_invalid');
  if (basicResearcher.kind === 'AI_PROVIDER') {
    if (!boundedString(basicResearcher.researchSessionRef, 500)) errors.push('basicResearcher_researchSessionRef_required_for_ai_provider');
  } else if (basicResearcher.researchSessionRef !== undefined) {
    errors.push('basicResearcher_researchSessionRef_forbidden_for_human');
  }
  return errors;
}

function billingAccountRequired(item) {
  if (!item || item.applicable !== true) return false;
  return item.status === 'FAIL' || item.requiresBillingAccount === true;
}

// Charges must never be inferred solely from a billing account's presence
// or requirement: only an explicit FAIL on one of the real cost-outcome rows
// (additionalCost / freeTierExceedBehavior / automaticBilling) is treated as
// evidence of an actual charge for ZERO_ADDITIONAL_COST.
function costEvidenceIndicatesCharge(byId) {
  return COST_EVIDENCE_CHECKLIST_IDS.some((id) => {
    const item = byId.get(id);
    return item && item.applicable === true && item.status === 'FAIL';
  });
}

// Generalized human top-condition enforcement. Each active condition is
// checked independently against the raw checklist evidence -- not only the
// one historical ZERO_ADDITIONAL_COST + BILLING_ACCOUNT_NOT_ALLOWED pairing
// -- so BILLING_ACCOUNT_NOT_ALLOWED alone (without ZERO_ADDITIONAL_COST)
// still rejects a billing-required service, and NO_PROTECTED_DATA_PERMITTED
// is enforced on its own relevant rows. A relevant row cannot be marked
// inapplicable to dodge an explicit active condition: that is itself a
// conflict. OTHER is never silently dropped and never silently adopted: an
// active OTHER must be linked to an evaluated checklist row, or it is itself
// a conflict; its statement is always surfaced in decisionBasis regardless
// of outcome.
function evaluateTopConditions(humanTopConditions, checklist, triggers) {
  const byId = new Map(checklist.map((item) => [item.id, item]));
  const otherStatements = Array.isArray(humanTopConditions)
    ? humanTopConditions.filter((item) => item.id === 'OTHER' && item.active === true).map((item) => item.statement)
    : [];
  if (!Array.isArray(humanTopConditions) || humanTopConditions.length === 0) {
    return { conflict: null, otherStatements };
  }

  const activeById = (id) => humanTopConditions.find((item) => item.id === id && item.active === true);
  const zeroCost = activeById('ZERO_ADDITIONAL_COST');
  const billingNotAllowed = activeById('BILLING_ACCOUNT_NOT_ALLOWED');
  const noProtectedData = activeById('NO_PROTECTED_DATA_PERMITTED');
  const activeOthers = humanTopConditions.filter((item) => item.id === 'OTHER' && item.active === true);

  const inapplicableBypass = (ids, conditionId) => {
    for (const id of ids) {
      const item = byId.get(id);
      if (item && item.applicable === false) {
        return {
          id: `TOP_CONDITION_${conditionId}_ROW_MARKED_INAPPLICABLE`,
          statement: `Human top condition ${conditionId} is active but checklist row '${id}' was marked inapplicable, which cannot bypass an explicit human top condition.`,
        };
      }
    }
    return null;
  };

  // An active OTHER is never silently adopted on text alone: it must be
  // linked (schema-enforced) to a checklist row, and that row must have
  // actually been evaluated (applicable === true). A link to a row that was
  // declared inapplicable means the human's own requirement was never
  // evaluated at all, which blocks rather than silently passing through.
  for (const other of activeOthers) {
    const linked = byId.get(other.linkedChecklistId);
    if (!linked || linked.applicable !== true) {
      return {
        conflict: {
          id: 'TOP_CONDITION_OTHER_UNEVALUATED',
          statement: `Human top condition OTHER ("${other.statement}") is linked to checklist row '${other.linkedChecklistId}', but that row was never evaluated (applicable !== true). An unevaluated human requirement must never be silently adopted.`,
        },
        otherStatements,
      };
    }
  }

  if (noProtectedData && triggers && triggers.protectedMedicalData === true) {
    // This change is itself declared to involve protected medical data
    // (the protectedMedicalData trigger), which directly contradicts a human
    // condition that no protected data may be used at all. All-PASS
    // checklist rows cannot resolve a contradiction between the declared
    // nature of the change and the human's own constraint; it must reject.
    return {
      conflict: {
        id: 'TOP_CONDITION_NO_PROTECTED_DATA_PERMITTED_CONTRADICTS_TRIGGER',
        statement: 'Human top condition disallows protected data, but this change is declared to involve protected medical data (protectedMedicalData trigger). All-PASS checklist rows cannot resolve this contradiction.',
      },
      otherStatements,
    };
  }

  if (zeroCost) {
    const bypass = inapplicableBypass(COST_RELATED_CHECKLIST_IDS, 'ZERO_ADDITIONAL_COST');
    if (bypass) return { conflict: bypass, otherStatements };
    if (costEvidenceIndicatesCharge(byId)) {
      return {
        conflict: {
          id: 'TOP_CONDITION_ZERO_COST_CHARGE_EVIDENCE_CONFLICT',
          statement: 'Human top condition requires zero additional cost, but the evaluated additionalCost/freeTierExceedBehavior/automaticBilling checklist evidence indicates an actual charge.',
        },
        otherStatements,
      };
    }
  }
  if (billingNotAllowed) {
    const bypass = inapplicableBypass(['billingAccount'], 'BILLING_ACCOUNT_NOT_ALLOWED');
    if (bypass) return { conflict: bypass, otherStatements };
    // This fires on BILLING_ACCOUNT_NOT_ALLOWED alone -- it does not require
    // ZERO_ADDITIONAL_COST to also be active. A disallowed billing account
    // is its own, independent rejection reason, and unlike ZERO_ADDITIONAL_
    // COST this condition is explicitly about the billing account itself
    // (a separate human gate from actual charges), so billingAccount's own
    // requiresBillingAccount/FAIL evidence is the correct and sufficient
    // signal here.
    if (billingAccountRequired(byId.get('billingAccount'))) {
      return {
        conflict: {
          id: 'TOP_CONDITION_BILLING_REQUIRED_CONFLICT',
          statement: 'Human top condition disallows a billing account, but the evaluated checklist evidence states a billing account is required.',
        },
        otherStatements,
      };
    }
  }
  if (noProtectedData) {
    const bypass = inapplicableBypass(PRIVACY_RELATED_CHECKLIST_IDS, 'NO_PROTECTED_DATA_PERMITTED');
    if (bypass) return { conflict: bypass, otherStatements };
  }

  return { conflict: null, otherStatements };
}

function checklistEntry(checklist, id) {
  return checklist.find((item) => item.id === id) || null;
}
function reportFromChecklistItem(item) {
  if (!item) return null;
  return {
    status: item.status,
    applicable: item.applicable,
    justification: item.justification,
    primarySourceRef: item.primarySourceRef ?? null,
    inapplicableReason: item.inapplicableReason ?? null,
    // Forwarded as recorded (null unless the raw checklist item actually set
    // it). The schema already forbids this field on every row except
    // 'billingAccount', so it stays null there; omitting it instead of
    // forwarding it would silently drop the one real billing-account signal
    // (e.g. a Spark-vs-Blaze plan selection) that report.cost.billingAccount
    // exists to surface.
    requiresBillingAccount: item.requiresBillingAccount ?? null,
  };
}

// A complete, closed report derived only from the raw, already-validated
// evidence (never from an arbitrary caller-supplied "result" claim), so a
// standalone proof cannot be fabricated by whatever the caller wanted the
// outcome to be.
function buildReport(input, checklist, result, code, decisionBasis) {
  const usedAI = input.deepResearch ? {
    primaryProviderId: input.deepResearch.primary?.providerId ?? null,
    primaryResearchSessionRef: input.deepResearch.primary?.researchSessionRef ?? null,
    primaryEvidenceRef: input.deepResearch.primary?.evidenceRef ?? null,
    adversarialProviderId: input.deepResearch.adversarial?.present === true ? input.deepResearch.adversarial.providerId : null,
    adversarialResearchSessionRef: input.deepResearch.adversarial?.present === true ? input.deepResearch.adversarial.researchSessionRef : null,
    adversarialEvidenceRef: input.deepResearch.adversarial?.present === true ? input.deepResearch.adversarial.evidenceRef : null,
  } : null;
  const sourceList = [];
  for (const item of checklist) if (item.primarySourceRef) sourceList.push(item.primarySourceRef);
  if (input.deepResearch?.primary?.evidenceRef) sourceList.push(input.deepResearch.primary.evidenceRef);
  if (input.deepResearch?.adversarial?.present === true && input.deepResearch.adversarial.evidenceRef) {
    sourceList.push(input.deepResearch.adversarial.evidenceRef);
  }
  const statusCounts = { PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 };
  const idsByStatus = { PASS: [], FAIL: [], UNKNOWN: [] };
  for (const item of checklist) {
    if (item.applicable === false) { statusCounts.NOT_APPLICABLE += 1; continue; }
    statusCounts[item.status] += 1;
    idsByStatus[item.status].push(item.id);
  }
  const blocks = result !== 'ADOPT' && result !== 'BYPASS_LIGHT';
  const activeTopConditions = Array.isArray(input.humanTopConditions)
    ? input.humanTopConditions.filter((item) => item.active === true).map((item) => ({ id: item.id, statement: item.statement, linkedChecklistId: item.linkedChecklistId ?? null }))
    : [];
  return {
    proposalId: input.evidenceBinding.proposalId,
    assessedAtUtcMs: input.evidenceBinding.assessedAtUtcMs,
    activeTopConditions,
    usedAI,
    basicResearcher: input.basicResearcher ? { ...input.basicResearcher } : null,
    passIds: idsByStatus.PASS,
    failIds: idsByStatus.FAIL,
    unknownIds: idsByStatus.UNKNOWN,
    sourceList,
    statusCounts,
    blocker: blocks ? { code, decisionBasis } : null,
    humanOperations: reportFromChecklistItem(checklistEntry(checklist, 'humanOperations')),
    cost: {
      additionalCost: reportFromChecklistItem(checklistEntry(checklist, 'additionalCost')),
      freeTierExceedBehavior: reportFromChecklistItem(checklistEntry(checklist, 'freeTierExceedBehavior')),
      billingAccount: reportFromChecklistItem(checklistEntry(checklist, 'billingAccount')),
      automaticBilling: reportFromChecklistItem(checklistEntry(checklist, 'automaticBilling')),
    },
    installsAccounts: {
      newCloudApiServiceAppLibraryCliAccountTriggered: input.triggers.newCloudApiServiceAppLibraryCliAccount === true,
      account: reportFromChecklistItem(checklistEntry(checklist, 'account')),
      auth: reportFromChecklistItem(checklistEntry(checklist, 'auth')),
    },
    maintenance: reportFromChecklistItem(checklistEntry(checklist, 'maintenance')),
    removal: reportFromChecklistItem(checklistEntry(checklist, 'removal')),
    recommendation: result,
  };
}

function normalizeCurrentConditionDefinitions(list) {
  if (!Array.isArray(list) || list.length > 20) return null;
  const definitions = [];
  for (const item of list) {
    if (!closedObject(item, new Set(['id', 'statement', 'linkedChecklistId'])) ||
        !TOP_CONDITION_IDS.has(item.id) || !boundedString(item.statement, 500)) return null;
    if (item.id === 'OTHER' ? !CHECKLIST_ID_SET.has(item.linkedChecklistId) : item.linkedChecklistId !== undefined) return null;
    const definition = { id: item.id, statement: item.statement,
      ...(item.id === 'OTHER' ? { linkedChecklistId: item.linkedChecklistId } : {}) };
    if (definitions.some((prior) => JSON.stringify(prior) === JSON.stringify(definition))) return null;
    definitions.push(definition);
  }
  return definitions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function evaluateResearchGate(input, expected = {}) {
  const errors = validateResearchGateInput(input);
  if (errors.length > 0) return stop('SCHEMA_INVALID', { errors });

  const binding = input.evidenceBinding;
  // Every comparison below fails closed on a malformed `expected` field
  // (e.g. a boolean or empty string where an array/object was required)
  // instead of silently skipping the check: a falsy-but-present malformed
  // value (like `''` or `0`) must never be treated the same as "caller chose
  // not to check this field" (`undefined`).
  if (expected.taskId !== undefined) {
    if (typeof expected.taskId !== 'string' || expected.taskId.length === 0) return stop('EXPECTED_BINDING_MALFORMED', { field: 'taskId' });
    if (binding.taskId !== expected.taskId) return stop('TASK_MISMATCH', { taskId: binding.taskId });
  }
  if (expected.proposalId !== undefined) {
    if (typeof expected.proposalId !== 'string' || expected.proposalId.length === 0) return stop('EXPECTED_BINDING_MALFORMED', { field: 'proposalId' });
    if (binding.proposalId !== expected.proposalId) return stop('PROPOSAL_MISMATCH', { taskId: binding.taskId });
  }
  if (expected.repository !== undefined) {
    const repo = expected.repository;
    if (!repo || typeof repo !== 'object' || Array.isArray(repo) || !nonEmptyString(repo.owner) || !nonEmptyString(repo.name)) {
      return stop('EXPECTED_BINDING_MALFORMED', { field: 'repository' });
    }
    if (binding.repository.owner !== repo.owner || binding.repository.name !== repo.name) {
      return stop('REPOSITORY_MISMATCH', { taskId: binding.taskId });
    }
  }
  if (expected.scope !== undefined) {
    if (!Array.isArray(expected.scope)) return stop('EXPECTED_BINDING_MALFORMED', { field: 'scope' });
    if (!sameStringSet(expected.scope, binding.scope)) return stop('SCOPE_MISMATCH', { taskId: binding.taskId });
  }
  if (expected.constraints !== undefined) {
    if (!Array.isArray(expected.constraints)) return stop('EXPECTED_BINDING_MALFORMED', { field: 'constraints' });
    if (!sameStringSet(expected.constraints, binding.constraints)) return stop('CONSTRAINTS_MISMATCH', { taskId: binding.taskId });
  }
  // The caller's currently-approved human top conditions must still be the
  // EXACT ones recorded in this evidence -- full id+statement, never ID
  // alone, so a condition whose statement was quietly changed (weakened,
  // narrowed, reworded) while keeping the same ID is treated as dropped/
  // replaced, not as still-authoritative. Only checked when the
  // orchestrator/receipt supplies the currently-approved set via
  // `expected.requiredActiveTopConditions`.
  if (expected.requiredActiveTopConditions !== undefined) {
    const current = normalizeCurrentConditionDefinitions(expected.requiredActiveTopConditions);
    if (!current) return stop('EXPECTED_BINDING_MALFORMED', { field: 'requiredActiveTopConditions' });
    const actual = normalizeCurrentConditionDefinitions((input.humanTopConditions || [])
      .filter((item) => item.active === true)
      .map(({ id, statement, linkedChecklistId }) => ({ id, statement,
        ...(linkedChecklistId !== undefined ? { linkedChecklistId } : {}) })));
    if (!actual || JSON.stringify(current) !== JSON.stringify(actual)) {
      return stop('TOP_CONDITION_DROPPED_OR_REPLACED', { taskId: binding.taskId });
    }
  }
  const now = Number.isInteger(expected.nowUtcMs) ? expected.nowUtcMs : Date.now();
  const age = now - binding.assessedAtUtcMs;
  if (!Number.isFinite(age) || age < 0 || age > binding.maxEvidenceAgeMs) {
    return stop('EVIDENCE_STALE', { taskId: binding.taskId });
  }

  const triggered = TRIGGER_KEYS.some((key) => input.triggers[key] === true);
  const deepResearchRequired = computeDeepResearchRequired(input);
  const checklist = input.checklist;

  const topConditions = evaluateTopConditions(input.humanTopConditions, checklist, input.triggers);
  const topConditionConflict = topConditions.conflict;
  const hasFail = checklist.some((item) => item.applicable === true && item.status === 'FAIL');
  const hasUnknown = checklist.some((item) => item.applicable === true && item.status === 'UNKNOWN');

  const decisionBasis = [];
  let result;
  let code;

  // Order matters: an explicit human top-condition conflict and a raw FAIL
  // both out-rank everything else, and FAIL out-ranks the deep-research/
  // adversarial-evidence check and the UNKNOWN/trial path -- a second AI not
  // having run yet must never suggest a mere trial when the first AI's raw
  // evidence already contains a FAIL.
  if (topConditionConflict) {
    result = 'REJECT';
    code = topConditionConflict.id;
    decisionBasis.push(topConditionConflict.statement);
  } else if (hasFail) {
    result = 'REJECT';
    code = 'CHECKLIST_FAIL_PRESENT';
    decisionBasis.push(...checklist.filter((item) => item.applicable === true && item.status === 'FAIL').map((item) => `${item.id}: ${item.justification}`));
  } else if (deepResearchRequired && (!input.deepResearch || input.deepResearch.adversarial?.present !== true)) {
    result = 'STOP';
    code = 'ADVERSARIAL_RESEARCH_EVIDENCE_MISSING';
    decisionBasis.push('Deep-Research-equivalent independent/adversarial evidence is required for this trigger profile and is missing.');
  } else if (hasUnknown) {
    result = 'TRIAL_REQUIRED';
    code = 'UNKNOWN_APPLICABLE_CONDITION_REQUIRES_TRIAL';
    decisionBasis.push(...checklist.filter((item) => item.applicable === true && item.status === 'UNKNOWN').map((item) => `${item.id}: ${item.justification}`));
  } else {
    result = triggered ? 'ADOPT' : 'BYPASS_LIGHT';
    code = triggered ? 'RESEARCH_GATE_CLEARED' : 'NO_TRIGGER_BYPASS_MINIMUM_SAFETY_CONFIRMED';
  }

  if (topConditions.otherStatements.length > 0) {
    decisionBasis.push(...topConditions.otherStatements.map((statement) => `OTHER (human top condition): ${statement}`));
  }

  const securityOrPrivacyUnknown = checklist.some((item) => (item.id === 'security' || item.id === 'privacy') && item.applicable === true && item.status === 'UNKNOWN');

  return {
    schemaVersion: SCHEMA_VERSION,
    result,
    code,
    taskId: binding.taskId,
    triggered,
    deepResearchRequired,
    decisionBasis,
    securityOrPrivacyUnknown,
    trialAuthorization: {
      permitted: result === 'TRIAL_REQUIRED',
      scope: result === 'TRIAL_REQUIRED' ? 'SYNTHETIC_BOUNDED_MINIMAL_ONLY' : 'NONE',
      generalImplementationAuthorized: false,
      realDataPermitted: false,
    },
    checklistSummary: checklist.map((item) => ({ id: item.id, status: item.status, applicable: item.applicable })),
    report: buildReport(input, checklist, result, code, decisionBasis),
  };
}

// Convenience export for orchestrator/receipt integration: true for any
// outcome that must block a source writer / install / account / config /
// external adoption from proceeding on this evidence.
export function blocksSourceWrite(result) {
  return !result || (result.result !== 'ADOPT' && result.result !== 'BYPASS_LIGHT');
}

// Strict orchestrator/receipt binding entry point. Raw evidence must never
// be trusted to validate itself: the caller (orchestrator / route receipt)
// MUST independently supply the full set of expected identity/scope fields
// it already holds for the current task, not merely whichever subset it
// happens to pass. Any missing expected field fails closed instead of
// silently skipping that comparison.
const REQUIRED_EXPECTED_BINDING_KEYS = ['taskId', 'proposalId', 'repository', 'scope', 'constraints'];
export function evaluateResearchGateBound(input, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return stop('EXPECTED_BINDING_REQUIRED');
  }
  const missing = REQUIRED_EXPECTED_BINDING_KEYS.filter((key) => expected[key] === undefined || expected[key] === null);
  if (missing.length > 0) return stop('EXPECTED_BINDING_INCOMPLETE', { missing });
  return evaluateResearchGate(input, expected);
}

const RESEARCH_ENVELOPE_KEYS = new Set(['evidence', 'context']);
const RESEARCH_CONTEXT_KEYS = new Set(['proposalId', 'constraints', 'humanTopConditions']);

// Shape-only validation for the single shared research envelope every
// source-write call site (implementation-orchestrator.mjs,
// implementation-runner.mjs, and implementation-route-receipt.mjs's pre-
// implementation AND final stages) must independently carry: the raw
// Research Gate evidence plus the CURRENT proposal/constraints/human-top-
// conditions this specific call is being bound against. This never itself
// decides ADOPT/REJECT/etc -- every call site must always independently
// re-evaluate the raw evidence via evaluateResearchGateBound using
// buildResearchExpectedBinding below, never trusting a caller-asserted
// result (the evidence schema has no such field at all).
function validateResearchContextShape(context) {
  const errors = [];
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.keys(context).some((key) => !RESEARCH_CONTEXT_KEYS.has(key))) {
    return ['research_context_invalid'];
  }
  if (!safeToken(context.proposalId)) errors.push('research_context_proposalId_invalid');
  if (!Array.isArray(context.constraints) || !context.constraints.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    errors.push('research_context_constraints_invalid');
  }
  if (!normalizeCurrentConditionDefinitions(context.humanTopConditions)) {
    errors.push('research_context_humanTopConditions_invalid');
  }
  return errors;
}

export function validateResearchEnvelopeShape(research) {
  if (!research || typeof research !== 'object' || Array.isArray(research)) return ['research_not_object'];
  if (Object.keys(research).some((key) => !RESEARCH_ENVELOPE_KEYS.has(key))) return ['research_unknown_field'];
  const errors = [];
  if (!research.evidence || typeof research.evidence !== 'object' || Array.isArray(research.evidence)) {
    errors.push('research_evidence_invalid');
  }
  errors.push(...validateResearchContextShape(research.context));
  return errors;
}

// Builds the expected Research Gate binding strictly from the caller's own
// already-validated task identity/repository/scope (never from the raw
// evidence itself, so evidence can never vouch for its own binding), plus
// the caller's current proposal/constraints/human-top-conditions context.
export function buildResearchExpectedBinding(research, { taskId, repository, scope }) {
  return {
    taskId,
    proposalId: research.context.proposalId,
    repository: { owner: repository.owner, name: repository.name },
    scope: [...scope],
    constraints: [...research.context.constraints],
    requiredActiveTopConditions: research.context.humanTopConditions.map((item) => ({ ...item })),
  };
}

export function evaluateResearchEnvelope(research, taskBinding, previousContext) {
  const errors = validateResearchEnvelopeShape(research);
  if (errors.length) return stop('RESEARCH_ENVELOPE_INVALID', { errors });
  if (!closedObject(taskBinding, new Set(['taskId', 'repository', 'scope'])) ||
      !safeToken(taskBinding.taskId) ||
      !closedObject(taskBinding.repository, new Set(['owner', 'name'])) ||
      !safeToken(taskBinding.repository.owner) || !safeToken(taskBinding.repository.name) ||
      !Array.isArray(taskBinding.scope) || taskBinding.scope.length === 0 ||
      taskBinding.scope.length > 50 || taskBinding.scope.some((item) => !boundedString(item, 500))) {
    return stop('TASK_BINDING_INVALID');
  }
  if (previousContext !== undefined) {
    const previousErrors = validateResearchContextShape(previousContext);
    if (previousErrors.length || research.context.proposalId !== previousContext.proposalId ||
        computeConstraintsDigest(research.context.constraints) !== computeConstraintsDigest(previousContext.constraints) ||
        JSON.stringify(normalizeCurrentConditionDefinitions(research.context.humanTopConditions)) !==
          JSON.stringify(normalizeCurrentConditionDefinitions(previousContext.humanTopConditions))) {
      return stop('CONTINUATION_RESEARCH_CONTEXT_CHANGED');
    }
  }
  return evaluateResearchGateBound(research.evidence, buildResearchExpectedBinding(research, taskBinding));
}

function parseArgs(argv) {
  const out = { inputPath: null, taskEnvelopePath: null, pretty: false, expectTaskId: null, expectProposalId: null, expectOwner: null, expectName: null, valid: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) out.inputPath = argv[++i];
    else if (arg === '--task-envelope-file' && argv[i + 1]) out.taskEnvelopePath = argv[++i];
    else if (arg === '--pretty') out.pretty = true;
    else if (arg === '--expect-task-id' && argv[i + 1]) out.expectTaskId = argv[++i];
    else if (arg === '--expect-proposal-id' && argv[i + 1]) out.expectProposalId = argv[++i];
    else if (arg === '--expect-owner' && argv[i + 1]) out.expectOwner = argv[++i];
    else if (arg === '--expect-name' && argv[i + 1]) out.expectName = argv[++i];
    else out.valid = false;
  }
  if (Boolean(out.inputPath) === Boolean(out.taskEnvelopePath)) out.valid = false;
  if (out.taskEnvelopePath && (out.expectTaskId || out.expectProposalId || out.expectOwner || out.expectName)) out.valid = false;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) {
    process.stdout.write(`${JSON.stringify(stop('ARGUMENT_INVALID'))}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.taskEnvelopePath) {
    let result;
    try {
      const packet = JSON.parse(fs.readFileSync(path.resolve(args.taskEnvelopePath), 'utf8'));
      if (!closedObject(packet, new Set(['schemaVersion', 'research', 'taskBinding', 'previousContext'])) || packet.schemaVersion !== 1) {
        result = stop('TASK_ENVELOPE_SCHEMA_INVALID');
      } else result = evaluateResearchEnvelope(packet.research, packet.taskBinding, packet.previousContext);
    } catch { result = stop('TASK_ENVELOPE_SCHEMA_INVALID'); }
    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    process.exitCode = blocksSourceWrite(result) ? 2 : 0;
    return;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(path.resolve(args.inputPath), 'utf8'));
  } catch {
    process.stdout.write(`${JSON.stringify(stop('SCHEMA_INVALID'))}\n`);
    process.exitCode = 2;
    return;
  }
  const expected = {};
  if (args.expectTaskId) expected.taskId = args.expectTaskId;
  if (args.expectProposalId) expected.proposalId = args.expectProposalId;
  if (args.expectOwner || args.expectName) expected.repository = { owner: args.expectOwner, name: args.expectName };
  const result = evaluateResearchGate(input, expected);
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  process.exitCode = (result.result === 'ADOPT' || result.result === 'BYPASS_LIGHT') ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();