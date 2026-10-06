#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  OFFICIAL_SOURCES, LIVE_IPAD_VERIFICATION, SYNTHETIC_FIXTURE_PRIMARY_SOURCE_REF,
  FIXTURE_ASSUMPTION_DISCLOSURE, runSimulation,
} from './apps-script-ipad-safari-redirect-fixture.mjs';

let assertions = 0;
function ok(value, message) {
  assert.ok(value, message);
  assertions += 1;
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

// --- Honesty boundary: citations are recorded, not fabricated as live fetches ---
ok(Array.isArray(OFFICIAL_SOURCES) && OFFICIAL_SOURCES.length === 3, 'exactly three official sources are cited (Apps Script ContentService, Apps Script multi-account troubleshooting, Firebase pricing)');
for (const source of OFFICIAL_SOURCES) {
  ok(/^https:\/\/[a-z0-9-]+\.google\.com\//.test(source.url), `official source is an actual Google-domain doc URL: ${source.url}`);
  equal(source.fetchedLiveDuringFixtureConstruction, false, `source ${source.id} is honestly marked as not live-fetched`);
  equal(source.rootFetchedAtUtc, '2026-10-04', `source ${source.id} records the actual root/parent research fetch date, distinct from this fixture's own non-fetch`);
}
ok(OFFICIAL_SOURCES.some((s) => s.url === 'https://developers.google.com/apps-script/guides/content'), 'ContentService redirect citation is the content guide (ContentService ONLY), not the general web guide');
ok(OFFICIAL_SOURCES.some((s) => s.url === 'https://developers.google.com/apps-script/guides/support/troubleshooting'), 'multi-account citation is the Apps Script troubleshooting guide (documents unsupported), not the generic Google Account help page');
ok(OFFICIAL_SOURCES.some((s) => s.url === 'https://firebase.google.com/pricing'), 'Firebase cost/billing findings are tied to the official Firebase pricing page');

equal(LIVE_IPAD_VERIFICATION.verified, false, 'live iPad Safari verification is honestly false for this offline fixture');
ok(/UNKNOWN/.test(LIVE_IPAD_VERIFICATION.reason), 'live verification reason states anonymous-session compatibility remains UNKNOWN');
ok(/not a universal incompatibility/i.test(LIVE_IPAD_VERIFICATION.reason), 'UNKNOWN is explicitly not generalized into a universal incompatibility claim');

ok(typeof FIXTURE_ASSUMPTION_DISCLOSURE === 'string' && /fabricated-fixture assumption/i.test(FIXTURE_ASSUMPTION_DISCLOSURE), 'the synthetic checklist disclosure explicitly labels itself a fabricated-fixture assumption');
ok(typeof SYNTHETIC_FIXTURE_PRIMARY_SOURCE_REF === 'string' && SYNTHETIC_FIXTURE_PRIMARY_SOURCE_REF.startsWith('synthetic-fixture-assumption://'), 'the non-official default source marker self-identifies as synthetic, never masquerading as a real citation');

const report = runSimulation();
equal(report.scenarios.length, 7, 'exactly 7 scenarios (A-G) are simulated');
equal(report.fixtureAssumptionDisclosure, FIXTURE_ASSUMPTION_DISCLOSURE, 'the simulation report carries the same honest fabricated-fixture disclosure');
ok(report.allPass, `all scenarios must match their expected result: ${JSON.stringify(report.scenarios.filter((s) => !s.pass))}`);

function scenario(id) {
  const found = report.scenarios.find((s) => s.id === id);
  ok(found, `scenario ${id} exists`);
  return found;
}

// A: Drive + iPad free transfer is REQUIRED (trigger TRUE + deep-research
// two-pass), but unresolved size/browser/route must still produce
// TRIAL_REQUIRED, never a falsely-adopted "free Drive videos always work" claim.
{
  const a = scenario('A');
  equal(a.detail.result, 'TRIAL_REQUIRED', 'scenario A requires a bounded trial for unresolved size/browser/route evidence instead of a false ADOPT');
  equal(a.detail.triggered, true, 'scenario A has an active risk trigger (largeTransfer)');
  equal(a.detail.deepResearchRequired, true, 'scenario A required Deep-Research-equivalent evidence (largeTransfer)');
  equal(a.detail.trialAuthorization.scope, 'SYNTHETIC_BOUNDED_MINIMAL_ONLY', 'scenario A trial stays bounded and synthetic');
  equal(a.detail.trialAuthorization.realDataPermitted, false, 'scenario A trial never permits real data');
  ok(a.detail.report.unknownIds.includes('size') && a.detail.report.unknownIds.includes('browserCompatibility') && a.detail.report.unknownIds.includes('corsCommunication'),
    'scenario A explicitly leaves size/browser/route (corsCommunication) unresolved rather than assuming PASS');
}

// B: new local Python library -> ordinary research ADOPT + explicit no-install environment-growth record.
{
  const b = scenario('B');
  equal(b.detail.research.result, 'ADOPT', 'scenario B basic-research ADOPT for a local low-risk library');
  equal(b.detail.research.deepResearchRequired, false, 'LOCAL_LOW_RISK relaxes the deep-research requirement for this trigger only');
  equal(b.detail.environmentGrowth.result, 'PROCEED', 'scenario B records environment growth without performing an actual install');
  equal(b.detail.environmentGrowth.additions[0].permissions, 'SAFE', 'recorded addition is classified SAFE');
}

// C: trivial 4px CSS change bypasses the research workload entirely.
{
  const c = scenario('C');
  equal(c.detail.result, 'BYPASS_LIGHT', 'scenario C bypasses research workload for a trivial local CSS edit');
  equal(c.detail.triggered, false, 'scenario C has no risk trigger');
}

// D: Firebase Spark/Blaze must stay service-specific, never a universal claim.
{
  const d = scenario('D');
  equal(d.detail.result, 'ADOPT', 'scenario D adopts the Spark-plan-specific evaluation');
  const billing = d.detail.report.cost.billingAccount;
  ok(billing.justification.includes('Spark') && billing.justification.includes('Blaze'),
    'billingAccount justification distinguishes Spark vs Blaze instead of asserting a universal free/paid claim');
  equal(billing.requiresBillingAccount, false, 'Spark selection does not require a billing account');
  equal(billing.primarySourceRef, 'https://firebase.google.com/pricing', 'billingAccount is genuinely backed by the real Firebase pricing citation, not a borrowed unrelated URL');
  equal(d.detail.report.cost.additionalCost.primarySourceRef, 'https://firebase.google.com/pricing', 'additionalCost is genuinely backed by the real Firebase pricing citation');
}

// E: Safari/Google compatibility genuinely unknown even after a separate
// adversarial session (bounded synthetic-minimal trial only), and an
// explicit missing-adversarial negative must STOP instead of falling
// through to that trial.
{
  const e = scenario('E');
  const { withAdversarial, missingAdversarial } = e.detail;
  equal(withAdversarial.result, 'TRIAL_REQUIRED', 'scenario E requires a bounded synthetic trial, not a manufactured PASS');
  equal(withAdversarial.trialAuthorization.scope, 'SYNTHETIC_BOUNDED_MINIMAL_ONLY', 'trial authorization stays bounded and synthetic');
  equal(withAdversarial.trialAuthorization.realDataPermitted, false, 'no real data is permitted by the bounded trial');
  const adversarial = withAdversarial.report.usedAI.adversarialProviderId;
  ok(adversarial && adversarial !== withAdversarial.report.usedAI.primaryProviderId, 'adversarial research used a separate session/provider from primary');
  equal(missingAdversarial.result, 'STOP', 'an explicit missing-adversarial variant of the SAME evidence must STOP, not silently fall through to the bounded trial');
  equal(missingAdversarial.code, 'ADVERSARIAL_RESEARCH_EVIDENCE_MISSING', 'missing-adversarial STOP code names the actual missing evidence');
  ok(missingAdversarial.trialAuthorization.permitted === false, 'the missing-adversarial negative never authorizes a trial either');
}

// F: REJECT stops before provider invocation; final receipt raw research removal fails closed.
{
  const f = scenario('F');
  const { orchestrator, passedReceipt, removalVerify } = f.detail;
  equal(orchestrator.result, 'STOP', 'orchestrator stops on REJECT evidence');
  equal(orchestrator.code, 'RESEARCH_GATE_BLOCKED', 'orchestrator stop code names the Research Gate block');
  equal(orchestrator.runner, null, 'orchestrator never reaches the provider runner after a REJECT');
  equal(orchestrator.researchGate.result, 'REJECT', 'the underlying raw evidence is an actual REJECT, not a trial/unknown');
  equal(passedReceipt.result, 'PASS', 'a separate non-blocking evidence set can still produce a valid PASS final receipt');
  equal(removalVerify.result, 'STOP', 'stripping the research envelope from an already-PASS final receipt fails verification');
  equal(removalVerify.code, 'RESEARCH_EVIDENCE_MISSING_OR_FAILED', 'raw research-evidence removal is detected and rejected');
}

// G: cleanup helper covers all 19 categories, all 4 closed classifications
// represented (incl. explicit publicUrls/listeners rows), no side effects.
{
  const g = scenario('G');
  equal(g.detail.result, 'PROCEED', 'cleanup audit records a classification-only PROCEED');
  ok(g.detail.note.includes('never performs stop/delete/revoke/disable side effects'), 'cleanup helper explicitly disclaims side effects');
  // PROCEED is only reachable once every one of the 19 closed categories was
  // explicitly accounted for (evaluateCleanupAudit fails closed on any
  // missing category), so this PASS is itself evidence of full coverage.
  equal(g.detail.rows.length, 5, 'exactly the five explicitly-classified rows are reported (remaining 14 categories were explicitly NONE_FOUND)');
  equal(g.detail.summary.KEEP + g.detail.summary.STOP + g.detail.summary.DELETE_CANDIDATE + g.detail.summary.HUMAN_DECISION_REQUIRED,
    g.detail.rows.length, 'summary counts match the classified rows (no untracked side state)');
  ok(g.detail.summary.KEEP > 0 && g.detail.summary.STOP > 0 && g.detail.summary.DELETE_CANDIDATE > 0 && g.detail.summary.HUMAN_DECISION_REQUIRED > 0,
    'all 4 closed cleanup classifications (KEEP/STOP/DELETE_CANDIDATE/HUMAN_DECISION_REQUIRED) are actually represented, not just 3');
  ok(g.detail.rows.some((row) => row.category === 'publicUrls'), 'publicUrls row is explicitly classified, never NONE_FOUND');
  ok(g.detail.rows.some((row) => row.category === 'listeners'), 'listeners row is explicitly classified, never NONE_FOUND');
}

process.stdout.write(`apps-script-ipad-safari-redirect-fixture-selftest: PASS (${assertions} assertions)\n`);
