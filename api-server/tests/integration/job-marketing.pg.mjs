// 求人分析のPostgreSQL結合テスト（JobsCampaigns の登録・上書き・監査履歴・同時実行・ROLLBACK・認証）。
// 検証専用のDBだけを使う。本番・共有DBでは実行しない（接続先が localhost で、DB名が _test で終わる場合だけ実行する）。
// 実行のたびに求人分析の7テーブルを作り直す（migration 004 を適用）。応募者などの他のテーブルには触れない。
//
// 使い方（api-server フォルダで）:
//   JM_PG_TEST_URL=postgres://postgres@127.0.0.1:<port>/<name>_test node --test tests/integration/job-marketing.pg.mjs
// 実際のAPI（server.js）を子プロセスで起動し、HTTPで操作して、DBの行を直接確認する。DBはSSL接続が必要（db.js と同じ設定）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as jm from "../../../shared/jobMarketing.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..", "..");
// 接続先の検証：postgres(ql):// で、localhost・DB名が _test で終わり、接続先を上書きする指定（?host= 等）が無いこと。
// 検証済みの値だけから接続設定を作る（URLの他の部分は使わない）
export function testTarget(value) {
  if (!value) return null;
  let u;
  try { u = new URL(value); } catch { throw new Error("JM_PG_TEST_URL を読み取れません"); }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!["postgres:", "postgresql:"].includes(u.protocol) || u.search || u.hash || !["127.0.0.1", "localhost"].includes(u.hostname)
    || !/^[A-Za-z0-9_]+_test$/.test(database))
    throw new Error("JM_PG_TEST_URL は localhost の、名前が _test で終わる検証用DBだけを指定してください（?host= などの指定は不可）");
  const config = { host: u.hostname, port: Number(u.port || 5432), database, user: decodeURIComponent(u.username || "postgres"), password: decodeURIComponent(u.password || "") || undefined };
  const auth = encodeURIComponent(config.user) + (config.password ? ":" + encodeURIComponent(config.password) : "");
  return { config, url: `postgres://${auth}@${config.host}:${config.port}/${config.database}` };
}
const target = testTarget(process.env.JM_PG_TEST_URL || "");
const skip = !target && "JM_PG_TEST_URL（localhost の *_test データベース）が未指定のため実行しません";

test("the integration test refuses non-local or non-test databases (no DB connection)", () => {
  for (const bad of ["postgres://localhost/audit_test?host=remote.example.invalid", "socket:/tmp?db=prod_test", "postgres://db.example.invalid/x_test",
    "postgres://localhost/production", "postgres://localhost/a_test#x", "http://localhost/a_test", "postgres://127.0.0.1/a_test;drop"])
    assert.throws(() => testTarget(bad), /検証用DB|読み取れません/, bad);
  assert.deepEqual(testTarget("postgres://postgres@127.0.0.1:55471/nks_jm_it_test").config, { host: "127.0.0.1", port: 55471, database: "nks_jm_it_test", user: "postgres", password: undefined });
});

const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const PORT = 5000 + Math.floor(Math.random() * 400) + 300;
const base = `http://127.0.0.1:${PORT}`;
const user = "it-user";
const password = crypto.randomBytes(12).toString("hex");
let server;
let db;
let cookie = "";

async function call(pathname, { method = "GET", body, auth = true } = {}) {
  const headers = { Origin: base };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && cookie) headers.Cookie = cookie;
  const res = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
const q = async (sql, params) => (await db.query(sql, params)).rows;

// 架空の JobsCampaigns 1求人（数値は検証用）
function posting(ref, imp, clk, starts = 0, applies = 0) {
  const header = ["求人名", "参照番号", "表示回数", "クリック数", "クリック率", "応募開始数", "応募数", "費用", "通貨", "担当者メールアドレス"];
  const row = [`架空求人${ref}`, ref, String(imp), String(clk), String(clk / imp), String(starts), String(applies), "0", "JPY", "it@example.invalid"];
  return jm.parseIndeedJobs([header, row], "JobsCampaigns_20261001_20261031.csv").postings[0];
}
function entry(categoryId, p, month, extra = {}, entryExtra = {}) {
  const range = jm.monthRange(month);
  return { ...jm.jobsPostingRecord(p, { categoryId, periodStart: range.start, periodEnd: range.end, planType: "free", periodConfirmed: true, filePeriod: { start: range.start, end: range.end }, ...extra }), ...entryExtra };
}
const hashOf = label => crypto.createHash("sha256").update(label).digest("hex");
const importJobs = (label, entries, extra = {}) => call("/api/job-marketing/imports", { method: "POST", body: { file_name: `JobsCampaigns_${label}.csv`, file_hash: hashOf(label), format: "indeed_jobs", entries, ...extra } });
const legacy = (categoryId, start, end, impressions, clicks, extra = {}) => call("/api/job-marketing/records", { method: "POST", body: {
  record: { category_id: categoryId, media: "Indeed", period_start: start, period_end: end, plan_type: "free", impressions, clicks, apply_starts: 1, applies: null, cost: null, source: "legacy_csv" }, ...extra,
} });
async function overview() { return (await call("/api/job-marketing")).data; }
async function month(categoryId, m) {
  const view = await overview();
  return jm.monthAggregate(view.records.filter(r => r.state === "active"), { categoryId, month: m, asOf: "2026-11-17" });
}
const counts = async () => (await q(`SELECT (SELECT count(*) FROM job_marketing_records)::int AS records, (SELECT count(*) FROM job_marketing_imports)::int AS imports,
  (SELECT count(*) FROM job_marketing_postings)::int AS postings`))[0];

