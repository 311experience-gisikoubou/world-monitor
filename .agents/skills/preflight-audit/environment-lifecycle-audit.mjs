#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Small lifecycle helper for the existing preflight/test/final workflow. It
// adds exactly two closed, observation-only checks:
//   1. evaluateEnvironmentGrowth -- records any new local environment
//      footprint (installed tool/package/service/etc.) with the required
//      item/need/alternative/residency/egress/auto-update/permissions/size/
//      remove/stop fields, and rejects UNKNOWN or UNSAFE permissions/safety
//      outright (subject to the existing human/install boundaries elsewhere
//      -- this module never itself grants install authority).
//   2. evaluateCleanupAudit -- a PoC Cleanup Audit inventory across the
//      closed category list, classifying each row KEEP / STOP /
//      DELETE_CANDIDATE / HUMAN_DECISION_REQUIRED only. It NEVER performs
//      stop/delete/revoke side effects itself; it is a classification
//      record only, and a missing inventory fails closed.
// This is not a new skill/router/platform: it is one small module inside
// the existing preflight-audit skill, wired by reference from SKILL.md.

const SCHEMA_VERSION = 1;

function nonEmptyString(value, max = 1000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function closedObject(value, allowedKeys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key));
}
function stop(code, extra = {}) {
  return { schemaVersion: SCHEMA_VERSION, result: 'STOP', code, ...extra };
}

// --- Environment growth ---------------------------------------------------

export const ENVIRONMENT_ADDITION_KEYS = [
  'item', 'need', 'alternative', 'residency', 'egress', 'autoUpdate',
  'permissions', 'permissionDetails', 'size', 'remove', 'stop',
  'necessityClassification',
];
// SAFE is the only value that allows an addition through. UNKNOWN and UNSAFE
// are both rejected here: an unknown safety/install profile is never
// silently treated as acceptable, and actual install/account authority
// always remains subject to the existing human/Research Gate boundaries
// (research-gate.mjs, operation-preflight.mjs) -- this module never grants it.
export const ENVIRONMENT_PERMISSIONS_VALUES = new Set(['SAFE', 'UNKNOWN', 'UNSAFE']);
// `permissions` alone is only a safety VERDICT (SAFE/UNKNOWN/UNSAFE); it
// records no actual requested rights. `permissionDetails` is the required,
// bounded, nonempty record of what was ACTUALLY requested (e.g. "read-only
// local filesystem access under the existing venv; no network, no
// credentials, no elevated/admin rights"), so an operational audit can see
// the real privilege footprint, not only a one-word verdict.
// `necessityClassification` is OPTIONAL and backwards compatible: omitting
// it preserves prior behavior exactly (implicitly REQUIRED). When a caller
// explicitly classifies the addition as EXISTING_ALTERNATIVE_SUFFICES --
// i.e. the `alternative` field it must already name identifies an actual
// existing substitute that is clearly sufficient -- this growth is itself
// unnecessary and must STOP rather than silently PROCEED, without inventing
// a second subsystem or a false universal "this always intercepts growth"
// claim; it only classifies THIS already-declared addition.
export const ENVIRONMENT_NECESSITY_VALUES = new Set(['REQUIRED', 'EXISTING_ALTERNATIVE_SUFFICES']);

function validateEnvironmentAddition(row) {
  const errors = [];
  if (!closedObject(row, ENVIRONMENT_ADDITION_KEYS)) return ['addition_not_object_or_unknown_field'];
  if (!nonEmptyString(row.item, 200)) errors.push('item_invalid');
  if (!nonEmptyString(row.need, 500)) errors.push('need_invalid');
  if (!nonEmptyString(row.alternative, 500)) errors.push('alternative_invalid');
  if (!nonEmptyString(row.residency, 300)) errors.push('residency_invalid');
  if (!nonEmptyString(row.egress, 300)) errors.push('egress_invalid');
  if (typeof row.autoUpdate !== 'boolean') errors.push('autoUpdate_invalid');
  if (!ENVIRONMENT_PERMISSIONS_VALUES.has(row.permissions)) errors.push('permissions_invalid');
  if (!nonEmptyString(row.permissionDetails, 500)) errors.push('permissionDetails_invalid');
  if (!nonEmptyString(row.size, 100)) errors.push('size_invalid');
  if (!nonEmptyString(row.remove, 300)) errors.push('remove_invalid');
  if (!nonEmptyString(row.stop, 300)) errors.push('stop_invalid');
  if (row.necessityClassification !== undefined && !ENVIRONMENT_NECESSITY_VALUES.has(row.necessityClassification)) {
    errors.push('necessityClassification_invalid');
  }
  return errors;
}

