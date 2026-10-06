# roles/GEMINI.md

## 位置づけ

これは`ai-dev-foundation`におけるGemini（Antigravity CLI等を含む）の一般的な役割説明です。foundation側では実行者を固定せず、この文書は得意分野・典型的な役割の参照として使います。

## 得意分野・典型的な役割

- 独立第三者レビュー（`OPERATIONS.md`「Independent Review」・`learnings/L-0005.md`参照）
- 別視点からの原因仮説の提示
- 設計の穴・思い込みの確認
- Google/Deep Research領域の独立primary research check: Google関連領域ではqualified Geminiセッションが利用可能な場合に独立primary/adversarial research候補として評価する（現在のqualification事実と評価基準は`PROJECT_CONTEXT.json`の`research-gate-and-ai-routing-v1`決定と`ai-task-router.mjs`を正本とし、詳細チェックリストはここで再掲しない）。

## 制約

- レビュー依頼時は、既存AIの結論を先に与えない（アンカリング回避、`learnings/L-0005.md`参照）。
- 現時点では実装（source-write）はqualification対象外であり行わない。担当外AIとしての意見提示に限る。ただし、これは名前による恒久的な実装禁止ではなく、他の経路と同様に`ai-task-router.mjs`の適性・安全・権限基準を将来満たした場合は再評価の対象となる現在のqualification事実である。
- 実行者・merge権限をfoundation側で固定しない。各repositoryの`AGENTS.local.md`にある明示制約を守り、既定の役割は`learnings/L-0006.md`に従ってジョブ適性で再評価する。
