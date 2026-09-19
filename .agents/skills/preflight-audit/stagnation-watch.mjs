#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const i = args.lastIndexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function hasFlag(name) { return args.includes(name); }
function stop(message, code = 'STAGNATION_WATCH_INVALID_INPUT') {
  const output = { result: 'STOP', code, message };
  console.log(JSON.stringify(output));
  process.exit(2);
}
function git(cwd, gitArgs, { allowFailure = false } = {}) {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFailure) {
    stop(`git ${gitArgs.join(' ')} failed: ${r.stderr.trim()}`, 'STAGNATION_WATCH_GIT_FAILED');
  }
  return r;
}
function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}
function receipt(kind, payload) {
  const envelope = { schema: 'ai-turn-receipt-v1', kind, ...payload };
  return { ...envelope, id: sha(JSON.stringify(envelope)) };
}
function receiptMatches(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value); const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => {
      if (value[key] === expected[key]) return true;
      if (value[key] && expected[key] && typeof value[key] === 'object' && typeof expected[key] === 'object') {
        return JSON.stringify(value[key]) === JSON.stringify(expected[key]);
      }
      return false;
    });
}
function normalizePath(value) { return value.replaceAll('\\', '/'); }
function isGovernancePath(path) {
  const p = normalizePath(path);
  return p === 'AGENTS.md'
    || p === 'AGENTS.local.md'
    || p === 'CURRENT_STATUS.md'
    || p.startsWith('.agents/')
    || p.startsWith('.claude/')
    || p.startsWith('.github/');
}

const targetRoot = resolve(argValue('--target-root', process.cwd()));
const workId = argValue('--work-id').trim();
const gatePhase = argValue('--gate-phase', 'unknown').trim();
const blockerSignature = argValue('--blocker-signature', '').trim();
const failureSignature = argValue('--failure-signature', '').trim();
const observationSignature = argValue('--observation-signature', '').trim();
const routeSignature = argValue('--route-signature', '').trim();
const continuationTaskId = argValue('--continuation-task-id', '').trim();
const continuationProcessId = argValue('--continuation-process-id', '').trim();
const continuationStage = argValue('--continuation-stage', '').trim();
const continuationLogPointer = argValue('--continuation-log-pointer', '').trim();
const continuationNextAction = argValue('--continuation-next-action', '').trim();
const prState = argValue('--pr-state', 'unknown').trim().toLowerCase();
const workflowStatus = argValue('--workflow-status', 'unknown').trim().toLowerCase();
const workState = argValue('--work-state').trim().toLowerCase();
const humanGate = argValue('--human-gate').trim().toLowerCase();
const continuationAction = argValue('--continuation-action').trim().toLowerCase();
const completionTarget = argValue('--completion-target', 'none').trim().toLowerCase();
const responseIntent = argValue('--response-intent', 'continue').trim().toLowerCase();
const aiRouteState = argValue('--ai-route-state', 'available').trim().toLowerCase();
const humanGateKind = argValue('--human-gate-kind', humanGate === 'none' ? 'none' : 'unspecified').trim().toLowerCase();
const testGateState = argValue('--test-gate-state', 'not-run').trim().toLowerCase();
const commitState = argValue('--commit-state', 'not-done').trim().toLowerCase();
const pushState = argValue('--push-state', 'not-done').trim().toLowerCase();
const prDraft = argValue('--pr-draft', 'unknown').trim().toLowerCase();
const finalAuditState = argValue('--final-audit-state', 'not-run').trim().toLowerCase();
const exactPrHeadState = argValue('--exact-pr-head-state', 'not-verified').trim().toLowerCase();
const fingerprintScope = argValue('--fingerprint-scope', 'product').trim().toLowerCase();
const intervalMinutesRaw = argValue('--interval-minutes', '60').trim();
const nowRaw = argValue('--now', '').trim();
const inputStateJson = argValue('--state-json', '').trim();
const noWrite = hasFlag('--no-write');
const continuationContextSupplied = Boolean(continuationTaskId || continuationProcessId || continuationStage || continuationLogPointer || continuationNextAction);
if (continuationContextSupplied && (!continuationTaskId || !continuationStage || !continuationNextAction)) {
  stop('platform continuation context requires task id, stage, and next action');
}
for (const [value, max, code] of [[continuationTaskId,256,'continuation task id too long'],[continuationProcessId,128,'continuation process id too long'],[continuationStage,256,'continuation stage too long'],[continuationLogPointer,1024,'continuation log pointer too long'],[continuationNextAction,256,'continuation next action too long']]) {
  if (value.length > max) stop(code);
}
const continuationContext = continuationContextSupplied ? { taskId: continuationTaskId, processId: continuationProcessId || null, stage: continuationStage, logPointer: continuationLogPointer || null, nextAction: continuationNextAction } : null;

