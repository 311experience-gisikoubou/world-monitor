# World Monitor（世界情勢ダッシュボード）

このリポジトリは、公式 [World Monitor](https://www.worldmonitor.app/) を確認・利用するための入口です。

## 最も簡単：公式サイトと同じ動きを見る
- [World Monitor 公式サイトを開く](https://www.worldmonitor.app/)
- Windows の場合は `Open-Official-WorldMonitor.url` をダブルクリックしても同じ公式サイトを開けます。

## 自分のPCで公式ソースを起動する場合
公式開発元 `koala73/worldmonitor` のソースを、Git サブモジュール `official/` に**特定のコミットで固定**して参照しています。独自の模倣画面は作りません。

1. Node.js 22以上、Git がある Windows PC を利用します。
2. リポジトリを Git で取得し、`start-world-monitor.cmd` をダブルクリックします。
3. 初回のみ公開ソースと npm の依存パッケージを取得します。自動的な有料API契約は行いません。
4. 開いたブラウザで `http://localhost:3000/` を確認します。終了するには起動したコマンド画面で Ctrl+C を押します。

### 大切な違い・限界
- **公式サイトと完全に同じ表示・最新データ・機能を利用するには、公式サイトを開いてください。**
- ローカル版はAPIキー、データ取得バックエンド、キャッシュ、サーバー機能の有無により、公式サイトと表示・動作が異なることがあります。新たな課金やAPI契約はしません。
- ソースコードの利用・改変・配布では公式の `AGPL-3.0-only` ライセンスを守ってください。ライセンスは `official/LICENSE` を参照してください。
- このリポジトリの `AGENTS.md` 等のAI共通基盤設定は変更していません。

## 不具合の原因（2026-10-09確認）
修正前の `main` には `src/`・`index.html`・`package.json` などのアプリ本体がなく、AI共通基盤の設定ファイルのみが入っていました。そのため公式World Monitorと同じアプリにはなっていませんでした。

公式ソース: https://github.com/koala73/worldmonitor
