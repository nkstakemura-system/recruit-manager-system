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