if (!workId) stop('--work-id is required');
if (!['complete', 'incomplete'].includes(workState)) stop('--work-state must be complete|incomplete');
if (!['none', 'required'].includes(humanGate)) stop('--human-gate must be none|required');
if (!['resume', 'report-only', 'wait-human'].includes(continuationAction)) {
  stop('--continuation-action must be resume|report-only|wait-human');
}
if (!['none', 'pre-merge'].includes(completionTarget)) stop('--completion-target must be none|pre-merge');
if (!['continue','terminate','platform-turn-boundary'].includes(responseIntent)) stop('--response-intent invalid');
if (!['available','exhausted'].includes(aiRouteState)) stop('--ai-route-state invalid');
if (!['none','unspecified','merge-authorization','cost','credentials-authentication','destructive-high-risk','production-real-data','business-spec-value','protected-data-policy','subjective-real-device','scope-safety-boundary','workflow-ownership'].includes(humanGateKind)) stop('--human-gate-kind invalid');
if (humanGate === 'none' && humanGateKind !== 'none') stop('--human-gate-kind must be none when --human-gate is none');
if (humanGate === 'required' && humanGateKind === 'none') stop('--human-gate-kind must identify the required human gate');
if (completionTarget === 'pre-merge' && humanGate === 'required' && humanGateKind === 'unspecified') stop('--human-gate-kind is required for pre-merge completion');
if (aiRouteState === 'exhausted' && humanGate === 'required') stop('--ai-route-state exhausted cannot coexist with a human gate');
if (workState === 'complete' && humanGate === 'required') stop('--work-state complete cannot coexist with a human gate');
if (!['not-run','pass','fail','unknown'].includes(testGateState)) stop('--test-gate-state invalid');
if (!['not-done','done'].includes(commitState)) stop('--commit-state invalid');
if (!['not-done','done'].includes(pushState)) stop('--push-state invalid');
if (!['unknown','yes','no'].includes(prDraft)) stop('--pr-draft invalid');
if (!['not-run','pass','fail','unknown'].includes(finalAuditState)) stop('--final-audit-state invalid');
if (!['not-verified','verified','unknown'].includes(exactPrHeadState)) stop('--exact-pr-head-state invalid');
if (!['product', 'all'].includes(fingerprintScope)) stop('--fingerprint-scope must be product|all');
if (!['none', 'open', 'ready', 'merged', 'closed', 'unknown'].includes(prState)) stop('--pr-state invalid');
if (!['idle', 'in-progress', 'passed', 'failed', 'cancelled', 'unknown'].includes(workflowStatus)) {
  stop('--workflow-status invalid');
}
const intervalMinutes = Number(intervalMinutesRaw);
if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) stop('--interval-minutes must be > 0');
const intervalMs = intervalMinutes * 60_000;
const now = nowRaw ? Date.parse(nowRaw) : Date.now();
if (!Number.isFinite(now)) stop('--now must be ISO-8601 parseable');

const rootCheck = git(targetRoot, ['rev-parse', '--show-toplevel']);
const gitRoot = resolve(rootCheck.stdout.trim());
if (gitRoot !== targetRoot) stop('--target-root must be repository root', 'STAGNATION_WATCH_TARGET_NOT_REPO_ROOT');

const branch = git(targetRoot, ['branch', '--show-current']).stdout.trim();
if (!branch) stop('detached HEAD is not supported', 'STAGNATION_WATCH_DETACHED_HEAD');
const headSha = git(targetRoot, ['rev-parse', 'HEAD']).stdout.trim();

