#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// The human's natural-language/spoken instruction is authoritative for the
// current task. This gate evaluates a bounded machine-readable summary of
// that instruction plus every known ambiguity/assumption. It never decides
// human value questions itself; it only proves whether source implementation
// may proceed.

const SCHEMA_VERSION = 1;
const MAX_INSTRUCTIONS = 50;
const MAX_AMBIGUITIES = 100;

export const MATERIAL_AMBIGUITY_CATEGORIES = new Set([
  'approved-scope-baseline',
  'user-visible-design-behavior',
  'business-meaning-workflow',
  'safety-privacy-data-handling',
  'recurring-cost',
  'destructive-action',
  'other-human-value-decision',
]);

export const NON_MATERIAL_AMBIGUITY_CATEGORIES = new Set([
  'ai-resolvable-technical-detail',
  'harmless-reversible-non-material',
]);

const MATERIALITIES = new Set(['MATERIAL', 'NON_MATERIAL']);
const DECISION_OWNERS = new Set(['HUMAN', 'AI']);
const RESOLUTIONS = new Set(['UNRESOLVED', 'EXPLICIT_ASSUMPTION', 'HUMAN_CLARIFICATION_RECORDED']);
const INSTRUCTION_KINDS = new Set(['INSTRUCTION', 'CONSTRAINT']);

const ALLOWED_TOP_KEYS = new Set([
  'schemaVersion', 'taskId', 'instructions', 'unlistedAssumptionsPresent', 'ambiguities',
]);
const ALLOWED_INSTRUCTION_KEYS = new Set(['id', 'kind', 'summary']);
const ALLOWED_AMBIGUITY_KEYS = new Set([
  'id', 'summary', 'category', 'materiality', 'classificationReason',
  'decisionOwner', 'resolution', 'assumptionJustification', 'humanClarificationRef',
]);

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}
function boundedString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}
function stop(code, extra = {}) {
  return { schemaVersion: SCHEMA_VERSION, result: 'STOP', code, ...extra };
}
function isMaterialCategory(category) {
  return MATERIAL_AMBIGUITY_CATEGORIES.has(category);
}
function isNonMaterialCategory(category) {
  return NON_MATERIAL_AMBIGUITY_CATEGORIES.has(category);
}

export function validateInstructionClarityInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input_not_object'];
  const errors = [];
  if (input.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion_invalid');
  if (Object.keys(input).some((key) => !ALLOWED_TOP_KEYS.has(key))) errors.push('unknown_field');
  if (!safeToken(input.taskId)) errors.push('taskId_invalid');
  if (typeof input.unlistedAssumptionsPresent !== 'boolean') errors.push('unlistedAssumptionsPresent_invalid');

  if (!Array.isArray(input.instructions) || input.instructions.length === 0 || input.instructions.length > MAX_INSTRUCTIONS) {
    errors.push('instructions_invalid');
  } else {
    const seen = new Set();
    for (const item of input.instructions) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('instruction_not_object'); continue; }
      if (Object.keys(item).some((key) => !ALLOWED_INSTRUCTION_KEYS.has(key))) errors.push('instruction_unknown_field');
      if (!safeToken(item.id)) errors.push('instruction_id_invalid');
      else if (seen.has(item.id)) errors.push('instruction_duplicate_id');
      else seen.add(item.id);
      if (!INSTRUCTION_KINDS.has(item.kind)) errors.push('instruction_kind_invalid');
      if (!boundedString(item.summary, 500)) errors.push('instruction_summary_invalid');
    }
  }

  if (!Array.isArray(input.ambiguities) || input.ambiguities.length > MAX_AMBIGUITIES) {
    errors.push('ambiguities_invalid');
    return errors;
  }

  const seenIds = new Set();
  for (const item of input.ambiguities) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('ambiguity_not_object'); continue; }
    if (Object.keys(item).some((key) => !ALLOWED_AMBIGUITY_KEYS.has(key))) errors.push('ambiguity_unknown_field');
    if (!safeToken(item.id)) errors.push('ambiguity_id_invalid');
    else if (seenIds.has(item.id)) errors.push('ambiguity_duplicate_id');
    else seenIds.add(item.id);
    if (!boundedString(item.summary, 500)) errors.push('ambiguity_summary_invalid');
    if (!boundedString(item.classificationReason, 500)) errors.push('ambiguity_classificationReason_invalid');

    const materialCategory = isMaterialCategory(item.category);
    const nonMaterialCategory = isNonMaterialCategory(item.category);
    if (!materialCategory && !nonMaterialCategory) errors.push('ambiguity_category_invalid');
    if (!MATERIALITIES.has(item.materiality)) errors.push('ambiguity_materiality_invalid');
    if (!DECISION_OWNERS.has(item.decisionOwner)) errors.push('ambiguity_decisionOwner_invalid');
    if (!RESOLUTIONS.has(item.resolution)) errors.push('ambiguity_resolution_invalid');

    if (materialCategory && item.materiality !== 'MATERIAL') errors.push('ambiguity_materiality_category_mismatch');
    if (nonMaterialCategory && item.materiality !== 'NON_MATERIAL') errors.push('ambiguity_materiality_category_mismatch');
    if (materialCategory && item.decisionOwner !== 'HUMAN') errors.push('ambiguity_decisionOwner_category_mismatch');
    if (nonMaterialCategory && item.decisionOwner !== 'AI') errors.push('ambiguity_decisionOwner_category_mismatch');

    if (item.resolution === 'EXPLICIT_ASSUMPTION') {
      if (!nonMaterialCategory || item.decisionOwner !== 'AI') errors.push('ambiguity_assumption_not_allowed');
      if (!boundedString(item.assumptionJustification, 500)) errors.push('ambiguity_assumptionJustification_required');
    } else if (item.assumptionJustification !== undefined) {
      errors.push('ambiguity_assumptionJustification_forbidden');
    }

    if (item.resolution === 'HUMAN_CLARIFICATION_RECORDED') {
      if (!safeToken(item.humanClarificationRef)) errors.push('ambiguity_humanClarificationRef_required');
    } else if (item.humanClarificationRef !== undefined) {
      errors.push('ambiguity_humanClarificationRef_forbidden');
    }
  }
  return errors;
}

