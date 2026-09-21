# AGENTS.md

## 役割

このrepositoryは、複数のAIツールと複数のアプリケーションrepositoryで共通利用する開発基盤の正本です。特定のAIツール・特定のプログラミング言語・特定のアプリケーションに依存しない内容だけを扱います。

各アプリケーションrepository側には、この内容をversion付きの同期コピーとして取り込んで利用します。

このファイルは、`CORE.md`（最上位安全原則）・`OPERATIONS.md`（運用の地図）・`PROJECT_COMPLETION.md`（完遂ロードマップと必要性精査の詳細正本）・`learnings/`（再発防止事項）・各アプリケーションrepositoryの`AGENTS.local.md`（固有ルール）への入口です。詳細規則の本文はこのファイルへ複製せず、該当文書を参照します。

## 読む順番

### このrepository（ai-dev-foundation）自体で作業する場合

1. `CORE.md`（最上位安全原則）
2. `AGENTS.md`（このファイル）
3. `OPERATIONS.md`（運用の地図）
4. `PROJECT_COMPLETION.md`（完遂ロードマップ・完成条件・必要/不要精査の詳細）
5. `roles/`（作業するAIの一般的な役割）
6. `learnings/INDEX.md`（既存の再発防止事項）

### このrepositoryの内容を導入したアプリケーションrepositoryで作業する場合

1. `AGENTS.md`（このファイル。共通ルール）
2. `AGENTS.local.md`（そのアプリケーションrepository固有のルール）
3. `CURRENT_STATUS.md`（存在する場合。現在地点だけを持つ短い正本）
4. そのアプリケーションrepositoryの業務仕様の正本
5. 該当する共通スキル
6. repository内の実装・テスト・設定

この順番は、特定のAIツールが持つ機能（import構文など）に依存せず、どのAIが読んでも同じ手順で進められるようにするためのものです。

`CURRENT_STATUS.md`は仕様書や履歴の代替ではない。存在する場合は作業再開時に必ず読み、記載内容をコード・PR・gate等の証拠より優先して「実装済み」と判断してはならない。

## 安全原則・運用ルールの所在

- 最上位の安全原則（`main`への直接commit禁止、force push等の破壊的操作の扱い、secrets/個人情報/実データの扱い等）は`CORE.md`にあります。ここでは複製しません。
- 実装前後の監査、commit/push/PR/mergeの定型フロー、人間確認が必要な地点、anti-loop、独立レビュー、承認済み操作の経路フォールバックは`OPERATIONS.md`にあります。ここでは複製しません。
- プロジェクト完遂ロードマップ、完成条件、必要/不要精査、残件管理の詳細正本は`PROJECT_COMPLETION.md`にあります。アプリケーションrepositoryへ同期されるこの`AGENTS.md`にも、必須の共通原則を下記「完遂ロードマップ共通原則」として保持します。
- 個別の再発防止事項・詳細ルールは`learnings/`にあります。ここでは複製しません。
- 各AIの一般的な得意分野・典型的な役割は`roles/`にあります。実際の担当はジョブ適性で選択し、各アプリケーションrepositoryの`AGENTS.local.md`にある役割記述は既定値・制約として扱います。明示的な安全・権限・責任・費用・データ取扱い・human approval境界は上書きしません。

## ルール状態の表現

重要なルール・提案・改善事項は、実際の状態を次の3つに分けて表現する。

- `ENFORCED`：コード、設定、CI、script、gate等で技術的に強制され、確認可能な証拠がある。
- `OPERATIONAL`：有効な運用ルールとして採用済みだが、技術的な強制は未実装または一部のみ。
- `PROPOSED`：提案・設計候補。まだ有効な運用ルールとして扱わない。

会話上の合意、Markdownへの記載、テンプレート追加だけを理由に`ENFORCED`と表現しない。`ENFORCED`と記載する場合は、何が強制しているかを確認できなければならない。

