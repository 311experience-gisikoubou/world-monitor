# OPERATIONS.md

## 位置づけ

これは`ai-dev-foundation`の運用の地図です。個々の再発防止事項・詳細ルールの本文は`learnings/`側にあり、ここでは複製せず参照します。この文書の内容が`CORE.md`と矛盾する場合は、常に`CORE.md`が優先します。

## Human / AI Responsibility

- 技術的に安全に実行できる作業（実装・監査・テスト・文書化・定型のGit/GitHub操作等）はAIが担う。
- 技術的な事実確認、安全判定、設定値、診断、出力解釈、実装方法、承認済み方針内の構成選択はAIが担い、非エンジニアの人間へ技術判断を丸投げしない。
- **技術的に重要・大規模・専門的という理由だけで人間確認へ昇格させない。** 技術的根拠だけで安全に一意に決められるならAIが自動で進める。
- 人間は、仕様・価値判断、実機でしか確認できない主観事項、高リスク・破壊的操作の承認、mergeの最終承認を担う。システム選択でも、人間の目的・業務方針・継続費用・責任分担・データ取扱い方針・日常の使い方などに実質的な選択が残る場合だけ、人間判断とする。
- 人間判断が必要な場合、AIは技術調査・安全比較・推奨案を先に作り、非エンジニアでも判断できる言葉で違い・影響・リスク・管理負担を説明してから明示判断を仰ぐ。
- 人間が価値・方針を承認した後の安全な技術詳細はAIが連続して処理し、細かな技術事項ごとに承認を取り直さない。
- ジョブ開始時と重要な実行経路変更時に、AIは作業内容、各AIの得意分野、必要な権限・tool、実行環境、安全性・privacy境界、文脈保持、独立監査の必要性、追加費用を確認し、利用可能なAIの中からジョブ適性で実行者・監査者を選択する。
- 各repositoryの`AGENTS.local.md`にあるAI役割記述は既定値・repository固有制約として必ず確認する。単なる過去の担当や通常経路は永久固定の割り当てとは扱わないが、安全・権限・責任・費用・データ取扱い・human approvalの明示境界は上書きしない（`roles/`、`learnings/L-0006.md`参照）。
- AIだけで安全に決められる実行者・経路の技術選択を、非エンジニアの人間へ返さない。通常経路が利用不能なら、承認済みの安全境界内で別の利用可能な経路をAIが評価する。
- 現行のsource実装では、qualificationを満たす間はClaude CLIの`claude-implementation-write`を第一実装経路とし、ChatGPTは仕様整理・設計・オーケストレーション・最終監査を既定担当とする。Codexのwrite経路は別途qualificationするまで実装フォールバックとして扱わず、Gemini/Antigravityは別途qualificationされるまでは独立レビュー・代替分析を主用途とする。ChatGPTによる直接source実装は閉じた例外理由がある場合だけとし、通常経路にはしない（`learnings/L-0006.md`参照）。
- For Claude implementation that may outlive the outer tool wait, use `long-task-wait/claude-job`: launch and status are short calls, model execution stays inside the existing `implementation-orchestrator.mjs`, 60 minutes is warning-only, one repository has one active job, out-of-scope changes fail closed, and only the outer runner may create DONE.

## Simplest Safe Design

安全性と自動化を両立したうえで、設計・実装・運用は可能な限り単純に保つ。

- 必要な安全性・privacy・data-loss prevention・復旧可能性・監査可能性・業務要件を先に固定する。その安全ラインを下げて単純化しない。
- 安全ラインを満たす複数案がある場合、構成要素、外部サービス、依存関係、データ経路、設定箇所、人間の手順、継続保守が少ない案を優先する。
- 既存の承認済み仕組みで安全に目的を満たせる場合、新しいソフト、サービス、通信経路、常駐プロセス、別管理の設定を理由なく追加しない。
- 非自明な独自実装や新規依存の導入では、**目的・要件固定 → 既存/OSS候補調査 → 採用/自作判断 → 実装 → テスト**を基本順序とする。GitHubや公式package ecosystem等で有力候補がある場合は3〜5件程度を比較し、用途適合性、ライセンス、ローカル実行、外部通信/telemetry、security/privacy、対象OS、保守状況、依存の重さ、更新・撤去負担まで確認する。候補が少なければ数を埋めない。OSS調査は採用承認ではなく、既存の費用・データ・security・lifecycle・human approval境界をそのまま維持する。
- より複雑な案を採用する場合は、その複雑さが安全性・必要機能・復旧性・運用上の明確な利点に必要であることをAIが説明できなければならない。
- 「安全だから手作業に戻す」で終わらせない。まず安全に自動化できる単純な経路をAIが探す。
- 同種の手作業、伝書鳩、承認往復、設定作業が繰り返される場合は、個別対応だけで終えず、類似ケースを含む構造的な自動化候補として扱う。ただし、自動化によって安全ラインを下げない。

