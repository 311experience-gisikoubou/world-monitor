#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  preflight, evaluate, verifyPreflightReceipt, verifyMeasurementReceipt, verifyStagedEvidence,
} from './ui-reference-reproduction-gate.mjs';

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git failed: ' + args.join(' ') + '\n' + r.stderr);
  return String(r.stdout ?? '').trim();
}
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8'); }

const root = mkdtempSync(join(tmpdir(), 'ui-repro-gate-'));
try {
  git(root, ['init']);
  mkdirSync(join(root, 'docs', 'ui-reference', 'current'), { recursive: true });
  mkdirSync(join(root, 'visual-test'), { recursive: true });

  const artifactId = 'delivery-ui-v1';
  const viewId = 'delivery-data';
  const referenceVersion = '2026-09-22-v1';

  writeJson(join(root, 'PROJECT_CONTEXT.json'), {
    thisRepository: 'acme/app',
    canonicalContract: {
      schemaVersion: 1,
      contractId: 'acme-app-contract',
      contractVersion: '1',
      approved: true,
      artifacts: [{
        id: artifactId,
        kind: 'DESIGN',
        slot: 'delivery-ui',
        status: 'CURRENT',
        sources: ['docs/ui-reference/CURRENT.json', 'docs/ui-reference/current/delivery-data.png'],
        visual: { designId: artifactId, version: referenceVersion, scope: [viewId], baseline: 'REFERENCE_IMAGE' },
      }],
      protectedDecisions: ['approved-ui-reference-authority'],
      requiredValidation: ['canonical-contract-gate'],
    },
  });
  writeJson(join(root, 'docs', 'ui-reference', 'CURRENT.json'), {
    schemaVersion: 1,
    references: [{
      artifactId, viewId,
      image: 'docs/ui-reference/current/delivery-data.png',
      approvedAt: '2026-09-22',
      viewport: { width: 1536, height: 1024 },
      browserZoom: 100,
      devicePixelRatio: 1,
      browser: 'Chrome',
      fontFamily: 'Inter',
    }],
  });
  writeFileSync(join(root, 'docs', 'ui-reference', 'current', 'delivery-data.png'), Buffer.from('synthetic-reference'));

  writeJson(join(root, 'visual-test', 'dimensions.json'), {
    schemaVersion: 1, artifactId, viewId, referenceVersion,
    checks: [
      { id: 'LAYOUT-001', category: 'POSITION', fromPhase: 'EARLY_CHECK', expected: 20, unit: 'px' },
      { id: 'CARD-001', category: 'SIZE', fromPhase: 'EARLY_CHECK', expected: 320, unit: 'px' },
      { id: 'SPACING-007', category: 'SPACING', fromPhase: 'MILESTONE_CHECK', expected: 16, unit: 'px' },
      { id: 'FONT-003', category: 'FONT', fromPhase: 'MILESTONE_CHECK', expected: 'Inter|16px|600|24px', unit: 'exact' },
      { id: 'COLOR-002', category: 'COLOR', fromPhase: 'FINAL_REALITY_CHECK', expected: '#ffffff', unit: 'exact' },
    ],
  });
  writeJson(join(root, 'visual-test', 'thresholds.json'), {
    schemaVersion: 1,
    checks: [
      { id: 'LAYOUT-001', mode: 'ABSOLUTE', value: 2 },
      { id: 'CARD-001', mode: 'ABSOLUTE', value: 2 },
      { id: 'SPACING-007', mode: 'ABSOLUTE', value: 1 },
      { id: 'FONT-003', mode: 'EXACT', value: 0 },
      { id: 'COLOR-002', mode: 'EXACT', value: 0 },
    ],
  });
  writeFileSync(join(root, 'visual-test', 'inspect.mjs'), 'console.log("synthetic inspection fixture");\n', 'utf8');
  writeJson(join(root, 'visual-test', 'display.json'), {
    schemaVersion: 1,
    viewport: { width: 1536, height: 1024 },
    osScalePercent: 100,
    appZoomPercent: 100,
    referenceScale: 1,
    fontFamily: 'Inter',
  });
  writeJson(join(root, 'visual-test', 'dummy.json'), {
    schemaVersion: 1,
    dataClass: 'synthetic',
    fixtureId: 'delivery-data-fixed-fixture',
  });
  writeFileSync(join(root, 'visual-test', 'baseline-overlay.png'), Buffer.from('synthetic-overlay-proof'));
  writeJson(join(root, 'visual-test', 'reproduction.json'), {
    schemaVersion: 1,
    artifactId,
    viewId,
    referenceVersion,
    overlayVerified: true,
    dimensionsFile: 'visual-test/dimensions.json',
    thresholdsFile: 'visual-test/thresholds.json',
    inspectionScript: 'visual-test/inspect.mjs',
    displayConditionsFile: 'visual-test/display.json',
    dummyDataFile: 'visual-test/dummy.json',
    overlayProofFile: 'visual-test/baseline-overlay.png',
  });

  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Self Test', '-c', 'user.email=selftest@example.invalid', 'commit', '-m', 'fixture']);

  const pre = preflight({
    schemaVersion: 1, mode: 'PREFLIGHT', repoRoot: root, configPath: 'visual-test/reproduction.json',
  });
  assert.equal(pre.result, 'PASS');
  assert.equal(pre.code, 'UI_REPRODUCTION_PREFLIGHT_PASS');
  assert.equal(pre.checkCount, 5);
  assert.equal(verifyPreflightReceipt(pre), true);
  assert(pre.protectedPaths.includes('docs/ui-reference/current/delivery-data.png'));
  assert(pre.protectedPaths.includes('visual-test/inspect.mjs'));

  const state1 = 'worktree:' + '1'.repeat(64);
  const earlyPass = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'EARLY_CHECK',
    preflightReceipt: pre, priorReceipts: [],
    measurement: {
      schemaVersion: 1, stateId: state1, artifactId, viewId, referenceVersion,
      checks: [
        { id: 'LAYOUT-001', actual: 21 },
        { id: 'CARD-001', actual: 319 },
      ],
    },
  });
  assert.equal(earlyPass.result, 'PASS');
  assert.equal(earlyPass.checks.length, 2);
  assert.equal(verifyMeasurementReceipt(earlyPass), true);
  assert.deepEqual(verifyStagedEvidence(earlyPass, state1), {
    ok: true, code: 'UI_REPRODUCTION_RECEIPT_VALID', receiptId: earlyPass.receiptId,
  });

  const state2 = 'worktree:' + '2'.repeat(64);
  const milestoneFail1 = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'MILESTONE_CHECK',
    preflightReceipt: pre, priorReceipts: [],
    measurement: {
      schemaVersion: 1, stateId: state2, artifactId, viewId, referenceVersion,
      checks: [
        { id: 'LAYOUT-001', actual: 20 },
        { id: 'CARD-001', actual: 327 },
        { id: 'SPACING-007', actual: 16 },
        { id: 'FONT-003', actual: 'Inter|16px|600|24px' },
      ],
    },
  });
  assert.equal(milestoneFail1.result, 'FAIL');
  assert.deepEqual(milestoneFail1.failedIds, ['CARD-001']);

  const state3 = 'worktree:' + '3'.repeat(64);
  const milestoneFail2 = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'MILESTONE_CHECK',
    preflightReceipt: pre, priorReceipts: [milestoneFail1],
    measurement: {
      schemaVersion: 1, stateId: state3, artifactId, viewId, referenceVersion,
      checks: [
        { id: 'LAYOUT-001', actual: 20 },
        { id: 'CARD-001', actual: 326 },
        { id: 'SPACING-007', actual: 16 },
        { id: 'FONT-003', actual: 'Inter|16px|600|24px' },
      ],
    },
  });
  assert.equal(milestoneFail2.result, 'FAIL');

  const state4 = 'worktree:' + '4'.repeat(64);
  const milestoneFail3 = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'MILESTONE_CHECK',
    preflightReceipt: pre, priorReceipts: [milestoneFail1, milestoneFail2],
    measurement: {
      schemaVersion: 1, stateId: state4, artifactId, viewId, referenceVersion,
      checks: [
        { id: 'LAYOUT-001', actual: 20 },
        { id: 'CARD-001', actual: 325 },
        { id: 'SPACING-007', actual: 16 },
        { id: 'FONT-003', actual: 'Inter|16px|600|24px' },
      ],
    },
  });
  assert.equal(milestoneFail3.result, 'STOP');
  assert.equal(milestoneFail3.code, 'REPEATED_CHECK_FAILURE');
  assert.deepEqual(milestoneFail3.repeated, [{ id: 'CARD-001', count: 3 }]);

  const state5 = 'worktree:' + '5'.repeat(64);
  const finalPass = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'FINAL_REALITY_CHECK',
    preflightReceipt: pre, priorReceipts: [milestoneFail1, milestoneFail2],
    measurement: {
      schemaVersion: 1, stateId: state5, artifactId, viewId, referenceVersion,
      checks: [
        { id: 'LAYOUT-001', actual: 20 },
        { id: 'CARD-001', actual: 320 },
        { id: 'SPACING-007', actual: 16 },
        { id: 'FONT-003', actual: 'Inter|16px|600|24px' },
        { id: 'COLOR-002', actual: '#ffffff' },
      ],
    },
  });
  assert.equal(finalPass.result, 'PASS');
  assert.equal(finalPass.checks.length, 5);

  // Protected input drift is detected independently from implementation scope.
  writeFileSync(join(root, 'visual-test', 'thresholds.json'), readFileSync(join(root, 'visual-test', 'thresholds.json'), 'utf8') + ' ');
  const drift = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'EARLY_CHECK',
    preflightReceipt: pre, priorReceipts: [],
    measurement: {
      schemaVersion: 1, stateId: state1, artifactId, viewId, referenceVersion,
      checks: [
        { id: 'LAYOUT-001', actual: 20 },
        { id: 'CARD-001', actual: 320 },
      ],
    },
  });
  assert.equal(drift.result, 'STOP');
  assert.equal(drift.code, 'UI_REPRO_PROTECTED_FILE_CHANGED');
  git(root, ['checkout', '--', 'visual-test/thresholds.json']);

  // Missing overlay preparation fails closed.
  const configPath = join(root, 'visual-test', 'reproduction.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.overlayVerified = false;
  writeJson(configPath, config);
  const badPre = preflight({
    schemaVersion: 1, mode: 'PREFLIGHT', repoRoot: root, configPath: 'visual-test/reproduction.json',
  });
  assert.equal(badPre.result, 'STOP');
  assert.equal(badPre.code, 'UI_REPRO_CONFIG_INVALID');

  console.log('ui-reference-reproduction-gate selftest: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
