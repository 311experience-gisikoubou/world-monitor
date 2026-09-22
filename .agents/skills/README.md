# .agents/skills/

このディレクトリは、この共通基盤repositoryが正本として持つ共通スキル（`SKILL.md`）の置き場所です。

## 現在の状態

共通開発フロー用スキルに加えて、共通ルール変更前の強制ゲート`common-rule-integration-audit`と、application repositoryへの同期実効性を確認し、未導入repositoryへの安全bootstrap・既導入repositoryの安全updateも支援する`foundation-sync-audit`を持ちます。技術スタック固有の手順は各アプリケーションrepository側の`AGENTS.local.md`を参照します。

## 完全共通（A分類・技術固有部分を含まない）

- **`common-rule-integration-audit`**：共通ルール・共通スキル・共通学習を追加/変更する前に必ず実行する強制ゲート。既存正本との重複・類似・矛盾・陳腐化・scope・統合可能性を確認し、`MERGE_EXISTING` / `NEW_COMMON` / `LOCAL_ONLY` / `REJECT` / `HUMAN_DECISION`へ分類する。`common-rule-health-audit.mjs`で宣言だけの技術ルール、実装/test欠落、未索引・長大化・重複候補もread-only棚卸しする。正本変更は人間承認後のみ。
- **`foundation-sync-audit`**：Layered V1では`CORE.md`をTier 0唯一の正本とし、生成済み`AGENTS.md`、共通詳細文書・skills・roles・learnings、Claude/Codex/Gemini/Antigravityのnative共通入口を同一のmanaged surfaceとして実ファイル同一性で監査する。`entrypoint-renderer.mjs`は`AGENTS.md`とAntigravity ruleを決定的に生成し、AGENTS 16 KiB上限も検証する。Claude native skillを使うrepositoryでは従来どおり`.claude/skills/`wrapperも監査する。初回導入は`foundation-bootstrap.mjs`、既導入repository更新は`foundation-update.mjs`、remote展開は同じmanaged path契約を使うplannerで行い、drift・欠落・新path衝突では上書きせずSTOPする。`AGENTS.local.md`・root `CLAUDE.md`・repository固有Skill・業務コードは変更しない。version表記・sync logだけで「実効的に完全同期済み」と判定しない。
- **`project-intake`**：ユーザーの短い「これがしたい」を、明示assumption・最大3つの人間判断・LIGHT/FULL安全profile付きの1枚企画書へ整理し、Human Decision Syncで承認後に既存preflight / implementation routing / staged reality / test-gate / final-pr-auditへ渡す入口。別のapproval DB・starter code・安全gateは作らない。
- **`preflight-audit`**：実装・修正・リファクタリング前のGit状態・仕様・既存コード・テストの確認と、想定外差分・仕様矛盾・データ損失リスク・追加費用リスクでの停止。
- **`post-merge-verification`**：GitHub上でPRがマージされた後の、マージ方式（squash／merge commit／rebase merge）確認、tree一致確認、local `main`のfast-forward同期、branch削除の安全判断。
- **`handoff`**：作業を別のチャット・別のAI・別のセッションへ引き継ぐためのProject Context固定と、通常ターンの短い暗黙継続が別Projectへ流れないためのturn-start整合確認。人間判断の正本はHuman Decision Syncに一本化し、local repository経路の`project-working-memory.mjs`はapproved reference・Current Goal・Next Stepの短期キャッシュとartifact recallだけを担当する。人間が採用したUI画像は`docs/ui-reference/`へproject-local正本として保存し、`ui-reference-manager.mjs`とCanonical Contract `REFERENCE_IMAGE`検証でCURRENT/archive・scope・source整合を強制する。focus内のdecision IDはcanonical confirmed decisionへ照合し、古い判断のローカルコピーを権威として再利用しない。
- **`long-task-wait`**：長時間taskの待機・監視をPC内へ寄せ、AI↔RDCの短いstatus連打を避ける。既存task IDにはbounded waitを使い、長時間Claude実装は`claude-job/`の非同期worktreeジョブとして起動して短いread-only statusで追跡する。Claude実行自体は既存`implementation-orchestrator.mjs`へ委譲し、安全境界を二重化しない。

