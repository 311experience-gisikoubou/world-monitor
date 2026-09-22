#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizeUiReferenceRegistry, UI_REFERENCE_REGISTRY } from '../handoff/ui-reference-registry.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_DIMENSION = 10000;
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };
const VIEW_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const STATE_ID_RE = /^(?:git|remote):[0-9a-f]{40}$|^(?:worktree|artifact):[0-9a-f]{64}$/u;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(inflated, width, height, bpp) {
  const rowBytes = width * bpp;
  const raster = Buffer.alloc(rowBytes * height);
  let prevRow = Buffer.alloc(rowBytes);
  let srcOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = inflated[srcOffset];
    if (filterType < 0 || filterType > 4) return null;
    srcOffset += 1;
    const rowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = inflated[srcOffset + x];
      const a = x >= bpp ? raster[rowStart + x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      let value;
      if (filterType === 0) value = raw;
      else if (filterType === 1) value = raw + a;
      else if (filterType === 2) value = raw + b;
      else if (filterType === 3) value = raw + ((a + b) >> 1);
      else value = raw + paethPredictor(a, b, c);
      raster[rowStart + x] = value & 0xff;
    }
    srcOffset += rowBytes;
    prevRow = raster.subarray(rowStart, rowStart + rowBytes);
  }
  return raster;
}

function toRGBA(raster, width, height, colorType, channels) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4;
    if (colorType === 6) {
      rgba[o] = raster[p]; rgba[o + 1] = raster[p + 1]; rgba[o + 2] = raster[p + 2]; rgba[o + 3] = raster[p + 3];
    } else if (colorType === 2) {
      rgba[o] = raster[p]; rgba[o + 1] = raster[p + 1]; rgba[o + 2] = raster[p + 2]; rgba[o + 3] = 255;
    } else if (colorType === 4) {
      const g = raster[p]; rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = raster[p + 1];
    } else {
      const g = raster[p]; rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

// Decodes 8-bit, non-interlaced grayscale/RGB/grayscale+alpha/RGBA PNGs (the formats real
// screenshot tools emit) into an RGBA raster. Palette, 16-bit, and interlaced PNGs fail closed
// with a specific code instead of being silently misread.
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    return { ok: false, code: 'PNG_SIGNATURE_INVALID' };
  }
  let offset = 8, ihdr = null;
  const idatChunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8, dataEnd = dataStart + length;
    if (length < 0 || dataEnd + 4 > buffer.length) return { ok: false, code: 'PNG_CHUNK_TRUNCATED' };
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (length !== 13) return { ok: false, code: 'PNG_IHDR_INVALID' };
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8), colorType: data.readUInt8(9), interlace: data.readUInt8(12),
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!ihdr) return { ok: false, code: 'PNG_IHDR_MISSING' };
  if (idatChunks.length === 0) return { ok: false, code: 'PNG_IDAT_MISSING' };
  if (ihdr.bitDepth !== 8) return { ok: false, code: 'PNG_UNSUPPORTED_BIT_DEPTH' };
  if (ihdr.interlace !== 0) return { ok: false, code: 'PNG_UNSUPPORTED_INTERLACE' };
  if (ihdr.width <= 0 || ihdr.height <= 0 || ihdr.width > MAX_DIMENSION || ihdr.height > MAX_DIMENSION) {
    return { ok: false, code: 'PNG_DIMENSIONS_INVALID' };
  }
  const channels = CHANNELS_BY_COLOR_TYPE[ihdr.colorType];
  if (!channels) return { ok: false, code: 'PNG_UNSUPPORTED_COLOR_TYPE' };

  let inflated;
  try { inflated = inflateSync(Buffer.concat(idatChunks)); }
  catch { return { ok: false, code: 'PNG_ZLIB_DECODE_FAILED' }; }

  const rowBytes = ihdr.width * channels;
  if (inflated.length !== (rowBytes + 1) * ihdr.height) return { ok: false, code: 'PNG_DATA_SIZE_MISMATCH' };
  const raster = unfilter(inflated, ihdr.width, ihdr.height, channels);
  if (!raster) return { ok: false, code: 'PNG_FILTER_UNSUPPORTED' };

  return { ok: true, width: ihdr.width, height: ihdr.height, data: toRGBA(raster, ihdr.width, ihdr.height, ihdr.colorType, channels) };
}

// Encodes an RGBA raster as a minimal valid 8-bit non-interlaced PNG. Used to build synthetic,
// non-sensitive fixture images for this engine's own self-test and for consuming projects'
// test suites, without adding an external PNG dependency.
export function encodeSyntheticPng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error('DIMENSIONS_INVALID');
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length !== width * height * 4) throw new Error('DATA_LENGTH_MISMATCH');
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    buf.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, y * rowBytes + rowBytes);
  }
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdrData), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function stop(code, detail = {}) { return { result: 'STOP', code, ...detail }; }

