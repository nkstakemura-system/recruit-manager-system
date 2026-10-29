-- 求人分析 migration（004）の適用前の確認。読み取りのみ（SELECT だけ。書き込み・設定変更なし）。
-- 応募者の情報は参照しない（求人分析のテーブルと、システムカタログのみ）。手順は tools/sql/RUNBOOK_job_marketing_migration.md。
--
-- 実行方法（読み取り専用。API の DATABASE_URL と同じロールで接続する）
--   psql -X -v ON_ERROR_STOP=1 "<接続先>" -c "BEGIN TRANSACTION READ ONLY" -c "SHOW transaction_read_only" -f tools/sql/job_marketing_precheck_readonly.sql -c "ROLLBACK"
--   Supabase の SQL Editor では、番号ごとに選択して実行する（最後の結果しか表示されないため）。

-- 期待値：0 の current_user が selection_events_owner と同じ（または bypassrls = true）、1 はすべて NULL、2 は false。

-- 0. 接続ロールと、既存の選考履歴テーブル（migration 003）の所有者・RLS
--    API（DATABASE_URL）と同じロールで実行し、current_user が選考履歴テーブルの所有者と同じ（または bypassrls = true）であること。
--    004 は 003 と同じく RLS を有効にしてポリシーを作らないため、所有者（または RLS をバイパスするロール）からのみ読み書きできる。
--    migration 004 も同じロールで適用すると、作成されるテーブルの所有者がそのロールになる。
SELECT current_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS current_user_bypassrls,
  (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('public.candidate_selection_events')) AS selection_events_owner,
  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.candidate_selection_events')) AS selection_events_rls;

-- 1. 求人分析のテーブル（適用前は全て NULL、適用後は全て表示される）
SELECT to_regclass('public.job_marketing_categories') AS categories,
  to_regclass('public.job_marketing_category_events') AS category_events,
  to_regclass('public.job_marketing_postings') AS postings,
  to_regclass('public.job_marketing_plan_events') AS plan_events,
  to_regclass('public.job_marketing_imports') AS imports,
  to_regclass('public.job_marketing_records') AS records,
  to_regclass('public.job_marketing_references') AS "references";

-- 2. 同名の関数（適用前は false、適用後は true）
SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'job_marketing_append_only') AS append_only_function_exists;