const preMergeStages = { testGateState, commitState, pushState, prState, prDraft, finalAuditState, exactPrHeadState };
const preMergeTechnicalReady = completionTarget === 'pre-merge'
  && testGateState === 'pass' && commitState === 'done' && pushState === 'done'
  && prState === 'open' && prDraft === 'yes' && finalAuditState === 'pass' && exactPrHeadState === 'verified';
const prematureMergeAuthorization = completionTarget === 'pre-merge' && !preMergeTechnicalReady
  && humanGate === 'required' && humanGateKind === 'merge-authorization';
let terminalState = 'AI_CONTINUES';
if (workState === 'complete') terminalState = 'COMPLETE';
else if (humanGate === 'required' && humanGateKind !== 'merge-authorization') terminalState = 'HUMAN_CONFIRMATION_REQUIRED';
else if (preMergeTechnicalReady) terminalState = 'PRE_MERGE_READY';
else if (humanGate === 'required' && !prematureMergeAuthorization) terminalState = 'HUMAN_CONFIRMATION_REQUIRED';
else if (aiRouteState === 'exhausted') terminalState = 'BLOCKED';

const diff = git(targetRoot, ['diff', '--binary', 'HEAD', '--', '.']).stdout;
const untrackedRaw = git(targetRoot, ['ls-files', '--others', '--exclude-standard', '-z']).stdout;
const untracked = untrackedRaw.split('\0').filter(Boolean).map(normalizePath).sort();
const treeRaw = git(targetRoot, ['ls-tree', '-r', '-z', 'HEAD']).stdout;
const treeEntries = treeRaw.split('\0').filter(Boolean);

const material = [];
for (const entry of treeEntries) {
  const tab = entry.indexOf('\t');
  if (tab < 0) continue;
  const meta = entry.slice(0, tab);
  const path = normalizePath(entry.slice(tab + 1));
  if (fingerprintScope === 'product' && isGovernancePath(path)) continue;
  material.push(`tree:${meta}:${path}`);
}
for (const path of untracked) {
  if (fingerprintScope === 'product' && isGovernancePath(path)) continue;
  try {
    const bytes = await readFile(join(targetRoot, path));
    material.push(`untracked:${path}:${sha(bytes)}`);
  } catch {
    material.push(`untracked:${path}:unreadable`);
  }
}
let filteredDiff = diff;
if (fingerprintScope === 'product') {
  const names = git(targetRoot, ['diff', '--name-only', 'HEAD', '--', '.']).stdout
    .split(/\r?\n/).filter(Boolean).map(normalizePath)
    .filter((p) => !isGovernancePath(p));
  const chunks = [];
  for (const path of names.sort()) {
    chunks.push(git(targetRoot, ['diff', '--binary', 'HEAD', '--', path]).stdout);
  }
  filteredDiff = chunks.join('\n');
}
material.push(`diff:${sha(filteredDiff)}`);
const productTreeHash = sha(material.sort().join('\n'));

const fingerprintObject = {
  branch,
  productTreeHash,
  gatePhase,
  blockerSignature,
  failureSignature,
  observationSignature,
  routeSignature,
  prState,
  workflowStatus: workflowStatus === 'in-progress' ? 'in-progress' : workflowStatus,
  completionTarget,
  preMergeStages,
};
const fingerprint = sha(JSON.stringify(fingerprintObject));

const safeWorkId = workId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'work';
const defaultStatePath = git(targetRoot, ['rev-parse', '--git-path', `ai-dev-foundation/stagnation/${safeWorkId}.json`]).stdout.trim();
const defaultStateFile = resolve(targetRoot, defaultStatePath);
const stateFile = resolve(argValue('--state-file', defaultStateFile));

let previous = null;
if (inputStateJson) {
  try { previous = JSON.parse(inputStateJson); } catch { stop('--state-json invalid JSON'); }
} else {
  try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch { previous = null; }
}

const isoNow = new Date(now).toISOString();
const baseState = {
  schema: 'ai-stagnation-state-v1',
  workId,
  fingerprint,
  fingerprintObject,
  lastMeaningfulProgressAt: isoNow,
  lastCheckpointAt: isoNow,
  unchangedCheckpoints: 0,
  level: 'CLEAR',
  requiredAction: 'continue',
  updatedAt: isoNow,
};

