#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateOrchestrationTask } from '../preflight-audit/implementation-orchestrator.mjs';
import { normalizeHumanDecisionSync, validateHumanDecisionSync } from '../handoff/human-decision-sync.mjs';
import { validateResearchEnvelopeShape } from '../preflight-audit/research-gate.mjs';
import { validateInstructionClarityInput } from '../preflight-audit/instruction-clarity-gate.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/;
const STATUSES = new Set(['DRAFT', 'PENDING_HUMAN', 'APPROVED', 'REJECTED']);
export const RISK_SIGNAL_KEYS = Object.freeze([
  'protectedOrPatientData',
  'externalCommunication',
  'addedCostOrPaidUsage',
  'authOrIdentity',
  'productionImpact',
  'realDataImpact',
]);
export const MAX_HUMAN_QUESTIONS = 3;
export const MAX_SOLUTION_OPTIONS = 3;
export const SOLUTION_DECISIONS = Object.freeze(['REUSE_EXISTING', 'SIMPLIFY_EXISTING', 'MINIMAL_CHANGE', 'EXTEND_REQUIRED']);
export const SOLUTION_CRITERIA = Object.freeze(['safety', 'accuracy', 'simplicity', 'humanOperations', 'maintenance', 'reversibility', 'existingOverlap']);
const PLACEHOLDERS = new Set(['TODO', 'TBD', 'UNKNOWN', 'UNAVAILABLE', 'UNRESOLVED', 'NA', 'NOTAPPLICABLE', '要補足', '未確認', '不明']);
const GATE_REFERENCES = Object.freeze({
  preflightAudit: '.agents/skills/preflight-audit/SKILL.md',
  implementationRouting: '.agents/skills/preflight-audit/implementation-orchestrator.mjs',
  stagedReality: '.agents/skills/test-gate/staged-reality-gate.mjs',
  finalPrAudit: '.agents/skills/final-pr-audit/SKILL.md',
  humanDecisionSync: '.agents/skills/handoff/human-decision-sync.mjs',
});

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(obj, allowed) { return isObject(obj) && Object.keys(obj).length === allowed.length && allowed.every((key) => Object.hasOwn(obj, key)); }
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function cleanText(value, max) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !hasControlChar(value) ? value : null;
}
function cleanId(value) { const text = cleanText(value, 160); return text && ID_RE.test(text) ? text : null; }
function resolvedText(value, max) {
  const text = cleanText(value, max);
  if (!text || /^<[^>]+>$/u.test(text)) return null;
  const key = text.replace(/[\s._:/-]+/gu, '').toUpperCase();
  return PLACEHOLDERS.has(key) ? null : text;
}
function textList(value, { maxItems, maxLength }) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out = [];
  for (const raw of value) {
    const text = resolvedText(raw, maxLength);
    if (!text) return null;
    out.push(text);
  }
  return out;
}
function stop(code, message, detail = {}) { return { result: 'STOP', intakeGate: 'FAIL', code, message, ...detail }; }
function pass(detail = {}) { return { result: 'PROCEED', intakeGate: 'PASS', code: 'PROJECT_INTAKE_ALIGNED', ...detail }; }

