// ローカルプレビュー（架空データ）で、連絡先の編集と和暦入力を画面から確認する。本番環境には接続しない。
// 使い方: 別ターミナルで node tools/preview/preview-server.cjs を起動（起動直後の初期データで実行）
//         node tools/preview/verify-contact-wareki.mjs <スクリーンショット保存先フォルダ> [http://127.0.0.1:5188]
// ブラウザは終了時に DevTools の Browser.close で閉じ、専用プロファイルを削除する（プロセスを残さない）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "nks-contact-wareki-check"));
const app = process.argv[3] || "http://127.0.0.1:5188";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(app)) throw new Error("ローカルのプレビューサーバーのみ対象です: " + app);
const browserPath = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(p => p && fs.existsSync(p));
if (!browserPath) throw new Error("Edge/Chrome が見つかりません。BROWSER_PATH を指定してください");
const port = 9341;
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nks-contact-wareki-profile-"));
const browser = spawn(browserPath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-extensions", "--disable-sync", "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
const browserExited = new Promise(r => browser.once("exit", r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i += 1) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page"); } catch { await sleep(200); }
}
const browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
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
  if (msg.method === "Page.javascriptDialogOpening") {
    dialogs.push(`${msg.params.type}: ${msg.params.message}`);
    send("Page.handleJavaScriptDialog", { accept: true });
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
const ok = (name, value, detail) => { steps.push({ name, value }); console.log(`${value ? "PASS" : "FAIL"} ${name}${!value && detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); };
const helpers = `
  window.__setValue = (el, value) => {
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  };
  window.__blur = el => el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  window.__click = (text, scope = document) => {
    const el = [...scope.querySelectorAll("button")].find(b => b.textContent.trim() === text && !b.disabled);
    if (!el) return false; el.click(); return true;
  };
  window.__modal = () => document.querySelector(".nks-contact-modal");
  window.__api = async (url, method = "GET", body) => {
    const r = await fetch(url, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  window.__row = name => [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes(name));
  window.__byLabel = label => document.querySelector('[aria-label="' + label + '"]');
  true`;
const go = async (url, ready, label) => {
  await send("Page.navigate", { url: app + url });
  await waitFor(ready, label);
  await evaluate(helpers);
  await sleep(250);
};
const api = (url, method, body) => evaluate(`__api(${JSON.stringify(url)}, ${JSON.stringify(method || "GET")}, ${JSON.stringify(body)})`);
const contactsOf = c => ({ tel: c.tel, email: c.email, primary_contact: c.primary_contact ?? null });
const withoutContacts = c => { const { tel, email, primary_contact, ...rest } = c; return JSON.stringify(rest); };
const setByLabel = (label, value) => evaluate(`__setValue(__byLabel(${JSON.stringify(label)}), ${JSON.stringify(value)})`);

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go("/", `!!document.querySelector(".nks-auth-card")`, "login form");
  await evaluate(`(() => { const [u, p] = document.querySelectorAll(".nks-auth-card input"); __setValue(u, "preview"); __setValue(p, "preview-only"); document.querySelector(".nks-auth-submit").click(); return true; })()`);
  await waitFor(`!document.querySelector(".nks-auth-card")`, "logged in");

  // ---------- 一覧：編集ボタン・代表連絡先 ----------
  await go("/candidates", `document.querySelectorAll("tbody tr").length >= 8`, "list rows");
  ok("一覧：全行の連絡先欄に「編集」（登録の有無に関係なく。＋ボタンなし）", await evaluate(`[...document.querySelectorAll("tbody tr")].every(r => [...r.children[4].querySelectorAll("button")].map(b => b.textContent.trim()).join() === "編集") && !document.querySelector("tbody").textContent.includes("＋")`));
  ok("一覧：代表連絡先（Email の2件目）を表示し、他の件数を添える", await evaluate(`(() => { const c = __row("表示確認用・高橋").children[4].textContent; return c.includes("メール") && c.includes("preview4b@example.invalid") && !c.includes("preview4a") && c.includes("他2件"); })()`));
  ok("一覧：未登録は「-」", await evaluate(`__row("表示確認用・佐藤").children[4].textContent.startsWith("-")`));
  await shot("01-list");

  // ---------- 空欄からの追加（代表は Email） ----------
  const satoBefore = (await api("/api/candidates/900002")).data;
  await evaluate(`__row("表示確認用・佐藤").children[4].querySelector("button").click()`);
  await waitFor(`!!(__modal() && __byLabel("TEL1"))`, "contact modal");
  ok("モーダル：空欄の TEL・Email 欄を1行ずつ表示", await evaluate(`__byLabel("TEL1").value === "" && __byLabel("Email1").value === "" && !__byLabel("TEL2")`));
  ok("モーダル：変更前は保存できない", await evaluate(`[...__modal().querySelectorAll("button")].find(b => b.textContent === "保存").disabled`));
  await setByLabel("TEL1", "０９００００００００２");
  await evaluate(`__blur(__byLabel("TEL1"))`);
  await sleep(100);
  ok("モーダル：TEL は半角・ハイフン付きに整形", await evaluate(`__byLabel("TEL1").value === "090-0000-0002"`));
  ok("モーダル：片方だけ入力した時点でその連絡先が代表", await evaluate(`__byLabel("TEL1").closest(".nks-contact-row").querySelector("input[type=radio]").checked`));
  await setByLabel("Email1", "sato@example.invalid");
  await evaluate(`__byLabel("Email1").closest(".nks-contact-row").querySelector("input[type=radio]").click()`);
  await shot("02-contact-modal-new");
  await evaluate(`__click("保存", __modal())`);
  await waitFor(`!__modal()`, "modal closed");
  await waitFor(`__row("表示確認用・佐藤").children[4].textContent.includes("sato@example.invalid")`, "list refreshed");
  const satoAfter = (await api("/api/candidates/900002")).data;
  ok("保存：TEL・Email・代表（Email）を保存", JSON.stringify(contactsOf(satoAfter)) === JSON.stringify({ tel: ["090-0000-0002"], email: ["sato@example.invalid"], primary_contact: "email_0" }), contactsOf(satoAfter));  ok("保存：連絡先以外の項目（選考ステータス・連絡履歴など）は変更なし", withoutContacts(satoAfter) === withoutContacts(satoBefore));
  ok("保存：一覧に代表（メール）と他1件を表示", await evaluate(`(() => { const c = __row("表示確認用・佐藤").children[4].textContent; return c.includes("メール") && c.includes("他1件"); })()`));

  // ---------- 既存の編集・代表の削除 ----------
  await evaluate(`__row("表示確認用・高橋").children[4].querySelector("button").click()`);
  await waitFor(`!!(__modal() && __byLabel("Email2"))`, "existing contacts");
  ok("モーダル：既存の連絡先（TEL1件・Email2件）と代表（Email2）を表示", await evaluate(`__byLabel("TEL1").value === "000-0000-0004" && __byLabel("Email1").value === "preview4a@example.invalid" && __byLabel("Email2").value === "preview4b@example.invalid" && __byLabel("Email2").closest(".nks-contact-row").querySelector("input[type=radio]").checked`));
  await evaluate(`__click("TELを追加", __modal())`);
  await setByLabel("TEL2", "03-0000-0044");
  await evaluate(`__byLabel("Email2を削除").click()`);
  await sleep(100);
  ok("モーダル：代表を削除すると、登録済みの TEL が代表になる", await evaluate(`!__byLabel("Email2") && __byLabel("TEL1").closest(".nks-contact-row").querySelector("input[type=radio]").checked`));
  await evaluate(`__byLabel("TEL2").closest(".nks-contact-row").querySelector("input[type=radio]").click()`);
  await evaluate(`__click("保存", __modal())`);
  await waitFor(`!__modal()`, "modal closed 2");
  const takahashi = (await api("/api/candidates/900004")).data;
  ok("保存：既存の編集・追加・削除と代表（TEL2）を保持", JSON.stringify(contactsOf(takahashi)) === JSON.stringify({ tel: ["000-0000-0004", "03-0000-0044"], email: ["preview4a@example.invalid"], primary_contact: "tel_1" }), contactsOf(takahashi));
  ok("保存：選考ステータス・面接日は変更なし", takahashi.status === 4 && takahashi.interview_2_date === "2026-10-09");

  // ---------- 不正な Email は保存しない ----------
  await evaluate(`__row("表示確認用・高橋").children[4].querySelector("button").click()`);
  await waitFor(`!!(__modal() && __byLabel("Email1"))`, "modal 3");
  await setByLabel("Email1", "not-an-email");
  await evaluate(`__click("保存", __modal())`);
  await waitFor(`!!__modal().querySelector(".nks-sel-error")`, "validation error");
  ok("不正な Email はエラーを表示し、保存しない", (await api("/api/candidates/900004")).data.email[0] === "preview4a@example.invalid");
  await evaluate(`__click("キャンセル", __modal())`);
  await waitFor(`!__modal()`, "cancel closes");

  // ---------- 同時編集（他の画面で先に更新）----------
  await evaluate(`__row("表示確認用・山田").children[4].querySelector("button").click()`);
  await waitFor(`!!(__modal() && __byLabel("TEL1"))`, "modal 4");
  const yamada = (await api("/api/candidates/900001")).data;
  const other = await api("/api/candidates/900001/contacts", "PATCH", { tel: ["000-1111-0001"], email: [], primary_contact: "tel_0", expected: contactsOf(yamada) });
  ok("他の画面からの更新（専用API）は成功", other.status === 200);
  await setByLabel("TEL1", "000-9999-0001");
  const dialogCount = dialogs.length;
  await evaluate(`__click("保存", __modal())`);
  await waitFor(`__byLabel("TEL1") && __byLabel("TEL1").value === "000-1111-0001"`, "reloaded after conflict");
  ok("古い画面の保存は409で停止し、最新の連絡先を読み直す", dialogs.slice(dialogCount).some(d => d.includes("他の画面で連絡先が更新されています")));
  ok("古い画面の値で上書きしない", (await api("/api/candidates/900001")).data.tel[0] === "000-1111-0001");
  await evaluate(`__click("キャンセル", __modal())`);
  await waitFor(`!__modal()`, "modal closed 4");

  // ---------- 詳細画面：連絡先の表示・全項目保存で連絡先を上書きしない ----------
  await go("/candidates/900001?view=detail", `!!document.querySelector("input[name=birth_date]")`, "detail");
  ok("詳細：連絡先に代表の印と編集ボタン", await evaluate(`(() => { const p = [...document.querySelectorAll(".nks-sel-panel-head")].find(h => h.textContent.includes("連絡先")); return !!p && !!p.querySelector("button") && document.querySelector(".nks-contact-side-row .nks-contact-side-mark") !== null; })()`));
  const fresh = (await api("/api/candidates/900001")).data;
  await api("/api/candidates/900001/contacts", "PATCH", { tel: ["000-2222-0001"], email: ["yamada@example.invalid"], primary_contact: "email_0", expected: contactsOf(fresh) });

  // ---------- 和暦：生年月日 ----------
  ok("生年月日：標準カレンダー（type=date）を維持", await evaluate(`document.querySelector("input[name=birth_date]").type === "date"`));
  ok("生年月日：西暦入力時は枠外に和暦（昭和64年1月7日）", await evaluate(`document.querySelector("input[name=birth_date]").closest(".nks-wareki-field").textContent.includes("昭和64年1月7日")`));
  const birthToggle = `[...document.querySelectorAll(".nks-wareki-label-row")].find(r => r.textContent.includes("生年月日")).querySelector("input[type=checkbox]")`;
  await evaluate(`${birthToggle}.click()`);
  await waitFor(`!!__byLabel("生年月日の和暦の年")`, "birth wareki row");
  ok("和暦入力：既存の生年月日を和暦で表示（昭和64年1月7日）し、値は変わらない", await evaluate(`__byLabel("生年月日の元号").value === "showa" && __byLabel("生年月日の和暦の年").value === "64" && __byLabel("生年月日の月").value === "1" && __byLabel("生年月日の日").value === "7" && document.querySelector("input[name=birth_date]").value === "1989-01-07"`));
  await setByLabel("生年月日の日", "8");
  await sleep(100);
  ok("和暦入力：昭和64年1月8日は受け付けない（値は変えない）", await evaluate(`document.querySelector(".nks-wareki-error")?.textContent.includes("昭和は") && document.querySelector("input[name=birth_date]").value === "1989-01-07"`));
  await setByLabel("生年月日の元号", "heisei");
  await setByLabel("生年月日の和暦の年", "元");
  await sleep(100);
  ok("和暦入力：平成元年1月8日 → 1989-01-08", await evaluate(`document.querySelector("input[name=birth_date]").value === "1989-01-08"`));
  await setByLabel("生年月日の和暦の年", "31"); await setByLabel("生年月日の月", "5"); await setByLabel("生年月日の日", "1");
  await sleep(100);
  // 入力途中の「平成31年1月8日」は有効な日付として入る。平成31年5月1日は受け付けない
  ok("和暦入力：平成31年5月1日は受け付けない", await evaluate(`document.querySelector(".nks-wareki-error")?.textContent.includes("平成は") && document.querySelector("input[name=birth_date]").value !== "2019-05-01"`));
  await setByLabel("生年月日の日", "30"); await setByLabel("生年月日の月", "4");
  await sleep(100);
  ok("和暦入力：平成31年4月30日 → 2019-04-30", await evaluate(`document.querySelector("input[name=birth_date]").value === "2019-04-30"`));
  await setByLabel("生年月日の元号", "reiwa"); await setByLabel("生年月日の和暦の年", "1"); await setByLabel("生年月日の月", "5"); await setByLabel("生年月日の日", "1");
  await sleep(100);
  ok("和暦入力：令和元年5月1日 → 2019-05-01", await evaluate(`document.querySelector("input[name=birth_date]").value === "2019-05-01"`));
  await setByLabel("生年月日の元号", "heisei"); await setByLabel("生年月日の和暦の年", "2"); await setByLabel("生年月日の月", "5"); await setByLabel("生年月日の日", "10");
  await sleep(100);
  ok("和暦入力：平成2年5月10日 → 1990-05-10",await evaluate(`document.querySelector("input[name=birth_date]").value === "1990-05-10"`));
  await shot("03-birth-wareki");
  await evaluate(`${birthToggle}.click()`);
  await sleep(100);
  ok("和暦入力を外しても入力済みの日付を保持し、枠外に和暦を表示", await evaluate(`document.querySelector("input[name=birth_date]").value === "1990-05-10" && document.querySelector("input[name=birth_date]").closest(".nks-wareki-field").textContent.includes("平成2年5月10日")`));

  // ---------- 和暦：卒業年・職歴・資格（年のみ） ----------
  const toggle = label => `[...document.querySelectorAll(".nks-wareki-label-row")].find(r => r.firstChild.textContent.startsWith(${JSON.stringify(label)})).querySelector("input[type=checkbox]")`;
  ok("年のみ：西暦入力時に和暦を表示（2019年は平成31年・令和元年の両方）", await evaluate(`(() => { const t = document.body.textContent; return t.includes("平成19年") && t.includes("平成31年・令和元年"); })()`));
  await evaluate(`${toggle("卒業年")}.click()`);
  await waitFor(`!!__byLabel("卒業年の和暦の年")`, "graduation wareki");
  ok("卒業年：和暦入力に切り替えても値は変わらない（2007 → 平成19年）", await evaluate(`__byLabel("卒業年の元号").value === "heisei" && __byLabel("卒業年の和暦の年").value === "19" && __byLabel("卒業年の和暦の年").closest(".nks-wareki-field").textContent.includes("2007年")`));
  await setByLabel("卒業年の元号", "showa"); await setByLabel("卒業年の和暦の年", "64");
  await sleep(100);
  ok("卒業年：昭和64年 → 1989年", await evaluate(`__byLabel("卒業年の和暦の年").closest(".nks-wareki-field").textContent.includes("1989年")`));
  await setByLabel("卒業年の和暦の年", "65");
  await sleep(100);
  ok("卒業年：昭和65年は受け付けない（1989年のまま）", await evaluate(`(() => { const f = __byLabel("卒業年の和暦の年").closest(".nks-wareki-field"); return f.textContent.includes("昭和は64年まで"); })()`));
  await setByLabel("卒業年の和暦の年", "64");
  await evaluate(`${toggle("職歴")}.click()`);
  await waitFor(`!!__byLabel("職歴1の退社年の和暦の年")`, "work wareki");
  ok("職歴：2019年は新しい元号（令和元年）で開き、値は2019年のまま", await evaluate(`__byLabel("職歴1の退社年の元号").value === "reiwa" && __byLabel("職歴1の退社年の和暦の年").value === "1" && __byLabel("職歴1の退社年の和暦の年").closest(".nks-wareki-field").textContent.includes("2019年")`));
  await setByLabel("職歴1の入社年の元号", "heisei"); await setByLabel("職歴1の入社年の和暦の年", "元");
  await setByLabel("職歴1の退社年の元号", "heisei"); await setByLabel("職歴1の退社年の和暦の年", "31");
  await evaluate(`${toggle("資格")}.click()`);
  await waitFor(`!!__byLabel("資格1の取得年の和暦の年")`, "license wareki");
  await setByLabel("資格1の取得年の元号", "reiwa"); await setByLabel("資格1の取得年の和暦の年", "元");
  await evaluate(`__byLabel("職歴1の入社年の和暦の年").scrollIntoView({ block: "center" })`);
  await sleep(150);
  await shot("04-year-wareki");
  await evaluate(`${toggle("職歴")}.click()`);
  await sleep(100);
  ok("職歴：和暦を外しても入力済みの年を保持（1989〜2019、年数も表示）", await evaluate(`(() => { const inputs = [...document.querySelectorAll('[aria-label^="職歴1の"]')]; return inputs.map(i => i.value).join() === "1989,2019" && document.body.textContent.includes("30年"); })()`));

  // ---------- 詳細の保存：西暦で保存・JSON構造維持・連絡先を上書きしない ----------
  const beforeSave = (await api("/api/candidates/900001")).data;
  const savedDialogs = dialogs.length;
  await evaluate(`__click("この内容を保存する")`);
  for (let i = 0; i < 40 && !dialogs.slice(savedDialogs).some(d => d.includes("保存・更新しました")); i += 1) await sleep(150);
  ok("詳細：保存完了のメッセージ", dialogs.slice(savedDialogs).some(d => d.includes("保存・更新しました")), dialogs.slice(savedDialogs));
  const saved = (await api("/api/candidates/900001")).data;
  ok("保存：生年月日・卒業年・職歴・資格を西暦で保存", saved.birth_date === "1990-05-10" && saved.graduation_year === "1989"
    && saved.work_history[0].start_year === "1989" && saved.work_history[0].end_year === "2019" && saved.licenses[0].date === "2019", saved);
  ok("保存：職歴・資格の JSON 構造（キー）は変更なし", JSON.stringify(Object.keys(saved.work_history[0]).sort()) === JSON.stringify(Object.keys(beforeSave.work_history[0]).sort())
    && JSON.stringify(Object.keys(saved.licenses[0]).sort()) === JSON.stringify(Object.keys(beforeSave.licenses[0]).sort()));
  ok("保存：詳細画面の全項目保存は、他の画面で更新された連絡先を上書きしない", JSON.stringify(contactsOf(saved)) === JSON.stringify({ tel: ["000-2222-0001"], email: ["yamada@example.invalid"], primary_contact: "email_0" }), contactsOf(saved));
  const sixDigit = await api("/api/candidates/900001", "PUT", { birth_date: "123456-01-01" });
  ok("6桁の年の生年月日は API が400で拒否", sixDigit.status === 400 && (await api("/api/candidates/900001")).data.birth_date === "1990-05-10");
  const sixYear = await api("/api/candidates/900001", "PUT", { licenses: [{ name: "架空資格", date: "123456" }] });
  ok("6桁の年（資格の取得年）は API が400で拒否", sixYear.status === 400 && (await api("/api/candidates/900001")).data.licenses[0].date === "2019");

  // ---------- 入力エラー中は保存しない（和暦の不正・入力途中、5桁以上の年） ----------
  await go("/candidates/900001?view=detail", `!!document.querySelector("input[name=birth_date]")`, "detail for errors");
  await evaluate(`${toggle("卒業年")}.click()`);
  await waitFor(`!!__byLabel("卒業年の和暦の年")`, "graduation wareki 2");
  await setByLabel("卒業年の元号", "showa"); await setByLabel("卒業年の和暦の年", "65");
  let before = dialogs.length;
  await evaluate(`__click("この内容を保存する")`);
  for (let i = 0; i < 20 && dialogs.length === before; i += 1) await sleep(150);
  ok("和暦の不正な年（昭和65年）が残っている間は保存しない", dialogs.slice(before).some(d => d.includes("入力内容を確認") && d.includes("卒業年")) && (await api("/api/candidates/900001")).data.graduation_year === "1989", dialogs.slice(before));
  await setByLabel("卒業年の和暦の年", "64");
  await evaluate(`${birthToggle}.click()`);
  await waitFor(`!!__byLabel("生年月日の日")`, "birth wareki 2");
  await setByLabel("生年月日の日", "");
  before = dialogs.length;
  await evaluate(`__click("この内容を保存する")`);
  for (let i = 0; i < 20 && dialogs.length === before; i += 1) await sleep(150);
  ok("和暦の年月日が入力途中の間は保存しない", dialogs.slice(before).some(d => d.includes("年月日をすべて入力")), dialogs.slice(before));
  await setByLabel("生年月日の日", "10");
  await evaluate(`${birthToggle}.click()`);
  await sleep(100);
  await setByLabel("資格1の取得年", "123456");
  await sleep(100);
  ok("西暦の年欄：5桁以上はエラー表示", await evaluate(`__byLabel("資格1の取得年").closest(".nks-wareki-field").textContent.includes("西暦4桁")`));
  before = dialogs.length;
  await evaluate(`__click("この内容を保存する")`);
  for (let i = 0; i < 20 && dialogs.length === before; i += 1) await sleep(150);
  ok("西暦の年欄：5桁以上の年が残っている間は保存しない", dialogs.slice(before).some(d => d.includes("西暦4桁")) && (await api("/api/candidates/900001")).data.licenses[0].date === "2019", dialogs.slice(before));
  await evaluate(`${toggle("資格")}.click()`);
  await waitFor(`!!__byLabel("資格1の取得年の和暦の年")`, "license wareki with long year");
  before = dialogs.length;
  await evaluate(`__click("この内容を保存する")`);
  for (let i = 0; i < 20 && dialogs.length === before; i += 1) await sleep(150);
  ok("5桁以上の年は和暦入力に切り替えても保存を止めたまま", await evaluate(`__byLabel("資格1の取得年の和暦の年").closest(".nks-wareki-field").textContent.includes("西暦4桁")`) && dialogs.slice(before).some(d => d.includes("西暦4桁")), dialogs.slice(before));
  await evaluate(`${toggle("資格")}.click()`);
  await sleep(100);
  await setByLabel("資格1の取得年", "2019");

  // ---------- 行の削除後に別の行の和暦入力を引き継がない ----------
  await evaluate(`__click("＋ 資格を追加")`);
  await sleep(100);
  await setByLabel("資格2の取得年", "1989");
  await evaluate(`${toggle("資格")}.click()`);
  await waitFor(`!!__byLabel("資格2の取得年の和暦の年")`, "license wareki 2");
  ok("資格：1行目 令和元年（2019）、2行目 平成元年（1989）", await evaluate(`__byLabel("資格1の取得年の元号").value === "reiwa" && __byLabel("資格2の取得年の元号").value === "heisei" && __byLabel("資格2の取得年の和暦の年").value === "1"`));
  await evaluate(`[...__byLabel("資格1の取得年の和暦の年").closest(".nks-wareki-field").parentElement.querySelectorAll("button")].find(b => b.textContent.trim() === "×").click()`);
  await sleep(150);
  ok("資格：1行目を削除すると、残った行は自分の値（1989年・平成元年）を表示", await evaluate(`!__byLabel("資格2の取得年の和暦の年") && __byLabel("資格1の取得年の元号").value === "heisei" && __byLabel("資格1の取得年の和暦の年").value === "1" && __byLabel("資格1の取得年の和暦の年").closest(".nks-wareki-field").textContent.includes("1989年")`));
  await setByLabel("資格1の取得年の和暦の年", "2");
  before = dialogs.length;
  await evaluate(`__click("この内容を保存する")`);
  for (let i = 0; i < 30 && !dialogs.slice(before).some(d => d.includes("保存・更新しました")); i += 1) await sleep(150);
  const afterDelete = (await api("/api/candidates/900001")).data;
  ok("資格：削除後に和暦で直した年（平成2年＝1990）を、その行の値として保存", afterDelete.licenses.length === 1 && afterDelete.licenses[0].date === "1990" && afterDelete.graduation_year === "1989" && afterDelete.birth_date === "1990-05-10", afterDelete.licenses);

  // ---------- 詳細の編集ボタン：保存後に表示を更新 ----------
  await go("/candidates/900001?view=detail", `!!document.querySelector(".nks-contact-side-row")`, "detail reload");
  ok("詳細：他の画面での更新後の連絡先と代表（Email）を表示", await evaluate(`(() => { const rows = [...document.querySelectorAll(".nks-contact-side-row")]; const p = rows.find(r => r.querySelector(".nks-contact-side-mark")); return rows.length === 2 && p.textContent.includes("yamada@example.invalid"); })()`));
  await evaluate(`[...document.querySelectorAll(".nks-sel-panel-head")].find(h => h.textContent.includes("連絡先")).querySelector("button").click()`);
  await waitFor(`!!(__modal() && __byLabel("TEL1"))`, "detail modal");
  await evaluate(`__byLabel("TEL1").closest(".nks-contact-row").querySelector("input[type=radio]").click()`);
  await evaluate(`__click("保存", __modal())`);
  await waitFor(`!__modal()`, "detail modal closed");
  await sleep(200);
  ok("詳細：連絡先の保存後、代表の表示を更新（TEL）", await evaluate(`[...document.querySelectorAll(".nks-contact-side-row")].find(r => r.querySelector(".nks-contact-side-mark")).textContent.includes("000-2222-0001")`));
  await shot("05-detail");

  // ---------- 新規受付：両方空欄・空欄を挟んだ代表 ----------
  await go("/register", `[...document.querySelectorAll("button")].some(b => b.textContent.includes("個人応募として登録"))`, "register");
  const regInputs = `[...document.querySelectorAll("input")]`;
  await evaluate(`__setValue(${regInputs}.find(i => i.name === "name_kanji"), "架空・登録確認")`);
  await evaluate(`__click("個人応募として登録")`);
  await sleep(500);
  const blankReg = (await api("/api/candidates")).data.find(c => c.name_kanji === "架空・登録確認");
  ok("新規受付：TEL・Email とも空欄でも登録できる", !!blankReg && blankReg.tel.length === 0 && blankReg.email.length === 0);
  await evaluate(`__setValue(${regInputs}.find(i => i.name === "name_kanji"), "架空・代表確認")`);
  const telSection = `[...document.querySelectorAll("label")].find(l => l.textContent === "連絡先 TEL").parentElement`;
  await evaluate(`[...${telSection}.querySelectorAll("button")].find(b => b.textContent.trim() === "＋").click()`);
  await sleep(100);
  await evaluate(`(() => { const rows = [...${telSection}.children].filter(d => d.tagName === "DIV"); const row = rows[1]; __setValue(row.querySelector("input:not([type])"), "000-3333-0002"); row.querySelector("input[type=radio]").click(); return rows.length; })()`);
  await sleep(100);
  await evaluate(`__click("個人応募として登録")`);
  await sleep(500);
  const primaryReg = (await api("/api/candidates")).data.find(c => c.name_kanji === "架空・代表確認");
  ok("新規受付：1行目が空欄でも、選んだ代表（2行目のTEL）を正しい番号で保存", !!primaryReg && JSON.stringify(contactsOf(primaryReg)) === JSON.stringify({ tel: ["000-3333-0002"], email: [], primary_contact: "tel_0" }), primaryReg && contactsOf(primaryReg));
} catch (err) {
  console.log("ERROR", err.message);
  steps.push({ name: err.message, value: false });
  try { await shot("99-error"); } catch { /* 画面取得に失敗しても結果は出す */ }
} finally {
  console.log("dialogs:", JSON.stringify(dialogs));
  console.log("problems:", JSON.stringify(problems));
  console.log("screenshots:", out);
  ws.close();
  // ブラウザ全体を DevTools から閉じ、終了を待ってから専用プロファイルを削除する
  try {
    const bws = new WebSocket(browserWs);
    await new Promise((r, j) => { bws.addEventListener("open", r, { once: true }); bws.addEventListener("error", j, { once: true }); });
    bws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await Promise.race([browserExited, sleep(5000)]);
    bws.close();
  } catch { browser.kill(); }
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.log("profile not removed:", profile); }
  const failed = steps.filter(s => !s.value).length;
  console.log(`${steps.length - failed}/${steps.length} PASS`);
  process.exitCode = failed || problems.length ? 1 : 0;
}