既存の`DECLARATION_ONLY` / `OPERATIONAL` / `TECHNICAL_ENFORCEMENT_REQUIRED`は「そのルールに必要な強制レベル」の分類であり、上記の「現在の実装状態」とは別軸として扱う。技術的強制が必要なのに未実装なら、現在状態は`OPERATIONAL`のままであり`ENFORCED`とはしない。

## CURRENT_STATUS運用

長期・複数段階のapplication projectでは、repository rootの`CURRENT_STATUS.md`を現在地点の短い正本として利用する。新規導入時は`templates/CURRENT_STATUS.md.template`を基準とする。

- 保持するのは現在Phase、branch、PR、直近gate、Blocker、次の1 action、人間操作要否、merge承認状態、更新日程度に限定する。
- 長い仕様、過去ログ、詳細テスト結果、設計判断の全文を複製しない。それらは既存正本へ残す。
- 残件に実行環境の違いがある場合、`PC-free work`に「プロジェクトPC・ローカルruntime・実機なしで安全に進められる作業」、`PC-required work`に「それらが必要な作業」を短く分けて保持する。
- ユーザーが外出先・PCなし等の制約を示した場合、または「今できる作業」を求めた場合、AIは`CURRENT_STATUS.md`だけでなく取得可能なPR・Issue・仕様・gate等の証拠も確認し、PCなしで進められる残件を洗い出す。複数projectを確認できる場合は横断して比較する。
- PCなし候補は、**完成を止めている重要作業 → PRを前進できる作業 → 仕様確定 → 監査・レビュー → 文書整理 → 将来拡張**の順を基本に、手戻りリスクも考慮して優先する。ユーザーへの提案は原則として上位3〜5件に絞る。
- 承認済みscope内で安全に実行可能なPCなし作業は、提案だけで止めずAIが継続してよい。仕様・価値判断などHuman Confirmation Pointが残る作業は、技術調査と推奨案まで作って人間へ返す。
- PC必須作業は一件ずつ人間へ返さず、可能な限りまとめて`PC-required work`として保持する。PC必須のBlockerがあっても、独立した安全な`PC-free work`が残る場合はプロジェクト全体を機械的に停止扱いにしない。
- PR、主要タスク、Blocker、merge状態、またはPC要否の分類が変わった時に更新する。
- `CURRENT_STATUS.md`だけを根拠に「実装済み」「強制済み」「テスト済み」と断定しない。実装・gate・PR等の証拠と矛盾する場合は証拠を優先し、statusを修正する。
- `Merge authorized: YES`は、有効な人間の明示merge承認が存在する場合だけ使用する。
- ユーザー向けの進捗・完了報告では、冒頭に次の状態を必ず1つだけ明示する：`【次のアクション：マージ】` / `【次のアクション：確認後に次へ】` / `【次のアクション：AIが自動継続】` / `【状態：完了】`。直下に`あなたの操作：<具体的な1操作または不要>`を置く。
- `【次のアクション：マージ】`は、必要なテスト・監査が完了し、merge承認だけが残る時だけ使う。すでに有効なmerge承認がある場合は再承認を求めず`AIが自動継続`としてmerge完了まで進める。
- `【次のアクション：確認後に次へ】`はHuman Confirmation Pointが実際に残る時だけ使い、確認内容を1つに絞る。技術作業だけが残る場合は`【次のアクション：AIが自動継続】`とし、報告だけで停止しない。
- 状態の整合は次で固定する：`MERGE` = `User action required: YES`かつ`Merge authorized: NO`かつ他のHuman Confirmation Pointなし、`CONFIRM_THEN_CONTINUE` = `User action required: YES`かつmerge承認以外のHuman Confirmation Pointあり、`AI_CONTINUES` = `User action required: NO`、`COMPLETE` = `Status: COMPLETE`かつ`User action required: NO`。`Merge authorized: YES`の進行中状態は`MERGE`に戻さず`AI_CONTINUES`とする。
- merge-readyに見えても、仕様・価値判断・本番/破壊的操作・主観的実機確認などmerge承認とは別のHuman Confirmation Pointが1つでも残る場合は`CONFIRM_THEN_CONTINUE`を使う。その確認が解消した後、merge承認だけが残れば初めて`MERGE`へ移る。
- PRを作る目的は、PR作業の開始時にユーザーへ1文で分かりやすく提示する。技術名ではなく「何を良くするPRか」を先に示す。
- 目的提示後、Human Confirmation Pointや安全上の重大問題がなければ、実装・テスト・監査・修正・push・PR作成・final auditを途中報告のためだけに止めず、マージ直前まで自動継続する。
- ユーザーが「マージ手前まで」を明示した場合、完了目標は`PRE_MERGE_READY`とする。必要修正とtest-gate PASS、commit、通常push、Draft PR、final-pr-audit PASS、exact PR / exact HEAD確認を完了し、merge承認だけを残す。
- gateの`STOP`/`FAIL`/`UNKNOWN`は、その試行や危険操作をfail-closedで止める意味であり、それだけではHuman Confirmation Pointではない。承認済みscope内の原因調査・修正・安全な経路変更・再試行はAIが継続する。
- 途中報告は、仕様/安全境界の実質変更、想定外差分、AI側で安全な復旧経路が尽きたgate失敗、データ/費用/本番/破壊的リスクなど、人間判断またはscope変更が必要な重大問題が出た時に限る。AIだけで安全に復旧できる一時的な経路失敗や通常の長時間テスト進行は報告理由にせず、進捗報告だけをterminal actionにしない。
- Before ending a turn with a progress/status response, run `stagnation-watch.mjs --response-intent terminate`. Only `terminalState=PRE_MERGE_READY|HUMAN_CONFIRMATION_REQUIRED|COMPLETE|BLOCKED` may terminate; `AI_CONTINUES` must keep executing.
- A turn-ending response is valid only when that exact terminate invocation returns a non-null `turnCloseReceipt`. The receipt is bound to work id, branch/HEAD, workflow fingerprint, terminal state, and issuance time; no receipt means no machine evidence to end the turn.
- An unavoidable ChatGPT/tool turn limit is `--response-intent platform-turn-boundary`: persist the exact continuation checkpoint and its `resumeCheckpointReceipt`, then resume next turn only when checkpoint integrity and exact branch/HEAD still match. A moved HEAD or invalid receipt requires state re-evaluation instead of stale resume. The gate remains nonzero/fail-closed with `responseMayTerminate=false`; this flag never grants permission for a voluntary progress-only response to end the turn. It is not a Human Confirmation Point, and repository code must not claim to remove the platform runtime limit.
- マージ承認を求める直前には、`目的 / 決まったこと・変更点 / 確認結果 / 注意点（なければなし）`を簡潔に報告し、その後に`【次のアクション：マージ】`と`あなたの操作：「マージして」と返信`を置く。
- Before a local audit/worktree uses a remote-tracking base such as `origin/main`, run the `preflight-audit` live-base-ref guard. The live remote branch ref is authoritative; a stale/missing local tracking ref is a STOP until AI refreshes the exact ref and rechecks.
- Before implementation authority is selected, validate `PROJECT_CONTEXT.json.canonicalContract` with the Canonical Contract Gate. CURRENT authority wins over repository history, SUPERSEDED/HISTORICAL/DRAFT artifacts cannot drive implementation, and Functional PASS cannot compensate for Contract Gate FAIL. Normal PASS adds no human confirmation.
- When a human explicitly adopts a UI image as the baseline, use the `handoff` skill's Approved UI Reference Authority: persist it under `docs/ui-reference/`, bind it to the CURRENT Canonical Contract `DESIGN / REFERENCE_IMAGE` artifact and Human Decision Sync, and treat implementation as reproduction rather than redesign. Projects without an approved UI image do not create this structure. A stale/missing/mismatched registry or image is a Contract Gate STOP; inability to perform screenshot comparison must be reported as unverified, not as reproduction complete.
- When `canonicalContract.requiredValidation` includes `human-decision-sync`, treat `PROJECT_CONTEXT.json.humanDecisionSync` as the tracked authority for explicit human-confirmed mutable decisions. Only `CONFIRMED` decisions may drive implementation; `DEPRECATED`, `PROPOSED`, and `UNRESOLVED` selections STOP. Conversation memory, summaries, old chats, local working memory, and AI inference never outrank this tracked state. A new explicit human decision must be synchronized to the registry before implementation continues.
- Actual merge execution must use the exact-PR / exact-HEAD authorization receipt gate defined by `final-pr-audit` **and** prove the current base SHA still equals the base SHA covered by the latest PASS audit; a status flag or continuation instruction alone never authorizes merge execution.
- When the target branch lacks verified server-side merge protection, PRs must stay Draft until the active conversation directly receives explicit merge authorization. Only that merge-coordinator flow may unlock Draft->Ready, immediately re-run the exact-HEAD + exact-audited-base gate, and merge. Direct writes, ref updates, or contents writes to `main` are prohibited as a bypass.
- A merged PR with no valid pre-merge exact-PR/exact-HEAD authorization receipt is an `UNAUTHORIZED_MERGE_INCIDENT`; later approval is not retroactive, and subsequent merge operations enter MERGE FREEZE until the human resolves the incident.

