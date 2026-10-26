# 選考タイムライン（第2弾）ローカル確認・運用メモ

このフォルダはローカル確認専用です。本番サーバー（`api-server/server.js`）からは読み込まれません。
PostgreSQL・Supabase・Render・`.env`・メール送信には接続しません（架空データをメモリ上で扱います）。

## ローカルプレビュー

```
cd react-app
npm run build
cd ..
node tools/preview/preview-server.cjs                    # 選考履歴テーブルありの状態
node tools/preview/preview-server.cjs --no-history-table # DB適用前（従来の進捗更新）の状態
```

- URL: http://127.0.0.1:5188/
- ログイン: `preview` / `preview-only`（プレビュー専用）
- 架空データ11件。終了すると更新内容は消えます。
- 画面の住所検索ボタンは既存機能として外部の郵便番号API（zipcloud）を呼びます。

## 第三者による再検証

プレビューを起動直後の状態で、別ターミナルから実行します（本番URLは受け付けません）。

```
node tools/preview/verify-api.mjs                 # HTTP検証（選考フロー・409・訂正/取消・集計）
node tools/preview/verify-ui.mjs <保存先フォルダ>  # 画面検証（ヘッドレスEdge/Chrome、スクリーンショット保存）
```

`verify-ui.mjs` はプレビューのデータを変更するため、`verify-api.mjs` と続けて実行する場合はプレビューを再起動してください。
API単体テストは `cd api-server && npm test`（DB接続なし）。

## DB適用・デプロイ・切り戻し

手順は `tools/sql/RUNBOOK_selection_migration.md` にまとめています（事前確認SQL・適用・lock_timeout・失敗時・旧コードへの切り戻し・完全削除時の扱い）。

要点：

- 適用前に `tools/sql/selection_precheck_readonly.sql`（読み取りのみ）で、409になる既存データの件数を確認する
- 新しいコードはテーブル未作成でも従来どおり動く（選考履歴機能のみ停止し、一覧の「更新」は従来の進捗モーダル）
- テーブル作成後は、個人応募の進捗は選考履歴でのみ変更でき、選考列を含む古い画面からの保存は409
- 選考履歴がある応募者の管理種別（個人応募／協力業者）の変更は409（履歴が無ければ従来どおり変更できる）
- 新コードの稼働中に選考履歴テーブルを削除しない

## モバイル版について（未対応・修正案）

モバイル版は `status` 番号だけで進捗を表示するため、次の表示差があります（Web版の統計・部長会の計算定義は変更していません）。

| 実際の工程（Web版の表示） | モバイル版の表示 |
|---|---|
| 3次面接以降 | 2次面接 |
| 書類選考中 | 受付 |
| 面接打診中（既存データのみ） | 面接打診中 |
| 辞退・音信不通（不採用） | 不採用 |

修正案は次の2点です（元の開発フォルダのモバイル版未コミット変更とは別に、取り込み時に対応してください）。

- `GET /api/candidates` の各行にある `selection_label` を優先して表示する。
  - 例：`getStatusLabel` の先頭で `if (c.selection_label) return c.selection_label;`
  - あわせて `Candidate` 型に `selection_label?: string | null` を追加する。
- 面接数などの集計は、Web版・部長会と同じく既存列から計算しているため、変更不要です。
