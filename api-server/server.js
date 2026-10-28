const express = require("express");
const { createAuth } = require("./auth");
const db = require("./db");
const { normalizeOfferDate, initialOfferDate, todayTokyo, offerDateUpdateSql } = require("./offerDate");
const selectionFlow = require("./selectionFlow");
const selection = require("./selectionService");
const { createPgSelectionStore, dateColumn } = require("./selectionPgStore");
const { buildFacts } = require("./dashboardFacts");
const contacts = require("./contactService");
require("dotenv").config();

const app = express();

app.use(express.json({ limit: "1mb" }));
const auth = createAuth();
auth.install(app);
const PORT = process.env.PORT || 5000;
const optionalText = value => typeof value === "string" && value.trim() ? value.trim() : null;
const selectionStore = createPgSelectionStore(db);
const contactStore = contacts.createPgContactStore(db);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// 個人応募の選考列は、選考履歴テーブルが存在する間（$69）は選考履歴APIだけが更新する。
// 送られなかった選考列は保持する（$70〜$77 は各列が送られたかどうか）。
const PUT_SELECTION_FLAGS = [
  ["status", "$7", "$70"], ["decline_reason", "$8", "$71"], ["interview_1_date", "$9", "$72"],
  ["interview_2_date", "$10", "$73"], ["expected_join_date", "$43", "$74"], ["contact_history", "$47", "$75"],
  ["interview_2_attendee", "$48", "$76"], ["applied_at", "$49", "$77"],
];
const isLongYear = value => (typeof value === "string" ? /^\s*\d{5,}\s*$/.test(value) : Number.isInteger(value) && value > 9999);
const longYearFields = b => [
  b.graduation_year,
  ...(Array.isArray(b.work_history) ? b.work_history.flatMap(w => [w?.start_year, w?.end_year]) : []),
  ...(Array.isArray(b.licenses) ? b.licenses.map(l => l?.date) : []),
].filter(isLongYear);
const legacySelectionWrite ="(is_coop IS TRUE OR NOT $69::boolean)";
const putSelectionSet = column => {
  const [, value, flag] = PUT_SELECTION_FLAGS.find(([name]) => name === column);
  return `${column}=CASE WHEN ${flag}::boolean AND ${legacySelectionWrite} THEN ${value} ELSE ${column} END`;
};

