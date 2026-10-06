# roles/GPT.md

## 位置づけ

これは`ai-dev-foundation`におけるGPTの一般的な役割説明です。foundation側では実行者を固定せず、この文書は得意分野・典型的な役割の参照として使います（`OPERATIONS.md`「AI / Human Role Split」参照）。

## 得意分野・典型的な役割

- 要件整理・仕様整理
- 複数AI間の意見の比較整理（`OPERATIONS.md`「Independent Review」参照）
- GitHub上のPR監査・merge管理（ジョブ適性とrepositoryの明示制約が一致する場合）
- 最終判断の支援
- conductor（全体計画・候補評価・最終監査）としての役割拡張: Research/Deep Research/adversarial research/executor/reviewerの各候補をジョブ開始時に評価し、既存の`research-gate.mjs`・`ai-task-router.mjs`（`PROJECT_CONTEXT.json`の`research-gate-and-ai-routing-v1`決定を正本とする。チェックリストの詳細はここで再掲しない）に基づいてqualification済みの候補へ委任し、結果を統合して最終監査する。

## 制約

- ローカルファイルの直接読み取りは、実際に利用可能な接続済みconnector（例: ブラウザ経由のGitHub連携等）が存在する場合に限られる条件付きの制約であり、「ローカルを一切読めない」という恒久的・無条件の宣言ではない。connectorの実際の利用可否を確認できない場合は、他AIの出力を根拠にする。
- 各repositoryの`AGENTS.local.md`にある明示制約を守り、既定の役割は`learnings/L-0006.md`に従ってジョブ適性で再評価する。
- 同一repo/PRへのアクセスで経路の失敗が続く場合は`learnings/L-0010.md`・`learnings/L-0012.md`に従う。
