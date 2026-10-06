import assert from 'node:assert/strict';
import { evaluate as evaluateReality } from './staged-reality-gate.mjs';
import { evaluate, verifyHumanVisualReviewReceipt } from './human-visual-review-gate.mjs';

const G = 'git:' + 'a'.repeat(40);
const identity = {
  repositoryExpected: 'acme/app',
  repositoryObserved: 'acme/app',
  projectContextExpected: 'app-v1',
  projectContextObserved: 'app-v1',
  workTargetExpected: 'screen-a',
  workTargetObserved: 'screen-a',
  executionSurfaceExpected: 'tauri-dev',
  executionSurfaceObserved: 'tauri-dev',
};
const authority = { state: 'CURRENT', source: 'REPO_LOCAL', reference: 'PROJECT_CONTEXT.json#screen-a' };
const actors = { implementerId: 'impl', judgeId: 'judge' };
const ev = kind => ({ kind, status: 'PASS', source: 'local', reference: 'selftest:' + kind, stateId: G });
const cleanup = {
  schemaVersion: 1,
  receiptType: 'UI_BROWSER_CLEANUP_V1',
  result: 'PASS',
  code: 'BROWSER_CLEANUP_OK',
  runId: 'run-1',
  stateId: G,
  ownershipValidated: true,
  rootPidGone: true,
  childProcessesGone: true,
  cdpPortReleased: true,
  profileLocksGone: true,
};
const finalReality = evaluateReality({
  schemaVersion: 2,
  phase: 'FINAL_REALITY_CHECK',
  taskTypes: ['UI'],
  stateId: G,
  identity,
  authority,
  actors,
  checkpoint: { scopeMatch: true, structureMatch: true, implementationComplete: true, deliverableMatch: true },
  evidence: [
    ev('GIT_STATE'),
    ev('DIFF'),
    ev('SCREENSHOT'),
    { kind: 'UI_BROWSER_CLEANUP', status: 'PASS', source: 'local', reference: 'cleanup', stateId: G, receipt: cleanup },
    ev('TEST_GATE_RESULT'),
  ],
});
assert.equal(finalReality.result, 'PASS');

const metric = (clientWidth, clientHeight, scrollWidth = clientWidth, scrollHeight = clientHeight) => ({
  clientWidth, clientHeight, scrollWidth, scrollHeight,
});
const region = (id, left, top, width, height, overrides = {}) => ({
  id,
  rect: { left, top, right: left + width, bottom: top + height, width, height },
  visibility: { visibleWidth: width, visibleHeight: height },
  scroll: metric(width, height),
  internalScrollAllowed: false,
  ...overrides,
});
function base(overrides = {}) {
  return {
    schemaVersion: 1,
    stateId: G,
    generatedAt: new Date().toISOString(),
    stagedRealityReceipt: finalReality,
    expectedSurface: 'tauri',
    observedSurface: 'tauri',
    environment: 'dev',
    runtime: {
      applicationSurfaceConfirmed: true,
      bypassesDeclaredApplicationRuntime: false,
      projectIdentityConfirmed: true,
      worktreeProvenanceConfirmed: true,
      nonProductionDataConfirmed: true,
      windowVisible: true,
      windowForeground: true,
      sameWindowMeasuredAndPresented: true,
      hostProcessId: 4242,
      hostProcessName: 'acme-app.exe',
      measurementWindowId: 'hwnd:1234',
      presentationWindowId: 'hwnd:1234',
    },
    viewport: { width: 1298, height: 761, devicePixelRatio: 1.5 },
    layout: {
      root: metric(1298, 761),
      screen: metric(1110, 697),
      pageOverflowAllowed: false,
    },
    requiredRegions: [
      region('hero', 10, 10, 1090, 72),
      region('list', 10, 190, 720, 450, {
        scroll: metric(720, 450, 720, 670),
        internalScrollAllowed: true,
      }),
      region('detail', 742, 190, 358, 450),
    ],
    presentationEvidenceRef: 'device-proof.json#window',
    ...overrides,
  };
}

let result = evaluate(base());
assert.equal(result.result, 'PASS');
assert.equal(result.code, 'HUMAN_VISUAL_REVIEW_READY');
assert.match(result.receiptId, /^[0-9a-f]{64}$/);
assert.equal(result.requiredRegions.find(x => x.id === 'list').overflowY, 220);
assert.equal(verifyHumanVisualReviewReceipt(result, G).ok, true);

