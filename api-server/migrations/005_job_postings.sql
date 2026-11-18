-- 求人一覧・求人詳細・応募者連携（第5弾）。手動適用専用。アプリ起動時には実行しない。※本番未適用（ファイル準備のみ）
--
-- 方針
-- * 求人は既存の求人原稿（job_marketing_postings）を共通利用する。求人分析・CSV取込の照合（媒体＋求人ID）はそのまま。
-- * 新規テーブルは3つ（すべて追記専用。UPDATE・DELETE・TRUNCATE をトリガーで拒否）:
--     job_marketing_posting_revisions    求人内容の版（修正のたびに新しい版を追加。最新の版が現在の内容）
--     job_marketing_posting_visibility   NKS内部の公開／非公開の切替履歴（外部サイトの掲載・停止とは無関係）
--     candidate_job_posting_links        応募者と求人のひも付け履歴（最新の行が現在のひも付け。posting_id NULL は「該当求人なし・不明」）
-- * 既存テーブルの変更は1点のみ：求人原稿の external_key の形式に「nks:」（求人IDの無い媒体のNKS採番）を追加する。
--   既存の 'id:' / 'title:' の行はそのまま有効（行の値は変更しない）。
-- * candidates には列を追加しない（基本情報の保存が応募経路の列を常に上書きするため、ひも付けは別テーブルで持つ）。
-- * 既存データの補正・移行・自動ひも付けはしない。既存の求人原稿の公開状態は「未設定」（行が無い状態）のまま。
-- * 掲載状態（無料・有料・不明・募集停止）は既存の job_marketing_plan_events を使う（このmigrationでは扱わない）。
-- * 応募者を完全消去（candidates の物理削除）した場合だけ、外部キーの連鎖削除でひも付け履歴も消える（選考履歴と同じ）。
-- * candidates.id の型は推測せず、実行時に pg_attribute から読み取って同じ型で外部キーを作成する。
-- * 同名テーブルが既にある場合・前提のテーブルや制約が想定と違う場合は、何もせずエラーで停止する。
-- * ロック待ちは3秒で打ち切る（lock_timeout）。失敗時は全体が取り消され、何も作成・変更されない。
--   外部キーの作成で candidates・job_marketing_postings に SHARE ROW EXCLUSIVE ロック、
--   制約の差し替えで job_marketing_postings に ACCESS EXCLUSIVE ロックを短時間取る（参照・保存は数秒以内の待機で済む）。
--
-- 手順書: tools/sql/RUNBOOK_job_postings_migration.md
-- 適用前の確認（読み取りのみ）: tools/sql/job_postings_precheck_readonly.sql
-- 適用後の確認（読み取りのみ）: tools/sql/job_postings_postcheck_readonly.sql
-- 適用順: このSQLを適用 → 確認 → 新しいAPI/画面をデプロイ。
-- （新しいAPIはテーブル未作成でも従来どおり動作し、求人一覧の画面のみ「未作成」と表示する）
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  id_type text;
  check_def text;
BEGIN
  IF to_regclass('public.job_marketing_posting_revisions') IS NOT NULL
    OR to_regclass('public.job_marketing_posting_visibility') IS NOT NULL
    OR to_regclass('public.candidate_job_posting_links') IS NOT NULL THEN
    RAISE EXCEPTION '求人一覧のテーブルが既に存在します。構造を確認してください（自動では変更しません）';
  END IF;
  IF to_regclass('public.job_marketing_postings') IS NULL THEN
    RAISE EXCEPTION 'public.job_marketing_postings がありません（migration 004 を先に適用してください）';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.candidates'::regclass AND a.attname = 'id' AND NOT a.attisdropped;
  IF id_type IS NULL THEN
    RAISE EXCEPTION 'public.candidates.id が見つかりません';
  END IF;

  -- 差し替える制約が migration 004 のとおりであること（定義全体の完全一致。違えば停止する）
  SELECT pg_get_constraintdef(c.oid) INTO check_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.job_marketing_postings'::regclass AND c.conname = 'job_marketing_postings_external_key_check' AND c.contype = 'c';
  IF check_def IS DISTINCT FROM 'CHECK (((external_key ~ ''^(id|title):''::text) AND (char_length(external_key) <= 210)))' THEN
    RAISE EXCEPTION 'job_marketing_postings_external_key_check が想定と違います（%）。自動では変更しません', COALESCE(check_def, '制約なし');
  END IF;

  EXECUTE format($sql$
    CREATE TABLE public.candidate_job_posting_links (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      candidate_id %s NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      posting_id BIGINT REFERENCES public.job_marketing_postings(id),
      reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
      actor TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT candidate_job_posting_links_seq_unique UNIQUE (candidate_id, seq)
    )$sql$, id_type);
END $$;

CREATE INDEX candidate_job_posting_links_posting_idx
  ON public.candidate_job_posting_links (posting_id) WHERE posting_id IS NOT NULL;

-- 求人原稿の external_key に「nks:」（求人IDの無い媒体のNKS採番）を追加する。既存の行の値は変更しない。
ALTER TABLE public.job_marketing_postings DROP CONSTRAINT job_marketing_postings_external_key_check;
ALTER TABLE public.job_marketing_postings ADD CONSTRAINT job_marketing_postings_external_key_check
  CHECK (external_key ~ '^(id|title|nks):' AND char_length(external_key) <= 210);

