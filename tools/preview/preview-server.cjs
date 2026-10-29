"use strict";
// NKS採用管理：ローカル専用のUIプレビュー（架空データ・メモリ内のみ）。
// PostgreSQL / Supabase / Render / .env / メール送信 / 外部API には一切接続しない。
// 選考履歴の処理は本番APIと同じ selectionService を、メモリ版の保存先で動かす。
//
// 起動: node tools/preview/preview-server.cjs            （選考履歴テーブルありの状態）
//       node tools/preview/preview-server.cjs --no-history-table （DB適用前の状態：従来の進捗更新）
//       node tools/preview/preview-server.cjs --no-marketing-table（求人分析のテーブル未作成の状態）
//       node tools/preview/preview-server.cjs --real-csv <フォルダ>（実際のCSVを「確認待ち」として画面に渡す。自動では登録しない）
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..", "..");
const flow = require(path.join(root, "api-server", "selectionFlow.js"));
const selection = require(path.join(root, "api-server", "selectionService.js"));
const { createMemorySelectionStore } = require(path.join(root, "api-server", "selectionMemoryStore.js"));
const { buildFacts } = require(path.join(root, "api-server", "dashboardFacts.js"));
const contacts = require(path.join(root, "api-server", "contactService.js"));
const marketing = require(path.join(root, "api-server", "jobMarketingService.js"));
const { createMemoryMarketingStore } = require(path.join(root, "api-server", "jobMarketingMemoryStore.js"));

const dist = path.join(root, "react-app", "dist");
const indexPath = path.join(dist, "index.html");
if (!fs.existsSync(indexPath)) throw new Error("React build がありません。先に react-app で npm run build を実行してください: " + indexPath);

const historyTable = !process.argv.includes("--no-history-table");
const host = "127.0.0.1";
const port = Number(process.env.PREVIEW_PORT) || 5188;
const token = crypto.randomBytes(32).toString("hex");
const cookieName = "nks_recruit_preview";

