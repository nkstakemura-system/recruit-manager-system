-- 求人マーケティング分析（第4弾）。手動適用専用。アプリ起動時には実行しない。※本番未適用（ファイル準備のみ）
--
-- 方針
-- * 新規テーブルのみ作成する。既存の candidates・採用経費・部長会・モバイル関連のテーブルや集計には触れない。
-- * 職種はIDで管理し、実績は category_id で関連付ける（名称変更・募集停止でも過去実績は保たれる）。
-- * 同じ職種で複数の求人原稿（Indeedの求人ID）が同時掲載される場合に備え、原稿を job_marketing_postings で識別し、
--   実績は posting_id（原稿を特定できない合計は NULL）で関連付ける。別の原稿どうしは同じ期間でも重複とみなさない。
-- * 掲載状態（無料・有料・不明・募集停止）は変更日つきの追記専用の履歴（job_marketing_plan_events）で持つ。
--   変更前の実績はそのまま残り、日別の実績は変更日を基準に無料・有料へ分けて集計する（月間合計は按分しない）。
-- * 実績（job_marketing_records）は追記専用。修正は新しい行が supersedes_id で旧行を置き換え、
--   取消は kind='void' の行を追記する。元の行は UPDATE・DELETE しない（トリガーで拒否）。
-- * 未取得の数値は NULL（0件と区別する）。費用の NULL は「未入力」であり 0円ではない。
-- * 応募者個人の情報は保存しない（集計値・メモ・参考求人のみ）。
-- * 同名テーブルが既にある場合は作成せずエラーで停止する。
-- * 失敗時は全体が取り消され、何も作成されない。
--
-- 適用順: このSQLを適用 → 確認 → 新しいAPI/画面をデプロイ。
-- （新しいAPIはテーブル未作成でも従来どおり動作し、求人分析の画面のみ「未作成」と表示する）
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('public.job_marketing_categories') IS NOT NULL
    OR to_regclass('public.job_marketing_category_events') IS NOT NULL
    OR to_regclass('public.job_marketing_postings') IS NOT NULL
    OR to_regclass('public.job_marketing_plan_events') IS NOT NULL
    OR to_regclass('public.job_marketing_imports') IS NOT NULL
    OR to_regclass('public.job_marketing_records') IS NOT NULL
    OR to_regclass('public.job_marketing_references') IS NOT NULL THEN
    RAISE EXCEPTION '求人分析のテーブルが既に存在します。構造を確認してください（自動では変更しません）';
  END IF;
END $$;

-- 職種マスタ（名称変更・募集停止／再開のみ UPDATE。削除はしない）
CREATE TABLE public.job_marketing_categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 50),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX job_marketing_categories_name_unique ON public.job_marketing_categories (btrim(name));

-- 職種の変更履歴（作成・名称変更・募集停止・再開）
CREATE TABLE public.job_marketing_category_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES public.job_marketing_categories(id),
  kind TEXT NOT NULL CHECK (kind IN ('created', 'renamed', 'paused', 'resumed')),
  before_value TEXT,
  after_value TEXT,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 求人原稿（Indeedの求人ID、無ければ求人タイトルで識別）。1つの原稿は1つの職種に属する（追記専用）
CREATE TABLE public.job_marketing_postings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES public.job_marketing_categories(id),
  media TEXT NOT NULL CHECK (btrim(media) <> '' AND char_length(media) <= 50),
  external_key TEXT NOT NULL CHECK (external_key ~ '^(id|title):' AND char_length(external_key) <= 210),
  job_id TEXT CHECK (job_id IS NULL OR char_length(job_id) <= 200),
  title TEXT CHECK (title IS NULL OR char_length(title) <= 200),
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX job_marketing_postings_key_unique ON public.job_marketing_postings (media, external_key);