// Meeting tokens are accepted only by this read-only endpoint.
app.get("/api/meeting/hr-summary", auth.requireMeeting, async (req, res) => {
  try {
    const { calendarDate, buildHrSummary, reportMonth } = await import("../shared/hrSummary.mjs");
    const asOf = calendarDate();
    let month;
    try { month = reportMonth(req.query?.month, asOf); } catch { return res.status(400).json({ error: "Invalid report month" }); }
    const result = await db.query(
      `SELECT id, name_kanji, status,
        to_char(expected_join_date, 'YYYY-MM-DD') AS expected_join_date,
        planned_department, job_title, employment_type,
        applied_at,
        to_char(interview_1_date, 'YYYY-MM-DD') AS interview_1_date,
        to_char(interview_2_date, 'YYYY-MM-DD') AS interview_2_date,
        to_char(offer_date, 'YYYY-MM-DD') AS offer_date
      FROM candidates
      WHERE COALESCE(is_coop, false) = false
        AND COALESCE(is_deleted, false) = false
        AND COALESCE(is_retired, false) = false
        AND (retirement_date IS NULL OR retirement_date > $1::date)`,
      [asOf],
    );
    res.json(buildHrSummary(result.rows, asOf, month));
  } catch (err) {
    console.error("Database operation failed");
    res.status(500).send("Server Error");
  }
});
// Protect every remaining API, including future routes and physical deletion.
app.use("/api", auth.requireSession);
// --- 応募者関連 API ---
app.get("/api/candidates", async (req, res) => {
  try {
    // 選考履歴テーブル未作成でも一覧は従来どおり表示する。
    // 一覧バッジには、取消されていない最新の工程（実際の面接回数）を使う。
    // 最新工程の日付は訂正後の値（終了タブの終了日に使う）。
    const result = (await selectionStore.ready())
      ? await db.query(
        `SELECT c.*, to_char(c.offer_date, 'YYYY-MM-DD') AS offer_date,
          le.kind AS latest_selection_kind, le.stage_number AS latest_selection_stage,
          le.unconfirmed_legacy AS latest_selection_unconfirmed_legacy, le.event_date AS latest_selection_date
        FROM candidates c
        LEFT JOIN LATERAL (
          SELECT e.kind, e.stage_number,
            COALESCE((
              SELECT to_char(x.event_date, 'YYYY-MM-DD') FROM public.candidate_selection_events x
              WHERE x.candidate_id = c.id AND x.kind = 'correction' AND x.target_event_id = e.id
              ORDER BY x.seq DESC LIMIT 1
            ), to_char(e.event_date, 'YYYY-MM-DD')) AS event_date,
            -- selectionFlow.isUnconfirmedLegacyInterview と同じ条件（従来データの受付のまま1次面接日のみ）
            (e.source = 'legacy' AND e.kind = 'interview_scheduled' AND e.stage_number = 1
              AND e.payload->>'legacy_status' = '1') IS TRUE AS unconfirmed_legacy
          FROM public.candidate_selection_events e
          WHERE e.candidate_id = c.id
            AND e.kind NOT IN ('baseline', 'correction', 'void', 'applied_date_changed', 'contact_history_changed')
            AND NOT EXISTS (
              SELECT 1 FROM public.candidate_selection_events v
              WHERE v.candidate_id = c.id AND v.kind = 'void' AND v.target_event_id = e.id
            )
          ORDER BY e.seq DESC LIMIT 1
        ) le ON true
        ORDER BY c.created_at DESC`,
      )
      : await db.query(
        "SELECT *, to_char(offer_date, 'YYYY-MM-DD') AS offer_date FROM candidates ORDER BY created_at DESC",
      );
    // 従来データの「受付のまま1次面接日のみ」は、一覧も既存の status（受付）で表示する
    res.json(result.rows.map(row => row.latest_selection_kind && row.latest_selection_unconfirmed_legacy !== true
      ? { ...row, ...selectionFlow.listSelectionFields(row.latest_selection_kind, row.latest_selection_stage, row.latest_selection_date) }
      : row));
  } catch (err) {
    console.error("Database operation failed");
    res.status(500).send("Server Error");
  }
});

// 期別ダッシュボードの集計元（読み取りのみ）。応募者ごとの選考の事実だけを返し、氏名・連絡先は返さない。
// 選考履歴テーブル未作成時は、既存列から投影した工程（日付不明は null）で返す。
app.get("/api/dashboard/facts", async (req, res) => {
  try {
    const managed = await selectionStore.ready();
    const candidates = (await db.query(
      `SELECT id, is_coop, is_deleted, status::text AS status, applied_at, decline_reason,
        ${dateColumn("interview_1_date")}, ${dateColumn("interview_2_date")},
        ${dateColumn("offer_date")}, ${dateColumn("expected_join_date")}
      FROM public.candidates`,
    )).rows;
    const events = managed ? (await db.query(
      `SELECT candidate_id::text AS candidate_id, id::text AS id, seq, kind, stage_number,
        to_char(event_date, 'YYYY-MM-DD') AS event_date, source, target_event_id::text AS target_event_id
      FROM public.candidate_selection_events ORDER BY candidate_id, seq`,
    )).rows : [];
    res.json({ as_of: todayTokyo(), history_table: managed, facts: buildFacts(candidates, events) });
  } catch (err) {
    console.error("Database operation failed");
    res.status(500).send("Server Error");
  }
});

app.get("/api/candidates/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT *, to_char(offer_date, 'YYYY-MM-DD') AS offer_date FROM candidates WHERE id = $1", [
      req.params.id,
    ]);
    if (result.rows.length === 0) return res.status(404).send("Not Found");
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

