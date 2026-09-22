#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizeCanonicalContract } from '../handoff/canonical-contract-gate.mjs';
import { normalizeUiReferenceRegistry, referencesForArtifact, UI_REFERENCE_REGISTRY } from '../handoff/ui-reference-registry.mjs';

const MAX_INPUT_BYTES = 256 * 1024;
const STATE_ID_RE = /^(?:git|remote):[0-9a-f]{40}$|^(?:worktree|artifact):[0-9a-f]{64}$/u;
const SHA40_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const VIEW_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const PHASES = ['EARLY_CHECK', 'MILESTONE_CHECK', 'FINAL_REALITY_CHECK'];
const PHASE_RANK = new Map(PHASES.map((x, i) => [x, i]));
const CATEGORIES = new Set(['POSITION', 'SIZE', 'SPACING', 'FONT', 'COLOR']);
const MODES = new Set(['ABSOLUTE', 'EXACT']);

function stop(code, detail = {}) { return { schemaVersion: 1, result: 'STOP', code, ...detail }; }
function fail(code, detail = {}) { return { schemaVersion: 1, result: 'FAIL', code, ...detail }; }
function exactKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).length === keys.length && Object.keys(obj).every(k => keys.includes(k));
}
function boundedText(value, max = 500) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function repoPath(value) {
  if (!boundedText(value, 500) || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value)) return null;
  if (value.includes('\\') || value.split('/').some(x => x === '' || x === '.' || x === '..')) return null;
  return value;
}
function inside(root, rel) {
  const abs = resolve(root, ...rel.split('/'));
  const back = relative(root, abs);
  return back !== '' && !back.startsWith('..') && !isAbsolute(back) ? abs : null;
}
function readJson(path, code) {
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return { error: code }; }
}
function fileSha256(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch { return null; }
}
function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 });
}
function tracked(root, rel) {
  const r = git(root, ['ls-files', '--error-unmatch', '--', rel]);
  return !r.error && r.status === 0;
}
function headSha(root) {
  const r = git(root, ['rev-parse', 'HEAD']);
  const s = String(r.stdout ?? '').trim().toLowerCase();
  return !r.error && r.status === 0 && SHA40_RE.test(s) ? s : null;
}
function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function receiptCore(receipt) {
  const { receiptId, ...core } = receipt;
  return core;
}
function verifyReceiptHash(receipt) {
  return Boolean(receipt && typeof receipt === 'object' && SHA256_RE.test(receipt.receiptId ?? '') &&
    canonicalHash(receiptCore(receipt)) === receipt.receiptId);
}

function normalizeConfig(raw) {
  const keys = [
    'schemaVersion', 'artifactId', 'viewId', 'referenceVersion', 'overlayVerified',
    'dimensionsFile', 'thresholdsFile', 'inspectionScript', 'displayConditionsFile',
    'dummyDataFile', 'overlayProofFile',
  ];
  if (!exactKeys(raw, keys) || raw.schemaVersion !== 1 || raw.overlayVerified !== true) return null;
  if (!ID_RE.test(raw.artifactId ?? '') || !VIEW_RE.test(raw.viewId ?? '') || !boundedText(raw.referenceVersion, 80)) return null;
  const pathFields = ['dimensionsFile', 'thresholdsFile', 'inspectionScript', 'displayConditionsFile', 'dummyDataFile', 'overlayProofFile'];
  const normalized = { ...raw };
  for (const key of pathFields) {
    const p = repoPath(raw[key]);
    if (!p) return null;
    normalized[key] = p;
  }
  return normalized;
}

function normalizeDimensions(raw, config) {
  if (!exactKeys(raw, ['schemaVersion', 'artifactId', 'viewId', 'referenceVersion', 'checks']) || raw.schemaVersion !== 1) return null;
  if (raw.artifactId !== config.artifactId || raw.viewId !== config.viewId || raw.referenceVersion !== config.referenceVersion) return null;
  if (!Array.isArray(raw.checks) || raw.checks.length === 0 || raw.checks.length > 500) return null;
  const checks = [];
  const ids = new Set();
  for (const row of raw.checks) {
    if (!exactKeys(row, ['id', 'category', 'fromPhase', 'expected', 'unit'])) return null;
    if (!CHECK_ID_RE.test(row.id ?? '') || ids.has(row.id) || !CATEGORIES.has(row.category) || !PHASE_RANK.has(row.fromPhase)) return null;
    if (!(typeof row.expected === 'number' && Number.isFinite(row.expected)) && !boundedText(row.expected, 300)) return null;
    if (!boundedText(row.unit, 40)) return null;
    ids.add(row.id);
    checks.push({ ...row });
  }
  return checks;
}