export function decisionTopicForIntake(intakeId) {
  const id = cleanId(intakeId);
  return id ? 'project-intake:' + id : null;
}
function normalizeRiskSignals(value) {
  if (!exactKeys(value, RISK_SIGNAL_KEYS)) return null;
  const out = {};
  for (const key of RISK_SIGNAL_KEYS) {
    if (typeof value[key] !== 'boolean') return null;
    out[key] = value[key];
  }
  return out;
}
function normalizeSolutionReview(value) {
  if (!exactKeys(value, ['options', 'selectedOptionId', 'extendRationale'])) return null;
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > MAX_SOLUTION_OPTIONS) return null;
  const options = [];
  const ids = new Set();
  for (const raw of value.options) {
    if (!exactKeys(raw, ['id', 'decision', 'summary', 'assessment'])) return null;
    const id = cleanId(raw.id);
    const summary = resolvedText(raw.summary, 500);
    if (!id || ids.has(id) || !summary || !SOLUTION_DECISIONS.includes(raw.decision) || !exactKeys(raw.assessment, SOLUTION_CRITERIA)) return null;
    const assessment = {};
    for (const key of SOLUTION_CRITERIA) {
      const text = resolvedText(raw.assessment[key], 300);
      if (!text) return null;
      assessment[key] = text;
    }
    ids.add(id);
    options.push({ id, decision: raw.decision, summary, assessment });
  }
  const selectedOptionId = cleanId(value.selectedOptionId);
  const selected = options.find((item) => item.id === selectedOptionId);
  if (!selected) return null;
  let extendRationale = null;
  if (selected.decision === 'EXTEND_REQUIRED') {
    // Fail closed: EXTEND_REQUIRED needs at least one non-extend alternative that was considered.
    if (!options.some((item) => item.decision !== 'EXTEND_REQUIRED')) return null;
    extendRationale = resolvedText(value.extendRationale, 1000);
    if (!extendRationale) return null;
  } else if (value.extendRationale !== null) return null;
  return { options, selectedOptionId, extendRationale };
}
export function computeIntakeProfile(riskSignals) {
  return RISK_SIGNAL_KEYS.some((key) => riskSignals[key] === true) ? 'FULL' : 'LIGHT';
}

export function normalizeIntakeBrief(input) {
  const allowed = ['schemaVersion', 'intakeId', 'intent', 'scope', 'assumptions', 'humanQuestions', 'solutionReview', 'riskSignals', 'status', 'decisionId'];
  if (!exactKeys(input, allowed) || input.schemaVersion !== 1) return { error: stop('PROJECT_INTAKE_BRIEF_INVALID', 'Project brief must use the closed schemaVersion=1 shape.') };
  const intakeId = cleanId(input.intakeId);
  const intent = resolvedText(input.intent, 2000);
  const scope = resolvedText(input.scope, 4000);
  const assumptions = textList(input.assumptions, { maxItems: 20, maxLength: 500 });
  const humanQuestions = textList(input.humanQuestions, { maxItems: 20, maxLength: 500 });
  const riskSignals = normalizeRiskSignals(input.riskSignals);
  const solutionReview = normalizeSolutionReview(input.solutionReview);
  const status = typeof input.status === 'string' && STATUSES.has(input.status) ? input.status : null;
  const decisionId = input.decisionId === null ? null : cleanId(input.decisionId);
  if (!intakeId || !intent || !scope || !assumptions || !humanQuestions || !riskSignals || !solutionReview || !status || (input.decisionId !== null && !decisionId)) {
    return { error: stop('PROJECT_INTAKE_BRIEF_INVALID', 'Project brief fields are incomplete, malformed, or unresolved.') };
  }
  if (input.humanQuestions.length > MAX_HUMAN_QUESTIONS) return { error: stop('PROJECT_INTAKE_QUESTIONS_EXCEEDED', 'Human questions must not exceed 3.') };
  if (status === 'APPROVED' && !decisionId) return { error: stop('PROJECT_INTAKE_APPROVAL_REQUIRES_DECISION', 'APPROVED intake requires a decisionId.') };
  if (status !== 'APPROVED' && decisionId) return { error: stop('PROJECT_INTAKE_DECISION_PREMATURE', 'decisionId is allowed only for APPROVED intake.') };
  return { value: { schemaVersion: 1, intakeId, intent, scope, assumptions, humanQuestions, solutionReview, riskSignals, status, decisionId } };
}

