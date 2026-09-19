#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const repoVisibility = argValue('--repo-visibility').toLowerCase();
const route = argValue('--route').toLowerCase();
const workflowMode = argValue('--workflow-mode', 'not-applicable').toLowerCase();
const workflowPath = argValue('--workflow-path').replaceAll('\\', '/');
const equivalentSafeRoute = argValue('--equivalent-safe-route', 'not-applicable').toLowerCase();
const quotaPercentRaw = argValue('--quota-percent');
const triggerReview = argValue('--trigger-review', 'not-applicable').toLowerCase();
const pathFilterReview = argValue('--path-filter-review', 'not-applicable').toLowerCase();
const concurrencyReview = argValue('--concurrency-review', 'not-applicable').toLowerCase();
const matrixReview = argValue('--matrix-review', 'not-applicable').toLowerCase();
const retryScope = argValue('--retry-scope', 'not-applicable').toLowerCase();
const failedOnlyRerunAvailable = argValue('--failed-only-rerun-available', 'not-applicable').toLowerCase();
const rerunCapabilityEvidence = argValue('--rerun-capability-evidence', 'not-applicable').toLowerCase();
const verificationPhase = argValue('--verification-phase', 'not-applicable').toLowerCase();
const samePropertyAlreadyPassed = argValue('--same-property-already-passed', 'not-applicable').toLowerCase();
const priorPassEvidenceSource = argValue('--prior-pass-evidence-source', 'not-applicable').toLowerCase();
const priorPassHead = argValue('--prior-pass-head');
const paidOverage = argValue('--paid-overage', 'denied').toLowerCase();
const jsonOnly = args.includes('--json');
const findings = [];
function add(status, code, detail = {}) { findings.push({ status, code, ...detail }); }
const REGISTRY_PATH = '.agents/github-actions-required-gates.json';
const WORKFLOW_RE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const allowedVisibility = new Set(['private', 'public']);
const allowedRoutes = new Set(['local', 'connector', 'github-hosted', 'self-hosted']);
const allowedModes = new Set(['not-applicable', 'temporary-one-shot', 'persistent', 'required-independent']);
const allowedEquivalent = new Set(['not-applicable', 'available', 'unavailable', 'unknown']);
const allowedReview = new Set(['not-applicable', 'pass', 'fail']);
const allowedRetry = new Set(['not-applicable', 'none', 'failed-only', 'full']);
const allowedYesNoNa = new Set(['not-applicable', 'yes', 'no']);
const allowedRerunEvidence = new Set(['not-applicable', 'github-api', 'connector', 'unavailable', 'unknown']);
const allowedVerificationPhase = new Set(['not-applicable','pre-merge','post-merge-required','deployment']);
const allowedSameProperty = new Set(['not-applicable','yes','no','unknown']);
const allowedPriorPassSource = new Set(['not-applicable','local-receipt','github-api','connector']);
const SHA_RE = /^[0-9a-f]{40}$/i;
const allowedPaid = new Set(['denied', 'human-approved', 'not-applicable']);

function cleanGitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
}
function gitText(args2) {
  const r = spawnSync('git', args2, { encoding:'utf8', windowsHide:true, timeout:5000, env:cleanGitEnv() });
  return { status:r.status, stdout:r.stdout || '', error:r.error || null };
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function loadRequiredRegistry(requiredWorkflowPath) {
  const root = gitText(['rev-parse','--show-toplevel']);
  const head = gitText(['rev-parse','HEAD']);
  if (root.error || root.status !== 0 || head.error || head.status !== 0) return { error:'ACTIONS_REQUIRED_GATE_REPOSITORY_UNVERIFIED' };
  const headSha = head.stdout.trim();
  const registry = gitText(['show', `${headSha}:${REGISTRY_PATH}`]);
  if (registry.error || registry.status !== 0) return { error:'ACTIONS_REQUIRED_GATE_REGISTRY_MISSING' };
  let parsed;
  try { parsed = JSON.parse(registry.stdout); } catch { return { error:'ACTIONS_REQUIRED_GATE_REGISTRY_INVALID' }; }
  if (!exactKeys(parsed, ['schemaVersion','gates']) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.gates)) {
    return { error:'ACTIONS_REQUIRED_GATE_REGISTRY_INVALID' };
  }
  const seen = new Set();
  for (const gate of parsed.gates) {
    if (!exactKeys(gate, ['workflowPath','status','reason'])) return { error:'ACTIONS_REQUIRED_GATE_REGISTRY_INVALID' };
    if (typeof gate.workflowPath !== 'string' || !WORKFLOW_RE.test(gate.workflowPath) || seen.has(gate.workflowPath)) return { error:'ACTIONS_REQUIRED_GATE_REGISTRY_INVALID' };
    if (gate.status !== 'required-independent' || typeof gate.reason !== 'string' || gate.reason.trim().length < 3 || gate.reason.length > 160 || /[\r\n]/.test(gate.reason)) return { error:'ACTIONS_REQUIRED_GATE_REGISTRY_INVALID' };
    seen.add(gate.workflowPath);
  }
  const entry = parsed.gates.find(g => g.workflowPath === requiredWorkflowPath);
  if (!entry) return { error:'ACTIONS_REQUIRED_GATE_NOT_REGISTERED' };
  const workflow = gitText(['cat-file','-e', `${headSha}:${requiredWorkflowPath}`]);
  if (workflow.error || workflow.status !== 0) return { error:'ACTIONS_REQUIRED_GATE_WORKFLOW_NOT_COMMITTED' };
  return { value:{ headSha, reason:entry.reason } };
}
if (!allowedVisibility.has(repoVisibility)) add('STOP', 'ACTIONS_REPO_VISIBILITY_REQUIRED');
if (!allowedRoutes.has(route)) add('STOP', 'ACTIONS_ROUTE_REQUIRED');
if (!allowedModes.has(workflowMode)) add('STOP', 'ACTIONS_WORKFLOW_MODE_INVALID');
if (!allowedEquivalent.has(equivalentSafeRoute)) add('STOP', 'ACTIONS_EQUIVALENT_ROUTE_INVALID');
if (![triggerReview, pathFilterReview, concurrencyReview, matrixReview].every(v => allowedReview.has(v))) add('STOP', 'ACTIONS_WORKFLOW_REVIEW_VALUE_INVALID');
if (!allowedRetry.has(retryScope)) add('STOP', 'ACTIONS_RETRY_SCOPE_INVALID');
if (!allowedYesNoNa.has(failedOnlyRerunAvailable)) add('STOP', 'ACTIONS_FAILED_ONLY_RERUN_VALUE_INVALID');
if (!allowedRerunEvidence.has(rerunCapabilityEvidence)) add('STOP', 'ACTIONS_RERUN_CAPABILITY_EVIDENCE_INVALID');
if (!allowedVerificationPhase.has(verificationPhase)) add('STOP', 'ACTIONS_VERIFICATION_PHASE_INVALID');
if (!allowedSameProperty.has(samePropertyAlreadyPassed)) add('STOP', 'ACTIONS_SAME_PROPERTY_EVIDENCE_INVALID');
if (!allowedPriorPassSource.has(priorPassEvidenceSource)) add('STOP', 'ACTIONS_PRIOR_PASS_EVIDENCE_SOURCE_INVALID');
if (!allowedPaid.has(paidOverage)) add('STOP', 'ACTIONS_PAID_OVERAGE_VALUE_INVALID');

