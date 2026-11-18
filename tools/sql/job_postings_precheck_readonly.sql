-- 求人一覧 migration（005）の適用前の確認。読み取りのみ（SELECT だけ。書き込み・設定変更なし）。
-- 応募者の個人情報は参照しない（件数・型・システムカタログのみ）。手順は tools/sql/RUNBOOK_job_postings_migration.md。
--
-- 実行方法（読み取り専用。API の DATABASE_URL と同じロールで接続する）
--   psql -X -v ON_ERROR_STOP=1 "<接続先>" -c "BEGIN TRANSACTION READ ONLY" -c "SHOW transaction_read_only" -f tools/sql/job_postings_precheck_readonly.sql -c "ROLLBACK"
--   Supabase の SQL Editor では、番号ごとに選択して実行する（最後の結果しか表示されないため）。

-- 0. 接続ロールと、既存の求人原稿テーブル（migration 004）の所有者・RLS
--    current_user が job_marketing_postings の所有者と同じ（または bypassrls = true）であること。
--    005 も 003・004 と同じく RLS を有効にしてポリシーを作らないため、所有者（または RLS をバイパスするロール）からのみ読み書きできる。
SELECT current_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS current_user_bypassrls,
  (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('public.job_marketing_postings')) AS postings_owner,
  (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('public.candidates')) AS candidates_owner,
  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.job_marketing_postings')) AS postings_rls;

-- 1. 新しいテーブル（適用前は全て NULL）
SELECT to_regclass('public.job_marketing_posting_revisions') AS revisions,
  to_regclass('public.job_marketing_posting_visibility') AS visibility,
  to_regclass('public.candidate_job_posting_links') AS links;

-- 2. 新しい関数（適用前は false）
SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'candidate_job_posting_links_append_only') AS links_function_exists;

-- 3. 前提：candidates.id の型（005 はこの型で外部キーを作る。本番は integer の想定）・求人分析の共通関数（true）
SELECT format_type(a.atttypid, a.atttypmod) AS candidates_id_type
FROM pg_attribute a WHERE a.attrelid = 'public.candidates'::regclass AND a.attname = 'id' AND NOT a.attisdropped;
SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'job_marketing_append_only') AS marketing_function_exists;

-- 4. 差し替える制約（1行：job_marketing_postings_external_key_check が CHECK (... '^(id|title):' ...) であること）
SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c WHERE c.conrelid = 'public.job_marketing_postings'::regclass AND c.contype = 'c' ORDER BY c.conname;

-- 5. 既存の求人原稿の external_key の形式（すべて id: か title:。適用後もこの値は変わらない）
SELECT split_part(external_key, ':', 1) AS key_type, count(*) AS postings FROM public.job_marketing_postings GROUP BY 1 ORDER BY 1;

-- 6. 適用前の件数（適用後の確認で同じ値であることを確かめる。応募者は件数のみ）
SELECT
  (SELECT count(*) FROM public.candidates) AS candidates,
  (SELECT count(*) FROM public.job_marketing_postings) AS postings,
  (SELECT count(*) FROM public.job_marketing_records) AS records,
  (SELECT count(*) FROM public.job_marketing_plan_events) AS plan_events,
  (SELECT count(*) FROM public.job_marketing_imports) AS imports,
  (SELECT count(*) FROM public.candidate_selection_events) AS selection_events;

-- 7. ロック待ちの確認（適用直前に実行。candidates・job_marketing_postings を長時間ロックしている接続が無いこと＝0行）
SELECT l.pid, l.mode, l.granted, now() - a.xact_start AS xact_age
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation IN (to_regclass('public.candidates'), to_regclass('public.job_marketing_postings')) AND l.pid <> pg_backend_pid();