export function evaluateEnvironmentGrowth(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return stop('ENVIRONMENT_GROWTH_MISSING');
  }
  if (input.schemaVersion !== SCHEMA_VERSION ||
      Object.keys(input).some((key) => key !== 'schemaVersion' && key !== 'additions') ||
      !Array.isArray(input.additions)) {
    return stop('SCHEMA_INVALID');
  }
  if (input.additions.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, result: 'PROCEED', code: 'NO_ENVIRONMENT_GROWTH', additions: [] };
  }
  const errors = [];
  const rejected = [];
  const unnecessary = [];
  for (const [index, row] of input.additions.entries()) {
    const rowErrors = validateEnvironmentAddition(row);
    if (rowErrors.length > 0) { errors.push(`addition_${index}:${rowErrors.join(',')}`); continue; }
    if (row.permissions !== 'SAFE') rejected.push({ item: row.item, permissions: row.permissions });
    if (row.necessityClassification === 'EXISTING_ALTERNATIVE_SUFFICES') {
      unnecessary.push({ item: row.item, alternative: row.alternative });
    }
  }
  if (errors.length > 0) return stop('ENVIRONMENT_GROWTH_INVALID', { errors });
  if (unnecessary.length > 0) {
    return stop('ENVIRONMENT_GROWTH_UNNECESSARY_EXISTING_ALTERNATIVE_SUFFICES', { unnecessary });
  }
  if (rejected.length > 0) {
    return stop('ENVIRONMENT_GROWTH_UNSAFE_OR_UNKNOWN_PERMISSIONS', { rejected });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'PROCEED',
    code: 'ENVIRONMENT_GROWTH_RECORDED',
    additions: input.additions.map((row) => ({ ...row })),
  };
}

// --- PoC Cleanup Audit -----------------------------------------------------

export const CLEANUP_CATEGORIES = [
  'folders', 'clones', 'worktrees', 'temp', 'downloads', 'apps', 'cli',
  'packages', 'backgroundProcesses', 'listeners', 'firewall', 'scheduledTasks',
  'services', 'extensions', 'oauth', 'tokens', 'publicUrls', 'testDeployments',
  'cloudResources',
];
export const CLEANUP_CLASSIFICATIONS = new Set([
  'KEEP', 'STOP', 'DELETE_CANDIDATE', 'HUMAN_DECISION_REQUIRED',
]);
const CLEANUP_ROW_KEYS = ['item', 'classification', 'rationale'];

function validateCleanupRow(row) {
  const errors = [];
  if (!closedObject(row, CLEANUP_ROW_KEYS)) return ['row_not_object_or_unknown_field'];
  if (!nonEmptyString(row.item, 300)) errors.push('item_invalid');
  if (!CLEANUP_CLASSIFICATIONS.has(row.classification)) errors.push('classification_invalid');
  if (!nonEmptyString(row.rationale, 500)) errors.push('rationale_invalid');
  return errors;
}

// Every category must be explicitly accounted for -- either a non-empty
// array of inventoried rows, or the literal 'NONE_FOUND' honestly declaring
// nothing was found in that category. Omitting a category entirely (rather
// than declaring it empty) fails closed, since a missing inventory is
// treated as a missing inventory, not as an implicit "nothing to report".
export function evaluateCleanupAudit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return stop('CLEANUP_AUDIT_MISSING');
  }
  if (input.schemaVersion !== SCHEMA_VERSION) return stop('SCHEMA_INVALID');
  const categories = input.categories;
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) {
    return stop('CLEANUP_AUDIT_MISSING');
  }
  const errors = [];
  if (Object.keys(categories).some((key) => !CLEANUP_CATEGORIES.includes(key))) {
    errors.push('category_unknown_field');
  }
  const rows = [];
  for (const category of CLEANUP_CATEGORIES) {
    const value = categories[category];
    if (value === undefined) { errors.push(`category_${category}_missing`); continue; }
    if (value === 'NONE_FOUND') continue;
    if (!Array.isArray(value) || value.length === 0) { errors.push(`category_${category}_invalid`); continue; }
    for (const [index, row] of value.entries()) {
      const rowErrors = validateCleanupRow(row);
      if (rowErrors.length > 0) { errors.push(`category_${category}_row_${index}:${rowErrors.join(',')}`); continue; }
      rows.push({ category, item: row.item, classification: row.classification, rationale: row.rationale });
    }
  }
  if (errors.length > 0) return stop('CLEANUP_AUDIT_INVALID', { errors });

  const summary = { KEEP: 0, STOP: 0, DELETE_CANDIDATE: 0, HUMAN_DECISION_REQUIRED: 0 };
  for (const row of rows) summary[row.classification] += 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    result: 'PROCEED',
    code: 'CLEANUP_AUDIT_RECORDED',
    rows,
    summary,
    note: 'Classification record only. This module never performs stop/delete/revoke/disable side effects itself.',
  };
}

function parseArgs(argv) {
  const out = { mode: null, inputPath: null, pretty: false, valid: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--environment-growth') out.mode = 'environment-growth';
    else if (arg === '--cleanup-audit') out.mode = 'cleanup-audit';
    else if (arg === '--input' && argv[i + 1]) out.inputPath = argv[++i];
    else if (arg === '--pretty') out.pretty = true;
    else out.valid = false;
  }
  if (!out.mode || !out.inputPath) out.valid = false;
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
    process.stdout.write(`${JSON.stringify(stop('INPUT_READ_OR_PARSE_FAILED'))}\n`);
    process.exitCode = 2;
    return;
  }
  const result = args.mode === 'environment-growth' ? evaluateEnvironmentGrowth(input) : evaluateCleanupAudit(input);
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  process.exitCode = result.result === 'PROCEED' ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