## Common Rule Change Workflow

共通ルール・共通スキル・共通学習の追加または変更は、通常の実装フローより先に次の強制ゲートを通す。

```
共通化候補を発見
→ common-rule-integration-audit（読み取り専用）
→ MERGE_EXISTING / NEW_COMMON / LOCAL_ONLY / REJECT / HUMAN_DECISION
→ 人間承認
→ feature branch
→ 正本変更
→ VERSION更新
→ final-pr-audit
→ 人間のmerge承認
→ squash merge
→ post-merge verification
→ application repositoryへ同期
```

- 「新しい共通ルールを思いついた = 追加」にはしない。
- `common-rule-integration-audit`前に正本を書き換えない。
- 既存ルールへ統合できる場合は新規ルールを増やさない。
- repository固有事項はcommonへ昇格させずlocalへ残す。
- 同期先で実効しない場所だけに重要ルールを書かない。
- 監査結果により提案scopeが変わった場合は、正本変更前に人間へ再確認する。
- 詳細は`learnings/L-0003.md`および`common-rule-integration-audit`スキルを参照する。

## Project Intake Front Door

新規project、または目的・scopeを新たに定義する意味ある新機能では、通常の実装フローへ入る前に`project-intake`を使う。

```text
短い人間の依頼
→ AIが1枚briefへ整理
→ 必要な人間判断を最大3つへ圧縮
→ Human Decision Syncへ明示承認を記録
→ project-intake task packet
→ 既存Shared AI Development Workflow
```

`project-intake`は既存gateの前段整理だけを担う。安全・provider選択・source実装・途中確認・test・PR監査・merge承認を別系統で再実装しない。`FULL`は患者/保護データ、外部通信、追加費用、本人認証、本番影響、実データ影響のどれかがある場合に自動選択し、それ以外は`LIGHT`とする。`LIGHT`も既存の最低安全ラインを外さない。技術stack別starterはrepository-localとし、AI間handoffはrepository artifactを優先する。

## Layered AI Rule Loading

共通ルールは、全AIが毎回すべて読む方式にしない。起動時の核と、作業時に必要な詳細を分離する。

- `CORE.md`をTier 0安全原則の唯一の正本とする。
- `AGENTS.md`は`CORE.md`と小さなタスク索引から機械生成し、Codexを含む共通always-on入口として使う。
- application repositoryでは`AGENTS.local.md`を必ず読み、repository固有事項はcommonへ複製しない。
- Claude Codeはmanagedな`.claude/CLAUDE.md`、Geminiは`GEMINI.md`、Antigravityは`.agents/rules/ai-foundation.md`から同じTier 0へ接続する。repository-owned root `CLAUDE.md`は上書きしない。
- `OPERATIONS.md`・`roles/`・`learnings/`・`.agents/skills/`は同期済み詳細層として保持し、`AGENTS.md`のタスク索引から必要なものだけ読む。`PROJECT_COMPLETION.md`は各repository固有の完成条件正本としてローカル保持し、Foundation同期で上書きしない。
- 生成入口とmanaged surfaceは`foundation-sync-audit`で内容一致を確認し、version表記や`sync-log.md`だけではCURRENTと判定しない。
- 生成済み`AGENTS.md`は16 KiBを上限とし、Codex既定32 KiB上限に十分な余白を確保する。
- `AGENTS.local.md`、業務仕様、root `CLAUDE.md`、secrets・実データ等のrepository-local内容はFoundation同期で上書きしない。

## Shared AI Development Workflow

複数のapplication repositoryで共通利用する標準開発ルーティンは以下とする。

```
Work-Start Guard（local source writeのみ）
→ Context / Authority Check
→ preflight-audit
→ feature branch
→ Implementation Step 1
→ EARLY CHECK
→ Implementation Step 2 / milestone work
→ MILESTONE CHECK
→ implementation completion
→ test-gate
→ FINAL REALITY CHECK
→ 差分確認
→ commit
→ 通常push
→ Draft PR作成
→ GitHub側PR情報取得
→ final-pr-audit
→ 人間のmerge承認
→ squash merge
→ post-merge verification
```

The staged checks are executed through `.agents/skills/test-gate/staged-reality-gate.mjs`. They fail closed on target/authority/state/evidence mismatch, use task-type-specific objective evidence, and reuse valid evidence rather than repeating the same test. If a later edit changes the bound state, rerun only the invalidated staged check before continuing.