const hostedWorkflow = route === 'github-hosted';
const privateHosted = hostedWorkflow && repoVisibility === 'private';
const persistentHosted = hostedWorkflow && (workflowMode === 'persistent' || workflowMode === 'required-independent');
const quotaPercent = quotaPercentRaw === '' ? null : Number(quotaPercentRaw);
if (hostedWorkflow && !WORKFLOW_RE.test(workflowPath)) add('STOP', 'ACTIONS_WORKFLOW_PATH_REQUIRED');
if (privateHosted && (quotaPercent === null || !Number.isFinite(quotaPercent) || quotaPercent < 0 || quotaPercent > 100)) {
  add('STOP', 'ACTIONS_PRIVATE_QUOTA_EVIDENCE_REQUIRED');
}
if (hostedWorkflow && workflowMode === 'not-applicable') add('STOP', 'ACTIONS_WORKFLOW_MODE_REQUIRED');
if (hostedWorkflow && equivalentSafeRoute === 'not-applicable') add('STOP', 'ACTIONS_EQUIVALENT_ROUTE_REVIEW_REQUIRED');
if (persistentHosted) {
  if (triggerReview !== 'pass') add('STOP', 'ACTIONS_TRIGGER_REVIEW_REQUIRED');
  if (pathFilterReview !== 'pass') add('STOP', 'ACTIONS_PATH_FILTER_REVIEW_REQUIRED');
  if (concurrencyReview !== 'pass') add('STOP', 'ACTIONS_CONCURRENCY_REVIEW_REQUIRED');
  if (matrixReview !== 'pass') add('STOP', 'ACTIONS_MATRIX_REVIEW_REQUIRED');
}
if (privateHosted && workflowMode === 'temporary-one-shot') {
  if (equivalentSafeRoute === 'available') add('STOP', 'ACTIONS_PRIVATE_ONE_SHOT_SAFE_ROUTE_AVAILABLE', { requiredAction:'use-local-or-connector-route' });
  if (equivalentSafeRoute === 'unknown') add('STOP', 'ACTIONS_EQUIVALENT_ROUTE_UNKNOWN', { requiredAction:'review-local-and-connector-routes' });
}
if (privateHosted && workflowMode === 'persistent' && equivalentSafeRoute === 'available') {
  add('STOP', 'ACTIONS_PRIVATE_HOSTED_SAFE_ROUTE_AVAILABLE', { requiredAction:'use-equivalent-safe-route-or-register-independent-need' });
}
let requiredGateEvidence = null;
if (privateHosted && workflowMode === 'required-independent') {
  if (equivalentSafeRoute !== 'unavailable') add('STOP', 'ACTIONS_REQUIRED_GATE_EQUIVALENT_ROUTE_NOT_EXCLUDED');
  if (WORKFLOW_RE.test(workflowPath)) {
    const proof = loadRequiredRegistry(workflowPath);
    if (proof.error) add('STOP', proof.error);
    else {
      requiredGateEvidence = proof.value;
      add('INFO', 'ACTIONS_REQUIRED_GATE_COMMITTED_POLICY_MATCH', { workflowPath, registryPath:REGISTRY_PATH, headSha:proof.value.headSha });
    }
  }
}
if (privateHosted && Number.isFinite(quotaPercent) && quotaPercent >= 90 && workflowMode !== 'required-independent') {
  add('STOP', 'ACTIONS_QUOTA_PRESSURE_NONREQUIRED_HOSTED_ROUTE_BLOCKED', { quotaPercent });
}
if (privateHosted && Number.isFinite(quotaPercent) && quotaPercent >= 100 && paidOverage !== 'human-approved') {
  add('STOP', 'ACTIONS_INCLUDED_QUOTA_EXHAUSTED', { quotaPercent, requiredAction:'stop-hosted-actions-or-obtain-human-cost-approval' });
}
if (privateHosted && Number.isFinite(quotaPercent) && quotaPercent >= 90 && workflowMode === 'required-independent' && requiredGateEvidence) {
  add('WARN', 'ACTIONS_QUOTA_PRESSURE_REQUIRED_GATE_PRESERVED', { quotaPercent });
}
if (hostedWorkflow && samePropertyAlreadyPassed === 'unknown') add('STOP', 'ACTIONS_DUPLICATE_VERIFICATION_EVIDENCE_REQUIRED');
const duplicateSkipCandidate = hostedWorkflow && samePropertyAlreadyPassed === 'yes' && !['post-merge-required','deployment'].includes(verificationPhase);
if (duplicateSkipCandidate) {
  if (!['local-receipt','github-api','connector'].includes(priorPassEvidenceSource) || !SHA_RE.test(priorPassHead)) {
    add('STOP', 'ACTIONS_PRIOR_PASS_EVIDENCE_REQUIRED');
  } else {
    const head = gitText(['rev-parse','HEAD']);
    if (head.error || head.status !== 0) add('STOP', 'ACTIONS_PRIOR_PASS_REPOSITORY_UNVERIFIED');
    else if (head.stdout.trim().toLowerCase() !== priorPassHead.toLowerCase()) add('STOP', 'ACTIONS_PRIOR_PASS_HEAD_MISMATCH');
    else add('STOP', 'ACTIONS_DUPLICATE_VERIFICATION_ALREADY_PROVEN', { requiredAction:'reuse-existing-pass-evidence', priorPassEvidenceSource, priorPassHead });
  }
}
if (retryScope === 'full' && failedOnlyRerunAvailable === 'yes') {
  if (rerunCapabilityEvidence === 'github-api' || rerunCapabilityEvidence === 'connector') {
    add('STOP', 'ACTIONS_FAILED_ONLY_RERUN_REQUIRED', { requiredAction:'rerun-failed-job-or-failed-jobs-only' });
  } else {
    add('STOP', 'ACTIONS_RERUN_CAPABILITY_EVIDENCE_REQUIRED');
  }
}
if (failedOnlyRerunAvailable === 'yes' && !['github-api','connector'].includes(rerunCapabilityEvidence)) {
  add('STOP', 'ACTIONS_RERUN_CAPABILITY_EVIDENCE_REQUIRED');
}
if (failedOnlyRerunAvailable === 'no' && ['github-api','connector'].includes(rerunCapabilityEvidence)) {
  add('STOP', 'ACTIONS_RERUN_CAPABILITY_EVIDENCE_CONFLICT');
}
if (retryScope !== 'not-applicable' && retryScope !== 'none' && failedOnlyRerunAvailable === 'not-applicable') {
  add('STOP', 'ACTIONS_RERUN_CAPABILITY_REVIEW_REQUIRED');
}
if (route === 'local' || route === 'connector' || route === 'self-hosted') {
  add('INFO', 'ACTIONS_INCLUDED_MINUTES_NOT_USED_BY_SELECTED_ROUTE', { route });
}
if (hostedWorkflow && repoVisibility === 'public') {
  add('INFO', 'ACTIONS_PUBLIC_STANDARD_HOSTED_ROUTE', { note:'private-repository included-minute pressure does not apply' });
}
if (!findings.some(f => f.status === 'STOP')) add('PASS', 'ACTIONS_COST_ROUTE_ACCEPTABLE');
const result = findings.some(f => f.status === 'STOP') ? 'STOP' : 'PROCEED';
const output = { result, repoVisibility, route, workflowMode, workflowPath:workflowPath || null, equivalentSafeRoute, quotaPercent,
  triggerReview, pathFilterReview, concurrencyReview, matrixReview, retryScope, failedOnlyRerunAvailable,
  rerunCapabilityEvidence, verificationPhase, samePropertyAlreadyPassed, priorPassEvidenceSource, priorPassHead:priorPassHead || null, paidOverage, requiredGateEvidence, findings };
console.log(JSON.stringify(output, null, jsonOnly ? 0 : 2));
process.exit(result === 'PROCEED' ? 0 : 2);