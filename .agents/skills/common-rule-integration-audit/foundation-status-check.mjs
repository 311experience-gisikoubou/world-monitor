#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditRuleHealth } from './common-rule-health-audit.mjs';

const REGISTRY_RELATIVE = '.agents/foundation-status.json';
const STATUS_MD_RELATIVE = 'STATUS.md';
const FINAL_STATES = new Set(['common_active', 'policy_only']);
const MANUAL_STATES = new Set(['trial', 'idea', 'not_started']);
const STATE_META = Object.freeze({
  common_active: { emoji: '✅', label: '共通運用中', meaning: 'Foundationの共通仕組みとして正式採用され、実装・検証の証拠がある。' },
  policy_only: { emoji: '🟡', label: '運用ルールのみ', meaning: '方針として有効だが、機械的強制は未実装または一部のみ。' },
  trial: { emoji: '🧪', label: '試験中', meaning: '限定範囲で実運用し、効果と副作用を確認している。' },
  idea: { emoji: '💡', label: 'アイデア', meaning: '改善候補。まだ採用・実装を約束していない。' },
  not_started: { emoji: '⬜', label: '未着手', meaning: '採用済みだが、実装にはまだ着手していない。' },
});
const CONTRACT_LABELS = Object.freeze({
  'human-ai-responsibility': ['人間とAIの役割分担', '人間の価値判断とAIの技術作業の境界を固定する。'],
  'project-context': ['Project Context Guard', 'プロジェクト取り違えを防ぐ。'],
  'canonical-contract': ['Canonical Contract Gate', '最新の正本・仕様の権威を機械判定する。'],
  'human-decision-sync': ['Human Decision Sync', '人間が確定した判断をRepoへ同期し、会話記憶より優先する。'],
  'ui-reference-authority': ['承認済みUI正本', '人間が承認したUI画像を実装正本として固定する。'],
  'project-working-memory': ['Project Working Memory', '現在の目的・参照・次の一手をproject-localに保持する。'],
  'anti-loop-stagnation': ['Anti-loop / Stagnation', '進捗停止や同じ失敗の反復を検出し、経路を見直す。'],
  'long-task-wait': ['Long Task Wait', '長時間処理の待機をPC側へ寄せ、status往復を減らす。'],
  'common-rule-integration': ['共通ルール統合監査', '新ルール追加前に重複・矛盾・過剰化を確認する。'],
  'staged-reality-checks': ['途中AIチェック', 'EARLY / MILESTONE / FINALで実物が正しい対象かを確認する。'],
  'executable-implementation-routing': ['AI実装ルーティング', '作業内容に合うAI実行経路を機械的に選び、証拠を残す。'],
});