test.before(async () => {
  if (skip) return;
  db = new Client({ ...target.config, ssl: { rejectUnauthorized: false } });
  await db.connect();
  // 破壊的な操作の前に、実際の接続先が検証用DBであることを確認する（応募者のテーブルがあるDBでは実行しない）
  const [who] = (await db.query("SELECT current_database() AS db, host(inet_server_addr()) AS addr, to_regclass('public.candidates') IS NOT NULL AS has_candidates")).rows;
  if (who.db !== target.config.database || !["127.0.0.1", "::1", null].includes(who.addr) || who.has_candidates)
    throw new Error(`検証用DBではないため中止しました（${who.db} / ${who.addr} / 応募者テーブル ${who.has_candidates ? "あり" : "なし"}）`);
  // 検証用DBの求人分析テーブルを作り直す（追記専用のトリガーがあるため DROP で作り直す）
  await db.query(`DROP TABLE IF EXISTS public.job_marketing_references, public.job_marketing_records, public.job_marketing_imports, public.job_marketing_plan_events,
    public.job_marketing_postings, public.job_marketing_category_events, public.job_marketing_categories CASCADE;
    DROP FUNCTION IF EXISTS public.job_marketing_append_only() CASCADE;`);
  await db.query(fs.readFileSync(path.join(apiDir, "migrations", "004_job_marketing.sql"), "utf8"));
  const env = {
    ...process.env, NODE_ENV: "development", PORT: String(PORT), DATABASE_URL: target.url, ALLOWED_ORIGINS: base,
    AUTH_USERNAME: user, AUTH_PASSWORD_HASH: bcrypt.hashSync(password, 10), AUTH_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
  };
  server = spawn(process.execPath, ["server.js"], { cwd: apiDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", d => { log += d; });
  server.stderr.on("data", d => { log += d; });
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(base + "/api/job-marketing"); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error("APIサーバーが起動しませんでした: " + log);
});
test.after(async () => {
  if (server) server.kill();
  if (db) await db.end();
});

test("unauthenticated access is refused", { skip }, async () => {
  assert.equal((await call("/api/job-marketing", { auth: false })).status, 401);
  assert.equal((await call("/api/job-marketing/imports", { method: "POST", body: {}, auth: false })).status, 401);
  assert.equal((await call("/api/auth/login", { method: "POST", body: { username: user, password: "wrong" }, auth: false })).status, 401);
  assert.equal((await call("/api/auth/login", { method: "POST", body: { username: user, password } })).status, 200);
  assert.ok(cookie, "session cookie");
  const view = await overview();
  assert.equal(view.ready, true);
  assert.equal(view.categories.length, 4);
});

test("a new monthly JobsCampaigns CSV is stored as one period-total record with its posting; no email is stored", { skip }, async () => {
  const sales = (await overview()).categories.find(c => c.name === "営業").id;
  const res = await importJobs("sales-oct", [entry(sales, posting("A", 52, 6, 1, 1), "2026-10")]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const [row] = await q("SELECT r.*, p.external_key FROM job_marketing_records r JOIN job_marketing_postings p ON p.id = r.posting_id WHERE r.id = $1", [res.data.ids[0]]);
  assert.deepEqual([row.impressions, row.clicks, row.apply_starts, row.applies, Number(row.cost), row.daily, row.source, row.external_key],
    [52, 6, 1, 1, 0, null, "indeed_csv", "id:A"]);
  assert.equal(row.source_meta.report, "jobs_campaigns");
  assert.equal(JSON.stringify(row.source_meta).includes("example.invalid"), false);
  assert.equal((await q("SELECT format FROM job_marketing_imports"))[0].format, "indeed_csv");
  const oct = await month(sales, "2026-10");
  assert.deepEqual([oct.status, oct.totals.impressions, oct.missing_dates.length], ["ok", 52, 0]);
  // 同じファイルは二重登録しない
  assert.equal((await importJobs("sales-oct", [entry(sales, posting("A", 52, 6, 1, 1), "2026-10")])).data.code, "duplicate_file");
});

test("overwriting the same posting and month supersedes the old record; other months and postings are unchanged", { skip }, async () => {
  const view = await overview();
  const sales = view.categories.find(c => c.name === "営業").id;
  const old = view.records.find(r => r.state === "active" && r.source_meta?.reference === "A");
  assert.equal((await importJobs("sales-sep", [entry(sales, posting("A", 40, 3), "2026-09")])).status, 200);
  assert.equal((await importJobs("sales-b-oct", [entry(sales, posting("B", 30, 3), "2026-10")])).status, 200);
  // 置き換えを指定しない同じ求人・同じ月は二重計上を防いで止まる
  assert.equal((await importJobs("sales-oct-2", [entry(sales, posting("A", 60, 7, 1, 1), "2026-10")])).data.code, "same_period");
  const res = await importJobs("sales-oct-2", [entry(sales, posting("A", 60, 7, 1, 1), "2026-10", {}, { replace_ids: [old.id] })]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const rows = await q("SELECT id::text, kind, supersedes_id::text FROM job_marketing_records ORDER BY id");
  assert.ok(rows.some(r => r.id === res.data.ids[0] && r.supersedes_id === old.id), "new record supersedes the old one");
  assert.ok(rows.some(r => r.id === old.id && r.kind === "metric"), "old record row is kept");
  assert.deepEqual([(await month(sales, "2026-10")).totals.impressions, (await month(sales, "2026-09")).totals.impressions], [90, 40]);
  // 別の求人・別の月の記録は置き換えられない
  const after = await overview();
  const other = after.records.filter(r => r.state === "active" && (r.source_meta?.reference === "B" || r.period_start === "2026-09-01"));
  for (const r of other) {
    const bad = await importJobs("sales-oct-3", [entry(sales, posting("A", 61, 7), "2026-10", {}, { replace_ids: [res.data.ids[0], r.id] })]);
    assert.equal(bad.status, 409);
    assert.equal(bad.data.code, "replace_unrelated");
  }
  // 監査履歴の行は UPDATE・DELETE できない
  await assert.rejects(db.query("UPDATE job_marketing_records SET impressions = 1 WHERE id = $1", [old.id]), /追記専用/);
  await assert.rejects(db.query("DELETE FROM job_marketing_records WHERE id = $1", [old.id]), /追記専用/);
});

test("partial and cross-month legacy records are replaced together in one transaction; September is kept", { skip }, async () => {
  const hq = (await overview()).categories.find(c => c.name === "CADオペ（本社）").id;
  const sep = (await legacy(hq, "2026-09-01", "2026-09-30", 300, 30)).data.id;
  const span = (await legacy(hq, "2026-09-07", "2026-10-07", 126, 16, { allow_overlap: true, overlap_reason: "旧管理CSV" })).data.id;
  const part = (await legacy(hq, "2026-10-01", "2026-10-19", 276, 51, { allow_overlap: true, overlap_reason: "旧管理CSV" })).data.id;
  const res = await importJobs("hq-oct", [entry(hq, posting("HQ", 458, 87, 2, 2), "2026-10", {}, { replace_ids: [part, span] })]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const view = await overview();
  const state = id => view.records.find(r => r.id === id).state;
  assert.deepEqual([state(part), state(span), state(sep)], ["superseded", "voided", "active"]);
  const voids = await q("SELECT reason, source_meta FROM job_marketing_records WHERE kind = 'void' AND supersedes_id = $1", [span]);
  assert.equal(voids.length, 1);
  assert.equal(voids[0].reason, `記録#${res.data.ids[0]}で置き換え`);
  assert.deepEqual([(await month(hq, "2026-10")).totals.impressions, (await month(hq, "2026-09")).totals.impressions], [458, 300]);
});

test("a larger category-wide record needs the scope confirmation (e.g. 637 vs 16)", { skip }, async () => {
  const toki = (await overview()).categories.find(c => c.name === "CADオペ（ときがわ）").id;
  const part = (await legacy(toki, "2026-10-01", "2026-10-19", 637, 116)).data.id;
  const p = posting("TOKI", 16, 6);
  const refused = await importJobs("toki-oct", [entry(toki, p, "2026-10", {}, { replace_ids: [part] })]);
  assert.deepEqual([refused.status, refused.data.code], [409, "scope_unconfirmed"]);
  assert.equal((await overview()).records.find(r => r.id === part).state, "active");
  assert.equal((await importJobs("toki-oct", [entry(toki, p, "2026-10", { scopeConfirmed: true }, { replace_ids: [part] })])).status, 200);
});

test("concurrent imports and double submission never create two active records for the same posting and month", { skip }, async () => {
  const elec = (await overview()).categories.find(c => c.name === "電気工事士").id;
  const before = (await overview()).records.length;
  const results = await Promise.all([
    importJobs("elec-1", [entry(elec, posting("E", 103, 8), "2026-10")]),
    importJobs("elec-2", [entry(elec, posting("E", 103, 8), "2026-10")]),
    importJobs("elec-1", [entry(elec, posting("E", 103, 8), "2026-10")]), // 二重送信（同じファイル）
  ]);
  const ok = results.filter(r => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(results.map(r => [r.status, r.data?.code])));
  assert.ok(results.filter(r => r.status === 409).every(r => ["same_period", "duplicate_file"].includes(r.data.code)));
  const active = (await overview()).records.filter(r => r.state === "active" && r.category_id === elec && r.period_start === "2026-10-01");
  assert.equal(active.length, 1);
  assert.equal((await overview()).records.length, before + 1);
  assert.equal((await q("SELECT count(*)::int AS n FROM job_marketing_postings WHERE external_key = 'id:E'"))[0].n, 1);
});

test("a failure in the middle of an overwrite rolls back everything (records, posting, import)", { skip }, async () => {
  const sales = (await overview()).categories.find(c => c.name === "営業").id;
  const a = (await importJobs("roll-a", [entry(sales, posting("R", 50, 5), "2026-08")])).data.ids[0];
  const extra = (await legacy(sales, "2026-08-01", "2026-08-09", 10, 1, { allow_overlap: true, overlap_reason: "旧" })).data.id;
  // 検証用DBだけ：置き換えの取消行（2件目の置き換え）の追加で失敗させる
  await db.query(`CREATE FUNCTION public.it_fail_void() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'it: simulated failure'; END $$;
    CREATE TRIGGER it_fail_void BEFORE INSERT ON public.job_marketing_records FOR EACH ROW WHEN (NEW.kind = 'void' AND NEW.reason LIKE '記録#%') EXECUTE FUNCTION public.it_fail_void();`);
  try {
    const before = await counts();
    const res = await importJobs("roll-b", [entry(sales, posting("R", 60, 6), "2026-08", { scopeConfirmed: true }, { replace_ids: [a, extra] })]);
    assert.equal(res.status, 500, JSON.stringify(res.data));
    assert.deepEqual(await counts(), before, "no record, posting or import row remains");
    const view = await overview();
    assert.deepEqual([a, extra].map(id => view.records.find(r => r.id === id).state), ["active", "active"]);
  } finally {
    await db.query("DROP TRIGGER it_fail_void ON public.job_marketing_records; DROP FUNCTION public.it_fail_void();");
  }
});

test("one category-wide old record is replaced once by a CSV with two postings; remaining postings of a CSV can be added later", { skip }, async () => {
  const hq = (await overview()).categories.find(c => c.name === "CADオペ（本社）").id;
  const part = (await legacy(hq, "2026-07-01", "2026-07-19", 300, 30)).data.id;
  const a = entry(hq, posting("M1", 400, 40), "2026-07");
  const b = entry(hq, posting("M2", 100, 10), "2026-07");
  const twice = await importJobs("multi", [{ ...a, replace_ids: [part] }, { ...b, replace_ids: [part] }]);
  assert.deepEqual([twice.status, twice.data.problems.some(p => p.code === "replace_twice")], [409, true]);
  // 同じCSVの求人Aだけ先に登録 → 残りの求人Bを後から追加。Aの再登録は止まる
  assert.equal((await importJobs("multi", [{ ...a, replace_ids: [part] }])).status, 200);
  assert.equal((await importJobs("multi", [{ ...a, replace_ids: [] }])).data.problems[0].code, "duplicate_file");
  assert.equal((await importJobs("multi", [b])).status, 200);
  const jul = await month(hq, "2026-07");
  assert.deepEqual([jul.status, jul.totals.impressions], ["ok", 500]);
  assert.equal((await q("SELECT count(*)::int AS n FROM job_marketing_records WHERE supersedes_id = $1", [part]))[0].n, 1, "the old record is replaced exactly once");
});
