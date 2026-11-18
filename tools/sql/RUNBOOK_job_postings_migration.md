# 求人一覧 migration（005）本番反映手順書

対象：`api-server/migrations/005_job_postings.sql`
- 新規テーブル3件（求人内容の版・公開／非公開の履歴・応募者と求人のひも付け履歴）、関数1件
- 既存テーブルの変更は1点：`job_marketing_postings` の `external_key` の形式に `nks:`（求人IDの無い媒体のNKS採番）を追加
- 既存の行（応募者・選考履歴・求人原稿・実績・掲載状態）は変更・補正・削除しない。既存の応募者を求人へ自動でひも付けない。既存の求人原稿の公開状態は「未設定（要設定）」のまま

確認SQL：`tools/sql/job_postings_precheck_readonly.sql`（適用前）・`tools/sql/job_postings_postcheck_readonly.sql`（適用後）。どちらも読み取りのみ。

## 0. 全体の順序

1. 本番DBで適用前の確認SQLを実行（読み取りのみ）
2. migration 005 を適用（1回だけ。失敗時は全体が取り消される）
3. 適用後の確認SQLを実行（読み取りのみ）
4. commit・push
5. Render の反映を確認
6. 画面で確認

新しいAPIは、テーブルが無い間も既存機能（応募者の登録・編集・選考・求人分析・CSV取込）は従来どおり動き、求人一覧の画面だけ「未作成」と表示する（応募者フォームの求人の選択欄も出さない）。
そのため 2 と 4〜5 の順序が前後しても既存業務は止まらない（推奨は上記の順）。

## 1. 事前確認（読み取りのみ）

API の `DATABASE_URL` と同じロールで接続し、適用前の確認SQLを実行する。

```
psql -X -v ON_ERROR_STOP=1 "<接続先>" -c "BEGIN TRANSACTION READ ONLY" -c "SHOW transaction_read_only" -f tools/sql/job_postings_precheck_readonly.sql -c "ROLLBACK"
```

| 項目 | 期待値 |
|---|---|
| 0. `current_user` | `postings_owner`（求人原稿テーブルの所有者）と同じ、または `current_user_bypassrls = true` |
| 1. 新しいテーブル | すべて NULL |
| 2. `links_function_exists` | `false` |
| 3. `candidates_id_type` / `marketing_function_exists` | `integer` / `true` |
| 4. `job_marketing_postings_external_key_check` | `CHECK (((external_key ~ '^(id|title):'::text) AND (char_length(external_key) <= 210)))` |
| 5. external_key の形式 | `id`（と `title`）のみ |
| 6. 件数 | 記録しておく（適用後の 7. と比べる） |
| 7. ロック | 0行（適用の直前にもう一度実行する） |

1〜5 のどれか1つでも期待値と違う場合は、適用せずに止める。7 が0行でない場合は、時間をおいて再確認する。

参考（2026-11-18 の READ ONLY 確認）：0 は `postgres`／`bypassrls = true`、1 は NULL、2 は false、3 は integer／true、4 は上記のとおり、5 は `id` 4件、6 は 応募者126・求人原稿4・実績16・掲載状態0・取込8・選考履歴51、7 は0行。

## 2. 適用

- 1. と同じロールで、`api-server/migrations/005_job_postings.sql` を**ファイル全体のまま1回だけ**実行する（BEGIN〜COMMIT を含む）。
- `lock_timeout = 3s`・`statement_timeout = 60s`。
  - 外部キーの作成で `candidates`・`job_marketing_postings` に SHARE ROW EXCLUSIVE ロック、制約の差し替えで `job_marketing_postings` に ACCESS EXCLUSIVE ロックを短時間取る。
  - 取得待ちが3秒を超えると失敗し、全体が取り消される（応募者の保存を長く止めない）。業務時間外の適用を推奨。
- 失敗した場合は全体が取り消され、何も作成・変更されない。エラー文を確認し、原因を解消してから再実行する。
  - 「求人一覧のテーブルが既に存在します」：既に適用済み、または失敗した旧版が残っている。構造を確認する（自動では変更しない）。
  - 「job_marketing_postings_external_key_check が想定と違います」：004 以降に制約が変更されている。適用せずに相談する。
  - `lock timeout`：他の接続がロック中。時間をおいて再実行する。