// Pure pixel comparison over two already-decoded RGBA rasters. A pixel counts as "changed" when
// any channel's absolute delta exceeds pixelDeltaThreshold; the caller supplies both thresholds
// explicitly, never a default "pass" value.
export function compareDecoded(baseline, actual, { pixelDeltaThreshold, maxChangedRatio }) {
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return { ok: false, code: 'IMAGE_DIMENSIONS_MISMATCH', baselineWidth: baseline.width, baselineHeight: baseline.height, actualWidth: actual.width, actualHeight: actual.height };
  }
  const totalPixelCount = baseline.width * baseline.height;
  let changedPixelCount = 0, sumAbsDelta = 0;
  for (let i = 0; i < totalPixelCount; i++) {
    const o = i * 4;
    const dr = Math.abs(baseline.data[o] - actual.data[o]);
    const dg = Math.abs(baseline.data[o + 1] - actual.data[o + 1]);
    const db = Math.abs(baseline.data[o + 2] - actual.data[o + 2]);
    const da = Math.abs(baseline.data[o + 3] - actual.data[o + 3]);
    sumAbsDelta += dr + dg + db + da;
    if (Math.max(dr, dg, db, da) > pixelDeltaThreshold) changedPixelCount++;
  }
  const changedRatio = totalPixelCount === 0 ? 0 : changedPixelCount / totalPixelCount;
  const meanAbsoluteChannelDelta = totalPixelCount === 0 ? 0 : sumAbsDelta / (totalPixelCount * 4);
  return { ok: true, totalPixelCount, changedPixelCount, changedRatio, meanAbsoluteChannelDelta, withinThreshold: changedRatio <= maxChangedRatio };
}

export function resolveRegistryBaseline(root, viewId) {
  const registryPath = resolve(root, ...UI_REFERENCE_REGISTRY.split('/'));
  if (!existsSync(registryPath)) return { ok: false, code: 'UI_REFERENCE_REGISTRY_MISSING' };
  let raw;
  try { raw = JSON.parse(readFileSync(registryPath, 'utf8')); }
  catch { return { ok: false, code: 'UI_REFERENCE_REGISTRY_INVALID' }; }
  const normalized = normalizeUiReferenceRegistry(raw);
  if (normalized.error) return { ok: false, code: normalized.error.code };
  const row = normalized.value.references.find(r => r.viewId === viewId);
  if (!row) return { ok: false, code: 'REFERENCE_ENTRY_NOT_FOUND' };
  return { ok: true, baselinePath: resolve(root, ...row.image.split('/')), expectedViewport: row.viewport };
}