export function evaluateProjectIntake(briefInput, manifest = null) {
  const normalized = normalizeIntakeBrief(briefInput);
  if (normalized.error) return normalized.error;
  const brief = normalized.value;
  const profile = computeIntakeProfile(brief.riskSignals);
  const common = { intakeId: brief.intakeId, profile, status: brief.status, intent: brief.intent, scope: brief.scope, assumptions: brief.assumptions, humanQuestions: brief.humanQuestions, solutionReview: brief.solutionReview, riskSignals: brief.riskSignals };
  if (brief.status !== 'APPROVED') return pass({ ...common, decisionId: null, humanDecisionFingerprint: null });
  if (brief.humanQuestions.length !== 0) return stop('PROJECT_INTAKE_APPROVAL_BLOCKED_BY_QUESTIONS', 'APPROVED intake requires zero unresolved human questions.');
  if (!manifest) return stop('PROJECT_INTAKE_CONTEXT_REQUIRED', 'APPROVED intake requires PROJECT_CONTEXT.json Human Decision Sync evidence.');
  const normalizedDecisions = normalizeHumanDecisionSync(manifest);
  if (normalizedDecisions.error || !normalizedDecisions.value) return stop('PROJECT_INTAKE_DECISION_REGISTRY_INVALID', 'Human Decision Sync registry is missing or invalid.');
  const decision = normalizedDecisions.value.decisions.find((item) => item.id === brief.decisionId);
  if (!decision) return stop('PROJECT_INTAKE_DECISION_NOT_FOUND', 'decisionId is not present in Human Decision Sync.');
  const expectedTopic = decisionTopicForIntake(brief.intakeId);
  if (decision.topic !== expectedTopic) return stop('PROJECT_INTAKE_DECISION_TOPIC_MISMATCH', 'Decision topic does not match this intake.', { expectedTopic, actualTopic: decision.topic });
  if (decision.status !== 'CONFIRMED' || decision.source !== 'EXPLICIT_HUMAN') return stop('PROJECT_INTAKE_DECISION_NOT_CONFIRMED', 'APPROVED intake requires a CONFIRMED EXPLICIT_HUMAN decision.');
  const sync = validateHumanDecisionSync(manifest, { schemaVersion: 1, selectedDecisionIds: [brief.decisionId] });
  if (sync.result === 'STOP') return stop('PROJECT_INTAKE_DECISION_SYNC_REJECTED', 'Human Decision Sync rejected the approval decision.', { decisionId: brief.decisionId });
  return pass({ ...common, decisionId: brief.decisionId, humanDecisionFingerprint: sync.humanDecisionFingerprint ?? null });
}

export function renderIntakeBriefMarkdown(briefInput) {
  const normalized = normalizeIntakeBrief(briefInput);
  if (normalized.error) return normalized.error;
  const brief = normalized.value;
  const profile = computeIntakeProfile(brief.riskSignals);
  const lines = ['# Project Intake Brief', '', '## Identity', '- Intake ID: ' + brief.intakeId, '- Status: ' + brief.status, '- Profile: ' + profile, '', '## Intent', brief.intent, '', '## Scope', brief.scope, '', '## Assumptions'];
  lines.push(...(brief.assumptions.length ? brief.assumptions.map((item) => '- ' + item) : ['- None']));
  lines.push('', '## Human Questions');
  lines.push(...(brief.humanQuestions.length ? brief.humanQuestions.map((item) => '- ' + item) : ['- None']));
  const review = brief.solutionReview;
  lines.push('', '## Solution Review', '- Recommended: ' + review.selectedOptionId);
  for (const option of review.options) {
    lines.push('- ' + option.id + ' [' + option.decision + ']: ' + option.summary);
    for (const key of SOLUTION_CRITERIA) lines.push('  - ' + key + ': ' + option.assessment[key]);
  }
  if (review.extendRationale) lines.push('- Extend rationale: ' + review.extendRationale);
  lines.push('', '## Risk Signals');
  for (const key of RISK_SIGNAL_KEYS) lines.push('- ' + key + ': ' + String(brief.riskSignals[key]));
  lines.push('', '## Approval', '- Decision ID: ' + (brief.decisionId ?? 'None'), '');
  return { result: 'PROCEED', markdown: lines.join('\n') };
}

