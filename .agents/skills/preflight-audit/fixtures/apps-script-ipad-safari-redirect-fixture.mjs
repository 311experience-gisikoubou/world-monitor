#!/usr/bin/env node
// Real synthetic fixture + executable simulation for a recurring real-world
// shape: an Apps Script ContentService/HtmlService web app opened from an
// iPad Safari anonymous/private/multi-login session, plus the adjacent
// decisions a task like this actually raises (free Drive transfer, a new
// local library, a trivial CSS tweak, Firebase plan selection, unresolved
// browser-compatibility risk, a rejected research gate, and a cleanup
// audit). This module calls the REAL preflight gates (research-gate,
// environment-lifecycle-audit, implementation-orchestrator,
// implementation-route-receipt) with synthetic input. It is not a new gate
// or skill: it is a fixture + simulation runner that exercises the existing
// ones, as referenced from preflight-audit/SKILL.md.
//
// Honesty boundary: every fact below that is attributed to Google is a
// citation of an existing OFFICIAL_SOURCES entry, not a live fetch performed
// while building this fixture (see `fetchedLiveDuringFixtureConstruction` on
// each entry). The parent research that identified/verified these three
// official sources fetched them on `rootFetchedAtUtc` (2026-10-04); THIS
// FIXTURE FILE ITSELF never performed that fetch and never re-verifies it.
//
// Corrected scope of each citation (never generalized beyond what it
// actually documents):
//   - The ContentService guide documents a one-time redirect to a
//     script.googleusercontent.com URL for CONTENTSERVICE responses only.
//     It is never cited here for HtmlService, and the separate Web Apps
//     execution-identity guide is never treated as general redirect
//     evidence.
//   - The Apps Script multi-account troubleshooting guide documents that
//     using multiple signed-in Google accounts at once is an UNSUPPORTED
//     configuration for Apps Script, not merely "has limitations".
//   - The Firebase pricing page documents PLAN-SPECIFIC (Spark vs Blaze)
//     cost/billing behavior; it is never cited as a universal
//     free-vs-paid claim for every Firebase service.
//
// Actual anonymous/private iPad Safari session behavior for this specific
// flow is NOT measured here and is never asserted as a universal
// incompatibility either; see `LIVE_IPAD_VERIFICATION`. This file never
// performs a live fetch, never drives a real browser/iPad, and never
// invokes a real AI provider or real Claude CLI execution. Every
// PASS/FAIL/UNKNOWN checklist status and justification below is a
// fabricated-fixture assumption for this offline simulation only -- see
// `FIXTURE_ASSUMPTION_DISCLOSURE` -- not an authenticated real-world fact.

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  CHECKLIST_IDS,
  MINIMAL_BYPASS_CHECKLIST_IDS,
  TRIGGER_KEYS,
  computeConstraintsDigest,
  evaluateResearchGate,
} from '../research-gate.mjs';
import {
  CLEANUP_CATEGORIES,
  evaluateCleanupAudit,
  evaluateEnvironmentGrowth,
} from '../environment-lifecycle-audit.mjs';
import { runImplementationOrchestration } from '../implementation-orchestrator.mjs';
import { evaluateReceipt, verifyFinalReceipt } from '../implementation-route-receipt.mjs';

// The root/parent research that identified and read these three official
// pages did so on this date. This fixture module's own construction did
// NOT perform a live fetch (see `fetchedLiveDuringFixtureConstruction` on
// each entry, which stays false regardless of `rootFetchedAtUtc`).
const ROOT_FETCHED_AT_UTC = '2026-10-04';

