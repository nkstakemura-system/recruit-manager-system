// 求人一覧・求人詳細・応募者連携（第5弾）のローカル検証。プレビューサーバー（架空データ）をヘッドレスEdge/Chromeで操作する。
// 本番環境には接続しない。データはプレビューのメモリ内だけで変更される。
// 使い方: 別ターミナルで PREVIEW_NOW=2026-10-29T12:00:00+09:00 node tools/preview/preview-server.cjs を起動（起動直後の初期データで実行）
//   node tools/preview/verify-postings.mjs <保存先フォルダ> <URL> [<migration 005 適用前のプレビューURL（--no-postings-table）>]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "nks-postings-check"));
const app = process.argv[3] || "http://127.0.0.1:5188";
const noTable = process.argv[4] || null;
for (const u of [app, noTable].filter(Boolean)) if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u)) throw new Error("ローカルのプレビューサーバーのみ対象です: " + u);
const browserPath = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(p => p && fs.existsSync(p));
if (!browserPath) throw new Error("Edge/Chrome が見つかりません。BROWSER_PATH を指定してください");
const port = 9336;
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nks-postings-profile-"));
const browser = spawn(browserPath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-extensions", "--disable-sync", "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i += 1) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page"); } catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const problems = [];
const dialogs = [];
ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") problems.push("exception: " + msg.params.exceptionDetails.exception?.description);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push("console.error: " + msg.params.args.map(a => a.value ?? a.description).join(" "));
  if (msg.method === "Page.javascriptDialogOpening") { dialogs.push(msg.params.message); send("Page.handleJavaScriptDialog", { accept: true }); }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluate failed: " + expression.slice(0, 80));
  return r.result?.result?.value;
}
async function waitFor(expression, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return true; await sleep(150); }
  throw new Error("timeout: " + label);
}
let viewport = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false };
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(r.result.data, "base64"));
}
async function go(url, ready, label) {
  await send("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'", "load " + label);
  await evaluate(helpers);
  await waitFor(ready, label);
}
const steps = [];
const ok = (name, value, detail = "") => { steps.push({ name, value: Boolean(value), detail }); console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const api = (url, method = "GET", body) => evaluate(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json" }, ${body !== undefined ? `body: ${JSON.stringify(JSON.stringify(body))},` : ""} credentials: "include" }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
const helpers = `
  window.__q = (sel, scope = document) => scope.querySelector(sel);
  window.__qa = (sel, scope = document) => [...scope.querySelectorAll(sel)];
  window.__modal = () => document.querySelector(".jm-modal");
  window.__set = (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  window.__field = (label, scope = document) => {
    const l = [...scope.querySelectorAll("label")].find(x => x.firstChild && x.firstChild.textContent.trim() === label);
    return l && l.querySelector("input,select,textarea");
  };
  window.__selectByText = (select, text) => {
    const o = [...select.options].find(x => x.textContent.startsWith(text));
    if (!o) return false; window.__set(select, o.value); return true;
  };
  window.__click = (text, scope = document) => {
    const el = [...scope.querySelectorAll("button,a")].find(b => b.textContent.trim() === text && !b.disabled);
    if (!el) return false; el.click(); return true;
  };
  window.__btn = (text, scope = document) => [...scope.querySelectorAll("button")].find(b => b.textContent.trim() === text);
  window.__radio = (text, scope = document) => {
    const l = [...scope.querySelectorAll("label")].find(x => x.textContent.trim() === text && x.querySelector("input[type=radio]"));
    if (!l) return false; l.querySelector("input").click(); return true;
  };
  window.__row = title => [...document.querySelectorAll(".jp-row:not(.jp-head)")].find(r => r.querySelector(".jp-title-link")?.textContent === title);
  window.__rows = () => [...document.querySelectorAll(".jp-row:not(.jp-head)")].map(r => r.querySelector(".jp-title-link").textContent);
  window.__tabCount = name => { const t = [...document.querySelectorAll(".jp-tabs .jm-tab")].find(b => b.firstChild.textContent === name); return t ? Number(t.querySelector(".jm-dot").textContent) : null; };
  window.__tab = name => { const t = [...document.querySelectorAll(".jp-tabs .jm-tab")].find(b => b.firstChild.textContent === name); t.click(); return true; };
  window.__section = title => [...document.querySelectorAll(".jp-section")].find(c => (c.querySelector("h3")?.textContent || "").startsWith(title));
  window.__text = (scope = document.body) => scope.innerText;
  true`;
const HW = "架空：電気工事士（太陽光・蓄電池）";
const SALES2 = "架空：法人営業スタッフ";
const AIR = "架空：設備CADオペレーター（施工図）";
const CSV1 = "架空：ルート営業（新規開拓なし）";
const CSV2 = "架空：CADオペレーター/設計補助";

try {
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  const clock = await fetch(app + "/api/preview/clock").then(r => r.ok ? r.json() : { pinned: false }).catch(() => ({ pinned: false }));
  if (!clock.pinned) throw new Error("日付に依存する検証のため、プレビューを基準日固定で起動してください（例：PREVIEW_NOW=2026-10-29T12:00:00+09:00）");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const R = Date; const base = R.parse(${JSON.stringify(clock.now)}); const t0 = R.now();
    const now = () => base + (R.now() - t0); window.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } }; })();` });
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await send("Page.navigate", { url: app + "/" });
  await waitFor("document.readyState === 'complete'", "load");
  const unauth = await evaluate(`Promise.all(["/api/job-postings", "/api/job-postings/1", "/api/job-postings/1/candidates?kind=applied", "/api/candidates/900001/job-posting"].map(u => fetch(u).then(r => r.status)))`);
  ok("未ログインでは求人一覧APIは401", unauth.every(s => s === 401), unauth.join(","));
  await evaluate(`fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "preview", password: "preview-only" }) }).then(r => r.status)`);

  // 1. メニューと一覧
  await go(app + "/jobs", "!!document.querySelector('.jp-list')", "jobs");
  ok("メニュー：「求人一覧」が「求人分析」の上にある", await evaluate(`(() => { const a = [...document.querySelectorAll("nav a")].map(x => x.getAttribute("href")); return a.indexOf("/jobs") >= 0 && a.indexOf("/jobs") === a.indexOf("/job-marketing") - 1; })()`));
  ok("既存メニューは維持", await evaluate(`["/", "/register", "/candidates", "/expenses", "/stats", "/job-marketing"].every(h => document.querySelector('nav a[href="' + h + '"]'))`));
  ok("初期表示は公開中の求人だけ", JSON.stringify(await evaluate("__rows()")) === JSON.stringify([AIR, HW]), JSON.stringify(await evaluate("__rows()")));
  ok("切替の件数：公開中2・非公開1・すべて5・要設定2", JSON.stringify(await evaluate(`["公開中", "非公開", "すべて", "要設定"].map(__tabCount)`)) === "[2,1,5,2]");
  ok("要設定の件数と確認導線を表示", await evaluate(`__q(".jp-unset").innerText.includes("要設定 2件") && !!__btn("確認する", __q(".jp-unset"))`));
  ok("列：求人タイトル・職種／掲載媒体／応募者数／採用数／公開状態／操作（公開切替・詳細）", await evaluate(`__q(".jp-head").innerText.replace(/\\?/g, "").replace(/\\s+/g, " ").trim() === "求人タイトル・職種 掲載媒体 応募者数 採用数 公開状態 操作"`), await evaluate(`__q(".jp-head").innerText.replace(/\\s+/g, " ")`));
  const hwRow = await evaluate(`(() => { const r = __row(${JSON.stringify(HW)}); return { text: r.innerText.replace(/\\s+/g, " "), counts: [...r.querySelectorAll(".jp-count")].map(x => x.textContent) }; })()`);
  ok("ハローワークの求人：職種・媒体・応募者3・採用0・公開中（一覧に求人番号は表示しない）", hwRow.text.includes("電気工事士") && hwRow.text.includes("ハローワーク") && !hwRow.text.includes("00000-00000001") && hwRow.counts.join() === "3,0" && hwRow.text.includes("公開中"), hwRow.text);
  // 列の位置：応募者数・採用数の数字（0 を含む）が各列の中央にそろい、右側のボタンの高さ・文字サイズがそろっている
  const layout = await evaluate(`(() => {
    const center = el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    const head = __qa(".jp-head > span"); const rows = __qa(".jp-row:not(.jp-head)");
    const off = col => Math.max(...rows.map(r => Math.abs(center(r.children[col].querySelector(".jp-count")) - center(head[col]))));
    const btns = rows.flatMap(r => [...r.querySelectorAll(".jp-actions-cell .jm-btn")]);
    const hs = new Set(btns.map(b => Math.round(b.getBoundingClientRect().height))); const fs = new Set(btns.map(b => getComputedStyle(b).fontSize));
    const detailX = new Set(rows.map(r => Math.round(r.querySelector(".jp-detail-btn").getBoundingClientRect().right)));
    return { apply: off(2), hire: off(3), heights: [...hs], fonts: [...fs], detailX: [...detailX], ids: __qa(".jp-id").length };
  })()`);
  ok("一覧：応募者数・採用数の数字（0を含む）が列の中央にそろう", layout.apply <= 1 && layout.hire <= 1, JSON.stringify(layout));
  ok("一覧：右側のボタンの高さ・文字サイズ・位置がそろう", layout.heights.length === 1 && layout.fonts.length === 1 && layout.detailX.length === 1 && layout.ids === 0, JSON.stringify(layout));
  ok("応募者数には「CSVの応募数とは別」の説明がある", await evaluate(`[...document.querySelectorAll(".jp-head .jm-tip")].some(t => t.dataset.tip.includes("CSVの応募数とは別"))`));
  await shot("01-list-public-pc");
  await evaluate(`__click("確認する")`);
  await waitFor(`location.search.includes("view=unset")`, "unset view");
  ok("「確認する」で要設定の求人（原稿未登録）を表示", JSON.stringify(await evaluate("__rows()")) === JSON.stringify([CSV1, CSV2]) && await evaluate(`__qa(".jp-row .jp-vis.is-unset").length === 2 && __qa(".jp-row button.jp-flag").filter(x => x.textContent === "原稿未登録").length === 2`));
  ok("状態の表示：押せるもの（原稿未登録・掲載種別未設定・実績あり）だけがボタン／リンク、掲載種別は押せない表示", await evaluate(`__qa(".jp-row .jp-flag").every(x => ["BUTTON", "A"].includes(x.tagName)) && __qa(".jp-row .jp-sub .jm-dot").every(x => x.tagName === "SPAN" && !x.onclick)`));
  await evaluate(`__tab("すべて")`);
  await evaluate(`__set(__q(".jp-media select"), "Indeed")`);
  await waitFor(`location.search.includes("media=Indeed") && location.search.includes("view=all")`, "media filter");
  ok("媒体で絞り込み（Indeed 3件）。絞り込みはURLに保持", JSON.stringify(await evaluate("__rows()")) === JSON.stringify([CSV1, SALES2, CSV2]));
  await evaluate(`__set(__q(".jp-media select"), "ハローワーク")`);
  ok("媒体：ハローワークで絞り込み", JSON.stringify(await evaluate("__rows()")) === JSON.stringify([HW]));
  await evaluate(`__set(__q(".jp-media select"), "")`);

  // 2. 公開／非公開
  await evaluate(`__row(${JSON.stringify(CSV1)}).querySelector(".jp-actions-cell button").click()`);
  await waitFor("!!__modal()", "visibility dialog");
  ok("未設定の求人：「公開状態を設定」ダイアログ（公開中／非公開を選ぶ）", await evaluate(`__modal().innerText.includes("公開状態を設定") && __qa("input[type=radio]", __modal()).length === 2 && __modal().innerText.includes("外部サイトの掲載は変更されません")`));
  await evaluate(`__radio("公開中", __modal())`);
  await evaluate(`__set(__field("公開開始日", __modal()), "2026-10-01")`);
  await evaluate(`__click("設定する", __modal())`);
  await waitFor(`!__modal() && !!__q(".jm-ok")`, "set public");
  ok("要設定→公開中に設定（要設定は1件に）", await evaluate(`__tabCount("要設定") === 1 && __row(${JSON.stringify(CSV1)}).innerText.includes("公開中") && __row(${JSON.stringify(CSV1)}).innerText.includes("2026/10/01〜")`));
  await evaluate(`__row(${JSON.stringify(HW)}).querySelector(".jp-actions-cell button").click()`);
  await waitFor("!!__modal()", "private dialog");
  ok("非公開への切替：「この求人を非公開にしますか？」と キャンセル／はい", await evaluate(`__modal().innerText.startsWith("この求人を非公開にしますか？") && !!__btn("キャンセル", __modal()) && !!__btn("はい", __modal())`));
  await shot("02-private-confirm");
  await evaluate(`__click("キャンセル", __modal())`);
  ok("キャンセルでは変更しない", await evaluate(`!__modal() && __row(${JSON.stringify(HW)}).innerText.includes("公開中")`));
  await evaluate(`__row(${JSON.stringify(HW)}).querySelector(".jp-actions-cell button").click()`);
  await waitFor("!!__modal()", "private dialog 2");
  await evaluate(`__set(__field("理由（任意）", __modal()), "検証：採用予定数に達した")`);
  await evaluate(`__click("はい", __modal())`);
  await waitFor(`!__modal() && __row(${JSON.stringify(HW)}).innerText.includes("非公開")`, "set private");
  ok("「はい」で非公開に（ボタンは「公開する」に変わる）", await evaluate(`__row(${JSON.stringify(HW)}).querySelector(".jp-actions-cell button").textContent === "公開する"`));
  await evaluate(`__row(${JSON.stringify(HW)}).querySelector(".jp-actions-cell button").click()`);
  await waitFor("!!__modal()", "public dialog");
  ok("公開へ戻す操作は「この求人を公開しますか？」「公開する」", await evaluate(`__modal().innerText.startsWith("この求人を公開しますか？") && !!__btn("公開する", __modal())`));
  await evaluate(`__click("公開する", __modal())`);
  await waitFor(`!__modal() && __row(${JSON.stringify(HW)}).innerText.includes("公開中")`, "public again");
  // 古い画面（切替の件数が古い）からの切替は409
  const staleVis = await api("/api/job-postings/3/visibility", "POST", { visibility: "private", expected_seq: 1 });
  ok("古い画面からの公開状態の切替は409（保存しない）", staleVis.status === 409 && staleVis.data.code === "stale", JSON.stringify(staleVis));

  // 3. 応募者数・採用数のモーダル → 応募者詳細 → 戻る
  await evaluate(`__row(${JSON.stringify(HW)}).querySelectorAll(".jp-count")[0].click()`);
  await waitFor(`__modal() && __modal().querySelectorAll("tbody tr").length === 3`, "people modal");
  const people = await evaluate(`__qa("tbody tr", __modal()).map(tr => [...tr.cells].map(td => td.innerText.trim()))`);
  ok("応募者モーダル：氏名・応募日・応募経路・現在の選考状態", await evaluate(`__q("thead", __modal()).innerText.replace(/\\s+/g, " ").trim() === "氏名 応募日 応募経路 現在の選考状態"`), JSON.stringify(people));
  ok("アーカイブ済みの応募者も応募実績に含む（表示あり）", people.some(r => r[0].includes("岡田") && r[0].includes("アーカイブ")));
  await shot("03-people-modal");
  await evaluate(`__click("閉じる") || __q(".jm-close").click()`);
  await evaluate(`__row(${JSON.stringify(SALES2)})?.querySelectorAll(".jp-count")[1]?.click() ?? (__tab("すべて"), true)`);
  if (!(await evaluate("!!__modal()"))) { await evaluate(`__tab("すべて")`); await evaluate(`__row(${JSON.stringify(SALES2)}).querySelectorAll(".jp-count")[1].click()`); }
  await waitFor(`__modal() && __modal().querySelectorAll("tbody tr").length > 0`, "hired modal");
  const hired = await evaluate(`__qa("tbody tr", __modal()).map(tr => tr.innerText.replace(/\\s+/g, " "))`);
  ok("採用数モーダル：入社済みの応募者（非公開の求人でも表示）", hired.length === 1 && hired[0].includes("中村") && hired[0].includes("入社"), JSON.stringify(hired));
  await evaluate(`__tab("すべて"); __set(__q(".jp-media select"), "Indeed"); true`);
  await sleep(200);
  const listUrl = await evaluate("location.pathname + location.search");
  await evaluate(`__row(${JSON.stringify(SALES2)}).querySelectorAll(".jp-count")[0].click()`);
  await waitFor(`__modal() && __modal().querySelectorAll("tbody tr").length === 3`, "sales applicants");
  await evaluate(`[...__modal().querySelectorAll(".jp-name")].find(b => b.textContent.includes("山本")).click()`);
  await waitFor(`location.pathname === "/candidates/900013" && document.body.innerText.includes("求人一覧へ戻る")`, "candidate detail");
  ok("氏名クリックで既存の応募者詳細へ移動（求人画面内に編集画面を複製しない）", await evaluate(`!document.querySelector(".jp-page") && document.body.innerText.includes("基本情報")`));
  ok("応募者詳細に、ひも付いた求人を表示", await waitFor(`!!__q(".nks-posting-link")?.innerText.includes(${JSON.stringify(SALES2)})`, "posting link").catch(() => false));
  await evaluate(`__click("← 求人一覧へ戻る")`);
  await waitFor(`location.pathname === "/jobs" && !!document.querySelector(".jp-list")`, "back to list");
  ok("「求人一覧へ戻る」で元の絞り込み（すべて・Indeed）に戻る", (await evaluate("location.pathname + location.search")) === listUrl && JSON.stringify(await evaluate("__rows()")) === JSON.stringify([CSV1, SALES2, CSV2]), listUrl);

  // 4. 求人詳細
  await go(app + "/jobs/3", "!!document.querySelector('.jp-detail-head')", "detail");
  const head = await evaluate(`__q(".jp-detail-head").innerText.replace(/\\s+/g, " ")`);
  ok("詳細の上部：タイトル・職種・媒体・求人ID・公開状態・掲載種別・版・主要操作", [HW, "電気工事士", "ハローワーク", "00000-00000001", "公開中", "無料掲載", "第2版", "求人原稿を編集", "非公開にする", "求人分析で見る", "応募者数", "採用数"].every(t => head.includes(t)), head);
  ok("求人内容：勤務地・雇用形態・給与・勤務時間・休日・求人担当者・全文", await evaluate(`(() => { const t = __section("求人内容").innerText; return ["勤務地", "架空県架空市", "雇用形態", "給与条件", "月給27万円", "勤務時間", "休日", "求人担当者", "資格手当あり。"].every(x => t.includes(x)); })()`));
  ok("全文は改行を保ったまま表示し、コピーできる", await evaluate(`__q(".jp-body").textContent.split("\\n").length === 5 && !!__btn("全文をコピー")`));
  ok("公開状態の履歴：変更前→変更後・日付・理由・操作者・公開期間", await evaluate(`(() => { const t = __section("公開状態の履歴").innerText; return t.includes("未設定 → 公開中") && t.includes("公開中 → 非公開") && t.includes("非公開 → 公開中") && t.includes("理由：検証：採用予定数に達した") && t.includes("preview@web") && t.includes("公開期間"); })()`));
  ok("掲載種別の履歴：求人分析と同じ記録（この求人・無料掲載）", await evaluate(`__section("掲載種別の履歴").innerText.includes("この求人") && __section("掲載種別の履歴").innerText.includes("無料掲載")`));
  await evaluate(`__qa(".jp-fold-section").forEach(d => d.open = true)`);
  const rev = await evaluate(`__section("修正履歴").innerText.replace(/\\s+/g, " ")`);
  ok("修正履歴：第2版の修正内容・理由と、給与の修正前／修正後", rev.includes("第2版") && rev.includes("修正内容：給与を2万円引き上げ、資格手当を追記") && rev.includes("修正理由：応募が少ないため（架空）") && rev.includes("月給25万円〜35万円") && rev.includes("月給27万円〜37万円（資格手当込み）"), rev.slice(0, 200));
  ok("改善履歴：求人内容の修正メモと掲載状態のメモを時系列で表示", await evaluate(`(() => { const t = __section("改善履歴").innerText; return t.includes("求人原稿の修正（第2版）") && t.includes("掲載状態の変更メモ") && t.includes("ハローワークは無料掲載"); })()`));
  await shot("04-detail-pc");

  // 4-2. 修正（新しい版）と古い画面
  await evaluate(`__click("求人原稿を編集")`);
  await waitFor("!!__modal()", "revision dialog");
  ok("修正ダイアログ：現在の内容を初期値にし、詳細項目は折り畳み", await evaluate(`__field("求人タイトル", __modal()).value === ${JSON.stringify(HW)} && !!__q("details.jp-fold", __modal()) && __q("textarea.jp-body-input", __modal()).value.includes("資格手当あり。")`));
  await evaluate(`__set(__q("textarea.jp-body-input", __modal()), __q("textarea.jp-body-input", __modal()).value + "\\n（検証）賞与年2回。")`);
  await evaluate(`__click("新しい版として保存", __modal())`);
  ok("修正内容が空なら保存しない", await evaluate(`__modal().innerText.includes("修正内容を入力してください")`));
  // 別の画面で先に修正された場合
  const other = await api("/api/job-postings/3/revisions", "POST", { expected_revision_no: 2, title: "架空：電気工事士（太陽光・蓄電池）", body: "別画面の修正", change_summary: "別画面" });
  await evaluate(`__set(__field("修正内容", __modal()), "賞与を追記")`);
  await evaluate(`__click("新しい版として保存", __modal())`);
  await waitFor(`__modal().innerText.includes("他の画面で求人内容が修正されています")`, "stale revision");
  ok("古い画面からの修正は409（今回の内容は保存しない・読み込み直しボタン）", other.status === 200 && await evaluate(`!!__btn("画面を読み込み直す", __modal())`));
  await go(app + "/jobs/3", "!!document.querySelector('.jp-detail-head')", "detail reload");
  ok("読み込み直すと第3版（別画面の修正）", await evaluate(`__q(".jp-detail-head").innerText.includes("第3版")`));
  await evaluate(`__click("求人原稿を編集")`);
  await waitFor("!!__modal()", "revision dialog 2");
  await evaluate(`__set(__field("給与条件", __modal()), "月給28万円〜（検証）")`);
  await evaluate(`__set(__field("修正内容", __modal()), "給与を修正（検証）")`);
  await evaluate(`__set(__field("修正理由（任意）", __modal()), "検証")`);
  await evaluate(`__click("新しい版として保存", __modal())`);
  await waitFor(`!__modal() && __q(".jp-detail-head").innerText.includes("第4版")`, "rev 4");
  ok("修正を保存すると第4版（前の版は修正履歴に残る）", await evaluate(`(() => { __qa(".jp-fold-section").forEach(d => d.open = true); const t = __section("修正履歴").innerText; return ["第4版", "第3版", "第2版", "第1版"].every(x => t.includes(x)) && t.includes("月給28万円〜（検証）"); })()`));

  // 4-3. 掲載種別の変更（求人分析と同じ記録）
  await evaluate(`__click("掲載状態を変更")`);
  await waitFor("!!__modal()", "plan dialog");
  ok("掲載状態の変更は、この求人を選んだ状態で開く", await evaluate(`__q("select", __modal()).value === "3"`));
  await evaluate(`__radio("有料掲載", __modal()) || [...__modal().querySelectorAll("label")].find(l => l.textContent.includes("有料"))?.querySelector("input")?.click()`);
  await evaluate(`__set(__q("input[type=date]", __modal()), "2026-10-27")`);
  await evaluate(`__click("確認へ", __modal())`);
  await waitFor(`!!__btn("この内容で登録", __modal())`, "plan confirm");
  ok("確認画面の対象はこの求人", await evaluate(`__q(".jm-confirm", __modal()).innerText.includes(${JSON.stringify(HW)})`));
  await evaluate(`__click("この内容で登録", __modal())`);
  await waitFor(`!__modal()`, "plan saved");
  const mk = await api("/api/job-marketing");
  ok("求人詳細から変更した掲載状態が求人分析の履歴にも入る", mk.data.plan_events.some(e => e.posting_id === "3" && e.status === "paid" && e.effective_date === "2026-10-27") && await evaluate(`__section("掲載種別の履歴").innerText.includes("有料掲載")`));
  await evaluate(`__click("求人分析で見る")`);
  await waitFor(`location.pathname === "/job-marketing" && !!document.querySelector(".jm-tab.is-on")`, "marketing");
  ok("「求人分析で見る」で該当職種の求人分析を表示", await evaluate(`document.querySelector(".jm-tab.is-on").firstChild.textContent === "電気工事士"`));

  // 4-4. CSV由来の求人（初版未登録）
  await go(app + "/jobs/2", "!!document.querySelector('.jp-detail-head')", "csv detail");
  ok("CSV由来の求人：原稿未登録として確認済みの情報だけを表示（求人IDは詳細に表示）", await evaluate(`__q(".jp-detail-head").innerText.includes("原稿未登録") && __q(".jp-detail-head").innerText.includes("fictional-cad-001") && __section("求人内容").innerText.includes("求人原稿は未登録です")`));
  await evaluate(`__click("求人原稿を登録")`);
  await waitFor("!!__modal()", "first revision");
  ok("求人原稿の登録：確認済みの求人名だけを引き継ぎ、他は推測で補完しない", await evaluate(`__field("求人タイトル", __modal()).value === ${JSON.stringify(CSV2)} && __q("textarea.jp-body-input", __modal()).value === "" && !__field("修正内容", __modal())`));
  await evaluate(`__set(__q("textarea.jp-body-input", __modal()), "架空の求人内容（初版）\\n2行目")`);
  await evaluate(`__click("求人原稿を登録", __modal())`);
  await waitFor(`!__modal() && __q(".jp-detail-head").innerText.includes("第1版")`, "first revision saved");
  ok("求人原稿を登録すると第1版になり「原稿未登録」が消える", await evaluate(`!__q(".jp-detail-head").innerText.includes("原稿未登録") && __text(__q(".jp-detail-actions")).includes("求人原稿を編集")`));
  await evaluate(`__click("← 求人一覧へ戻る")`);
  await waitFor(`location.pathname === "/jobs" && !!document.querySelector(".jp-list")`, "list after first revision");
  await evaluate(`__tab("すべて")`);
  ok("一覧へ戻っても「原稿未登録」が残らない", await evaluate(`!__row(${JSON.stringify(CSV2)}).innerText.includes("原稿未登録")`));

  // 5. 求人の新規登録（ハローワーク）
  await go(app + "/jobs", "!!document.querySelector('.jp-list')", "jobs 2");
  await evaluate(`__click("＋ 求人を登録")`);
  await waitFor("!!__modal()", "new dialog");
  ok("登録ダイアログ：詳細項目は折り畳み（初期画面に入力欄を並べない）", await evaluate(`!__q("details.jp-fold", __modal()).open`));
  await evaluate(`__click("登録する", __modal())`);
  ok("必須項目が無いと登録しない", await evaluate(`__modal().innerText.includes("職種を選択してください")`));
  await evaluate(`__selectByText(__field("職種", __modal()), "営業")`);
  await evaluate(`__set(__field("掲載媒体", __modal()), "ハローワーク")`);
  await evaluate(`__set(__field("求人ID・参照番号（任意）", __modal()), "00000-00000099")`);
  await evaluate(`__set(__field("求人タイトル", __modal()), "検証：ハローワーク営業")`);
  await evaluate(`__set(__q("textarea.jp-body-input", __modal()), "貼り付けた全文1行目\\n\\n  字下げの行\\n最終行")`);
  await evaluate(`__q("details.jp-fold", __modal()).open = true`);
  await evaluate(`__set(__field("勤務地", __modal()), "架空市")`);
  await shot("05-new-posting");
  await evaluate(`__click("登録する", __modal())`);
  await waitFor(`location.pathname.startsWith("/jobs/") && !!document.querySelector(".jp-detail-head")`, "new detail");
  ok("新規登録後は求人詳細へ（第1版・公開中・全文の改行を保持）", await evaluate(`__q(".jp-detail-head").innerText.includes("第1版") && __q(".jp-detail-head").innerText.includes("公開中") && __q(".jp-body").textContent === "貼り付けた全文1行目\\n\\n  字下げの行\\n最終行"`));
  const newId = await evaluate(`location.pathname.split("/").pop()`);
  const dupe = await api("/api/job-postings", "POST", { category_id: "1", media: "ハローワーク", job_id: "00000-00000099", title: "重複" });
  ok("同じ媒体・求人IDの二重登録は409", dupe.status === 409 && dupe.data.code === "duplicate");

  // 6. 応募者の新規登録：媒体→求人を選び、同時に保存
  await go(app + "/register", "!!document.querySelector('input[name=name_kanji]')", "register");
  await evaluate(`__set(__q("input[name=name_kanji]"), "検証・求人応募")`);
  await evaluate(`__radio("求人")`);
  await waitFor(`!!document.querySelector("select[name=agent_media]")`, "media select");
  ok("応募経路「求人」：掲載媒体を選択（求人は媒体を選ぶまで選べない）", await evaluate(`__q("select[name=job_posting]").disabled === true`));
  await evaluate(`__set(__q("select[name=agent_media]"), "Indeed")`);
  const opts = await evaluate(`[...__q("select[name=job_posting]").options].map(o => o.textContent)`);
  ok("Indeedの求人だけを表示し、非公開の求人も選べる。「該当求人なし・不明」可", opts[0] === "該当求人なし・不明" && opts.some(o => o.startsWith(SALES2) && o.includes("非公開")) && !opts.some(o => o.startsWith(HW)), JSON.stringify(opts));
  // 「その他」で別の媒体名を入力すると、別媒体の求人の選択は外れる（P1-03）
  await evaluate(`__selectByText(__q("select[name=job_posting]"), ${JSON.stringify(SALES2)})`);
  await evaluate(`__set(__q("select[name=agent_media]"), "その他")`);
  await waitFor(`!!document.querySelector(".nks-posting-picker input[name=agent_name]")`, "other media input");
  await evaluate(`__set(__q(".nks-posting-picker input[name=agent_name]"), "doda")`);
  ok("「その他」で別の媒体名を入力すると、選択中の別媒体の求人は外れる", await evaluate(`__q("select[name=job_posting]").value === ""`));
  await evaluate(`__set(__q("select[name=agent_media]"), "Indeed")`);
  await evaluate(`__selectByText(__q("select[name=job_posting]"), ${JSON.stringify(SALES2)})`);
  await shot("06-register-picker");
  await evaluate(`__click("個人応募として登録")`);
  await sleep(800);
  const afterReg = await api("/api/job-postings");
  const sales2 = afterReg.data.postings.find(p => p.title === SALES2);
  const cands = await api("/api/candidates");
  const created = cands.data.find(c => c.name_kanji === "検証・求人応募");
  ok("新規登録と求人の選択を同時に保存（応募者数 3→4、媒体名は Indeed）", sales2.applicants === 4 && created?.agent_name === "Indeed", `${sales2.applicants} / ${created?.agent_name}`);
  // 求人の保存に失敗する場合（存在しない求人）は応募者も登録しない
  const before = cands.data.length;
  const bad = await api("/api/candidates", "POST", { name_kanji: "検証・失敗", source_type: "求人", agent_name: "Indeed", job_posting: { posting_id: "9999" } });
  ok("求人の保存に失敗したら応募者も登録しない（片方だけ成功しない）", bad.status === 400 && (await api("/api/candidates")).data.length === before);

  // 7. 既存応募者の編集：表記揺れの媒体名を保護し、求人を選ぶ・変更履歴
  await api("/api/candidates/900006", "PUT", { agent_name: "インディード", source_type: "求人" });
  await go(app + "/candidates/900006?view=detail", "!!document.querySelector('.nks-source-detail')", "edit candidate");
  await evaluate(`__click("編集", __q(".nks-source-detail"))`);
  await waitFor(`!!document.querySelector("select[name=agent_media]")`, "edit picker");
  ok("表記揺れ「インディード」は Indeed として表示し、保存値は変更しない旨を表示", await evaluate(`__q("select[name=agent_media]").value === "Indeed" && __q(".nks-posting-picker").innerText.includes("登録済みの媒体名「インディード」")`));
  await evaluate(`__selectByText(__q("select[name=job_posting]"), ${JSON.stringify(CSV1)})`);
  await evaluate(`__click("この内容を保存する")`);
  await waitFor(`!!document.querySelector(".nks-posting-link")`, "linked");
  const c6 = (await api("/api/candidates/900006")).data;
  const link6 = (await api("/api/candidates/900006/job-posting")).data;
  ok("既存応募者の求人を選択して保存（媒体名「インディード」はそのまま）", c6.agent_name === "インディード" && link6.current?.title === CSV1, `${c6.agent_name} / ${link6.current?.title}`);
  // 古い画面（job_posting を送らない全項目保存）では、ひも付けは消えない
  await api("/api/candidates/900006", "PUT", { ...c6, name_kanji: c6.name_kanji });
  ok("古い画面からの保存（求人の項目なし）でひも付けは消えない", (await api("/api/candidates/900006/job-posting")).data.current?.title === CSV1);
  // 別の画面でひも付けが変わった後に、古い画面から求人を変更すると409
  await evaluate(`__click("編集", __q(".nks-source-detail"))`);
  await waitFor(`!!document.querySelector("select[name=job_posting]")`, "edit picker 2");
  await api("/api/candidates/900006", "PUT", { source_type: "求人", agent_name: "インディード", job_posting: { posting_id: sales2.id, expected_link_id: link6.link_id } });
  // 応募経路を省略した保存は、本番と同じく「求人以外」として扱い、ひも付けがあれば409（P3-01）
  const omitted = await api("/api/candidates/900006", "PUT", { name_kanji: "保存されない名前" });
  ok("応募経路を省略した保存は、ひも付けがあれば409（本番と同じ判定・保存しない）", omitted.status === 409 && omitted.data.code === "link_required" && (await api("/api/candidates/900006")).data.name_kanji !== "保存されない名前");
  await evaluate(`__selectByText(__q("select[name=job_posting]"), "該当求人なし・不明")`);
  dialogs.length = 0;
  await evaluate(`__click("この内容を保存する")`);
  await sleep(800);
  const conflict = dialogs.find(m => m.includes("求人のひも付けが他の画面で変更されています"));
  ok("別の画面でひも付けが変わっていたら409（今回の保存は行わない）", Boolean(conflict) && (await api("/api/candidates/900006/job-posting")).data.current?.title === SALES2, dialogs.join(" | "));
  await go(app + "/candidates/900006?view=detail", "!!document.querySelector('.nks-posting-history')", "history");
  ok("求人の選択の変更履歴を表示", await evaluate(`(() => { const d = __q(".nks-posting-history"); d.open = true; return d.innerText.includes("求人の選択の履歴（2件）") && d.innerText.includes("未選択 → " + ${JSON.stringify(CSV1)}) && d.innerText.includes(${JSON.stringify(CSV1)} + " → " + ${JSON.stringify(SALES2)}); })()`));
  await evaluate(`__click("編集", __q(".nks-source-detail"))`);
  await waitFor(`!!document.querySelector("input[name=source_type]")`, "source radios");
  await evaluate(`__radio("紹介")`);
  ok("応募経路を「求人」以外にすると、ひも付けを外す旨を表示", await evaluate(`document.body.innerText.includes("とのひも付けを外します（履歴は残ります）")`));
  await evaluate(`__click("この内容を保存する")`);
  await sleep(800);
  ok("応募経路を変えて保存すると、ひも付けを外す（履歴に残る）", await (async () => { const l = (await api("/api/candidates/900006/job-posting")).data; return l.current === null && l.history.length === 3 && l.history[0].reason === "応募経路の種別を変更"; })());
  await api("/api/candidates/900006", "PUT", { source_type: "求人", agent_name: "インディード" });

  // 8. 採用数：内定→加算、内定辞退→除外
  const countHw = async () => (await api("/api/job-postings")).data.postings.find(p => p.id === "3");
  const addStep = async (id, kind, date, extra = {}) => { const v = (await api(`/api/candidates/${id}/selection`)).data; return api(`/api/candidates/${id}/selection/events`, "POST", { expected_version: v.version, kind, event_date: date, ...extra }); };
  const s0 = await countHw();
  await addStep(900003, "interview_completed", "2026-10-27");
  await addStep(900003, "offer", "2026-10-28");
  const s1 = await countHw();
  await addStep(900003, "declined", "2026-10-29", { note: "検証：内定辞退" });
  const s2 = await countHw();
  ok("採用数：内定で+1、内定辞退で除外（応募者数は変わらない）", s0.hires === 0 && s1.hires === 1 && s2.hires === 0 && s0.applicants === s2.applicants, `${s0.hires}→${s1.hires}→${s2.hires} / 応募者 ${s0.applicants}→${s2.applicants}`);
  await addStep(900018, "offer", "2026-10-28");
  const v18 = (await api("/api/candidates/900018/selection")).data;
  const s3 = await countHw();
  await api(`/api/candidates/900018/selection/events/${v18.records.at(-1).id}/void`, "POST", { expected_version: v18.version, reason: "検証：内定取消" });
  const s4 = await countHw();
  ok("採用数：内定の記録を取消すると除外", s3.hires === 1 && s4.hires === 0, `${s3.hires}→${s4.hires}`);
  const dash = await api("/api/dashboard/facts");
  ok("ダッシュボードの集計元は従来どおり（内定の事実は履歴に残る）", dash.status === 200 && dash.data.facts.find(f => f.id === "900003").offers.includes("2026-10-28"));

  // 8-2. 往復の戻り導線：絞り込み一覧 → 求人詳細 → 応募者詳細 → 求人詳細 → 一覧（絞り込みを保持。P1-04）
  await go(app + "/jobs?view=all&media=%E3%83%8F%E3%83%AD%E3%83%BC%E3%83%AF%E3%83%BC%E3%82%AF", "!!document.querySelector('.jp-list')", "filtered list");
  const filtered = await evaluate("location.pathname + location.search");
  await evaluate(`__row(${JSON.stringify(HW)}).querySelector(".jp-detail-btn").click()`);
  await waitFor(`location.pathname === "/jobs/3" && !!document.querySelector(".jp-detail-head")`, "detail from list");
  await evaluate(`__q(".jp-detail-counts .jp-count").click()`);
  await waitFor(`__modal() && __modal().querySelectorAll(".jp-name").length > 0`, "detail people");
  await evaluate(`__q(".jp-name", __modal()).click()`);
  await waitFor(`location.pathname.startsWith("/candidates/") && document.body.innerText.includes("求人詳細へ戻る")`, "candidate from detail");
  await evaluate(`__click("← 求人詳細へ戻る")`);
  await waitFor(`location.pathname === "/jobs/3" && !!document.querySelector(".jp-detail-head")`, "back to detail");
  await evaluate(`__click("← 求人一覧へ戻る")`);
  await waitFor(`location.pathname === "/jobs" && !!document.querySelector(".jp-list")`, "back to list 2");
  ok("求人詳細→応募者詳細→求人詳細→一覧と戻っても、一覧の絞り込みを保持", (await evaluate("location.pathname + location.search")) === filtered, filtered);

  // 8-3. ひも付けを読み込めない場合は求人を選べない（選択が保存されないまま成功表示にならない。P1-01）
  await go(app + "/candidates", `document.querySelectorAll("tbody tr").length > 0`, "candidates for fail");
  await evaluate(`(() => { window.__realFetch = window.fetch; window.fetch = (u, o) => String(u).endsWith("/candidates/900010/job-posting") ? Promise.resolve(new Response("{}", { status: 500 })) : window.__realFetch(u, o);
    history.pushState({}, "", "/candidates/900010?view=detail"); dispatchEvent(new PopStateEvent("popstate")); return true; })()`);
  await waitFor(`!!document.querySelector(".nks-source-detail")`, "candidate with failing link");
  await evaluate(`__click("編集", __q(".nks-source-detail"))`);
  await waitFor(`!!document.querySelector("select[name=agent_media]")`, "picker with failing link");
  ok("ひも付けを読み込めない場合：求人の選択欄を出さず、再読み込みを案内", await waitFor(`!document.querySelector("select[name=job_posting]") && __q(".nks-posting-picker").innerText.includes("求人のひも付けを読み込めなかったため")`, "link error note").catch(() => false));
  // ひも付けを読み込めないまま応募経路を「求人」以外に変えて保存：409で何も保存しない（P2-01）
  await evaluate(`__radio("紹介")`);
  dialogs.length = 0;
  await evaluate(`__click("この内容を保存する")`);
  await sleep(800);
  await evaluate(`window.fetch = window.__realFetch; true`);
  const c10 = (await api("/api/candidates/900010")).data;
  ok("ひも付けを読み込めないまま応募経路を変えた保存は409（応募経路もひも付けも変わらない）",
    dialogs.some(m => m.includes("応募経路の種別の変更は、画面を読み込み直してから")) && c10.source_type === "求人" && (await api("/api/candidates/900010/job-posting")).data.current?.title === AIR, dialogs.join(" | "));
  await evaluate(`window.fetch = window.__realFetch; true`);

  // 協力業者へ切り替えて保存：同じ保存でひも付けを外し、履歴に残す（P2-02）
  await go(app + "/candidates/900001?view=detail", "!!document.querySelector('.nks-posting-link')", "linked candidate");
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("協力業者へ切替")).click()`);
  await sleep(300);
  await evaluate(`__click("この内容を保存する")`);
  await sleep(800);
  const c1 = (await api("/api/candidates/900001")).data;
  const l1 = (await api("/api/candidates/900001/job-posting")).data;
  ok("協力業者へ切り替えて保存すると、同じ保存でひも付けを外す（理由「協力業者に変更」）", c1.is_coop === true && l1.current === null && l1.history[0]?.reason === "協力業者に変更", `${c1.is_coop} / ${l1.history[0]?.reason}`);

  // 8-4. 求人分析：CAD本社・ときがわのタブ切替と、無料／有料比較の表示条件（架空の実績をプレビューのAPIで登録）
  const mk0 = await api("/api/job-marketing");
  const catId = name => mk0.data.categories.find(c => c.name === name).id;
  const rec = (name, start, end, plan, v) => api("/api/job-marketing/records", "POST", { record: { category_id: catId(name), media: "Indeed", period_start: start, period_end: end, plan_type: plan,
    impressions: v[0], clicks: v[1], apply_starts: v[2], applies: v[3] } });
  const r1 = await rec("CADオペ（本社）", "2026-09-01", "2026-09-30", "free", [458, 87, 2, 2]);
  const r2 = await rec("CADオペ（ときがわ）", "2026-09-01", "2026-09-30", "paid", [16, 6, 0, 0]);
  ok("架空の実績を登録（本社：無料のみ、ときがわ：有料のみ）", r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
  await go(app + "/job-marketing", "!!document.querySelector('.jm-kpis')", "marketing cad");
  await evaluate(`__set(__q(".jm-bar .jm-month select"), "2026-09")`);
  const kpiOf = async name => {
    await evaluate(`[...document.querySelectorAll(".jm-tab")].find(b => b.firstChild.textContent === ${JSON.stringify(name)}).click()`);
    await sleep(300);
    return evaluate(`({ on: document.querySelector(".jm-tab.is-on").firstChild.textContent, kpi: __q(".jm-kpis").innerText.replace(/\\s+/g, " "),
      compare: [...document.querySelectorAll(".jm-card")].some(c => (c.querySelector("h3")?.textContent || "").startsWith("無料／有料掲載の比較")) })`);
  };
  const honsha = await kpiOf("CADオペ（本社）");
  const tokigawa = await kpiOf("CADオペ（ときがわ）");
  ok("求人分析：本社タブは本社の実績（458・87）、ときがわタブはときがわの実績（16・6）を表示",
    honsha.on === "CADオペ（本社）" && honsha.kpi.includes("458") && honsha.kpi.includes("87") && !honsha.kpi.includes(" 16 ")
    && tokigawa.on === "CADオペ（ときがわ）" && /\b16\b/.test(tokigawa.kpi) && !tokigawa.kpi.includes("458"), `${honsha.kpi.slice(0, 80)} | ${tokigawa.kpi.slice(0, 80)}`);
  ok("無料／有料比較：無料だけ（本社）・有料だけ（ときがわ）の場合は表示しない", honsha.compare === false && tokigawa.compare === false);
  await rec("CADオペ（ときがわ）", "2026-08-01", "2026-08-31", "free", [40, 3, 0, 0]);
  await go(app + "/job-marketing", "!!document.querySelector('.jm-kpis')", "marketing cad 2");
  await evaluate(`__set(__q(".jm-bar .jm-month select"), "2026-09")`);
  const tokigawa2 = await kpiOf("CADオペ（ときがわ）");
  ok("無料／有料比較：無料・有料の両方に実績がある場合は表示", tokigawa2.compare === true);
  const salesSep = await kpiOf("営業");
  ok("無料／有料比較：営業の9月（直近12か月は無料だけ。有料は10/14から）は表示しない", salesSep.compare === false);
  await evaluate(`__set(__q(".jm-bar .jm-month select"), "2026-10")`);
  const sales = await kpiOf("営業");
  ok("無料／有料比較：営業の10月（無料→有料）は従来どおり表示", sales.compare === true);
  await shot("11-marketing-compare");

  // 8-5. 状態の表示から該当の操作へ（実績あり→求人分析の対象求人、掲載種別未設定→掲載状態の変更、原稿未登録→求人原稿の登録）
  await go(app + "/jobs?view=all", "!!document.querySelector('.jp-list')", "list for flags");
  const flagsUrl = await evaluate("location.pathname + location.search");
  await evaluate(`[...__row(${JSON.stringify(HW)}).querySelectorAll(".jp-flag")].find(x => x.textContent === "実績あり").click()`);
  await waitFor(`location.pathname === "/job-marketing" && !!document.querySelector(".jm-kpis")`, "analysis from flag");
  await waitFor(`!!document.querySelector(".jm-postings li.is-focus")`, "focused posting").catch(() => null);
  const focus = await evaluate(`({ tab: document.querySelector(".jm-tab.is-on").firstChild.textContent, month: __q(".jm-bar .jm-month select").value,
    open: !!__q(".jm-postings")?.open, focus: __q(".jm-postings li.is-focus")?.innerText.includes(${JSON.stringify(HW)}), back: !!__q(".jm-back-link") })`);
  ok("「実績あり」→ 求人分析で対象の職種・月を開き、求人原稿の内訳で対象を強調", focus.tab === "電気工事士" && focus.month === "2025-10" && focus.open && focus.focus && focus.back, JSON.stringify(focus));
  await evaluate(`__q(".jm-back-link").click()`);
  await waitFor(`location.pathname.startsWith("/jobs/") && !!document.querySelector(".jp-detail-head")`, "back to detail from analysis");
  ok("求人分析の「求人詳細へ戻る」で求人詳細へ", await evaluate(`__q(".jp-detail-head h2").textContent === ${JSON.stringify(HW)}`));
  await evaluate(`__click("← 求人一覧へ戻る")`);
  await waitFor(`location.pathname === "/jobs" && !!document.querySelector(".jp-list")`, "back to list from analysis");
  ok("さらに「求人一覧へ戻る」で元の絞り込みに戻る", (await evaluate("location.pathname + location.search")) === flagsUrl, flagsUrl);
  await evaluate(`[...__row(${JSON.stringify(AIR)}).querySelectorAll(".jp-flag")].find(x => x.textContent === "掲載種別未設定").click()`);
  await waitFor(`!!__modal() && __modal().innerText.includes("掲載状態の変更")`, "plan dialog from flag");
  ok("「掲載種別未設定」→ 求人詳細で掲載状態の変更を、この求人を選んだ状態で開く", await evaluate(`__q("select", __modal()).value === location.pathname.split("/").pop() && !location.search.includes("open=")`));
  await evaluate(`__q(".jm-close", __modal()).click()`);
  await go(app + "/jobs?view=all", "!!document.querySelector('.jp-list')", "list for revision flag");
  await evaluate(`[...__row(${JSON.stringify(CSV1)}).querySelectorAll(".jp-flag")].find(x => x.textContent === "原稿未登録").click()`);
  await waitFor(`!!__modal() && __modal().innerText.startsWith("求人原稿を登録")`, "revision dialog from flag");
  ok("「原稿未登録」→ 求人詳細で求人原稿の登録を開く", true);
  await evaluate(`__q(".jm-close", __modal()).click()`);

  // 月をまたぐ実績（この月の集計には含めない記録）が対象の場合も、内訳を開いて強調する（U1-02）
  const airRow = (await api("/api/job-postings")).data.postings.find(p => p.title === AIR);
  const span = await api("/api/job-marketing/records", "POST", { record: { category_id: airRow.category_id, posting_id: airRow.id, media: "Indeed",
    period_start: "2024-09-15", period_end: "2024-10-15", plan_type: "free", impressions: 50, clicks: 4, apply_starts: 0, applies: 0 } });
  await go(app + `/job-marketing?category=${airRow.category_id}&posting=${airRow.id}`, "!!document.querySelector('.jm-kpis') || !!document.querySelector('.jm-empty')", "analysis spanning");
  await waitFor(`!!document.querySelector(".jm-posting-spanning li.is-focus")`, "spanning focus").catch(() => null);
  ok("月をまたぐ実績が対象でも、求人原稿の内訳を開いて対象を強調", span.status === 200 && await evaluate(`__q(".jm-bar .jm-month select").value === "2024-09" && !!__q(".jm-postings")?.open && !!__q(".jm-posting-spanning li.is-focus")`),
    await evaluate(`__q(".jm-bar .jm-month select").value + " " + !!__q(".jm-postings")`));


  // 8-6. 職種の「＋」：求人分析と同じ職種マスタに追加し、選択済みにする（入力中の内容は保持）。重複は既存の仕組みで防ぐ
  await go(app + "/jobs", "!!document.querySelector('.jp-list')", "list for new");
  await evaluate(`__click("＋ 求人を登録")`);
  await waitFor("!!__modal()", "new dialog 2");
  await evaluate(`__set(__field("求人タイトル", __modal()), "検証：職種と媒体の追加")`);
  await evaluate(`__set(__q("textarea.jp-body-input", __modal()), "入力途中の原稿\\n・箇条書き")`);
  await evaluate(`__q(".jp-add-btn", __modal()).click()`);
  await waitFor(`__qa(".jm-modal").length === 2 && __qa(".jm-modal").at(-1).innerText.startsWith("職種の管理")`, "category manager");
  const top = `__qa(".jm-modal").at(-1)`;
  await evaluate(`__set(__q('input[aria-label="追加する職種名"]', ${top}), "検証職種")`);
  await evaluate(`__click("追加", ${top})`);
  await waitFor(`__qa(".jm-modal").length === 1`, "manager closed");
  const picked = await evaluate(`(() => { const sel = __q(".jp-select-add select", __modal()); return { text: sel.selectedOptions[0]?.textContent, title: __field("求人タイトル", __modal()).value, body: __q("textarea.jp-body-input", __modal()).value }; })()`);
  ok("「＋」で職種の管理を開き、追加した職種を選択済みにする（入力中のタイトル・原稿は保持）", picked.text === "検証職種" && picked.title === "検証：職種と媒体の追加" && picked.body.includes("・箇条書き"), JSON.stringify(picked));
  await evaluate(`__q(".jp-add-btn", __modal()).click()`);
  await waitFor(`__qa(".jm-modal").length === 2`, "category manager 2");
  await evaluate(`__set(__q('input[aria-label="追加する職種名"]', ${top}), " 検証職種 ")`);
  await evaluate(`__click("追加", ${top})`);
  await waitFor(`${top}.innerText.includes("同じ名前の職種が既にあります")`, "duplicate category");
  ok("同じ名前の職種は既存の仕組みで登録しない", true);
  await evaluate(`__q(".jm-close", ${top}).click()`);
  // 媒体：「その他（入力）」で新しい媒体名を入力して登録 → 以後の選択肢に表示
  await evaluate(`__set(__field("掲載媒体", __modal()), "その他")`);
  await waitFor(`!!__q('input[aria-label="媒体名"]', __modal())`, "other media input");
  await evaluate(`__set(__q('input[aria-label="媒体名"]', __modal()), "求人ボックス")`);
  await evaluate(`__click("登録する", __modal())`);
  await waitFor(`location.pathname.startsWith("/jobs/") && !!document.querySelector(".jp-detail-head")`, "detail after new media");
  const mk1 = await api("/api/job-marketing");
  ok("追加した職種は求人分析の職種にも表示（同じマスタ）", mk1.data.categories.some(c => c.name === "検証職種") && await evaluate(`__q(".jp-detail-head").innerText.includes("検証職種") && __q(".jp-detail-head").innerText.includes("求人ボックス")`));
  await go(app + "/jobs", "!!document.querySelector('.jp-list')", "list for media reuse");
  await evaluate(`__click("＋ 求人を登録")`);
  await waitFor("!!__modal()", "new dialog 3");
  ok("新しく登録した媒体「求人ボックス」が次回から選択肢に出る", await evaluate(`[...__field("掲載媒体", __modal()).options].some(o => o.value === "求人ボックス")`));
  await evaluate(`__set(__field("掲載媒体", __modal()), "その他")`);
  await waitFor(`!!__q('input[aria-label="媒体名"]', __modal())`, "other media input 2");
  await evaluate(`__set(__q('input[aria-label="媒体名"]', __modal()), "求人 ボックス")`);
  ok("表記だけが違う媒体名は、登録済みの表記にそろえる旨を表示", await evaluate(`__modal().innerText.includes("「求人ボックス」として登録されます")`));
  await evaluate(`__set(__q('input[aria-label="媒体名"]', __modal()), "ボックス")`);
  ok("近い媒体名は登録済みの候補を表示（自動では置き換えない）", await evaluate(`__modal().innerText.includes("登録済みの媒体：") && __q('input[aria-label="媒体名"]', __modal()).value === "ボックス"`));
  await evaluate(`__q(".jm-close", __modal()).click()`);
  const dupMedia = await api("/api/job-postings", "POST", { category_id: "1", media: "求人 ボックス", title: "検証：表記揺れ" });
  const afterMedia = (await api("/api/job-postings")).data;
  ok("表記揺れの媒体名で登録しても、登録済みの「求人ボックス」にそろう（媒体が重複しない）", dupMedia.status === 200 && afterMedia.postings.find(p => p.id === dupMedia.data.id).media === "求人ボックス" && !afterMedia.media.includes("求人 ボックス"));
  await go(app + "/register", "!!document.querySelector('input[name=name_kanji]')", "register media");
  await evaluate(`__radio("求人")`);
  await waitFor(`!!document.querySelector("select[name=agent_media]")`, "register media select");
  ok("応募者登録の掲載媒体にも同じ表記（求人ボックス）が出る", await evaluate(`[...__q("select[name=agent_media]").options].some(o => o.value === "求人ボックス")`));

  // 9. スマホ表示
  viewport = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await go(app + "/jobs?view=all", "!!document.querySelector('.jp-list')", "mobile list");
  ok("スマホ：カード表示（表の見出しは非表示）・横スクロールなし", await evaluate(`getComputedStyle(__q(".jp-head")).display === "none" && document.documentElement.scrollWidth <= innerWidth + 1 && __qa(".jp-row:not(.jp-head)").every(r => r.getBoundingClientRect().width <= innerWidth)`), await evaluate(`document.documentElement.scrollWidth + "/" + innerWidth`));
  ok("スマホ：カードに媒体・応募者数・採用数・公開状態・詳細", await evaluate(`(() => { const r = __row(${JSON.stringify(HW)}); const labels = [...r.querySelectorAll("[data-label]")].filter(e => getComputedStyle(e, "::before").content !== "none").map(e => getComputedStyle(e, "::before").content.replace(/\"/g, "")); return ["媒体", "応募者数", "採用数"].every(x => labels.includes(x)) && r.innerText.includes("公開中") && r.innerText.includes("詳細"); })()`));
  await shot("07-list-mobile");
  await evaluate(`__row(${JSON.stringify(HW)}).querySelectorAll(".jp-count")[0].click()`);
  await waitFor(`!!__modal()`, "mobile modal");
  await shot("08-modal-mobile");
  await evaluate(`__q(".jm-close").click()`);
  await go(app + "/jobs/3", "!!document.querySelector('.jp-detail-head')", "mobile detail");
  ok("スマホ：求人詳細も横スクロールなし", await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), await evaluate(`document.documentElement.scrollWidth + "/" + innerWidth`));
  await shot("09-detail-mobile");
  await go(app + "/candidates/900003?view=detail", "!!document.querySelector('.nks-source-detail')", "mobile candidate");
  await evaluate(`__click("編集", __q(".nks-source-detail"))`);
  await waitFor(`!!document.querySelector("select[name=job_posting]")`, "mobile picker");
  // 既存の応募者詳細はスマホで右側の入力欄が画面外に出る（従来からの配置。今回は変更しない）。選択欄が入力欄の幅に収まることを確認する
  ok("スマホ：応募者編集の媒体・求人の選択（入力欄の幅に収まる）", await evaluate(`(() => { const sel = __q("select[name=job_posting]"); const box = __q(".nks-source-detail").getBoundingClientRect(); const r = sel.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && sel.value === "3"; })()`));
  await shot("10-candidate-picker-mobile");
  viewport = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false };
  await send("Emulation.setDeviceMetricsOverride", viewport);

  // 10. 既存画面の回帰（応募者一覧・ダッシュボード・求人分析）
  await go(app + "/candidates", `document.querySelectorAll("tbody tr").length > 0`, "candidates");
  ok("既存：応募者一覧を表示", true);
  await go(app + "/job-marketing", "!!document.querySelector('.jm-kpis')", "marketing");
  ok("既存：求人分析を表示", true);
  await go(app + "/", "document.body.innerText.length > 200", "dashboard");
  ok("既存：ダッシュボードを表示", true);

  // 11. migration 005 適用前（テーブル未作成）のプレビュー
  if (noTable) {
    await send("Page.navigate", { url: noTable + "/" });
    await waitFor("document.readyState === 'complete'", "load no-table");
    await evaluate(`fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "preview", password: "preview-only" }) }).then(r => r.status)`);
    await go(noTable + "/jobs", `document.body.innerText.includes("求人一覧のテーブルが未作成")`, "no-table jobs");
    ok("テーブル未作成：求人一覧は未作成の案内だけを表示", true);
    await go(noTable + "/register", "!!document.querySelector('input[name=name_kanji]')", "no-table register");
    await evaluate(`__radio("求人")`);
    await sleep(300);
    ok("テーブル未作成：応募者の登録は従来どおり（求人の選択欄は出さない）", await evaluate(`!document.querySelector("select[name=job_posting]")`));
    const reg = await evaluate(`fetch("/api/candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name_kanji: "検証・未作成", source_type: "求人", agent_name: "Indeed" }) }).then(r => r.status)`);
    const put = await evaluate(`fetch("/api/candidates/900001", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_posting: { posting_id: "1", expected_link_id: null } }) }).then(r => r.status)`);
    ok("テーブル未作成：登録は成功し、ひも付けの保存は503", reg === 200 && put === 503, `${reg}/${put}`);
  }

  ok("ブラウザのエラーなし", problems.length === 0, problems.join(" | "));
} catch (err) {
  ok("検証の実行", false, [err.message, ...problems].join(" | "));
  await shot("zz-error").catch(() => null);
} finally {
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ app, steps, problems, dialogs }, null, 2));
  await send("Browser.close").catch(() => null);
  ws.close();
  await sleep(1500);
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
  else browser.kill();
  for (let i = 0; i < 10; i += 1) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  const failed = steps.filter(s => !s.value).length;
  console.log(`\n${steps.length - failed}/${steps.length} PASS。スクリーンショット: ${out}`);
  process.exitCode = failed ? 1 : 0;
}