const previousPlatformCheckpoint = previous?.level === 'PLATFORM_TURN_BOUNDARY' ? previous.continuationCheckpoint : null;
const expectedPlatformCheckpointReceipt = previousPlatformCheckpoint ? receipt('platform-turn-boundary', {
  workId: previous?.workId, branch: previousPlatformCheckpoint.branch, headSha: previousPlatformCheckpoint.headSha,
  fingerprint: previous?.fingerprint, createdAt: previousPlatformCheckpoint.createdAt,
  continuation: previousPlatformCheckpoint.continuation ?? null,
}) : null;
const platformCheckpointIntegrityValid = Boolean(previousPlatformCheckpoint)
  && previous?.schema === 'ai-stagnation-state-v1' && previous?.workId === workId
  && receiptMatches(previousPlatformCheckpoint.receipt, expectedPlatformCheckpointReceipt);
const platformCheckpointRepoMatches = platformCheckpointIntegrityValid
  && previousPlatformCheckpoint.branch === branch && previousPlatformCheckpoint.headSha === headSha;

let result = 'PROCEED';
let code = 'STAGNATION_BASELINE_CREATED';
let nextState = baseState;
let detail = {};
let handoffClass = humanGate === 'required' ? 'HUMAN_REQUIRED' : 'AI_OWNED';