export const OFFICIAL_SOURCES = Object.freeze([
  {
    id: 'apps-script-contentservice-redirect',
    url: 'https://developers.google.com/apps-script/guides/content',
    note: 'Official Apps Script ContentService guide (ContentService ONLY, not HtmlService, and not a general web-app-execution-identity claim): a deployed ContentService response is served through a one-time redirect to a script.googleusercontent.com URL rather than the permanent /exec URL.',
    rootFetchedAtUtc: ROOT_FETCHED_AT_UTC,
    fetchedLiveDuringFixtureConstruction: false,
  },
  {
    id: 'apps-script-multi-account-troubleshooting',
    url: 'https://developers.google.com/apps-script/guides/support/troubleshooting',
    note: 'Official Apps Script troubleshooting guide, multi-account section: using multiple signed-in Google accounts at once with Apps Script is documented as an UNSUPPORTED configuration, not merely "has limitations". The separate Web Apps guide documents execution identity (who a deployed script runs as); it is never cited here as redirect-behavior generalization.',
    rootFetchedAtUtc: ROOT_FETCHED_AT_UTC,
    fetchedLiveDuringFixtureConstruction: false,
  },
  {
    id: 'firebase-pricing',
    url: 'https://firebase.google.com/pricing',
    note: 'Official Firebase pricing page: cost/billing behavior (e.g. the Spark vs Blaze plan) is SERVICE- and PLAN-specific. Cited here only to tie this fixture\'s Firebase cost/billing findings to the Spark plan explicitly; Spark is never treated as a universally-available or universally-free tier for every Firebase service.',
    rootFetchedAtUtc: ROOT_FETCHED_AT_UTC,
    fetchedLiveDuringFixtureConstruction: false,
  },
]);

// Explicit, non-official-evidence marker for every checklist row in this
// fixture that is NOT directly backed by one of the three OFFICIAL_SOURCES
// above. It must never be mistaken for a real primary-source citation: it
// names itself as a fabricated-fixture assumption so no unsupported factual
// quote can masquerade as official evidence.
export const SYNTHETIC_FIXTURE_PRIMARY_SOURCE_REF =
  'synthetic-fixture-assumption://no-live-primary-source-fabricated-offline-fixture-only';

// All-PASS (or any-status) checklist rows in this fixture are synthetic,
// fabricated-fixture assumptions built for this offline simulation only.
// They are never authenticated real-world facts, even when a row's
// justification text happens to reference an OFFICIAL_SOURCES citation.
export const FIXTURE_ASSUMPTION_DISCLOSURE =
  'Every PASS/FAIL/UNKNOWN checklist status and justification in this fixture (scenarios A-G) is a fabricated-fixture assumption for this offline synthetic simulation only. Only the three OFFICIAL_SOURCES citations (and their quoted scope) are real, honestly-labeled external citations; they were read by the parent/root research on rootFetchedAtUtc, not fetched live by this fixture file. No checklist PASS here is proof of an actual, verified real-world fact, and iPad Safari anonymous-session compatibility stays genuinely UNKNOWN (never a universal incompatibility claim) per LIVE_IPAD_VERIFICATION.';

// Real-device truth is never manufactured by a synthetic gate run. This
// fixture's PASS/REJECT/TRIAL_REQUIRED results are evidence-checklist
// simulations only; they are not proof of actual iPad Safari behavior.
export const LIVE_IPAD_VERIFICATION = Object.freeze({
  verified: false,
  reason: 'This fixture is an offline synthetic simulation. No real iPad, no real Safari session (anonymous or signed-in), and no real multi-login state was exercised. Anonymous/private-session compatibility for this flow remains genuinely UNKNOWN until an actual device/session measurement is recorded -- this is NOT a universal incompatibility claim, only an honest absence of a real measurement.',
});

