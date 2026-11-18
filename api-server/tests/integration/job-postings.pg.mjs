// 求人一覧・求人詳細・応募者連携（第5弾）のPostgreSQL結合テスト。migration 003・004・005 を検証用DBに適用し、実際のAPI（server.js）を通して確認する。
// 検証専用のDBだけを使う。本番・共有DBでは実行しない（接続先が localhost で、DB名が _test で終わる場合だけ実行する）。
// 応募者テーブルは検証用の架空の表（本番と同じ列構成）を作る。既に応募者テーブルがあるDBでは、このテストが作った印（COMMENT）が無い限り中止する。
//
// 使い方（api-server フォルダで）:
//   JP_PG_TEST_URL=postgres://postgres@127.0.0.1:<port>/<name>_test node --test tests/integration/job-postings.pg.mjs
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
const FIXTURE_MARK = "nks-job-postings-integration-fixture";

export function testTarget(value) {
  if (!value) return null;
  let u;
  try { u = new URL(value); } catch { throw new Error("JP_PG_TEST_URL を読み取れません"); }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!["postgres:", "postgresql:"].includes(u.protocol) || u.search || u.hash || !["127.0.0.1", "localhost"].includes(u.hostname)
    || !/^[A-Za-z0-9_]+_test$/.test(database))
    throw new Error("JP_PG_TEST_URL は localhost の、名前が _test で終わる検証用DBだけを指定してください（?host= などの指定は不可）");
  const config = { host: u.hostname, port: Number(u.port || 5432), database, user: decodeURIComponent(u.username || "postgres"), password: decodeURIComponent(u.password || "") || undefined };
  const auth = encodeURIComponent(config.user) + (config.password ? ":" + encodeURIComponent(config.password) : "");
  return { config, url: `postgres://${auth}@${config.host}:${config.port}/${config.database}` };
}
const target = testTarget(process.env.JP_PG_TEST_URL || "");
const skip = !target && "JP_PG_TEST_URL（localhost の *_test データベース）が未指定のため実行しません";

test("the integration test refuses non-local or non-test databases (no DB connection)", () => {
  for (const bad of ["postgres://localhost/audit_test?host=remote.example.invalid", "postgres://db.example.invalid/x_test", "postgres://localhost/production", "http://localhost/a_test"])
    assert.throws(() => testTarget(bad), /検証用DB|読み取れません/, bad);
});

const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const PORT = 5000 + Math.floor(Math.random() * 300) + 700;
const base = `http://127.0.0.1:${PORT}`;
const user = "it-user";
const password = crypto.randomBytes(12).toString("hex");
let server;
let db;
let cookie = "";

async function call(pathname, { method = "GET", body, auth = true, origin = true } = {}) {
  const headers = {};
  if (origin) headers.Origin = base;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && cookie) headers.Cookie = cookie;
  const res = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
const q = async (sql, params) => (await db.query(sql, params)).rows;
const migration = name => fs.readFileSync(path.join(apiDir, "migrations", name), "utf8");

// 本番の candidates と同じ列構成（2026-11-18 の READ ONLY 監査で確認した列・型）の架空の表
const CANDIDATES_DDL = `CREATE TABLE public.candidates (
  id SERIAL PRIMARY KEY, name_kanji varchar, name_kana varchar, age integer, birth_year integer, birth_date date, experience text,
  tel jsonb, email jsonb, status integer, primary_contact varchar, applied_at timestamp without time zone, expected_join_date date, decline_reason text,
  interview_1_date date, interview_2_date date, is_deleted boolean DEFAULT false, is_retired boolean DEFAULT false, retirement_date date,
  created_at timestamp without time zone DEFAULT now(), motivation_memo text, prev_salary text, desired_salary text, commute_method text, experience_memo text,
  available_date text, other_selection_status text, other_memo text, qa_1 jsonb, qa_2 jsonb, interview_2_memo text, agent_name text, resume_memo text,
  zip_code text, address text, address_banchi text, address_building text, address_room text, emerg_zip_code text, emerg_address text,
  emerg_address_banchi text, emerg_address_building text, emerg_address_room text, emerg_tel text, emerg_name text, emerg_relation text, education text,
  graduation_year text, work_history jsonb, licenses jsonb, family jsonb, commute_time text, contact_history jsonb, interview_2_attendee text,
  is_coop boolean, company_name text, introducer text, internal_contact text, desired_dept text, subcontract_status text, source_type varchar,
  introducer_fee integer, job_title text, planned_department text, employment_type text, offer_date date
); COMMENT ON TABLE public.candidates IS '${FIXTURE_MARK}';`;

