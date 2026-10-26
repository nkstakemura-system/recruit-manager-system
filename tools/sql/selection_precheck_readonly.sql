-- 選考履歴 migration（003）適用前の確認。読み取りのみ（SELECT だけ。書き込み・設定変更なし）。
-- 応募者の氏名・連絡先・理由の文面などは出力せず、件数（と列の型など構造情報）だけを確認する。
--
-- 実行方法（どちらも読み取り専用）
--   * psql（推奨。トランザクションごと読み取り専用にして最後に取り消す）
--     次の1行をそのまま実行する（<接続先> だけを置き換える）
--     psql -X -v ON_ERROR_STOP=1 "<接続先>" -c "BEGIN TRANSACTION READ ONLY" -c "SHOW transaction_read_only" -f tools/sql/selection_precheck_readonly.sql -c "ROLLBACK"
--     （最初に表示される transaction_read_only が on であることを確認する）
--   * Supabase の SQL Editor：最後の結果しか表示されないため、番号ごとに選択して実行する。
--     全体を実行した場合は、最後の「9. まとめ」だけが表示される。
--     （この場合、接続自体は読み取り専用にならない。このファイルが SELECT だけであることはテストで確認している）
-- このSQLは「選考履歴の作成前」の既存データの検査。作成後に旧コード等で変更された不一致は、選考の画面
--（「既存データと選考履歴が一致しない」表示）と手順書 6. の確認SQLで扱う。
-- 判定は api-server/selectionFlow.js（syncIssues / legacyEvents / deriveMirror）と
-- api-server/selectionPgStore.js（日付の範囲判定・受付日の列型）と同じ規則（tests/selection-flow.test.cjs で照合）。

-- 1. candidates.id の型（migration はこの型で外部キーを作る）
SELECT format_type(a.atttypid, a.atttypmod) AS candidates_id_type
FROM pg_attribute a
WHERE a.attrelid = 'public.candidates'::regclass AND a.attname = 'id' AND NOT a.attisdropped;

-- 2. candidates.id に主キー／一意制約があるか（外部キーの前提。無ければ migration は失敗して全体が取り消される）
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'public.candidates'::regclass AND contype IN ('p', 'u')
  AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.candidates'::regclass AND attname = 'id')];

-- 3. 同名テーブル・関数が既に無いこと（どちらも NULL / false であること。あれば migration は停止する）
SELECT to_regclass('public.candidate_selection_events') AS existing_table,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'candidate_selection_events_append_only'
    AND pronamespace = 'public'::regnamespace) AS existing_function;

-- 4. 現在の接続ロールと candidates の所有者（APIの接続ロールが新テーブルの所有者になる想定。RLSの影響確認用）
--    日付の表示形式（DateStyle）は ISO であること（8. の受付日の判定が前提とする）
SELECT current_user AS current_role,
  (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'candidates') AS candidates_owner,
  current_setting('DateStyle') AS date_style;

-- 5. 各列の型
--    * applied_at が date / timestamp / timestamptz 以外の場合、受付日の変更は409で停止する
--    * 面接日・内定日・入社予定日は date または timestamp であること（6〜9 の範囲判定の前提）
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'candidates'
  AND column_name IN ('id', 'status', 'applied_at', 'interview_1_date', 'interview_2_date', 'offer_date',
    'expected_join_date', 'decline_reason', 'interview_2_attendee', 'contact_history', 'is_coop', 'is_deleted')
ORDER BY column_name;

-- 6. 個人応募の status と日付の組み合わせ別の件数
--    consistency = 'NG' の組み合わせは、選考の更新（工程の追加・訂正・取消）が409
--    （既存データと選考履歴が不一致）となり、自動補正しない。
--    未定義の status（1〜6・9 以外、NULL を含む）は日付に関係なく NG。
--    例外：status 1（受付）＋1次面接日のみ（2次面接日・内定日・入社予定日なし）は OK（従来データとして互換扱い）。
--    1次面接の予定として表示し、status は受付のまま。面接の実施は推定せず、利用者が「1次面接（完了）」を登録する。
WITH c AS (
  SELECT status::text AS st,
    interview_1_date IS NOT NULL AS i1, interview_2_date IS NOT NULL AS i2,
    offer_date IS NOT NULL AS offer, expected_join_date IS NOT NULL AS joinp
  FROM public.candidates
  WHERE COALESCE(is_coop, false) = false
)
SELECT st AS status, i1, i2, offer, joinp, count(*) AS candidates,
  CASE
    WHEN st IS NULL OR st NOT IN ('1', '2', '3', '4', '5', '6', '9') THEN 'NG'
    WHEN st = '1' THEN CASE WHEN i2 OR offer OR joinp THEN 'NG' ELSE 'OK' END
    WHEN st = '2' THEN CASE WHEN i1 OR i2 OR offer OR joinp THEN 'NG' ELSE 'OK' END
    WHEN st = '3' THEN CASE WHEN i2 OR offer OR joinp THEN 'NG' ELSE 'OK' END
    WHEN st = '4' THEN CASE WHEN offer OR joinp THEN 'NG' ELSE 'OK' END
    ELSE 'OK'
  END AS consistency
