#!/usr/bin/env node
import process from 'node:process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { observeProjectContextEvidence, parseJsonStrict } from '../handoff/project-context-guard.mjs';

export const SCHEMA_VERSION = 3;
export const WIP_REVIEW_MAX_AGE_MS = 5 * 60 * 1000;
export const PROJECT_GUARD_MAX_AGE_MS = 5 * 60 * 1000;
export const MAX_INPUT_BYTES = 64 * 1024;

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'evidenceComplete', 'changeClass', 'dataMode',
  'executionScope', 'impacts', 'changedFiles', 'wipReview', 'projectGuard',
]);
const WIP_REVIEW_KEYS = new Set(['decision', 'evidenceFetchedAt']);
const WIP_DECISIONS = new Set(['CONTINUE', 'STOP_NEW_WORK']);
const WIP_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROJECT_GUARD_KEYS = new Set(['expectedRepository','expectedProjectIdentifier','expectedContextFingerprint','referenceRepository','targetIssueRepository','targetPrRepository','operationType','route']);
const ROUTE_KEYS = new Set(['selection','selectedPathId','alternateReasonCode','alternateReason']);
const REGISTRY_KEYS = new Set(['schemaVersion','routes']);
const REGISTRY_ROUTE_KEYS = new Set(['id','operationType','status','runtimeRequirements']);
const RUNTIME_REQUIREMENT_KEYS = new Set(['kind','subject','processName','commandContains']);
const OPERATION_TYPES = new Set(['read-only-reference','branch-create','issue-create','pr-create','product-implementation','real-device','write']);
const CHANGE_OPERATION_TYPES = new Set(['branch-create','issue-create','pr-create','product-implementation','real-device','write']);
const RUNTIME_KINDS = new Set(['process','tunnel','preview-server','device-session']);
const ROUTE_SELECTIONS = new Set(['known-good','alternate','new','known-failed-under-test','not-applicable']);
const REGISTRY_ROUTE_STATUSES = new Set(['known-good','candidate','known-failed']);
const ALTERNATE_REASON_CODES = new Set(['purpose-mismatch','required-capability-missing','environment-incompatible','safety-boundary','route-under-test']);
const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/;
const ROUTE_ID_RE = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const PROCESS_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;
const WINDOWS_POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_CIM_MODULE_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\CimCmdlets\\CimCmdlets.psd1';
const WINDOWS_UTILITY_MODULE_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1';
const WINDOWS_SYSTEM_MODULE_ROOT = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
export const KNOWN_GOOD_REGISTRY_PATH = '.agents/known-good-paths.json';
const IMPACT_KEYS = [
  'production', 'network', 'realDevice', 'installOrAdoption',
  'dependency', 'securitySensitive', 'authOrCredential', 'mergeAuthority',
  'workflowOrDeployment', 'databaseOrMigration', 'externalDataRoute',
  'recurringCost', 'lifecycle', 'businessPolicy', 'architecture',
];
const FAST_CHANGE_CLASSES = new Set(['routine', 'configuration', 'implementation']);
const ALLOWED_CHANGE_CLASSES = new Set([
  ...FAST_CHANGE_CLASSES, 'architecture', 'install-adoption',
  'external-data-route', 'recurring-cost', 'lifecycle-responsibility',
  'workflow-impact', 'business-policy',
]);
const FAST_DATA_MODES = new Set(['source-only', 'synthetic', 'public']);
const ALLOWED_DATA_MODES = new Set([...FAST_DATA_MODES, 'real', 'protected']);
const ALLOWED_EXECUTION_SCOPES = new Set([
  'local-dev', 'interactive', 'real-device', 'network', 'production',
]);
const FAST_REQUIRED_CHECKS = [
  'SECURITY_PREFLIGHT', 'TARGETED_TESTS', 'GIT_DIFF_CHECK',
  'MERGE_AUTHORIZATION_IF_MERGING',
];
const FAST_SKIPPED_CHECKS = [
  'OPERATION_PREFLIGHT_MULTI_STEP_ONLY', 'FULL_SELFTEST_SUITE_HEAVY_FLOW_ONLY',
];
const FULL_REQUIRED_CHECKS = ['EXISTING_FULL_GATE_FLOW', 'MERGE_AUTHORIZATION_IF_MERGING'];