const DAY_MS = 24 * 60 * 60 * 1000;

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
function checklistItem(id, status, overrides = {}) {
  const applicable = overrides.applicable !== undefined ? overrides.applicable : true;
  const base = {
    id,
    status,
    applicable,
    justification: overrides.justification || `Evaluated ${id} for this synthetic Apps Script scenario.`,
  };
  if (applicable === true && (status === 'PASS' || status === 'FAIL')) {
    // Default to the explicit synthetic-fixture marker, never to an
    // unrelated real OFFICIAL_SOURCES URL: borrowing e.g. the ContentService
    // redirect citation as a default source for an unrelated row (Drive
    // transfer timing, billing, etc.) would be an unsupported factual quote
    // masquerading as official evidence. Call sites that ARE genuinely
    // backed by one of the three real citations pass an explicit
    // `primarySourceRef` override.
    base.primarySourceRef = overrides.primarySourceRef || SYNTHETIC_FIXTURE_PRIMARY_SOURCE_REF;
  }
  if (applicable === false) {
    base.inapplicableReason = overrides.inapplicableReason || 'Not applicable for this scenario.';
  }
  if (overrides.requiresBillingAccount !== undefined) base.requiresBillingAccount = overrides.requiresBillingAccount;
  return base;
}
function fullChecklist(overridesById = {}) {
  return CHECKLIST_IDS.map((id) => {
    const o = overridesById[id];
    if (!o) return checklistItem(id, 'PASS');
    const status = o.status ?? (o.applicable === false ? 'UNKNOWN' : 'PASS');
    return checklistItem(id, status, o);
  });
}
function minimalChecklist(overridesById = {}) {
  return MINIMAL_BYPASS_CHECKLIST_IDS.map((id) => {
    const o = overridesById[id];
    if (!o) return checklistItem(id, 'PASS');
    const status = o.status ?? (o.applicable === false ? 'UNKNOWN' : 'PASS');
    return checklistItem(id, status, o);
  });
}
function binding(overrides = {}) {
  const constraints = overrides.constraints ?? [];
  return {
    taskId: overrides.taskId ?? 'apps-script-ipad-fixture-task',
    proposalId: overrides.proposalId ?? 'apps-script-ipad-fixture-proposal',
    repository: overrides.repository ?? { owner: 'synthetic-owner', name: 'synthetic-repo' },
    scope: overrides.scope ?? ['src/apps-script/**'],
    constraints,
    constraintsDigestSha256: computeConstraintsDigest(constraints),
    assessedAtUtcMs: Date.now(),
    maxEvidenceAgeMs: DAY_MS,
  };
}
function deepResearch(primaryProvider, adversarialProvider, { rationale } = {}) {
  const sameProvider = adversarialProvider === primaryProvider;
  return {
    primary: {
      providerId: primaryProvider,
      researchSessionRef: `research-session://primary/${primaryProvider}/apps-script-ipad`,
      evidenceRef: OFFICIAL_SOURCES[0].url,
    },
    adversarial: {
      present: true,
      providerId: adversarialProvider,
      researchSessionRef: `research-session://adversarial/${adversarialProvider}/apps-script-ipad`,
      distinctFromPrimary: !sameProvider,
      evidenceRef: OFFICIAL_SOURCES[1].url,
      ...(sameProvider ? { sameProviderRationale: rationale || 'Only one qualified research route was available for this synthetic fixture.' } : {}),
    },
  };
}
function aiBasicResearcher(id = 'chatgpt-research', ref = 'research-session://basic/chatgpt-research/apps-script-ipad') {
  return { researcherId: id, kind: 'AI_PROVIDER', researchSessionRef: ref };
}
function researchEnvelope(evidence, { proposalId, constraints = [], humanTopConditions = [] }) {
  return { evidence, context: { proposalId, constraints, humanTopConditions } };
}

