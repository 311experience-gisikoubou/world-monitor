#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  compareDecoded, decodePng, encodeSyntheticPng, resolveRegistryBaseline, runVisualDiff, verifyVisualDiffEvidence,
} from './visual-diff-engine.mjs';

const STATE = 'git:' + 'a'.repeat(40);
const runWithState = args => runVisualDiff({ ...args, stateId: STATE });

// Independent PNG filter encoder (mirrors the PNG spec's per-scanline filter formulas, not the
// engine's unfilter code) used only to prove decodePng correctly reverses every filter type
// (Sub/Up/Average/Paeth), since encodeSyntheticPng always emits filter type 0 and so cannot
// exercise those decode paths on its own.
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function paethRef(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function buildFilteredPng(width, height, channels, colorType, raster, filterTypeForRow) {
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const ft = filterTypeForRow(y);
    raw[y * (rowBytes + 1)] = ft;
    for (let x = 0; x < rowBytes; x++) {
      const orig = raster[y * rowBytes + x];
      const a = x >= channels ? raster[y * rowBytes + x - channels] : 0;
      const b = y > 0 ? raster[(y - 1) * rowBytes + x] : 0;
      const c = (y > 0 && x >= channels) ? raster[(y - 1) * rowBytes + x - channels] : 0;
      let filt;
      if (ft === 0) filt = orig;
      else if (ft === 1) filt = orig - a;
      else if (ft === 2) filt = orig - b;
      else if (ft === 3) filt = orig - Math.floor((a + b) / 2);
      else filt = orig - paethRef(a, b, c);
      raw[y * (rowBytes + 1) + 1 + x] = filt & 0xff;
    }
  }
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0); ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = colorType; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  return Buffer.concat([SIG, pngChunk('IHDR', ihdrData), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

function solidRGBA(width, height, [r, g, b, a]) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { const o = i * 4; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a; }
  return buf;
}
function withChangedPixels(base, count, delta) {
  const buf = Buffer.from(base);
  for (let i = 0; i < count; i++) buf[i * 4] = Math.min(255, buf[i * 4] + delta);
  return buf;
}

// --- decode/encode roundtrip across supported color depths ---
{
  const width = 6, height = 4;
  const rgba = solidRGBA(width, height, [10, 20, 30, 255]);
  for (let i = 0; i < width * height; i++) rgba[i * 4 + (i % 3)] = (i * 17) % 256; // vary pixels
  const png = encodeSyntheticPng({ width, height, data: rgba });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const decoded = decodePng(png);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(Buffer.compare(decoded.data, rgba), 0);
}

// --- decode: every scanline filter type (0-4), independently re-encoded, must reconstruct exactly ---
{
  const width = 9, height = 5, channels = 4, colorType = 6; // RGBA
  const raster = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raster.length; i++) raster[i] = (i * 37 + 11) % 256; // non-trivial pseudo-random pattern
  const png = buildFilteredPng(width, height, channels, colorType, raster, y => y % 5); // cycles through filter types 0..4
  const decoded = decodePng(png);
  assert.equal(decoded.ok, true, JSON.stringify(decoded));
  assert.equal(Buffer.compare(decoded.data, raster), 0);
}

// --- decode: RGB (colorType 2), grayscale (0), and grayscale+alpha (4) with a non-None filter ---
{
  const width = 4, height = 4;
  const rgbRaster = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgbRaster.length; i++) rgbRaster[i] = (i * 53 + 7) % 256;
  const rgbPng = buildFilteredPng(width, height, 3, 2, rgbRaster, () => 2); // Up filter throughout
  const rgbDecoded = decodePng(rgbPng);
  assert.equal(rgbDecoded.ok, true);
  for (let i = 0; i < width * height; i++) {
    assert.equal(rgbDecoded.data[i * 4], rgbRaster[i * 3]);
    assert.equal(rgbDecoded.data[i * 4 + 1], rgbRaster[i * 3 + 1]);
    assert.equal(rgbDecoded.data[i * 4 + 2], rgbRaster[i * 3 + 2]);
    assert.equal(rgbDecoded.data[i * 4 + 3], 255);
  }

  const grayRaster = Buffer.alloc(width * height);
  for (let i = 0; i < grayRaster.length; i++) grayRaster[i] = (i * 29 + 3) % 256;
  const grayPng = buildFilteredPng(width, height, 1, 0, grayRaster, () => 4); // Paeth throughout
  const grayDecoded = decodePng(grayPng);
  assert.equal(grayDecoded.ok, true);
  for (let i = 0; i < width * height; i++) {
    assert.equal(grayDecoded.data[i * 4], grayRaster[i]);
    assert.equal(grayDecoded.data[i * 4 + 1], grayRaster[i]);
    assert.equal(grayDecoded.data[i * 4 + 2], grayRaster[i]);
    assert.equal(grayDecoded.data[i * 4 + 3], 255);
  }

  const grayAlphaRaster = Buffer.alloc(width * height * 2);
  for (let i = 0; i < grayAlphaRaster.length; i++) grayAlphaRaster[i] = (i * 61 + 5) % 256;
  const grayAlphaPng = buildFilteredPng(width, height, 2, 4, grayAlphaRaster, () => 3); // Average throughout
  const grayAlphaDecoded = decodePng(grayAlphaPng);
  assert.equal(grayAlphaDecoded.ok, true);
  for (let i = 0; i < width * height; i++) {
    assert.equal(grayAlphaDecoded.data[i * 4], grayAlphaRaster[i * 2]);
    assert.equal(grayAlphaDecoded.data[i * 4 + 3], grayAlphaRaster[i * 2 + 1]);
  }
}