export function buildImplementationTaskPacket(briefInput, manifest = null) {
  const evaluated = evaluateProjectIntake(briefInput, manifest);
  if (evaluated.result === 'STOP') return evaluated;
  if (evaluated.status !== 'APPROVED') return stop('PROJECT_INTAKE_PACKET_REQUIRES_APPROVAL', 'Task packet requires APPROVED intake.');
  return {
    result: 'PROCEED',
    code: 'PROJECT_INTAKE_TASK_PACKET',
    schemaVersion: 1,
    intakeId: evaluated.intakeId,
    objective: evaluated.intent,
    profile: evaluated.profile,
    scope: evaluated.scope,
    assumptions: evaluated.assumptions,
    solutionReview: evaluated.solutionReview,
    safetyFacts: { ...evaluated.riskSignals },
    approval: { decisionId: evaluated.decisionId, humanDecisionFingerprint: evaluated.humanDecisionFingerprint },
    downstreamGates: { ...GATE_REFERENCES },
    note: 'This packet points to existing Foundation gates and does not replace them.',
  };
}

// AI Job Issue section names, exactly as scripts/ai-job-poller/poll-once.ps1 requires them.
export const AI_JOB_SECTIONS = Object.freeze({
  objective: '目的',
  allowedPaths: '変更してよいパス',
  doneConditions: '完了条件',
  testCommand: 'テストコマンド',
  prohibitions: '禁止事項',
});
const POLLER_HEADING_RE = /^\s*#{2,3}(?:\s|#|$)/u;
const DEFAULT_DONE_CONDITION = 'Source edits are limited to allowedScope.';
const DEFAULT_PROHIBITION = '変更許可パス外を変更しない';
const POLLER_ROOT_ONLY_BLOCKED = new Set(['**', '.git/**', '.ai-jobs/**']);

// The poller-format Issue body only carries objective/scope/done-conditions/
// test-command/prohibitions: it has no field for the already-validated
// research/instructionClarity evidence an orchestrator task payload already
// carries. This is the SINGLE place that evidence is embedded as a second
// machine-readable comment (the same mechanism agent-job-bridge.mjs already
// uses for continuation metadata), so that EVERY caller of
// renderPollerIssueFromTask/renderAiJobIssue -- not only the agent-cycle ->
// agent-job-bridge path -- carries the raw evidence forward. It embeds the
// EXACT evidence already present on the validated task (never a fabricated/
// placeholder trigger:false or ADOPT result).
const RESEARCH_META_TAG = 'AGENT_CYCLE_JOB_RESEARCH_V1';
export function encodeResearchEnvelope(taskPayload) {
  const payload = { research: taskPayload.research, instructionClarity: taskPayload.instructionClarity };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `<!-- ${RESEARCH_META_TAG} ${encoded} -->`;
}

// A single Markdown-safe line: no control chars, not blank, not a poller heading, no HTML comment.
function jobLine(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || hasControlChar(text) || POLLER_HEADING_RE.test(text) || text.includes('<!--') || text.includes('-->')) return null;
  return text;
}
function jobPath(value) {
  const text = jobLine(value);
  if (!text || text.includes('`') || text.includes('\\')) return null;
  if (/^([-*+]|\d+\.)\s/u.test(text) || text.startsWith('./') || text.includes(':') || text.startsWith('/') || text.endsWith('/')) return null;
  if (text.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  const stars = (text.match(/\*/gu) || []).length;
  const validGlob = stars === 2 && text.endsWith('/**') && !text.slice(0, -3).includes('*');
  if (/[?[]/u.test(text) || (stars > 0 && !validGlob)) return null;
  if (POLLER_ROOT_ONLY_BLOCKED.has(text)) return null;
  return text;
}
function jobLines(list, mapper) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const item of list) {
    const line = mapper(item);
    if (!line) return null;
    out.push(line);
  }
  return out;
}
function bullets(items) { return items.map((item) => '- ' + item); }

