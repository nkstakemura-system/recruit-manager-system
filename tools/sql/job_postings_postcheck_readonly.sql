-- 求人一覧 migration（005）の適用後の確認。読み取りのみ（SELECT だけ。書き込み・設定変更なし）。
-- 応募者の個人情報は参照しない（件数・システムカタログのみ）。手順は tools/sql/RUNBOOK_job_postings_migration.md。
--
-- 実行方法（読み取り専用。API の DATABASE_URL と同じロールで接続する）
--   psql -X -v ON_ERROR_STOP=1 "<接続先>" -c "BEGIN TRANSACTION READ ONLY" -c "SHOW transaction_read_only" -f tools/sql/job_postings_postcheck_readonly.sql -c "ROLLBACK"
--   Supabase の SQL Editor では、番号ごとに選択して実行する（最後の結果しか表示されないため）。

-- 1. 新しいテーブル（3件すべて表示される）
SELECT to_regclass('public.job_marketing_posting_revisions') AS revisions,
  to_regclass('public.job_marketing_posting_visibility') AS visibility,
  to_regclass('public.candidate_job_posting_links') AS links;

-- 2. 所有者と RLS（3行すべて owner = API の接続ロール、rls_enabled = true）
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('job_marketing_posting_revisions', 'job_marketing_posting_visibility', 'candidate_job_posting_links')
ORDER BY c.relname;

-- 3. 公開ロール（anon / authenticated。PUBLIC 経由を含む実効権限）が使えない（0行・false）
SELECT r.rolname, c.relname, CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated')
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')
  AND c.relname IN ('job_marketing_posting_revisions', 'job_marketing_posting_visibility', 'candidate_job_posting_links',
    'job_marketing_posting_revisions_id_seq', 'job_marketing_posting_visibility_id_seq', 'candidate_job_posting_links_id_seq')
  AND ((c.relkind = 'r' AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
    OR (c.relkind = 'S' AND has_sequence_privilege(r.rolname, c.oid, 'USAGE, SELECT, UPDATE')))
ORDER BY r.rolname, c.relname;
SELECT r.rolname, has_function_privilege(r.rolname, 'public.candidate_job_posting_links_append_only()', 'EXECUTE') AS can_execute
FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated');

-- 4. 追記専用のトリガー（版 2・公開状態 2・ひも付け 3 = 7）、外部キー（4：版→原稿、公開状態→原稿、ひも付け→応募者・原稿）、一意制約（3）
SELECT
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname IN ('job_marketing_posting_revisions', 'job_marketing_posting_visibility', 'candidate_job_posting_links') AND NOT t.tgisinternal) AS triggers,
  (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    WHERE c.relname IN ('job_marketing_posting_revisions', 'job_marketing_posting_visibility', 'candidate_job_posting_links') AND k.contype = 'f') AS foreign_keys,
  (SELECT count(*) FROM pg_constraint k WHERE k.contype = 'u' AND k.conname IN (
    'job_marketing_posting_revisions_no_unique', 'job_marketing_posting_visibility_seq_unique', 'candidate_job_posting_links_seq_unique')) AS unique_constraints;

-- 5. ひも付けの外部キー：candidates.id と同じ型、応募者の完全消去で連鎖削除（confdeltype = 'c'）
SELECT format_type(a.atttypid, a.atttypmod) AS candidate_id_type,
  (SELECT k.confdeltype FROM pg_constraint k WHERE k.conrelid = 'public.candidate_job_posting_links'::regclass AND k.contype = 'f'
    AND k.confrelid = 'public.candidates'::regclass) AS on_delete
FROM pg_attribute a WHERE a.attrelid = 'public.candidate_job_posting_links'::regclass AND a.attname = 'candidate_id';

-- 6. 差し替えた制約（CHECK (... '^(id|title|nks):' ...)）
SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
WHERE c.conrelid = 'public.job_marketing_postings'::regclass AND c.conname = 'job_marketing_postings_external_key_check';

-- 7. データ件数（新しいテーブルは 0。既存の件数は適用前の確認 6. と同じ）
SELECT
  (SELECT count(*) FROM public.job_marketing_posting_revisions) AS revisions,
  (SELECT count(*) FROM public.job_marketing_posting_visibility) AS visibility,
  (SELECT count(*) FROM public.candidate_job_posting_links) AS links,
  (SELECT count(*) FROM public.candidates) AS candidates,
  (SELECT count(*) FROM public.job_marketing_postings) AS postings,
  (SELECT count(*) FROM public.job_marketing_records) AS records,
  (SELECT count(*) FROM public.job_marketing_plan_events) AS plan_events,
  (SELECT count(*) FROM public.job_marketing_imports) AS imports,
  (SELECT count(*) FROM public.candidate_selection_events) AS selection_events;