if (workState === 'complete') {
  result = 'COMPLETE';
  code = 'WORK_COMPLETE';
  nextState = { ...baseState, level: 'COMPLETE', requiredAction: 'none' };
  handoffClass = 'COMPLETE';
} else if (completionTarget === 'pre-merge' && preMergeTechnicalReady && humanGate === 'required' && humanGateKind === 'merge-authorization') {
  handoffClass = 'MERGE_AUTH_REQUIRED';
  if (continuationAction !== 'wait-human') {
    result = 'STOP'; code = 'PRE_MERGE_READY_WAIT_REQUIRED'; nextState = previous ?? baseState;
  } else {
    result = 'WAIT_HUMAN'; code = 'PRE_MERGE_READY_WAITING_MERGE_AUTH';
    nextState = { ...(previous ?? baseState), workId, lastCheckpointAt: isoNow, updatedAt: isoNow, level:'WAIT_HUMAN', requiredAction:'request-merge-authorization' };
  }
} else if (completionTarget === 'pre-merge' && preMergeTechnicalReady && humanGate === 'none') {
  result = 'STOP'; code = 'PRE_MERGE_MERGE_AUTHORIZATION_REQUIRED'; handoffClass = 'MERGE_AUTH_REQUIRED'; nextState = previous ?? baseState;
} else if (completionTarget === 'pre-merge' && !preMergeTechnicalReady && humanGate === 'required' && humanGateKind === 'merge-authorization') {
  result = 'STOP'; code = 'PRE_MERGE_MERGE_GATE_PREMATURE'; handoffClass = 'AI_OWNED'; nextState = previous ?? baseState;
} else if (aiRouteState === 'exhausted') {
  result = 'BLOCKED'; code = 'SAFE_AI_ROUTE_EXHAUSTED'; handoffClass = 'AI_OWNED';
  nextState = { ...(previous ?? baseState), workId, lastCheckpointAt: isoNow, updatedAt: isoNow, level:'BLOCKED', requiredAction:'report-blocked' };
} else if (humanGate === 'required') {
  if (continuationAction !== 'wait-human') {
    result = 'STOP';
    code = 'HUMAN_GATE_REQUIRED';
    nextState = previous ?? baseState;
  } else {
    result = 'WAIT_HUMAN';
    code = 'WAITING_AT_VALID_HUMAN_GATE';
    nextState = {
      ...(previous ?? baseState),
      workId,
      lastCheckpointAt: isoNow,
      updatedAt: isoNow,
      level: 'WAIT_HUMAN',
      requiredAction: 'wait-human',
    };
  }
} else if (continuationAction === 'wait-human') {
  result = 'STOP';
  code = 'UNNECESSARY_HUMAN_WAIT';
  nextState = previous ?? baseState;
} else if (continuationAction === 'report-only') {
  result = 'STOP';
  code = completionTarget === 'pre-merge' ? 'PRE_MERGE_CONTINUATION_REQUIRED' : 'SAFE_WORK_CONTINUATION_REQUIRED';
  nextState = previous ?? baseState;
} else if (previous?.level === 'PLATFORM_TURN_BOUNDARY' && responseIntent === 'continue' && !platformCheckpointIntegrityValid) {
  result = 'STOP';
  code = 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_INVALID';
  handoffClass = 'AI_OWNED';
  nextState = { ...(previous ?? baseState), workId, updatedAt: isoNow, requiredAction: 're-evaluate-work-state' };
  detail = { checkpointIntegrityValid: false };
} else if (previous?.level === 'PLATFORM_TURN_BOUNDARY' && responseIntent === 'continue' && !platformCheckpointRepoMatches) {
  result = 'STOP';
  code = 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_STALE_HEAD';
  handoffClass = 'AI_OWNED';
  nextState = { ...previous, workId, updatedAt: isoNow, requiredAction: 're-evaluate-work-state' };
  detail = { checkpointBranch: previousPlatformCheckpoint.branch, checkpointHeadSha: previousPlatformCheckpoint.headSha, currentBranch: branch, currentHeadSha: headSha };
} else if (previous?.level === 'PLATFORM_TURN_BOUNDARY' && responseIntent === 'continue' && previous.fingerprint !== fingerprint) {
  result = 'PROCEED';
  code = 'PLATFORM_TURN_BOUNDARY_STATE_CHANGED_REEVALUATE';
  nextState = baseState;
  detail = { resumedFromCheckpoint: false, previousFingerprint: previous.fingerprint };
} else if (previous?.level === 'PLATFORM_TURN_BOUNDARY' && responseIntent === 'continue') {
  result = 'PROCEED';
  code = 'PLATFORM_TURN_BOUNDARY_RESUMED';
  nextState = {
    ...previous, fingerprint, fingerprintObject, updatedAt: isoNow,
    level: previousPlatformCheckpoint.level ?? 'CLEAR',
    requiredAction: previousPlatformCheckpoint.requiredAction ?? 'continue',
    continuationCheckpoint: null,
  };
  detail = { resumedFromCheckpoint: true, resumeCheckpointReceipt: previousPlatformCheckpoint.receipt, resumeContinuation: previousPlatformCheckpoint.continuation ?? null };
} else if (workflowStatus === 'in-progress') {
  result = 'PROCEED';
  code = 'ACTIVE_EXECUTION_IN_PROGRESS';
  nextState = {
    ...(previous ?? baseState),
    workId,
    fingerprint,
    fingerprintObject,
    updatedAt: isoNow,
    level: previous?.level ?? 'CLEAR',
    requiredAction: 'continue-active-execution',
  };
} else if (!previous || previous.schema !== 'ai-stagnation-state-v1' || previous.workId !== workId) {
  result = 'PROCEED';
  code = 'STAGNATION_BASELINE_CREATED';
  nextState = baseState;
} else if (previous.fingerprint !== fingerprint) {
  result = 'PROCEED';
  code = 'MEANINGFUL_PROGRESS_DETECTED';
  nextState = baseState;
  detail = { previousFingerprint: previous.fingerprint };
} else {
  const lastCheckpointMs = Date.parse(previous.lastCheckpointAt || previous.updatedAt || previous.lastMeaningfulProgressAt);
  const elapsedMs = Number.isFinite(lastCheckpointMs) ? Math.max(0, now - lastCheckpointMs) : intervalMs;
  const dueCheckpoints = Math.floor(elapsedMs / intervalMs);
  if (dueCheckpoints < 1) {
    result = 'PROCEED';
    code = 'STAGNATION_CHECKPOINT_NOT_DUE';
    nextState = { ...previous, updatedAt: isoNow };
    detail = { minutesUntilNextCheckpoint: Math.ceil((intervalMs - elapsedMs) / 60_000) };
  } else {
    const unchangedCheckpoints = Math.min(999, Number(previous.unchangedCheckpoints || 0) + dueCheckpoints);
    let level = 'L1';
    let requiredAction = 'root-cause-analysis';
    code = 'STAGNATION_L1_ROOT_CAUSE_REQUIRED';
    if (unchangedCheckpoints >= 3) {
      level = 'HARD_STOP';
      requiredAction = 'route-reselection';
      code = 'STAGNATION_HARD_STOP_ROUTE_CHANGE_REQUIRED';
    } else if (unchangedCheckpoints >= 2) {
      level = 'L2';
      requiredAction = 'forced-reflection';
      code = 'STAGNATION_L2_FORCED_REFLECTION_REQUIRED';
    }
    result = 'STOP';
    nextState = {
      ...previous,
      fingerprint,
      fingerprintObject,
      lastCheckpointAt: isoNow,
      unchangedCheckpoints,
      level,
      requiredAction,
      updatedAt: isoNow,
    };
    detail = { dueCheckpoints, elapsedMinutes: Math.floor(elapsedMs / 60_000) };
  }
}