// 今日（日本時間）から days 日後の YYYY-MM-DD
const shiftDays = days => { const d = new Date(flow.todayTokyo() + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
// 架空データ（実在の人物・応募者ではない）
const blank = { tel: [], email: [], qa_1: [], qa_2: [], work_history: [], licenses: [], family: [], contact_history: [], is_deleted: false, is_retired: false };
const candidates = [
  { ...blank, id: 900001, name_kanji: "表示確認用・山田", name_kana: "ヒョウジカクニンヨウ ヤマダ", status: 1, applied_at: "2026-10-20", experience: "経験者", source_type: "求人", agent_name: "架空求人媒体", job_title: "施工管理", employment_type: "正社員", tel: ["000-0000-0001"], primary_contact: "tel_0", birth_date: "1989-01-07", graduation_year: "2007", work_history: [{ company: "架空建設", start_year: "2007", end_year: "2019", is_same_industry: true, is_same_job: false }], licenses: [{ name: "架空資格", date: "2019" }], created_at: "2026-10-20T01:00:00Z" },
  { ...blank, id: 900002, name_kanji: "表示確認用・佐藤", name_kana: "ヒョウジカクニンヨウ サトウ", status: 2, applied_at: "2026-10-14", experience: "未経験者", source_type: "紹介", agent_name: "架空紹介者", contact_history: [{ date: "2026-10-15", tel: true, email: false }], created_at: "2026-10-14T01:00:00Z" },
  { ...blank, id: 900003, name_kanji: "表示確認用・鈴木", name_kana: "ヒョウジカクニンヨウ スズキ", status: 3, applied_at: "2026-10-01", interview_1_date: "2026-10-27", experience: "経験者", source_type: "求人", created_at: "2026-10-01T01:00:00Z" },
  { ...blank, id: 900004, name_kanji: "表示確認用・高橋", name_kana: "ヒョウジカクニンヨウ タカハシ", status: 4, applied_at: "2026-09-18", interview_1_date: "2026-09-25", interview_2_date: "2026-10-09", interview_2_attendee: "架空部長", experience: "経験者", source_type: "人材紹介", agent_name: "架空エージェント", introducer_fee: 300000, tel: ["000-0000-0004"], email: ["preview4a@example.invalid", "preview4b@example.invalid"], primary_contact: "email_1", created_at: "2026-09-18T01:00:00Z" },
  { ...blank, id: 900005, name_kanji: "表示確認用・田中", name_kana: "ヒョウジカクニンヨウ タナカ", status: 5, applied_at: "2026-08-19", interview_1_date: "2026-09-02", offer_date: "2026-10-01", expected_join_date: "2026-11-01", experience: "経験者", source_type: "人材紹介", agent_name: "架空エージェント", introducer_fee: 250000, job_title: "CADオペレーター", planned_department: "設計部", employment_type: "正社員", created_at: "2026-08-19T01:00:00Z" },
  { ...blank, id: 900006, name_kanji: "表示確認用・伊藤", name_kana: "ヒョウジカクニンヨウ イトウ", status: 9, applied_at: "2026-09-05", interview_1_date: "2026-09-12", decline_reason: "1次面接辞退: 架空の理由（他社決定）", experience: "未経験者", source_type: "求人", created_at: "2026-09-05T01:00:00Z" },
  { ...blank, id: 900007, name_kanji: "表示確認用・渡辺", name_kana: "ヒョウジカクニンヨウ ワタナベ", status: 6, applied_at: "2026-07-01", interview_1_date: "2026-07-08", offer_date: "2026-07-20", expected_join_date: "2026-08-01", experience: "経験者", source_type: "新卒", agent_name: "架空学校", created_at: "2026-07-01T01:00:00Z" },
  // 不整合な既存データの例（status 1 なのに内定日がある）→ 選考の更新は409で停止し、自動補正しない
  { ...blank, id: 900009, name_kanji: "表示確認用・小林", name_kana: "ヒョウジカクニンヨウ コバヤシ", status: 1, applied_at: "2026-09-01", offer_date: "2026-09-20", experience: "不明", source_type: "その他", created_at: "2026-09-01T01:00:00Z" },
  // 従来データの例（受付のまま1次面接日だけが登録されている。未来日・過去日）→ 受付のまま1次面接予定として表示し、実施は推定しない
  { ...blank, id: 900010, name_kanji: "表示確認用・加藤", name_kana: "ヒョウジカクニンヨウ カトウ", status: 1, applied_at: "2026-10-05", interview_1_date: shiftDays(14), experience: "経験者", source_type: "求人", created_at: "2026-10-05T01:00:00Z" },
  { ...blank, id: 900011, name_kanji: "表示確認用・吉田", name_kana: "ヒョウジカクニンヨウ ヨシダ", status: 1, applied_at: "2026-09-20", interview_1_date: shiftDays(-14), experience: "未経験者", source_type: "求人", created_at: "2026-09-20T01:00:00Z" },
  { ...blank, id: 900008, name_kanji: "表示確認用・協力担当", name_kana: "架空工業株式会社", is_coop: true, status: 1, applied_at: "2026-10-10", company_name: "架空工業株式会社", created_at: "2026-10-10T01:00:00Z" },
  // 期別ダッシュボード確認用（第3弾）。選考履歴は起動時に seedHistory で本番と同じ選考APIから登録する
  { ...blank, id: 900012, name_kanji: "表示確認用・中村", name_kana: "ヒョウジカクニンヨウ ナカムラ", status: 1, applied_at: "2026-08-05", tel: ["000-0000-0012"], primary_contact: "tel_0", source_type: "求人", created_at: "2026-08-05T01:00:00Z" },
  { ...blank, id: 900013, name_kanji: "表示確認用・山本", name_kana: "ヒョウジカクニンヨウ ヤマモト", status: 1, applied_at: "2026-09-03", email: ["preview13@example.invalid"], primary_contact: "email_0", source_type: "求人", created_at: "2026-09-03T01:00:00Z" },
  { ...blank, id: 900014, name_kanji: "表示確認用・中島", name_kana: "ヒョウジカクニンヨウ ナカジマ", status: 1, applied_at: "2026-08-28", source_type: "人材紹介", created_at: "2026-08-28T01:00:00Z" },
  { ...blank, id: 900015, name_kanji: "表示確認用・前田", name_kana: "ヒョウジカクニンヨウ マエダ", status: 1, applied_at: "2026-03-02", source_type: "紹介", created_at: "2026-03-02T01:00:00Z" },
  { ...blank, id: 900017, name_kanji: "表示確認用・岡田", name_kana: "ヒョウジカクニンヨウ オカダ", status: 1, applied_at: "2026-09-10", source_type: "求人", created_at: "2026-09-10T01:00:00Z" },
  { ...blank, id: 900018, name_kanji: "表示確認用・後藤", name_kana: "ヒョウジカクニンヨウ ゴトウ", status: 1, applied_at: "2026-09-25", source_type: "求人", created_at: "2026-09-25T01:00:00Z" },
  // 旧データ（選考履歴なし）の終了。終了日は記録が無いため「終了日不明」
  { ...blank, id: 900016, name_kanji: "表示確認用・藤田", name_kana: "ヒョウジカクニンヨウ フジタ", status: 9, applied_at: "2026-01-15", interview_1_date: "2026-01-22", interview_2_date: "2026-02-01", decline_reason: "2次面接辞退: 架空の理由", source_type: "求人", created_at: "2026-01-15T01:00:00Z" },
];
const expenses = [
  { id: 800001, payee: "架空求人媒体", amount: 120000, expense_date: "2026-09-01" },
  { id: 800002, payee: "架空エージェント", amount: 300000, expense_date: "2026-10-01" },
  { id: 800003, payee: "架空求人媒体", amount: 80000, expense_date: "2026-03-01" },
];
const store = createMemorySelectionStore(candidates, { ready: historyTable });
const contactStore = contacts.createMemoryContactStore(candidates);
const marketingTable = !process.argv.includes("--no-marketing-table");
const marketingStore = createMemoryMarketingStore({ ready: marketingTable });

// 実CSVの確認（--real-csv <フォルダ>）。Indeedのレポート（EngagementSummary_*.csv）と旧管理CSV（求人マーケティング*.csv）だけを読み取り、
// メモリ上に「確認待ち」として保持する。職種・年・「応募」の意味などは画面で利用者が確定し、取込後もメモリ内のみ（DB・Gitには入らない）。
// このモードでは架空の求人分析データは登録しない（実データと混ざらないようにする）。
const realCsvAt = process.argv.indexOf("--real-csv");
const realCsvDir = realCsvAt > 0 && process.argv[realCsvAt + 1] ? path.resolve(process.argv[realCsvAt + 1]) : null;
const pendingFiles = [];
if (realCsvAt > 0 && !realCsvDir) throw new Error("--real-csv にはCSVのフォルダを指定してください");
if (realCsvDir) {
  for (const name of fs.readdirSync(realCsvDir).filter(n => /^(EngagementSummary_[\w-]*|求人マーケティング.*)\.csv$/i.test(n)).sort()) {
    const bytes = fs.readFileSync(path.join(realCsvDir, name));
    if (bytes.length > 2 * 1024 * 1024) continue;
    pendingFiles.push({ name, size: bytes.length, hash: crypto.createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") });
  }
}
async function pendingList() {
  const view = await marketing.overview(marketingStore);
  const activeImports = new Set(view.records.filter(r => r.state === "active" && r.import_id).map(r => r.import_id));
  const imported = new Set(view.imports.filter(i => activeImports.has(i.id)).map(i => i.file_hash));
  return { files: pendingFiles.map(p => ({ ...p, imported: imported.has(p.hash) })) };
}

// 求人分析の架空実績（第4弾）。本番と同じ jobMarketingService で登録する。
// * 営業：7・8月は月間合計（無料）、9/1〜10/26は日別（架空のCSV取込）。10/14に無料→有料へ切替（日別のため切替日で正確に分かれる）
// * 電気工事士：8月（無料）・9月（9/15に有料へ切替。月間合計しかないため「内訳不明」）・10月（有料）
// CADオペ（ときがわ）・CADオペ（本社）は、実際のCSVの取込確認用に未登録のまま残す。
async function seedMarketing() {
  const { categories } = await marketing.overview(marketingStore);
  const id = name => categories.find(c => c.name === name).id;
  const by = "preview-seed@web";
  const save = (name, start, end, values, extra = {}) => marketing.saveRecord(marketingStore, {
    record: { category_id: id(name), media: "Indeed", period_start: start, period_end: end, plan_type: "free", ...values }, ...extra,
  }, by);
  const plan = (name, status, effective_date, extra = {}) => marketing.savePlanEvent(marketingStore, { category_id: id(name), status, effective_date, ...extra }, by);

  await plan("営業", "free", "2026-07-01", { note: "架空：初回掲載（無料）" });
  await save("営業", "2026-07-01", "2026-07-31", { impressions: 820, clicks: 41, apply_starts: 3, applies: 2, note: "架空：初回掲載" });
  await save("営業", "2026-08-01", "2026-08-31", { impressions: 760, clicks: 18, apply_starts: 1, applies: 1, note: "架空：タイトルを「法人営業スタッフ」に変更" });
  // 架空の日別データ（決まった計算式で作る。10/14以降は表示・クリックが多く、1日1,000円の費用あり）
  const daily = [];
  for (let t = Date.UTC(2026, 8, 1), i = 0; t <= Date.UTC(2026, 9, 26); t += 86400000, i += 1) {
    const date = new Date(t).toISOString().slice(0, 10);
    const paid = date >= "2026-10-14";
    const wave = (i * 7) % 11;
    daily.push({
      date, impressions: (paid ? 96 : 42) + wave * (paid ? 3 : 1), clicks: (paid ? 5 : 2) + (wave % 3), apply_starts: i % (paid ? 3 : 6) === 0 ? 1 : 0,
      applies: i % (paid ? 6 : 12) === 0 ? 1 : 0, cost: paid ? 1000 : null,
    });
  }
  await marketing.importCsv(marketingStore, {
    file_name: "EngagementSummary_20260901_20261026_架空.csv", file_hash: "f".repeat(63) + "1", format: "indeed",
    entries: [{ record: { category_id: id("営業"), media: "Indeed", period_start: "2026-09-01", period_end: "2026-10-26", plan_type: "unknown", daily, note: "架空：9/10 給与表記を月給に統一、10/14 タイトルに「未経験歓迎」を追加" } }],
  }, by);
  await plan("営業", "paid", "2026-10-14", { budget: "30000", note: "架空：タイトル変更と同時に有料掲載（1日1,000円）" });

  await plan("電気工事士", "free", "2026-08-01");
  await save("電気工事士", "2026-08-01", "2026-08-31", { impressions: 240, clicks: 9, apply_starts: 0, applies: 0, note: "架空：タイトルキャッチコピー変更" });
  await save("電気工事士", "2026-09-01", "2026-09-30", { impressions: 410, clicks: 16, apply_starts: null, applies: 1, plan_type: "unknown", note: "架空：9/15から有料掲載（月間合計のみ）" });
  await plan("電気工事士", "paid", "2026-09-15", { budget: "15000" });
  await save("電気工事士", "2026-10-01", "2026-10-26", { impressions: 620, clicks: 25, apply_starts: 3, applies: 1, plan_type: "paid", cost: 13000 });

  const ref = (name, values) => marketing.createReference(marketingStore, { category_id: id(name), ...values }, by);
  await ref("電気工事士", { company_name: "架空電設株式会社", job_title: "電気工事士（未経験可）", url: "https://example.com/jobs/denki-1", memo: "架空：資格手当の金額を明記", checked_on: "2026-10-20" });
  await ref("電気工事士", { company_name: "架空電工有限会社", memo: "架空：URL未登録の例" });
  await ref("営業", { company_name: "架空商事株式会社", job_title: "ルート営業", url: "https://example.org/sales?id=1", checked_on: "2026-10-15" });
}

// 架空の選考履歴（実際の操作と同じく selectionService 経由で追記する）
async function seedHistory() {
  const step = async (id, kind, event_date, extra = {}) => {
    const v = await selection.getTimeline(store, id);
    await selection.addStep(store, id, { expected_version: v.version, kind, event_date, ...extra }, "preview-seed@web");
  };
  const interview = async (id, ...dates) => {
    for (const date of dates) { await step(id, "interview_scheduled", date); await step(id, "interview_completed", date); }
  };
  await interview(900012, "2026-08-12", "2026-08-26");
  await step(900012, "offer", "2026-09-01");
  await step(900012, "join_planned", "2026-10-01");
  await step(900012, "joined", "2026-10-01");
  await interview(900013, "2026-09-10", "2026-09-24", "2026-10-08");
  await step(900013, "rejected", "2026-10-15");
  await interview(900014, "2026-09-04");
  await step(900014, "offer", "2026-09-15");
  await step(900014, "declined", "2026-09-20", { note: "架空の理由（他社決定）" });
  await interview(900015, "2026-03-10", "2026-03-20");
  await step(900015, "offer", "2026-04-01");
  await step(900015, "join_planned", "2026-05-01");
  await step(900015, "joined", "2026-05-01");
  await interview(900017, "2026-09-17");
  await interview(900018, "2026-10-02");
  const v = await selection.getTimeline(store, 900018);
  await selection.correctStep(store, 900018, v.records.at(-1).id, { expected_version: v.version, event_date: "2026-10-03", reason: "架空の訂正" }, "preview-seed@web");
  // 選考履歴を残したまま論理削除（実績は集計に残る）
  candidates.find(c => c.id === 900017).is_deleted = true;
}

function send(res, code, payload, extra = {}) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(data);
}
const signedIn = req => (req.headers.cookie || "").split(";").some(c => c.trim() === `${cookieName}=${token}`);
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1048576) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); } });
    req.on("error", reject);
  });
}