// --- Scenario A: Drive + iPad free transfer is a REQUIRED capability, but
//     size/browser/route stay genuinely unresolved -> TRIAL_REQUIRED, never
//     a falsely-adopted "free Drive videos always work" claim ------------
function scenarioAEvidence() {
  const checklist = fullChecklist({
    // size/browserCompatibility/corsCommunication are left UNKNOWN on
    // purpose: actual per-user video file size, actual iPad Safari
    // handling, and the actual client-to-Drive-API request route for this
    // flow were never measured. A trivial "it's free Drive so it's fine"
    // PASS here would falsely ADOPT an unresolved real-world risk; the
    // deep-research-backed two-pass evidence below only proves the
    // capability is REQUIRED and reviewed, not that every unresolved row is
    // actually safe.
    size: { status: 'UNKNOWN', justification: 'Actual free-tier video file sizes vary per user and were never measured; whether every case stays within the free Drive quota is unresolved, not assumed PASS.' },
    browserCompatibility: { status: 'UNKNOWN', justification: 'Actual iPad Safari handling of this Drive transfer route was never measured end-to-end; see LIVE_IPAD_VERIFICATION.' },
    corsCommunication: { status: 'UNKNOWN', justification: 'The actual client-to-Drive-API request route for this transfer was never verified end-to-end for this iPad Safari session.' },
    time: { justification: 'Transfer duration depends on network; a conservative client timeout is used instead of assuming instantaneous completion.' },
    retention: { justification: 'Transferred files remain in the user Drive account under the existing Drive retention; no extra Foundation-owned retention store is created.' },
    region: { justification: 'No region restriction applies to this free consumer Drive usage.' },
    failure: { justification: 'A failed transfer leaves the source file untouched and reports failure; no silent partial state.' },
    resend: { justification: 'Resend is a plain user-initiated retry; no automatic resend loop exists.' },
    ack: { justification: 'Success is reported to the user only after the Drive API acknowledges the upload.' },
    recovery: { justification: 'Recovery relies on existing Drive trash/version history; no additional backup mechanism is introduced.' },
  });
  return {
    schemaVersion: 1,
    evidenceBinding: binding({ taskId: 'apps-script-ipad-fixture-a', proposalId: 'apps-script-ipad-fixture-a-proposal', constraints: ['free-tier-only', 'ipad-safari-client'] }),
    triggers: triggersWith('largeTransfer'),
    checklist,
    humanTopConditions: [
      { id: 'ZERO_ADDITIONAL_COST', active: true, statement: 'This transfer path must not add any cost beyond the existing free Drive tier.' },
    ],
    deepResearch: deepResearch('chatgpt-research', 'gemini-research'),
    basicResearcher: null,
  };
}

// --- Scenario B: new local Python library (existing-alternatives + env growth) ---
function scenarioBEvidence() {
  const checklist = fullChecklist({
    existingOverlap: { justification: 'Compared against the stdlib csv module and two other maintained libraries before selecting this one; see Existing Solution / OSS Reuse Check.' },
    maintenance: { justification: 'Library has active maintenance releases; it has no account or network footprint, so there is no ongoing provider maintenance exposure.' },
    removal: { justification: 'Uninstalling the library removes its entire footprint; there is no server-side state to clean up.' },
  });
  return {
    schemaVersion: 1,
    evidenceBinding: binding({ taskId: 'apps-script-ipad-fixture-b', proposalId: 'apps-script-ipad-fixture-b-proposal', constraints: ['local-only', 'no-network-dependency'] }),
    triggers: triggersWith('newCloudApiServiceAppLibraryCliAccount'),
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'LOCAL_LOW_RISK',
    checklist,
    humanTopConditions: [],
    deepResearch: null,
    basicResearcher: aiBasicResearcher(),
  };
}
function scenarioBEnvironmentGrowthInput() {
  return {
    schemaVersion: 1,
    additions: [{
      item: 'python-library-x (local CSV parsing helper)',
      need: 'Parse exported CSV rows without hand-written regex.',
      alternative: 'Considered the stdlib csv module and two other maintained libraries; this one has the smallest dependency footprint for the same need.',
      residency: 'Installed inside the existing local virtual environment only.',
      egress: 'None; the library performs no network calls.',
      autoUpdate: false,
      permissions: 'SAFE',
      permissionDetails: 'Import-only Python package installed inside the existing local virtual environment; no network access, no filesystem access outside the venv, no credentials, no elevated/admin rights.',
      size: '~80 KB wheel',
      remove: 'pip uninstall python-library-x',
      stop: 'No running process; import-only usage, so there is nothing to stop.',
    }],
  };
}

// --- Scenario C: trivial 4px CSS change -> BYPASS_LIGHT, no Deep Research --
function scenarioCEvidence() {
  return {
    schemaVersion: 1,
    evidenceBinding: binding({ taskId: 'apps-script-ipad-fixture-c', proposalId: 'apps-script-ipad-fixture-c-proposal', constraints: [] }),
    triggers: noTriggers(),
    noTriggerAssessment: {
      reasonCode: 'PURE_CSS_OR_TEXT_CHANGE',
      justification: 'Adjusts a 4px padding value on an existing local UI element; no new service, data, or network behavior is introduced.',
    },
    checklist: minimalChecklist(),
    humanTopConditions: [],
    deepResearch: null,
    basicResearcher: null,
  };
}

