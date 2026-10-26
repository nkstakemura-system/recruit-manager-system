-- 選考履歴テーブル（第2弾）。手動適用専用。アプリ起動時には実行しない。
--
-- 方針
-- * 既存の candidates の値は変更・移行・補正・削除しない。
--   （各応募者の最初の選考更新時に、APIが既存値を baseline として履歴へ追記する）
-- * 履歴は追記専用。訂正・取消は correction / void の行を追記し、元の行は UPDATE・DELETE しない。
--   トリガーで UPDATE・直接の DELETE・TRUNCATE を拒否する。
--   応募者の「完全消去」（candidates の物理削除）時のみ、外部キーの連鎖削除で履歴も消える。
-- * candidates.id の型は推測せず、実行時に pg_attribute から読み取って同じ型で外部キーを作成する。
-- * 同名テーブルが既にある場合（失敗した旧パッチ版など）は作成せずエラーで停止する。
--
-- * ロック待ちが長引く場合は待たずに失敗する（lock_timeout）。失敗時は全体が取り消され、何も作成されない。
--   外部キーの作成で candidates に SHARE ROW EXCLUSIVE ロックを取る（参照は止めないが、待機中・保持中は
--   応募者の保存が待たされる）。待機が既存画面の保存を止め続けないよう、3秒で打ち切る。
--
-- 手順書（事前確認・適用・失敗時・切り戻し・完全削除の扱い）: tools/sql/RUNBOOK_selection_migration.md
-- 適用前の確認（読み取りのみ）: tools/sql/selection_precheck_readonly.sql
-- 適用順: このSQLを適用 → 確認 → 新しいAPI/画面をデプロイ。
-- （新しいAPIはテーブル未作成でも従来どおり動作し、選考履歴機能のみ停止する）
BEGIN;

-- このトランザクション内だけの設定（SET LOCAL。接続プールの他の利用者には影響しない）
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  id_type text;
BEGIN
  IF to_regclass('public.candidate_selection_events') IS NOT NULL THEN
    RAISE EXCEPTION 'public.candidate_selection_events が既に存在します。構造を確認してください（自動では変更しません）';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.candidates'::regclass AND a.attname = 'id' AND NOT a.attisdropped;
  IF id_type IS NULL THEN
    RAISE EXCEPTION 'public.candidates.id が見つかりません';
  END IF;

  EXECUTE format($sql$
    CREATE TABLE public.candidate_selection_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      candidate_id %s NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      kind TEXT NOT NULL CHECK (kind IN (
        'document_received', 'interview_scheduled', 'interview_completed', 'offer', 'join_planned', 'joined',
        'declined', 'no_contact', 'rejected', 'contacting',
        'baseline', 'correction', 'void', 'applied_date_changed', 'contact_history_changed'
      )),
      stage_number INTEGER CHECK (stage_number >= 1),
      event_date DATE CHECK (event_date IS NULL OR event_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
      note TEXT,
      attendee TEXT,
      ended_stage TEXT,
      source TEXT NOT NULL CHECK (source IN ('user', 'legacy')),
      target_event_id BIGINT REFERENCES public.candidate_selection_events(id),
      payload JSONB,
      actor TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT candidate_selection_events_seq_unique UNIQUE (candidate_id, seq),
      -- 面接の工程だけが回数を持つ（上限は設けない）
      CONSTRAINT candidate_selection_events_stage_check
        CHECK ((kind IN ('interview_scheduled', 'interview_completed')) = (stage_number IS NOT NULL)),
      -- 訂正・取消だけが対象の行を参照する
      CONSTRAINT candidate_selection_events_target_check
        CHECK ((kind IN ('correction', 'void')) = (target_event_id IS NOT NULL)),
      -- 利用者が登録する工程・訂正には日付が必須（既存データ由来の行は日付未登録を許容）
      CONSTRAINT candidate_selection_events_date_check
        CHECK (source = 'legacy' OR event_date IS NOT NULL
          OR kind IN ('baseline', 'void', 'contact_history_changed')),
      -- 利用者入力の長さ（既存データ由来の値は元のまま保存するため対象外）
      CONSTRAINT candidate_selection_events_text_check
        CHECK (source = 'legacy' OR ((note IS NULL OR char_length(note) <= 1000)
          AND (attendee IS NULL OR char_length(attendee) <= 100)))
    )$sql$, id_type);
END $$;

-- 同じ行を二重に取り消せないようにする（同時操作の最終防御。通常はAPIの版照合で409）
CREATE UNIQUE INDEX candidate_selection_events_void_once
  ON public.candidate_selection_events (target_event_id) WHERE kind = 'void';
CREATE INDEX candidate_selection_events_target_idx
  ON public.candidate_selection_events (target_event_id) WHERE target_event_id IS NOT NULL;

-- 追記専用にする
CREATE FUNCTION public.candidate_selection_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- candidates の物理削除（完全消去）に伴う外部キーの連鎖削除のみ許可
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '選考履歴は追記専用です（%は禁止）', TG_OP;
END
$fn$;

CREATE TRIGGER candidate_selection_events_no_update
  BEFORE UPDATE ON public.candidate_selection_events
  FOR EACH ROW EXECUTE FUNCTION public.candidate_selection_events_append_only();
CREATE TRIGGER candidate_selection_events_no_delete
  BEFORE DELETE ON public.candidate_selection_events
  FOR EACH ROW EXECUTE FUNCTION public.candidate_selection_events_append_only();
CREATE TRIGGER candidate_selection_events_no_truncate
  BEFORE TRUNCATE ON public.candidate_selection_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.candidate_selection_events_append_only();

-- 応募者情報は機微情報のため、Supabase の公開ロールからは参照させない（APIサーバーのみ直接接続）。
ALTER TABLE public.candidate_selection_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.candidate_selection_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.candidate_selection_events_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION public.candidate_selection_events_append_only() FROM PUBLIC;
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.candidate_selection_events FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.candidate_selection_events_id_seq FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.candidate_selection_events_append_only() FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- テーブルの削除（DROP）について:
--   新しいAPIの稼働中は削除しないこと（テーブル有りの判定を保持しているため、一覧表示・選考の更新・管理種別の変更がエラーになる）。
--   削除は、旧コードへ戻した後、かつ履歴が0件の場合に限る。手順は RUNBOOK_selection_migration.md の「6.」を参照。
