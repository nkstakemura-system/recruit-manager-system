import offerModule from '../offerDate.js';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import * as hrModule from "../../shared/hrSummary.mjs";

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

function serverHarness(mode = "development", rows = []) {
  const routes = new Map(), queries = [];
  const app = { use() {}, listen() {} };
  for (const method of ["get", "post", "put", "patch", "delete"])
    app[method] = (url, ...handlers) => routes.set(method + " " + url, handlers.at(-1));
  const express = () => app;
  express.json = express.static = () => () => {};
  const db = { async query(sql, params) { queries.push({ sql, params }); return { rows }; } };
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
  await h.routes.get("put /api/candidates/:id")({ body: {}, params: { id: "1" } }, h.response());
  assert.equal(h.queries[1].params.length, 68);
  assert.deepEqual(Array.from(h.queries[1].params.slice(58, 64)), [false, null, false, null, false, null]);
  assert.match(h.queries[1].sql, /ELSE job_title END/);
  await h.routes.get("put /api/candidates/:id")({
    body: { job_title: " CAD ", planned_department: "", employment_type: null }, params: { id: "1" },
  }, h.response());
  assert.deepEqual(Array.from(h.queries[2].params.slice(58, 64)), [true, "CAD", true, null, true, null]);
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
    const query = h.queries.at(-1);
    assert.equal(query.params[64], false); assert.equal(query.params[65], null);
    assert.match(query.sql, /offer_date IS NULL AND status::text IS DISTINCT FROM '5' AND \$68::text = '5'/);
    assert.match(query.sql, /ELSE offer_date END/);
    assert.equal(query.params[66], offerModule.todayTokyo());
    assert.equal(query.params[67], status);
  }
  for (const date of ["2026-09-01", null, ""]) {
    await put({ body: { status: 6, offer_date: date }, params: { id: 1 } }, h.response());
    const query = h.queries.at(-1);
    assert.equal(query.params[64], true); assert.equal(query.params[65], date || null);
  }
  // Existing offer_date prevents automatic initialization; staying at status=5 does not backfill.
  assert.match(offerModule.offerDateUpdateSql, /WHEN offer_date IS NULL AND status::text IS DISTINCT FROM '5'/);
  const res = h.response(), before = h.queries.length;
  await put({ body: { offer_date: "2026-13-01" }, params: { id: 1 } }, res);
  assert.equal(res.code, 400); assert.equal(h.queries.length, before);
});