const SENSITIVE_PATH_RULES = [
  ['SENSITIVE_PATH_SECURITY', /(^|\/)(auth|authentication|authorization|oauth|security|credentials?|secrets?|permissions?)(?:[._-][^/]*)?(\/|$)|(^|\/)\.env(?:\.|$)/i],
  ['SENSITIVE_PATH_DATABASE', /(^|\/)(db|database|migrations?|schema)(?:[._-][^/]*)?(\/|$)|\.sql$/i],
  ['SENSITIVE_PATH_WORKFLOW', /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)azure-pipelines\.ya?ml$|(^|\/)Jenkinsfile$|(^|\/)bitbucket-pipelines\.ya?ml$|(^|\/)(deploy|deployment|infra|terraform|k8s|kubernetes|helm)(?:[._-][^\/]*)?(\/|$)|(^|\/)Dockerfile(?:\.[^\/]+)?$|(^|\/)(?:docker-)?compose(?:\.[^\/]+)?\.ya?ml$/i],
  ['SENSITIVE_PATH_MERGE_GATE', /(^|\/)\.agents\/skills\/final-pr-audit(\/|$)/i],
  ['SENSITIVE_PATH_GOVERNANCE_GATE', /(^|\/)\.agents\/skills\//i],
  ['SENSITIVE_PATH_DEPENDENCY', /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.(?:toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|go\.(?:mod|sum)|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.lockfile|[^/]+\.csproj|Directory\.Packages\.props|packages\.lock\.json|setup\.(?:py|cfg)|pubspec\.(?:yaml|lock)|mix\.(?:exs|lock)|Package\.(?:swift|resolved))$/i],
];

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(object, allowed) {
  return Object.keys(object).every(key => allowed.has(key));
}
function validRepoPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !value.includes('\\') && !value.includes('\0')
    && !value.startsWith('/') && !/^[A-Za-z]:\//.test(value)
    && !value.split('/').some(part => part === '..' || part === '.' || part === '');
}
function invalidReport(code) {
  return {
    schemaVersion: SCHEMA_VERSION,
    evidenceValid: false,
    workStartAllowed: false,
    decision: 'FULL_GATE',
    reasons: [code],
    requiredChecks: FULL_REQUIRED_CHECKS,
    skippedChecks: [],
  };
}