result = evaluate(base({ observedSurface: 'web-browser' }));
assert.equal(result.code, 'APPLICATION_SURFACE_MISMATCH');

result = evaluate(base({ runtime: { ...base().runtime, bypassesDeclaredApplicationRuntime: true } }));
assert.equal(result.code, 'APPLICATION_RUNTIME_BYPASS_DETECTED');

result = evaluate(base({ runtime: { ...base().runtime, windowForeground: false } }));
assert.equal(result.code, 'RUNTIME_EVIDENCE_NOT_PROVEN');

result = evaluate(base({ runtime: { ...base().runtime, presentationWindowId: 'hwnd:9999' } }));
assert.equal(result.code, 'MEASURED_PRESENTED_WINDOW_MISMATCH');

result = evaluate(base({ runtime: { ...base().runtime, hostProcessName: 'chrome.exe' } }));
assert.equal(result.code, 'TAURI_HOST_PROCESS_INVALID');

result = evaluate(base({ environment: 'production' }));
assert.equal(result.code, 'NON_PRODUCTION_ENVIRONMENT_REQUIRED');

result = evaluate(base({ generatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }));
assert.equal(result.code, 'PRESENTATION_EVIDENCE_STALE');

result = evaluate(base({ generatedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() }));
assert.equal(result.code, 'PRESENTATION_TIMESTAMP_IN_FUTURE');

result = evaluate(base({
  layout: {
    ...base().layout,
    screen: metric(1110, 697, 1119, 697),
  },
}));
assert.equal(result.code, 'PAGE_OR_SCREEN_OVERFLOW_DETECTED');

result = evaluate(base({
  layout: {
    root: metric(1298, 761, 1298, 811),
    screen: metric(1110, 697),
    pageOverflowAllowed: true,
    pageOverflowPolicyRef: 'canonical#page-scroll-allowed',
  },
}));
assert.equal(result.result, 'PASS');

result = evaluate(base({
  requiredRegions: [
    region('hero', 10, 10, 1090, 72),
    region('detail', 1050, 190, 358, 450),
  ],
}));
assert.equal(result.code, 'REQUIRED_REGION_CLIPPED_OR_OUT_OF_VIEWPORT');
assert.equal(result.boundsWithinViewport, false);

result = evaluate(base({
  requiredRegions: [
    region('detail', 742, 190, 358, 450, {
      visibility: { visibleWidth: 310, visibleHeight: 450 },
    }),
  ],
}));
assert.equal(result.code, 'REQUIRED_REGION_CLIPPED_OR_OUT_OF_VIEWPORT');
assert.equal(result.clipped, true);

result = evaluate(base({
  requiredRegions: [
    region('list', 10, 190, 720, 450, {
      scroll: metric(720, 450, 720, 460),
      internalScrollAllowed: false,
    }),
  ],
}));
assert.equal(result.code, 'REQUIRED_REGION_UNEXPECTED_OVERFLOW');

result = evaluate(base({
  requiredRegions: [
    region('bad-metric', 0, 0, 200, 100, {
      rect: { left: 0, top: 0, right: 190, bottom: 100, width: 200, height: 100 },
    }),
  ],
}));
assert.equal(result.code, 'REQUIRED_REGION_MEASUREMENT_INVALID');

const staleReality = { ...finalReality, stateId: 'git:' + 'b'.repeat(40) };
result = evaluate(base({ stagedRealityReceipt: staleReality }));
assert.equal(result.code, 'FINAL_REALITY_RECEIPT_INVALID');

const structurallyInvalidReady = { ...evaluate(base()), requiredRegions: [{ id: 'broken' }] };
assert.equal(verifyHumanVisualReviewReceipt(structurallyInvalidReady, G).code, 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID');

const expiredReady = { ...evaluate(base()), generatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
assert.equal(verifyHumanVisualReviewReceipt(expiredReady, G).code, 'HUMAN_VISUAL_REVIEW_RECEIPT_EXPIRED');

const invalidRuntimeReady = { ...evaluate(base()) };
invalidRuntimeReady.runtime = { ...invalidRuntimeReady.runtime, windowForeground: false };
assert.equal(verifyHumanVisualReviewReceipt(invalidRuntimeReady, G).code, 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID');

const hashTamperedReady = { ...evaluate(base()), presentationEvidenceRef: 'device-proof.json#other-window' };
assert.equal(verifyHumanVisualReviewReceipt(hashTamperedReady, G).code, 'HUMAN_VISUAL_REVIEW_RECEIPT_TAMPERED');

console.log('human-visual-review-gate selftest: PASS');