// --- Scenario D: Firebase Spark/Blaze is SERVICE-SPECIFIC, not universal ---
function scenarioDEvidence() {
  const checklist = fullChecklist({
    // Each row below is genuinely backed by the real Firebase pricing
    // citation (OFFICIAL_SOURCES[2]), tied to the explicit Spark plan --
    // never a universal Firebase free/paid claim, and never the unrelated
    // Apps Script citations.
    additionalCost: { justification: 'On the Firebase Spark plan, this usage level adds no cost. The Blaze plan would add metered cost beyond the free quota for the same usage; this evaluation targets the Spark plan only, not Firebase in general.', primarySourceRef: OFFICIAL_SOURCES[2].url },
    freeTierExceedBehavior: { justification: 'On Spark, exceeding the free quota blocks further writes rather than charging. Blaze would charge instead of blocking. This project stays on Spark.', primarySourceRef: OFFICIAL_SOURCES[2].url },
    billingAccount: { justification: 'The Spark plan does not require a billing account. The Blaze plan would require one for metered usage. Selecting Spark avoids creating a billing account.', requiresBillingAccount: false, primarySourceRef: OFFICIAL_SOURCES[2].url },
    automaticBilling: { justification: 'Spark has no automatic billing because no billing account exists on this plan; this would differ under Blaze.', primarySourceRef: OFFICIAL_SOURCES[2].url },
  });
  return {
    schemaVersion: 1,
    evidenceBinding: binding({ taskId: 'apps-script-ipad-fixture-d', proposalId: 'apps-script-ipad-fixture-d-proposal', constraints: ['firebase-spark-plan-only'] }),
    triggers: triggersWith('newCloudApiServiceAppLibraryCliAccount', 'feeOrFreeQuota'),
    newCloudApiServiceAppLibraryCliAccountRiskProfile: 'EXTERNAL_OR_HIGH_RISK',
    checklist,
    humanTopConditions: [
      { id: 'BILLING_ACCOUNT_NOT_ALLOWED', active: true, statement: 'No billing account may be created for this feature.' },
    ],
    deepResearch: deepResearch('chatgpt-research', 'gemini-research'),
    basicResearcher: null,
  };
}

// --- Scenario E: Google + Safari compatibility genuinely unknown. With a
//     real separate adversarial session, this is a bounded SYNTHETIC-MINIMAL
//     trial only (never a manufactured PASS); an explicit negative variant
//     with the adversarial session missing proves the gate STOPs instead. --
function scenarioEEvidence() {
  const checklist = fullChecklist({
    browserCompatibility: {
      status: 'UNKNOWN',
      justification: 'No live iPad Safari anonymous/private-session measurement was performed. Google documents the ContentService one-time redirect and the Apps Script multi-account troubleshooting guide documents multi-login as unsupported, but actual anonymous-session behavior on iPad Safari for this specific flow was not directly measured; see LIVE_IPAD_VERIFICATION.',
    },
  });
  return {
    schemaVersion: 1,
    evidenceBinding: binding({ taskId: 'apps-script-ipad-fixture-e', proposalId: 'apps-script-ipad-fixture-e-proposal', constraints: ['ipad-safari-anonymous-session'] }),
    triggers: triggersWith('osBrowserCompatibility'),
    checklist,
    humanTopConditions: [],
    // A separate adversarial session (a different provider from primary) is
    // required before an UNKNOWN browser-compatibility row can even reach
    // the bounded trial path; it does not manufacture a PASS by itself.
    deepResearch: deepResearch('chatgpt-research', 'gemini-research'),
    basicResearcher: null,
  };
}
// Explicit negative variant: the SAME evidence, but with the required
// adversarial research session missing entirely (primary only). This must
// STOP (ADVERSARIAL_RESEARCH_EVIDENCE_MISSING), never silently fall through
// to the bounded trial path -- a second AI not having run yet is a harder
// block than an UNKNOWN row by itself.
function scenarioEMissingAdversarialEvidence() {
  return {
    ...scenarioEEvidence(),
    deepResearch: {
      primary: {
        providerId: 'chatgpt-research',
        researchSessionRef: 'research-session://primary/chatgpt-research/apps-script-ipad-missing-adversarial',
        evidenceRef: OFFICIAL_SOURCES[0].url,
      },
      adversarial: { present: false },
    },
  };
}