## 共通本体＋アプリ側設定（B分類・技術スタック固有部分を分離）

- **`migration-safety`**：既存migrationの不変性、番号・順序確認、fresh適用／既存DBからのupgrade確認、schema整合性確認、data loss防止、backup・rollbackの判断という共通原則のみを持つ。具体的なDB製品名・migrationツール名・コマンドは含まず、各アプリケーション側の`AGENTS.local.md`を参照する。
- **`test-gate`**：変更種別に応じた検証選択、軽い検証から重い検証への順序、失敗時停止、検証結果の状態記録という共通ワークフローのみを持つ。具体的な実行コマンドは含まず、各アプリケーション側の`AGENTS.local.md`を参照する。 `staged-reality-gate.mjs`でEARLY / MILESTONE / FINAL REALITYの途中AIチェックも実行し、task種別ごとの客観証拠・exact state binding・fail closedで方向ズレを早期検出する。
- **`final-pr-audit`**：base/head SHA・commit数・変更ファイル・diff範囲・仕様整合性・`test-gate`結果の確認・PRとマージの分離という共通チェック項目のみを持つ。具体的なbuild/test/lintコマンド等は各アプリケーション側の`AGENTS.local.md`を参照する。 Merge execution also uses a short-lived GitHub receipt bound to exact PR + exact HEAD and emits an expected-head SHA only on PASS; private-repository evidence can come from an already-authorized machine-readable GitHub route without copying credentials into the gate.

## ローカルAI間ハンドオフ（C分類・repository固有の採用判断を伴う）

- **`local-ai-handoff`**：同一PC上のローカルAI CLI間で状態・監査結果・次指示をファイル経由で受け渡す共通プロトコル。ライブの`.ai-handoff/`実データは採用する各application repository側に置く。

## アプリケーションrepository側での扱い

- Layered V1のmanaged surface（生成済み`AGENTS.md`、共通詳細文書・`.agents/skills/`・`roles/`・`learnings/`、AI別native入口）は、この共通基盤repositoryからの**同期コピー**です。
- アプリケーションrepository側で、この同期コピーを直接編集しません。`AGENTS.local.md`とroot `CLAUDE.md`はrepository-localのままです。
- アプリケーション固有の変更・追加手順は、そのアプリケーションrepository側の`AGENTS.local.md`に記載します。
- 技術スタック固有の具体的コマンドも、共通スキルへは書かず`AGENTS.local.md`に記載します。
- Claude Code native skillを利用するrepositoryでは、`templates/.claude/skills/<skill>/SKILL.md.template`を`.claude/skills/<skill>/SKILL.md`として同期します。wrapperはcanonical本文を複製せず、同一repository内の`.agents/skills/<skill>/SKILL.md`を参照します。
- repository固有の`.agents/skills/`や`.claude/skills/`はtarget-only extraとして共存してよく、foundation側の同名共有pathを上書きしません。
- 未導入repositoryの初回導入には`foundation-bootstrap.mjs`、既導入repositoryのFoundation更新には`foundation-update.mjs`を使い分けます。updateは旧正本との一致を証明できない共有pathを上書きしません。
- 完全同期・最新版・適用済みと表現する前に`foundation-sync-audit`または同等の固定SHA間remote比較をPASSさせます。Layered V1では4AIのnative入口一致も完全同期条件です。Claude native skillが設定済みならwrapper一致も必要です。部分同期は完全同期と表現しません。
- `portfolio-health-observer`：既存のWIP・stagnation・Foundation判定を横断集約するread-only observer。新しい優先順位判定や安全閾値は持たない。
