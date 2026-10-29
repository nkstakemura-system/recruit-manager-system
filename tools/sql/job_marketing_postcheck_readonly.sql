-- 求人分析 migration（004）の適用後の確認。読み取りのみ（SELECT だけ。書き込み・設定変更なし）。
-- 応募者の情報は参照しない（求人分析のテーブルと、システムカタログのみ）。手順は tools/sql/RUNBOOK_job_marketing_migration.md。
--
-- 実行方法（読み取り専用。API の DATABASE_URL と同じロールで接続する）
--   psql -X -v ON_ERROR_STOP=1 "<接続先>" -c "BEGIN TRANSACTION READ ONLY" -c "SHOW transaction_read_only" -f tools/sql/job_marketing_postcheck_readonly.sql -c "ROLLBACK"
--   Supabase の SQL Editor では、番号ごとに選択して実行する（最後の結果しか表示されないため）。

-- 期待値は各項目のコメントと手順書 3. を参照。

-- 0. 接続ロールと、既存の選考履歴テーブル（migration 003）の所有者・RLS
--    API（DATABASE_URL）と同じロールで実行し、current_user が選考履歴テーブルの所有者と同じ（または bypassrls = true）であること。
--    004 は 003 と同じく RLS を有効にしてポリシーを作らないため、所有者（または RLS をバイパスするロール）からのみ読み書きできる。
--    migration 004 も同じロールで適用すると、作成されるテーブルの所有者がそのロールになる。
SELECT current_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS current_user_bypassrls,
  (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('public.candidate_selection_events')) AS selection_events_owner,
  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.candidate_selection_events')) AS selection_events_rls;

-- 1. 求人分析のテーブル（7件すべて表示される）
SELECT to_regclass('public.job_marketing_categories') AS categories,
  to_regclass('public.job_marketing_category_events') AS category_events,
  to_regclass('public.job_marketing_postings') AS postings,
  to_regclass('public.job_marketing_plan_events') AS plan_events,
  to_regclass('public.job_marketing_imports') AS imports,
  to_regclass('public.job_marketing_records') AS records,
  to_regclass('public.job_marketing_references') AS "references";

-- 2. 関数（true）
SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'job_marketing_append_only') AS append_only_function_exists;

-- 3. 適用後：所有者と RLS（7行すべて owner = API の接続ロール、rls_enabled = true）
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'job\_marketing\_%'
ORDER BY c.relname;

-- 4. 適用後：公開ロール（anon / authenticated。PUBLIC 経由の権限も含む実効権限）がテーブル・シーケンス・関数を使えない（0行・false）
SELECT r.rolname, c.relname, CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated')
WHERE n.nspname = 'public' AND c.relname LIKE 'job_marketing_%' AND c.relkind IN ('r', 'S')
  AND ((c.relkind = 'r' AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
    OR (c.relkind = 'S' AND has_sequence_privilege(r.rolname, c.oid, 'USAGE, SELECT, UPDATE')))
ORDER BY r.rolname, c.relname;
SELECT r.rolname, has_function_privilege(r.rolname, 'public.job_marketing_append_only()', 'EXECUTE') AS can_execute
FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated');

-- 5. 適用後：追記専用・削除禁止のトリガー（14）、外部キー（10）、一意索引（4）
SELECT
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname LIKE 'job\_marketing\_%' AND NOT t.tgisinternal) AS triggers,
  (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    WHERE c.relname LIKE 'job\_marketing\_%' AND k.contype = 'f') AS foreign_keys,
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
    'job_marketing_categories_name_unique', 'job_marketing_postings_key_unique',
    'job_marketing_plan_events_void_once', 'job_marketing_records_supersede_once')) AS unique_indexes;

-- 6. 適用後：初期の職種（4件：営業・CADオペ（ときがわ）・CADオペ（本社）・電気工事士、すべて募集中）
SELECT id, name, is_active, sort_order FROM public.job_marketing_categories ORDER BY sort_order, id;

-- 7. 適用後：データ件数（適用直後は 実績・取込・原稿・掲載状態・参考求人 がすべて 0、職種の履歴は 4）
SELECT
  (SELECT count(*) FROM public.job_marketing_records) AS records,
  (SELECT count(*) FROM public.job_marketing_imports) AS imports,
  (SELECT count(*) FROM public.job_marketing_postings) AS postings,
  (SELECT count(*) FROM public.job_marketing_plan_events) AS plan_events,
  (SELECT count(*) FROM public.job_marketing_references) AS "references",
  (SELECT count(*) FROM public.job_marketing_category_events) AS category_events;