// --- Scenario F: REJECT stops before provider invocation; final receipt
//     raw research-evidence removal fails -----------------------------------
function scenarioFRejectEvidence() {
  return {
    schemaVersion: 1,
    evidenceBinding: binding({ taskId: 'apps-script-ipad-fixture-f', proposalId: 'apps-script-ipad-fixture-f-proposal', constraints: [] }),
    triggers: noTriggers(),
    noTriggerAssessment: {
      reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL',
      justification: 'Synthetic REJECT fixture for scenario F: simulates a raw evidence FAIL to prove the stop happens before any provider invocation.',
    },
    checklist: minimalChecklist({
      safety: { status: 'FAIL', justification: 'Synthetic FAIL: simulates an unsafe finding so the gate must REJECT before Claude (or any provider) is ever probed or invoked.' },
    }),
    humanTopConditions: [],
    deepResearch: null,
    basicResearcher: null,
  };
}
function scenarioFOrchestratorPayload() {
  const evidence = scenarioFRejectEvidence();
  const research = researchEnvelope(evidence, { proposalId: evidence.evidenceBinding.proposalId, constraints: [], humanTopConditions: [] });
  return {
    schemaVersion: 1,
    taskId: evidence.evidenceBinding.taskId,
    kind: 'implementation',
    objective: 'Synthetic scenario F: prove a REJECT stops before provider invocation.',
    prompt: 'This prompt must never reach a real provider because the Research Gate rejects the raw evidence first.',
    repoRoot: 'C:/synthetic/apps-script-ipad-fixture-does-not-exist',
    branch: 'feat/apps-script-ipad-fixture-f',
    allowedScope: evidence.evidenceBinding.scope,
    dataClass: 'synthetic',
    repository: evidence.evidenceBinding.repository,
    instructionClarity: {
      schemaVersion: 1,
      taskId: evidence.evidenceBinding.taskId,
      instructions: [{ id: 'instr-1', kind: 'INSTRUCTION', summary: 'Synthetic instruction for scenario F.' }],
      unlistedAssumptionsPresent: false,
      ambiguities: [],
    },
    research,
  };
}
function scenarioFReceiptEvidence() {
  return {
    schemaVersion: 1,
    evidenceBinding: binding({ taskId: 'apps-script-ipad-fixture-f-final', proposalId: 'apps-script-ipad-fixture-f-final-proposal', constraints: [] }),
    triggers: noTriggers(),
    noTriggerAssessment: {
      reasonCode: 'LOCAL_SAFE_EDIT_NO_RISK_SIGNAL',
      justification: 'Synthetic non-blocking evidence used only to build a PASS final receipt for the raw-removal test below.',
    },
    checklist: minimalChecklist(),
    humanTopConditions: [],
    deepResearch: null,
    basicResearcher: null,
  };
}
function scenarioFFinalReceiptInput() {
  const evidence = scenarioFReceiptEvidence();
  const research = researchEnvelope(evidence, { proposalId: evidence.evidenceBinding.proposalId, constraints: [], humanTopConditions: [] });
  return {
    schemaVersion: 1,
    stage: 'final',
    task: { id: evidence.evidenceBinding.taskId, kind: 'implementation' },
    executor: { id: 'claude-implementation-write', provider: 'claude', routeType: 'qualified-agent' },
    repository: evidence.evidenceBinding.repository,
    branch: 'feat/apps-script-ipad-fixture-f',
    allowedScope: evidence.evidenceBinding.scope,
    dataClass: 'synthetic',
    costPolicy: 'no-new-cost',
    instructionClarity: {
      schemaVersion: 1,
      taskId: evidence.evidenceBinding.taskId,
      instructions: [{ id: 'instr-1', kind: 'INSTRUCTION', summary: 'Synthetic instruction for scenario F final receipt.' }],
      unlistedAssumptionsPresent: false,
      ambiguities: [],
    },
    research,
    implementationHead: 'a'.repeat(40),
    executionEvidence: {
      preHead: 'b'.repeat(40),
      changeSetSha256: 'c'.repeat(64),
      changedPaths: ['src/apps-script/web-app.gs'],
    },
  };
}