let responseMayTerminate = terminalState !== 'AI_CONTINUES';
let resumeRequired = false;
let turnCloseReceipt = null;
let resumeCheckpointReceipt = null;
if (responseIntent === 'terminate' && !responseMayTerminate) {
  detail = { ...detail, terminalResponseUnderlyingCode: code };
  result = 'STOP';
  code = 'TERMINAL_RESPONSE_REJECTED_AI_CONTINUES';
  handoffClass = 'AI_OWNED';
  nextState = { ...nextState, workId, lastCheckpointAt: isoNow, updatedAt: isoNow, requiredAction:'continue-ai-work' };
} else if (responseIntent === 'platform-turn-boundary' && !responseMayTerminate) {
  const checkpointRequiredAction = nextState?.requiredAction ?? 'continue';
  const checkpointLevel = nextState?.level ?? 'CLEAR';
  resumeCheckpointReceipt = receipt('platform-turn-boundary', { workId, branch, headSha, fingerprint, createdAt: isoNow, continuation: continuationContext });
  detail = { ...detail, terminalResponseUnderlyingCode: code };
  result = 'STOP';
  code = 'PLATFORM_TURN_BOUNDARY_CHECKPOINT_SAVED';
  handoffClass = 'AI_OWNED';
  resumeRequired = true;
  nextState = {
    ...nextState,
    workId, fingerprint, fingerprintObject, lastCheckpointAt: isoNow, updatedAt: isoNow,
    level:'PLATFORM_TURN_BOUNDARY', requiredAction:'resume-from-checkpoint',
    continuationCheckpoint: {
      branch, headSha, gatePhase, workflowStatus, blockerSignature, failureSignature,
      observationSignature, routeSignature, completionTarget, preMergeStages,
      continuation: continuationContext,
      level: checkpointLevel, requiredAction: checkpointRequiredAction, createdAt: isoNow, receipt: resumeCheckpointReceipt,
    },
  };
}

if (responseIntent === 'terminate' && responseMayTerminate) {
  turnCloseReceipt = receipt('terminal-response', { workId, branch, headSha, fingerprint, terminalState, issuedAt: isoNow });
}

if (!noWrite && !inputStateJson) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
}

const output = {
  result,
  code,
  workId,
  branch,
  headSha,
  productTreeHash,
  fingerprintScope,
  gatePhase,
  blockerSignature: blockerSignature || null,
  failureSignature: failureSignature || null,
  observationSignature: observationSignature || null,
  routeSignature: routeSignature || null,
  prState,
  workflowStatus,
  workState,
  humanGate,
  humanGateKind,
  handoffClass,
  continuationAction,
  completionTarget,
  responseIntent,
  aiRouteState,
  terminalState,
  responseMayTerminate,
  turnCloseReceipt,
  resumeCheckpointReceipt,
  resumeRequired,
  preMergeTechnicalReady,
  preMergeStages,
  intervalMinutes,
  stateFile: inputStateJson ? null : stateFile,
  nextState,
  ...detail,
};
console.log(JSON.stringify(output));
process.exit(['STOP','BLOCKED'].includes(result) ? 2 : 0);