function normalizeThresholds(raw, dimensions) {
  if (!exactKeys(raw, ['schemaVersion', 'checks']) || raw.schemaVersion !== 1 || !Array.isArray(raw.checks)) return null;
  const byId = new Map();
  for (const row of raw.checks) {
    if (!exactKeys(row, ['id', 'mode', 'value']) || !CHECK_ID_RE.test(row.id ?? '') || byId.has(row.id) || !MODES.has(row.mode)) return null;
    if (!Number.isFinite(row.value) || row.value < 0 || row.value > 100000) return null;
    if (row.mode === 'EXACT' && row.value !== 0) return null;
    byId.set(row.id, { ...row });
  }
  if (byId.size !== dimensions.length || dimensions.some(x => !byId.has(x.id))) return null;
  for (const d of dimensions) {
    const t = byId.get(d.id);
    if (typeof d.expected === 'number' && t.mode !== 'ABSOLUTE') return null;
    if (typeof d.expected === 'string' && t.mode !== 'EXACT') return null;
  }
  return byId;
}

function normalizeDisplay(raw) {
  if (!exactKeys(raw, ['schemaVersion', 'viewport', 'osScalePercent', 'appZoomPercent', 'referenceScale', 'fontFamily']) || raw.schemaVersion !== 1) return null;
  const v = raw.viewport;
  if (!exactKeys(v, ['width', 'height']) || !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 200 || v.height < 200 || v.width > 10000 || v.height > 10000) return null;
  if (!Number.isFinite(raw.osScalePercent) || raw.osScalePercent <= 0 || raw.osScalePercent > 500) return null;
  if (!Number.isFinite(raw.appZoomPercent) || raw.appZoomPercent <= 0 || raw.appZoomPercent > 500) return null;
  if (!Number.isFinite(raw.referenceScale) || raw.referenceScale <= 0 || raw.referenceScale > 8) return null;
  if (!boundedText(raw.fontFamily, 300)) return null;
  return raw;
}

function normalizeDummyData(raw) {
  if (!exactKeys(raw, ['schemaVersion', 'dataClass', 'fixtureId']) || raw.schemaVersion !== 1) return null;
  return raw.dataClass === 'synthetic' && ID_RE.test(raw.fixtureId ?? '') ? raw : null;
}

