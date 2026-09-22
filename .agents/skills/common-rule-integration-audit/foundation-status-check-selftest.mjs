#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatusModel, renderStatusMarkdown } from './foundation-status-check.mjs';

const healthReport = {
  ok: true,
  code: 'COMMON_RULE_HEALTH_PASS',
  contracts: [
    {
      id: 'project-context',
      state: 'ENFORCED',
      required: 'TECHNICAL',
      enforcementScope: 'LOCAL_WHEN_INVOKED',
      implementationMissing: [],
      testsMissing: [],
      activationMissing: [],
    },
    {
      id: 'human-ai-responsibility',
      state: 'OPERATIONAL',
      required: 'OPERATIONAL',
      enforcementScope: 'OPERATIONAL',
      implementationMissing: [],
      testsMissing: [],
      activationMissing: [],
    },
  ],
};

function registry(status = 'trial', evidence = [{ path: 'evidence.txt', contains: 'present' }], from = 'idea', handwrittenTo = undefined) {
  return {
    schemaVersion: 1,
    manualItems: [{
      id: 'foundation-status-visibility',
      name_ja: '基盤状態の可視化',
      summary_ja: '状態を見えるようにする。',
      status,
      evidence,
      nextStep_ja: '次へ',
    }],
    currentWorkItem: {
      title_ja: '状態可視化',
      changes: [{
        itemId: 'foundation-status-visibility',
        from,
        ...(handwrittenTo === undefined ? {} : { to: handwrittenTo }),
        note_ja: '試験へ移行',
      }],
    },
  };
}

const root = await mkdtemp(join(tmpdir(), 'foundation-status-'));
try {
  await writeFile(join(root, 'evidence.txt'), 'present\n', 'utf8');

  const good = await buildStatusModel({ root, registry: registry(), healthReport });
  assert.equal(good.ok, true);
  assert.equal(good.counts.common_active, 1);
  assert.equal(good.counts.policy_only, 1);
  assert.equal(good.counts.trial, 1);
  const markdown = renderStatusMarkdown(good);
  for (const label of ['✅ 共通運用中', '🟡 運用ルールのみ', '🧪 試験中', '💡 アイデア', '⬜ 未着手']) {
    assert.equal(markdown.includes(label), true);
  }

  const idea = await buildStatusModel({
    root,
    registry: registry('idea', []),
    healthReport,
  });
  assert.equal(idea.ok, true);

  const falsePromotion = await buildStatusModel({
    root,
    registry: registry('common_active', []),
    healthReport,
  });
  assert.equal(falsePromotion.ok, false);
  assert.equal(falsePromotion.errors.some(error => error.code === 'FINAL_STATE_MUST_BE_DERIVED'), true);

  const falseHistoricalFinalState = await buildStatusModel({
    root,
    registry: registry('trial', [{ path: 'evidence.txt' }], 'common_active'),
    healthReport,
  });
  assert.equal(falseHistoricalFinalState.ok, false);
  assert.equal(falseHistoricalFinalState.code, 'CURRENT_CHANGES_INVALID');
  assert.equal(falseHistoricalFinalState.errors.some(error => error.code === 'CHANGE_FROM_FINAL_STATE_UNVERIFIED'), true);

  const trialWithoutEvidence = await buildStatusModel({
    root,
    registry: registry('trial', []),
    healthReport,
  });
  assert.equal(trialWithoutEvidence.ok, false);
  assert.equal(trialWithoutEvidence.errors.some(error => error.code === 'TRIAL_EVIDENCE_REQUIRED'), true);

  const missingEvidence = await buildStatusModel({
    root,
    registry: registry('trial', [{ path: 'missing.txt' }]),
    healthReport,
  });
  assert.equal(missingEvidence.ok, false);
  assert.equal(missingEvidence.errors.some(error => error.code === 'MANUAL_EVIDENCE_FILE_MISSING'), true);

  const handwrittenTarget = await buildStatusModel({
    root,
    registry: registry('trial', [{ path: 'evidence.txt' }], 'idea', 'common_active'),
    healthReport,
  });
  assert.equal(handwrittenTarget.ok, false);
  assert.equal(handwrittenTarget.code, 'CURRENT_CHANGES_INVALID');
  assert.equal(handwrittenTarget.errors.some(error => error.code === 'CHANGE_TO_MUST_BE_DERIVED'), true);

  const derivedPromotionRegistry = {
    schemaVersion: 1,
    manualItems: [],
    currentWorkItem: {
      title_ja: '証拠からの昇格',
      changes: [{ itemId: 'project-context', from: 'trial', note_ja: '検証完了' }],
    },
  };
  const derivedPromotion = await buildStatusModel({ root, registry: derivedPromotionRegistry, healthReport });
  assert.equal(derivedPromotion.ok, true);
  assert.equal(renderStatusMarkdown(derivedPromotion).includes('🧪 試験中 → ✅ 共通運用中'), true);

  console.log('foundation-status-check selftest: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