## 共通ルール変更ゲート

- 共通ルール・共通スキル・共通学習を追加または変更しようとした場合、正本へ書き込む前に必ず`common-rule-integration-audit`を実行する。
- 「新しい共通ルールを思いついた = 新規追加」にはしない。まず既存正本との重複・類似・矛盾・陳腐化・統合可能性・common/local scopeを監査する。
- 監査結果は`MERGE_EXISTING` / `NEW_COMMON` / `LOCAL_ONLY` / `REJECT` / `HUMAN_DECISION`のいずれかとして明示する。
- 既存ルールへ統合可能なら、新規ルールを増やさない。repository固有なら`AGENTS.local.md`等へ置き、commonへ昇格させない。
- 正本への追加・統合・削除・deprecated/superseded化は、人間承認後のみ実施する。
- 詳細は`learnings/L-0003.md`および`.agents/skills/common-rule-integration-audit/SKILL.md`を参照する。

## 安全運用強制ゲート

- 安全な読み取り、調査、テスト、監査、定型確認はAIが自動で進める。
- 機密データへのアクセス、外部送信、破壊的・不可逆操作、安全性`UNKNOWN`の実データ経路は停止する。
- 技術的安全性はAIが証拠で判定し、人間へエンジニア知識を要求しない。判定不能なら人間に技術判断を丸投げせず`UNKNOWN`として停止する。
- **技術的に重要・大規模・専門的というだけで人間確認へ戻さない。** 安全な設定値、構成、診断、実装方法、承認済み方針内の方式選択はAIが判断して自動継続する。
- 人間へ判断を返すのは、技術的根拠だけでは一意に決められず、人間の目的・業務方針・継続費用・責任分担・データ取扱い方針・日常の使い方などに実質的な選択が残る場合だけとする。AIは先に技術調査・安全比較・推奨案を作り、非エンジニアでも判断できる説明を提示する。
- ジョブ開始時と、実行AI・実行経路・必要権限・実行環境が重要に変わる時は、現在利用可能なAI・CLI・connector・実行経路を確認し、利用可能性と必要権限を機械的に確認できた新しい経路も候補へ自動的に加える。その上で、作業内容、AIの得意分野、必要な権限・tool、実行環境、安全性・privacy境界、文脈保持、独立監査の必要性、追加費用を確認し、取得可能で信頼できる場合は使用量・残量/上限・予想処理負荷も加味して、利用可能なAIの中からジョブ適性で実行者・監査者を選択する。単一AIの利用最大化を目的にせず、利用可能なAI全体の処理効率・残量・追加費用を最適化する。能力・安全性・品質が実質同等なら、残量に余裕があり追加費用が少ない経路を優先する。新しいAI・CLI・connectorが追加されたことだけを理由に共通ルールの個別改訂を要求せず、既存の選定規則で評価する。ただし、インストール済み・接続済みであること自体は、機密データ、本番権限、有料利用、merge権限等の承認を意味しない。利用可能な場合は`preflight-audit`の`ai-capacity-observer.mjs`を使用量・残量判断の優先的な機械証拠として使い、`UNAVAILABLE`を推測で補わない。実際の使用量・残量を取得できない場合は現在の配分が最適と断定しない。
- Before a private-repository GitHub-hosted Actions route is invoked, or before `.github/workflows/**` changes are pushed and can consume hosted minutes, run `preflight-audit` `github-actions-cost-guard.mjs`. Prefer equivalent safe local/connector/self-hosted evidence; at high quota pressure allow only machine-registered `required-independent` hosted gates. `required-independent` is not a caller assertion: the exact workflow must match the committed current-HEAD `.agents/github-actions-required-gates.json` registry. Review trigger duplication, path scope, concurrency/cancel behavior, matrix/OS/runtime fan-out, and rerun scope. When current GitHub API/connector capability evidence proves failed-only rerun support, do not rerun successful jobs. Required independent safety gates remain intact, and paid overage still requires a separate Human Confirmation Point.
- `AGENTS.local.md`のAI役割記述は既定値・repository固有制約として確認するが、単なる過去の担当や通常経路を永久固定の割り当てとは扱わない。明示的な安全・権限・責任・費用・データ取扱い・human approval境界は常に維持する。
- 同じ検証propertyをworkflow段階ごとに儀式的に繰り返さない。決定的なsource testは原則local、独立OS/clean-room/device等の追加propertyだけを必要なhosted/実機経路で確認し、exact HEAD/base/treeが不変なら既存PASS evidenceを再利用する。feature pushとmerge後mainで同一CIを二重実行したり、tree-preserving merge後にfull testを再実行したりしない。
- AIだけで安全に解決できる実行者・経路の技術選択を、非エンジニアの人間へ返さない。詳細は`learnings/L-0006.md`に従う。
- **シンプルイズベストを安全運用の共通原則とする。** 安全性・必要機能・復旧可能性・監査可能性を満たす案の中で、外部依存、構成要素、データ経路、設定箇所、人間の手順、維持管理負担が少ない案を優先する。安全を削る単純化と、必要性のない複雑化の両方を禁止する。
- 目的・要件が固まり、非自明な機能を独自実装する前、または新しい依存・サービスを導入する前に、既存の承認済み仕組みと再利用可能なOSS・package候補を調査する。GitHubや公式package ecosystem等に有力候補がある場合は原則3〜5件を比較し、用途適合性、ライセンスの明確さ/互換性、ローカル・オフライン実行可否、外部通信/telemetry、security/privacy、対象OS、保守状況、依存・build/runtime負荷、更新・撤去負担を確認する。安全かつ単純に目的を満たせる既存解があれば再利用・組み合わせを優先し、不足部分だけを最小実装する。候補数は数合わせせず、OSSが存在すること自体を採用理由にしない。
- 同種の伝書鳩・手作業・承認往復が繰り返される場合、個別対応だけで終えず、類似ケースを含む構造的な自動化候補として扱う。ただし自動化によって安全性を下げない。
- 長時間・複数段階の作業では、同じ製品tree・製品の未commit差分・blocker・failure・route等が一定checkpoint期間変わらない停滞を状態付きで検出し、原因分析→Forced Reflection→別routeへの強制昇格を行う。管理ファイルだけのHEAD変更は製品進捗として扱わない。未完了でhuman gateが無い場合、ユーザーの状態確認質問に報告だけして停止せず、安全な次工程を継続する。詳細と機械gateは`preflight-audit`の`stagnation-watch.mjs`を正本とする。
- 各ユーザー作業ターンの開始時は、Current Taskを選ぶ前にactive Project Contextを先に固定する。特に「次」「続けて」「進めて」等だけの曖昧な継続指示では、直前に触れたrepository・PR・taskの新しさをProject選択根拠にしない。前候補のProject Context ID/fingerprintを機械的に保持できる実行環境では`.agents/skills/handoff/project-context-guard.mjs --turn-start`を使い、active/candidateが一致する場合だけ暗黙継続する。不一致は`CROSS_PROJECT_CONTINUATION_BLOCKED`でSTOPし、active Project Rootから次taskを再選択する。
- ブラウザChatGPT等、前候補identityの独立保持やCLI gate実行を機械強制できない環境では、この通常ターン保護は`OPERATIONAL`であり`ENFORCED`と表現しない。その場合も現在選択中のChatGPT Projectまたは明示active projectを直前の別Project文脈より優先し、短い継続指示だけで別Projectへ移らない。別Projectを明示した依頼は通常のscope/ownership確認へ進める。
- 引き継ぎ・新チャット開始・session移管では、Project Root repositoryの固定`PROJECT_CONTEXT.json`（`repositoryRole=ROOT`、`thisRepository`は正確なGitHub `origin`と一致必須）だけをhandoffの機械正本として扱い、`.agents/skills/handoff/project-context-guard.mjs`を必ず通す。Related Repo自身のmanifestをProject Rootの権威として使わない。active contextの`projectContextId`と`contextFingerprint`を保持し、Current Task repositoryがProject Rootと異なる場合は自動的に`RELATED_REPO`へ格下げする。guard生成artifactを完全なProject Context envelopeとしてそのまま使い、自由追記・書換え・追加見出しを許可しない。完成artifactは機械生成envelopeとの完全一致を再検証し、別Project Contextや任意追記をfail closedでSTOPする。詳細な現在地はenvelope検証後にcanonical repository evidenceから読み直す。Project Context identityの変更は通常の技術修正ではなく人間のproject ownership/goal変更として別途明示承認を要する。冒頭順序は必ず Project Root → Current State → Related Work → Next Action とする。
- 実装・変更・外部サービス利用・ネットワーク変更・データ経路変更の前には`preflight-audit`を実行する。preflightで外部AI/クラウド/API/GitHub、AIやtoolの実データアクセス権、repository visibility、LAN公開範囲、logs/backups/TEMP等の残存可能性まで確認する。
- preflightでは、実際の作業対象に必要な`AGENTS.md`・`AGENTS.local.md`・存在する`CURRENT_STATUS.md`・業務仕様の正本を確認してから変更へ進む。読み取れない正本が安全性やscopeに影響する場合は推測で補わない。
- **承認済み基準保護を全project共通ルールとする。** 人間が基準画像・正本・承認済みデザイン・承認済み仕様・確定済み名称/構造/業務フロー等として固定したものを、AI判断で再設計・再解釈・「改善」して変更しない。移植・実装・再現では基準を先に忠実に保持し、基準にない意味ある追加・削除・移動・再構成が必要ならHuman Confirmation Pointとして差分を示して明示承認を得る。コードや設計書は未実装機能確認の証拠には使えるが、別の承認済み基準を無断で上書きする根拠にはならない。
- preflightでは実装前に作業所有権も確認する。少なくとも「この作業は現在のrepository / 共通基盤のscopeか」「専用application projectや別workstreamが正本として既に進行していないか」「同じIssue / PR / 実装を二重に作らないか」を、取得可能な`CURRENT_STATUS.md`・Issue・PR・branch・仕様等の証拠で確認する。
- 専用project / repositoryで同じ製品タスクが既に進行している場合、別workstreamから新しいbranch・Issue・PR・製品実装を開始しない。その状態は共通運用改善の観測材料としてのみ使い、現在のworkstreamが所有する次の安全なタスクへ進む。明示的な移管・完了・再開根拠がある場合だけ所有権を変更する。
- 「AIは読まない」「外へ出さない」という宣言だけで安全確認済みとしない。必要ならアクセス不能化、分離、自動検査、fail closed等の技術的強制へ進める。
- 新しい重要ルールが決まった時点で、AIは`DECLARATION_ONLY` / `OPERATIONAL` / `TECHNICAL_ENFORCEMENT_REQUIRED`のどれかを判定する。技術的強制が必要なのに未実装なら、その状態を明示して実データ用途を進めない。