function loadPreparation(root, configPath) {
  const cfgRel = repoPath(configPath);
  if (!cfgRel) return stop('UI_REPRO_CONFIG_PATH_INVALID');
  const cfgAbs = inside(root, cfgRel);
  if (!cfgAbs || !tracked(root, cfgRel)) return stop('UI_REPRO_CONFIG_NOT_TRACKED');
  const cfgRaw = readJson(cfgAbs, 'UI_REPRO_CONFIG_INVALID');
  if (cfgRaw.error) return stop(cfgRaw.error);
  const config = normalizeConfig(cfgRaw.value);
  if (!config) return stop('UI_REPRO_CONFIG_INVALID');

  const context = readJson(resolve(root, 'PROJECT_CONTEXT.json'), 'PROJECT_CONTEXT_INVALID');
  if (context.error) return stop(context.error);
  const contract = normalizeCanonicalContract(context.value);
  if (contract.error) return stop(contract.error.code);
  const artifact = contract.byId.get(config.artifactId);
  if (!artifact || artifact.status !== 'CURRENT' || artifact.kind !== 'DESIGN' || artifact.visual?.baseline !== 'REFERENCE_IMAGE') {
    return stop('UI_REPRO_CURRENT_REFERENCE_REQUIRED');
  }
  if (artifact.visual.version !== config.referenceVersion || !artifact.visual.scope.includes(config.viewId)) {
    return stop('UI_REPRO_REFERENCE_VERSION_OR_SCOPE_MISMATCH');
  }

  const registryRel = UI_REFERENCE_REGISTRY;
  const registryAbs = inside(root, registryRel);
  if (!registryAbs || !tracked(root, registryRel)) return stop('UI_REFERENCE_REGISTRY_MISSING');
  const registryRaw = readJson(registryAbs, 'UI_REFERENCE_REGISTRY_INVALID');
  if (registryRaw.error) return stop(registryRaw.error);
  const registry = normalizeUiReferenceRegistry(registryRaw.value);
  if (registry.error) return stop(registry.error.code);
  const rows = referencesForArtifact(registry.value, config.artifactId).filter(x => x.viewId === config.viewId);
  if (rows.length !== 1) return stop('UI_REPRO_REFERENCE_ENTRY_MISSING_OR_AMBIGUOUS');
  const reference = rows[0];

  const files = {
    config: cfgRel,
    registry: registryRel,
    referenceImage: reference.image,
    dimensions: config.dimensionsFile,
    thresholds: config.thresholdsFile,
    inspectionScript: config.inspectionScript,
    displayConditions: config.displayConditionsFile,
    dummyData: config.dummyDataFile,
    overlayProof: config.overlayProofFile,
  };
  const hashes = {};
  for (const [name, rel] of Object.entries(files)) {
    const abs = inside(root, rel);
    if (!abs || !tracked(root, rel)) return stop('UI_REPRO_FIXED_FILE_NOT_TRACKED', { name, path: rel });
    const hash = fileSha256(abs);
    if (!hash) return stop('UI_REPRO_FIXED_FILE_INVALID', { name, path: rel });
    hashes[name] = hash;
  }

  const dimsRaw = readJson(inside(root, files.dimensions), 'UI_REPRO_DIMENSIONS_INVALID');
  if (dimsRaw.error) return stop(dimsRaw.error);
  const dimensions = normalizeDimensions(dimsRaw.value, config);
  if (!dimensions) return stop('UI_REPRO_DIMENSIONS_INVALID');

  const thresholdsRaw = readJson(inside(root, files.thresholds), 'UI_REPRO_THRESHOLDS_INVALID');
  if (thresholdsRaw.error) return stop(thresholdsRaw.error);
  const thresholds = normalizeThresholds(thresholdsRaw.value, dimensions);
  if (!thresholds) return stop('UI_REPRO_THRESHOLDS_INVALID');

  const displayRaw = readJson(inside(root, files.displayConditions), 'UI_REPRO_DISPLAY_CONDITIONS_INVALID');
  if (displayRaw.error) return stop(displayRaw.error);
  const display = normalizeDisplay(displayRaw.value);
  if (!display) return stop('UI_REPRO_DISPLAY_CONDITIONS_INVALID');
  if (!reference.viewport || reference.viewport.width !== display.viewport.width || reference.viewport.height !== display.viewport.height) {
    return stop('UI_REPRO_VIEWPORT_MISMATCH', { registryViewport: reference.viewport, displayViewport: display.viewport });
  }

  const dummyRaw = readJson(inside(root, files.dummyData), 'UI_REPRO_DUMMY_DATA_INVALID');
  if (dummyRaw.error) return stop(dummyRaw.error);
  const dummy = normalizeDummyData(dummyRaw.value);
  if (!dummy) return stop('UI_REPRO_DUMMY_DATA_INVALID');

  return {
    ok: true, config, artifact, reference, files, hashes, dimensions, thresholds, display, dummy,
    protectedPaths: [...new Set(Object.values(files))].sort(),
  };
}

export function preflight(input) {
  if (!input || input.schemaVersion !== 1 || input.mode !== 'PREFLIGHT' || !boundedText(input.repoRoot, 1000) || !boundedText(input.configPath, 500)) {
    return stop('UI_REPRO_PREFLIGHT_INPUT_INVALID');
  }
  const root = resolve(input.repoRoot);
  const prepared = loadPreparation(root, input.configPath);
  if (!prepared.ok) return prepared;
  const head = headSha(root);
  if (!head) return stop('UI_REPRO_HEAD_UNKNOWN');
  const core = {
    schemaVersion: 1,
    receiptType: 'UI_REPRODUCTION_PREFLIGHT_V1',
    result: 'PASS',
    code: 'UI_REPRODUCTION_PREFLIGHT_PASS',
    baseHead: head,
    artifactId: prepared.config.artifactId,
    viewId: prepared.config.viewId,
    referenceVersion: prepared.config.referenceVersion,
    referenceImage: prepared.reference.image,
    referenceImageSha256: prepared.hashes.referenceImage,
    displayConditions: prepared.display,
    checkCount: prepared.dimensions.length,
    protectedPaths: prepared.protectedPaths,
    protectedHashes: prepared.hashes,
    configPath: repoPath(input.configPath),
  };
  return { ...core, receiptId: canonicalHash(core) };
}