- local source writeを始める前に `work-start-guard.mjs --mode write` を通し、clean worktree・live target branch・feature branchの派生元・AGENTS/Foundation currentnessを確認する。dirty/staleな既存worktreeを見つけても自動reset/clean/stashせず、読み取り専用で差分を保護したまま確認する。
- `main`へ直接commitしない。原則として1目的1feature branch / 1 PRとする。
- feature branchやIssue/PRを新規作成する前に、preflightで作業所有権を確認する。最低限、(1)現在のrepository / 共通基盤のscopeか、(2)専用application projectや別workstreamが正本として既に進行していないか、(3)同じIssue / PR / 実装を二重に作らないか、の3点を`CURRENT_STATUS.md`・Issue・PR・branch・仕様等の取得可能な証拠で確認する。
- 同じ製品タスクを専用project / repositoryが既に所有している場合、そのworkstreamの状態を別projectから更新・再実装しない。共通基盤側では再発防止や横断運用の観測材料としてのみ使い、別のFoundation-owned taskへ進む。所有権の移管は、明示的な移管・完了・再開根拠がある場合だけ行う。
- 安全な技術作業は、工程ごとの個別承認を求めず連続実行してよい。
- test-gate後に実装差分を変更した場合、そのtest-gateは無効となるため、必要な検証を再実行する。
- exact committed HEADでtest-gateが完了した場合は、`VERIFICATION_EVIDENCE_V1`を単一のverification証拠として後段へ引き継ぐ。`final-pr-audit`やpost-mergeは現在のbase/head/scopeとの一致を機械確認し、同じpropertyのテスト・結果取得を繰り返さない。不一致時も無関係なPASSまで全再実行せず、無効化されたpropertyだけを再検証する。
- Foundation更新を複数application repositoryへ展開する場合は、old/new Foundation差分を1回だけ固定し、`foundation-batch-rollout-plan`でexact blob identityから`CURRENT / UPDATE / PARTIAL_RESUME`を判定する。`CURRENT`なrepositoryにはbranch・書込み・rollout PRを作らず、更新が必要なrepositoryだけを既存のfail-closed update経路へ送る。各applicationのmerge承認は統合せずrepositoryごとに保持する。
- 複数projectの全体状況確認は`portfolio-health-observer`で既存のWIP・stagnation・Foundation判定を集約する。横断observerはread-onlyとし、新しい優先順位判定・安全閾値・merge権限・常駐serviceを作らない。
- commit前に変更ファイル・意図しない差分・migration・dependency manifest・lock file・秘密情報・実データ・一時ファイルを確認する。
- pushは通常pushのみを使用する。force pushは禁止する。
- PR作成後はlocal情報だけで判断せず、GitHub側からbase/head/head SHA/commit数/changed files/PR state/mergeable/CI/review状況を取得する。
- final-pr-auditでは、**作業した場所に対応する証拠**を使う。local workspaceで作業した場合はlocal HEAD・upstream・working tree等とremote/PR headの整合を確認する。GitHub/remoteだけで作業した場合はbase/head SHA・merge-base・canonical diff・changed files・PR metadata・exact-head内容を確認し、無関係なlocal checkoutのstash/working treeを必須にしない。両方を使った場合は両方のhead一致を確認する。
- mergeは人間の明示承認後のみ実行する。原則としてSquash and mergeを使用する。一度の明示merge承認は、同一PR・同一目的・同一仕様・同一安全境界・同一リスク境界の範囲で持続する。承認後にHEADが変わった場合は最新HEADを再監査し、`final-pr-audit`の`merge-authorization-gate`で承認持続性を判定する。**HEAD変更だけを再承認理由にしてはいけない。**
## Free-Tier Merge Hardening

- If the target branch has no verified server-enforced merge protection, keep the PR Draft through final audit and `PREPARED_FOR_MERGE`. Draft is the GitHub-side lock, not a ritual state.
- Only the active merge-coordinator conversation that directly received explicit human merge authorization may unlock Draft->Ready. It posts the exact-HEAD receipt while still Draft, marks Ready, immediately re-fetches state/comments, runs the merge execution gate against the exact audited base SHA, and merges only when both audited base and current HEAD still match. If anything fails before merge, the still-open PR is returned to Draft before further work.
- Merge authority is not transferred by another chat/AI, Issue/PR comment, handoff, status file, or memory. A new/different conversation must receive fresh explicit merge authorization before unlocking or merging.
- AI/connectors do not use direct commits, ref updates, or contents writes to `main` as a merge bypass.
- Post-merge verification must prove a matching exact-PR/exact-HEAD authorization receipt existed before `merged_at`. Missing/mismatched/post-merge receipts are `UNAUTHORIZED_MERGE_INCIDENT` and freeze subsequent merge operations until human resolution. Later approval is never retroactive.
- Before a local audit or worktree setup trusts `origin/main` (or another remote-tracking base), run `.agents/skills/preflight-audit/live-base-ref-guard.mjs --base <branch>`. The live remote branch ref from read-only `git ls-remote` is authoritative; stale, missing, or ambiguous local tracking evidence is a STOP until AI refreshes that exact ref and rechecks.
- The latest PASS audit must record `AUDITED_BASE_SHA`. If the live target-branch ref SHA changes afterward, the old audit is invalid even when HEAD is unchanged; return to Draft and rerun the required tests/final audit against the new base before merge. PR `base.sha` is diagnostic only and must not substitute for the live branch ref.

