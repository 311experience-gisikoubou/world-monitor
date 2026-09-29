#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  preflight, evaluate, verifyPreflightReceipt, verifyMeasurementReceipt, verifyStagedEvidence,
} from './ui-reference-reproduction-gate.mjs';
import { encodeSyntheticPng } from './visual-diff-engine.mjs';

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git failed: ' + args.join(' ') + '\n' + r.stderr);
  return String(r.stdout ?? '').trim();
}
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function rgba(width, height, color = [255, 255, 255, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(color, i * 4);
  return data;
}
function paint(data, imageWidth, region, color) {
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) data.set(color, (y * imageWidth + x) * 4);
  }
}
function png(width, height, data) { return encodeSyntheticPng({ width, height, data }); }

const root = mkdtempSync(join(tmpdir(), 'ui-repro-gate-'));
try {
  git(root, ['init']);
  mkdirSync(join(root, 'docs', 'ui-reference', 'current'), { recursive: true });
  mkdirSync(join(root, 'visual-test'), { recursive: true });

  const artifactId = 'delivery-ui-v1';
  const viewId = 'delivery-data';
  const referenceVersion = '2026-09-28-v2';
  const width = 240, height = 200;
  const shapeRegion = { x: 10, y: 10, width: 20, height: 20 };
  const display = {
    schemaVersion: 2,
    viewport: { width, height },
    osScalePercent: 100,
    appZoomPercent: 100,
    referenceScale: 1,
    devicePixelRatio: 1,
    appWindowState: 'FIXED_WINDOWED',
    fontFamily: 'Inter',
  };

  const baselineData = rgba(width, height);
  paint(baselineData, width, shapeRegion, [0, 0, 0, 255]);
  const baselinePng = png(width, height, baselineData);
  writeFileSync(join(root, 'docs', 'ui-reference', 'current', 'delivery-data.png'), baselinePng);

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
      approvedAt: '2026-09-28',
      viewport: { width, height },
      browserZoom: 100,
      devicePixelRatio: 1,
      browser: 'Chrome',
      fontFamily: 'Inter',
    }],
  });

  writeJson(join(root, 'visual-test', 'dimensions.json'), {
    schemaVersion: 1, artifactId, viewId, referenceVersion,
    checks: [
      { id: 'LAYOUT-001', category: 'POSITION', fromPhase: 'EARLY_CHECK', expected: 20, unit: 'px' },
      { id: 'CARD-001', category: 'SIZE', fromPhase: 'EARLY_CHECK', expected: 120, unit: 'px' },
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
  writeJson(join(root, 'visual-test', 'display.json'), display);
  writeJson(join(root, 'visual-test', 'dummy.json'), {
    schemaVersion: 1, dataClass: 'synthetic', fixtureId: 'delivery-data-fixed-fixture',
  });
  writeFileSync(join(root, 'visual-test', 'baseline-overlay.png'), Buffer.from('synthetic-overlay-proof'));
  writeJson(join(root, 'visual-test', 'final-visual-thresholds.json'), {
    schemaVersion: 1, pixelDeltaThreshold: 0, maxChangedRatio: 0.01,
  });

  const toothSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M3 2 L17 2 L15 18 L5 18 Z"/></svg>\n';
  writeFileSync(join(root, 'visual-test', 'tooth-11.svg'), toothSvg, 'utf8');
  writeJson(join(root, 'visual-test', 'fixed-shapes.json'), {
    schemaVersion: 1, artifactId, viewId, referenceVersion,
    components: [{
      componentId: 'tooth-shape-11',
      targetRegion: shapeRegion,
      canonicalKind: 'SVG',
      canonicalAsset: 'visual-test/tooth-11.svg',
      version: 'tooth-v1',
      sha256: sha256(Buffer.from(toothSvg)),
      pixelDeltaThreshold: 0,
      maxChangedRatio: 0,
    }],
  });
  writeJson(join(root, 'visual-test', 'reproduction.json'), {
    schemaVersion: 2,
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
    finalVisualDiffThresholdsFile: 'visual-test/final-visual-thresholds.json',
    fixedShapeRegistryFile: 'visual-test/fixed-shapes.json',
  });

  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Self Test', '-c', 'user.email=selftest@example.invalid', 'commit', '-m', 'fixture']);

  const pre = preflight({
    schemaVersion: 1, mode: 'PREFLIGHT', repoRoot: root, configPath: 'visual-test/reproduction.json',
  });
  assert.equal(pre.result, 'PASS');
  assert.equal(pre.code, 'UI_REPRODUCTION_PREFLIGHT_PASS');
  assert.equal(pre.checkCount, 5);
  assert.equal(pre.fixedShapeCount, 1);
  assert.equal(verifyPreflightReceipt(pre), true);
  assert(pre.protectedPaths.includes('visual-test/final-visual-thresholds.json'));
  assert(pre.protectedPaths.includes('visual-test/fixed-shapes.json'));
  assert(pre.protectedPaths.includes('visual-test/tooth-11.svg'));

  const measurement = (stateId, phase = 'FINAL_REALITY_CHECK') => ({
    schemaVersion: 1, stateId, artifactId, viewId, referenceVersion,
    checks: phase === 'EARLY_CHECK'
      ? [{ id: 'LAYOUT-001', actual: 20 }, { id: 'CARD-001', actual: 120 }]
      : phase === 'MILESTONE_CHECK'
        ? [
            { id: 'LAYOUT-001', actual: 20 }, { id: 'CARD-001', actual: 120 },
            { id: 'SPACING-007', actual: 16 }, { id: 'FONT-003', actual: 'Inter|16px|600|24px' },
          ]
        : [
            { id: 'LAYOUT-001', actual: 20 }, { id: 'CARD-001', actual: 120 },
            { id: 'SPACING-007', actual: 16 }, { id: 'FONT-003', actual: 'Inter|16px|600|24px' },
            { id: 'COLOR-002', actual: '#ffffff' },
          ],
  });

  const stateEarly = 'worktree:' + '1'.repeat(64);
  const earlyPass = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'EARLY_CHECK',
    preflightReceipt: pre, priorReceipts: [], measurement: measurement(stateEarly, 'EARLY_CHECK'),
  });
  assert.equal(earlyPass.result, 'PASS');
  assert.equal(earlyPass.visualComparison, undefined);
  assert.equal(verifyMeasurementReceipt(earlyPass), true);
  assert.equal(verifyStagedEvidence(earlyPass, stateEarly).ok, true);

  const badNumeric = (stateId, priorReceipts) => evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'MILESTONE_CHECK',
    preflightReceipt: pre, priorReceipts,
    measurement: {
      ...measurement(stateId, 'MILESTONE_CHECK'),
      checks: [
        { id: 'LAYOUT-001', actual: 20 }, { id: 'CARD-001', actual: 130 },
        { id: 'SPACING-007', actual: 16 }, { id: 'FONT-003', actual: 'Inter|16px|600|24px' },
      ],
    },
  });
  const fail1 = badNumeric('worktree:' + '2'.repeat(64), []);
  const fail2 = badNumeric('worktree:' + '3'.repeat(64), [fail1]);
  const fail3 = badNumeric('worktree:' + '4'.repeat(64), [fail1, fail2]);
  assert.equal(fail1.result, 'FAIL');
  assert.equal(fail2.result, 'FAIL');
  assert.equal(fail3.result, 'STOP');
  assert.equal(fail3.code, 'REPEATED_CHECK_FAILURE');

  const actualC = join(root, 'visual-test', 'actual-case-c.png');
  writeFileSync(actualC, baselinePng);

  const actualAData = Buffer.from(baselineData);
  paint(actualAData, width, { x: 100, y: 80, width: 40, height: 40 }, [100, 100, 100, 255]);
  writeFileSync(join(root, 'visual-test', 'actual-case-a.png'), png(width, height, actualAData));

  const actualBData = Buffer.from(baselineData);
  paint(actualBData, width, { x: 15, y: 15, width: 1, height: 1 }, [255, 255, 255, 255]);
  writeFileSync(join(root, 'visual-test', 'actual-case-b.png'), png(width, height, actualBData));

  const finalInput = (stateId, actualScreenshot, captureConditions = display) => ({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'FINAL_REALITY_CHECK',
    preflightReceipt: pre, priorReceipts: [],
    measurement: measurement(stateId),
    actualScreenshot,
    captureConditions,
  });

  // Case A: numeric PASS, whole/card appearance differs materially => FINAL FAIL.
  const caseA = evaluate(finalInput('worktree:' + 'a'.repeat(64), 'visual-test/actual-case-a.png'));
  assert.equal(caseA.result, 'FAIL');
  assert.equal(caseA.code, 'UI_REPRODUCTION_FINAL_FAIL');
  assert.equal(caseA.failedIds.length, 0);
  assert.equal(caseA.visualComparison.result, 'FAIL');
  assert.equal(caseA.fixedShapeComparison.result, 'PASS');

  // Case B: numeric PASS and whole diff tolerance passes, but one fixed-shape pixel differs => FINAL FAIL.
  const caseB = evaluate(finalInput('worktree:' + 'b'.repeat(64), 'visual-test/actual-case-b.png'));
  assert.equal(caseB.result, 'FAIL');
  assert.equal(caseB.failedIds.length, 0);
  assert.equal(caseB.visualComparison.result, 'PASS');
  assert.equal(caseB.fixedShapeComparison.result, 'FAIL');
  assert.deepEqual(caseB.fixedShapeComparison.failedShapeIds, ['tooth-shape-11']);

  // Case C: numeric, direct whole-image comparison and fixed-shape comparison all match => FINAL PASS.
  const stateC = 'worktree:' + 'c'.repeat(64);
  const caseC = evaluate(finalInput(stateC, 'visual-test/actual-case-c.png'));
  assert.equal(caseC.result, 'PASS');
  assert.equal(caseC.code, 'UI_REPRODUCTION_FINAL_PASS');
  assert.equal(caseC.visualComparison.result, 'PASS');
  assert.equal(caseC.fixedShapeComparison.result, 'PASS');
  assert.equal(verifyMeasurementReceipt(caseC), true);
  assert.equal(verifyStagedEvidence(caseC, stateC).ok, true);

  const wrongCapture = evaluate(finalInput(
    'worktree:' + 'd'.repeat(64), 'visual-test/actual-case-c.png', { ...display, devicePixelRatio: 2 },
  ));
  assert.equal(wrongCapture.result, 'STOP');
  assert.equal(wrongCapture.code, 'UI_REPRO_CAPTURE_CONDITIONS_MISMATCH');

  const overlayAsActual = evaluate(finalInput(
    'worktree:' + 'e'.repeat(64), 'visual-test/baseline-overlay.png',
  ));
  assert.equal(overlayAsActual.result, 'STOP');
  assert.equal(overlayAsActual.code, 'UI_REPRO_OVERLAY_NOT_ACTUAL_SCREENSHOT');

  // A registered shape's canonical file is protected and hash-bound.
  writeFileSync(join(root, 'visual-test', 'tooth-11.svg'), toothSvg.replace('L17 2', 'L16 2'), 'utf8');
  const shapeDrift = evaluate({
    schemaVersion: 1, mode: 'EVALUATE', repoRoot: root, phase: 'EARLY_CHECK',
    preflightReceipt: pre, priorReceipts: [], measurement: measurement(stateEarly, 'EARLY_CHECK'),
  });
  assert.equal(shapeDrift.result, 'STOP');
  assert.equal(shapeDrift.code, 'UI_REPRO_FIXED_SHAPE_CANONICAL_HASH_MISMATCH');
  git(root, ['checkout', '--', 'visual-test/tooth-11.svg']);

  const tampered = structuredClone(caseC);
  tampered.visualComparison.result = 'FAIL';
  assert.equal(verifyStagedEvidence(tampered, stateC).ok, false);
  assert.equal(verifyStagedEvidence(caseC, 'worktree:' + 'f'.repeat(64)).ok, false);

  console.log('ui-reference-reproduction-gate selftest: PASS (cases A/B/C)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
