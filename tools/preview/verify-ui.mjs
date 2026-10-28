// ローカルプレビュー（架空データ）の画面検証。ヘッドレスEdge/ChromeをDevToolsプロトコルで操作する。
// 本番環境には接続しない。外部パッケージ不要（Node 22以降の WebSocket を使用）。
// 使い方: 別ターミナルで node tools/preview/preview-server.cjs を起動（起動直後の初期データで実行）
//         node tools/preview/verify-ui.mjs <スクリーンショット保存先フォルダ> [http://127.0.0.1:5188]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "nks-recruit-ui-check"));
const app = process.argv[3] || "http://127.0.0.1:5188";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(app)) throw new Error("ローカルのプレビューサーバーのみ対象です: " + app);
const browserPath = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(p => p && fs.existsSync(p));
if (!browserPath) throw new Error("Edge/Chrome が見つかりません。BROWSER_PATH を指定してください");
const port = 9333;
fs.mkdirSync(out, { recursive: true });
const browser = spawn(browserPath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(out, "browser-profile")}`,
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
let dialogAnswer = true; // 次の確認ダイアログへの応答
ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") problems.push("exception: " + msg.params.exceptionDetails.exception?.description);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push("console.error: " + msg.params.args.map(a => a.value ?? a.description).join(" "));
  if (msg.method === "Page.javascriptDialogOpening") {
    dialogs.push(`${msg.params.type}: ${msg.params.message}`);
    send("Page.handleJavaScriptDialog", { accept: msg.params.type === "alert" ? true : dialogAnswer });
    dialogAnswer = true;
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluate failed");
  return r.result?.result?.value;
}
async function waitFor(expression, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(150); }
  throw new Error("timeout: " + label);
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(r.result.data, "base64"));
}
const steps = [];
const ok = (name, value) => { steps.push({ name, value }); console.log(`${value ? "PASS" : "FAIL"} ${name}`); };
const helpers = `
  window.__setValue = (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  window.__click = (text, scope = document) => {
    const el = [...scope.querySelectorAll("button")].find(b => b.textContent.trim() === text && !b.disabled);
    if (!el) return false; el.click(); return true;
  };
  window.__modal = () => document.querySelector(".nks-sel-modal");
  window.__labels = () => [...document.querySelectorAll(".nks-sel-modal .nks-timeline-item strong")].map(s => s.textContent);
  true`;
const go = async (url, ready, label) => {
  await send("Page.navigate", { url: app + url });
  await waitFor(ready, label);
  await evaluate(helpers);
  await sleep(250);
};

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go("/", `!!document.querySelector(".nks-auth-card")`, "login form");
  await evaluate(`(() => { const [u, p] = document.querySelectorAll(".nks-auth-card input"); __setValue(u, "preview"); __setValue(p, "preview-only"); document.querySelector(".nks-auth-submit").click(); return true; })()`);
  await waitFor(`!document.querySelector(".nks-auth-card")`, "logged in");

  // 一覧：バッジ・ボタンの整列
  await go("/candidates", `document.querySelectorAll("tbody tr").length >= 8`, "list rows");
  await shot("01-list");
  const layout = await evaluate(`(() => {
    const rows = [...document.querySelectorAll("tbody tr")];
    const cell = r => r.children[5];
    const b = rows.map(r => cell(r).querySelector(".nks-row-btn").getBoundingClientRect());
    const g = rows.map(r => cell(r).querySelector(".nks-list-cell-main > span").getBoundingClientRect());
    const left = rows.map(r => cell(r).getBoundingClientRect().left);
    return {
      bh: new Set(b.map(x => Math.round(x.height))).size, br: new Set(b.map((x, i) => Math.round(x.right - left[i]))).size,
      gh: new Set(g.map(x => Math.round(x.height))).size, gl: new Set(g.map((x, i) => Math.round(x.left - left[i]))).size,
      all: new Set([...document.querySelectorAll("tbody .nks-row-btn")].map(x => Math.round(x.getBoundingClientRect().height))).size,
    };
  })()`);
  ok("一覧：更新ボタンの高さ・位置が全行で同一", layout.bh === 1 && layout.br === 1);
  ok("一覧：バッジの高さ・位置が全行で同一", layout.gh === 1 && layout.gl === 1);
  ok("一覧：行内ボタンの高さが全て同一", layout.all === 1);

  // 第3弾：一覧タブ（進行中のみ通常表示）・連絡先の2段表示・全タブ検索
  const rowText = `[...document.querySelectorAll("tbody tr")].map(r => r.textContent).join("\\n")`;
  const clickTab = label => evaluate(`[...document.querySelectorAll(".nks-list-tabs button")].find(b => b.firstChild.textContent === ${JSON.stringify(label)}).click()`);
  ok("一覧：タブは 進行中／入社済／終了・削除済／協力業者", await evaluate(`JSON.stringify([...document.querySelectorAll(".nks-list-tabs button")].map(b => b.firstChild.textContent))`) === JSON.stringify(["進行中", "入社済", "終了・削除済", "協力業者"]));
  ok("一覧：進行中に終了・入社済・協力業者を出さない", await evaluate(`(() => { const t = ${rowText}; return !t.includes("表示確認用・伊藤") && !t.includes("表示確認用・中村") && !t.includes("表示確認用・協力担当") && t.includes("表示確認用・田中"); })()`));
  ok("一覧：TEL・メールはバッジが上段、値が下段", await evaluate(`[...document.querySelectorAll(".nks-contact")].every(c => c.children[0].getBoundingClientRect().bottom <= c.children[1].getBoundingClientRect().top + 1)`));
  await evaluate(`__setValue(document.querySelector(".nks-list-search"), "架空工業")`);
  await sleep(200);
  ok("一覧：会社名で検索でき、該当件数を他タブにも表示", await evaluate(`JSON.stringify([...document.querySelectorAll(".nks-list-tab-count")].map(x => x.textContent)) === JSON.stringify(["0", "0", "0", "1"])`));
  await evaluate(`__setValue(document.querySelector(".nks-list-search"), "")`);
  await clickTab("終了・削除済");
  await waitFor(`[...document.querySelectorAll("tbody tr")].some(r => r.textContent.includes("表示確認用・山本"))`, "ended tab");
  await shot("01b-list-ended");
  ok("終了・削除済：行をグレーアウト", await evaluate(`[...document.querySelectorAll("tbody tr")].every(r => r.classList.contains("nks-row-ended"))`));
  ok("終了・削除済：終了日（訂正後の日付）と理由を表示", await evaluate(`(() => { const r = [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("表示確認用・山本")); return r.textContent.includes("終了日 2026/10/15") && r.textContent.includes("不採用"); })()`));
  ok("終了・削除済：旧データは終了日を推測しない", await evaluate(`[...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("表示確認用・藤田")).textContent.includes("終了日不明")`));
  ok("終了・削除済：論理削除は削除済の表示と従来の復元・完全消去", await evaluate(`(() => { const r = [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("表示確認用・岡田")); return r.textContent.includes("削除済") && r.textContent.includes("復元") && r.textContent.includes("完全消去"); })()`));
  ok("終了・削除済：不採用・辞退だけの行は完全消去を出さない（従来どおり削除のみ）", await evaluate(`(() => { const r = [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("表示確認用・山本")); return !r.textContent.includes("完全消去") && r.textContent.includes("削除"); })()`));

  // 第3弾：期別ダッシュボード（1段目5カード・2段目 終了実績／採用経費・3段目 現在の選考状況）
  await go("/", `!!document.querySelector("[data-kpi='interviews']")`, "dashboard");
  const num = id => `(document.querySelector("[data-kpi='${id}'] .nks-kpi-num")?.textContent || "")`;
  const rect = sel => `document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect()`;
  ok("ダッシュボード：当期（54期）を初期表示（期選択・当期・A4印刷は上部右側）", await evaluate(`(() => {
    const s = document.querySelector(".nks-period select"), tools = ${rect(".nks-dash-tools")}, head = ${rect(".nks-dash-head")};
    return s.selectedOptions[0].textContent.startsWith("54期") && !!document.querySelector(".nks-period-tag") && tools.right > head.right - 4 && tools.left > head.left + head.width / 2
      && [...document.querySelectorAll(".nks-dash-tools button")].some(b => b.textContent === "A4印刷");
  })()`));
  ok("ダッシュボード：1段目5カード・2段目2カード・3段目現在の選考状況", await evaluate(`(() => {
    const row1 = [...document.querySelectorAll(".nks-kpi-grid > .nks-kpi-card")], row2 = [...document.querySelectorAll(".nks-dash-row2 > .nks-kpi-card")];
    const tops = list => new Set(list.map(c => Math.round(c.getBoundingClientRect().top))).size;
    const now = ${rect(".nks-now")}, grid = ${rect(".nks-kpi-grid")};
    return row1.map(c => c.dataset.kpi).join() === "applied,interviewed,interviews,offers,joins" && tops(row1) === 1
      && row2.map(c => c.dataset.kpi).join() === "ended,cost" && tops(row2) === 1
      && row2[0].getBoundingClientRect().top > row1[0].getBoundingClientRect().bottom
      && now.top > row2[0].getBoundingClientRect().bottom && Math.abs(now.width - grid.width) <= 2;
  })()`));
  ok("ダッシュボード：面接実績 5人・面談回数 8回", await evaluate(`${num("interviewed")} === "5" && ${num("interviews")} === "8"`));
  ok("ダッシュボード：面談回数の内訳は数字の直下に左詰め（1次 5回 2次 2回 3次 1回）", await evaluate(`(() => {
    const c = document.querySelector("[data-kpi='interviews']"), b = c.querySelector(".nks-kpi-breakdown"), n = c.querySelector(".nks-kpi-num").getBoundingClientRect();
    const r = b.getBoundingClientRect(), last = b.lastElementChild.getBoundingClientRect(), card = c.getBoundingClientRect();
    return JSON.stringify([...b.children].map(x => x.textContent)) === JSON.stringify(["1次 5回", "2次 2回", "3次 1回"])
      && Math.abs(r.left - n.left) <= 1 && r.top >= n.bottom - 1 && r.top - n.bottom < 12 && last.right - card.left < card.width * 0.85;
  })()`));
  ok("ダッシュボード：数値は大きく左寄せ", await evaluate(`[...document.querySelectorAll(".nks-kpi-card")].every(c => { const n = c.querySelector(".nks-kpi-num"); return parseFloat(getComputedStyle(n).fontSize) >= 28 && n.getBoundingClientRect().left - c.getBoundingClientRect().left < 20; })`));
  ok("ダッシュボード：応募 14名・内定 4名・入社 2名（旧データ含む表示）", await evaluate(`${num("applied")} === "14" && ${num("offers")} === "4" && ${num("joins")} === "2" && document.querySelector("[data-kpi='joins']").textContent.includes("旧データ 1名含む")`));
  ok("ダッシュボード：終了実績＝不採用＋辞退（グレー系・内訳左詰め）", await evaluate(`(() => {
    const c = document.querySelector("[data-kpi='ended']"), b = c.querySelector(".nks-kpi-breakdown");
    return ${num("ended")} === "2" && JSON.stringify([...b.children].map(x => x.textContent)) === JSON.stringify(["不採用 1名", "辞退 1名"])
      && Math.abs(b.getBoundingClientRect().left - c.querySelector(".nks-kpi-num").getBoundingClientRect().left) <= 1
      && getComputedStyle(c.querySelector(".nks-kpi-num")).color === "rgb(90, 102, 120)";
  })()`));
  ok("ダッシュボード：採用経費 ¥420,000 / 2人、採用単価 ¥210,000（集計値から計算）", await evaluate(`(() => {
    const q = k => document.querySelector("[data-cost='" + k + "']").textContent, yen = s => Number(s.replace(/[^0-9]/g, ""));
    return q("expense") === "¥420,000" && q("joins") === "2" && q("unit") === "¥210,000" && yen(q("unit")) === Math.round(yen(q("expense")) / Number(q("joins")))
      && document.querySelector("[data-kpi='cost']").textContent.includes("※採用単価");
  })()`));
  // 実施未確認は「今期（8/1〜）で基準日（as_of）までに予定日を過ぎた旧データの面接」なので、期待値は実行日の基準日で数える
  //（架空データの面接予定日が過ぎると件数が増えるため、固定値にしない）
  ok("ダッシュボード：実施未確認ありの注意をKPIの近くに表示（ツールチップで詳細）", await evaluate(`(async () => {
    const body = await (await fetch("/api/dashboard/facts", { credentials: "include" })).json();
    const [y, m] = body.as_of.split("-").map(Number), start = (m >= 8 ? y : y - 1) + "-08-01";
    const due = body.facts.filter(f => !f.coop).flatMap(f => (f.unconfirmed || []).filter(i => i.date >= start && i.date <= body.as_of).map(() => f.id));
    const n = [...document.querySelectorAll("[data-kpi='interviewed'] .nks-kpi-note")].find(x => x.textContent === "実施未確認あり");
    return due.length >= 5 && !!n && n.title.includes(due.length + "回（" + new Set(due).size + "人）");
  })()`));
  ok("ダッシュボード：赤は注意情報のみ（KPIの数字は赤にしない）", await evaluate(`[...document.querySelectorAll(".nks-kpi-num, [data-cost] ")].every(n => getComputedStyle(n).color !== "rgb(230, 0, 18)")`));
  ok("ダッシュボード：現在の選考状況は現在値と明示", await evaluate(`document.querySelector(".nks-now h3").textContent.includes("現在値") && document.querySelectorAll(".nks-now-item").length === 6`));
  ok("ダッシュボード：参考情報ブロック（旧データ一覧・長い定義・部長会の旧集計）を通常画面から撤去", await evaluate(`(() => { const t = document.querySelector(".nks-dash").textContent; return !document.querySelector(".nks-ref") && !t.includes("部長会") && !t.includes("期別実績には含めていません") && !t.includes("集計の定義"); })()`));
  ok("ダッシュボード：12か月表示・未到来の月はバーなし", await evaluate(`(() => {
    const cols = [...document.querySelectorAll(".nks-chart-col")], future = cols.filter(c => c.classList.contains("is-future"));
    return cols.length === 12 && future.length === 9 && future.every(c => c.querySelectorAll(".nks-bar").length === 0) && cols.slice(0, 3).every(c => c.querySelectorAll(".nks-bar").length === 4);
  })()`));
  ok("ダッシュボード：月別詳細表は折り畳み・期計は常に表示", await evaluate(`!document.querySelector(".nks-month-detail").open && document.querySelector(".nks-month-detail").getBoundingClientRect().height < 40 && document.querySelector(".nks-period-total").textContent.includes("面談 8回")`));
  await evaluate(`document.querySelector(".nks-month-detail").open = true`);
  await sleep(150);
  ok("ダッシュボード：詳細表は未到来の月が空欄、経過月の0は0と表示", await evaluate(`(() => {
    const rows = [...document.querySelectorAll(".nks-month-table tbody tr")], cells = r => [...r.children].slice(1).map(td => td.textContent);
    const aug = cells(rows[0]), nov = cells(rows[3]);
    return rows.length === 12 && aug[4] === "0" && aug[5] === "1" && nov.every(v => v === "") && rows.slice(3).every(r => cells(r).every(v => v === ""))
      && document.querySelector(".nks-month-table tfoot").textContent.includes("8回");
  })()`));
  await shot("01e-dashboard-54-table");
  await evaluate(`document.querySelector(".nks-month-detail").open = false`);
  ok("ダッシュボード：0件のバーはクリック対象にしない", await evaluate(`[...document.querySelectorAll(".nks-bar.is-clickable")].every(b => Number(b.textContent) > 0) && !document.querySelector(".nks-bar.is-offers[data-month='2026-08']")`));
  ok("ダッシュボード：内定・入社バーの合計がKPIの件数と一致", await evaluate(`(() => { const sum = s => [...document.querySelectorAll(".nks-bar.is-" + s + ".is-clickable")].reduce((a, b) => a + Number(b.textContent), 0); return String(sum("offers")) === ${num("offers")} && String(sum("joins")) === ${num("joins")}; })()`));
  await evaluate(`document.querySelector(".nks-bar.is-offers[data-month='2026-09']").focus(); document.querySelector(".nks-bar.is-offers[data-month='2026-09']").click()`);
  await waitFor(`!!document.querySelector(".nks-pop")`, "offer popover");
  ok("ダッシュボード：内定バー → 対象月・種別と氏名・配属予定部署だけを表示", await evaluate(`(() => {
    const pop = document.querySelector(".nks-pop"), items = [...pop.querySelectorAll("li")];
    const bar = Number(document.querySelector(".nks-bar.is-offers[data-month='2026-09']").textContent);
    const text = items.map(li => li.textContent).join("|");
    return pop.querySelector("#nks-pop-title").textContent === "2026年9月の内定（" + bar + "名）" && items.length === bar
      && items.every(li => li.children.length === 2 && li.children[0].classList.contains("nks-pop-name") && li.children[1].classList.contains("nks-pop-dept"))
      && text.includes("表示確認用・中島") && text.includes("表示確認用・中村") && !/[0-9]{3,}|@|\\//.test(text)
      && pop.getBoundingClientRect().width <= 330 && document.activeElement === pop.querySelector(".nks-pop-close");
  })()`));
  await shot("01g-dashboard-offer-popover");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector(".nks-pop")`, "popover closed by Escape");
  ok("ダッシュボード：Escで閉じ、クリックしたバーへフォーカスが戻る", await evaluate(`document.activeElement === document.querySelector(".nks-bar.is-offers[data-month='2026-09']")`));
  await evaluate(`document.querySelector(".nks-bar.is-joins[data-month='2026-08']").click()`);
  await waitFor(`!!document.querySelector(".nks-pop")`, "join popover");
  ok("ダッシュボード：入社バー（旧データの入社者）・部署未設定は「—」", await evaluate(`(() => { const items = [...document.querySelectorAll(".nks-pop li")]; return document.querySelector("#nks-pop-title").textContent === "2026年8月の入社（1名）" && items.length === 1 && items[0].textContent === "表示確認用・渡辺—"; })()`));
  await evaluate(`document.querySelector(".nks-pop-backdrop").click()`);
  await waitFor(`!document.querySelector(".nks-pop")`, "popover closed by outside click");
  await evaluate(`document.querySelector(".nks-bar.is-offers[data-month='2026-10']").click()`);
  await waitFor(`!!document.querySelector(".nks-pop")`, "offer popover october");
  ok("ダッシュボード：配属予定部署がある場合は部署名を表示", await evaluate(`[...document.querySelectorAll(".nks-pop li")].some(li => li.textContent === "表示確認用・田中設計部")`));
  await evaluate(`document.querySelector(".nks-pop-close").click()`);
  await shot("01c-dashboard-54");
  // 印刷：参考説明・操作ボタン・ダイアログを出さず、5カード／2カードの配置を保つ
  await send("Emulation.setEmulatedMedia", { media: "print" });
  await sleep(200);
  ok("ダッシュボード（A4印刷）：操作ボタン非表示・参考説明なし・カード配置を維持", await evaluate(`(() => {
    const row1 = [...document.querySelectorAll(".nks-kpi-grid > .nks-kpi-card")], hidden = [...document.querySelectorAll(".nks-dash-tools .print-hide")];
    return hidden.length > 0 && hidden.every(b => getComputedStyle(b).display === "none") && new Set(row1.map(c => Math.round(c.getBoundingClientRect().top))).size === 1
      && !document.querySelector(".nks-dash").textContent.includes("部長会");
  })()`));
  await shot("01h-dashboard-print");
  await send("Emulation.setEmulatedMedia", { media: "" });
  await evaluate(`(() => { const s = document.querySelector(".nks-period select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "53"); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await waitFor(`document.querySelector(".nks-dash-title span").textContent.startsWith("53期")`, "period 53");
  ok("ダッシュボード：前期（53期）へ切替（面談 2回・入社 1名・12か月すべて表示・当期へ）", await evaluate(`${num("interviews")} === "2" && ${num("joins")} === "1" && document.querySelectorAll(".nks-chart-col.is-future").length === 0 && !document.querySelector(".nks-period-tag") && [...document.querySelectorAll(".nks-dash-tools button")].some(b => b.textContent === "当期へ")`));
  await evaluate(`document.querySelector(".nks-month-detail").open = true`);
  await sleep(100);
  ok("ダッシュボード：過去の期は12か月すべて実績を表示（0は0）", await evaluate(`[...document.querySelectorAll(".nks-month-table tbody tr")].every(r => [...r.children].slice(1).every(td => td.textContent !== ""))`));
  await evaluate(`document.querySelector(".nks-month-detail").open = false`);
  await shot("01d-dashboard-53");
  await evaluate(`__click("当期へ", document.querySelector(".nks-dash-tools"))`);
  await waitFor(`document.querySelector(".nks-dash-title span").textContent.startsWith("54期")`, "back to current");
  ok("ダッシュボード：当期へ戻る", await evaluate(`${num("interviews")} === "8" && !!document.querySelector(".nks-period-tag")`));
  // スマートフォン幅：カードが自然に折り返し、横スクロールしない
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  ok("ダッシュボード（スマートフォン）：カードが折り返し、横にはみ出さない", await evaluate(`(() => {
    const d = document.querySelector(".nks-dash"), cards = [...document.querySelectorAll(".nks-kpi-card")];
    return d.scrollWidth <= d.clientWidth + 1 && new Set(cards.slice(0, 5).map(c => Math.round(c.getBoundingClientRect().top))).size >= 3
      && cards.every(c => c.getBoundingClientRect().right <= window.innerWidth + 1);
  })()`));
  await shot("01f-dashboard-mobile");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await go("/candidates", `document.querySelectorAll("tbody tr").length >= 8`, "list rows again");

  // 一覧から共通モーダル（鈴木：既存の1次面接予定）
  await evaluate(`__click("更新", [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("表示確認用・鈴木")))`);
  await waitFor(`!!document.querySelector(".nks-sel-modal .nks-timeline")`, "modal");
  ok("一覧の更新は画面移動せずモーダル表示", await evaluate(`location.pathname === "/candidates"`));
  ok("未到達の工程は表示しない（受付＋1次面接予定のみ）", JSON.stringify(await evaluate(`__labels()`)) === JSON.stringify(["受付・応募", "1次面接（予定）"]));
  ok("面接予定の後は完了／辞退／音信不通", JSON.stringify(await evaluate(`[...__modal().querySelectorAll(".nks-sel-action")].map(b => b.textContent)`)) === JSON.stringify(["1次面接（完了）", "辞退", "音信不通"]));
  await evaluate(`__click("1次面接（完了）", __modal())`);
  await waitFor(`!!document.querySelector(".nks-sel-form input[type=date]")`, "add form");
  ok("日付は標準カレンダー input[type=date]", await evaluate(`document.querySelector(".nks-sel-form input[type=date]").type === "date"`));
  ok("面接完了日の初期値は面接予定日", await evaluate(`document.querySelector(".nks-sel-form input[type=date]").value === "2026-10-27"`));
  // 6桁年はブラウザが値を受け付けても、画面側で拒否する
  await evaluate(`__setValue(document.querySelector(".nks-sel-form input[type=date]"), "202610-10-27")`);
  await evaluate(`__click("登録する", document.querySelector(".nks-sel-form"))`);
  await sleep(200);
  ok("6桁年・不正日付は登録しない", await evaluate(`!!document.querySelector(".nks-sel-error") && __labels().length === 2`));
  // 入力中のEscは確認（キャンセルすると閉じない）
  dialogAnswer = false;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  ok("入力中のEscは確認し、取り消すと閉じない", !!(await evaluate(`!!__modal()`)) && dialogs.at(-1)?.includes("入力中の内容は保存されていません"));
  await evaluate(`__setValue(document.querySelector(".nks-sel-form input[type=date]"), "2026-10-27")`);
  await evaluate(`__click("登録する", document.querySelector(".nks-sel-form"))`);
  await waitFor(`__labels().includes("1次面接（完了）")`, "completed");
  await evaluate(`__click("2次面接（予定）", __modal())`);
  await evaluate(`__setValue(document.querySelector(".nks-sel-form input[type=date]"), "2026-11-04")`);
  await evaluate(`__click("登録する", document.querySelector(".nks-sel-form"))`);
  await waitFor(`__labels().includes("2次面接（予定）")`, "stage2");
  await shot("02-list-modal");
  await evaluate(`__click("閉じる", document.querySelector(".nks-sel-footer"))`);
  await waitFor(`!__modal()`, "closed");
  await sleep(300);
  ok("一覧バッジが実際の回数で更新（2次面接予定）", await evaluate(`[...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("表示確認用・鈴木")).textContent.includes("2次面接予定")`));

  // 詳細：内定日欄なし・同じモーダル・入社済みにする・未保存入力の保持
  await go("/candidates/900005?view=detail", `!!document.querySelector(".nks-timeline")`, "detail");
  ok("詳細：内定日の入力欄なし（二重入力廃止）", await evaluate(`!document.querySelector('input[name="offer_date"]')`));
  await evaluate(`__setValue(document.querySelector('input[name="planned_department"]'), "架空の未保存部署")`);
  await evaluate(`__click("選考を更新")`);
  await waitFor(`!!document.querySelector(".nks-sel-modal .nks-timeline")`, "detail modal");
  ok("詳細からも同じ共通モーダル", await evaluate(`!!__modal().querySelector("#nks-sel-title")`));
  await evaluate(`__click("入社済みにする", __modal())`);
  await evaluate(`__click("登録する", document.querySelector(".nks-sel-form"))`);
  await waitFor(`__labels().includes("入社済み")`, "joined");
  ok("入社済みにする前に確認ダイアログ", dialogs.some(d => d.includes("入社済み（進捗：入社）に変更します")));
  // 取消（追記）→ 再度入社済み
  await evaluate(`__click("取消", __modal())`);
  await evaluate(`__setValue([...__modal().querySelectorAll(".nks-sel-form input")].at(-1), "架空の取消理由")`);
  await evaluate(`__click("取消を記録", __modal())`);
  await waitFor(`!__labels().includes("入社済み")`, "voided");
  await evaluate(`(() => { const d = __modal().querySelector(".nks-sel-history"); d.open = true; return true; })()`);
  await sleep(200);
  ok("取消後も変更履歴に入社済み・取消が残る", await evaluate(`(() => { const t = __modal().querySelector(".nks-sel-history").textContent; return t.includes("入社済み") && t.includes("取消：入社済み") && t.includes("架空の取消理由"); })()`));
  await shot("03-detail-modal-history");
  await evaluate(`__click("閉じる", document.querySelector(".nks-sel-footer"))`);
  await sleep(300);
  ok("詳細：未保存の入力が保持される", await evaluate(`document.querySelector('input[name="planned_department"]').value === "架空の未保存部署"`));
  await evaluate(`__click("この内容を保存する")`);
  await sleep(600);
  const saved = await evaluate(`fetch("/api/candidates/900005", { credentials: "include" }).then(r => r.json())`);
  ok("基本情報の保存が成功し、選考状態は変わらない", saved.planned_department === "架空の未保存部署" && String(saved.status) === "5" && saved.offer_date === "2026-10-01");
  ok("紹介料の自動計上の確認は出ない", !dialogs.some(d => d.includes("紹介料")));
  await shot("04-detail");

  // C-04：選考履歴がある応募者の管理種別変更は409で理由を表示し、保存しない
  const hasButton = text => `[...document.querySelectorAll("button")].some(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  await go("/candidates/900005?view=detail", hasButton("➡ 協力業者へ切替"), "detail 900005");
  await evaluate(`__click("➡ 協力業者へ切替")`);
  await evaluate(`__click("この内容を保存する")`);
  await sleep(600);
  const coopBlocked = await evaluate(`fetch("/api/candidates/900005", { credentials: "include" }).then(r => r.json())`);
  ok("履歴あり：種別変更の保存は理由付きで拒否", dialogs.some(d => d.includes("選考履歴があるため、管理種別")));
  ok("履歴あり：種別は個人応募のまま", coopBlocked.is_coop !== true);
  // 履歴なし：協力業者→個人応募へ変更後、再読み込みせずに続けて保存できる（R1-01）
  await go("/candidates/900008?view=detail", hasButton("➡ 個人応募へ切替"), "detail 900008");
  const before = dialogs.length;
  await evaluate(`__click("➡ 個人応募へ切替")`);
  await evaluate(`__click("この内容を保存する")`);
  await sleep(600);
  await evaluate(`__click("この内容を保存する")`);
  await sleep(600);
  const switched = await evaluate(`fetch("/api/candidates/900008", { credentials: "include" }).then(r => r.json())`);
  const after = dialogs.slice(before);
  ok("履歴なし：種別変更後の2回目の保存も成功", after.filter(d => d.includes("データを保存・更新しました")).length === 2 && !after.some(d => d.includes("画面が古い")));
  ok("履歴なし：個人応募へ変更され、選考の更新ボタンが出る", switched.is_coop === false && await evaluate(hasButton("選考を更新")));
  // 再読み込みせずに選考の更新を開き、工程を実際に登録できる
  await evaluate(`__click("選考を更新")`);
  await waitFor(`!!(__modal() && __modal().querySelector(".nks-sel-action"))`, "selection modal after switch");
  await evaluate(`__click("書類選考", __modal())`);
  await waitFor(`!!document.querySelector(".nks-sel-form input[type=date]")`, "date input after switch");
  await evaluate(`__setValue(document.querySelector(".nks-sel-form input[type=date]"), "2026-10-11")`);
  await evaluate(`__click("登録する", document.querySelector(".nks-sel-form"))`);
  await waitFor(`__labels().includes("書類到着")`, "registered after switch");
  const switchedTimeline = await evaluate(`fetch("/api/candidates/900008/selection", { credentials: "include" }).then(r => r.json())`);
  ok("履歴なし：種別変更後、再読み込みせずに選考の更新を保存できる", switchedTimeline.stored === true && switchedTimeline.records.some(x => x.kind === "document_received" && x.event_date === "2026-10-11"));
  await shot("06-coop-switch");
  await evaluate(`__click("閉じる", document.querySelector(".nks-sel-footer"))`);

  // 従来データ（受付のまま1次面接日のみ）：受付のまま予定として表示し、完了日は空欄で確認付き
  await go("/candidates/900010?view=detail", hasButton("選考を更新"), "detail 900010");
  await evaluate(`__click("選考を更新")`);
  await waitFor(`!!(__modal() && __modal().querySelector(".nks-sel-notice"))`, "legacy notice");
  ok("従来データ：実施状況の確認メッセージを表示（警告・停止ではない）", await evaluate(`!__modal().querySelector(".nks-sel-warning") && __modal().querySelector(".nks-sel-notice").textContent.includes("推定していません")`));
  ok("従来データ：タイムラインに1次面接（予定）", JSON.stringify(await evaluate(`__labels()`)) === JSON.stringify(["受付・応募", "1次面接（予定）"]));
  await evaluate(`__click("1次面接（完了）", __modal())`);
  await waitFor(`!!document.querySelector(".nks-sel-form input[type=date]")`, "legacy completion form");
  ok("従来データ：完了日は空欄（面接日から推定しない）", await evaluate(`document.querySelector(".nks-sel-form input[type=date]").value === ""`));
  await shot("07-legacy-received");
  await evaluate(`__click("閉じる", document.querySelector(".nks-sel-footer"))`);
  await sleep(300);

  // 不整合な既存データ：警告と操作停止
  await go("/candidates/900009?view=detail", `!!document.querySelector(".nks-timeline")`, "inconsistent detail");
  await evaluate(`__click("選考を更新")`);
  await waitFor(`!!document.querySelector(".nks-sel-warning")`, "warning");
  ok("不整合データは警告を表示し、工程ボタンを出さない", await evaluate(`__modal().querySelectorAll(".nks-sel-action").length === 0`));
  await shot("05-inconsistent");
} catch (err) {
  console.log("ERROR", err.message);
  steps.push({ name: err.message, value: false });
  try { await shot("99-error"); } catch { /* 画面取得に失敗しても結果は出す */ }
} finally {
  console.log("dialogs:", JSON.stringify(dialogs));
  console.log("problems:", JSON.stringify(problems));
  console.log("screenshots:", out);
  ws.close();
  browser.kill();
  const failed = steps.filter(s => !s.value).length;
  console.log(`${steps.length - failed}/${steps.length} PASS`);
  process.exitCode = failed || problems.length ? 1 : 0;
}