-- 掲載状態の履歴（追記専用）。posting_id が NULL の変更は職種全体に適用する。
-- ある日の掲載状態は、その日以前で最も新しい変更（職種全体・原稿ごと）。取消は kind='void' の行を追記する。
CREATE TABLE public.job_marketing_plan_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('change', 'void')),
  category_id BIGINT NOT NULL REFERENCES public.job_marketing_categories(id),
  posting_id BIGINT REFERENCES public.job_marketing_postings(id),
  supersedes_id BIGINT REFERENCES public.job_marketing_plan_events(id),
  status TEXT CHECK (status IN ('free', 'paid', 'unknown', 'stopped')),
  effective_date DATE,
  budget NUMERIC(14, 2) CHECK (budget >= 0),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 4000),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_marketing_plan_events_change_check CHECK (kind <> 'change' OR (status IS NOT NULL AND effective_date IS NOT NULL AND supersedes_id IS NULL)),
  CONSTRAINT job_marketing_plan_events_void_check CHECK (kind <> 'void' OR (supersedes_id IS NOT NULL AND reason IS NOT NULL AND status IS NULL AND effective_date IS NULL AND budget IS NULL)),
  CONSTRAINT job_marketing_plan_events_budget_paid_only CHECK (budget IS NULL OR status = 'paid')
);
CREATE UNIQUE INDEX job_marketing_plan_events_void_once ON public.job_marketing_plan_events (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX job_marketing_plan_events_category_idx ON public.job_marketing_plan_events (category_id, effective_date);

-- CSV取り込みの記録（同じファイルの二重登録の判定に使う）
CREATE TABLE public.job_marketing_imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name TEXT NOT NULL CHECK (char_length(file_name) <= 255),
  file_hash TEXT NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  format TEXT NOT NULL CHECK (format IN ('indeed_csv', 'legacy_csv')),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX job_marketing_imports_hash_idx ON public.job_marketing_imports (file_hash);

-- 実績（追記専用）
CREATE TABLE public.job_marketing_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('metric', 'void')),
  category_id BIGINT NOT NULL REFERENCES public.job_marketing_categories(id),
  supersedes_id BIGINT REFERENCES public.job_marketing_records(id),
  media TEXT CHECK (media IS NULL OR (btrim(media) <> '' AND char_length(media) <= 50)),
  period_start DATE,
  period_end DATE,
  plan_type TEXT CHECK (plan_type IN ('free', 'paid', 'unknown')),
  impressions INTEGER CHECK (impressions >= 0),
  clicks INTEGER CHECK (clicks >= 0),
  apply_starts INTEGER CHECK (apply_starts >= 0),
  applies INTEGER CHECK (applies >= 0),
  cost NUMERIC(14, 2) CHECK (cost >= 0),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 4000),
  source TEXT CHECK (source IN ('manual', 'indeed_csv', 'legacy_csv')),
  import_id BIGINT REFERENCES public.job_marketing_imports(id),
  posting_id BIGINT REFERENCES public.job_marketing_postings(id), -- 求人原稿（NULL は原稿を特定しない職種全体の記録）
  source_meta JSONB,   -- 提供元の定義（応募開始・応募完了の意味）、旧CSVの元の値、確認した年、重複登録の理由など
  daily JSONB,         -- Indeed CSV の日別の値（実在する日付のみ）
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 実績の行は期間・掲載種別・媒体・取得元が必須
  CONSTRAINT job_marketing_records_metric_check CHECK (kind <> 'metric' OR (
    period_start IS NOT NULL AND period_end IS NOT NULL AND period_end >= period_start
    AND period_end - period_start <= 365 AND plan_type IS NOT NULL AND media IS NOT NULL AND source IS NOT NULL)),
  -- 取消の行は対象と理由が必須で、数値を持たない
  CONSTRAINT job_marketing_records_void_check CHECK (kind <> 'void' OR (
    supersedes_id IS NOT NULL AND reason IS NOT NULL AND period_start IS NULL AND impressions IS NULL AND clicks IS NULL
    AND apply_starts IS NULL AND applies IS NULL AND cost IS NULL AND daily IS NULL))
);
-- 1つの記録を置き換え・取消できるのは1回だけ（同時操作の最終防御。通常はAPIの直列化で防ぐ）
CREATE UNIQUE INDEX job_marketing_records_supersede_once ON public.job_marketing_records (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX job_marketing_records_category_idx ON public.job_marketing_records (category_id, period_start);
CREATE INDEX job_marketing_records_import_idx ON public.job_marketing_records (import_id) WHERE import_id IS NOT NULL;

-- 参考求人（編集・論理削除のみ。URL先の自動取得はしない）
CREATE TABLE public.job_marketing_references (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES public.job_marketing_categories(id),
  company_name TEXT NOT NULL CHECK (btrim(company_name) <> '' AND char_length(company_name) <= 200),
  job_title TEXT CHECK (job_title IS NULL OR char_length(job_title) <= 200),
  url TEXT CHECK (url IS NULL OR (char_length(url) <= 2000 AND url ~* '^https?://')),
  memo TEXT CHECK (memo IS NULL OR char_length(memo) <= 2000),
  checked_on DATE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 追記専用・削除禁止
CREATE FUNCTION public.job_marketing_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '%は追記専用です（%は禁止）', TG_TABLE_NAME, TG_OP;
END
$fn$;

CREATE TRIGGER job_marketing_records_no_update BEFORE UPDATE OR DELETE ON public.job_marketing_records
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_records_no_truncate BEFORE TRUNCATE ON public.job_marketing_records
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_imports_no_update BEFORE UPDATE OR DELETE ON public.job_marketing_imports
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_imports_no_truncate BEFORE TRUNCATE ON public.job_marketing_imports
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_postings_no_update BEFORE UPDATE OR DELETE ON public.job_marketing_postings
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_postings_no_truncate BEFORE TRUNCATE ON public.job_marketing_postings
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_plan_events_no_update BEFORE UPDATE OR DELETE ON public.job_marketing_plan_events
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_plan_events_no_truncate BEFORE TRUNCATE ON public.job_marketing_plan_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_category_events_no_update BEFORE UPDATE OR DELETE ON public.job_marketing_category_events
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_category_events_no_truncate BEFORE TRUNCATE ON public.job_marketing_category_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();
-- 職種・参考求人は UPDATE のみ許可（物理削除しない）
CREATE TRIGGER job_marketing_categories_no_delete BEFORE DELETE ON public.job_marketing_categories
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_categories_no_truncate BEFORE TRUNCATE ON public.job_marketing_categories
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_references_no_delete BEFORE DELETE ON public.job_marketing_references
  FOR EACH ROW EXECUTE FUNCTION public.job_marketing_append_only();
CREATE TRIGGER job_marketing_references_no_truncate BEFORE TRUNCATE ON public.job_marketing_references
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_marketing_append_only();

-- 初期職種（後から画面で追加・名称変更・募集停止できる）
INSERT INTO public.job_marketing_categories (name, sort_order) VALUES
  ('営業', 10), ('CADオペ（ときがわ）', 20), ('CADオペ（本社）', 30), ('電気工事士', 40);
INSERT INTO public.job_marketing_category_events (category_id, kind, after_value, actor)
  SELECT id, 'created', name, 'migration-004' FROM public.job_marketing_categories;

-- Supabase の公開ロールからは参照させない（APIサーバーのみ直接接続）
DO $$
DECLARE
  t text;
  role_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_marketing_categories', 'job_marketing_category_events', 'job_marketing_postings', 'job_marketing_plan_events', 'job_marketing_imports', 'job_marketing_records', 'job_marketing_references'] LOOP
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
  REVOKE ALL ON FUNCTION public.job_marketing_append_only() FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.job_marketing_append_only() FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- 削除（DROP）について: 新しいAPIの稼働中は削除しないこと（テーブル有りの判定を保持しているため）。
-- 旧コードへ戻した後に限り、依存順（records / plan_events → postings / imports / references / category_events → categories）で DROP する。
