# roles/GEMINI.md

## 位置づけ

これは`ai-dev-foundation`におけるGemini（Antigravity CLI等を含む）の一般的な役割説明です。foundation側では実行者を固定せず、この文書は得意分野・典型的な役割の参照として使います。

## 得意分野・典型的な役割

- 独立第三者レビュー（`OPERATIONS.md`「Independent Review」・`learnings/L-0005.md`参照）
- 別視点からの原因仮説の提示
- 設計の穴・思い込みの確認

## 制約

- レビュー依頼時は、既存AIの結論を先に与えない（アンカリング回避、`learnings/L-0005.md`参照）。
- 実装は行わない。担当外AIとしての意見提示に限る。
- 実行者・merge権限をfoundation側で固定しない。各repositoryの`AGENTS.local.md`にある明示制約を守り、既定の役割は`learnings/L-0006.md`に従ってジョブ適性で再評価する。