test.before(async () => {
  if (skip) return;
  db = new Client({ ...target.config, ssl: { rejectUnauthorized: false } });
  await db.connect();
  // 破壊的な操作の前に、実際の接続先が検証用DBであること・応募者テーブルがこのテストの架空の表であることを確認する
  const [who] = (await db.query(`SELECT current_database() AS db, host(inet_server_addr()) AS addr,
    to_regclass('public.candidates') IS NOT NULL AS has_candidates, obj_description(to_regclass('public.candidates'), 'pg_class') AS mark`)).rows;
  if (who.db !== target.config.database || !["127.0.0.1", "::1", null].includes(who.addr) || (who.has_candidates && who.mark !== FIXTURE_MARK))
    throw new Error(`検証用DBではないため中止しました（${who.db} / ${who.addr} / 応募者テーブル ${who.has_candidates ? "あり（架空の印なし）" : "なし"}）`);
  await db.query(`DROP TABLE IF EXISTS public.candidate_job_posting_links, public.job_marketing_posting_revisions, public.job_marketing_posting_visibility,
    public.candidate_selection_events, public.job_marketing_references, public.job_marketing_records, public.job_marketing_imports, public.job_marketing_plan_events,
    public.job_marketing_postings, public.job_marketing_category_events, public.job_marketing_categories, public.candidates CASCADE;
    DROP FUNCTION IF EXISTS public.job_marketing_append_only() CASCADE; DROP FUNCTION IF EXISTS public.candidate_selection_events_append_only() CASCADE;
    DROP FUNCTION IF EXISTS public.candidate_job_posting_links_append_only() CASCADE;`);
  await db.query(CANDIDATES_DDL);
  await db.query(migration("003_candidate_selection_events.sql"));
  await db.query(migration("004_job_marketing.sql"));
  const env = {
    ...process.env, NODE_ENV: "development", PORT: String(PORT), DATABASE_URL: target.url, ALLOWED_ORIGINS: base,
    AUTH_USERNAME: user, AUTH_PASSWORD_HASH: bcrypt.hashSync(password, 10), AUTH_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
  };
  server = spawn(process.execPath, ["server.js"], { cwd: apiDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", d => { log += d; });
  server.stderr.on("data", d => { log += d; });
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(base + "/api/job-postings"); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error("APIサーバーが起動しませんでした: " + log);
});
test.after(async () => {
  if (server) server.kill();
  if (db) await db.end();
});

const login = () => call("/api/auth/login", { method: "POST", body: { username: user, password } });
const createCandidate = body => call("/api/candidates", { method: "POST", body: { name_kanji: "架空", source_type: "求人", agent_name: "Indeed", ...body } });
const overview = async () => (await call("/api/job-postings")).data;
const row = async id => (await overview()).postings.find(p => p.id === String(id));
async function step(id, kind, event_date, extra = {}) {
  const v = (await call(`/api/candidates/${id}/selection`)).data;
  return call(`/api/candidates/${id}/selection/events`, { method: "POST", body: { expected_version: v.version, kind, event_date, ...extra } });
}
const linkOf = async id => (await call(`/api/candidates/${id}/job-posting`)).data;
const ids = {};

test("before migration 005: the API keeps working and reports the list as not ready", { skip }, async () => {
  assert.equal((await call("/api/job-postings", { auth: false })).status, 401);
  assert.equal((await login()).status, 200);
  assert.equal((await overview()).ready, false);
  const c = await createCandidate({ name_kanji: "架空・適用前" });
  assert.equal(c.status, 200); // 応募者の登録は従来どおり
  const put = await call(`/api/candidates/${c.data.id}`, { method: "PUT", body: { name_kanji: "架空・適用前", job_posting: { posting_id: "1", expected_link_id: null } } });
  assert.equal(put.status, 503); // ひも付けは保存しない（他の項目も保存しない）
  ids.before = c.data.id;
});

test("migration 005 applies once, keeps existing rows, and refuses to run twice", { skip }, async () => {
  await db.query("INSERT INTO public.job_marketing_postings (category_id, media, external_key, job_id, title, actor) VALUES (1, 'Indeed', 'id:CSV-1', 'CSV-1', '架空：CSVの求人', 'it')");
  const beforeRows = await q("SELECT id, external_key FROM public.job_marketing_postings ORDER BY id");
  await db.query(migration("005_job_postings.sql"));
  assert.deepEqual(await q("SELECT id, external_key FROM public.job_marketing_postings ORDER BY id"), beforeRows);
  await assert.rejects(db.query(migration("005_job_postings.sql")), /既に存在します/);
  await db.query("ROLLBACK").catch(() => {});
  const tables = await q(`SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.relname IN ('job_marketing_posting_revisions', 'job_marketing_posting_visibility', 'candidate_job_posting_links') ORDER BY 1`);
  assert.deepEqual(tables.map(t => [t.relname, t.relrowsecurity]), [["candidate_job_posting_links", true], ["job_marketing_posting_revisions", true], ["job_marketing_posting_visibility", true]]);
  const fkType = await q(`SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = 'public.candidate_job_posting_links'::regclass AND a.attname = 'candidate_id'`);
  assert.equal(fkType[0].t, "integer"); // candidates.id と同じ型
  // external_key：nks: を追加。その他の形式は従来どおり拒否
  await db.query("INSERT INTO public.job_marketing_postings (category_id, media, external_key, title) VALUES (1, 'AirWORK', 'nks:abc', 'x')");
  await assert.rejects(db.query("INSERT INTO public.job_marketing_postings (category_id, media, external_key, title) VALUES (1, 'AirWORK', 'free:abc', 'x')"), /external_key_check/);
  await db.query("DELETE FROM public.job_marketing_postings WHERE external_key = 'nks:abc'").catch(() => {}); // 追記専用のため削除は拒否される
  assert.equal((await q("SELECT count(*)::int AS n FROM public.job_marketing_postings WHERE external_key = 'nks:abc'"))[0].n, 1);
  ids.csvPosting = String(beforeRows[0].id);
});

test("create postings, versions and visibility through the API (append-only rows, actor recorded)", { skip }, async () => {
  await login();
  const noOrigin = await call("/api/job-postings", { method: "POST", origin: false, body: { category_id: "1", media: "Indeed", title: "x" } });
  assert.equal(noOrigin.status, 403);
  const a = await call("/api/job-postings", { method: "POST", body: { category_id: "1", media: "インディード", job_id: "J-1", title: "架空：営業", body: "全文\n2行目", visibility: "public", effective_date: "2026-10-01" } });
  assert.equal(a.status, 200);
  ids.indeed = a.data.id;
  const hw = await call("/api/job-postings", { method: "POST", body: { category_id: "4", media: "ハローワーク", job_id: "00000-1", title: "架空：電気工事士" } });
  ids.hw = hw.data.id;
  const air = await call("/api/job-postings", { method: "POST", body: { category_id: "2", media: "AirWORK", title: "架空：IDなし" } });
  assert.match((await q("SELECT external_key FROM public.job_marketing_postings WHERE id = $1", [air.data.id]))[0].external_key, /^nks:/);
  assert.equal((await call("/api/job-postings", { method: "POST", body: { category_id: "1", media: "Indeed", job_id: "J-1", title: "重複" } })).status, 409);
  const [p] = await q("SELECT media, external_key, title, actor FROM public.job_marketing_postings WHERE id = $1", [ids.indeed]);
  assert.deepEqual(p, { media: "Indeed", external_key: "id:J-1", title: "架空：営業", actor: "it-user@web" });
  const [rev] = await q("SELECT revision_no, body, actor FROM public.job_marketing_posting_revisions WHERE posting_id = $1", [ids.indeed]);
  assert.deepEqual(rev, { revision_no: 1, body: "全文\n2行目", actor: "it-user@web" });
  assert.equal((await call(`/api/job-postings/${ids.indeed}/revisions`, { method: "POST", body: { expected_revision_no: 1, title: "架空：営業", body: "全文（改）", change_summary: "本文を修正" } })).status, 200);
  assert.equal((await call(`/api/job-postings/${ids.indeed}/visibility`, { method: "POST", body: { expected_seq: 1, visibility: "private", effective_date: "2026-10-20", reason: "充足" } })).status, 200);
  const vis = await q("SELECT seq, previous_visibility, visibility, to_char(effective_date, 'YYYY-MM-DD') AS d, reason FROM public.job_marketing_posting_visibility WHERE posting_id = $1 ORDER BY seq", [ids.indeed]);
  assert.deepEqual(vis, [{ seq: 1, previous_visibility: null, visibility: "public", d: "2026-10-01", reason: null }, { seq: 2, previous_visibility: "public", visibility: "private", d: "2026-10-20", reason: "充足" }]);
  for (const t of ["job_marketing_posting_revisions", "job_marketing_posting_visibility"]) {
    await assert.rejects(db.query(`UPDATE public.${t} SET actor = 'x'`), /追記専用/);
    await assert.rejects(db.query(`DELETE FROM public.${t}`), /追記専用/);
    await assert.rejects(db.query(`TRUNCATE public.${t}`), /追記専用/);
  }
  const d = (await call(`/api/job-postings/${ids.indeed}`)).data;
  assert.deepEqual([d.current.revision_no, d.revisions[0].changes.map(c => c.key), d.visibility.current], [2, ["body"], "private"]);
  const csv = (await call(`/api/job-postings/${ids.csvPosting}`)).data;
  assert.deepEqual([csv.posting.revision_no, csv.posting.visibility, csv.posting.title], [0, null, "架空：CSVの求人"]); // 既存の求人原稿は初版未登録・要設定
});

test("concurrent edits: only one of two saves from the same screen state succeeds", { skip }, async () => {
  const body = n => ({ expected_revision_no: 2, title: "架空：営業", body: `同時編集${n}`, change_summary: `同時${n}` });
  const revs = await Promise.all([1, 2, 3].map(n => call(`/api/job-postings/${ids.indeed}/revisions`, { method: "POST", body: body(n) })));
  assert.deepEqual(revs.map(r => r.status).sort(), [200, 409, 409]);
  assert.deepEqual((await q("SELECT revision_no FROM public.job_marketing_posting_revisions WHERE posting_id = $1 ORDER BY revision_no", [ids.indeed])).map(r => r.revision_no), [1, 2, 3]);
  const vis = await Promise.all([1, 2].map(() => call(`/api/job-postings/${ids.hw}/visibility`, { method: "POST", body: { expected_seq: 0, visibility: "public", effective_date: "2026-10-01" } })));
  assert.deepEqual(vis.map(r => r.status).sort(), [200, 409]);
  assert.equal((await q("SELECT count(*)::int AS n FROM public.job_marketing_posting_visibility WHERE posting_id = $1", [ids.hw]))[0].n, 1);
});

test("candidate registration and link are saved in one transaction; old screens never clear the link", { skip }, async () => {
  const before = (await q("SELECT count(*)::int AS n FROM public.candidates"))[0].n;
  const bad = await createCandidate({ name_kanji: "架空・失敗", job_posting: { posting_id: "99999" } });
  assert.equal(bad.status, 400);
  assert.equal((await q("SELECT count(*)::int AS n FROM public.candidates"))[0].n, before); // 応募者も登録されない
  const c1 = await createCandidate({ name_kanji: "架空・一", job_posting: { posting_id: ids.indeed } });
  assert.equal(c1.status, 200);
  ids.c1 = c1.data.id;
  assert.deepEqual(await q("SELECT seq, posting_id::text AS posting_id, actor FROM public.candidate_job_posting_links WHERE candidate_id = $1", [ids.c1]), [{ seq: 1, posting_id: ids.indeed, actor: "it-user@web" }]);
  const coop = await createCandidate({ name_kanji: "架空協力", is_coop: true, job_posting: { posting_id: ids.indeed } });
  assert.equal(coop.status, 400); // 協力業者はひも付けない（登録も取り消す）
  // 古い画面（job_posting を送らない全項目保存）：ひも付けはそのまま
  // 実際の画面と同じく、選考の列・連絡先は送らない（既存の保護で409になるため）
  const full = (await call(`/api/candidates/${ids.c1}`)).data;
  for (const k of [...require("../../selectionFlow.js").SELECTION_OWNED_FIELDS, "tel", "email", "primary_contact"]) delete full[k];
  assert.equal((await call(`/api/candidates/${ids.c1}`, { method: "PUT", body: { ...full, name_kanji: "架空・一（改）" } })).status, 200);
  assert.equal((await linkOf(ids.c1)).current.id, ids.indeed);
  // 古い画面（ひも付けの版が古い）からの変更は409で、他の項目も保存しない
  const stale = await call(`/api/candidates/${ids.c1}`, { method: "PUT", body: { name_kanji: "保存されない名前", source_type: "求人", job_posting: { posting_id: ids.hw, expected_link_id: null } } });
  assert.deepEqual([stale.status, stale.data.code], [409, "link_stale"]);
  assert.equal((await q("SELECT name_kanji FROM public.candidates WHERE id = $1", [ids.c1]))[0].name_kanji, "架空・一（改）");
  const unknown = await call(`/api/candidates/${ids.c1}`, { method: "PUT", body: { name_kanji: "保存されない名前", source_type: "求人", job_posting: { posting_id: "99999", expected_link_id: (await linkOf(ids.c1)).link_id } } });
  assert.equal(unknown.status, 400);
  assert.equal((await q("SELECT name_kanji FROM public.candidates WHERE id = $1", [ids.c1]))[0].name_kanji, "架空・一（改）");
  // 同時に2画面から変更：一方だけ成功
  const expected = (await linkOf(ids.c1)).link_id;
  const both = await Promise.all([ids.hw, ids.csvPosting].map(pid => call(`/api/candidates/${ids.c1}`, { method: "PUT", body: { name_kanji: "架空・一（改）", source_type: "求人", job_posting: { posting_id: pid, expected_link_id: expected } } })));
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
  assert.equal((await q("SELECT count(*)::int AS n FROM public.candidate_job_posting_links WHERE candidate_id = $1", [ids.c1]))[0].n, 2);
  await assert.rejects(db.query("UPDATE public.candidate_job_posting_links SET reason = 'x'"), /追記専用/);
  await assert.rejects(db.query("DELETE FROM public.candidate_job_posting_links"), /追記専用/);
  // 元の求人に戻す
  await call(`/api/candidates/${ids.c1}`, { method: "PUT", body: { name_kanji: "架空・一（改）", source_type: "求人", job_posting: { posting_id: ids.indeed, expected_link_id: (await linkOf(ids.c1)).link_id, reason: "戻す" } } });
  assert.equal((await linkOf(ids.c1)).history.length, 3);
});

test("a linked applicant cannot leave the 求人 route or become co-op unless the same save clears the link (nothing saved on 409)", { skip }, async () => {
  const c = await createCandidate({ name_kanji: "架空・経路変更", job_posting: { posting_id: ids.hw } });
  const id = c.data.id;
  const name = async () => (await q("SELECT name_kanji, source_type, is_coop FROM public.candidates WHERE id = $1", [id]))[0];
  // ひも付けを送らずに応募経路を変える（ひも付けを読み込めていない画面・古い画面）：409・何も保存しない
  const r1 = await call(`/api/candidates/${id}`, { method: "PUT", body: { name_kanji: "保存されない", source_type: "人材紹介", agent_name: "架空" } });
  assert.deepEqual([r1.status, r1.data.code], [409, "link_required"]);
  assert.deepEqual(await name(), { name_kanji: "架空・経路変更", source_type: "求人", is_coop: false });
  // 協力業者への変更も同じ
  const r2 = await call(`/api/candidates/${id}`, { method: "PUT", body: { name_kanji: "保存されない", is_coop: true, source_type: "求人" } });
  assert.deepEqual([r2.status, r2.data.code], [409, "link_required"]);
  assert.equal((await name()).is_coop, false);
  // 求人以外の応募経路で求人を選ぶことはできない
  const r3 = await call(`/api/candidates/${id}`, { method: "PUT", body: { name_kanji: "架空・経路変更", source_type: "紹介", job_posting: { posting_id: ids.indeed, expected_link_id: (await linkOf(id)).link_id } } });
  assert.equal(r3.status, 400);
  // 同じ保存でひも付けを外せば保存でき、履歴に残る
  const r4 = await call(`/api/candidates/${id}`, { method: "PUT", body: { name_kanji: "架空・経路変更", is_coop: true, source_type: "求人",
    job_posting: { posting_id: null, expected_link_id: (await linkOf(id)).link_id, reason: "協力業者に変更" } } });
  assert.equal(r4.status, 200, JSON.stringify(r4.data));
  assert.equal((await name()).is_coop, true);
  const l = await linkOf(id);
  assert.deepEqual([l.current, l.history.length, l.history[0].reason], [null, 2, "協力業者に変更"]);
});

test("applications and hires follow the selection history (offer counts, decline and voided offers do not)", { skip }, async () => {
  const c2 = await createCandidate({ name_kanji: "架空・二", job_posting: { posting_id: ids.indeed } });
  const c3 = await createCandidate({ name_kanji: "架空・三（入社済み・従来データ）", status: 6, job_posting: { posting_id: ids.indeed } });
  ids.c2 = c2.data.id;
  ids.c3 = c3.data.id;
  let r = await row(ids.indeed);
  assert.deepEqual([r.applicants, r.hires], [3, 1]);
  for (const [kind, date] of [["interview_scheduled", "2026-10-05"], ["interview_completed", "2026-10-05"], ["offer", "2026-10-10"]]) assert.equal((await step(ids.c1, kind, date)).status, 200);
  r = await row(ids.indeed);
  assert.deepEqual([r.applicants, r.hires], [3, 2]);
  assert.equal((await step(ids.c1, "declined", "2026-10-12", { note: "内定辞退" })).status, 200);
  assert.equal((await row(ids.indeed)).hires, 1);
  for (const [kind, date] of [["interview_scheduled", "2026-10-06"], ["interview_completed", "2026-10-06"], ["offer", "2026-10-11"]]) await step(ids.c2, kind, date);
  assert.equal((await row(ids.indeed)).hires, 2);
  const v = (await call(`/api/candidates/${ids.c2}/selection`)).data;
  assert.equal((await call(`/api/candidates/${ids.c2}/selection/events/${v.records.at(-1).id}/void`, { method: "POST", body: { expected_version: v.version, reason: "内定取消" } })).status, 200);
  assert.equal((await row(ids.indeed)).hires, 1);
  const people = (await call(`/api/job-postings/${ids.indeed}/candidates?kind=applied`)).data.candidates;
  assert.deepEqual(people.map(p => p.selection_label).sort(), ["1次面接済", "入社", "辞退"].sort());
  assert.deepEqual((await call(`/api/job-postings/${ids.indeed}/candidates?kind=hired`)).data.candidates.map(p => p.id), [String(ids.c3)]);
  // アーカイブ後も応募実績に残る
  await call(`/api/candidates/${ids.c2}`, { method: "DELETE" });
  assert.equal((await row(ids.indeed)).applicants, 3);
  // ダッシュボードの集計元は従来どおり
  assert.equal((await call("/api/dashboard/facts")).status, 200);
});

test("CSV import reuses the posting with the same job ID; plan changes from the detail are shared with job analysis", { skip }, async () => {
  const header = ["求人名", "参照番号", "表示回数", "クリック数", "クリック率", "応募開始数", "応募数", "費用", "通貨"];
  const parsed = jm.parseIndeedJobs([header, ["架空：営業（CSV）", "J-1", "52", "6", "0.115385", "1", "1", "0", "JPY"]], "JobsCampaigns_20261001_20261031.csv");
  const range = jm.monthRange("2026-10");
  const entries = parsed.postings.map(p => jm.jobsPostingRecord(p, { categoryId: "1", periodStart: range.start, periodEnd: range.end, planType: "free", periodConfirmed: true, filePeriod: { start: range.start, end: range.end } }));
  const postingsBefore = (await q("SELECT count(*)::int AS n FROM public.job_marketing_postings"))[0].n;
  const imp = await call("/api/job-marketing/imports", { method: "POST", body: { file_name: "JobsCampaigns_20261001_20261031.csv", file_hash: "b".repeat(64), format: "indeed_jobs", entries } });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal((await q("SELECT count(*)::int AS n FROM public.job_marketing_postings"))[0].n, postingsBefore);
  assert.equal((await q("SELECT posting_id::text AS p FROM public.job_marketing_records WHERE kind = 'metric' ORDER BY id DESC LIMIT 1"))[0].p, ids.indeed);
  assert.equal((await call("/api/job-marketing/plan-events", { method: "POST", body: { category_id: "1", posting_id: ids.indeed, status: "paid", effective_date: "2026-10-14", budget: "30000", note: "有料へ" } })).status, 200);
  const d = (await call(`/api/job-postings/${ids.indeed}`)).data;
  assert.equal(d.records.length, 1);
  assert.ok(d.plan_events.some(e => e.posting_id === ids.indeed && e.status === "paid"));
  assert.ok(d.improvements.some(i => i.note === "有料へ"));
  assert.equal(d.posting.title, "架空：営業"); // CSVの名称で求人タイトル（版）は変わらない
  assert.equal((await q("SELECT title FROM public.job_marketing_postings WHERE id = $1", [ids.indeed]))[0].title, "架空：営業");
});


test("the batched read (one round trip, read-only snapshot) returns the same results as the transaction path", { skip }, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ ...target.config, ssl: { rejectUnauthorized: false }, max: 3 });
  try {
    const { createPgMarketingStore } = require(path.join(apiDir, "jobMarketingPgStore.js"));
    const { createPgJobPostingStore } = require(path.join(apiDir, "jobPostingPgStore.js"));
    const svc = require(path.join(apiDir, "jobPostingService.js"));
    const store = createPgJobPostingStore(pool, createPgMarketingStore(pool));
    const viaTx = { ready: store.ready, transaction: store.transaction }; // read を持たない保存先（従来の読み方）
    const strip = v => JSON.parse(JSON.stringify(v));
    assert.deepEqual(strip(await svc.overview(store)), strip(await svc.overview(viaTx)));
    for (const id of [ids.indeed, ids.hw, ids.csvPosting]) assert.deepEqual(strip(await svc.detail(store, id)), strip(await svc.detail(viaTx, id)));
    assert.deepEqual(strip(await svc.candidates(store, ids.indeed, "applied")), strip(await svc.candidates(viaTx, ids.indeed, "applied")));
    assert.deepEqual(strip(await svc.candidateLink(store, ids.c1)), strip(await svc.candidateLink(viaTx, ids.c1)));
    // 一覧は全文を読まない（最新の版の本文は null）。詳細は全文を読む
    const row = (await svc.overview(store)).postings.find(p => p.id === ids.indeed);
    assert.equal(typeof row.record_count, "number");
    assert.ok((await svc.detail(store, ids.indeed)).current.body);
    // 読み取りは読み取り専用のトランザクション（書き込みは拒否される）
    const c = await pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await assert.rejects(c.query("INSERT INTO public.job_marketing_imports (file_name, file_hash, format, record_count) VALUES ('x', repeat('a', 64), 'indeed_csv', 0)"), /read-only/);
    } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
  } finally { await pool.end(); }
});

test("physical deletion of a candidate cascades only its link history", { skip }, async () => {
  const links = (await q("SELECT count(*)::int AS n FROM public.candidate_job_posting_links WHERE candidate_id = $1", [ids.c3]))[0].n;
  assert.equal(links, 1);
  assert.equal((await call(`/api/candidates/${ids.c3}/physical`, { method: "DELETE" })).status, 200);
  assert.equal((await q("SELECT count(*)::int AS n FROM public.candidate_job_posting_links WHERE candidate_id = $1", [ids.c3]))[0].n, 0);
  assert.equal((await row(ids.indeed)).applicants, 2);
  assert.ok((await q("SELECT count(*)::int AS n FROM public.job_marketing_posting_revisions"))[0].n > 0); // 求人の履歴は残る
});