app.post("/api/candidates", async (req, res) => {
  let offerDate;
  try { offerDate = initialOfferDate(req.body.status || 1, req.body.offer_date); }
  catch { return res.status(400).json({ error: "Invalid offer date" }); }
  const {
    name_kanji,
    name_kana,
    age,
    birth_year,
    experience,
    tel,
    email,
    status,
    primary_contact,
    applied_at,
    is_coop,
    company_name,
    introducer,
    internal_contact,
    desired_dept,
    subcontract_status,
    source_type,
    agent_name,
    introducer_fee, // ★追加
    job_title,
    planned_department,
    employment_type,
  } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO candidates (
        name_kanji, name_kana, age, birth_year, experience, 
        tel, email, status, primary_contact, applied_at,
        is_coop, company_name, introducer, internal_contact, desired_dept, subcontract_status,
        source_type, agent_name, introducer_fee, job_title, planned_department, employment_type, offer_date
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
      [
        name_kanji,
        name_kana,
        age || null,
        birth_year || null,
        experience,
        JSON.stringify(tel || []),
        JSON.stringify(email || []),
        status || 1,
        primary_contact,
        applied_at || new Date(),
        is_coop || false,
        company_name || null,
        introducer || null,
        internal_contact || null,
        desired_dept || null,
        subcontract_status || null,
        source_type || null,
        agent_name || null,
        introducer_fee || null, // $17, $18, $19
        optionalText(job_title),
        optionalText(planned_department),
        optionalText(employment_type),
        offerDate,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Database operation failed");
    res.status(500).send("Server Error");
  }
});

app.put("/api/candidates/:id", async (req, res) => {
  const b = req.body;
  let offerDate;
  try { offerDate = normalizeOfferDate(b.offer_date); }
  catch { return res.status(400).json({ error: "Invalid offer date" }); }
  // 生年月日の5桁以上の年（標準カレンダーで入力できてしまう値）は保存しない
  if (typeof b.birth_date === "string" && /^[+-]?\d{5,}/.test(b.birth_date.trim())) {
    return res.status(400).json({ error: "生年月日は西暦4桁で入力してください" });
  }
  // 卒業年・職歴の入社年／退社年・資格の取得年の5桁以上の年も保存しない（その他の既存の記載は従来どおり）
  if (longYearFields(b).length) {
    return res.status(400).json({ error: "年は西暦4桁で入力してください" });
  }
  let client;
  try {
    // 応募者行のロック → 選考履歴の有無の確認 → 判定 → 更新 を1トランザクションで行う。
    // 選考履歴APIも同じ行を FOR UPDATE でロックするため、判定から更新までの間に履歴が追加されることはない。
    client = await db.connect();
    await client.query("BEGIN");
    const current = (await client.query("SELECT is_coop FROM candidates WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    const selectionManaged = await selectionStore.ready(client);
    const currentIsCoop = current?.is_coop === true;
    // 管理種別が送られなかった場合は現在の値を保持する（省略で個人応募へ戻らないようにする）
    const isCoop = hasOwn(b, "is_coop") ? Boolean(b.is_coop) : current ? current.is_coop : false;
    const coopChanged = Boolean(current) && Boolean(isCoop) !== currentIsCoop;
    const hasHistory = selectionManaged && coopChanged && (await client.query(
      "SELECT EXISTS (SELECT 1 FROM public.candidate_selection_events WHERE candidate_id = $1) AS found", [req.params.id],
    )).rows[0]?.found === true;
    // 選考履歴がある応募者の管理種別変更、古い画面からの選考列は、黙って無視せず409で停止する（協力業者は従来どおり保存）。
    const conflict = current && selectionFlow.candidatePutConflict({
      managed: selectionManaged, currentIsCoop, nextIsCoop: Boolean(isCoop), hasHistory, body: b,
    });
    if (conflict) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: conflict.message, code: conflict.code });
    }
    await client.query(
      `UPDATE candidates SET
        name_kanji=$1, name_kana=$2, age=$3, birth_year=$4, tel=COALESCE($5, tel), email=COALESCE($6, email),
        ${putSelectionSet("status")}, ${putSelectionSet("decline_reason")},
        ${putSelectionSet("interview_1_date")}, ${putSelectionSet("interview_2_date")},
        motivation_memo=$11, prev_salary=$12, desired_salary=$13, commute_method=$14, 
        experience_memo=$15, available_date=$16, other_selection_status=$17, other_memo=$18,
        qa_1=$19, qa_2=$20, interview_2_memo=$21, agent_name=$22, resume_memo=$23,
        zip_code=$24, address=$25, address_banchi=$26, address_building=$27, address_room=$28,
        emerg_zip_code=$29, emerg_address=$30, emerg_address_banchi=$31, emerg_address_building=$32, emerg_address_room=$33,
        emerg_tel=$34, emerg_name=$35, emerg_relation=$36, education=$37, graduation_year=$38, 
        work_history=$39, licenses=$40, family=$41, commute_time=$42, ${putSelectionSet("expected_join_date")},
        birth_date=$44, is_retired=$45, retirement_date=$46,
        ${putSelectionSet("contact_history")}, ${putSelectionSet("interview_2_attendee")},
        ${putSelectionSet("applied_at")}, is_coop=$50, company_name=$51, introducer=$52, internal_contact=$53,
        desired_dept=$54, subcontract_status=$55,
        source_type=$57, introducer_fee=$58,
        job_title=CASE WHEN $59::boolean THEN $60::text ELSE job_title END,
        planned_department=CASE WHEN $61::boolean THEN $62::text ELSE planned_department END,
        employment_type=CASE WHEN $63::boolean THEN $64::text ELSE employment_type END,
        offer_date=CASE WHEN ${legacySelectionWrite} THEN (${offerDateUpdateSql.replace(/^offer_date=/, "")}) ELSE offer_date END
      WHERE id = $56`,
      [
        b.name_kanji,
        b.name_kana,
        b.age || null,
        b.birth_year || null,
        // 連絡先は連絡先API（PATCH /contacts）だけが更新する。古い画面の全項目保存で上書きしないよう、
        // $5・$6 は常に NULL を渡して現在の値を保持する
        null,
        null,
        b.status,
        b.decline_reason,
        b.interview_1_date || null,
        b.interview_2_date || null,
        b.motivation_memo,
        b.prev_salary,
        b.desired_salary,
        b.commute_method,
        b.experience_memo,
        b.available_date,
        b.other_selection_status,
        b.other_memo,
        JSON.stringify(b.qa_1 || []),
        JSON.stringify(b.qa_2 || []),
        b.interview_2_memo,
        b.agent_name,
        b.resume_memo,
        b.zip_code,
        b.address,
        b.address_banchi,
        b.address_building,
        b.address_room,
        b.emerg_zip_code,
        b.emerg_address,
        b.emerg_address_banchi,
        b.emerg_address_building,
        b.emerg_address_room,
        b.emerg_tel,
        b.emerg_name,
        b.emerg_relation,
        b.education,
        b.graduation_year,
        JSON.stringify(b.work_history || []),
        JSON.stringify(b.licenses || []),
        JSON.stringify(b.family || []),
        b.commute_time,
        b.expected_join_date || null,
        b.birth_date || null,
        b.is_retired || false,
        b.retirement_date || null,
        JSON.stringify(b.contact_history || []),
        b.interview_2_attendee,
        b.applied_at,
        isCoop,
        b.company_name,
        b.introducer,
        b.internal_contact,
        b.desired_dept,
        b.subcontract_status,
        req.params.id, // $56
        b.source_type || null, // $57 ★重要
        b.introducer_fee || null, // $58 ★重要
        Object.prototype.hasOwnProperty.call(b, "job_title"), optionalText(b.job_title),
        Object.prototype.hasOwnProperty.call(b, "planned_department"), optionalText(b.planned_department),
        Object.prototype.hasOwnProperty.call(b, "employment_type"), optionalText(b.employment_type),
        Object.prototype.hasOwnProperty.call(b, "offer_date"), offerDate, todayTokyo(), b.status,
        selectionManaged, // $69
        ...PUT_SELECTION_FLAGS.map(([field]) => hasOwn(b, field)), // $70〜$77
      ],
    );
    await client.query("COMMIT");
    res.json({ message: "更新完了" });
  } catch (err) {
    if (client) try { await client.query("ROLLBACK"); } catch { /* 接続断時は元のエラーを優先 */ }
    console.error("Database operation failed");
    res.status(500).send("Server Error");
  } finally {
    client?.release();
  }
});