// --- Scenario G: actual cleanup helper call, 19 categories, all 4 closed
//     classifications represented (incl. explicit publicUrls/listeners
//     rows), no actual side effects ------------------------------------
function scenarioGCleanupAuditInput() {
  const categories = {};
  for (const category of CLEANUP_CATEGORIES) categories[category] = 'NONE_FOUND';
  categories.worktrees = [{
    item: 'apps-script-ipad-fixture job worktree',
    classification: 'KEEP',
    rationale: 'Still referenced by an active job status.json; not stale.',
  }];
  categories.temp = [{
    item: 'temporary research-gate task-envelope file used by run-claude-job.ps1',
    classification: 'STOP',
    rationale: 'Already removed by the launcher\'s own finally block; nothing further to delete.',
  }];
  categories.oauth = [{
    item: 'Apps Script web app OAuth consent for the executing Google account',
    classification: 'HUMAN_DECISION_REQUIRED',
    rationale: 'Revoking account-level OAuth consent is a human/account decision, not an automatic cleanup action.',
  }];
  // Explicit publicUrls/listener rows: a deployed Apps Script web app
  // publishes a public /exec URL, and a local test session can leave a
  // webhook listener/port-forward behind. Both are classified here (never
  // NONE_FOUND), covering the remaining DELETE_CANDIDATE classification so
  // all 4 closed classifications (KEEP/STOP/DELETE_CANDIDATE/
  // HUMAN_DECISION_REQUIRED) are actually represented, not just 3.
  categories.publicUrls = [{
    item: 'Apps Script /exec public web app URL for this deployment',
    classification: 'HUMAN_DECISION_REQUIRED',
    rationale: 'Un-publishing/revoking a public Apps Script deployment URL is a human/account-level decision, not an automatic cleanup action.',
  }];
  categories.listeners = [{
    item: 'synthetic local test webhook listener/port-forward used while exercising this fixture',
    classification: 'DELETE_CANDIDATE',
    rationale: 'No longer referenced by any active job or test deployment; a safe manual-deletion candidate, never auto-deleted by this helper.',
  }];
  return { schemaVersion: 1, categories };
}