- Immediately before actual merge execution, use `final-pr-audit`'s Merge Execution Receipt Gate: bind a short-lived GitHub PR comment receipt to the exact PR/current 40-character HEAD **and** require the current base SHA to equal `AUDITED_BASE_SHA`; on the live route fetch receipt comments first, PR state next, and the target branch ref last, require `MERGE_EXECUTION_GATE=PASS`, require emitted `EXPECTED_BASE_SHA` to equal the audit, and pass emitted `EXPECTED_HEAD_SHA` as the merge API expected-head precondition. After PASS, do no unrelated network/review work before the merge call. GitHub's normal PR merge API provides an expected-HEAD check but no atomic expected-base-SHA precondition, so this free-tier path is a final observed-state check rather than an atomic base lock; post-merge verification must detect any residual race as `BASE_SHA_DRIFT`. Continuation language does not create merge authorization. For private repositories, use already-authorized machine-readable GitHub evidence; do not copy credentials into the gate.
- merge後はpost-merge-verificationを行い、PRがMERGEDであること、squash commit、親関係、必要なtree整合、必要なlocal main同期、working tree cleanを確認する。local checkoutを運用上使用しないrepositoryでは、そのlocal同期項目を機械的に作らず、実際の運用経路に必要なpost-merge証拠を使う。

この共通ルーティンに対し、各application repositoryは`AGENTS.local.md`で技術スタック固有のテスト、実機確認条件、禁止領域、正本ドキュメント等を追加する。

## Safe Continuous Workflow

承認された作業範囲について、以下の定型工程は、工程ごとに人間へ「進めてよいか」を確認せず連続実行してよい。

```
Context / Authority Check → preflight-audit（Canonical Contract Gate含む） → implementation slice → EARLY CHECK → milestone work → MILESTONE CHECK → implementation completion → test-gate → FINAL REALITY CHECK → commit → push → Draft PR作成 → final-pr-audit
```

- 「commitしてよいか」「pushしてよいか」「PRを作ってよいか」という定型確認は、安全条件を満たす限り不要である。
- ユーザーが「マージ手前まで」を明示した場合、`PRE_MERGE_READY`は「必要修正 → EARLY / MILESTONE CHECK → test-gate PASS → FINAL REALITY CHECK PASS → commit → 通常push → Draft PR → final-pr-audit PASS → exact PR / exact HEAD確認」が完了し、merge承認だけが残る状態とする。途中の技術的gate失敗はこの完了目標を解除しない。
- 実装・修正・リファクタリングの前に、現状把握のための監査を行う（`preflight-audit`スキル参照）。**localで作業するならlocal/origin・HEAD・upstream・working tree・stashを確認し、remote-onlyで作業するならremote branch/base/head/merge-base/diff/scopeを確認する。** 作業に使っていない環境の状態を、人間の伝書鳩作業で収集しない。
- 1つのPull Requestは1つの目的にとどめる。
- 変更は最小限にとどめ、段階的に確認しながら進める。既存の挙動を無断で変更しない。
- 承認済み基準・正本・デザイン・仕様がある場合、実装前にそれを明示的な比較基準として固定する。AIは改善案や現行コードの都合を理由に基準を再設計しない。移植先・実装先で意味ある差分が必要になった場合は、その差分だけをHuman Confirmation Pointとして提示し、承認前に基準または実装へ混入させない。
- 仕様とコードが矛盾する場合、推測で実装を進めない。「Human Confirmation Points」の仕様・価値判断に該当するものとして、その時点で停止する。
- 必要なテストと監査を省略しない（`test-gate`・`final-pr-audit`参照）。
- 読み取り専用の監査を依頼された場合は、ファイルを変更しない。
- Squash and mergeの後は、マージ結果の検証を行う（`post-merge-verification`スキル参照）。
- merge実行には人間の明示承認が必要だが、同一承認範囲内で既に有効なmerge承認がある場合は、HEAD変更後の再監査PASSと`merge-authorization-gate=PERSIST`をもって再承認なしで継続する。
- ユーザー向けのcheckpoint/status/final reportは、先頭で次アクションを1つに固定する：`【次のアクション：マージ】` / `【次のアクション：確認後に次へ】` / `【次のアクション：AIが自動継続】` / `【状態：完了】`。2行目は必ず`あなたの操作：...`とする。
- `マージ`は「必要gateが完了し、merge承認だけが唯一の残りHuman Confirmation Point」の場合だけ。`確認後に次へ`は仕様・価値判断・主観的実機確認等のHuman Confirmation Pointが残る場合だけ。安全な技術作業や再監査が残るだけなら`AIが自動継続`とし、ユーザーへ「次」と言わせるために停止しない。
- 有効なmerge承認を既に受けている場合、途中報告で再び`マージ`を要求しない。必要gateを通し、その承認範囲内でmergeとpost-merge verificationまで自動継続する。
- 状態組み合わせはfail closedで扱う：`MERGE`は`User action required=YES / Merge authorized=NO / non-merge HCP=NONE`、`CONFIRM_THEN_CONTINUE`は`User action required=YES / non-merge HCP=PRESENT`、`AI_CONTINUES`は`User action required=NO`、`COMPLETE`は`Status=COMPLETE / User action required=NO`。これに矛盾する組み合わせは表示せず、証拠を再確認して状態を修正する。
- PRが技術的にmerge-readyでも、merge承認とは別のHuman Confirmation Pointが残る間は`CONFIRM_THEN_CONTINUE`であり`MERGE`ではない。既にmerge承認済みなら、残る安全な再監査・merge実行・post-merge verificationは`AI_CONTINUES`で完遂する。