function fail(code, detail = {}) { return { ok: false, code, ...detail }; }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function tableText(value) { return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' '); }
function statusLabel(id) {
  const meta = STATE_META[id];
  return meta ? meta.emoji + ' ' + meta.label : id;
}
function validRepoPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some(part => part === '' || part === '.' || part === '..');
}
function derivedStatus(contract) {
  if (contract.state === 'ENFORCED') return 'common_active';
  if (contract.state === 'OPERATIONAL') return 'policy_only';
  if (contract.state === 'DECLARATION_ONLY') {
    const implementationPresent = (contract.implementationMissing ?? []).length === 0;
    const verificationMissing =
      (contract.testsMissing ?? []).length > 0 || (contract.activationMissing ?? []).length > 0;
    return implementationPresent && verificationMissing ? 'trial' : 'not_started';
  }
  return 'not_started';
}
function contractItem(contract) {
  const label = CONTRACT_LABELS[contract.id] ?? [
    contract.id,
    '共通ルール監査のcontract。required=' + contract.required + ', scope=' + contract.enforcementScope,
  ];
  const status = derivedStatus(contract);
  return {
    id: contract.id,
    name_ja: label[0],
    summary_ja: label[1],
    status,
    source: 'common-rule-health',
    nextStep_ja: status === 'common_active' ? '継続運用'
      : status === 'policy_only' ? '必要性が確認された場合だけ機械強制を追加'
      : status === 'trial' ? '不足している検証・発動証拠を確認'
      : '不足実装を完了',
  };
}
async function validateEvidence(root, item, errors) {
  for (const evidence of item.evidence ?? []) {
    if (!validRepoPath(evidence?.path)) {
      errors.push({ code: 'MANUAL_EVIDENCE_PATH_INVALID', id: item.id });
      continue;
    }
    const full = join(root, evidence.path);
    if (!(await exists(full))) {
      errors.push({ code: 'MANUAL_EVIDENCE_FILE_MISSING', id: item.id, path: evidence.path });
      continue;
    }
    if (typeof evidence.contains === 'string') {
      const text = await readFile(full, 'utf8');
      if (!text.includes(evidence.contains)) {
        errors.push({ code: 'MANUAL_EVIDENCE_MARKER_MISSING', id: item.id, path: evidence.path });
      }
    }
  }
}
export async function validateRegistry({ root, registry, derivedIds = new Set() }) {
  const errors = [];
  if (!registry || registry.schemaVersion !== 1) return fail('REGISTRY_SCHEMA_INVALID');
  const manualItems = Array.isArray(registry.manualItems) ? registry.manualItems : [];
  const seen = new Set();
  for (const item of manualItems) {
    if (!item?.id || typeof item.id !== 'string') {
      errors.push({ code: 'MANUAL_ITEM_ID_MISSING' });
      continue;
    }
    if (seen.has(item.id) || derivedIds.has(item.id)) errors.push({ code: 'ITEM_ID_DUPLICATE', id: item.id });
    seen.add(item.id);
    if (!MANUAL_STATES.has(item.status)) {
      errors.push({
        code: FINAL_STATES.has(item.status) ? 'FINAL_STATE_MUST_BE_DERIVED' : 'MANUAL_STATUS_INVALID',
        id: item.id,
        status: item.status ?? null,
      });
    }
    if (!item.name_ja || !item.summary_ja) errors.push({ code: 'MANUAL_ITEM_FIELD_MISSING', id: item.id });
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (item.status === 'trial' && evidence.length === 0) errors.push({ code: 'TRIAL_EVIDENCE_REQUIRED', id: item.id });
    if (evidence.length > 0) await validateEvidence(root, item, errors);
  }
  const changes = registry.currentWorkItem?.changes;
  if (changes !== undefined && !Array.isArray(changes)) errors.push({ code: 'CURRENT_CHANGES_INVALID' });
  return errors.length ? fail('REGISTRY_VALIDATION_FAILED', { errors }) : { ok: true };
}
export async function buildStatusModel({ root, registry, healthReport = null }) {
  const health = healthReport ?? await auditRuleHealth({ root });
  const derivedItems = (health.contracts ?? []).map(contractItem);
  const derivedIds = new Set(derivedItems.map(item => item.id));
  const validation = await validateRegistry({ root, registry, derivedIds });
  if (!validation.ok) return validation;
  const manualItems = (Array.isArray(registry.manualItems) ? registry.manualItems : []).map(item => ({ ...item, source: 'manual-lifecycle' }));
  const items = [...derivedItems, ...manualItems];
  const byId = new Map(items.map(item => [item.id, item]));
  const changeErrors = [];
  for (const change of registry.currentWorkItem?.changes ?? []) {
    const item = byId.get(change?.itemId);
    if (!item) {
      changeErrors.push({ code: 'CHANGE_ITEM_UNKNOWN', itemId: change?.itemId ?? null });
      continue;
    }
    if (!STATE_META[change.from]) {
      changeErrors.push({ code: 'CHANGE_FROM_STATE_INVALID', itemId: change.itemId });
    } else if (!MANUAL_STATES.has(change.from)) {
      changeErrors.push({ code: 'CHANGE_FROM_FINAL_STATE_UNVERIFIED', itemId: change.itemId, claimed: change.from });
    } else if (Object.hasOwn(change, 'to')) {
      changeErrors.push({ code: 'CHANGE_TO_MUST_BE_DERIVED', itemId: change.itemId });
    }
  }
  if (changeErrors.length) return fail('CURRENT_CHANGES_INVALID', { errors: changeErrors });
  const counts = Object.fromEntries(Object.keys(STATE_META).map(id => [id, 0]));
  for (const item of items) counts[item.status] += 1;
  return {
    ok: true,
    healthOk: Boolean(health.ok),
    healthCode: health.code,
    items,
    counts,
    currentWorkItem: registry.currentWorkItem ?? null,
  };
}
export function renderStatusMarkdown(model) {
  const lines = [
    '# Foundation 状態一覧',
    '',
    'このファイルは `.agents/foundation-status.json` と既存の common-rule health 証拠から機械生成します。手動編集しません。',
    '**「決まった」ことと「実装・検証済み」は別です。** ✅ 共通運用中は common-rule health の証拠からだけ導出し、JSONへ手書きして昇格できません。',
    '各application repositoryへの配布状況は別軸で、`portfolio-governance-audit` を使って確認します。',
    '',
    '## 状態の意味',
    '',
    '| 状態 | 意味 |',
    '|---|---|',
  ];
  for (const id of Object.keys(STATE_META)) {
    const meta = STATE_META[id];
    lines.push('| ' + meta.emoji + ' ' + meta.label + ' | ' + meta.meaning + ' |');
  }
  lines.push('', '**現在:** ' + Object.keys(STATE_META).map(id => statusLabel(id) + ' ' + model.counts[id]).join(' / '));
  lines.push('', '## 今回の変更', '', '**' + tableText(model.currentWorkItem?.title_ja ?? 'N/A') + '**', '');
  const changes = model.currentWorkItem?.changes ?? [];
  if (!changes.length) lines.push('- 変更なし');
  for (const change of changes) {
    const item = model.items.find(candidate => candidate.id === change.itemId);
    const note = change.note_ja ? ' — ' + change.note_ja : '';
    lines.push('- ' + (item?.name_ja ?? change.itemId) + ': ' + statusLabel(change.from) + ' → ' + statusLabel(item?.status) + note);
  }
  lines.push('', '## 現在の一覧', '', '| 仕組み | 状態 | 何をするものか | 次の一歩 |', '|---|---|---|---|');
  for (const item of model.items) {
    lines.push('| ' + tableText(item.name_ja) + ' | ' + statusLabel(item.status) + ' | ' + tableText(item.summary_ja) + ' | ' + tableText(item.nextStep_ja ?? '') + ' |');
  }
  return lines.join('\n') + '\n';
}
function parseArgs(argv) {
  let root = null;
  let write = false;
  let pretty = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) root = argv[++i];
    else if (argv[i] === '--write') write = true;
    else if (argv[i] === '--pretty') pretty = true;
    else throw new Error('UNKNOWN_ARGUMENT:' + argv[i]);
  }
  const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
  return { root: root ? resolve(root) : resolve(scriptDir, '../../..'), write, pretty };
}
export async function runStatusCheck({ root, write = false }) {
  const registryPath = join(root, REGISTRY_RELATIVE);
  if (!(await exists(registryPath))) return fail('REGISTRY_FILE_MISSING');
  let registry;
  try { registry = JSON.parse(await readFile(registryPath, 'utf8')); }
  catch { return fail('REGISTRY_INVALID_JSON'); }
  const model = await buildStatusModel({ root, registry });
  if (!model.ok) return model;
  const expected = renderStatusMarkdown(model);
  const statusPath = join(root, STATUS_MD_RELATIVE);
  if (write) {
    await writeFile(statusPath, expected, 'utf8');
  } else {
    if (!(await exists(statusPath))) return fail('STATUS_MD_MISSING');
    const actual = await readFile(statusPath, 'utf8');
    const normalizedActual = actual.replaceAll('\r\n', '\n');
    const normalizedExpected = expected.replaceAll('\r\n', '\n');
    if (normalizedActual !== normalizedExpected) return fail('STATUS_MD_DRIFT');
  }
  return {
    ok: model.healthOk,
    code: model.healthOk ? (write ? 'FOUNDATION_STATUS_WRITTEN' : 'FOUNDATION_STATUS_CURRENT') : 'FOUNDATION_STATUS_HEALTH_STOP',
    items: model.items.length,
    counts: model.counts,
    healthCode: model.healthCode,
    path: STATUS_MD_RELATIVE,
  };
}
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runStatusCheck(args);
    console.log(JSON.stringify(report, null, args.pretty ? 2 : 0));
    console.error('FOUNDATION_STATUS=' + (report.ok ? 'PASS' : 'STOP') + ' code=' + report.code);
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    const report = fail(error?.message || 'FOUNDATION_STATUS_INTERNAL_ERROR');
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
