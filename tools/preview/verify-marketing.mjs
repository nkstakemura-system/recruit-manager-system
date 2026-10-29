// 求人分析（第4弾）のローカル検証。プレビューサーバー（架空データ）をヘッドレスEdge/Chromeで操作する。
// 本番環境には接続しない。CSVは架空のフィクスチャーと、この検証で作る架空の複数求人CSVだけを使う（ファイルは変更しない）。
// 使い方: 別ターミナルで node tools/preview/preview-server.cjs を起動（起動直後の初期データで実行）
//   node tools/preview/verify-marketing.mjs <保存先フォルダ> <URL>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "api-server", "tests", "fixtures", "job-marketing");
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "nks-marketing-check"));
const app = process.argv[3] || "http://127.0.0.1:5188";
const indeedCsv = path.join(fixtures, "EngagementSummary_20260901_20260930_fictional.csv");
const legacyCsv = path.join(fixtures, "求人マーケティング(架空) - 架空CAD.csv");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(app)) throw new Error("ローカルのプレビューサーバーのみ対象です: " + app);
// 架空の複数求人CSV（求人ID・職種名あり。2求人×10日）
const multiCsv = ["日付,求人ID,職種名,表示回数,クリック数,応募開始数,応募数,費用"];
for (let d = 1; d <= 10; d += 1) {
  const date = `2026-08-${String(d).padStart(2, "0")}`;
  multiCsv.push(`${date},J-100,架空CAD補助,${30 + d},${2 + (d % 2)},${d % 4 === 0 ? 1 : 0},${d % 8 === 0 ? 1 : 0},`);
  multiCsv.push(`${date},J-200,架空CAD設計,${20 + d},${1 + (d % 3)},${d % 5 === 0 ? 1 : 0},0,`);
}
const browserPath = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(p => p && fs.existsSync(p));
if (!browserPath) throw new Error("Edge/Chrome が見つかりません。BROWSER_PATH を指定してください");
const port = 9334;
fs.mkdirSync(out, { recursive: true });
// 実行ごとに新しいプロファイル（前回のキャッシュ・セッションを持ち込まない）
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nks-marketing-profile-"));
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
ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") problems.push("exception: " + msg.params.exceptionDetails.exception?.description);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push("console.error: " + msg.params.args.map(a => a.value ?? a.description).join(" "));
  if (msg.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
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
async function shot(name, full = false) {
  let clip;
  if (full) {
    const h = await evaluate(`Math.max(document.querySelector(".jm-page")?.scrollHeight || 0, innerHeight)`);
    const w = await evaluate("innerWidth");
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    clip = true;
  }
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(r.result.data, "base64"));
  if (clip) await send("Emulation.setDeviceMetricsOverride", viewport);
}
async function setFile(selector, file) {
  const { result: { root } } = await send("DOM.getDocument", { depth: -1 });
  const { result: { nodeId } } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await send("DOM.setFileInputFiles", { nodeId, files: [file] });
}
// ドラッグ＆ドロップ（DataTransfer に File を入れて drop イベントを送る）
async function dropFile(name, bytes) {
  await evaluate(`(() => {
    const bin = atob(${JSON.stringify(Buffer.from(bytes).toString("base64"))});
    const data = Uint8Array.from(bin, c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([data], ${JSON.stringify(name)}, { type: "text/csv" }));
    const zone = document.querySelector(".jm-drop");
    zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    window.__overSeen = zone.classList.contains("is-over") || true;
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true; })()`);
}
let viewport = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false };
const steps = [];
const ok = (name, value, detail = "") => { steps.push({ name, value: Boolean(value), detail }); console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
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
    const l = [...scope.querySelectorAll("label")].find(x => x.firstChild && x.firstChild.textContent.trim().replace(/必須$/, "") === label);
    return l && l.querySelector("input,select,textarea");
  };
  window.__selectByText = (select, text) => {
    const o = [...select.options].find(x => x.textContent.startsWith(text));
    if (!o) return false; window.__set(select, o.value); return true;
  };
  window.__click = (text, scope = document) => {
    const el = [...scope.querySelectorAll("button")].find(b => b.textContent.trim() === text && !b.disabled);
    if (!el) return false; el.click(); return true;
  };
  window.__btn = (text, scope = document) => [...scope.querySelectorAll("button")].find(b => b.textContent.trim() === text);
  window.__radio = (text, scope = document) => {
    const l = [...scope.querySelectorAll("label")].find(x => x.textContent.trim() === text && x.querySelector("input[type=radio]"));
    if (!l) return false; l.querySelector("input").click(); return true;
  };
  window.__tab = name => { const t = [...document.querySelectorAll(".jm-tab")].find(b => b.firstChild.textContent === name); t.click(); return true; };
  window.__card = title => [...document.querySelectorAll(".jm-card")].find(c => (c.querySelector("h3,summary")?.textContent || "").startsWith(title));
  window.__text = (scope = document.body) => scope.innerText;
  window.__status = () => (document.querySelector(".jm-check-status") || {}).innerText || "";
  true`;

try {
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await send("Page.navigate", { url: app + "/" });
  await waitFor("document.readyState === 'complete'", "load");
  await evaluate(`fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "preview", password: "preview-only" }) }).then(r => r.status)`);
  await send("Page.navigate", { url: app + "/job-marketing" });
  await waitFor("!!document.querySelector('.jm-kpis')", "job marketing page");
  await evaluate(helpers);

  // 1. 画面構成（上から：操作 → KPI → 率 → 無料／有料 → 月別推移 → 自動分析 → 折り畳み）
  ok("サイドバーに「求人分析」がある", await evaluate(`!!document.querySelector('nav a[href="/job-marketing"]')`));
  ok("既存メニューは維持", await evaluate(`["/", "/candidates", "/expenses", "/stats", "/register"].every(h => document.querySelector('nav a[href="' + h + '"]'))`));
  ok("上部に対象月・職種・CSV取込・実績登録", await evaluate(`!!__q(".jm-bar .jm-month select") && __qa(".jm-tab").length === 4 && !!__btn("CSV取込") && !!__btn("実績を登録")`));
  const order = await evaluate(`(() => { const els = [".jm-bar", ".jm-kpis", ".jm-rates"].map(s => __q(s)).concat([__card("無料／有料掲載の比較"), __q(".jm-month-card")]).concat(["自動分析コメント", "掲載状態の履歴", "改善履歴", "参考求人"].map(t => __card(t)));
    return els.every(Boolean) && els.every((e, i) => i === 0 || (els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)); })()`);
  ok("並び順：操作→KPI→率→無料／有料→月別推移→自動分析→履歴・参考求人", order);
  ok("履歴・参考求人は初期状態で折り畳み", await evaluate(`["掲載状態の履歴", "改善履歴", "参考求人"].every(t => !__card(t).open)`));
  const fonts = await evaluate(`(() => { const px = el => parseFloat(getComputedStyle(el).fontSize);
    return { kpi: px(__q(".jm-kpi-value")), label: px(__q(".jm-kpi-label")), page: px(__q(".jm-page")), comment: px(__q(".jm-analysis li p")), min: Math.min(...__qa(".jm-page *").filter(e => e.offsetParent && e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(px)) }; })()`);
  ok("文字サイズ：本文14px・KPI数値は大きく（28px以上）", fonts.page >= 14 && fonts.kpi >= 28 && fonts.label >= 13 && fonts.comment >= 14, JSON.stringify(fonts));
  ok("見出しは「自動分析コメント」で、AIと表示しない", await evaluate(`__text().includes("自動分析コメント") && !/AIが|AIによる|AI分析/.test(__text())`));

  // 2. 営業（10月）：10/14に無料→有料。日別データは切替日で正確に分ける
  ok("営業：掲載状態は有料掲載（10/14〜）", await evaluate(`__q(".jm-plan-row").innerText.includes("有料掲載") && __q(".jm-plan-row").innerText.includes("2026/10/14〜")`));
  const vs = await evaluate(`__qa(".jm-vs-card").map(c => c.innerText.replace(/\\s+/g, " "))`);
  ok("無料／有料の左右2カード", vs.length === 2 && vs[0].startsWith("無料掲載") && vs[1].startsWith("有料掲載"), vs.map(v => v.slice(0, 60)).join(" | "));
  ok("日別CSVは切替日で分割（無料は10/13まで、有料は10/14から）", vs[0].includes("2026/10/13") && vs[1].includes("2026/10/14〜2026/10/26") && vs[1].includes("13日分"));
  ok("1日平均と率を併記（期間の日数が違っても合計だけで比べない）", vs.every(v => v.includes("1日平均") && v.includes("CTR") && v.includes("応募率")));
  ok("有料カードに掲載費用・予算・応募単価", vs[1].includes("¥13,000") && vs[1].includes("予算 ¥30,000") && vs[1].includes("応募単価"));
  ok("比較できるときは「比較データ不足」を出さない", await evaluate(`!__card("無料／有料掲載の比較").innerText.includes("比較データ不足")`));
  const top = await evaluate(`__qa(".jm-analysis > ul > li").map(li => li.querySelector("strong").innerText)`);
  ok("自動分析コメントは最大3件を初期表示", top.length <= 3 && top.length > 0, top.join(" / "));
  // 月別推移：初期は選択月の実績を1行で表示し、グラフは展開時のみ
  ok("月別推移：初期は選択月の実績を1行で表示（グラフは閉じている）", await evaluate(`__q(".jm-month-sum").innerText.replace(/\\s+/g, " ").includes("2026年10月の実績 表示 2,035回 クリック 115回 応募開始 7件 応募 3件") && !__q(".jm-chart")`), await evaluate(`__q(".jm-month-sum").innerText.replace(/\\s+/g, " ")`));
  await evaluate(`__click("月別グラフを見る ▼")`);
  await waitFor(`!!__q(".jm-chart")`, "chart open");
  const chart = await evaluate(`__qa(".jm-chart-col").map(c => [c.querySelector(".jm-chart-month").innerText, c.querySelector(".jm-chart-value").innerText, c.className.includes("is-future")])`);
  ok("月別グラフ：実績の件数ラベル（7〜10月）", JSON.stringify(chart.filter(c => ["7月", "8月", "9月", "10月"].includes(c[0])).map(c => c[1])) === JSON.stringify(["820", "760", "1,412", "2,035"]), JSON.stringify(chart));
  ok("月別グラフ：記録の無い月は「未登録」（0件と区別）", chart.filter(c => ["2月", "3月", "4月", "5月", "6月"].includes(c[0])).every(c => c[1] === "未登録"));
  ok("月別グラフ：未到来の月（11・12月）は空欄", chart.filter(c => c[2]).map(c => c[0]).join() === "11月,12月" && chart.filter(c => c[2]).every(c => c[1] === ""));
  await evaluate(`__radio("クリック率（CTR）", __q(".jm-chart-wrap"))`);
  ok("月別グラフ：クリック率（CTR）に切り替え", await evaluate(`__qa(".jm-chart-col .jm-chart-value").some(v => /%$/.test(v.innerText))`));
  await evaluate(`__radio("表示回数", __q(".jm-chart-wrap"))`);
  await evaluate(`__qa(".jm-chart-col").find(c => c.innerText.startsWith("9月")).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))`);
  await waitFor(`!!__q(".jm-chart-tip")`, "chart tooltip");
  ok("月別グラフ：カーソルで月・数値を表示", await evaluate(`__q(".jm-chart-tip").innerText.startsWith("2026年9月：表示回数 1,412回")`), await evaluate(`__q(".jm-chart-tip").innerText`));
  await shot("01b-monthly-chart");
  await evaluate(`__click("月別グラフを閉じる ▲")`);
  ok("月別グラフを折り畳む", await evaluate(`!__q(".jm-chart")`));
  ok("有料切替後の変化を指摘（断定しない）", top.includes("有料切替後の反応に変化があります") && await evaluate(`__text().includes("断定できません")`));
  ok("目安の数値は折り畳み・暫定扱い", await evaluate(`(() => { const d = __q(".jm-analysis details"); return !d.open && d.innerText.includes("判定の目安") && d.textContent.includes("業界平均やIndeedの基準ではありません"); })()`));
  await shot("01-sales-oct", true);

  // 3. 電気工事士9月：月間合計しかない月の途中切替は「内訳不明」（按分しない）
  await evaluate(`__tab("電気工事士")`);
  await evaluate(`__set(__q(".jm-month select"), "2026-09")`);
  await waitFor(`__card("無料／有料掲載の比較").innerText.includes("内訳不明")`, "split unknown");
  const elec = await evaluate(`__card("無料／有料掲載の比較").innerText.replace(/\\s+/g, " ")`);
  ok("月間合計しかない9月は「掲載方法別の内訳不明」", elec.includes("掲載方法別の内訳不明：2026/9/1〜2026/9/30"));
  ok("内訳不明の9月を無料にも有料にも計上しない", /無料掲載.*2026\/8\/1〜2026\/8\/31/.test(elec) && !/無料掲載[^有]*9\/30/.test(elec));
  ok("月の途中の切替は月次でも明示", await evaluate(`__q(".jm-plan-row").innerText.includes("月の途中で掲載方法を変更")`));
  await shot("02-electric-sep-split-unknown", true);

  // 4. 掲載状態：無料→有料→無料（CADオペ（本社））
  await evaluate(`__tab("CADオペ（本社）")`);
  await evaluate(`__set(__q(".jm-month select"), "2026-10")`);
  await waitFor(`__q(".jm-plan-row").innerText.includes("未設定")`, "cad status none");
  ok("実績が無い月はCSV取込・実績登録のボタンを表示", await evaluate(`!!__q(".jm-empty") && !!__btn("CSV取込", __q(".jm-empty"))`));
  const plan = async (status, date, extra = {}) => {
    await evaluate(`__click(${JSON.stringify(status === "free" && extra.first ? "掲載状態を変更" : status === "paid" ? "有料掲載に切替" : "掲載状態を変更")}, __q(".jm-plan-row"))`);
    await waitFor(`!!__modal()`, "plan modal");
    await evaluate(`__radio(${JSON.stringify({ free: "無料掲載", paid: "有料掲載" }[status])}, __modal())`);
    if (extra.emptyDateCheck) {
      await evaluate(`__click("確認へ", __modal())`);
      ok("有料掲載開始日は必須", await evaluate(`__q(".jm-error", __modal()).innerText.includes("有料掲載開始日を入力してください")`));
      ok("開始日は標準の type=date（西暦4桁・本日まで。予定日は登録しない）", await evaluate(`(() => { const i = __modal().querySelector("input[type=date]"); return i.min === "1000-01-01" && i.max === new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()); })()`));
    }
    await evaluate(`__set(__modal().querySelector("input[type=date]"), ${JSON.stringify(date)})`);
    if (extra.budget) await evaluate(`__set(__field("掲載予算・費用（円）", __modal()), ${JSON.stringify(extra.budget)})`);
    if (extra.note) await evaluate(`__set(__modal().querySelector("textarea"), ${JSON.stringify(extra.note)})`);
    if (extra.shotInput) await shot(extra.shotInput);
    await evaluate(`__click("確認へ", __modal())`);
    await waitFor(`!!__q(".jm-confirm", __modal())`, "confirm");
    if (extra.shotConfirm) {
      ok("確認画面：開始日・予算・メモと「過去の実績は残る」", await evaluate(`__modal().innerText.includes("2026/9/14 から") && __modal().innerText.includes("¥20,000") && __modal().innerText.includes("より前の実績・掲載履歴はそのまま残ります")`));
      await shot(extra.shotConfirm);
    }
    await evaluate(`__click("この内容で登録", __modal())`);
    await waitFor(`!__modal() && __text().includes("掲載状態を変更しました")`, "plan saved");
  };
  await plan("free", "2026-08-01", { first: true });
  await plan("paid", "2026-09-14", { emptyDateCheck: true, budget: "20000", note: "架空：有料掲載を開始", shotInput: "03-plan-dialog", shotConfirm: "04-plan-confirm" });
  ok("無料→有料：掲載状態が有料掲載に", await evaluate(`__q(".jm-plan-row").innerText.includes("有料掲載") && __q(".jm-plan-row").innerText.includes("予算 ¥20,000")`));
  await plan("free", "2026-10-10", {});
  await evaluate(`__card("掲載状態の履歴").open = true`);
  const hist = await evaluate(`__qa(".jm-plan-hist li").map(li => li.innerText.replace(/\\s+/g, " "))`);
  ok("有料→無料：変更日つきで全履歴を保持", hist.length === 3 && hist[0].includes("2026/10/10〜") && hist[1].includes("2026/9/14〜") && hist[2].includes("2026/8/1〜"), hist.join(" | "));
  await shot("05-plan-history", true);

  // 5. CSVドラッグ＆ドロップ（職種は必須・ファイル名から自動確定しない）
  await evaluate(`__click("CSV取込")`);
  await waitFor(`!!__q(".jm-drop")`, "drop zone");
  ok("ドロップ領域とファイル選択ボタン", await evaluate(`__q(".jm-drop").innerText.includes("ドラッグ＆ドロップ") && !!__btn("ファイルを選択", __modal())`));
  await shot("06-csv-drop-zone");
  await dropFile("renamed-without-period.csv", fs.readFileSync(indeedCsv));
  await waitFor(`__modal().innerText.includes("Indeed形式")`, "dropped indeed");
  ok("ドロップしたCSVを中身で判定（ファイル名に期間・形式の情報なし）", await evaluate(`__q(".jm-filebar").innerText.includes("Indeed形式") && __q(".jm-filebar").innerText.includes("UTF-8")`));
  ok("取込前の内容プレビュー", await evaluate(`__qa(".jm-table.is-raw tbody tr", __modal()).length >= 5`));
  ok("取込先の職種は空欄から選ぶ（必須）", await evaluate(`__q(".jm-import-card select", __modal()).value === "" && __status().includes("取込先の職種を選択してください") && __btn("取り込む", __modal()).disabled`));
  ok("集計期間は実データから表示して確認", await evaluate(`__field("集計開始日", __modal()).value === "2026-09-02" && __field("集計終了日", __modal()).value === "2026-09-25"`), await evaluate(`__field("集計開始日", __modal()).value + "〜" + __field("集計終了日", __modal()).value`));
  ok("未収集日は0件扱いせず表示", await evaluate(`__q(".jm-import-card .jm-chip.is-warn", __modal()).innerText.includes("未収集")`));
  await shot("07-csv-preview");
  await evaluate(`__selectByText(__q(".jm-import-card select", __modal()), "CADオペ（本社）")`);
  await waitFor(`__modal().innerText.includes("日別に分けて集計")`, "history split");
  ok("掲載状態の履歴で切替日前後を日別に分ける表示", await evaluate(`__modal().innerText.includes("無料／") || __modal().innerText.includes("有料")`), await evaluate(`(__q(".jm-sub.is-info", __modal()) || {}).innerText`));
  await waitFor(`__status().includes("重複なし")`, "dry run ok");
  ok("重複がなければ取り込める", await evaluate(`!__btn("取り込む", __modal()).disabled`));
  await shot("08-csv-ready");
  await evaluate(`__click("取り込む", __modal())`);
  await waitFor(`!__modal() && __text().includes("CSVを取り込みました")`, "imported");
  await evaluate(`__set(__q(".jm-month select"), "2026-09")`);
  await waitFor(`__qa(".jm-kpi-value")[0].innerText === "2,300"`, "kpi after import");
  const cad = await evaluate(`__qa(".jm-vs-card").map(c => c.innerText.replace(/\\s+/g, " "))`);
  ok("取込後：9/14の切替日で無料・有料に分割", cad[0].includes("2026/9/13") && cad[1].includes("2026/9/14"), cad.map(c => c.slice(0, 70)).join(" | "));
  const sums = await evaluate(`(() => { const n = c => Number((c.innerText.match(/表示回数\\s*([\\d,]+)/) || [])[1]?.replace(/,/g, "")); const [a, b] = __qa(".jm-vs-card"); return [n(a), n(b)]; })()`);
  ok("無料＋有料＝CSVの合計（二重計上なし）", sums[0] + sums[1] === 2300, sums.join(" + "));
  await shot("09-cad-after-import", true);

  // 同じCSVをもう一度（別の職種へも不可）
  await evaluate(`__click("CSV取込")`);
  await waitFor(`!!__q(".jm-drop")`, "drop zone 2");
  await dropFile("same-file-again.csv", fs.readFileSync(indeedCsv));
  await waitFor(`__modal().innerText.includes("Indeed形式")`, "dropped 2");
  await evaluate(`__selectByText(__q(".jm-import-card select", __modal()), "CADオペ（ときがわ）")`);
  await evaluate(`__radio("不明", __q(".jm-import-card", __modal()))`);
  await waitFor(`__modal().innerText.includes("このCSVは登録済みです")`, "duplicate file");
  ok("同じCSVの二重登録を防止（取り込むボタンは無効）", await evaluate(`__btn("取り込む", __modal()).disabled`));
  await evaluate(`__click("別のファイル", __modal())`);

  // 複数求人を含むCSV：求人ごとに取込先を選ぶ（曖昧なまま1職種へ登録しない）
  await waitFor(`!!__q(".jm-drop")`, "drop zone 3");
  await dropFile("multi-job.csv", Buffer.from(multiCsv.join("\r\n"), "utf8"));
  await waitFor(`__qa(".jm-import-card", __modal()).length === 2`, "multi groups");
  ok("複数求人のCSVは求人ごとに分割して表示", await evaluate(`__modal().innerText.includes("2件の求人が含まれます") && __modal().innerText.includes("J-100") && __modal().innerText.includes("J-200")`));
  ok("CSVの職種名は候補表示のみ（自動では選ばない）", await evaluate(`__qa(".jm-import-card select", __modal()).every(s => s.value === "")`));
  const [c1, c2] = [0, 1];
  await evaluate(`__selectByText(__qa(".jm-import-card select", __modal())[${c1}], "CADオペ（ときがわ）")`);
  await evaluate(`__radio("無料", __qa(".jm-import-card", __modal())[${c1}])`);
  await sleep(300);
  ok("1件でも取込先が未選択なら取り込めない", await evaluate(`__status().includes("取込先の職種を選択してください") && __btn("取り込む", __modal()).disabled`));
  await evaluate(`__selectByText(__qa(".jm-import-card select", __modal())[${c2}], "CADオペ（ときがわ）")`);
  await evaluate(`__radio("無料", __qa(".jm-import-card", __modal())[${c2}])`);
  await waitFor(`__status().includes("重複なし")`, "multi ok");
  ok("同じ職種の別の求人（求人ID）は同じ期間でも重複にならない", true);
  await shot("10-csv-multi-job");
  await evaluate(`__click("取り込む", __modal())`);
  await waitFor(`!__modal() && __text().includes("実績 2件")`, "multi imported");

  // 旧管理CSV（ファイル選択ボタン。年・「応募」の意味・掲載種別は利用者が確認）
  await evaluate(`__click("CSV取込")`);
  await waitFor(`!!__q(".jm-drop")`, "drop zone 4");
  await setFile(".jm-modal input[type=file]", legacyCsv);
  await waitFor(`!!__q(".jm-filebar") && __q(".jm-filebar").innerText.includes("旧管理表")`, "legacy parsed");
  ok("旧管理CSV：年・「応募」の意味を必須で確認", await evaluate(`!!__field("年（全列）", __modal()) && __modal().innerText.includes("「応募」の意味")`));
  ok("旧管理CSV：期間の重なりを警告", await evaluate(`__modal().innerText.includes("期間が重なっています")`));
  await evaluate(`(() => { const m = __modal(); __selectByText(__field("取込先の職種", m), "営業"); __set(__field("年（全列）", m), "2026");
    __radio("不明", m.querySelector(".jm-seg")); __qa(".jm-import-card", m).forEach(c => __radio("不明", c)); return true; })()`);
  await waitFor(`__qa(".jm-conflict", __modal()).length > 0`, "legacy conflicts");
  ok("既存の実績・別の列と期間が重なる列は理由なしでは登録しない", await evaluate(`__btn("取り込む", __modal()).disabled`), `${await evaluate(`__qa(".jm-conflict", __modal()).length`)}件`);
  await shot("11-legacy-conflicts");
  await evaluate(`__q(".jm-close").click()`);

  // 6. 手入力：同じ期間の二重登録の防止
  await evaluate(`__tab("電気工事士")`);
  await evaluate(`__click("実績を登録")`);
  await waitFor(`!!__modal()`, "record form");
  await evaluate(`(() => { const m = __modal(); __selectByText(__field("職種", m), "電気工事士");
    __set(__field("開始日", m), "2026-10-01"); __set(__field("終了日", m), "2026-10-26"); __radio("有料", m); __set(__field("表示回数", m), "600"); return true; })()`);
  ok("入力中に率を自動計算・空欄は未取得", await evaluate(`__modal().innerText.includes("クリック率（CTR） —")`));
  await evaluate(`__click("登録", __modal())`);
  await waitFor(`!!__q(".jm-conflict", __modal())`, "conflict shown");
  ok("同じ期間の二重登録を防止（置き換えの選択）", await evaluate(`__q(".jm-conflict", __modal()).innerText.includes("同じ期間の記録が既にあります")`));
  await shot("12-duplicate-period");
  await evaluate(`__q(".jm-close").click()`);

  // 7. 職種の管理：1職種1行（職種名・状態・編集）、ボタンは折り返さない
  await evaluate(`__click("職種の管理")`);
  await waitFor(`!!__q(".jm-cat-list")`, "category modal");
  ok("1職種1行（左：職種名、中央：状態、右：編集）", await evaluate(`__qa(".jm-cat-row").every(r => r.children.length === 3 && r.children[0].classList.contains("jm-cat-name") && r.children[1].classList.contains("jm-state") && r.children[2].textContent === "編集")`));
  await evaluate(`__click("編集", __qa(".jm-cat-row").find(r => r.innerText.startsWith("電気工事士")))`);
  ok("編集の中で名称変更・募集停止", await evaluate(`!!__btn("名称を保存", __modal()) && !!__btn("募集停止にする", __modal())`));
  ok("ボタンの文字が折り返さない", await evaluate(`__qa("button", __modal()).every(b => b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().height <= 42)`));
  ok("職種追加は下部の独立した入力行", await evaluate(`!!__q(".jm-cat-add input") && __q(".jm-cat-list").compareDocumentPosition(__q(".jm-cat-add")) & Node.DOCUMENT_POSITION_FOLLOWING`));
  await shot("13-category-manager");
  await evaluate(`__click("募集停止にする", __modal())`);
  await waitFor(`__qa(".jm-cat-row").find(r => r.innerText.startsWith("電気工事士")).innerText.includes("停止中")`, "paused");
  ok("募集停止：職種は停止中・掲載状態も募集停止", await evaluate(`__qa(".jm-tab").find(t => t.innerText.startsWith("電気工事士")).innerText.includes("停止")`));
  await evaluate(`__click("編集", __qa(".jm-cat-row").find(r => r.innerText.startsWith("電気工事士")))`);
  await evaluate(`__click("募集を再開する", __modal())`);
  await waitFor(`__qa(".jm-cat-row").find(r => r.innerText.startsWith("電気工事士")).innerText.includes("募集中")`, "resumed");
  await evaluate(`__q(".jm-close").click()`);
  await evaluate(`__set(__q(".jm-month select"), "2026-08")`);
  ok("停止・再開しても過去の実績は残る", await evaluate(`__qa(".jm-kpi-value")[0].innerText === "240"`));

  // 8. 参考求人：javascript: は拒否、https は登録
  await evaluate(`__card("参考求人").open = true`);
  await evaluate(`__click("参考求人を追加")`);
  await waitFor(`!!__modal()`, "ref modal");
  await evaluate(`(() => { const m = __modal(); __set(__field("会社名", m), "架空検証株式会社"); __set(__field("URL（http/https）", m), "javascript:alert(1)"); return true; })()`);
  await evaluate(`__click("保存", __modal())`);
  await waitFor(`!!__q(".jm-error", __modal())`, "ref url error");
  ok("参考求人URL：http/https 以外は拒否", await evaluate(`__q(".jm-error", __modal()).innerText.includes("http")`));
  await evaluate(`__set(__field("URL（http/https）", __modal()), "https://example.com/verify")`);
  await evaluate(`__click("保存", __modal())`);
  await waitFor(`!__modal() && __text().includes("架空検証株式会社")`, "ref saved");
  await evaluate(`__card("参考求人").open = true`);
  ok("参考求人のリンクは別タブ・noopener", await evaluate(`__qa(".jm-ref-url").some(a => a.href === "https://example.com/verify" && a.target === "_blank" && a.rel.includes("noopener") && a.rel.includes("noreferrer"))`));

  // 9. サマリーのコピー（個人情報なし）
  await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: app }).catch(() => null);
  await evaluate(`__tab("営業")`);
  await evaluate(`__set(__q(".jm-month select"), "2026-10")`);
  await evaluate(`__click("サマリーをコピー")`);
  await sleep(400);
  const copied = await evaluate(`navigator.clipboard.readText().catch(() => (document.querySelector(".jm-modal textarea") || {}).value || "")`);
  ok("サマリーをコピー（無料／有料の比較を含む）", copied.includes("求人マーケティング月次サマリー") && copied.includes("有料掲載：13日"), copied.split("\n")[0]);
  if (await evaluate(`!!__modal()`)) await evaluate(`__q(".jm-close").click()`);

  // 10. スマートフォン幅
  viewport = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await sleep(500);
  ok("390px幅で横にはみ出さない", await evaluate(`document.querySelector(".jm-page").scrollWidth <= document.querySelector(".jm-page").clientWidth + 1`));
  ok("390px幅：KPIは2列・比較カードは縦並び", await evaluate(`(() => { const k = __qa(".jm-kpi"); const v = __qa(".jm-vs-card"); return k[0].getBoundingClientRect().top === k[1].getBoundingClientRect().top && k[2].getBoundingClientRect().top > k[0].getBoundingClientRect().top && v[1].getBoundingClientRect().top > v[0].getBoundingClientRect().top; })()`));
  await shot("14-mobile-top");
  await shot("15-mobile-full", true);
  await evaluate(`__click("職種の管理")`);
  await waitFor(`!!__q(".jm-cat-list")`, "category modal mobile");
  ok("390px幅：職種の管理のボタンが折り返さない", await evaluate(`__qa("button", __modal()).every(b => b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().height <= 42)`));
  await shot("16-mobile-category");
  await evaluate(`__q(".jm-close").click()`);
  await evaluate(`__click("CSV取込")`);
  await waitFor(`!!__q(".jm-drop")`, "drop mobile");
  await dropFile("mobile.csv", Buffer.from(multiCsv.join("\r\n"), "utf8"));
  await waitFor(`__qa(".jm-import-card", __modal()).length === 2`, "multi mobile");
  ok("390px幅：CSV取込画面が横にはみ出さない", await evaluate(`__q(".jm-modal").scrollWidth <= __q(".jm-modal").clientWidth + 1`));
  await shot("17-mobile-csv");
  await evaluate(`__q(".jm-close").click()`);

  // 11. 既存画面の回帰（応募者一覧・ダッシュボード）
  viewport = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false };
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await evaluate(`document.querySelector('nav a[href="/candidates"]').click()`);
  await waitFor(`document.body.innerText.includes("応募者一覧") && document.querySelectorAll("tbody tr").length > 0`, "candidates");
  ok("既存：応募者一覧を表示", true, `${await evaluate(`document.querySelectorAll("tbody tr").length`)}行`);
  await shot("18-candidates-regression");
  await evaluate(`document.querySelector('nav a[href="/"]').click()`);
  await sleep(800);
  ok("既存：ダッシュボードを表示", await evaluate(`!document.querySelector(".jm-page") && document.body.innerText.length > 200`));
  await shot("19-dashboard-regression");

  ok("ブラウザのエラーなし", problems.length === 0, problems.join(" | "));
} catch (err) {
  ok("検証の実行", false, [err.message, ...problems].join(" | "));
  await shot("zz-error").catch(() => null);
} finally {
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ app, steps, problems }, null, 2));
  // ブラウザを終了してから、この実行用のプロファイルを削除する（子プロセスを残さない）
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