function canonicalWipTimestamp(value) {
  const ms = typeof value === 'string' && WIP_TIMESTAMP_RE.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function canonicalRepo(value) {
  if (typeof value !== 'string' || value !== value.trim() || !REPO_ID_RE.test(value)) return null;
  const [owner, name] = value.split('/');
  if (!owner || !name || owner.length > 39 || name.length > 100 || name === '.' || name === '..') return null;
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}
function canonicalProjectId(value) {
  return typeof value === 'string' && value === value.trim() && PROJECT_ID_RE.test(value) ? value : null;
}
function canonicalOptionalRepo(value) {
  return value === null ? null : canonicalRepo(value);
}
function canonicalOptionalText(value, maxLength = 500, minLength = 1) {
  if (value === null) return null;
  return typeof value === 'string' && value === value.trim() && value.length >= minLength && value.length <= maxLength && !/[\u0000-\u001F\u007F]/.test(value) ? value : undefined;
}
function validContextFingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function normalizeLiveObservation(value) {
  if (!isObject(value) || value.result !== 'PROCEED') return { error: value?.code ?? 'PROJECT_CONTEXT_OBSERVATION_FAILED' };
  const actualRepository = canonicalRepo(value.actualRepository);
  const worktreeRepository = canonicalRepo(value.worktreeRepository);
  const projectContextId = canonicalProjectId(value.projectContextId);
  const currentBranch = canonicalOptionalText(value.currentBranch, 250);
  const headSha = typeof value.headSha === 'string' && /^[a-f0-9]{40}$/.test(value.headSha) ? value.headSha : null;
  if (!actualRepository || !worktreeRepository || !projectContextId || !validContextFingerprint(value.contextFingerprint) || !currentBranch || !headSha || !canonicalWipTimestamp(value.observedAt)) return { error: 'PROJECT_CONTEXT_OBSERVATION_INVALID' };
  return { value: { actualRepository, worktreeRepository, projectContextId, contextFingerprint:value.contextFingerprint, currentBranch, headSha, observedAt:value.observedAt } };
}
export function observeLiveProjectContext() {
  return observeProjectContextEvidence(path.resolve(process.cwd(), 'PROJECT_CONTEXT.json'));
}
function normalizeKnownGoodRoutes(routes) {
  if (!Array.isArray(routes) || routes.length > 50) return { error:'KNOWN_GOOD_REGISTRY_INVALID' };
  const ids = new Set(); const normalized = [];
  for (const route of routes) {
    if (!isObject(route) || !exactKeys(route, REGISTRY_ROUTE_KEYS) || Object.keys(route).length !== REGISTRY_ROUTE_KEYS.size) return { error:'KNOWN_GOOD_REGISTRY_INVALID' };
    if (typeof route.id !== 'string' || !ROUTE_ID_RE.test(route.id) || ids.has(route.id) || !CHANGE_OPERATION_TYPES.has(route.operationType) || !REGISTRY_ROUTE_STATUSES.has(route.status) || !Array.isArray(route.runtimeRequirements) || route.runtimeRequirements.length > 10) return { error:'KNOWN_GOOD_REGISTRY_INVALID' };
    const requirementKeys = new Set(); const runtimeRequirements = [];
    for (const requirement of route.runtimeRequirements) {
      if (!isObject(requirement) || !exactKeys(requirement, RUNTIME_REQUIREMENT_KEYS) || Object.keys(requirement).length !== RUNTIME_REQUIREMENT_KEYS.size || !RUNTIME_KINDS.has(requirement.kind) || typeof requirement.subject !== 'string' || !ROUTE_ID_RE.test(requirement.subject) || typeof requirement.processName !== 'string' || !PROCESS_NAME_RE.test(requirement.processName) || !Array.isArray(requirement.commandContains) || requirement.commandContains.length < 1 || requirement.commandContains.length > 4) return { error:'KNOWN_GOOD_REGISTRY_INVALID' };
      const commandContains = requirement.commandContains.map(value => canonicalOptionalText(value, 160, 1));
      if (commandContains.some(value => value === undefined || value === null) || new Set(commandContains).size !== commandContains.length) return { error:'KNOWN_GOOD_REGISTRY_INVALID' };
      const key = requirement.kind + ':' + requirement.subject; if (requirementKeys.has(key)) return { error:'KNOWN_GOOD_REGISTRY_INVALID' }; requirementKeys.add(key);
      runtimeRequirements.push({ kind:requirement.kind, subject:requirement.subject, processName:requirement.processName, commandContains });
    }
    if (route.operationType === 'real-device' && runtimeRequirements.length === 0) return { error:'KNOWN_GOOD_REGISTRY_REAL_DEVICE_RUNTIME_REQUIRED' };
    ids.add(route.id); normalized.push({ id:route.id, operationType:route.operationType, status:route.status, runtimeRequirements });
  }
  return { value:normalized };
}
function cleanGitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
}
function decodeUtf8Fatal(value) {
  if (!Buffer.isBuffer(value)) return null;
  try { return new TextDecoder('utf-8', { fatal:true }).decode(value); } catch { return null; }
}
function gitText(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { windowsHide:true, timeout:5000, env:cleanGitEnv() });
  const stdout = decodeUtf8Fatal(result.stdout);
  return { status:result.status, error:result.error || (stdout === null ? new Error('utf8') : null), stdout:stdout ?? '' };
}
function gitRoot(cwd) {
  const probe = gitText(cwd, ['rev-parse','--show-toplevel']);
  if (probe.error || probe.status !== 0 || !probe.stdout.trim()) return { error:'PROJECT_GUARD_REPOSITORY_UNVERIFIED' };
  return { value:path.resolve(probe.stdout.trim()) };
}
function loadKnownGoodRoutes(root, headSha) {
  const listed = gitText(root, ['ls-tree','--name-only',headSha,'--',KNOWN_GOOD_REGISTRY_PATH]);
  if (listed.error || listed.status !== 0) return { error:'KNOWN_GOOD_REGISTRY_REPOSITORY_UNVERIFIED' };
  if (listed.stdout.trim() === '') return { value:[], present:false };
  if (listed.stdout.trim() !== KNOWN_GOOD_REGISTRY_PATH) return { error:'KNOWN_GOOD_REGISTRY_INVALID' };
  const shown = gitText(root, ['show',headSha + ':' + KNOWN_GOOD_REGISTRY_PATH]);
  if (shown.error || shown.status !== 0) return { error:'KNOWN_GOOD_REGISTRY_INVALID' };
  try { const parsed = parseJsonStrict(shown.stdout); if (!isObject(parsed) || !exactKeys(parsed, REGISTRY_KEYS) || Object.keys(parsed).length !== REGISTRY_KEYS.size || parsed.schemaVersion !== 1) return { error:'KNOWN_GOOD_REGISTRY_INVALID' }; const normalized = normalizeKnownGoodRoutes(parsed.routes); return normalized.error ? normalized : { value:normalized.value, present:true }; }
  catch { return { error:'KNOWN_GOOD_REGISTRY_INVALID' }; }
}
function activeProjectAuthority() {
  const repository = canonicalRepo(process.env.AI_ACTIVE_TASK_REPOSITORY);
  const projectContextId = canonicalProjectId(process.env.AI_ACTIVE_PROJECT_CONTEXT_ID);
  const contextFingerprint = process.env.AI_ACTIVE_PROJECT_CONTEXT_FINGERPRINT;
  if (!repository || !projectContextId || !validContextFingerprint(contextFingerprint)) return { error:'PROJECT_CONTEXT_AUTHORITY_REQUIRED' };
  return { value:{ repository, projectContextId, contextFingerprint } };
}
function runtimeProbeEnv() {
  const env = Object.fromEntries(Object.entries(cleanGitEnv()).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
  env.PSModulePath = WINDOWS_SYSTEM_MODULE_ROOT;
  return env;
}
function decodeBase64Utf8Fatal(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) return null;
    return new TextDecoder('utf-8', { fatal:true }).decode(bytes);
  } catch { return null; }
}
function observeRuntimeProcesses() {
  if (process.platform !== 'win32') return { error:'RUNTIME_PROCESS_PROBE_UNSUPPORTED_PLATFORM' };
  const command = "$ErrorActionPreference='Stop'; $PSModuleAutoloadingPreference='None'; Import-Module -Name '" + WINDOWS_UTILITY_MODULE_PATH + "' -Force -ErrorAction Stop; Import-Module -Name '" + WINDOWS_CIM_MODULE_PATH + "' -Force -ErrorAction Stop; $items=CimCmdlets\\Get-CimInstance -ClassName Win32_Process -ErrorAction Stop; foreach($item in $items){$name=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$item.Name));$cmd=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$item.CommandLine));[Console]::Out.WriteLine(([string][int]$item.ProcessId)+'|'+$name+'|'+$cmd)}";
  const result = spawnSync(WINDOWS_POWERSHELL_PATH, ['-NoProfile','-NonInteractive','-Command',command], { windowsHide:true, timeout:10000, maxBuffer:2 * 1024 * 1024, env:runtimeProbeEnv() });
  const text = decodeUtf8Fatal(result.stdout);
  if (result.error || result.status !== 0 || text === null) return { error:'RUNTIME_PROCESS_PROBE_FAILED' };
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length > 4096) return { error:'RUNTIME_PROCESS_PROBE_FAILED' };
  const value = [];
  for (const line of lines) {
    const parts=line.split('|');
    if (parts.length !== 3 || !/^(?:0|[1-9][0-9]*)$/.test(parts[0])) return { error:'RUNTIME_PROCESS_PROBE_FAILED' };
    const name=decodeBase64Utf8Fatal(parts[1]); const commandLine=decodeBase64Utf8Fatal(parts[2]);
    if (!name || commandLine === null) return { error:'RUNTIME_PROCESS_PROBE_FAILED' };
    value.push({ name:name.toLowerCase(), commandLine });
  }
  return { value };
}
function runtimeBindingMarker(live) {
  const digest = createHash('sha256').update(live.actualRepository + '\n' + live.contextFingerprint).digest('hex');
  return 'ai-bind-' + digest;
}
function commandLineHasUniqueBinding(commandLine, expected) {
  const markers = commandLine.toLowerCase().match(/(?<![a-z0-9])ai-bind-[a-f0-9]{64}(?![a-z0-9])/g) ?? [];
  return markers.length === 1 && markers[0] === expected;
}
function probeRouteRuntime(route, live) {
  if (route.runtimeRequirements.length === 0) return null;
  const snapshot = observeRuntimeProcesses(); if (snapshot.error) return snapshot.error;
  const binding = runtimeBindingMarker(live);
  for (const requirement of route.runtimeRequirements) {
    const expectedName = requirement.processName.toLowerCase();
    const tokens = requirement.commandContains.map(token => token.toLowerCase());
    const found = snapshot.value.some(item => { const commandLine = item.commandLine.toLowerCase(); return item.name === expectedName && commandLineHasUniqueBinding(commandLine, binding) && tokens.every(token => commandLine.includes(token)); });
    if (!found) return 'RUNTIME_STATE_NOT_READY';
  }
  return null;
}
function validateRoute(route, applicableRoutes) {
  if (!isObject(route) || !exactKeys(route, ROUTE_KEYS) || Object.keys(route).length !== ROUTE_KEYS.size || !ROUTE_SELECTIONS.has(route.selection)) return 'ROUTE_EVIDENCE_INVALID';
  const selectedPathId = route.selectedPathId === null ? null : (typeof route.selectedPathId === 'string' && ROUTE_ID_RE.test(route.selectedPathId) ? route.selectedPathId : undefined);
  const alternateReason = canonicalOptionalText(route.alternateReason, 500, 12);
  const alternateReasonCode = route.alternateReasonCode === null ? null : (ALTERNATE_REASON_CODES.has(route.alternateReasonCode) ? route.alternateReasonCode : undefined);
  if (selectedPathId === undefined || alternateReason === undefined || alternateReasonCode === undefined) return 'ROUTE_EVIDENCE_INVALID';
  const knownGood = applicableRoutes.filter(item => item.status === 'known-good');
  const candidates = applicableRoutes.filter(item => item.status === 'candidate');
  const knownFailed = applicableRoutes.filter(item => item.status === 'known-failed');
  const knownIds = new Set(knownGood.map(item => item.id));
  const candidateIds = new Set(candidates.map(item => item.id));
  const knownFailedIds = new Set(knownFailed.map(item => item.id));
  const recordedIds = new Set([...knownIds, ...candidateIds, ...knownFailedIds]);
  if (applicableRoutes.length === 0) return route.selection === 'not-applicable' && selectedPathId === null && alternateReason === null && alternateReasonCode === null ? null : 'ROUTE_SELECTION_CONFLICT';
  if (selectedPathId && !recordedIds.has(selectedPathId)) return 'UNRECORDED_ROUTE_SELECTION';
  if (selectedPathId && knownFailedIds.has(selectedPathId) && route.selection !== 'known-failed-under-test') return 'KNOWN_FAILED_ROUTE_BLOCKED';
  if (route.selection === 'known-failed-under-test') return selectedPathId && knownFailedIds.has(selectedPathId) && alternateReasonCode === 'route-under-test' && alternateReason ? null : 'KNOWN_FAILED_ROUTE_UNDER_TEST_INVALID';
  if (knownGood.length > 0) {
    if (route.selection === 'known-good') return selectedPathId && knownIds.has(selectedPathId) && alternateReason === null && alternateReasonCode === null ? null : 'KNOWN_GOOD_PATH_REQUIRED';
    if (route.selection === 'alternate') return selectedPathId && candidateIds.has(selectedPathId) && alternateReasonCode && alternateReason ? null : 'ALTERNATE_ROUTE_JUSTIFICATION_REQUIRED';
    return 'KNOWN_GOOD_PATH_REQUIRED';
  }
  if (candidates.length > 0) return route.selection === 'new' && selectedPathId && candidateIds.has(selectedPathId) && alternateReason === null && alternateReasonCode === null ? null : 'ROUTE_SELECTION_CONFLICT';
  return 'NO_USABLE_ROUTE_AVAILABLE';
}
export function validateProjectGuard(guard) {
  if (!isObject(guard)) return 'PROJECT_GUARD_REQUIRED';
  if (!exactKeys(guard, PROJECT_GUARD_KEYS) || Object.keys(guard).length !== PROJECT_GUARD_KEYS.size) return 'PROJECT_GUARD_INVALID';
  const expectedRepository = canonicalRepo(guard.expectedRepository);
  const expectedProjectIdentifier = canonicalProjectId(guard.expectedProjectIdentifier);
  const expectedContextFingerprint = guard.expectedContextFingerprint;
  const referenceRepository = canonicalOptionalRepo(guard.referenceRepository);
  const targetIssueRepository = canonicalOptionalRepo(guard.targetIssueRepository);
  const targetPrRepository = canonicalOptionalRepo(guard.targetPrRepository);
  if (!expectedRepository || !expectedProjectIdentifier || !validContextFingerprint(expectedContextFingerprint) || (guard.referenceRepository !== null && !referenceRepository) || (guard.targetIssueRepository !== null && !targetIssueRepository) || (guard.targetPrRepository !== null && !targetPrRepository)) return 'PROJECT_GUARD_IDENTITY_INVALID';
  if (!OPERATION_TYPES.has(guard.operationType)) return 'OPERATION_TYPE_INVALID';
  const authority = activeProjectAuthority(); if (authority.error) return authority.error;
  if (authority.value.repository !== expectedRepository || authority.value.projectContextId !== expectedProjectIdentifier || authority.value.contextFingerprint !== expectedContextFingerprint) return 'PROJECT_GUARD_EXPECTED_AUTHORITY_MISMATCH';
  const observed = normalizeLiveObservation(observeLiveProjectContext()); if (observed.error) return observed.error;
  const live = observed.value; const nowMs = Date.now(); const observedMs = Date.parse(live.observedAt);
  if (observedMs > nowMs) return 'PROJECT_CONTEXT_OBSERVATION_FROM_FUTURE';
  if (nowMs - observedMs > PROJECT_GUARD_MAX_AGE_MS) return 'PROJECT_CONTEXT_OBSERVATION_STALE';
  if (live.actualRepository !== expectedRepository || live.worktreeRepository !== expectedRepository) return 'EXPECTED_REPOSITORY_MISMATCH';
  if (live.projectContextId !== expectedProjectIdentifier || live.contextFingerprint !== expectedContextFingerprint) return 'PROJECT_CONTEXT_TRANSITION_MISMATCH';
  if (guard.operationType === 'read-only-reference') { if (!referenceRepository || targetIssueRepository || targetPrRepository) return 'READ_ONLY_REFERENCE_TARGET_INVALID'; }
  else {
    if (referenceRepository) return 'REFERENCE_REPOSITORY_WRITE_CONFLICT';
    if (targetIssueRepository && targetIssueRepository !== expectedRepository) return 'TARGET_ISSUE_REPOSITORY_MISMATCH';
    if (targetPrRepository && targetPrRepository !== expectedRepository) return 'TARGET_PR_REPOSITORY_MISMATCH';
    if (guard.operationType === 'issue-create' && !targetIssueRepository) return 'TARGET_ISSUE_REPOSITORY_REQUIRED';
    if (guard.operationType === 'pr-create' && !targetPrRepository) return 'TARGET_PR_REPOSITORY_REQUIRED';
  }
  const rootResult = gitRoot(process.cwd()); if (rootResult.error) return rootResult.error; const root = rootResult.value;
  const registry = loadKnownGoodRoutes(root, live.headSha); if (registry.error) return registry.error;
  if (guard.operationType === 'real-device' && !registry.present) return 'KNOWN_GOOD_REGISTRY_REQUIRED_FOR_REAL_DEVICE';
  const applicableRoutes = registry.value.filter(item => item.operationType === guard.operationType);
  const routeError = validateRoute(guard.route, applicableRoutes); if (routeError) return routeError;
  const selectedRoute = guard.route.selectedPathId ? applicableRoutes.find(item => item.id === guard.route.selectedPathId) : null;
  if (guard.operationType === 'real-device' && !selectedRoute) return 'REAL_DEVICE_ROUTE_REQUIRED';
  if (selectedRoute) { const runtimeError = probeRouteRuntime(selectedRoute, live); if (runtimeError) return runtimeError; }
  const finalObserved = normalizeLiveObservation(observeLiveProjectContext());
  if (finalObserved.error) return 'PROJECT_CONTEXT_CHANGED_DURING_GUARD';
  const end = finalObserved.value;
  for (const key of ['actualRepository','worktreeRepository','projectContextId','contextFingerprint','currentBranch','headSha']) if (end[key] !== live[key]) return 'PROJECT_CONTEXT_CHANGED_DURING_GUARD';
  return null;
}
export function validateEvidence(evidence) {
  if (!isObject(evidence)) return 'EVIDENCE_SHAPE_INVALID';
  if (!exactKeys(evidence, TOP_LEVEL_KEYS)) return 'EVIDENCE_UNKNOWN_FIELD';
  if (evidence.schemaVersion !== SCHEMA_VERSION) return 'EVIDENCE_SCHEMA_UNSUPPORTED';
  const nowMs = Date.now();
  if (!isObject(evidence.wipReview)) return 'WIP_REVIEW_REQUIRED';
  if (!exactKeys(evidence.wipReview, WIP_REVIEW_KEYS) || Object.keys(evidence.wipReview).length !== WIP_REVIEW_KEYS.size) return 'WIP_REVIEW_INVALID';
  if (!WIP_DECISIONS.has(evidence.wipReview.decision)) return 'WIP_REVIEW_DECISION_INVALID';
  if (!canonicalWipTimestamp(evidence.wipReview.evidenceFetchedAt)) return 'WIP_REVIEW_TIMESTAMP_INVALID';
  const wipFetchedMs = Date.parse(evidence.wipReview.evidenceFetchedAt);
  if (wipFetchedMs > nowMs) return 'WIP_REVIEW_FROM_FUTURE';
  if (nowMs - wipFetchedMs > WIP_REVIEW_MAX_AGE_MS) return 'WIP_REVIEW_STALE';
  if (evidence.wipReview.decision !== 'CONTINUE') return 'WIP_REVIEW_BLOCKED';
  if (typeof evidence.evidenceComplete !== 'boolean') return 'EVIDENCE_COMPLETE_FLAG_INVALID';
  if (!ALLOWED_CHANGE_CLASSES.has(evidence.changeClass)) return 'CHANGE_CLASS_INVALID';
  if (!ALLOWED_DATA_MODES.has(evidence.dataMode)) return 'DATA_MODE_INVALID';
  if (!ALLOWED_EXECUTION_SCOPES.has(evidence.executionScope)) return 'EXECUTION_SCOPE_INVALID';
  if (!isObject(evidence.projectGuard)) return 'PROJECT_GUARD_REQUIRED';
  if (!OPERATION_TYPES.has(evidence.projectGuard.operationType)) return 'OPERATION_TYPE_INVALID';
  if (evidence.projectGuard.operationType === 'read-only-reference') return 'READ_ONLY_REFERENCE_NOT_CHANGE_AUTHORITY';
  const realDeviceOperation = evidence.projectGuard.operationType === 'real-device';
  const realDeviceScope = evidence.executionScope === 'real-device';
  if (realDeviceOperation !== realDeviceScope) return 'PROJECT_GUARD_OPERATION_SCOPE_CONFLICT';
  if (!isObject(evidence.impacts)) return 'IMPACTS_INVALID';
  if (!exactKeys(evidence.impacts, new Set(IMPACT_KEYS))) return 'IMPACTS_UNKNOWN_FIELD';
  if (Object.keys(evidence.impacts).length !== IMPACT_KEYS.length) return 'IMPACTS_INCOMPLETE';
  if (IMPACT_KEYS.some(key => typeof evidence.impacts[key] !== 'boolean')) return 'IMPACT_FLAG_INVALID';
  if (realDeviceOperation && evidence.impacts.realDevice !== true) return 'PROJECT_GUARD_REAL_DEVICE_IMPACT_REQUIRED';
  if (!Array.isArray(evidence.changedFiles) || evidence.changedFiles.length === 0) return 'CHANGED_FILES_INVALID';
  if (evidence.changedFiles.some(path => !validRepoPath(path))) return 'CHANGED_FILE_PATH_INVALID';
  if (new Set(evidence.changedFiles).size !== evidence.changedFiles.length) return 'CHANGED_FILES_DUPLICATE';
  const projectGuardError = validateProjectGuard(evidence.projectGuard);
  if (projectGuardError) return projectGuardError;
  return null;
}

