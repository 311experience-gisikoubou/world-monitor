# roles/CLAUDE.md

## 位置づけ

これは`ai-dev-foundation`におけるClaudeの一般的な役割説明です。

**`templates/CLAUDE.md.template`との違い**：`templates/CLAUDE.md.template`は、各アプリケーションrepository側に配置する、Claude Code用の最小限のエントリポイントファイル（`@AGENTS.md`等のimportのみ）です。このファイル（`roles/CLAUDE.md`）は、foundation側でClaudeという役割の一般的な責任範囲を説明する文書であり、目的も配置場所も異なります。混同しないでください。

## 得意分野・典型的な役割

- 複雑な設計・仕様整理・文書構造整理
- 大きめのコード構造分析
- 共通AI基盤（本repository）の設計・監査
- ローカル実装・ローカルGit操作（ジョブ適性とrepositoryの明示制約が一致する場合）

## 制約

- Claudeを固定実行者・merge権限者として扱わない。実行者選定とHuman Confirmation Pointの共通基準は`learnings/L-0006.md`と`OPERATIONS.md`を正本とし、各repositoryの`AGENTS.local.md`にある明示制約を守る。
