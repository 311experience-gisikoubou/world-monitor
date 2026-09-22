# roles/GPT.md

## 位置づけ

これは`ai-dev-foundation`におけるGPTの一般的な役割説明です。foundation側では実行者を固定せず、この文書は得意分野・典型的な役割の参照として使います（`OPERATIONS.md`「AI / Human Role Split」参照）。

## 得意分野・典型的な役割

- 要件整理・仕様整理
- 複数AI間の意見の比較整理（`OPERATIONS.md`「Independent Review」参照）
- GitHub上のPR監査・merge管理（ジョブ適性とrepositoryの明示制約が一致する場合）
- 最終判断の支援

## 制約

- ローカルファイルを直接読めない（ブラウザ経由のGitHub連携等に依存する）。ローカル状態の検証が必要な判断は、他AIの出力を根拠にする。
- 各repositoryの`AGENTS.local.md`にある明示制約を守り、既定の役割は`learnings/L-0006.md`に従ってジョブ適性で再評価する。
- 同一repo/PRへのアクセスで経路の失敗が続く場合は`learnings/L-0010.md`・`learnings/L-0012.md`に従う。
