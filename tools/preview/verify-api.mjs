// ローカルプレビュー（架空データ）に対するHTTP検証。本番環境には接続しない。
// 使い方: 別ターミナルで node tools/preview/preview-server.cjs を起動（起動直後の初期データで実行）
//         node tools/preview/verify-api.mjs [http://127.0.0.1:5188]
import { buildHrSummary } from "../../shared/hrSummary.mjs";

const base = process.argv[2] || "http://127.0.0.1:5188";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw new Error("ローカルのプレビューサーバーのみ対象です: " + base);
let cookie = "";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`); };
async function call(path, method = "GET", body) {
  const res = await fetch(base + path, {
    method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
const list = async () => (await call("/api/candidates")).data;
const find = async id => (await list()).find(c => c.id === id);
const timeline = async id => (await call(`/api/candidates/${id}/selection`)).data;
const step = async (id, kind, event_date, extra = {}) => {
  const v = await timeline(id);
  return call(`/api/candidates/${id}/selection/events`, "POST", { expected_version: v.version, kind, event_date, ...extra });
};
const asOf = "2026-10-23";
const summary = rows => JSON.stringify(buildHrSummary(rows, asOf, "2026-10"));

check("未ログインは401", (await call("/api/candidates")).status === 401);
check("ログイン（架空の専用アカウント）", (await call("/api/auth/login", "POST", { username: "preview", password: "preview-only" })).status === 200);
// 選考操作を行わない応募者（集計の比較用）
const untouched = rows => rows.filter(x => ![900001, 900002, 900003, 900005, 900006, 900008, 900011].includes(x.id));
const summaryBefore = summary(untouched(await list()));
const expenseCountBefore = (await call("/api/expenses")).data.length;

// 1. 受付直後の選択肢
let v = await timeline(900001);
check("受付日を自動表示・未到達工程は無し", v.applied_date === "2026-10-20" && v.records.length === 0);
check("受付後の選択肢＝書類選考/1次面接/辞退/音信不通", v.actions.map(a => a.label).join(",") === "書類選考,1次面接（予定）,辞退,音信不通");

// 2. 書類到着 → 面接予定 → 完了 → 2次 → 3次 → 内定 → 入社予定 → 入社済み
await step(900001, "document_received", "2026-10-21");
check("書類選考 → 一覧バッジ「書類選考中」", (await find(900001)).selection_label === "書類選考中");
check("面接完了前は内定を登録できない", (await step(900001, "offer", "2026-10-22")).status === 409);
await step(900001, "interview_scheduled", "2026-10-22");
await step(900001, "interview_completed", "2026-10-22");
await step(900001, "interview_scheduled", "2026-10-24", { attendee: "架空部長" });
await step(900001, "interview_completed", "2026-10-24");
await step(900001, "interview_scheduled", "2026-11-05");
let c = await find(900001);
check("3次面接：status は既存の4のまま・一覧は「3次面接予定」", String(c.status) === "4" && c.selection_label === "3次面接予定");
check("1次/2次の面接日・同席者は既存列へ反映", c.interview_1_date === "2026-10-22" && c.interview_2_date === "2026-10-24" && c.interview_2_attendee === "架空部長");
await step(900001, "interview_completed", "2026-11-05");
await step(900001, "offer", "2026-11-10");
c = await find(900001);
check("内定通知日 → offer_date / status 5", String(c.status) === "5" && c.offer_date === "2026-11-10");
await step(900001, "join_planned", "2026-12-01");
v = await timeline(900001);
check("入社予定の後は「入社済みにする」と「内定辞退」のみ", v.actions.map(a => a.label).join(",") === "入社済みにする,内定辞退");
check("入社予定日を過ぎても自動で入社にならない", String((await find(900001)).status) === "5");
await step(900001, "joined", "2026-12-01");
check("入社済みにする（明示操作）→ status 6", String((await find(900001)).status) === "6");
check("入社済みの操作が履歴に記録", (await timeline(900001)).history.some(h => h.label === "入社済み"));

// 3. 訂正・取消は追記（元の記録は残る）
v = await timeline(900001);
const historyCount = v.history.length;
const first = v.records.find(r => r.kind === "interview_scheduled");
let r = await call(`/api/candidates/900001/selection/events/${first.id}/correction`, "POST", { expected_version: v.version, event_date: "2026-10-23", reason: "架空の日程変更" });
check("訂正：1次面接日が更新され、元の日付も保持", r.status === 200 && (await find(900001)).interview_1_date === "2026-10-23" && r.data.records.find(x => x.id === first.id).original_date === "2026-10-22");
v = r.data;
r = await call(`/api/candidates/900001/selection/events/${v.records.at(-1).id}/void`, "POST", { expected_version: v.version, reason: "架空の取消" });
check("取消：入社済みを取り消すと status 5 へ", r.status === 200 && String((await find(900001)).status) === "5");
check("訂正・取消後も履歴は追記のみ（件数が2件増加）", r.data.history.length === historyCount + 2 && r.data.history.at(-1).label === "取消：入社済み");
const notLatest = await call(`/api/candidates/900001/selection/events/${first.id}/void`, "POST", { expected_version: r.data.version });
check("最新以外の取消は409", notLatest.status === 409);
const stale = await call(`/api/candidates/900001/selection/events`, "POST", { expected_version: v.version, kind: "joined", event_date: "2026-12-01" });
check("古い画面（版不一致）からの更新は409", stale.status === 409 && stale.data.code === "stale");

// 4. 入社予定の取消 = 内定辞退（元の入社予定日は履歴に残る）
r = await step(900001, "declined", "2026-11-20");
check("内定辞退は理由必須", r.status === 400);
r = await step(900001, "declined", "2026-11-20", { note: "架空の理由" });
c = await find(900001);
check("内定辞退：status 9・理由・発生段階", String(c.status) === "9" && c.decline_reason === "内定辞退: 架空の理由" && c.selection_label === "辞退");
check("元の入社予定日は履歴と既存列に残る", c.expected_join_date === "2026-12-01" && r.data.records.some(x => x.kind === "join_planned" && x.event_date === "2026-12-01"));

// 5. 音信不通 → 不採用
r = await step(900003, "no_contact", "2026-10-28");
check("音信不通は確認文付き・status 9", r.status === 200 && String((await find(900003)).status) === "9");
check("音信不通の理由文言（段階付き）", (await find(900003)).decline_reason === "1次面接音信不通（不採用）");

// 6. 既存 status 2 は保持
v = await timeline(900002);
check("既存の面接打診中を表示・選択肢は1次面接/辞退/音信不通", v.records.map(x => x.label).join() === "面接打診" && v.actions.map(a => a.kind).join() === "interview_scheduled,declined,no_contact");
r = await call("/api/candidates/900002/selection/contact-history", "PATCH", { expected_version: v.version, contact_history: [{ date: "2026-10-15", tel: true }, { date: "2026-10-16", email: true }] });
check("連絡履歴の保存で status 2 は変わらない", r.status === 200 && String((await find(900002)).status) === "2");

// 7. 不整合な既存データは409で停止（自動補正しない）
v = await timeline(900009);
check("不整合データは警告表示・操作不可", v.sync_issues.length > 0 && v.actions.length === 0);
r = await call("/api/candidates/900009/selection/events", "POST", { expected_version: v.version, kind: "declined", event_date: "2026-10-01", note: "x" });
const c9 = await find(900009);
check("不整合データの更新は409・値は変更なし", r.status === 409 && r.data.code === "out_of_sync" && String(c9.status) === "1" && c9.offer_date === "2026-09-20");

// 8. 古い画面のPUT（選考列を含む）は409、新しい画面の基本情報保存は成功
c = await find(900005);
r = await call("/api/candidates/900005", "PUT", { ...c, status: 1, job_title: "架空職種" });
check("選考列を含むPUTは黙って無視せず409", r.status === 409 && r.data.code === "selection_fields_rejected" && (await find(900005)).job_title !== "架空職種");
const basic = Object.fromEntries(Object.entries(c).filter(([k]) => !["status", "decline_reason", "interview_1_date", "interview_2_date", "interview_2_attendee", "offer_date", "expected_join_date", "applied_at", "contact_history"].includes(k)));
r = await call("/api/candidates/900005", "PUT", { ...basic, job_title: "架空職種" });
const c5 = await find(900005);
check("選考列を送らない基本情報保存は成功・選考列は保持", r.status === 200 && c5.job_title === "架空職種" && String(c5.status) === "5" && c5.offer_date === "2026-10-01");
r = await call("/api/candidates/900008", "PUT", { status: "2", internal_contact: "架空担当" });
check("協力業者は従来どおりPUTで進捗更新", r.status === 200 && String((await find(900008)).status) === "2");
check("協力業者は選考履歴APIの対象外", (await call("/api/candidates/900008/selection")).status === 400);

// 8-2. C-04：選考履歴がある応募者の管理種別変更は409（何も保存しない）、履歴が無ければ従来どおり変更できる
const selectionKeys = ["status", "decline_reason", "interview_1_date", "interview_2_date", "interview_2_attendee", "offer_date", "expected_join_date", "applied_at", "contact_history"];
const basicOf = row => Object.fromEntries(Object.entries(row).filter(([k]) => !selectionKeys.includes(k) && !["selection_label"].includes(k)));
c = await find(900001);
r = await call("/api/candidates/900001", "PUT", { ...basicOf(c), is_coop: true, job_title: "架空の変更" });
c = await find(900001);
check("履歴あり：個人応募→協力業者は409・理由を表示", r.status === 409 && r.data.code === "coop_change_has_history" && /選考履歴があるため/.test(r.data.error));
check("履歴あり：409の場合は種別も他の項目も保存されない", c.is_coop !== true && c.job_title !== "架空の変更");
r = await call("/api/candidates/900001", "PUT", { ...basicOf(c), job_title: "架空の変更" });
check("履歴あり：種別を変えない基本情報保存は成功", r.status === 200 && (await find(900001)).job_title === "架空の変更");
c = await find(900006);
r = await call("/api/candidates/900006", "PUT", { ...basicOf(c), is_coop: true });
check("履歴なし：個人応募→協力業者は従来どおり変更できる", r.status === 200 && (await find(900006)).is_coop === true);
r = await call("/api/candidates/900006", "PUT", { ...basicOf(await find(900006)), is_coop: false, status: c.status });
check("履歴なし：協力業者→個人応募も従来どおり変更できる", r.status === 200 && (await find(900006)).is_coop === false);
check("選考の更新・入社済みの操作で経費は自動登録されない", (await call("/api/expenses")).data.length === expenseCountBefore);

// 8-3. 従来データ：受付のまま1次面接日だけ（未来日・過去日）。status は受付のまま、実施は推定しない
for (const id of [900010, 900011]) {
  const row = await find(id);
  v = await timeline(id);
  const done = v.actions.find(a => a.kind === "interview_completed");
  check(`従来データ(${id})：409にならず1次面接予定として表示`, v.sync_issues.length === 0 && v.records.length === 1 && v.records[0].label === "1次面接（予定）" && v.records[0].event_date === row.interview_1_date);
  check(`従来データ(${id})：status は受付のまま・一覧も受付表示`, String(row.status) === "1" && v.status === "1" && row.selection_label === undefined);
  check(`従来データ(${id})：実施状況の確認を表示し、完了日は空欄・確認付き`, v.notices.length === 1 && done && done.default_date === null && done.date_must_be_entered === true && /確認しましたか/.test(done.confirm));
}
r = await call("/api/candidates/900011/selection/events", "POST", { expected_version: (await timeline(900011)).version, kind: "interview_completed", event_date: "" });
check("従来データ：実施日を入力しない完了登録は拒否・値は変更なし", r.status === 400 && String((await find(900011)).status) === "1");
const past = (await find(900011)).interview_1_date;
r = await step(900011, "interview_completed", past);
c = await find(900011);
check("従来データ：明示的に完了を登録すると1次面接（status 3）・面接日は保持", r.status === 200 && String(c.status) === "3" && c.interview_1_date === past && c.selection_label === "1次面接済");

// 9. 日付の4桁年検証
for (const bad of ["202610-10-01", "0000-10-01", "2026-02-30"]) {
  check(`不正日付 ${bad} を拒否`, (await step(900004, "interview_completed", bad)).status === 400);
}

// 10. 閲覧・履歴化・不整合データへの操作試行で、集計が変わらないこと
//     （選考操作をした応募者は既存列が変わるため除外。既存の集計関数をそのまま使用）
check("操作していない応募者の部長会集計は操作前と一致", summary(untouched(await list())) === summaryBefore);

const failed = results.filter(x => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
