# 求人分析 migration（004）本番反映手順書

対象：`api-server/migrations/004_job_marketing.sql`（新規テーブル7件・関数1件のみ。既存の応募者・選考・経費・部長会のテーブルには触れない）
確認SQL：`tools/sql/job_marketing_precheck_readonly.sql`（適用前）・`tools/sql/job_marketing_postcheck_readonly.sql`（適用後）。どちらも読み取りのみ

## 0. 全体の順序

1. 本番DBで適用前の確認SQLを実行（読み取りのみ）
2. migration 004 を適用（1回だけ。失敗時は全体が取り消される）
3. 適用後の確認SQLを実行（読み取りのみ）
4. commit・push
5. Render の反映を確認
6. 画面で確認

新しいAPIは、テーブルが無い間も既存機能は従来どおり動き、求人分析の画面だけ「未作成」と表示する。
そのため 2 と 4〜5 の順序が前後しても既存業務は止まらない（推奨は上記の順）。

## 1. 事前確認（読み取りのみ）

API の `DATABASE_URL` と同じロールで接続し、適用前の確認SQLを実行する。

```
psql -X -v ON_ERROR_STOP=1 "<接続先>" -c "BEGIN TRANSACTION READ ONLY" -c "SHOW transaction_read_only" -f tools/sql/job_marketing_precheck_readonly.sql -c "ROLLBACK"
```

（Supabase の SQL Editor では、番号ごとに選択して実行する）

| 項目 | 期待値 |
|---|---|
| 0. `current_user` | `selection_events_owner`（選考履歴テーブルの所有者）と同じ、または `current_user_bypassrls = true` |
| 0. `selection_events_rls` | `true`（003 と同じ方式で RLS が有効） |
| 1. 求人分析のテーブル | すべて NULL |
| 2. `append_only_function_exists` | `false` |

0〜2 のどれか1つでも期待値と違う場合（0 のロールが違う、1 が NULL でない、2 が true）は、適用せずに止める。

## 2. 適用

- 1. と同じロールで、`api-server/migrations/004_job_marketing.sql` を**ファイル全体のまま1回だけ**実行する（BEGIN〜COMMIT を含む）。
- `lock_timeout = 3s`・`statement_timeout = 60s`。新規テーブルのみのため、既存テーブルのロック待ちは発生しない。
- 失敗した場合は全体が取り消され、何も作られない。エラー文を確認し、原因を解消してから再実行する。
- 同名テーブルがある場合は「求人分析のテーブルが既に存在します」で停止する（自動では変更しない）。

## 3. 適用直後の確認（読み取りのみ）

同じロールで適用後の確認SQLを実行する（コマンドは 1. の `-f` を `tools/sql/job_marketing_postcheck_readonly.sql` に変えたもの）。

| 項目 | 期待値 |
|---|---|
| 1. | 7テーブルすべて表示 |
| 2. | `true` |
| 3. | 7行すべて `owner` = API の接続ロール、`rls_enabled = true` |
| 4. | 公開ロールの実効権限（テーブル・シーケンス）0行。`can_execute` は `anon` / `authenticated` の2行とも `false` |
| 5. | トリガー 14・外部キー 10・一意索引 4 |
| 6. | 初期職種4件（営業・CADオペ（ときがわ）・CADオペ（本社）・電気工事士）、すべて `is_active = true` |
| 7. | 実績・取込・原稿・掲載状態・参考求人は 0、職種の履歴は 4 |

架空データ・実CSVは migration では登録しない（実績は画面のCSV取込から利用者が登録する）。

## 4. commit・push

`git add --all` は使わず、パスを指定する。

```
git add api-server/server.js api-server/tests/hr-summary.test.mjs react-app/src/App.jsx \
  api-server/jobMarketingService.js api-server/jobMarketingPgStore.js api-server/jobMarketingMemoryStore.js \
  api-server/migrations/004_job_marketing.sql api-server/tests/job-marketing.test.mjs api-server/tests/fixtures/job-marketing \
  shared/jobMarketing.mjs react-app/src/marketing \
  tools/preview/preview-server.cjs tools/preview/README.md tools/preview/verify-marketing.mjs \
  tools/sql/job_marketing_precheck_readonly.sql tools/sql/job_marketing_postcheck_readonly.sql tools/sql/RUNBOOK_job_marketing_migration.md
git status --short   # 意図しないファイルが含まれていないこと（実CSVはリポジトリ外のため含まれない）
git commit -m "feat: add job marketing analysis (Indeed CSV, free/paid comparison)"
git push origin HEAD:main
```

`tests/fixtures/job-marketing` のCSVは架空データ。`tools/preview/verify-real-csv.mjs` は実データの集計値を含むため追加しない（開発端末のみ）。

## 5. Render の反映確認

- main への push で Render が自動デプロイする設定であることを確認する（手動の場合は Manual Deploy）。
- API と画面の両方のデプロイが成功したことを確認する。

## 6. 画面で確認

- ログイン → サイドバー「求人分析」が表示され、初期4職種のタブが出る（「未作成」の表示が無い）。
- 「確認待ちのCSV」は表示されない（ローカルプレビュー専用）。
- 既存の応募者一覧・選考・ダッシュボード・部長会の画面が従来どおり表示される。
- 実データの登録は人事担当者が「CSV取込」から行う。職種・年・「応募」の意味・掲載種別は取込時に確認する。

## 7. 切り戻し

- 旧コードへ戻す場合、テーブルは残したままでよい（旧コードは求人分析のテーブルを参照しない）。
- 新しいコードの稼働中にテーブルを削除しない（テーブル有りの判定を保持しているため 500 になる）。
- 完全に削除する場合は、旧コードへ戻した後に、依存順（records / plan_events → postings / imports / references / category_events → categories）で DROP する。