### PR Communication Flow

- PR作業を開始する時点で、ユーザーへPRの目的を1文で先に示す。実装手段やファイル名より「何のための変更か」を優先する。
- 目的提示後からpre-merge checkpointまでは、Human Confirmation Pointや重大な安全/仕様問題がない限り、通常の工程進捗を逐次報告せずAIが自動継続する。テスト中、監査中、rebase中等の状態説明だけを理由に停止しない。
- 途中報告を行うのは、承認scope・仕様・安全境界・リスク境界を変える必要が出た場合、想定外差分、AI側で安全な復旧経路が尽きたgate failure、データ/費用/本番/破壊的操作等の重大事項で人間判断が必要な場合に限定する。安全に自動復旧できるtest/Git/tool/connector失敗は、原因調査・修正・経路再選択・再試行へ戻し、進捗報告だけで通常フローを終了しない。
- merge承認を求める直前のpre-merge checkpointでは、`目的`、`決まったこと・変更点`、`確認結果`、`注意点（なければなし）`だけを短く示す。長い工程ログ、全テスト名、途中経過は繰り返さない。
- pre-merge checkpointの直後にだけ`【次のアクション：マージ】`と`あなたの操作：「マージして」と返信`を出す。merge承認以外のHuman Confirmation Pointが残る場合は先に`確認後に次へ`で解消し、merge表示を混在させない。

## Stateful Stagnation Enforcement

Multi-step / long-running work must not remain in report-only mode while safe unfinished work remains. At task start and at status/checkpoint events, use the `preflight-audit` `stagnation-watch.mjs` gate (or an equivalent machine-readable invocation). It keeps a persistent work fingerprint and elapsed checkpoint state, escalates unchanged work from root-cause analysis to Forced Reflection to route hard-stop, and treats missed intervals as due checkpoints on the next invocation. A user status question does not itself create a human gate. If work is incomplete and no genuine human confirmation point exists, reporting status and stopping is not an allowed terminal action. Genuine merge, production, destructive, cost/data/workflow/ownership, and subjective real-device gates remain unchanged.
Before a progress/status response ends the turn, invoke the same gate with `--response-intent terminate`. The only allowed terminal states are `PRE_MERGE_READY`, genuine `HUMAN_CONFIRMATION_REQUIRED`, `COMPLETE`, and safe-AI-route-exhausted `BLOCKED`; `AI_CONTINUES` is rejected. A valid turn-ending response also requires the fresh non-null `turnCloseReceipt` returned by that exact invocation; without it, termination has no machine evidence.
If the platform itself forces the turn to end, use `--response-intent platform-turn-boundary`. Persist the exact resumable checkpoint plus `resumeCheckpointReceipt`, and resume from it on the next turn only when checkpoint integrity and exact branch/HEAD still match. A stale or invalid checkpoint stops for state re-evaluation rather than silently resuming. The gate still exits nonzero with `responseMayTerminate=false`, so a caller cannot use this flag to authorize a voluntary progress-only terminal response; the actual platform cutoff is the only exception. This remains AI-owned and does not create a human confirmation point.

The foundation does not require an always-on hourly GitHub Actions schedule in every application repository. Scheduling is an execution mechanism; the enforcement source is the stateful gate, so projects can use an already-available scheduler without creating unnecessary recurring runner cost or another service dependency.

## Evidence by Execution Location

安全確認は「毎回同じコマンドを人間に実行してもらうこと」ではなく、**実際に変更を作成・検証した場所から必要な性質を証明すること**を目的とする。

- local workspaceが変更作成・test・commitに使われた場合、local repository stateは重要な証拠なので省略しない。
- GitHub/remote branchだけで変更が作成され、local workspaceがその監査対象headの作成・testに関与していない場合、無関係なlocal working tree・stashはPR品質の証拠ではない。GitHubのexact head、base、merge-base、canonical diff、changed files、PR metadata等を使う。
- mixed経路では両方を確認し、同じheadを見ていることを証明する。
- `git diff --check`等の性質は、local audited headがある場合は通常のlocal commandを使う。remote-onlyの場合はcanonical diffに対する技術的に同等な検査を使ってよいが、literal commandを実行したとは記載しない。
- equivalent evidenceがない場合は`unavailable`/`UNKNOWN`のまま停止する。**確認そのものを省略してPASSにはしない。**
- tool間で機械的に取得できる情報を、非エンジニアの人間へコピー&ペーストさせない。経路不足が繰り返されるなら構造的自動化候補として扱う。