export function verifyPreflightReceipt(receipt) {
  if (!receipt || receipt.receiptType !== 'UI_REPRODUCTION_PREFLIGHT_V1' || receipt.result !== 'PASS' || receipt.code !== 'UI_REPRODUCTION_PREFLIGHT_PASS') return false;
  if (!SHA40_RE.test(receipt.baseHead ?? '') || !SHA256_RE.test(receipt.referenceImageSha256 ?? '') || !Array.isArray(receipt.protectedPaths)) return false;
  return verifyReceiptHash(receipt);
}

function protectedStillCurrent(root, preflightReceipt) {
  const prepared = loadPreparation(root, preflightReceipt.configPath);
  if (!prepared.ok) return prepared;
  if (prepared.config.artifactId !== preflightReceipt.artifactId || prepared.config.viewId !== preflightReceipt.viewId ||
      prepared.config.referenceVersion !== preflightReceipt.referenceVersion || prepared.reference.image !== preflightReceipt.referenceImage) {
    return stop('UI_REPRO_PREPARATION_DRIFT');
  }
  if (JSON.stringify(prepared.protectedPaths) !== JSON.stringify(preflightReceipt.protectedPaths)) return stop('UI_REPRO_PROTECTED_PATH_DRIFT');
  for (const [name, sha] of Object.entries(preflightReceipt.protectedHashes ?? {})) {
    if (prepared.hashes[name] !== sha) return stop('UI_REPRO_PROTECTED_FILE_CHANGED', { name });
  }
  return { ok: true, prepared };
}

function normalizeMeasurement(raw, receipt, phase, requiredChecks) {
  if (!exactKeys(raw, ['schemaVersion', 'stateId', 'artifactId', 'viewId', 'referenceVersion', 'checks']) || raw.schemaVersion !== 1) return null;
  if (!STATE_ID_RE.test(raw.stateId ?? '') || raw.artifactId !== receipt.artifactId || raw.viewId !== receipt.viewId || raw.referenceVersion !== receipt.referenceVersion) return null;
  if (!Array.isArray(raw.checks) || raw.checks.length !== requiredChecks.length) return null;
  const byId = new Map();
  for (const row of raw.checks) {
    if (!exactKeys(row, ['id', 'actual']) || !CHECK_ID_RE.test(row.id ?? '') || byId.has(row.id)) return null;
    if (!(typeof row.actual === 'number' && Number.isFinite(row.actual)) && !boundedText(row.actual, 300)) return null;
    byId.set(row.id, row.actual);
  }
  if (requiredChecks.some(x => !byId.has(x.id))) return null;
  return { stateId: raw.stateId, phase, byId };
}

function evaluateChecks(requiredChecks, thresholds, measurement) {
  return requiredChecks.map(spec => {
    const threshold = thresholds.get(spec.id);
    const actual = measurement.byId.get(spec.id);
    let passed = false;
    let delta = null;
    if (threshold.mode === 'ABSOLUTE' && typeof spec.expected === 'number' && typeof actual === 'number') {
      delta = Math.abs(actual - spec.expected);
      passed = delta <= threshold.value;
    } else if (threshold.mode === 'EXACT' && typeof spec.expected === 'string' && typeof actual === 'string') {
      passed = actual === spec.expected;
    }
    return {
      id: spec.id,
      category: spec.category,
      expected: spec.expected,
      actual,
      unit: spec.unit,
      tolerance: { mode: threshold.mode, value: threshold.value },
      delta,
      status: passed ? 'PASS' : 'FAIL',
    };
  });
}

export function verifyMeasurementReceipt(receipt) {
  if (!receipt || receipt.receiptType !== 'UI_MEASUREMENT_V1' || !['PASS', 'FAIL'].includes(receipt.result) || !STATE_ID_RE.test(receipt.stateId ?? '')) return false;
  return verifyReceiptHash(receipt);
}