// Fail-closed evidence engine: compares a baseline PNG against an actual screenshot PNG and
// reports dimensions, changed pixel count/ratio, mean absolute channel delta, and both files'
// SHA-256. Thresholds are required inputs; there is no built-in "reasonable default" that can
// turn an unconfigured comparison into a silent PASS.
export function runVisualDiff({ baselinePath, actualPath, pixelDeltaThreshold, maxChangedRatio, expectedViewport = null, actualViewport = null, stateId }) {
  if (!STATE_ID_RE.test(stateId || '')) return stop('STATE_ID_INVALID');
  if (!existsSync(baselinePath)) return stop('REFERENCE_IMAGE_MISSING', { baselinePath });
  if (!existsSync(actualPath)) return stop('ACTUAL_IMAGE_MISSING', { actualPath });

  let viewportCheck = 'NOT_REQUESTED';
  if (expectedViewport) {
    if (!actualViewport) return stop('VIEWPORT_REQUIRED', { expectedViewport });
    if (actualViewport.width !== expectedViewport.width || actualViewport.height !== expectedViewport.height) {
      return stop('VIEWPORT_MISMATCH', { expectedViewport, actualViewport });
    }
    viewportCheck = 'MATCHED';
  } else if (actualViewport) {
    viewportCheck = 'NOT_CHECKED_NO_EXPECTED';
  }

  const baselineBuffer = readFileSync(baselinePath);
  const actualBuffer = readFileSync(actualPath);
  if (baselineBuffer.length > MAX_IMAGE_BYTES) return stop('REFERENCE_IMAGE_TOO_LARGE', { baselinePath });
  if (actualBuffer.length > MAX_IMAGE_BYTES) return stop('ACTUAL_IMAGE_TOO_LARGE', { actualPath });

  const baselineSha256 = sha256(baselineBuffer);
  const actualSha256 = sha256(actualBuffer);

  const baselineDecoded = decodePng(baselineBuffer);
  if (!baselineDecoded.ok) return stop(baselineDecoded.code, { side: 'baseline' });
  if (expectedViewport && (baselineDecoded.width !== expectedViewport.width || baselineDecoded.height !== expectedViewport.height)) {
    return stop('REFERENCE_VIEWPORT_MISMATCH', {
      expectedViewport,
      baselineDimensions: { width: baselineDecoded.width, height: baselineDecoded.height },
    });
  }
  const actualDecoded = decodePng(actualBuffer);
  if (!actualDecoded.ok) return stop(actualDecoded.code, { side: 'actual' });

  const compared = compareDecoded(baselineDecoded, actualDecoded, { pixelDeltaThreshold, maxChangedRatio });
  if (!compared.ok) {
    return stop(compared.code, {
      baselineWidth: compared.baselineWidth, baselineHeight: compared.baselineHeight,
      actualWidth: compared.actualWidth, actualHeight: compared.actualHeight,
    });
  }

  const core = {
    schemaVersion: 1,
    evidenceType: 'VISUAL_DIFF_V1',
    stateId,
    baseline: { path: baselinePath, sha256: baselineSha256, width: baselineDecoded.width, height: baselineDecoded.height },
    actual: { path: actualPath, sha256: actualSha256, width: actualDecoded.width, height: actualDecoded.height },
    pixelDeltaThreshold,
    maxChangedRatio,
    totalPixelCount: compared.totalPixelCount,
    changedPixelCount: compared.changedPixelCount,
    changedRatio: compared.changedRatio,
    meanAbsoluteChannelDelta: compared.meanAbsoluteChannelDelta,
    viewportCheck,
    expectedViewport: expectedViewport ?? null,
    actualViewport: actualViewport ?? null,
  };
  const result = compared.withinThreshold ? 'PASS' : 'FAIL';
  const code = result === 'PASS' ? 'VISUAL_DIFF_WITHIN_THRESHOLD' : 'VISUAL_DIFF_EXCEEDS_THRESHOLD';
  const evidenceId = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return { ...core, result, code, evidenceId };
}

export function verifyVisualDiffEvidence(receipt, expectedStateId) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { ok: false, code: 'VISUAL_DIFF_RECEIPT_INVALID' };
  if (!STATE_ID_RE.test(expectedStateId || '') || receipt.stateId !== expectedStateId) return { ok: false, code: 'VISUAL_DIFF_STATE_MISMATCH' };
  if (receipt.schemaVersion !== 1 || receipt.evidenceType !== 'VISUAL_DIFF_V1' || receipt.result !== 'PASS' || receipt.code !== 'VISUAL_DIFF_WITHIN_THRESHOLD') {
    return { ok: false, code: 'VISUAL_DIFF_RECEIPT_NOT_PASS' };
  }
  if (!/^[0-9a-f]{64}$/u.test(receipt.evidenceId || '') || !/^[0-9a-f]{64}$/u.test(receipt.baseline?.sha256 || '') || !/^[0-9a-f]{64}$/u.test(receipt.actual?.sha256 || '')) {
    return { ok: false, code: 'VISUAL_DIFF_RECEIPT_INVALID' };
  }
  if (!Number.isInteger(receipt.pixelDeltaThreshold) || receipt.pixelDeltaThreshold < 0 || receipt.pixelDeltaThreshold > 255 ||
      !Number.isFinite(receipt.maxChangedRatio) || receipt.maxChangedRatio < 0 || receipt.maxChangedRatio > 1 ||
      !Number.isInteger(receipt.totalPixelCount) || receipt.totalPixelCount <= 0 ||
      !Number.isInteger(receipt.changedPixelCount) || receipt.changedPixelCount < 0 || receipt.changedPixelCount > receipt.totalPixelCount ||
      !Number.isFinite(receipt.changedRatio) || !Number.isFinite(receipt.meanAbsoluteChannelDelta)) {
    return { ok: false, code: 'VISUAL_DIFF_RECEIPT_INVALID' };
  }
  const expectedRatio = receipt.changedPixelCount / receipt.totalPixelCount;
  if (Math.abs(expectedRatio - receipt.changedRatio) > Number.EPSILON * 8 || receipt.changedRatio > receipt.maxChangedRatio) {
    return { ok: false, code: 'VISUAL_DIFF_RECEIPT_INCONSISTENT' };
  }
  const { result, code, evidenceId, ...core } = receipt;
  const expectedEvidenceId = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  if (expectedEvidenceId !== evidenceId) return { ok: false, code: 'VISUAL_DIFF_RECEIPT_TAMPERED' };
  return { ok: true, code: 'VISUAL_DIFF_RECEIPT_VALID', evidenceId };
}