## Human Confirmation Points

以下に該当した場合のみ、通常フローを止めて人間へ確認する。

- 技術的根拠だけでは一意に決められない仕様・価値判断が必要な場合
- 承認済み基準・正本・デザイン・仕様から意味ある差分を生じさせる必要がある場合
- 人間の目的・業務方針・継続費用・責任分担・データ取扱い方針・日常の使い方に実質的な選択が残る場合。AIは先に技術調査・安全比較・推奨案を作り、非エンジニアでも判断できる説明を提示してから確認する
- 実機でしか判断できない主観的な見た目・操作感等
- 高リスクまたは破壊的な変更
- 本番環境または実データへ影響する操作
- 想定外の差分
- NG / UNKNOWNの原因が、人間にしか解消できない仕様・価値判断・認証・費用・本番/実データ・破壊的操作・保護データ方針等に該当し、AI側の安全な復旧経路が残っていない場合
- LOOP DETECTED（`learnings/L-0004.md`参照）
- 承認済みの対象PR・目的・仕様・価値判断・安全境界・リスク境界に実質的な変化があった場合。**SHA/HEADの変化だけでは該当しない。**
- merge実行時に有効な明示merge承認が存在しない場合、または`merge-authorization-gate`が`REAUTHORIZE`を返した場合

技術的に重要・大規模であっても、安全な設定値、構成方式、コマンド解釈、診断結果、内部実装方法などを技術的根拠で決められる場合はHuman Confirmation Pointへ昇格させない。AIが判断し、自動継続する。gateのSTOP/FAIL/UNKNOWNは検証対象の操作をfail-closedで止めるが、それ自体を人間へのhandoff理由にしない。

## Repeated Approval / Environment Friction

通常の安全な技術作業で同種の承認プロンプトや手作業が繰り返される場合、その場しのぎで毎回承認・再設定を続けない。

- 同種の承認・環境トラブルが概ね3回発生したら、個別対応を止めて根本原因を調査する。
- 同種の伝書鳩・手作業・AI間の人間中継が繰り返される場合も、個別回答だけで終えず、類似ケースを含む構造的な自動化候補として扱う。
- 調査対象は、CLI権限、PATH、settings、repository rules、harness/実行環境制約、upstream設定等を含む。
- 根本原因の修正自体が高リスク・破壊的・本番影響を伴う場合は、人間確認を取る。
- 人間にGit操作・test実行・SHA比較・PR監査等の安全な定型作業を繰り返し手作業させない。

## Anti-Loop

同系統の失敗を2回した場合の停止基準は`learnings/L-0004.md`を参照する。ここでは複製しない。

## Independent Review

担当外AIによる独立レビューの起動条件は`learnings/L-0005.md`を参照する。ここでは複製しない。

## AI / Human Role Split

役割分担確認とジョブ適性によるAI選択の基準は`learnings/L-0006.md`を参照する。各repositoryの`AGENTS.local.md`は既定の役割・明示制約、`roles/`は各AIの一般的な得意分野を示す参照情報として扱う。

## GitHub Actions Cost / Route Control

GitHub-hosted Actions is an execution route, not the default transport for technical work. Before pushing `.github/workflows/**` changes or choosing hosted Actions as an execution route, use `preflight-audit/github-actions-cost-guard.mjs`. Local editing/commit may prepare evidence without consuming hosted minutes, but the guard must PASS before the change is pushed or the hosted route is invoked.

For private repositories, prefer existing local/connector/self-hosted evidence when equivalent and safe. Temporary one-shot hosted workflows must not be used merely because another machine route is inconvenient. Under high quota pressure, reserve private hosted minutes for evidence that is independently required and cannot be produced by an equivalent safe route. `required-independent` is not a caller assertion: the exact workflow must be committed at the current HEAD and listed in the committed `.agents/github-actions-required-gates.json` registry. Persistent hosted gates must retain necessary safety while checking trigger duplication, path scope, concurrency cancellation, matrix/OS/runtime fan-out, and retry scope. When the current GitHub API/connector route proves failed-only rerun support, retry only failed work rather than successful jobs.

Paid overage, a budget increase, or any new recurring cost remains a Human Confirmation Point. Quota saving never authorizes removal of merge authorization, final-pr-audit, test-gate, security, production/data boundaries, or required independent Windows/device/platform verification.

Verification placement follows property equivalence: deterministic source checks prefer local execution; hosted/device execution is reserved for a distinct independent environment property that local evidence cannot equivalently prove. Do not run the same PR verification on both feature push and merged main unless the latter proves a distinct deployment/runtime property. After an exact tree-preserving merge on the audited base, post-merge verification reuses the pre-merge PASS test evidence instead of rerunning the full suite.
## Approved-Operation Route Fallback

