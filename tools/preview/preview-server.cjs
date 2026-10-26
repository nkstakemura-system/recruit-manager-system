"use strict";
// NKS採用管理：ローカル専用のUIプレビュー（架空データ・メモリ内のみ）。
// PostgreSQL / Supabase / Render / .env / メール送信 / 外部API には一切接続しない。
// 選考履歴の処理は本番APIと同じ selectionService を、メモリ版の保存先で動かす。
//
// 起動: node tools/preview/preview-server.cjs            （選考履歴テーブルありの状態）
//       node tools/preview/preview-server.cjs --no-history-table （DB適用前の状態：従来の進捗更新）
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..", "..");
const flow = require(path.join(root, "api-server", "selectionFlow.js"));
const selection = require(path.join(root, "api-server", "selectionService.js"));
const { createMemorySelectionStore } = require(path.join(root, "api-server", "selectionMemoryStore.js"));
const { buildFacts } = require(path.join(root, "api-server", "dashboardFacts.js"));

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
  { ...blank, id: 900001, name_kanji: "表示確認用・山田", name_kana: "ヒョウジカクニンヨウ ヤマダ", status: 1, applied_at: "2026-10-20", experience: "経験者", source_type: "求人", agent_name: "架空求人媒体", job_title: "施工管理", employment_type: "正社員", tel: ["000-0000-0001"], primary_contact: "tel_0", created_at: "2026-10-20T01:00:00Z" },
  { ...blank, id: 900002, name_kanji: "表示確認用・佐藤", name_kana: "ヒョウジカクニンヨウ サトウ", status: 2, applied_at: "2026-10-14", experience: "未経験者", source_type: "紹介", agent_name: "架空紹介者", contact_history: [{ date: "2026-10-15", tel: true, email: false }], created_at: "2026-10-14T01:00:00Z" },
  { ...blank, id: 900003, name_kanji: "表示確認用・鈴木", name_kana: "ヒョウジカクニンヨウ スズキ", status: 3, applied_at: "2026-10-01", interview_1_date: "2026-10-27", experience: "経験者", source_type: "求人", created_at: "2026-10-01T01:00:00Z" },
  { ...blank, id: 900004, name_kanji: "表示確認用・高橋", name_kana: "ヒョウジカクニンヨウ タカハシ", status: 4, applied_at: "2026-09-18", interview_1_date: "2026-09-25", interview_2_date: "2026-10-09", interview_2_attendee: "架空部長", experience: "経験者", source_type: "人材紹介", agent_name: "架空エージェント", introducer_fee: 300000, created_at: "2026-09-18T01:00:00Z" },
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
    send(res, err.status || 500, { error: err.status ? err.message : "Local preview error", code: err.code, fields: err.fields });
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
      // 送られた項目だけを保存（送られなかった選考列は保持）
      for (const [key, value] of Object.entries(body)) if (key !== "id") c[key] = value;
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

(historyTable ? seedHistory() : Promise.resolve()).then(() => http.createServer(async (req, res) => {
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
  console.log(`架空データ ${candidates.length} 件。更新はメモリ内のみで、終了すると消えます。終了: Ctrl+C`);
}));