export function evaluateInstructionClarity(input) {
  const errors = validateInstructionClarityInput(input);
  if (errors.length > 0) return stop('SCHEMA_INVALID', { errors });
  const { taskId } = input;

  if (input.unlistedAssumptionsPresent === true) {
    return stop('UNLISTED_ASSUMPTION_PRESENT', { taskId });
  }

  const materialUnresolved = input.ambiguities.filter(
    (item) => item.materiality === 'MATERIAL' && item.resolution !== 'HUMAN_CLARIFICATION_RECORDED',
  );
  if (materialUnresolved.length > 0) {
    return stop('MATERIAL_AMBIGUITY_UNRESOLVED', {
      taskId,
      ambiguityIds: materialUnresolved.map((item) => item.id),
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'PROCEED',
    code: 'INSTRUCTION_CLARITY_CONFIRMED',
    taskId,
    instructionCount: input.instructions.length,
    ambiguityCount: input.ambiguities.length,
    materialResolvedCount: input.ambiguities.filter((item) => item.materiality === 'MATERIAL').length,
    nonMaterialCount: input.ambiguities.filter((item) => item.materiality === 'NON_MATERIAL').length,
    assumptionCount: input.ambiguities.filter((item) => item.resolution === 'EXPLICIT_ASSUMPTION').length,
    humanClarificationCount: input.ambiguities.filter((item) => item.resolution === 'HUMAN_CLARIFICATION_RECORDED').length,
    evidence: {
      instructions: input.instructions.map((item) => ({ id: item.id, kind: item.kind, summary: item.summary })),
      ambiguities: input.ambiguities.map((item) => ({
        id: item.id,
        summary: item.summary,
        category: item.category,
        materiality: item.materiality,
        classificationReason: item.classificationReason,
        decisionOwner: item.decisionOwner,
        resolution: item.resolution,
        ...(item.assumptionJustification !== undefined ? { assumptionJustification: item.assumptionJustification } : {}),
        ...(item.humanClarificationRef !== undefined ? { humanClarificationRef: item.humanClarificationRef } : {}),
      })),
    },
  };
}

function parseArgs(argv) {
  const out = { inputPath: null, pretty: false, valid: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) out.inputPath = argv[++i];
    else if (arg === '--pretty') out.pretty = true;
    else out.valid = false;
  }
  if (typeof out.inputPath !== 'string' || out.inputPath.length === 0) out.valid = false;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) {
    process.stdout.write(`${JSON.stringify(stop('ARGUMENT_INVALID'))}\n`);
    process.exitCode = 2;
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
  const result = evaluateInstructionClarity(input);
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  process.exitCode = result.result === 'PROCEED' ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