承認済み操作の実行経路が利用不能になった場合の扱いは、一般原則を`learnings/L-0012.md`、GitHub連携における具体例を`learnings/L-0010.md`で扱う。ここでは複製しない。

## Project Context / Handoff Root Protection

### Ordinary-turn implicit continuation

通常ターンでも、Current Taskの選択よりactive Project Contextを先に確定する。特にユーザー入力が「次」「続けて」「進めて」等の継続意味だけで、新しいProject/対象を明示していない場合は、直前に触れた別Projectのtaskを暗黙再開してはならない。

前候補のProject Context ID/fingerprintを独立保持できる実行環境では、既存`project-context-guard.mjs`を`--turn-start`で実行する。入力はactive Project Rootのcanonical manifestと、active/candidate双方のProject Context ID/fingerprintを含むclosed stateとする。同一なら`TURN_CONTEXT_ALIGNED`、不一致なら`CROSS_PROJECT_CONTINUATION_BLOCKED`でfail closedし、active Project Rootのcanonical evidenceから次taskを再選択する。candidate identityが不明な場合も推測せずSTOPする。`--turn-start`はimplicit continuationだけを判定し、明示的なProject変更を承認しない。

ブラウザChatGPT等でこのCLI gateを機械実行できない場合、active ChatGPT Project/明示active projectを優先する同じ規則を運用適用するが、その環境での保護状態は`OPERATIONAL`であり`ENFORCED`ではない。

引き継ぎ・新チャット・session移管では、Project Root repositoryの `PROJECT_CONTEXT.json`（`repositoryRole=ROOT`）だけをhandoff identityの機械正本として扱う。Related RepoのmanifestはProject Rootを承認・再定義できない。

- Project Rootは projectContextId / project name / root repository / final objective / context fingerprint の組で固定する。
- Current Taskは別フィールドで管理し、rootと異なるrepositoryは常に `RELATED_REPO` とする。最近の作業量・作業時間・commit/PR数はroot判定材料に使わない。
- 生成stateはactive projectから保持した `establishedProjectContextId` と `establishedContextFingerprint` を必須とする。
- guardの `--render` で完全なProject Context envelopeを生成し、その出力を編集せず `--handoff-file` で再検証する。visibleな `##` sectionは Project Root -> Current State -> Related Work -> Next Action の4つだけとする。
- machine headerは1個だけ、Project Root/Current Task/safety固定fieldもartifact全体で各1個だけ許可する。artifactはmachine-rendered envelopeと完全一致が必要で、自由追記・追加heading/list/prose・再serializationもSTOPする。詳細な現在地はinbound envelope検証後にcanonical repository evidenceから取得する。
- canonical fileはProject Root repo rootの `PROJECT_CONTEXT.json` 固定。`thisRepository`はexact GitHub hostのlocal `origin`と一致必須で、lookalike hostやコピーmanifestはSTOPする。
- Project Context identityを変更すること自体はHuman Confirmation Pointであり、guardに自動transition modeはない。別途人間承認されたproject-definition変更として扱う。
- handoff本文には `AGENTS.local.md` の関連するForbidden Scope / Data and Security / Git rules / real-device / additional-cost条件を実データなしで明記し、参照先だけ残さない。

### Approved UI reference baseline

人間がUI画像を「採用」「基準」「これでいく」と明示した場合、その画像は会話内だけに残さず、application repositoryの `docs/ui-reference/` にproject-local正本として保存する。詳細な保存形式・archive・再現検証は `handoff` skillの Approved UI Reference Authority を正本とする。

この仕組みは承認済み画像がある場合だけ発動する。非UI projectや未確定デザインにはfolder追加を強制しない。承認済み画像はCanonical Contractの `DESIGN / REFERENCE_IMAGE` artifactとHuman Decision Syncへ結び、turn-start / preflight / final auditで既存Canonical Contract Gateを再利用して古い画像・scope不一致・CURRENTの二重化をSTOPする。完成デザインへ切り替えた時点で仮/旧UIとAI記憶は見た目の根拠から外し、既存実装はロジック・データ挙動だけを参照する。忠実再現は `UI_REFERENCE_REPRODUCTION` として扱い、実装前に `ui-reference-reproduction-gate.mjs` で正本・Overlay確認済み寸法・許容値・検査スクリプト・表示条件・固定synthetic dummy dataを固定し、その `protectedPaths` をClaude実装経路の `forbiddenScope` に渡す。EARLY / MILESTONE / FINAL REALITYの合否はDOM/CSS数値計測を主判定とし、同一検査IDの3回連続FAILはSTOPする。スクリーンショット・Overlay・Pixel diffはズレ位置確認とPR証拠の補助に限定し、数値FAILを上書きしない。