## 3. 適用直後の確認（読み取りのみ）

同じロールで適用後の確認SQLを実行する（コマンドは 1. の `-f` を `tools/sql/job_postings_postcheck_readonly.sql` に変えたもの）。

| 項目 | 期待値 |
|---|---|
| 1. | 3テーブルすべて表示 |
| 2. | 3行すべて `owner` = API の接続ロール、`rls_enabled = true` |
| 3. | 公開ロールの実効権限 0行。`can_execute` は `anon` / `authenticated` の2行とも `false` |
| 4. | トリガー 7・外部キー 4・一意制約 3 |
| 5. | `candidate_id_type = integer`、`on_delete = c`（応募者の完全消去で連鎖削除） |
| 6. | `CHECK (((external_key ~ '^(id|title|nks):'::text) AND (char_length(external_key) <= 210)))` |
| 7. | 新しいテーブルは 0。応募者・求人原稿・実績・掲載状態・取込・選考履歴は適用前の 6. と同じ |

## 4. commit・push

`git add --all` は使わず、パスを指定する（実CSV・本番スナップショット・.env・バックアップは含めない）。

```
git add api-server/server.js api-server/jobMarketingPgStore.js \
  api-server/jobPostingService.js api-server/jobPostingPgStore.js api-server/jobPostingMemoryStore.js \
  api-server/migrations/005_job_postings.sql api-server/tests/job-postings.test.mjs api-server/tests/integration/job-postings.pg.mjs \
  api-server/tests/hr-summary.test.mjs shared/jobPostings.mjs \
  react-app/src/App.jsx react-app/src/postings react-app/src/marketing/JobMarketing.jsx react-app/src/marketing/MarketingForms.jsx \
  tools/preview/preview-server.cjs tools/preview/README.md tools/preview/verify-postings.mjs \
  tools/sql/job_postings_precheck_readonly.sql tools/sql/job_postings_postcheck_readonly.sql tools/sql/RUNBOOK_job_postings_migration.md
git status --short   # 意図しないファイルが含まれていないこと
```

## 5. Render の反映確認

- main への push で Render が自動デプロイする。配信される画面ファイル（`/assets/index-*.js`）が新しいものに切り替わったことを確認する。

## 6. 画面で確認（ログイン後）

- サイドバー「求人一覧」が「求人分析」の上に表示され、求人一覧に既存の求人原稿4件が「要設定」「初版未登録」で表示される（「未作成」の表示が無い）。
- 公開状態は推測で設定しない。人事担当者が各求人の実際の状況を確認して「公開状態を設定」から登録する。
- 既存の応募者は求人にひも付いていない（応募者数 0）。必要に応じて応募者の編集画面から求人を選ぶ。
- 既存の応募者一覧・選考・ダッシュボード・求人分析・CSV取込が従来どおり使える。

## 7. 切り戻し

- 旧コードへ戻す場合、テーブルは残したままでよい（旧コードは新しいテーブルを参照しない。`nks:` の求人原稿も旧コードの求人分析で従来どおり表示される）。
- 新しいコードの稼働中にテーブルを削除しない（テーブル有りの判定を保持しているため、求人一覧と応募者の求人選択がエラーになる）。
- 完全に削除する場合は、旧コードへ戻した後に限り、次を実行する（ひも付け・版・公開状態の履歴は失われる）。

```
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TABLE public.candidate_job_posting_links, public.job_marketing_posting_revisions, public.job_marketing_posting_visibility;
DROP FUNCTION public.candidate_job_posting_links_append_only();
-- nks: の求人原稿が無い場合だけ、制約を元に戻す（ある場合は戻さず残す。行は削除しない）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.job_marketing_postings WHERE external_key LIKE 'nks:%') THEN
    ALTER TABLE public.job_marketing_postings DROP CONSTRAINT job_marketing_postings_external_key_check;
    ALTER TABLE public.job_marketing_postings ADD CONSTRAINT job_marketing_postings_external_key_check
      CHECK (external_key ~ '^(id|title):' AND char_length(external_key) <= 210);
  END IF;
END $$;
COMMIT;
```

求人画面から新規登録された求人原稿（`job_marketing_postings` の行）は追記専用のため、切り戻しでも削除されず、求人分析に残る。