// --- decode: unsupported formats fail closed instead of misreading bytes ---
{
  const width = 2, height = 2;
  const paletteIhdr = Buffer.alloc(13);
  paletteIhdr.writeUInt32BE(width, 0); paletteIhdr.writeUInt32BE(height, 4);
  paletteIhdr[8] = 8; paletteIhdr[9] = 3; paletteIhdr[10] = 0; paletteIhdr[11] = 0; paletteIhdr[12] = 0;
  const palettePng = Buffer.concat([SIG, pngChunk('IHDR', paletteIhdr), pngChunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), pngChunk('IEND', Buffer.alloc(0))]);
  assert.equal(decodePng(palettePng).code, 'PNG_UNSUPPORTED_COLOR_TYPE');

  const interlacedIhdr = Buffer.alloc(13);
  interlacedIhdr.writeUInt32BE(width, 0); interlacedIhdr.writeUInt32BE(height, 4);
  interlacedIhdr[8] = 8; interlacedIhdr[9] = 6; interlacedIhdr[10] = 0; interlacedIhdr[11] = 0; interlacedIhdr[12] = 1;
  const interlacedPng = Buffer.concat([SIG, pngChunk('IHDR', interlacedIhdr), pngChunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), pngChunk('IEND', Buffer.alloc(0))]);
  assert.equal(decodePng(interlacedPng).code, 'PNG_UNSUPPORTED_INTERLACE');

  const bitDepth16Ihdr = Buffer.alloc(13);
  bitDepth16Ihdr.writeUInt32BE(width, 0); bitDepth16Ihdr.writeUInt32BE(height, 4);
  bitDepth16Ihdr[8] = 16; bitDepth16Ihdr[9] = 6; bitDepth16Ihdr[10] = 0; bitDepth16Ihdr[11] = 0; bitDepth16Ihdr[12] = 0;
  const bitDepth16Png = Buffer.concat([SIG, pngChunk('IHDR', bitDepth16Ihdr), pngChunk('IDAT', deflateSync(Buffer.alloc((width * 8 + 1) * height))), pngChunk('IEND', Buffer.alloc(0))]);
  assert.equal(decodePng(bitDepth16Png).code, 'PNG_UNSUPPORTED_BIT_DEPTH');
}

// --- decode failure modes ---
{
  assert.equal(decodePng(Buffer.from('not a png')).code, 'PNG_SIGNATURE_INVALID');
  assert.equal(decodePng(Buffer.alloc(0)).code, 'PNG_SIGNATURE_INVALID');
}

