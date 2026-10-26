import offerModule from '../offerDate.js';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import * as hrModule from "../../shared/hrSummary.mjs";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);

const asOf = "2026-10-11";
const applicant = (id, extra = {}) => ({
  id, name_kanji: "テスト" + id, status: "5",
  expected_join_date: "2026-11-01", ...extra,
});

test("summary excludes archived/cooperative records, includes today, sorts all joiners and limits fields", () => {
  const rows = [
    applicant(1, { expected_join_date: asOf, status: 6, tel: ["secret"], address: "secret" }),
    applicant(2), applicant(3), applicant(4),
    applicant(5, { is_coop: true }), applicant(6, { is_deleted: true }),
    applicant(7, { is_retired: true }), applicant(8, { retirement_date: asOf }),
    applicant(9, { expected_join_date: "2026-10-10" }),
    applicant(10, { expected_join_date: null }),
    applicant(11, { status: "1" }), applicant(12, { status: "2" }),
    applicant(13, { status: "3" }), applicant(14, { status: "4" }),
    applicant(15, { status: "9" }),
    applicant(16, { is_coop: null, is_deleted: null, is_retired: null, employment_type: " パート " }),
  ];
  const summary = hrModule.buildHrSummary(rows, asOf);
  assert.deepEqual(summary.counts, { received: 1, contacting: 1, interview1: 1, interview2: 1, offered: 6, planned_join: 5 });
  assert.deepEqual(summary.planned_joiners.map(p => p.id), [1, 2, 3, 4, 16]);
  assert.deepEqual(Object.keys(summary.planned_joiners[0]), ["id", "name_kanji", "expected_join_date", "planned_department", "job_title", "employment_type"]);
  assert.equal(summary.planned_joiners[0].job_title, null);
  assert.equal(summary.planned_joiners[4].employment_type, "パート");
  assert.equal(hrModule.calendarDate(new Date("2026-10-10T15:00:00Z")), asOf);
});