// --- 選考履歴 API（個人応募のみ。協力業者は従来の進捗更新を使用） ---
const selectionRoute = handler => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code, fields: err.fields });
    console.error("Selection operation failed");
    res.status(500).json({ error: "選考情報を保存できませんでした" });
  }
};
// 監査用の操作者（ログインユーザー名と利用端末）
const selectionActor = req => `${req.authUser?.username || "unknown"}@${req.get("Authorization") ? "mobile" : "web"}`;
app.get("/api/candidates/:id/selection", selectionRoute(req =>
  selection.getTimeline(selectionStore, req.params.id)));
app.post("/api/candidates/:id/selection/events", selectionRoute(req =>
  selection.addStep(selectionStore, req.params.id, req.body, selectionActor(req))));
// 訂正・取消は元の工程を変更せず、記録を追記する
app.post("/api/candidates/:id/selection/events/:eventId/correction", selectionRoute(req =>
  selection.correctStep(selectionStore, req.params.id, req.params.eventId, req.body, selectionActor(req))));
app.post("/api/candidates/:id/selection/events/:eventId/void", selectionRoute(req =>
  selection.voidStep(selectionStore, req.params.id, req.params.eventId, req.body, selectionActor(req))));
app.patch("/api/candidates/:id/selection/applied-date", selectionRoute(req =>
  selection.setAppliedDate(selectionStore, req.params.id, req.body, selectionActor(req))));