// --- compareDecoded: identical images ---
{
  const width = 5, height = 5;
  const data = solidRGBA(width, height, [100, 120, 140, 255]);
  const a = { width, height, data };
  const b = { width, height, data: Buffer.from(data) };
  const result = compareDecoded(a, b, { pixelDeltaThreshold: 0, maxChangedRatio: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.changedPixelCount, 0);
  assert.equal(result.changedRatio, 0);
  assert.equal(result.meanAbsoluteChannelDelta, 0);
  assert.equal(result.withinThreshold, true);
}

// --- compareDecoded: partial change, threshold boundary ---
{
  const width = 10, height = 10; // 100 pixels
  const base = solidRGBA(width, height, [50, 50, 50, 255]);
  const changed = withChangedPixels(base, 5, 40); // 5/100 = 0.05 changed ratio at threshold>0
  const a = { width, height, data: base };
  const b = { width, height, data: changed };

  const withinBoundary = compareDecoded(a, b, { pixelDeltaThreshold: 10, maxChangedRatio: 0.05 });
  assert.equal(withinBoundary.changedPixelCount, 5);
  assert.equal(withinBoundary.changedRatio, 0.05);
  assert.equal(withinBoundary.withinThreshold, true);

  const exceeds = compareDecoded(a, b, { pixelDeltaThreshold: 10, maxChangedRatio: 0.01 });
  assert.equal(exceeds.withinThreshold, false);

  const noPixelCounted = compareDecoded(a, b, { pixelDeltaThreshold: 100, maxChangedRatio: 0 });
  assert.equal(noPixelCounted.changedPixelCount, 0);
}

// --- compareDecoded: dimension mismatch ---
{
  const a = { width: 4, height: 4, data: solidRGBA(4, 4, [1, 1, 1, 255]) };
  const b = { width: 5, height: 4, data: solidRGBA(5, 4, [1, 1, 1, 255]) };
  const result = compareDecoded(a, b, { pixelDeltaThreshold: 0, maxChangedRatio: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMAGE_DIMENSIONS_MISMATCH');
}

// --- runVisualDiff: direct-path mode, end to end, fs-backed ---
const root = mkdtempSync(join(tmpdir(), 'visual-diff-engine-'));
try {
  const baselinePath = join(root, 'baseline.png');
  const actualMatchPath = join(root, 'actual-match.png');
  const actualDriftPath = join(root, 'actual-drift.png');
  const actualDimMismatchPath = join(root, 'actual-dim.png');
  const width = 200, height = 200;
  const baseData = solidRGBA(width, height, [200, 100, 50, 255]);
  writeFileSync(baselinePath, encodeSyntheticPng({ width, height, data: baseData }));
  writeFileSync(actualMatchPath, encodeSyntheticPng({ width, height, data: Buffer.from(baseData) }));
  writeFileSync(actualDriftPath, encodeSyntheticPng({ width, height, data: withChangedPixels(baseData, width * height, 60) }));
  writeFileSync(actualDimMismatchPath, encodeSyntheticPng({ width: width + 1, height, data: solidRGBA(width + 1, height, [200, 100, 50, 255]) }));

  const pass = runWithState({ baselinePath, actualPath: actualMatchPath, pixelDeltaThreshold: 5, maxChangedRatio: 0 });
  assert.equal(pass.result, 'PASS');
  assert.equal(pass.code, 'VISUAL_DIFF_WITHIN_THRESHOLD');
  assert.equal(pass.baseline.sha256.length, 64);
  assert.equal(pass.actual.sha256.length, 64);
  assert.equal(pass.changedPixelCount, 0);
  assert.match(pass.evidenceId, /^[0-9a-f]{64}$/);
  assert.equal(pass.stateId, STATE);
  assert.deepEqual(verifyVisualDiffEvidence(pass, STATE), { ok: true, code: 'VISUAL_DIFF_RECEIPT_VALID', evidenceId: pass.evidenceId });
  assert.equal(verifyVisualDiffEvidence({ ...pass, changedPixelCount: 1 }, STATE).code, 'VISUAL_DIFF_RECEIPT_INCONSISTENT');
  assert.equal(verifyVisualDiffEvidence(pass, 'git:' + 'b'.repeat(40)).code, 'VISUAL_DIFF_STATE_MISMATCH');

  const fail = runWithState({ baselinePath, actualPath: actualDriftPath, pixelDeltaThreshold: 5, maxChangedRatio: 0.1 });
  assert.equal(fail.result, 'FAIL');
  assert.equal(fail.code, 'VISUAL_DIFF_EXCEEDS_THRESHOLD');
  assert.equal(fail.changedPixelCount, width * height);

  const dimMismatch = runWithState({ baselinePath, actualPath: actualDimMismatchPath, pixelDeltaThreshold: 0, maxChangedRatio: 0 });
  assert.equal(dimMismatch.result, 'STOP');
  assert.equal(dimMismatch.code, 'IMAGE_DIMENSIONS_MISMATCH');

  const missingBaseline = runWithState({ baselinePath: join(root, 'nope.png'), actualPath: actualMatchPath, pixelDeltaThreshold: 0, maxChangedRatio: 0 });
  assert.equal(missingBaseline.code, 'REFERENCE_IMAGE_MISSING');

  const missingActual = runWithState({ baselinePath, actualPath: join(root, 'nope.png'), pixelDeltaThreshold: 0, maxChangedRatio: 0 });
  assert.equal(missingActual.code, 'ACTUAL_IMAGE_MISSING');

  const viewportMismatch = runWithState({
    baselinePath, actualPath: actualMatchPath, pixelDeltaThreshold: 0, maxChangedRatio: 0,
    expectedViewport: { width: 200, height: 200 }, actualViewport: { width: 201, height: 200 },
  });
  assert.equal(viewportMismatch.code, 'VIEWPORT_MISMATCH');

  const viewportRequired = runWithState({
    baselinePath, actualPath: actualMatchPath, pixelDeltaThreshold: 0, maxChangedRatio: 0,
    expectedViewport: { width: 200, height: 200 }, actualViewport: null,
  });
  assert.equal(viewportRequired.code, 'VIEWPORT_REQUIRED');

  const viewportMatched = runWithState({
    baselinePath, actualPath: actualMatchPath, pixelDeltaThreshold: 0, maxChangedRatio: 0,
    expectedViewport: { width: 200, height: 200 }, actualViewport: { width: 200, height: 200 },
  });
  assert.equal(viewportMatched.result, 'PASS');
  assert.equal(viewportMatched.viewportCheck, 'MATCHED');

  // --- registry mode: resolve baseline + expected viewport from docs/ui-reference/CURRENT.json ---
  mkdirSync(join(root, 'docs', 'ui-reference', 'current'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ui-reference', 'current', 'home.png'), encodeSyntheticPng({ width, height, data: baseData }));
  writeFileSync(join(root, 'docs', 'ui-reference', 'CURRENT.json'), JSON.stringify({
    schemaVersion: 1,
    references: [{
      artifactId: 'home-ui-v1', viewId: 'home', image: 'docs/ui-reference/current/home.png', approvedAt: '2026-09-21',
      viewport: { width: 200, height: 200 }, browserZoom: 100, devicePixelRatio: 1, browser: 'Chrome', fontFamily: 'Arial',
    }],
  }, null, 2));

  const resolved = resolveRegistryBaseline(root, 'home');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.baselinePath, join(root, 'docs', 'ui-reference', 'current', 'home.png'));
  assert.deepEqual(resolved.expectedViewport, { width: 200, height: 200 });

  assert.equal(resolveRegistryBaseline(root, 'missing-view').code, 'REFERENCE_ENTRY_NOT_FOUND');

  const registryRoot = mkdtempSync(join(tmpdir(), 'visual-diff-engine-noreg-'));
  assert.equal(resolveRegistryBaseline(registryRoot, 'home').code, 'UI_REFERENCE_REGISTRY_MISSING');
  rmSync(registryRoot, { recursive: true, force: true });

  // --- CLI: threshold required (fail closed on unconfigured comparison) ---
  const engine = fileURLToPath(new URL('./visual-diff-engine.mjs', import.meta.url));
  const cliMissingThreshold = spawnSync('node', [engine, '--baseline', baselinePath, '--actual', actualMatchPath, '--state-id', STATE], { encoding: 'utf8' });
  assert.equal(cliMissingThreshold.status, 2);
  assert.equal(JSON.parse(cliMissingThreshold.stdout).code, 'THRESHOLD_REQUIRED');

  const cliPass = spawnSync('node', [engine, '--baseline', baselinePath, '--actual', actualMatchPath, '--pixel-delta-threshold', '0', '--max-changed-ratio', '0', '--state-id', STATE], { encoding: 'utf8' });
  assert.equal(cliPass.status, 0);
  assert.equal(JSON.parse(cliPass.stdout).result, 'PASS');

  const cliBothModes = spawnSync('node', [engine, '--baseline', baselinePath, '--root', root, '--view-id', 'home', '--actual', actualMatchPath, '--pixel-delta-threshold', '0', '--max-changed-ratio', '0', '--state-id', STATE], { encoding: 'utf8' });
  assert.equal(cliBothModes.status, 2);
  assert.equal(JSON.parse(cliBothModes.stdout).code, 'VISUAL_DIFF_ENGINE_ERROR');

  const cliRegistry = spawnSync('node', [engine, '--root', root, '--view-id', 'home', '--actual', actualMatchPath, '--pixel-delta-threshold', '0', '--max-changed-ratio', '0', '--actual-viewport', '200x200', '--state-id', STATE], { encoding: 'utf8' });
  assert.equal(cliRegistry.status, 0);
  const registryOut = JSON.parse(cliRegistry.stdout);
  assert.equal(registryOut.result, 'PASS');
  assert.equal(registryOut.viewportCheck, 'MATCHED');

  const cliRegistryNoViewport = spawnSync('node', [engine, '--root', root, '--view-id', 'home', '--actual', actualMatchPath, '--pixel-delta-threshold', '0', '--max-changed-ratio', '0', '--state-id', STATE], { encoding: 'utf8' });
  assert.equal(cliRegistryNoViewport.status, 2);
  assert.equal(JSON.parse(cliRegistryNoViewport.stdout).code, 'VIEWPORT_REQUIRED');

  console.log('visual-diff-engine selftest: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