## 完遂ロードマップ共通原則

すべての開発プロジェクトで、実装開始前に「何を作るか」だけでなく「どこまで作れば完成か」を定義する。

- 主目的、完成条件、対象範囲、対象外、他アプリとの役割分担、完遂までのPhase、各Phaseの出口条件を先に定義する。
- 未完了項目・提案・Issue・TODOは、A:完成必須 / B:便利 / C:将来拡張 / D:他アプリの役割なので不要 / E:実装済みで文書が古いだけ / F:ドキュメント整理のみ、のいずれかへ分類する。
- 各項目は、未完成修正 / 追加機能 / ドキュメント修正の種別も明示する。
- 追加機能は自動採用しない。主目的・完成条件・実運用上の必要性・役割重複・二重入力・維持コスト・正本設計への影響を確認する。
- 同じ目的を満たすなら、既存機能の再利用・統合・削減を、新しい依存関係・サービス・設定・管理対象の追加より優先する。
- 「作れるから」「昔の設計書や予定に残っているから」だけを実装理由にしない。
- 他アプリが担うべき機能は完成必須から外し、scope外または移管候補として明示する。
- PR、Issue、主要タスクの完了後は、現在Phase、完成必須の残件数、今回完了数、次の必須タスク、Blocker、追加機能候補、不要判定項目を更新する。
- 個別作業だけを追い、プロジェクト全体の残り距離を見失わない。
- 安全性、privacy、data-loss prevention、バックアップ、復元、migration整合性は最後にまとめず、全Phaseで並走させる。
- 「完成」は機能数ではなく、主目的の業務フローを安全かつ実用的に最初から最後まで完遂できることで判定する。便利機能・将来拡張は完成後へ回してよい。