### Human Decision Sync

When a project opts in through `canonicalContract.requiredValidation: ["human-decision-sync"]`, tracked explicit human decisions live in `PROJECT_CONTEXT.json.humanDecisionSync`. `CONFIRMED` is current authority, `DEPRECATED` remains visible but cannot be reused, `UNRESOLVED` remains open, and `PROPOSED` is never promoted merely because an AI suggested it. `project-context-guard.mjs --turn-start` loads this state together with `currentState` and `nextAction`; conversation memory, summaries, old chats, and stale documents are subordinate evidence.

A new explicit human decision that changes an existing topic is synchronized into the tracked registry and the replaced decision is marked `DEPRECATED` before implementation continues. Human Decision Sync reuses the existing Canonical Contract for artifact authority; it does not add a second database or cloud service. Repositories that have not yet opted in remain valid during staged rollout, while portfolio governance reports adoption separately.

### Project-local focus/reference memory

Project Contextを確定した後、local repository実行経路が使える場合は `handoff/project-working-memory.mjs` を使い、Current Goal / Approved Reference / Next Stepをproject-localのGit管理外working memoryへ退避する。人間判断の正本はtrackedなHuman Decision Syncだけとし、working memoryには二重のdecision台帳を持たない。focusがcanonical decision IDを参照する場合は、そのIDがHuman Decision Syncの現行`CONFIRMED`に存在することを毎回検証する。Project Context ID/fingerprintとexact GitHub originに一致しないmemoryはSTOPする。

旧schema v1のlocal memoryが見つかった場合は、目標・参照・次の手を残しつつlocal decision copyとその旧リンクを落としてschema v2へ縮小移行する。過去成果物の提示では `VERIFIED / UNVERIFIED / INFERENCE / NEWLY_CREATED` を混同せず、元実物が未確認なら過去成果物として提示しない。再現する場合は元実物が見つからない理由を先に示し、`NEWLY_CREATED`として扱う。患者・医院・請求・売上・資格情報・その他の保護対象実データはworking memoryへ保存しない。

人間が「これでいく」「これは未決定」「この画像を基準にする」等を明示した場合、その判断はHuman Decision Syncへ同期し、AI推測とは分離する。人間の価値・仕様判断が未確定なら、AIは技術比較・探索・検証までを進め、最終選択を推測で確定しない。ブラウザだけでlocal helperを機械起動できない経路は `OPERATIONAL` であり、普遍的な `ENFORCED` と表現しない。

### Portfolio coverage audit

新しいrepositoryの追加後、Foundation更新後、またはProject混同対策の全体適用状態を確認するときは、Foundation rootで `node tools/portfolio-governance-audit.mjs --pretty` を実行する。

このFoundation-only toolはGitHub Actionsを常駐させず、現在のauthenticated ownerのrepository inventoryを取得し、active repositoryのdefault branchに対してFoundation canonical blob identity、configured Claude wrappers、`PROJECT_CONTEXT.json`、ROOT/RELATED relationship、Human Decision Syncのvalid/configured状態、current turn-start guardを一括監査する。さらに`common-rule-health-audit.mjs`を自動実行し、共通ルールの`DECLARATION_ONLY`、実装/test欠落、未索引learning、Markdown肥大化・重複候補を同じ監査で可視化する。version記録だけではCURRENTと判定しない。

GitHub inventory/tree/blob evidenceが取得不能・不完全・truncatedの場合、新規repositoryにFoundation/Project Contextが無い場合、Related Repoのroot identityが一致しない場合、またはcurrent turn-start guardが一致しない場合はSTOPする。archived/disabled repositoryはinventory countへ含めるがactive coverageから除外する。

## Local AI Handoff

同一PC上のローカルAI CLI間（V1：Claude Code ↔ Codex CLI）でのファイル経由ハンドオフの手順は`local-ai-handoff`スキルを参照する。ここでは複製しない。GPT（ブラウザ版）はローカルファイルを読めないため対象外であり、そのまま次節の`[AI_HANDOFF]`（GitHub PRコメント）を使う。

## [AI_HANDOFF]

PRの最終監査結果は、PRのConversationへ`[AI_HANDOFF]`で始まるコメントとして投稿する。最低限、以下を含める。

- RESULT（MERGE READY / NOT READY）
- head SHA / base SHA
- changed files数
- commit数
- diff scope
- verification結果
- blockers
- mergeable / mergeStateStatus

## Stop Conditions（要約）

想定外差分、NG、UNKNOWN、要件矛盾、security/privacy/data-loss risk、LOOP DETECTED、人間にしかできない価値判断、未承認の人間価値/責任選択、または有効なmerge承認が存在しない状態。承認後のHEAD変更そのものは停止・再承認理由ではなく、最新HEAD再監査と`merge-authorization-gate`判定のトリガーとする。詳細は「Human Confirmation Points」および各`learnings/L-000X.md`を参照する。