FROM c
GROUP BY st, i1, i2, offer, joinp
ORDER BY consistency DESC, status, i1, i2, offer, joinp;

-- 7. 選考の日付列が西暦1〜9999年の範囲外（紀元前・5桁年）の件数（列別）
--    該当する応募者は選考の更新が409で停止する（値を消去・上書きしない）。
SELECT
  count(*) FILTER (WHERE interview_1_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AS interview_1_date_out_of_range,
  count(*) FILTER (WHERE interview_2_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AS interview_2_date_out_of_range,
  count(*) FILTER (WHERE offer_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AS offer_date_out_of_range,
  count(*) FILTER (WHERE expected_join_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AS expected_join_date_out_of_range
FROM public.candidates
WHERE COALESCE(is_coop, false) = false;

-- 8. 受付日・連絡履歴（409にはならないが、確認が必要な件数）
--    * applied_at_unreadable: 受付日が「YYYY-MM-DD」で始まらない、または紀元前（列型によらず文字列で判定）。
--      選考画面の受付日が空欄表示となり、受付日を変更すると元の値は履歴（baseline）に文字列のまま残る。
--    * applied_at_type_unsupported: 1 の場合、受付日の変更はすべて409で停止する（列型が date / timestamp 以外）。
--    * contact_history_not_array: 連絡履歴が配列（[...]）でない件数。選考画面では空として表示され、
--      連絡履歴を保存すると上書きされる（変更前の値は履歴に残るが、配列でない値は空として記録される）。
SELECT
  count(*) FILTER (WHERE applied_at IS NOT NULL AND (applied_at::text !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])'
    OR applied_at::text LIKE '%BC%')) AS applied_at_unreadable,
  (SELECT CASE WHEN data_type IN ('date', 'timestamp without time zone', 'timestamp with time zone') THEN 0 ELSE 1 END
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'candidates' AND column_name = 'applied_at') AS applied_at_type_unsupported,
  count(*) FILTER (WHERE contact_history IS NOT NULL AND left(btrim(contact_history::text), 1) <> '[') AS contact_history_not_array
FROM public.candidates
WHERE COALESCE(is_coop, false) = false;

-- 9. まとめ（項目ごとの件数。blocked_* が選考の更新で409となる応募者数）
--    * blocked_total / blocked_active: 6 の NG または 7 の範囲外のいずれかに該当する個人応募（active は論理削除以外）
--    * received_with_interview_1_compatible: status 1＋1次面接日のみ（互換扱い。409にならない）の件数
--    * coop_null: is_coop が NULL の件数（個人応募として扱われる）
WITH f AS (
  SELECT
    COALESCE(is_deleted, false) AS deleted,
    (status IS NULL OR status::text NOT IN ('1', '2', '3', '4', '5', '6', '9')) AS undefined_status,
    CASE status::text
      WHEN '1' THEN interview_2_date IS NOT NULL OR offer_date IS NOT NULL OR expected_join_date IS NOT NULL
      WHEN '2' THEN interview_1_date IS NOT NULL OR interview_2_date IS NOT NULL OR offer_date IS NOT NULL OR expected_join_date IS NOT NULL
      WHEN '3' THEN interview_2_date IS NOT NULL OR offer_date IS NOT NULL OR expected_join_date IS NOT NULL
      WHEN '4' THEN offer_date IS NOT NULL OR expected_join_date IS NOT NULL
      ELSE false
    END AS status_date_mismatch,
    (status::text = '1' AND interview_1_date IS NOT NULL AND interview_2_date IS NULL
      AND offer_date IS NULL AND expected_join_date IS NULL) AS received_with_interview_1,
    COALESCE(interview_1_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31', false)
      OR COALESCE(interview_2_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31', false)
      OR COALESCE(offer_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31', false)
      OR COALESCE(expected_join_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31', false) AS date_out_of_range
  FROM public.candidates
  WHERE COALESCE(is_coop, false) = false
)
SELECT
  count(*) AS personal_total,
  count(*) FILTER (WHERE undefined_status) AS undefined_status,
  count(*) FILTER (WHERE status_date_mismatch) AS status_date_mismatch,
  count(*) FILTER (WHERE date_out_of_range) AS date_out_of_range,
  count(*) FILTER (WHERE received_with_interview_1 AND NOT date_out_of_range) AS received_with_interview_1_compatible,
  count(*) FILTER (WHERE undefined_status OR status_date_mismatch OR date_out_of_range) AS blocked_total,
  count(*) FILTER (WHERE (undefined_status OR status_date_mismatch OR date_out_of_range) AND NOT deleted) AS blocked_active,
  (SELECT count(*) FROM public.candidates WHERE is_coop IS NULL) AS coop_null
FROM f;
