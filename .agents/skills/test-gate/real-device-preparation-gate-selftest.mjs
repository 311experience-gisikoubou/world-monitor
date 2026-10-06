import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const gateArg = process.argv[2];
if (!gateArg) throw new Error('gate path required');
const gate = resolve(gateArg);

function run(extra) {
  return spawnSync(process.execPath, [gate, '--json', ...extra], { encoding: 'utf8' });
}
function expectProceed(extra) {
  const r = run(extra);
  if (r.status !== 0 || !r.stdout.includes('"result":"PROCEED"')) {
    throw new Error(`expected PROCEED: ${r.stdout} ${r.stderr}`);
  }
}
function expectStop(extra, code) {
  const r = run(extra);
  if (r.status === 0 || !r.stdout.includes('"result":"STOP"')) {
    throw new Error(`expected STOP: ${r.stdout} ${r.stderr}`);
  }
  if (!r.stdout.includes(code)) throw new Error(`missing ${code}: ${r.stdout}`);
}

const G = 'git:' + 'a'.repeat(40);
const temp = mkdtempSync(join(tmpdir(), 'real-device-prep-selftest-'));
const receiptPath = join(temp, 'human-review.json');
const receiptCore = {
  schemaVersion: 1,
  receiptType: 'HUMAN_VISUAL_REVIEW_READY_V1',
  result: 'PASS',
  code: 'HUMAN_VISUAL_REVIEW_READY',
  stateId: G,
  generatedAt: new Date().toISOString(),
  stagedRealityReceiptId: 'b'.repeat(64),
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
    hostProcessName: 'app.exe',
    measurementWindowId: 'hwnd:1',
    presentationWindowId: 'hwnd:1',
  },
  viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
  layout: {
    rootOverflowX: 0,
    rootOverflowY: 0,
    screenOverflowX: 0,
    screenOverflowY: 0,
    pageOverflowAllowed: false,
  },
  requiredRegions: [
    {
      id: 'screen',
      rect: { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 },
      visibleWidth: 1200,
      visibleHeight: 800,
      boundsWithinViewport: true,
      clipped: false,
      overflowX: 0,
      overflowY: 0,
      internalScrollAllowed: false,
    },
  ],
  presentationEvidenceRef: 'device-proof#window',
};
const receipt = {
  ...receiptCore,
  receiptId: createHash('sha256').update(JSON.stringify(receiptCore)).digest('hex'),
  rule: 'selftest',
};
writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');

const ready = [
  '--manual-verification', 'required',
  '--verification-basis', 'objective',
  '--verification-owner', 'ai-workflow',
  '--sample-data', 'required',
  '--sample-data-prepared', 'yes',
  '--sample-data-preparer', 'ai-workflow',
  '--sample-data-source', 'dev-preload',
  '--approved-test-environment', 'yes',
  '--human-sample-data-entry', 'no',
  '--ui-path-verified', 'yes',
  '--manual-started', 'no',
];

try {
  expectProceed(ready);

  expectProceed([
    '--manual-verification', 'not-required',
    '--verification-basis', 'not-applicable',
    '--verification-owner', 'none',
    '--sample-data', 'not-required',
    '--sample-data-prepared', 'na',
    '--sample-data-preparer', 'none',
    '--sample-data-source', 'none',
    '--approved-test-environment', 'not-applicable',
    '--human-sample-data-entry', 'na',
    '--ui-path-verified', 'na',
    '--manual-started', 'no',
  ]);

  expectProceed([
    '--manual-verification', 'required',
    '--verification-basis', 'objective',
    '--verification-owner', 'ai-workflow',
    '--sample-data', 'not-required',
    '--sample-data-prepared', 'na',
    '--sample-data-preparer', 'none',
    '--sample-data-source', 'none',
    '--approved-test-environment', 'yes',
    '--human-sample-data-entry', 'no',
    '--ui-path-verified', 'yes',
    '--manual-started', 'no',
  ]);

  const subjective = [
    '--manual-verification', 'required',
    '--verification-basis', 'subjective',
    '--verification-owner', 'user',
    '--sample-data', 'not-required',
    '--sample-data-prepared', 'na',
    '--sample-data-preparer', 'none',
    '--sample-data-source', 'none',
    '--approved-test-environment', 'yes',
    '--human-sample-data-entry', 'no',
    '--ui-path-verified', 'yes',
    '--manual-started', 'no',
  ];
  expectStop(subjective, 'HUMAN_VISUAL_REVIEW_RECEIPT_REQUIRED');
  expectProceed([...subjective, '--state-id', G, '--human-visual-review-receipt-file', receiptPath]);
  expectStop([...subjective, '--state-id', 'git:' + 'c'.repeat(40), '--human-visual-review-receipt-file', receiptPath], 'HUMAN_VISUAL_REVIEW_RECEIPT_INVALID');

  expectStop([...ready, '--verification-owner', 'user'], 'UNNECESSARY_HUMAN_CONFIRMATION');
  expectStop([...ready, '--verification-basis', 'subjective'], 'SUBJECTIVE_CONFIRMATION_REQUIRES_HUMAN');
  expectStop([
    '--manual-verification', 'not-required',
    '--verification-basis', 'objective',
    '--verification-owner', 'ai-workflow',
    '--sample-data', 'not-required',
    '--sample-data-prepared', 'na',
    '--sample-data-preparer', 'none',
    '--sample-data-source', 'none',
    '--approved-test-environment', 'not-applicable',
    '--human-sample-data-entry', 'na',
    '--ui-path-verified', 'na',
    '--manual-started', 'no',
  ], 'VERIFICATION_NOT_REQUIRED_CONFLICT');

  expectStop([...ready, '--sample-data-prepared', 'no'], 'SAMPLE_DATA_NOT_PREPARED');
  expectStop([...ready, '--sample-data-preparer', 'user'], 'HUMAN_ASSIGNED_SAMPLE_DATA_CREATION');
  expectStop([...ready, '--human-sample-data-entry', 'yes'], 'HUMAN_SAMPLE_DATA_ENTRY_FORBIDDEN');
  expectStop([...ready, '--sample-data-source', 'unknown'], 'SAMPLE_DATA_SOURCE_UNSAFE_OR_UNKNOWN');
  expectStop([...ready, '--approved-test-environment', 'unknown'], 'TEST_ENVIRONMENT_NOT_CONFIRMED');
  expectStop([...ready, '--ui-path-verified', 'no'], 'UI_PATH_NOT_VERIFIED');
  expectStop([
    ...ready,
    '--sample-data-prepared', 'no',
    '--manual-started', 'yes',
  ], 'MANUAL_STARTED_BEFORE_PREPARATION_COMPLETE');

  console.log('real-device-preparation-gate selftest: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