function consecutiveFailures(currentFailedIds, priorReceipts) {
  const counts = new Map(currentFailedIds.map(id => [id, 1]));
  const ordered = [...priorReceipts].reverse();
  for (const prior of ordered) {
    const statusById = new Map((prior.checks ?? []).map(x => [x.id, x.status]));
    for (const id of [...counts.keys()]) {
      if (statusById.get(id) === 'FAIL') counts.set(id, counts.get(id) + 1);
      else counts.delete(id);
    }
    if (counts.size === 0) break;
  }
  return counts;
}

export function evaluate(input) {
  if (!input || input.schemaVersion !== 1 || input.mode !== 'EVALUATE' || !boundedText(input.repoRoot, 1000) ||
      !PHASE_RANK.has(input.phase) || !verifyPreflightReceipt(input.preflightReceipt)) {
    return stop('UI_REPRO_EVALUATE_INPUT_INVALID');
  }
  const prior = input.priorReceipts ?? [];
  if (!Array.isArray(prior) || prior.length > 20 || prior.some(x => !verifyMeasurementReceipt(x))) return stop('UI_REPRO_PRIOR_RECEIPTS_INVALID');
  if (prior.some(x => x.artifactId !== input.preflightReceipt.artifactId || x.viewId !== input.preflightReceipt.viewId ||
      x.referenceVersion !== input.preflightReceipt.referenceVersion)) return stop('UI_REPRO_PRIOR_RECEIPTS_WRONG_TARGET');

  const root = resolve(input.repoRoot);
  const protectedCheck = protectedStillCurrent(root, input.preflightReceipt);
  if (!protectedCheck.ok) return protectedCheck;
  const prepared = protectedCheck.prepared;
  const rank = PHASE_RANK.get(input.phase);
  const requiredChecks = prepared.dimensions.filter(x => PHASE_RANK.get(x.fromPhase) <= rank);
  const measurement = normalizeMeasurement(input.measurement, input.preflightReceipt, input.phase, requiredChecks);
  if (!measurement) return stop('UI_REPRO_MEASUREMENT_INVALID');

  const checks = evaluateChecks(requiredChecks, prepared.thresholds, measurement);
  const failedIds = checks.filter(x => x.status === 'FAIL').map(x => x.id);
  const core = {
    schemaVersion: 1,
    receiptType: 'UI_MEASUREMENT_V1',
    result: failedIds.length === 0 ? 'PASS' : 'FAIL',
    code: failedIds.length === 0 ? 'UI_MEASUREMENT_PASS' : 'UI_MEASUREMENT_FAIL',
    phase: input.phase,
    stateId: measurement.stateId,
    artifactId: input.preflightReceipt.artifactId,
    viewId: input.preflightReceipt.viewId,
    referenceVersion: input.preflightReceipt.referenceVersion,
    preflightReceiptId: input.preflightReceipt.receiptId,
    protectedFilesUnchanged: true,
    checks,
    failedIds,
  };
  const receipt = { ...core, receiptId: canonicalHash(core) };

  if (failedIds.length > 0) {
    const counts = consecutiveFailures(failedIds, prior);
    const repeated = [...counts.entries()].filter(([, count]) => count >= 3).map(([id, count]) => ({ id, count }));
    if (repeated.length > 0) return stop('REPEATED_CHECK_FAILURE', { repeated, measurementReceipt: receipt });
    return receipt;
  }
  return receipt;
}

export function verifyStagedEvidence(receipt, expectedStateId) {
  if (!verifyMeasurementReceipt(receipt) || receipt.result !== 'PASS' || receipt.stateId !== expectedStateId || receipt.protectedFilesUnchanged !== true) {
    return { ok: false, code: 'UI_REPRODUCTION_RECEIPT_INVALID' };
  }
  return { ok: true, code: 'UI_REPRODUCTION_RECEIPT_VALID', receiptId: receipt.receiptId };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) return { error: 'INPUT_TOO_LARGE' };
    chunks.push(chunk);
  }
  try { return { value: JSON.parse(chunks.join('')) }; } catch { return { error: 'INPUT_JSON_INVALID' }; }
}

async function main() {
  const input = await readStdin();
  const result = input.error ? stop(input.error) :
    input.value?.mode === 'PREFLIGHT' ? preflight(input.value) :
    input.value?.mode === 'EVALUATE' ? evaluate(input.value) :
    stop('MODE_INVALID');
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.result === 'PASS' ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