app.patch("/api/candidates/:id/selection/contact-history", selectionRoute(req =>
  selection.setContactHistory(selectionStore, req.params.id, req.body, selectionActor(req))));

// --- 連絡先 API（TEL・Email・代表連絡先のみ。画面が読み込んだ時点の値と違う場合は409） ---
app.patch("/api/candidates/:id/contacts", async (req, res) => {
  try {
    res.json(await contacts.updateContacts(contactStore, req.params.id, req.body));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code, field: err.field, current: err.current });
    console.error("Contact update failed");
    res.status(500).json({ error: "連絡先を保存できませんでした" });
  }
});

// 論理削除（非表示）
app.delete("/api/candidates/:id", async (req, res) => {
  try {
    await db.query("UPDATE candidates SET is_deleted = true WHERE id = $1", [
      req.params.id,
    ]);
    res.json({ message: "削除しました" });
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

// ★追加：物理削除（完全抹消）
app.delete("/api/candidates/:id/physical", async (req, res) => {
  try {
    await db.query("DELETE FROM candidates WHERE id = $1", [req.params.id]);
    res.json({ message: "完全に削除しました" });
  } catch (err) {
    console.error("Database operation failed");
    res.status(500).send("Server Error");
  }
});

app.patch("/api/candidates/:id/restore", async (req, res) => {
  try {
    await db.query(
      "UPDATE candidates SET is_deleted = false, is_retired = false, retirement_date = null WHERE id = $1",
      [req.params.id],
    );
    res.json({ message: "復元しました" });
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

// --- 採用経費関連 API ---
app.get("/api/expenses", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM recruitment_expenses ORDER BY expense_date DESC",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

app.post("/api/expenses", async (req, res) => {
  const { payee, amount, expense_date } = req.body;
  try {
    const result = await db.query(
      "INSERT INTO recruitment_expenses (payee, amount, expense_date) VALUES ($1, $2, $3) RETURNING *",
      [payee, amount, expense_date],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

app.delete("/api/expenses/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM recruitment_expenses WHERE id = $1", [
      req.params.id,
    ]);
    res.json({ message: "削除しました" });
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

app.put("/api/expenses/:id", async (req, res) => {
  const { payee, amount, expense_date } = req.body;
  try {
    const result = await db.query(
      "UPDATE recruitment_expenses SET payee = $1, amount = $2, expense_date = $3 WHERE id = $4 RETURNING *",
      [payee, amount, expense_date, req.params.id],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Database operation failed");
    res.status(500).send("Server Error");
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
const path = require("path");
app.use(express.static(path.join(__dirname, "../react-app/dist")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../react-app/dist/index.html"));
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