export function runSimulation() {
  const rows = [];

  const a = evaluateResearchGate(scenarioAEvidence());
  rows.push({
    id: 'A',
    title: 'Drive + iPad free transfer: trigger TRUE + deep-research two-pass, but unresolved size/browser/route -> TRIAL_REQUIRED, never a falsely-adopted free-Drive-videos claim',
    expected: 'TRIAL_REQUIRED',
    actual: a.result,
    pass: a.result === 'TRIAL_REQUIRED' && a.triggered === true && a.deepResearchRequired === true
      && a.trialAuthorization?.scope === 'SYNTHETIC_BOUNDED_MINIMAL_ONLY' && a.trialAuthorization?.realDataPermitted === false,
    detail: a,
  });

  const bResearch = evaluateResearchGate(scenarioBEvidence());
  const bGrowth = evaluateEnvironmentGrowth(scenarioBEnvironmentGrowthInput());
  rows.push({
    id: 'B',
    title: 'New local Python library (existing alternatives + environment growth, no actual install)',
    expected: 'ADOPT + PROCEED',
    actual: `${bResearch.result} + ${bGrowth.result}`,
    pass: bResearch.result === 'ADOPT' && bGrowth.result === 'PROCEED',
    detail: { research: bResearch, environmentGrowth: bGrowth },
  });

  const c = evaluateResearchGate(scenarioCEvidence());
  rows.push({ id: 'C', title: 'Trivial 4px CSS change (BYPASS_LIGHT, no Deep Research)', expected: 'BYPASS_LIGHT', actual: c.result, pass: c.result === 'BYPASS_LIGHT' && c.triggered === false, detail: c });

  const d = evaluateResearchGate(scenarioDEvidence());
  const billingRow = d.report?.cost?.billingAccount;
  const serviceSpecific = Boolean(billingRow?.justification?.includes('Spark') && billingRow?.justification?.includes('Blaze'));
  rows.push({ id: 'D', title: 'Firebase Spark/Blaze (service-specific, no universal free/paid claim)', expected: 'ADOPT', actual: d.result, pass: d.result === 'ADOPT' && serviceSpecific, detail: d });

  const e = evaluateResearchGate(scenarioEEvidence());
  const eMissingAdversarial = evaluateResearchGate(scenarioEMissingAdversarialEvidence());
  rows.push({
    id: 'E',
    title: 'Google + Safari compatibility unknown: bounded synthetic-minimal TRIAL_REQUIRED with a real adversarial session, and an explicit missing-adversarial negative STOP',
    expected: 'TRIAL_REQUIRED (with adversarial) / STOP (missing adversarial)',
    actual: `${e.result} / ${eMissingAdversarial.result}`,
    pass: e.result === 'TRIAL_REQUIRED' && e.trialAuthorization?.scope === 'SYNTHETIC_BOUNDED_MINIMAL_ONLY' && e.trialAuthorization?.realDataPermitted === false
      && eMissingAdversarial.result === 'STOP' && eMissingAdversarial.code === 'ADVERSARIAL_RESEARCH_EVIDENCE_MISSING',
    detail: { withAdversarial: e, missingAdversarial: eMissingAdversarial },
  });

  // desc:null keeps this fully offline: the Research Gate REJECT must stop
  // the orchestrator before it ever resolves or probes a real provider
  // executable, so no provider descriptor is supplied here.
  const fOrchestrator = runImplementationOrchestration(scenarioFOrchestratorPayload(), { desc: null });
  const fPassedReceipt = evaluateReceipt(scenarioFFinalReceiptInput());
  const fTamperedReceipt = { ...fPassedReceipt };
  delete fTamperedReceipt.research;
  const fRemovalVerify = verifyFinalReceipt(fTamperedReceipt, {
    owner: fTamperedReceipt.repository?.owner,
    name: fTamperedReceipt.repository?.name,
    branch: fTamperedReceipt.branch,
    head: fTamperedReceipt.implementationHead,
  });
  rows.push({
    id: 'F',
    title: 'REJECT stops before provider invocation; final receipt raw research removal fails',
    expected: 'RESEARCH_GATE_BLOCKED (orchestrator) + RESEARCH_EVIDENCE_MISSING_OR_FAILED (receipt)',
    actual: `${fOrchestrator.code} + ${fRemovalVerify.code}`,
    pass: fOrchestrator.result === 'STOP' && fOrchestrator.code === 'RESEARCH_GATE_BLOCKED' && fOrchestrator.runner === null
      && fPassedReceipt.result === 'PASS'
      && fRemovalVerify.result === 'STOP' && fRemovalVerify.code === 'RESEARCH_EVIDENCE_MISSING_OR_FAILED',
    detail: { orchestrator: fOrchestrator, passedReceipt: fPassedReceipt, removalVerify: fRemovalVerify },
  });

  const gInput = scenarioGCleanupAuditInput();
  const coversAllCategories = CLEANUP_CATEGORIES.every((category) => category in gInput.categories)
    && Object.keys(gInput.categories).length === CLEANUP_CATEGORIES.length;
  const g = evaluateCleanupAudit(gInput);
  rows.push({
    id: 'G',
    title: 'Cleanup helper covers 19 categories, classification only, no side effects',
    expected: 'PROCEED',
    actual: g.result,
    pass: g.result === 'PROCEED' && Boolean(g.note) && g.note.includes('never performs stop/delete/revoke/disable side effects') && coversAllCategories,
    detail: g,
  });

  return {
    schemaVersion: 1,
    officialSources: OFFICIAL_SOURCES,
    liveIpadVerification: LIVE_IPAD_VERIFICATION,
    fixtureAssumptionDisclosure: FIXTURE_ASSUMPTION_DISCLOSURE,
    scenarios: rows,
    allPass: rows.every((row) => row.pass === true),
  };
}

function main() {
  const pretty = process.argv.includes('--pretty');
  const result = runSimulation();
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
  process.exitCode = result.allPass ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
