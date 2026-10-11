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
  assert.equal(h.queries[0].params.length, 22);
  assert.deepEqual(Array.from(h.queries[0].params.slice(19)), [null, null, null]);
  await h.routes.get("put /api/candidates/:id")({ body: {}, params: { id: "1" } }, h.response());
  assert.equal(h.queries[1].params.length, 64);
  assert.deepEqual(Array.from(h.queries[1].params.slice(58)), [false, null, false, null, false, null]);
  assert.match(h.queries[1].sql, /ELSE job_title END/);
  await h.routes.get("put /api/candidates/:id")({
    body: { job_title: " CAD ", planned_department: "", employment_type: null }, params: { id: "1" },
  }, h.response());
  assert.deepEqual(Array.from(h.queries[2].params.slice(58)), [true, "CAD", true, null, true, null]);
});