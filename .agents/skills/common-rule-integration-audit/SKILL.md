---
name: common-rule-integration-audit
description: Use before adding or changing common rules, common skills, common learnings, or cross-repository operational procedures. Search existing canonical sources first, classify the proposal as MERGE_EXISTING / NEW_COMMON / LOCAL_ONLY / REJECT / HUMAN_DECISION, and stop source-of-truth writes until required human approval.
---

# common-rule-integration-audit

## Purpose

共通ルール・共通スキル・共通学習を新規追加または変更する前に、既存正本との重複・類似・矛盾・陳腐化・scope誤りを必ず監査し、追加ではなく統合・local化・却下が適切でないかを判定する強制ゲート。

「新しい共通ルールを思いついた = 追加」にはしない。

## Mandatory Trigger

以下のいずれかを提案・作成・変更しようとした時点で、書き込みより先に必ず実行する。

- `AGENTS.md` の共通ルール
- `CORE.md` / `OPERATIONS.md` の共通原則・運用
- `learnings/` のcommon scope学習
- `.agents/skills/` の共通スキル
- 複数repositoryへ同期・横展開する予定のルール、チェックリスト、報告形式、運用手順

ユーザーが「今後すべての開発で」「共通ルールに」「他プロジェクトにも」等と指定した場合も必須。

## Audit Order

### 1. Proposal definition

提案内容を1〜3行で固定し、何を解決するルールかを明示する。

### 2. Existing-source search

最低限、以下を読み取り専用で検索する。

- `CORE.md`
- `AGENTS.md`
- `OPERATIONS.md`
- `learnings/INDEX.md` と関連 `L-XXXX.md`
- `.agents/skills/README.md` と関連 `SKILL.md`
- 必要に応じて各application repositoryの `AGENTS.local.md`

名称一致だけでなく、目的・trigger・stop condition・責務が類似する既存ルールも確認する。

### 3. Classification

必ず次のどれかに分類する。

- `MERGE_EXISTING`: 既存ルールへ統合するのが適切
- `NEW_COMMON`: 独立した共通ルールとして追加する価値がある
- `LOCAL_ONLY`: repository固有であり共通化しない
- `REJECT`: 不要・重複・過剰・既存原則を弱めるため採用しない
- `HUMAN_DECISION`: scopeや価値判断が必要で人間判断待ち

### 4. Safety / consistency check

以下を確認する。

- `CORE.md` の安全下限を弱めない
- 既存のhuman approval条件を弱めない
- 同じ概念を別名で二重管理しない
- 古いルールを残したまま新ルールを並立させない
- 同期対象外の文書だけに重要ルールを書き、application側で効かない状態を作らない
- 技術スタック固有事項をcommonへ持ち込まない
- 既存参照を切らない

### 5. Human approval before source-of-truth write

監査結果を人間へ提示する。

正本への追加・統合・削除・supersede・deprecated化は、人間が明示承認するまで実施しない。

すでにユーザーが具体的な正本変更まで明示承認している場合でも、この監査自体は省略しない。監査で提案scopeが変わった場合は再確認する。

### 6. Implementation after approval

承認後のみ、通常のbranch / PRフローで変更する。

共通ルール変更では、必要に応じて以下も同じPRで整合させる。

- `AGENTS.md` の入口・強制ルール
- `OPERATIONS.md` の運用フロー
- `learnings/INDEX.md` / 対象learning
- `.agents/skills/README.md` / 対象skill
- `VERSION`
- 同期対象・同期方法に関する記述

## Required Output

監査結果は最低限次の形で出す。

```text
COMMON_RULE_INTEGRATION_AUDIT: PASS / STOP
Proposal: <提案の要約>
Existing overlap: <あり/なし + 対象>
Decision: MERGE_EXISTING / NEW_COMMON / LOCAL_ONLY / REJECT / HUMAN_DECISION
Reason: <短い理由>
Files to change: <承認後に変更する正本>
Human approval: REQUIRED / ALREADY_EXPLICIT
```

## Stop Conditions

以下の場合は正本変更へ進まない。

- 既存ルールとの矛盾が解消できない
- common / local のscopeが決められない
- 安全原則・承認条件が弱まる
- 同期先でルールが実効しない
- 統合先があるのに新規ルールを追加しようとしている
- 人間の価値判断が必要

## Key principle

共通ルールの品質は「何件あるか」ではなく、実際に発動し、重複せず、現在の運用に効いているかで評価する。