// Render the existing poller-compatible AI Job Issue body from an already
// bounded orchestrator task payload. This is deliberately lower-level than
// Project Intake approval so existing approved control loops can reuse the
// exact same safe poller format without duplicating the renderer.
export function renderPollerIssueFromTask(taskPayload) {
  const errors = validateOrchestrationTask(taskPayload);
  if (errors.length > 0) return stop('PROJECT_INTAKE_JOB_TASK_INVALID', 'Orchestrator task payload is invalid.', { errors });
  // validateOrchestrationTask only checks research's shape and that
  // instructionClarity.taskId matches; the full instructionClarity shape
  // (and research's full shape, re-asserted here for a direct caller that
  // skipped the orchestrator) must also hold before this evidence is
  // embedded for a downstream launcher to trust.
  const researchShapeErrors = validateResearchEnvelopeShape(taskPayload.research);
  if (researchShapeErrors.length > 0) {
    return stop('PROJECT_INTAKE_JOB_RESEARCH_EVIDENCE_INVALID', 'research evidence failed full shape validation.', { errors: researchShapeErrors });
  }
  const clarityShapeErrors = validateInstructionClarityInput(taskPayload.instructionClarity);
  if (clarityShapeErrors.length > 0) {
    return stop('PROJECT_INTAKE_JOB_INSTRUCTION_CLARITY_INVALID', 'instructionClarity failed full shape validation.', { errors: clarityShapeErrors });
  }
  const objective = jobLine(taskPayload.objective);
  if (!objective) return stop('PROJECT_INTAKE_JOB_TEXT_UNSAFE', 'Objective cannot be rendered as a single safe line.');
  const rawPromptLines = String(taskPayload.prompt).split(/\r?\n/u);
  if (rawPromptLines.some((line) => hasControlChar(line))) {
    return stop('PROJECT_INTAKE_JOB_PROMPT_UNSAFE', 'Prompt must not contain control characters.');
  }
  // Deterministic escaping so prompt text can never create poller sections or comments.
  const promptLines = rawPromptLines.map((line) => {
    const escaped = line.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
    return POLLER_HEADING_RE.test(escaped) ? '> ' + escaped : escaped;
  });
  const allowed = jobLines(taskPayload.allowedScope, jobPath);
  if (!allowed) return stop('PROJECT_INTAKE_JOB_ALLOWED_SCOPE_INVALID', 'allowedScope cannot be rendered in poller path notation.');
  const noDone = taskPayload.doneConditions === undefined || (Array.isArray(taskPayload.doneConditions) && taskPayload.doneConditions.length === 0);
  const done = noDone ? [DEFAULT_DONE_CONDITION] : jobLines(taskPayload.doneConditions, jobLine);
  if (!done) return stop('PROJECT_INTAKE_JOB_DONE_CONDITIONS_REQUIRED', 'doneConditions must be non-empty renderable lines when provided.');
  const tests = taskPayload.requiredTests;
  if (!Array.isArray(tests) || tests.length !== 1) return stop('PROJECT_INTAKE_JOB_TEST_COMMAND_INVALID', 'requiredTests must contain exactly one command.');
  const testCommand = jobLine(tests[0]);
  if (!testCommand || /^なし(?:\s|$|（|\()/u.test(testCommand)) return stop('PROJECT_INTAKE_JOB_TEST_COMMAND_INVALID', 'requiredTests must be one executable single-line command.');
  const noForbidden = taskPayload.forbiddenScope === undefined || (Array.isArray(taskPayload.forbiddenScope) && taskPayload.forbiddenScope.length === 0);
  const forbidden = noForbidden ? [DEFAULT_PROHIBITION] : jobLines(taskPayload.forbiddenScope, jobPath);
  if (!forbidden) return stop('PROJECT_INTAKE_JOB_FORBIDDEN_SCOPE_REQUIRED', 'forbiddenScope entries must be renderable as paths.');
  const promptText = promptLines.join('\n').trim();
  const lines = [
    encodeResearchEnvelope(taskPayload), '',
    '## ' + AI_JOB_SECTIONS.objective, objective, ...(promptText ? ['', promptText] : []), '',
    '## ' + AI_JOB_SECTIONS.allowedPaths, ...bullets(allowed), '',
    '## ' + AI_JOB_SECTIONS.doneConditions, ...bullets(done), '',
    '## ' + AI_JOB_SECTIONS.testCommand, testCommand, '',
    '## ' + AI_JOB_SECTIONS.prohibitions, ...bullets(forbidden), '',
  ];
  return { result: 'PROCEED', code: 'POLLER_AI_JOB_ISSUE_RENDERED', markdown: lines.join('\n') };
}

// Render the existing poller-compatible AI Job Issue body from an APPROVED intake
// and an orchestrator task payload. Does not add any new task/job schema.
export function renderAiJobIssue(briefInput, manifest, taskPayload) {
  const packet = buildImplementationTaskPacket(briefInput, manifest);
  if (packet.result === 'STOP') return packet;
  const rendered = renderPollerIssueFromTask(taskPayload);
  if (rendered.result === 'STOP') return rendered;
  if (taskPayload.objective !== packet.objective) return stop('PROJECT_INTAKE_JOB_OBJECTIVE_MISMATCH', 'Orchestrator task objective must equal the intake objective.');
  return {
    ...rendered,
    code: 'PROJECT_INTAKE_AI_JOB_ISSUE',
    intakeId: packet.intakeId,
  };
}

function parseArgs(argv) {
  const out = { briefFile: null, contextFile: null, taskFile: null, render: false, renderJob: false, packet: false, pretty: false, valid: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--brief-file' && argv[i + 1]) out.briefFile = argv[++i];
    else if (arg === '--context-file' && argv[i + 1]) out.contextFile = argv[++i];
    else if (arg === '--task-file' && argv[i + 1]) out.taskFile = argv[++i];
    else if (arg === '--render') out.render = true;
    else if (arg === '--render-ai-job') out.renderJob = true;
    else if (arg === '--packet') out.packet = true;
    else if (arg === '--pretty') out.pretty = true;
    else out.valid = false;
  }
  if (!out.briefFile || [out.render, out.packet, out.renderJob].filter(Boolean).length > 1) out.valid = false;
  if (out.renderJob !== Boolean(out.taskFile)) out.valid = false;
  return out;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) { process.stdout.write(JSON.stringify(stop('PROJECT_INTAKE_ARGUMENT_INVALID', 'Arguments are invalid.')) + '\n'); process.exitCode = 2; return; }
  try {
    const brief = JSON.parse(readFileSync(resolve(args.briefFile), 'utf8'));
    const manifest = args.contextFile ? JSON.parse(readFileSync(resolve(args.contextFile), 'utf8')) : null;
    const task = args.renderJob ? JSON.parse(readFileSync(resolve(args.taskFile), 'utf8')) : null;
    const result = args.renderJob ? renderAiJobIssue(brief, manifest, task) : args.render ? renderIntakeBriefMarkdown(brief) : args.packet ? buildImplementationTaskPacket(brief, manifest) : evaluateProjectIntake(brief, manifest);
    if ((args.render || args.renderJob) && result.result !== 'STOP') process.stdout.write(result.markdown);
    else process.stdout.write(JSON.stringify(result, null, args.pretty ? 2 : 0) + '\n');
    if (result.result === 'STOP') process.exitCode = 2;
  } catch (error) {
    process.stdout.write(JSON.stringify(stop('PROJECT_INTAKE_INPUT_INVALID', error?.message || 'unknown error')) + '\n');
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