-- 求人内容の版（追記専用）。revision_no は求人ごとの連番で、同じ番号の二重登録を一意制約で防ぐ（同時編集の最終防御）
CREATE TABLE public.job_marketing_posting_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_id BIGINT NOT NULL REFERENCES public.job_marketing_postings(id),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  title TEXT NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 200),
  body TEXT CHECK (body IS NULL OR char_length(body) <= 20000),
  url TEXT CHECK (url IS NULL OR (char_length(url) <= 2000 AND url ~* '^https?://')),
  location TEXT CHECK (location IS NULL OR char_length(location) <= 200),
  employment_type TEXT CHECK (employment_type IS NULL OR char_length(employment_type) <= 50),
  salary TEXT CHECK (salary IS NULL OR char_length(salary) <= 1000),
  work_hours TEXT CHECK (work_hours IS NULL OR char_length(work_hours) <= 1000),
  holidays TEXT CHECK (holidays IS NULL OR char_length(holidays) <= 1000),
  other_conditions TEXT CHECK (other_conditions IS NULL OR char_length(other_conditions) <= 4000),
  contact_person TEXT CHECK (contact_person IS NULL OR char_length(contact_person) <= 100),
  change_summary TEXT CHECK (change_summary IS NULL OR char_length(change_summary) <= 500),
  change_reason TEXT CHECK (change_reason IS NULL OR char_length(change_reason) <= 500),
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_marketing_posting_revisions_no_unique UNIQUE (posting_id, revision_no),
  -- 2版目以降は修正内容が必須
  CONSTRAINT job_marketing_posting_revisions_summary_check CHECK (revision_no = 1 OR (change_summary IS NOT NULL AND btrim(change_summary) <> ''))
);

-- NKS内部の公開／非公開の切替履歴（追記専用）。seq は求人ごとの連番（同時切替の最終防御）。
-- previous_visibility が NULL の行は「未設定」からの最初の設定。effective_date は公開開始日・非公開日（業務上の日付）
CREATE TABLE public.job_marketing_posting_visibility (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_id BIGINT NOT NULL REFERENCES public.job_marketing_postings(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  previous_visibility TEXT CHECK (previous_visibility IS NULL OR previous_visibility IN ('public', 'private')),
  effective_date DATE NOT NULL CHECK (effective_date BETWEEN DATE '1000-01-01' AND DATE '9999-12-31'),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_marketing_posting_visibility_seq_unique UNIQUE (posting_id, seq),
  CONSTRAINT job_marketing_posting_visibility_change_check CHECK (previous_visibility IS DISTINCT FROM visibility),
  CONSTRAINT job_marketing_posting_visibility_first_check CHECK ((seq = 1) = (previous_visibility IS NULL))
);

-- 追記専用（求人分析と同じ関数を使う）
CREATE TRIGGER job_marketing_posting_revisions_no_update BEFORE UPDATE OR DELETE ON public.job_marketing_posting_revisions
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_posting_revisions_no_truncate BEFORE TRUNCATE ON public.job_marketing_posting_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_posting_visibility_no_update BEFORE UPDATE OR DELETE ON public.job_marketing_posting_visibility
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_posting_visibility_no_truncate BEFORE TRUNCATE ON public.job_marketing_posting_visibility
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();

-- ひも付け履歴は追記専用。応募者の完全消去に伴う連鎖削除だけを許可する（選考履歴と同じ）
CREATE FUNCTION public.candidate_job_posting_links_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '求人のひも付け履歴は追記専用です（%は禁止）', TG_OP;
END
$fn$;
CREATE TRIGGER candidate_job_posting_links_no_update BEFORE UPDATE ON public.candidate_job_posting_links
  FOR EACH ROW EXECUTE FUNCTION public.candidate_job_posting_links_append_only();
CREATE TRIGGER candidate_job_posting_links_no_delete BEFORE DELETE ON public.candidate_job_posting_links
  FOR EACH ROW EXECUTE FUNCTION public.candidate_job_posting_links_append_only();
CREATE TRIGGER candidate_job_posting_links_no_truncate BEFORE TRUNCATE ON public.candidate_job_posting_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.candidate_job_posting_links_append_only();

-- Supabase の公開ロールからは参照させない（APIサーバーのみ直接接続）
DO $$
DECLARE
  t text;
  role_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_marketing_posting_revisions', 'job_marketing_posting_visibility', 'candidate_job_posting_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC', t || '_id_seq');
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, role_name);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I', t || '_id_seq', role_name);
      END IF;
    END LOOP;
  END LOOP;
  REVOKE ALL ON FUNCTION public.candidate_job_posting_links_append_only() FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.candidate_job_posting_links_append_only() FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- 削除（切り戻し）について: 新しいAPIの稼働中は削除しないこと（テーブル有りの判定を保持しているため）。
-- 旧コードへ戻した後に限り、手順書の「切り戻し」に従って DROP し、external_key の制約を元に戻す
-- （nks: の求人原稿が登録済みの場合は制約を戻せないため、元に戻さず残す）。
