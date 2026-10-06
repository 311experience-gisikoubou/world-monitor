#!/usr/bin/env node
import { createHash } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifyStagedRealityReceipt } from './staged-reality-gate.mjs';

const MAX_INPUT_BYTES = 64 * 1024;
const STATE_ID_RE = /^(?:git|remote):[0-9a-f]{40}$|^(?:worktree|artifact):[0-9a-f]{64}$/;
const SURFACES = new Set(['tauri', 'native-app', 'desktop-app', 'electron', 'web-browser', 'web-app', 'mobile-app']);
const NON_PRODUCTION_ENVS = new Set(['dev', 'development', 'local-dev', 'test', 'staging', 'demo', 'preview']);
const BROWSER_PROCESS_RE = /^(?:chrome|chrome\.exe|msedge|msedge\.exe|firefox|firefox\.exe)$/iu;
const PX_TOLERANCE = 0.5;
const MAX_REVIEW_AGE_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

function bounded(value, max = 1000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function stop(code, extra = {}) {
  return { schemaVersion: 1, result: 'STOP', code, ...extra };
}
function finite(value) {
  return Number.isFinite(value);
}
function positive(value) {
  return finite(value) && value > 0;
}
function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}
function reviewTimestamp(value, now = Date.now()) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return { ok: false, code: 'PRESENTATION_TIMESTAMP_INVALID' };
  if (now - timestamp > MAX_REVIEW_AGE_MS) return { ok: false, code: 'PRESENTATION_EVIDENCE_STALE' };
  if (timestamp - now > MAX_FUTURE_SKEW_MS) return { ok: false, code: 'PRESENTATION_TIMESTAMP_IN_FUTURE' };
  return { ok: true, timestamp };
}
function metricBox(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    positive(value.clientWidth) && positive(value.clientHeight) &&
    positive(value.scrollWidth) && positive(value.scrollHeight);
}
function overflowFor(value) {
  return {
    x: Math.max(0, value.scrollWidth - value.clientWidth),
    y: Math.max(0, value.scrollHeight - value.clientHeight),
  };
}
function rectValid(rect) {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return false;
  const keys = ['left', 'top', 'right', 'bottom', 'width', 'height'];
  if (keys.some(key => !finite(rect[key]))) return false;
  if (!positive(rect.width) || !positive(rect.height)) return false;
  return Math.abs((rect.right - rect.left) - rect.width) <= PX_TOLERANCE &&
    Math.abs((rect.bottom - rect.top) - rect.height) <= PX_TOLERANCE;
}
function visibilityValid(visibility) {
  return visibility && typeof visibility === 'object' && !Array.isArray(visibility) &&
    finite(visibility.visibleWidth) && visibility.visibleWidth >= 0 &&
    finite(visibility.visibleHeight) && visibility.visibleHeight >= 0;
}
function fullyInsideViewport(rect, viewport) {
  return rect.left >= -PX_TOLERANCE &&
    rect.top >= -PX_TOLERANCE &&
    rect.right <= viewport.width + PX_TOLERANCE &&
    rect.bottom <= viewport.height + PX_TOLERANCE;
}
function fullyVisible(rect, visibility) {
  return visibility.visibleWidth + PX_TOLERANCE >= rect.width &&
    visibility.visibleHeight + PX_TOLERANCE >= rect.height;
}
function receiptCore(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    receiptType: receipt.receiptType,
    result: receipt.result,
    code: receipt.code,
    stateId: receipt.stateId,
    generatedAt: receipt.generatedAt,
    stagedRealityReceiptId: receipt.stagedRealityReceiptId,
    expectedSurface: receipt.expectedSurface,
    observedSurface: receipt.observedSurface,
    environment: receipt.environment,
    runtime: receipt.runtime,
    viewport: receipt.viewport,
    layout: receipt.layout,
    requiredRegions: receipt.requiredRegions,
    presentationEvidenceRef: receipt.presentationEvidenceRef,
  };
}
export function verifyHumanVisualReviewReceipt(receipt, expectedStateId = '') {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
  const timestampCheck = reviewTimestamp(receipt.generatedAt);
  if (!timestampCheck.ok) {
    return {
      ok: false,
      code: timestampCheck.code === 'PRESENTATION_EVIDENCE_STALE'
        ? 'HUMAN_VISUAL_REVIEW_RECEIPT_EXPIRED'
        : 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID',
      reason: timestampCheck.code,
    };
  }
  if (receipt.schemaVersion !== 1 || receipt.receiptType !== 'HUMAN_VISUAL_REVIEW_READY_V1' ||
      receipt.result !== 'PASS' || receipt.code !== 'HUMAN_VISUAL_REVIEW_READY' ||
      !STATE_ID_RE.test(receipt.stateId || '') ||
      !SURFACES.has(receipt.expectedSurface) || receipt.expectedSurface !== receipt.observedSurface ||
      !NON_PRODUCTION_ENVS.has(receipt.environment) ||
      !receipt.runtime || typeof receipt.runtime !== 'object' || Array.isArray(receipt.runtime) ||
      receipt.runtime.applicationSurfaceConfirmed !== true ||
      receipt.runtime.bypassesDeclaredApplicationRuntime !== false ||
      receipt.runtime.projectIdentityConfirmed !== true ||
      receipt.runtime.worktreeProvenanceConfirmed !== true ||
      receipt.runtime.nonProductionDataConfirmed !== true ||
      receipt.runtime.windowVisible !== true || receipt.runtime.windowForeground !== true ||
      receipt.runtime.sameWindowMeasuredAndPresented !== true ||
      !positiveInteger(receipt.runtime.hostProcessId) || !bounded(receipt.runtime.hostProcessName, 160) ||
      !bounded(receipt.runtime.measurementWindowId, 240) ||
      receipt.runtime.measurementWindowId !== receipt.runtime.presentationWindowId ||
      !receipt.viewport || !positiveInteger(receipt.viewport.width) || !positiveInteger(receipt.viewport.height) ||
      !positive(receipt.viewport.devicePixelRatio) ||
      !receipt.layout || typeof receipt.layout !== 'object' || Array.isArray(receipt.layout) ||
      !finite(receipt.layout.rootOverflowX) || receipt.layout.rootOverflowX < 0 ||
      !finite(receipt.layout.rootOverflowY) || receipt.layout.rootOverflowY < 0 ||
      !finite(receipt.layout.screenOverflowX) || receipt.layout.screenOverflowX < 0 ||
      !finite(receipt.layout.screenOverflowY) || receipt.layout.screenOverflowY < 0 ||
      typeof receipt.layout.pageOverflowAllowed !== 'boolean' ||
      !Array.isArray(receipt.requiredRegions) || receipt.requiredRegions.length === 0 ||
      !bounded(receipt.presentationEvidenceRef, 2000)) {
    return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
  }
  if (receipt.expectedSurface === 'tauri' && BROWSER_PROCESS_RE.test(receipt.runtime.hostProcessName.trim())) {
    return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
  }
  const receiptPageOverflow = receipt.layout.rootOverflowX > PX_TOLERANCE ||
    receipt.layout.rootOverflowY > PX_TOLERANCE ||
    receipt.layout.screenOverflowX > PX_TOLERANCE ||
    receipt.layout.screenOverflowY > PX_TOLERANCE;
  if (receiptPageOverflow && !receipt.layout.pageOverflowAllowed) {
    return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
  }
  if (receiptPageOverflow && receipt.layout.pageOverflowAllowed &&
      !bounded(receipt.layout.pageOverflowPolicyRef, 1000)) {
    return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
  }
  for (const region of receipt.requiredRegions) {
    if (!region || typeof region !== 'object' || !bounded(region.id, 160) || !rectValid(region.rect) ||
        !finite(region.visibleWidth) || region.visibleWidth < 0 ||
        !finite(region.visibleHeight) || region.visibleHeight < 0 ||
        region.boundsWithinViewport !== true || region.clipped !== false ||
        !finite(region.overflowX) || region.overflowX < 0 ||
        !finite(region.overflowY) || region.overflowY < 0 ||
        typeof region.internalScrollAllowed !== 'boolean') {
      return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
    }
    if (!fullyInsideViewport(region.rect, receipt.viewport) ||
        region.visibleWidth + PX_TOLERANCE < region.rect.width ||
        region.visibleHeight + PX_TOLERANCE < region.rect.height) {
      return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
    }
    if ((region.overflowX > PX_TOLERANCE || region.overflowY > PX_TOLERANCE) && !region.internalScrollAllowed) {
      return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID' };
    }
  }
  if (expectedStateId && receipt.stateId !== expectedStateId) return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_STALE' };
  const expectedId = createHash('sha256').update(JSON.stringify(receiptCore(receipt))).digest('hex');
  if (receipt.receiptId !== expectedId) return { ok: false, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_TAMPERED' };
  return { ok: true, code: 'HUMAN_VISUAL_REVIEW_RECEIPT_VALID', receiptId: receipt.receiptId };
}
export function evaluate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1) return stop('INPUT_INVALID');
  if (!STATE_ID_RE.test(input.stateId || '')) return stop('STATE_ID_INVALID');
  const timestampCheck = reviewTimestamp(input.generatedAt);
  if (!timestampCheck.ok) return stop(timestampCheck.code);

  const staged = verifyStagedRealityReceipt(input.stagedRealityReceipt, input.stateId, { requireFinal: true, requireUi: true });
  if (!staged.ok) return stop('FINAL_REALITY_RECEIPT_INVALID', { reason: staged.code });

  if (!SURFACES.has(input.expectedSurface) || !SURFACES.has(input.observedSurface)) return stop('APPLICATION_SURFACE_INVALID');
  if (input.expectedSurface !== input.observedSurface) {
    return stop('APPLICATION_SURFACE_MISMATCH', { expectedSurface: input.expectedSurface, observedSurface: input.observedSurface });
  }

  const runtime = input.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return stop('RUNTIME_EVIDENCE_INVALID');
  const requiredRuntimeTrue = [
    'applicationSurfaceConfirmed',
    'projectIdentityConfirmed',
    'worktreeProvenanceConfirmed',
    'nonProductionDataConfirmed',
    'windowVisible',
    'windowForeground',
    'sameWindowMeasuredAndPresented',
  ];
  const falseRuntime = requiredRuntimeTrue.filter(key => runtime[key] !== true);
  if (falseRuntime.length) return stop('RUNTIME_EVIDENCE_NOT_PROVEN', { missingOrFalse: falseRuntime });
  if (runtime.bypassesDeclaredApplicationRuntime !== false) return stop('APPLICATION_RUNTIME_BYPASS_DETECTED');
  if (!positiveInteger(runtime.hostProcessId) || !bounded(runtime.hostProcessName, 160) ||
      !bounded(runtime.measurementWindowId, 240) || !bounded(runtime.presentationWindowId, 240)) {
    return stop('RUNTIME_IDENTITY_INVALID');
  }
  if (runtime.measurementWindowId !== runtime.presentationWindowId) {
    return stop('MEASURED_PRESENTED_WINDOW_MISMATCH', {
      measurementWindowId: runtime.measurementWindowId,
      presentationWindowId: runtime.presentationWindowId,
    });
  }
  if (input.expectedSurface === 'tauri' && BROWSER_PROCESS_RE.test(runtime.hostProcessName.trim())) {
    return stop('TAURI_HOST_PROCESS_INVALID', { hostProcessName: runtime.hostProcessName });
  }

  if (!NON_PRODUCTION_ENVS.has(input.environment)) return stop('NON_PRODUCTION_ENVIRONMENT_REQUIRED');

  const viewport = input.viewport;
  if (!viewport || typeof viewport !== 'object' || !positiveInteger(viewport.width) || !positiveInteger(viewport.height) ||
      !Number.isFinite(viewport.devicePixelRatio) || viewport.devicePixelRatio <= 0) {
    return stop('VIEWPORT_INVALID');
  }

  const layout = input.layout;
  if (!layout || typeof layout !== 'object' || Array.isArray(layout) ||
      !metricBox(layout.root) || !metricBox(layout.screen) ||
      typeof layout.pageOverflowAllowed !== 'boolean') {
    return stop('LAYOUT_EVIDENCE_INVALID');
  }
  const rootOverflow = overflowFor(layout.root);
  const screenOverflow = overflowFor(layout.screen);
  const pageOverflow = rootOverflow.x > PX_TOLERANCE || rootOverflow.y > PX_TOLERANCE ||
    screenOverflow.x > PX_TOLERANCE || screenOverflow.y > PX_TOLERANCE;
  if (pageOverflow && !layout.pageOverflowAllowed) {
    return stop('PAGE_OR_SCREEN_OVERFLOW_DETECTED', {
      rootOverflowX: rootOverflow.x,
      rootOverflowY: rootOverflow.y,
      screenOverflowX: screenOverflow.x,
      screenOverflowY: screenOverflow.y,
    });
  }
  if (pageOverflow && layout.pageOverflowAllowed && !bounded(layout.pageOverflowPolicyRef, 1000)) {
    return stop('PAGE_OVERFLOW_POLICY_REFERENCE_REQUIRED');
  }

  if (!Array.isArray(input.requiredRegions) || input.requiredRegions.length === 0 || input.requiredRegions.length > 50) {
    return stop('REQUIRED_REGIONS_INVALID');
  }
  const seen = new Set();
  const normalizedRegions = [];
  for (const region of input.requiredRegions) {
    if (!region || typeof region !== 'object' || Array.isArray(region) || !bounded(region.id, 160) || seen.has(region.id)) {
      return stop('REQUIRED_REGIONS_INVALID');
    }
    seen.add(region.id);
    if (!rectValid(region.rect) || !visibilityValid(region.visibility) || !metricBox(region.scroll) ||
        typeof region.internalScrollAllowed !== 'boolean') {
      return stop('REQUIRED_REGION_MEASUREMENT_INVALID', { regionId: region.id });
    }

    const boundsWithinViewport = fullyInsideViewport(region.rect, viewport);
    const clipped = !fullyVisible(region.rect, region.visibility);
    if (!boundsWithinViewport || clipped) {
      return stop('REQUIRED_REGION_CLIPPED_OR_OUT_OF_VIEWPORT', {
        regionId: region.id,
        boundsWithinViewport,
        clipped,
        rect: region.rect,
        viewport: { width: viewport.width, height: viewport.height },
      });
    }

    const overflow = overflowFor(region.scroll);
    if ((overflow.x > PX_TOLERANCE || overflow.y > PX_TOLERANCE) && !region.internalScrollAllowed) {
      return stop('REQUIRED_REGION_UNEXPECTED_OVERFLOW', {
        regionId: region.id,
        overflowX: overflow.x,
        overflowY: overflow.y,
      });
    }
    normalizedRegions.push({
      id: region.id.trim(),
      rect: {
        left: region.rect.left,
        top: region.rect.top,
        right: region.rect.right,
        bottom: region.rect.bottom,
        width: region.rect.width,
        height: region.rect.height,
      },
      visibleWidth: region.visibility.visibleWidth,
      visibleHeight: region.visibility.visibleHeight,
      boundsWithinViewport: true,
      clipped: false,
      overflowX: overflow.x,
      overflowY: overflow.y,
      internalScrollAllowed: region.internalScrollAllowed,
    });
  }

  if (!bounded(input.presentationEvidenceRef, 2000)) return stop('PRESENTATION_EVIDENCE_REFERENCE_REQUIRED');

  const core = {
    schemaVersion: 1,
    receiptType: 'HUMAN_VISUAL_REVIEW_READY_V1',
    result: 'PASS',
    code: 'HUMAN_VISUAL_REVIEW_READY',
    stateId: input.stateId,
    generatedAt: new Date(timestampCheck.timestamp).toISOString(),
    stagedRealityReceiptId: input.stagedRealityReceipt.receiptId,
    expectedSurface: input.expectedSurface,
    observedSurface: input.observedSurface,
    environment: input.environment,
    runtime: {
      applicationSurfaceConfirmed: true,
      bypassesDeclaredApplicationRuntime: false,
      projectIdentityConfirmed: true,
      worktreeProvenanceConfirmed: true,
      nonProductionDataConfirmed: true,
      windowVisible: true,
      windowForeground: true,
      sameWindowMeasuredAndPresented: true,
      hostProcessId: runtime.hostProcessId,
      hostProcessName: runtime.hostProcessName.trim(),
      measurementWindowId: runtime.measurementWindowId.trim(),
      presentationWindowId: runtime.presentationWindowId.trim(),
    },
    viewport: {
      width: viewport.width,
      height: viewport.height,
      devicePixelRatio: viewport.devicePixelRatio,
    },
    layout: {
      rootOverflowX: rootOverflow.x,
      rootOverflowY: rootOverflow.y,
      screenOverflowX: screenOverflow.x,
      screenOverflowY: screenOverflow.y,
      pageOverflowAllowed: layout.pageOverflowAllowed,
      ...(layout.pageOverflowAllowed ? { pageOverflowPolicyRef: layout.pageOverflowPolicyRef.trim() } : {}),
    },
    requiredRegions: normalizedRegions,
    presentationEvidenceRef: input.presentationEvidenceRef.trim(),
  };
  return {
    ...core,
    receiptId: createHash('sha256').update(JSON.stringify(core)).digest('hex'),
    rule: 'Human visual review may start only for the exact measured application window and state. Region bounds and overflow are computed from raw viewport/DOM metrics; caller-asserted pass booleans are not accepted as substitutes.',
  };
}
async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) return { error: 'INPUT_TOO_LARGE' };
    chunks.push(chunk);
  }
  try { return { value: JSON.parse(chunks.join('')) }; }
  catch { return { error: 'INPUT_JSON_INVALID' }; }
}
async function main() {
  const input = await readStdin();
  const result = input.error ? stop(input.error) : evaluate(input.value);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.result === 'PASS' ? 0 : 2;
}
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
