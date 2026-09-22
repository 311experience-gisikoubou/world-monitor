#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizeHumanDecisionSync, validateHumanDecisionSync } from '../handoff/human-decision-sync.mjs';

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
export function computeIntakeProfile(riskSignals) {
  return RISK_SIGNAL_KEYS.some((key) => riskSignals[key] === true) ? 'FULL' : 'LIGHT';
}

export function normalizeIntakeBrief(input) {
  const allowed = ['schemaVersion', 'intakeId', 'intent', 'scope', 'assumptions', 'humanQuestions', 'riskSignals', 'status', 'decisionId'];
  if (!exactKeys(input, allowed) || input.schemaVersion !== 1) return { error: stop('PROJECT_INTAKE_BRIEF_INVALID', 'Project brief must use the closed schemaVersion=1 shape.') };
  const intakeId = cleanId(input.intakeId);
  const intent = resolvedText(input.intent, 2000);
  const scope = resolvedText(input.scope, 4000);
  const assumptions = textList(input.assumptions, { maxItems: 20, maxLength: 500 });
  const humanQuestions = textList(input.humanQuestions, { maxItems: 20, maxLength: 500 });
  const riskSignals = normalizeRiskSignals(input.riskSignals);
  const status = typeof input.status === 'string' && STATUSES.has(input.status) ? input.status : null;
  const decisionId = input.decisionId === null ? null : cleanId(input.decisionId);
  if (!intakeId || !intent || !scope || !assumptions || !humanQuestions || !riskSignals || !status || (input.decisionId !== null && !decisionId)) {
    return { error: stop('PROJECT_INTAKE_BRIEF_INVALID', 'Project brief fields are incomplete, malformed, or unresolved.') };
  }
  if (input.humanQuestions.length > MAX_HUMAN_QUESTIONS) return { error: stop('PROJECT_INTAKE_QUESTIONS_EXCEEDED', 'Human questions must not exceed 3.') };
  if (status === 'APPROVED' && !decisionId) return { error: stop('PROJECT_INTAKE_APPROVAL_REQUIRES_DECISION', 'APPROVED intake requires a decisionId.') };
  if (status !== 'APPROVED' && decisionId) return { error: stop('PROJECT_INTAKE_DECISION_PREMATURE', 'decisionId is allowed only for APPROVED intake.') };
  return { value: { schemaVersion: 1, intakeId, intent, scope, assumptions, humanQuestions, riskSignals, status, decisionId } };
}

export function evaluateProjectIntake(briefInput, manifest = null) {
  const normalized = normalizeIntakeBrief(briefInput);
  if (normalized.error) return normalized.error;
  const brief = normalized.value;
  const profile = computeIntakeProfile(brief.riskSignals);
  const common = { intakeId: brief.intakeId, profile, status: brief.status, intent: brief.intent, scope: brief.scope, assumptions: brief.assumptions, humanQuestions: brief.humanQuestions, riskSignals: brief.riskSignals };
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
    safetyFacts: { ...evaluated.riskSignals },
    approval: { decisionId: evaluated.decisionId, humanDecisionFingerprint: evaluated.humanDecisionFingerprint },
    downstreamGates: { ...GATE_REFERENCES },
    note: 'This packet points to existing Foundation gates and does not replace them.',
  };
}

function parseArgs(argv) {
  const out = { briefFile: null, contextFile: null, render: false, packet: false, pretty: false, valid: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--brief-file' && argv[i + 1]) out.briefFile = argv[++i];
    else if (arg === '--context-file' && argv[i + 1]) out.contextFile = argv[++i];
    else if (arg === '--render') out.render = true;
    else if (arg === '--packet') out.packet = true;
    else if (arg === '--pretty') out.pretty = true;
    else out.valid = false;
  }
  if (!out.briefFile || (out.render && out.packet)) out.valid = false;
  return out;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) { process.stdout.write(JSON.stringify(stop('PROJECT_INTAKE_ARGUMENT_INVALID', 'Arguments are invalid.')) + '\n'); process.exitCode = 2; return; }
  try {
    const brief = JSON.parse(readFileSync(resolve(args.briefFile), 'utf8'));
    const manifest = args.contextFile ? JSON.parse(readFileSync(resolve(args.contextFile), 'utf8')) : null;
    const result = args.render ? renderIntakeBriefMarkdown(brief) : args.packet ? buildImplementationTaskPacket(brief, manifest) : evaluateProjectIntake(brief, manifest);
    if (args.render && result.result !== 'STOP') process.stdout.write(result.markdown);
    else process.stdout.write(JSON.stringify(result, null, args.pretty ? 2 : 0) + '\n');
    if (result.result === 'STOP') process.exitCode = 2;
  } catch (error) {
    process.stdout.write(JSON.stringify(stop('PROJECT_INTAKE_INPUT_INVALID', error?.message || 'unknown error')) + '\n');
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