function listRow(c) {
  const latest = historyTable ? store.latest(c.id) : null;
  // 本番と同じく、従来データの「受付のまま1次面接日のみ」は既存の status で表示する
  if (!latest || flow.isUnconfirmedLegacyInterview(latest)) return c;
  return {
    ...c, latest_selection_kind: latest.kind, latest_selection_stage: latest.stage_number,
    ...flow.listSelectionFields(latest.kind, latest.stage_number, latest.event_date),
  };
}

async function selectionCall(res, work) {
  try {
    send(res, 200, await work());
  } catch (err) {
    send(res, err.status || 500, { error: err.status ? err.message : "Local preview error", code: err.code, fields: err.fields, problems: err.problems });
  }
}
const actor = "preview@web";

async function api(req, res, pathname) {
  const method = req.method;
  if (pathname === "/api/auth/login" && method === "POST") {
    const input = await readBody(req);
    if (input.username !== "preview" || input.password !== "preview-only") return send(res, 401, { error: "Only preview credentials are accepted" });
    return send(res, 200, { user: { username: "preview" } }, { "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` });
  }
  if (pathname === "/api/auth/me" && method === "GET")
    return signedIn(req) ? send(res, 200, { user: { username: "preview" } }) : send(res, 401, { error: "Authentication required" });
  if (pathname === "/api/auth/logout" && method === "POST")
    return send(res, 200, { ok: true }, { "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  if (!signedIn(req)) return send(res, 401, { error: "Authentication required" });

  // 本番と同じ求人分析API（jobMarketingService）をメモリ保存先で実行する
  if (pathname === "/api/job-marketing" && method === "GET")
    return selectionCall(res, async () => ({ ...(await marketing.overview(marketingStore)), ...(realCsvDir ? { preview_pending_files: true } : {}) }));
  if (pathname === "/api/job-marketing/pending-files" && method === "GET") return selectionCall(res, pendingList);
  const jm = /^\/api\/job-marketing\/(categories|plan-events|records|imports|references)(?:\/(\d+)(?:\/(void))?)?$/.exec(pathname);
  if (jm) {
    const [, kind, itemId, action] = jm;
    const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
    if (kind === "categories" && !itemId && method === "POST") return selectionCall(res, () => marketing.createCategory(marketingStore, body, actor));
    if (kind === "categories" && itemId && method === "PATCH") return selectionCall(res, () => marketing.updateCategory(marketingStore, itemId, body, actor));
    if (kind === "plan-events" && !itemId && method === "POST") return selectionCall(res, () => marketing.savePlanEvent(marketingStore, body, actor));
    if (kind === "plan-events" && itemId && action === "void" && method === "POST") return selectionCall(res, () => marketing.voidPlanEvent(marketingStore, itemId, body, actor));
    if (kind === "records" && !itemId && method === "POST") return selectionCall(res, () => marketing.saveRecord(marketingStore, body, actor));
    if (kind === "records" && itemId && action === "void" && method === "POST") return selectionCall(res, () => marketing.voidRecord(marketingStore, itemId, body, actor));
    if (kind === "imports" && !itemId && method === "POST") return selectionCall(res, () => marketing.importCsv(marketingStore, body, actor));
    if (kind === "references" && !itemId && method === "POST") return selectionCall(res, () => marketing.createReference(marketingStore, body, actor));
    if (kind === "references" && itemId && method === "PUT") return selectionCall(res, () => marketing.updateReference(marketingStore, itemId, body, actor));
    if (kind === "references" && itemId && method === "DELETE") return selectionCall(res, () => marketing.deleteReference(marketingStore, itemId, actor));
    return send(res, 404, { error: "Not found" });
  }

  // 本番と同じ選考履歴API（selectionService）をメモリ保存先で実行する
  const sel = /^\/api\/candidates\/(\d+)\/selection(?:\/(events|applied-date|contact-history)(?:\/([\w-]+)\/(correction|void))?)?$/.exec(pathname);
  if (sel) {
    const [, id, part, eventId, action] = sel;
    if (!historyTable) return send(res, 503, { error: "選考履歴テーブルが未作成のため、選考履歴機能は使用できません", code: "selection_unavailable" });
    if (!part && method === "GET") return selectionCall(res, () => selection.getTimeline(store, id));
    const body = await readBody(req);
    if (part === "events" && !eventId && method === "POST") return selectionCall(res, () => selection.addStep(store, id, body, actor));
    if (part === "events" && action === "correction" && method === "POST") return selectionCall(res, () => selection.correctStep(store, id, eventId, body, actor));
    if (part === "events" && action === "void" && method === "POST") return selectionCall(res, () => selection.voidStep(store, id, eventId, body, actor));
    if (part === "applied-date" && method === "PATCH") return selectionCall(res, () => selection.setAppliedDate(store, id, body, actor));
    if (part === "contact-history" && method === "PATCH") return selectionCall(res, () => selection.setContactHistory(store, id, body, actor));
    return send(res, 404, { error: "Not found" });
  }

  if (pathname === "/api/dashboard/facts" && method === "GET") {
    const events = historyTable ? candidates.flatMap(c => store.log(c.id).map(e => ({ ...e, candidate_id: String(c.id) }))) : [];
    return send(res, 200, { as_of: flow.todayTokyo(), history_table: historyTable, facts: buildFacts(candidates, events) });
  }
  if (pathname === "/api/candidates") {
    if (method === "GET") return send(res, 200, candidates.map(listRow));
    if (method === "POST") {
      const body = await readBody(req);
      const candidate = { ...blank, ...body, id: 900000 + candidates.length + 1, status: body.status || 1, applied_at: body.applied_at || flow.todayTokyo(), created_at: new Date().toISOString() };
      candidates.unshift(candidate);
      return send(res, 200, candidate);
    }
  }
  // 本番と同じ連絡先API（contactService）をメモリ保存先で実行する
  const contact = /^\/api\/candidates\/([^/]+)\/contacts$/.exec(pathname);
  if (contact && method === "PATCH") {
    const body = await readBody(req);
    try {
      return send(res, 200, await contacts.updateContacts(contactStore, contact[1], body));
    } catch (err) {
      return send(res, err.status || 500, err.status
        ? { error: err.message, code: err.code, field: err.field, current: err.current }
        : { error: "Local preview error" });
    }
  }
  const one = /^\/api\/candidates\/(\d+)(?:\/(restore|physical))?$/.exec(pathname);
  if (one) {
    const index = candidates.findIndex(c => String(c.id) === one[1]);
    if (index < 0) return send(res, 404, { error: "Not Found" });
    const c = candidates[index];
    if (method === "GET" && !one[2]) return send(res, 200, c);
    if (method === "PUT" && !one[2]) {
      const body = await readBody(req);
      // 本番PUTと同じ判定：選考履歴がある応募者の管理種別変更、個人応募の選考列（古い画面）は409
      // （この判定から保存までは同期処理のため、途中で選考履歴が追加されることはない）
      const isCoop = Object.prototype.hasOwnProperty.call(body, "is_coop") ? Boolean(body.is_coop) : c.is_coop === true;
      const conflict = flow.candidatePutConflict({
        managed: historyTable, currentIsCoop: c.is_coop === true, nextIsCoop: isCoop, hasHistory: store.log(c.id).length > 0, body,
      });
      if (conflict) return send(res, 409, { error: conflict.message, code: conflict.code });
      if (typeof body.birth_date === "string" && /^[+-]?\d{5,}/.test(body.birth_date.trim())) {
        return send(res, 400, { error: "生年月日は西暦4桁で入力してください" });
      }
      // 本番と同じく、卒業年・職歴・資格の5桁以上の年は保存しない
      const longYear = v => (typeof v === "string" ? /^\s*\d{5,}\s*$/.test(v) : Number.isInteger(v) && v > 9999);
      const years = [body.graduation_year,
        ...(Array.isArray(body.work_history) ? body.work_history.flatMap(w => [w?.start_year, w?.end_year]) : []),
        ...(Array.isArray(body.licenses) ? body.licenses.map(l => l?.date) : [])];
      if (years.some(longYear)) return send(res, 400, { error: "年は西暦4桁で入力してください" });
      // 送られた項目だけを保存（送られなかった選考列は保持）。
      // 本番と同じく、連絡先（tel・email・primary_contact）は連絡先APIだけが更新する
      const contactOwned = ["tel", "email", "primary_contact"];
      for (const [key, value] of Object.entries(body)) if (key !== "id" && !contactOwned.includes(key)) c[key] = value;
      return send(res, 200, { message: "更新完了" });
    }
    if (method === "PATCH" && one[2] === "restore") {
      Object.assign(c, { is_deleted: false, is_retired: false, retirement_date: null });
      return send(res, 200, { message: "復元しました" });
    }
    if (method === "DELETE") {
      if (one[2] === "physical") candidates.splice(index, 1);
      else c.is_deleted = true;
      return send(res, 200, { message: "削除しました" });
    }
  }
  if (pathname === "/api/expenses") {
    if (method === "GET") return send(res, 200, expenses);
    if (method === "POST") {
      const item = { ...await readBody(req), id: 800000 + expenses.length + 1 };
      expenses.push(item);
      return send(res, 200, item);
    }
  }
  const expense = /^\/api\/expenses\/(\d+)$/.exec(pathname);
  if (expense) {
    const index = expenses.findIndex(e => String(e.id) === expense[1]);
    if (index < 0) return send(res, 404, { error: "Not Found" });
    if (method === "DELETE") { expenses.splice(index, 1); return send(res, 200, { message: "削除しました" }); }
    if (method === "PUT") { Object.assign(expenses[index], await readBody(req)); return send(res, 200, expenses[index]); }
  }
  return send(res, 404, { error: "Preview endpoint not implemented" });
}

const contentTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon",
};

(historyTable ? seedHistory() : Promise.resolve()).then(() => marketingTable && !realCsvDir ? seedMarketing() : null).then(() => http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${host}:${port}`).pathname;
    if (pathname.startsWith("/api/")) return await api(req, res, pathname);
    let target = path.resolve(dist, "." + decodeURIComponent(pathname));
    if (target !== dist && !target.startsWith(dist + path.sep)) return send(res, 403, { error: "Forbidden" });
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) target = indexPath;
    res.writeHead(200, { "Content-Type": contentTypes[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(target).pipe(res);
  } catch {
    send(res, 500, { error: "Local preview error" });
  }
}).listen(port, host, () => {
  console.log("=== NKS採用管理：DB接続なしのローカルプレビュー ===");
  console.log(`URL: http://${host}:${port}/`);
  console.log("ログイン名: preview / パスワード: preview-only");
  console.log(historyTable ? "モード: 選考履歴テーブルあり（第2弾の新しい選考更新）" : "モード: 選考履歴テーブルなし（DB適用前の従来動作）");
  if (realCsvDir) console.log(`求人分析: 実CSV ${pendingFiles.length}件を確認待ちとして読み込み（未登録・メモリ内のみ）：${pendingFiles.map(p => p.name).join("、")}`);
  else console.log(marketingTable ? "求人分析: 架空実績あり（営業・電気工事士に無料→有料の切替。CADオペ2職種はCSV取込確認用に未登録）" : "求人分析: テーブル未作成の状態");
  console.log(`架空データ ${candidates.length} 件。更新はメモリ内のみで、終了すると消えます。終了: Ctrl+C`);
}));