詳細な棚卸し条件、Phase管理、完成判定は共有正本`PROJECT_COMPLETION.md`に従う。

## 実装原則（このrepository固有）

- 具体的な技術コマンド（ビルド・lint・テスト等）は、各アプリケーションrepository側の`AGENTS.local.md`を参照する。
- 共通基盤側には、技術スタック固有のコマンドを追加しない。

## スキル運用

- 通常の自然言語による依頼から、必要なスキルを自動的に選択する。
- ユーザーへ、不要なスキル名の選択を求めない。
- 複数のスキルが必要な場合は、組み合わせて使用する。
- 新しいスキルを追加する場合は、先に`common-rule-integration-audit`で既存スキルとの重複・必要性・優先度・scopeを確認する（`learnings/L-0003.md`も参照）。
- 共通スキルは、特定の言語、特定のpackage manager、特定のframework、特定のrepository名、特定の絶対パスを名指ししない。
- 技術スタック固有の手順は、共通スキルではなく各アプリケーションrepository側の`AGENTS.local.md`に置く。

## 同期コピーの扱い

- 各アプリケーションrepository側にある`AGENTS.md`と`.agents/skills/`以下は、この共通repositoryからの同期コピーである。
- 同期コピーは、アプリケーションrepository側で直接編集しない。
- アプリケーション固有のルールは、`AGENTS.local.md`にのみ記載する。
- 共通ルールを変更する場合は、まずこの共通repository側へ変更を反映し、`VERSION`を更新してから、各アプリケーションへ同期する。
- 同期の際は、同期元のversionとcommit SHAを記録する。
- `CORE.md`・`OPERATIONS.md`・`PROJECT_COMPLETION.md`・`roles/`は、本Governance Expansion時点ではアプリケーションrepositoryへの同期対象に含めていない（`README.md`「想定する同期対象」参照）。同期対象化は将来の検討事項とする。