function sensitivePathReasons(changedFiles) {
  const reasons = new Set();
  for (const path of changedFiles) {
    for (const [code, pattern] of SENSITIVE_PATH_RULES) {
      if (pattern.test(path)) reasons.add(code);
    }
  }
  return [...reasons];
}
export function classifyChange(evidence, options = {}) {
  const validationError = validateEvidence(evidence, options);
  if (validationError) return invalidReport(validationError);

  const reasons = [];
  if (!evidence.evidenceComplete) reasons.push('EVIDENCE_INCOMPLETE');
  if (!FAST_CHANGE_CLASSES.has(evidence.changeClass)) reasons.push('CHANGE_CLASS_REQUIRES_FULL_GATE');
  if (!FAST_DATA_MODES.has(evidence.dataMode)) reasons.push('DATA_MODE_REQUIRES_FULL_GATE');
  if (evidence.executionScope !== 'local-dev') reasons.push('EXECUTION_SCOPE_REQUIRES_FULL_GATE');

  const impactReasonCodes = {
    production: 'PRODUCTION_IMPACT', network: 'NETWORK_IMPACT', realDevice: 'REAL_DEVICE_IMPACT',
    installOrAdoption: 'INSTALL_OR_ADOPTION_IMPACT', dependency: 'DEPENDENCY_IMPACT',
    securitySensitive: 'SECURITY_SENSITIVE_IMPACT', authOrCredential: 'AUTH_OR_CREDENTIAL_IMPACT',
    mergeAuthority: 'MERGE_AUTHORITY_IMPACT', workflowOrDeployment: 'WORKFLOW_OR_DEPLOYMENT_IMPACT',
    databaseOrMigration: 'DATABASE_OR_MIGRATION_IMPACT', externalDataRoute: 'EXTERNAL_DATA_ROUTE_IMPACT',
    recurringCost: 'RECURRING_COST_IMPACT', lifecycle: 'LIFECYCLE_IMPACT',
    businessPolicy: 'BUSINESS_POLICY_IMPACT', architecture: 'ARCHITECTURE_IMPACT',
  };
  for (const key of IMPACT_KEYS) {
    if (evidence.impacts[key]) reasons.push(impactReasonCodes[key]);
  }
  reasons.push(...sensitivePathReasons(evidence.changedFiles));

  if (reasons.length > 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      evidenceValid: true,
      workStartAllowed: true,
      decision: 'FULL_GATE',
      reasons: [...new Set(reasons)],
      requiredChecks: FULL_REQUIRED_CHECKS,
      skippedChecks: [],
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    evidenceValid: true,
    workStartAllowed: true,
    decision: 'FAST_PATH',
    reasons: ['ALL_FAST_PATH_CONDITIONS_MET'],
    requiredChecks: FAST_REQUIRED_CHECKS,
    skippedChecks: FAST_SKIPPED_CHECKS,
  };
}
export function parseInput(raw) {
  const text = String(raw ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) return { error: 'INPUT_TOO_LARGE' };
  const jsonText = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return { error: 'INPUT_JSON_INVALID' }; }
  return { value: parsed };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) return { error: 'INPUT_TOO_LARGE' };
    chunks.push(chunk);
  }
  return parseInput(chunks.join(''));
}

function validateCliArgs(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 1 && argv[0] === '--pretty') return null;
  return 'CLI_ARGUMENT_INVALID';
}

async function main() {
  const cliError = validateCliArgs(process.argv.slice(2));
  if (cliError) {
    const report = invalidReport(cliError);
    console.log(JSON.stringify(report));
    console.error(`FAST_PATH_CLASSIFIER=${report.decision}`);
    process.exitCode = 2;
    return;
  }
  const input = await readStdin();
  const report = input.error ? invalidReport(input.error) : classifyChange(input.value);
  console.log(JSON.stringify(report, null, process.argv.includes('--pretty') ? 2 : 0));
  console.error(`FAST_PATH_CLASSIFIER=${report.decision}`);
  if (!report.evidenceValid) process.exitCode = 2;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await main();
