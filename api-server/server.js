const express = require("express");
const cors = require("cors");
const db = require("./db");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 5000;

// --- 応募者関連 API ---
app.get("/api/candidates", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM candidates ORDER BY created_at DESC",
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

app.get("/api/candidates/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM candidates WHERE id = $1", [
      req.params.id,
    ]);
    if (result.rows.length === 0) return res.status(404).send("Not Found");
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

app.post("/api/candidates", async (req, res) => {
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
    applied_at, // フロントから届く 'YYYY-MM-DD' 形式
    is_coop,
    company_name,
    introducer,
    internal_contact,
    desired_dept,
    subcontract_status,
  } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO candidates (
        name_kanji, name_kana, age, birth_year, experience, 
        tel, email, status, primary_contact, applied_at,
        is_coop, company_name, introducer, internal_contact, desired_dept, subcontract_status
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
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
        applied_at || new Date(), // ★ここで空文字やundefinedを許容せず値を確実に渡す
        is_coop || false,
        company_name || null,
        introducer || null,
        internal_contact || null,
        desired_dept || null,
        subcontract_status || null,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("【POST Error】:", err); // ★エラー内容を詳細に吐き出すように変更
    res.status(500).send("Server Error");
  }
});

app.put("/api/candidates/:id", async (req, res) => {
  const b = req.body;
  try {
    await db.query(
      `UPDATE candidates SET 
        name_kanji=$1, name_kana=$2, age=$3, birth_year=$4, tel=$5, email=$6,
        status=$7, decline_reason=$8, interview_1_date=$9, interview_2_date=$10, 
        motivation_memo=$11, prev_salary=$12, desired_salary=$13, commute_method=$14, 
        experience_memo=$15, available_date=$16, other_selection_status=$17, other_memo=$18,
        qa_1=$19, qa_2=$20, interview_2_memo=$21, agent_name=$22, resume_memo=$23,
        zip_code=$24, address=$25, address_banchi=$26, address_building=$27, address_room=$28,
        emerg_zip_code=$29, emerg_address=$30, emerg_address_banchi=$31, emerg_address_building=$32, emerg_address_room=$33,
        emerg_tel=$34, emerg_name=$35, emerg_relation=$36, education=$37, graduation_year=$38, 
        work_history=$39, licenses=$40, family=$41, commute_time=$42, expected_join_date=$43,
        birth_date=$44, is_retired=$45, retirement_date=$46, contact_history=$47, interview_2_attendee=$48,
        applied_at=$49,
        is_coop=$50, company_name=$51, introducer=$52, internal_contact=$53, desired_dept=$54, subcontract_status=$55
      WHERE id = $56`,
      [
        b.name_kanji,
        b.name_kana,
        b.age || null,
        b.birth_year || null,
        JSON.stringify(b.tel || []),
        JSON.stringify(b.email || []),
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
        b.is_coop || false, // $50
        b.company_name, // $51
        b.introducer, // $52
        b.internal_contact, // $53
        b.desired_dept, // $54
        b.subcontract_status, // $55
        req.params.id, // $56
      ],
    );
    res.json({ message: "更新完了" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

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

// --- 経費の更新 (PUT) ---
app.put("/api/expenses/:id", async (req, res) => {
  const { payee, amount, expense_date } = req.body;
  try {
    const result = await db.query(
      "UPDATE recruitment_expenses SET payee = $1, amount = $2, expense_date = $3 WHERE id = $4 RETURNING *",
      [payee, amount, expense_date, req.params.id],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// ★ ここから追加：Reactの本番画面を一緒に配信する設定 ★
const path = require("path");
app.use(express.static(path.join(__dirname, "../react-app/dist")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../react-app/dist/index.html"));
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