// respond: SQL ごとに返す行を変えたい場合の関数（選考履歴テーブルの有無など）
// customDb: 行ロックを再現する偽DBなど（同時更新の検証用）
function serverHarness(mode = "development", rows = [], respond = null, customDb = null) {
  const routes = new Map(), queries = [];
  const app = { use() {}, listen() {} };
  for (const method of ["get", "post", "put", "patch", "delete"])
    app[method] = (url, ...handlers) => routes.set(method + " " + url, handlers.at(-1));
  const express = () => app;
  express.json = express.static = () => () => {};
  // conn: 0 は接続プール、1以上はトランザクション用に借りた接続の番号
  const run = (conn, sql, params) => { queries.push({ sql, params, conn }); return { rows: respond ? respond(sql, params) : rows }; };
  let connections = 0;
  const db = customDb || {
    async query(sql, params) { return run(0, sql, params); },
    async connect() { const conn = ++connections; return { async query(sql, params) { return run(conn, sql, params); }, release() {} }; },
  };
  const filename = new URL("../server.js", import.meta.url);
  const source = fs.readFileSync(filename, "utf8").replace('await import("../shared/hrSummary.mjs")', "hrModule");
  vm.runInNewContext(source, {
    hrModule, process: { env: { NODE_ENV: mode } }, console,
    __dirname: path.dirname(filename.pathname),
    require: name => {
      if (name === "express") return express;
      if (name === "./auth") return { createAuth: () => ({ install() {}, requireSession() {}, requireMeeting() {} }) };
      if (name === "./db") return db;
      if (name === "./offerDate") return offerModule;
      if (["./selectionFlow", "./selectionService", "./selectionPgStore", "./dashboardFacts"].includes(name)) return requireLocal("." + name);
      if (name === "dotenv") return { config() {} };
      if (name === "path") return path;
      throw new Error("Unexpected dependency: " + name);
    },
  }, { filename: "server.js" });
  const response = () => ({
    code: 200, body: null,
    status(code) { this.code = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  });
  return { routes, queries, response };
}

test("meeting route selects only needed columns and returns read-only projection", async () => {
  const h = serverHarness("development", [applicant(1, { email: ["secret"] })]);
  const res = h.response();
  await h.routes.get("get /api/meeting/hr-summary")({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(h.queries.length, 1);
  assert.match(h.queries[0].sql, /^SELECT id, name_kanji, status/);
  assert.doesNotMatch(h.queries[0].sql, /SELECT\s*\*/i);
  assert.match(h.queries[0].sql, /COALESCE\(is_coop, false\)/);
  assert.match(h.queries[0].sql, /retirement_date > \$1::date/);
  assert.equal(res.body.planned_joiners[0]?.email, undefined);
});

test("legacy POST accepts omitted fields; PUT preserves omitted values and supports explicit clearing", async () => {
  const h = serverHarness(), res = h.response();
  await h.routes.get("post /api/candidates")({ body: {} }, res);
  assert.equal(h.queries[0].params.length, 23);
  assert.deepEqual(Array.from(h.queries[0].params.slice(19, 22)), [null, null, null]);
  // PUT は選考履歴テーブルの有無を確認してから UPDATE する
  const updates = () => h.queries.filter(q => /^UPDATE candidates SET/.test(q.sql));
  await h.routes.get("put /api/candidates/:id")({ body: {}, params: { id: "1" } }, h.response());
  assert.equal(updates()[0].params.length, 77);
  assert.deepEqual(Array.from(updates()[0].params.slice(58, 64)), [false, null, false, null, false, null]);
  assert.match(updates()[0].sql, /ELSE job_title END/);
  await h.routes.get("put /api/candidates/:id")({
    body: { job_title: " CAD ", planned_department: "", employment_type: null }, params: { id: "1" },
  }, h.response());
  assert.deepEqual(Array.from(updates()[1].params.slice(58, 64)), [true, "CAD", true, null, true, null]);
});
test("month validation defaults to Tokyo month, rejects invalid values before DB access", async () => {
  assert.equal(hrModule.reportMonth(undefined, "2026-10-01"), "2026-10");
  assert.equal(hrModule.reportMonth("2027-01"), "2027-01");
  for (const month of ["2026-1", "2026-00", "2026-13", "0000-01", "", null, ["2026-10"], "2026-10&secret=1"]) {
    const h = serverHarness(), res = h.response();
    await h.routes.get("get /api/meeting/hr-summary")({ query: { month } }, res);
    assert.equal(res.code, 400); assert.equal(h.queries.length, 0);
  }
  const h = serverHarness(), res = h.response();
  await h.routes.get("get /api/meeting/hr-summary")({ query: { month: "2026-09" } }, res);
  assert.equal(res.body.report_month, "2026-09");
});

test("monthly counts applicants once, interviews separately, excludes future and inactive records", () => {
  const rows = [
    applicant(1, { status: 1, applied_at: "2026-10-01", interview_1_date: "2026-10-03" }),
    applicant(2, { status: 4, applied_at: "2026-09-30", interview_1_date: "2026-10-04", interview_2_date: asOf }),
    applicant(3, { status: 6, applied_at: "2026-10-05", offer_date: "2026-10-07", interview_1_date: "2026-10-12" }),
    applicant(4, { status: 5, offer_date: null, interview_2_date: "2026-11-01" }),
    applicant(5, { applied_at: "2026-10-01", interview_1_date: "2026-10-02", offer_date: "2026-10-03", is_coop: true }),
    applicant(6, { applied_at: "2026-10-01", offer_date: "2026-10-03", is_deleted: true }),
    applicant(7, { applied_at: "2026-10-01", offer_date: "2026-10-03", is_retired: true }),
    applicant(8, { applied_at: "2026-10-01", offer_date: "2026-10-03", retirement_date: asOf }),
  ];
  const summary = hrModule.buildHrSummary(rows, asOf, "2026-10");
  assert.deepEqual(summary.monthly, { received: 2, interviews: 3, offers: 1 });
  assert.deepEqual(summary.current, { in_selection: 2, planned_join: 2 });
  assert.equal(summary.current.planned_join, summary.planned_joiners.length);
  assert.equal(hrModule.countCompletedInterviews([rows[0]], "2026-10", asOf), 1);
  assert.equal(hrModule.countCompletedInterviews([rows[1]], "2026-10", asOf), 2);
  assert.equal(hrModule.countCompletedInterviews([rows[2]], "2026-10", asOf), 0);
  assert.equal(hrModule.monthlyResults([{ applied_at: "2026-09-30T15:00:00Z" }], "2026-10", asOf).received, 1);
});

test("offer date POST auto-initializes in Tokyo, keeps manual value, and rejects invalid dates", async () => {
  assert.equal(offerModule.todayTokyo(new Date("2026-10-11T15:00:00Z")), "2026-10-12");
  assert.equal(offerModule.initialOfferDate(5, null, asOf), asOf);
  assert.equal(offerModule.initialOfferDate(5, "2026-09-01", asOf), "2026-09-01");
  assert.equal(offerModule.initialOfferDate(1, null, asOf), null);
  const h = serverHarness();
  await h.routes.get("post /api/candidates")({ body: { status: 5 } }, h.response());
  assert.equal(h.queries[0].params[22], offerModule.todayTokyo());
  assert.match(h.queries[0].sql, /employment_type, offer_date/);
  for (const date of ["2026-02-30", "2026/10/01", "0000-01-01", "garbage"]) {
    const res = h.response();
    await h.routes.get("post /api/candidates")({ body: { status: 5, offer_date: date } }, res);
    assert.equal(res.code, 400);
  }
  assert.equal(h.queries.length, 1);
});

test("offer date PUT uses old-row atomic transition, preserves omitted values, supports explicit correction/clearing", async () => {
  const h = serverHarness();
  const put = h.routes.get("put /api/candidates/:id");
  for (const status of [5, 6, 9]) {
    await put({ body: { status }, params: { id: 1 } }, h.response());
    const query = h.queries.findLast(q => /^UPDATE candidates SET/.test(q.sql));
    assert.equal(query.params[64], false); assert.equal(query.params[65], null);
    assert.match(query.sql, /offer_date IS NULL AND status::text IS DISTINCT FROM '5' AND \$68::text = '5'/);
    assert.match(query.sql, /ELSE offer_date END/);
    assert.equal(query.params[66], offerModule.todayTokyo());
    assert.equal(query.params[67], status);
  }
  for (const date of ["2026-09-01", null, ""]) {
    await put({ body: { status: 6, offer_date: date }, params: { id: 1 } }, h.response());
    const query = h.queries.findLast(q => /^UPDATE candidates SET/.test(q.sql));
    assert.equal(query.params[64], true); assert.equal(query.params[65], date || null);
  }
  // Existing offer_date prevents automatic initialization; staying at status=5 does not backfill.
  assert.match(offerModule.offerDateUpdateSql, /WHEN offer_date IS NULL AND status::text IS DISTINCT FROM '5'/);
  const res = h.response(), before = h.queries.length;
  await put({ body: { offer_date: "2026-13-01" }, params: { id: 1 } }, res);
  assert.equal(res.code, 400); assert.equal(h.queries.length, before);
});

// --- 第2弾：選考履歴との共存 ---
const { SELECTION_OWNED_FIELDS } = requireLocal("../selectionFlow");
// 選考履歴テーブルあり（ready）＋ 対象応募者が個人応募か協力業者か
const managedHarness = (isCoop) => serverHarness("development", [], sql => {
  if (/to_regclass/.test(sql)) return [{ ready: true }];
  if (/^SELECT is_coop FROM candidates/.test(sql)) return [{ is_coop: isCoop }];
  return [];
});

test("PUT rejects selection columns for individual applicants with 409 instead of silently ignoring them", async () => {
  for (const field of SELECTION_OWNED_FIELDS) {
    const h = managedHarness(false), res = h.response();
    await h.routes.get("put /api/candidates/:id")({ body: { name_kanji: "x", [field]: null }, params: { id: "1" } }, res);
    assert.equal(res.code, 409, field);
    assert.equal(res.body.code, "selection_fields_rejected");
    assert.equal(h.queries.some(q => /^UPDATE/.test(q.sql)), false, field);
  }
  // 新しい画面の基本情報保存（選考列なし）は保存できる
  const h = managedHarness(false), res = h.response();
  await h.routes.get("put /api/candidates/:id")({ body: { name_kanji: "x", job_title: "CAD" }, params: { id: "1" } }, res);
  assert.equal(res.code, 200);
  const update = h.queries.find(q => /^UPDATE/.test(q.sql));
  assert.equal(update.params[68], true);
  assert.deepEqual(Array.from(update.params.slice(69, 77)), [false, false, false, false, false, false, false, false]);
});

test("cooperative records keep the existing progress update through PUT", async () => {
  const h = managedHarness(true), res = h.response();
  await h.routes.get("put /api/candidates/:id")({ body: { status: "9", internal_contact: "担当", decline_reason: "x" }, params: { id: "1" } }, res);
  assert.equal(res.code, 200);
  const update = h.queries.find(q => /^UPDATE/.test(q.sql));
  assert.equal(update.params[69], true); // status が送られた
});

test("PUT selection columns are written only when sent and only for cooperative records or before the history table exists", async () => {
  const h = serverHarness();
  await h.routes.get("put /api/candidates/:id")({ body: { status: 3 }, params: { id: "1" } }, h.response());
  const update = h.queries.find(q => /^UPDATE/.test(q.sql));
  assert.equal(update.params[68], false); // テーブル未作成 → 従来どおり保存
  assert.equal(update.params[69], true);
  for (const [column, value, flag] of [
    ["status", "$7", "$70"], ["decline_reason", "$8", "$71"], ["interview_1_date", "$9", "$72"],
    ["interview_2_date", "$10", "$73"], ["expected_join_date", "$43", "$74"], ["contact_history", "$47", "$75"],
    ["interview_2_attendee", "$48", "$76"], ["applied_at", "$49", "$77"],
  ]) {
    const expected = `${column}=CASE WHEN ${flag}::boolean AND (is_coop IS TRUE OR NOT $69::boolean) THEN ${value} ELSE ${column} END`;
    assert.ok(update.sql.includes(expected), column);
  }
  assert.match(update.sql, /offer_date=CASE WHEN \(is_coop IS TRUE OR NOT \$69::boolean\) THEN \(CASE/);
  assert.doesNotMatch(update.sql, /to_regclass/);
});

test("candidate list falls back to the legacy query while the history table is missing", async () => {
  const h = serverHarness("development", [applicant(1)]);
  const res = h.response();
  await h.routes.get("get /api/candidates")({}, res);
  assert.equal(res.code, 200);
  assert.doesNotMatch(h.queries.at(-1).sql, /candidate_selection_events/);
  assert.equal(res.body[0].selection_label, undefined);
});

test("candidate list badges use the latest non-voided step with the real interview round", async () => {
  const h = serverHarness("development", [], sql => /to_regclass/.test(sql) ? [{ ready: true }]
    : [applicant(1, { status: "4", latest_selection_kind: "interview_scheduled", latest_selection_stage: 3 })]);
  const res = h.response();
  await h.routes.get("get /api/candidates")({}, res);
  assert.match(h.queries.at(-1).sql, /v\.kind = 'void' AND v\.target_event_id = e\.id/);
  assert.equal(res.body[0].selection_label, "3次面接予定");
  assert.equal(res.body[0].status, "4");
});

test("candidate list keeps the existing status label for legacy received records with only a 1st interview date", async () => {
  const h = serverHarness("development", [], sql => /to_regclass/.test(sql) ? [{ ready: true }]
    : [
      applicant(1, { status: "1", latest_selection_kind: "interview_scheduled", latest_selection_stage: 1, latest_selection_unconfirmed_legacy: true }),
      applicant(2, { status: "3", latest_selection_kind: "interview_scheduled", latest_selection_stage: 1, latest_selection_unconfirmed_legacy: false }),
    ]);
  const res = h.response();
  await h.routes.get("get /api/candidates")({}, res);
  // 選考APIの判定（isUnconfirmedLegacyInterview）と同じ条件：従来データ由来・1次面接予定・印が "1"
  assert.match(h.queries.at(-1).sql,
    /\(e\.source = 'legacy' AND e\.kind = 'interview_scheduled' AND e\.stage_number = 1\s+AND e\.payload->>'legacy_status' = '1'\) IS TRUE AS unconfirmed_legacy/);
  assert.equal(res.body[0].selection_label, undefined);
  assert.equal(res.body[0].status, "1");
  assert.equal(res.body[1].selection_label, "1次面接予定");
});

// --- C-04：管理種別（個人応募／協力業者）の変更と選考履歴 ---
// isCoop: 現在の管理種別（undefined は応募者なし） / history: 選考履歴の有無 / ready: 選考履歴テーブルの有無
const coopHarness = ({ isCoop = false, history = false, ready = true } = {}) => serverHarness("development", [], sql => {
  if (/to_regclass/.test(sql)) return [{ ready }];
  if (/^SELECT is_coop FROM candidates/.test(sql)) return isCoop === undefined ? [] : [{ is_coop: isCoop }];
  if (/^SELECT EXISTS \(SELECT 1 FROM public\.candidate_selection_events/.test(sql)) return [{ found: history }];
  return [];
});
const putCandidate = async (h, body) => {
  const res = h.response();
  await h.routes.get("put /api/candidates/:id")({ body, params: { id: "1" } }, res);
  return res;
};
const indexOf = (h, pattern) => h.queries.findIndex(q => pattern.test(q.sql));

test("C-04: the management type of an applicant with selection history cannot be changed (409, nothing saved)", async () => {
  for (const [isCoop, next, extra] of [[false, true, {}], [true, false, { status: "9" }]]) {
    const h = coopHarness({ isCoop, history: true });
    const res = await putCandidate(h, { name_kanji: "x", is_coop: next, ...extra });
    assert.equal(res.code, 409, `${isCoop} -> ${next}`);
    assert.equal(res.body.code, "coop_change_has_history");
    assert.match(res.body.error, /選考履歴があるため、管理種別（個人応募／協力業者）は変更できません/);
    assert.match(res.body.error, /今回の保存は行っていません/);
    assert.equal(indexOf(h, /^UPDATE/), -1);
    assert.equal(indexOf(h, /^COMMIT/), -1);
    // 行ロック → 履歴の確認 → 取り消し が、同じ接続の1トランザクション内で順に行われる
    const begin = indexOf(h, /^BEGIN/), lock = indexOf(h, /FOR UPDATE$/), exists = indexOf(h, /^SELECT EXISTS/), rollback = indexOf(h, /^ROLLBACK/);
    assert.ok(begin >= 0 && begin < lock && lock < exists && exists < rollback, "order");
    const conns = new Set([begin, lock, exists, rollback].map(i => h.queries[i].conn));
    assert.equal(conns.size, 1); assert.notEqual([...conns][0], 0);
  }
});

test("C-04: without selection history the existing type change keeps working in one transaction", async () => {
  for (const [isCoop, next] of [[false, true], [true, false]]) {
    const h = coopHarness({ isCoop, history: false });
    const res = await putCandidate(h, { name_kanji: "x", is_coop: next });
    assert.equal(res.code, 200);
    const lock = indexOf(h, /FOR UPDATE$/), exists = indexOf(h, /^SELECT EXISTS/);
    const update = indexOf(h, /^UPDATE candidates SET/), commit = indexOf(h, /^COMMIT/);
    assert.ok(lock < exists && exists < update && update < commit);
    assert.equal(h.queries[update].params[49], next);
    assert.equal(h.queries[update].conn, h.queries[lock].conn);
  }
  // 選考履歴テーブル作成前は履歴が存在し得ないため、確認せずに従来どおり変更する
  const h = coopHarness({ isCoop: false, ready: false });
  assert.equal((await putCandidate(h, { is_coop: true })).code, 200);
  assert.equal(indexOf(h, /^SELECT EXISTS/), -1);
  assert.equal(h.queries[indexOf(h, /^UPDATE candidates SET/)].params[49], true);
});

test("C-04: saving without changing the type is unaffected by history; an omitted type keeps the current value", async () => {
  const same = coopHarness({ isCoop: false, history: true });
  assert.equal((await putCandidate(same, { name_kanji: "x", is_coop: false, job_title: "CAD" })).code, 200);
  assert.equal(indexOf(same, /^SELECT EXISTS/), -1);
  for (const isCoop of [true, false, null]) {
    const h = coopHarness({ isCoop, history: true });
    assert.equal((await putCandidate(h, { name_kanji: "x" })).code, 200, String(isCoop));
    assert.equal(h.queries[indexOf(h, /^UPDATE candidates SET/)].params[49], isCoop);
  }
  // 存在しない応募者は従来どおり（更新0件で終了）
  assert.equal((await putCandidate(coopHarness({ isCoop: undefined }), { is_coop: true })).code, 200);
});

test("C-04: a database error rolls the PUT back and releases the connection", async () => {
  let released = 0;
  const queries = [];
  const db = {
    async query(sql) { queries.push(sql); return { rows: [{ ready: true }] }; },
    async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          if (/^UPDATE candidates SET/.test(sql)) throw new Error("simulated");
          if (/^SELECT is_coop/.test(sql)) return { rows: [{ is_coop: false }] };
          return { rows: [{ ready: true, found: false }] };
        },
        release() { released += 1; },
      };
    },
  };
  const h = serverHarness("development", [], null, db);
  const res = h.response();
  await h.routes.get("put /api/candidates/:id")({ body: { name_kanji: "x" }, params: { id: "1" } }, res);
  assert.equal(res.code, 500);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(released, 1);
});

// 行ロック（FOR UPDATE）を再現する偽DB。選考履歴APIとPUTが同じ応募者行を奪い合う。
// locking=false はロックが無い場合の対照（この検証方法が競合を検出できることの確認）。
function lockingDb({ locking = true } = {}) {
  const state = {
    candidate: { id: 1, is_coop: false, status: "1", applied_at: "2026-10-01", decline_reason: null, interview_1_date: null,
      interview_2_date: null, offer_date: null, expected_join_date: null, interview_2_attendee: null, contact_history: [] },
    events: [],
  };
  let owner = null;
  let waiters = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  async function run(conn, sql, params) {
    await tick();
    if (/to_regclass/.test(sql)) return { rows: [{ ready: true }] };
    if (/^(COMMIT|ROLLBACK)/.test(sql)) {
      if (owner === conn) { owner = null; const wake = waiters; waiters = []; wake.forEach(fn => fn()); }
      return { rows: [] };
    }
    if (locking && /FOR UPDATE/.test(sql)) {
      while (owner && owner !== conn) await new Promise(resolve => waiters.push(resolve));
      owner = conn;
    }
    if (/^SELECT is_coop FROM candidates/.test(sql)) return { rows: [{ is_coop: state.candidate.is_coop }] };
    if (/^SELECT EXISTS/.test(sql)) return { rows: [{ found: state.events.length > 0 }] };
    if (/FROM public\.candidates WHERE id/.test(sql)) return { rows: [{ ...state.candidate }] };
    if (/FROM public\.candidate_selection_events WHERE candidate_id/.test(sql)) return { rows: state.events.map(e => ({ ...e })) };
    if (/^INSERT INTO public\.candidate_selection_events/.test(sql)) {
      const [, seq, kind, stage_number, event_date, note, attendee, ended_stage, source, target_event_id, payload, actor] = params;
      state.events.push({ id: String(state.events.length + 1), seq, kind, stage_number, event_date, note, attendee, ended_stage,
        source, target_event_id, payload: payload && JSON.parse(payload), actor });
      return { rows: [] };
    }
    if (/^UPDATE public\.candidates SET/.test(sql)) {
      for (const [, column, n] of sql.matchAll(/(\w+) = \$(\d+)/g)) state.candidate[column] = params[Number(n) - 1];
      return { rows: [] };
    }
    if (/^UPDATE candidates SET/.test(sql)) { state.candidate.is_coop = params[49]; return { rows: [] }; }
    return { rows: [] };
  }
  let connections = 0;
  return {
    state,
    db: {
      query: (sql, params) => run(0, sql, params),
      async connect() { const conn = ++connections; return { query: (sql, params) => run(conn, sql, params), release() {} }; },
    },
  };
}

async function raceCoopChange(locking, delayStep, delayPut) {
  const fake = lockingDb({ locking });
  const h = serverHarness("development", [], null, fake.db);
  const selectionReq = body => ({ params: { id: "1" }, body, authUser: { username: "tester" }, get: () => undefined });
  const timeline = h.response();
  await h.routes.get("get /api/candidates/:id/selection")(selectionReq({}), timeline);
  const after = async (ticks, fn) => { for (let i = 0; i < ticks; i += 1) await new Promise(r => setImmediate(r)); return fn(); };
  const step = h.response(), put = h.response();
  await Promise.all([
    after(delayStep, () => h.routes.get("post /api/candidates/:id/selection/events")(
      selectionReq({ expected_version: timeline.body.version, kind: "interview_scheduled", event_date: "2026-10-05" }), step)),
    after(delayPut, () => h.routes.get("put /api/candidates/:id")({ body: { name_kanji: "x", is_coop: true }, params: { id: "1" } }, put)),
  ]);
  return { state: fake.state, step, put };
}

test("C-04: concurrent selection updates and type changes cannot slip past the history check", async () => {
  const outcomes = new Set();
  for (let delayStep = 0; delayStep <= 12; delayStep += 1) {
    for (let delayPut = 0; delayPut <= 12; delayPut += 1) {
      const { state, step, put } = await raceCoopChange(true, delayStep, delayPut);
      const label = `step+${delayStep} put+${delayPut}`;
      // 協力業者なのに選考履歴がある（不整合）状態にはならない
      assert.equal(state.candidate.is_coop === true && state.events.length > 0, false, label);
      if (step.code === 200) {
        assert.equal(put.code, 409, label); assert.equal(put.body.code, "coop_change_has_history", label);
        assert.equal(state.candidate.is_coop, false, label);
      } else {
        assert.equal(put.code, 200, label); assert.equal(step.code, 400, label); // 協力業者は選考履歴APIを使えない
        assert.deepEqual(state.events, [], label);
      }
      outcomes.add(step.code === 200 ? "history first" : "type change first");
    }
  }
  assert.deepEqual([...outcomes].sort(), ["history first", "type change first"]); // 両方の順序を検証できている
  // 対照：行ロックが無ければ同じ手順で不整合が起き得る（この検証が競合を検出できることの確認）
  let broken = false;
  for (let delayStep = 0; delayStep <= 12 && !broken; delayStep += 1) {
    for (let delayPut = 0; delayPut <= 12 && !broken; delayPut += 1) {
      const { state } = await raceCoopChange(false, delayStep, delayPut);
      broken = state.candidate.is_coop === true && state.events.length > 0;
    }
  }
  assert.equal(broken, true);
});