function arg(args, name) { const i = args.indexOf(name); if (i < 0) return null; if (!args[i + 1]) throw new Error(name + '_VALUE_REQUIRED'); return args[i + 1]; }
function safeView(v) { return typeof v === 'string' && VIEW_RE.test(v) ? v : null; }
function parseViewportArg(v) {
  const m = String(v).match(/^(\d{1,5})x(\d{1,5})$/u);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width >= 1 && height >= 1 ? { width, height } : null;
}
function emit(result, pretty) {
  console.log(JSON.stringify(result, null, pretty ? 2 : 0));
  process.exitCode = result.result === 'PASS' ? 0 : 2;
}

async function main() {
  const allowed = new Set(['--baseline', '--actual', '--root', '--view-id', '--pixel-delta-threshold', '--max-changed-ratio', '--expected-viewport', '--actual-viewport', '--state-id', '--out', '--pretty']);
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) { if (!allowed.has(args[i])) throw new Error('ARGUMENT_INVALID'); if (args[i] !== '--pretty') i++; }
    const pretty = args.includes('--pretty');

    const baselineArg = arg(args, '--baseline');
    const rootRaw = arg(args, '--root');
    const viewIdRaw = arg(args, '--view-id');
    const actualArg = arg(args, '--actual');
    const stateId = arg(args, '--state-id');
    const outArg = arg(args, '--out');
    if (!actualArg || !STATE_ID_RE.test(stateId || '')) throw new Error('ARGUMENT_INVALID');

    const registryMode = rootRaw !== null || viewIdRaw !== null;
    if (baselineArg && registryMode) throw new Error('ARGUMENT_INVALID');
    if (!baselineArg && !registryMode) throw new Error('ARGUMENT_INVALID');
    if (registryMode && (!rootRaw || !viewIdRaw)) throw new Error('ARGUMENT_INVALID');
    const viewId = registryMode ? safeView(viewIdRaw) : null;
    if (registryMode && !viewId) throw new Error('ARGUMENT_INVALID');

    const pixelDeltaThresholdRaw = arg(args, '--pixel-delta-threshold');
    const maxChangedRatioRaw = arg(args, '--max-changed-ratio');
    if (pixelDeltaThresholdRaw === null || maxChangedRatioRaw === null) return emit(stop('THRESHOLD_REQUIRED'), pretty);
    const pixelDeltaThreshold = Number(pixelDeltaThresholdRaw);
    const maxChangedRatio = Number(maxChangedRatioRaw);
    if (!Number.isInteger(pixelDeltaThreshold) || pixelDeltaThreshold < 0 || pixelDeltaThreshold > 255) return emit(stop('THRESHOLD_INVALID', { field: 'pixelDeltaThreshold' }), pretty);
    if (!Number.isFinite(maxChangedRatio) || maxChangedRatio < 0 || maxChangedRatio > 1) return emit(stop('THRESHOLD_INVALID', { field: 'maxChangedRatio' }), pretty);

    const expectedViewportRaw = arg(args, '--expected-viewport');
    if (registryMode && expectedViewportRaw !== null) throw new Error('ARGUMENT_INVALID');
    let expectedViewport = null;
    if (expectedViewportRaw !== null) {
      expectedViewport = parseViewportArg(expectedViewportRaw);
      if (!expectedViewport) throw new Error('ARGUMENT_INVALID');
    }
    const actualViewportRaw = arg(args, '--actual-viewport');
    let actualViewport = null;
    if (actualViewportRaw !== null) {
      actualViewport = parseViewportArg(actualViewportRaw);
      if (!actualViewport) throw new Error('ARGUMENT_INVALID');
    }

    let baselinePath = baselineArg ? resolve(baselineArg) : null;
    if (registryMode) {
      const resolved = resolveRegistryBaseline(resolve(rootRaw), viewId);
      if (!resolved.ok) return emit(stop(resolved.code), pretty);
      baselinePath = resolved.baselinePath;
      expectedViewport = resolved.expectedViewport;
    }

    const result = runVisualDiff({ baselinePath, actualPath: resolve(actualArg), pixelDeltaThreshold, maxChangedRatio, expectedViewport, actualViewport, stateId });
    if (outArg) writeFileSync(resolve(outArg), JSON.stringify(result, null, 2) + '\n', 'utf8');
    emit(result, pretty);
  } catch (e) {
    emit(stop('VISUAL_DIFF_ENGINE_ERROR', { message: e?.message ?? 'unknown' }), false);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
