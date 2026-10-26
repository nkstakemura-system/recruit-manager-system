// 期別ダッシュボード（第3弾）の集計。選考履歴は本番と同じ selectionService をメモリ保存先で動かして作る。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import * as metrics from "../../shared/recruitMetrics.mjs";

const require = createRequire(import.meta.url);
const selection = require("../selectionService.js");
const { createMemorySelectionStore } = require("../selectionMemoryStore.js");
const { buildFacts, candidateFacts } = require("../dashboardFacts.js");
const flow = require("../selectionFlow.js");

const asOf = "2026-10-26";
const blank = { is_coop: false, is_deleted: false, contact_history: [], status: 1 };

test("NKS periods run from August 1 to July 31 (54th = 2026/8-2027/7)", () => {
  assert.equal(metrics.periodOf("2026-08-01"), 54);
  assert.equal(metrics.periodOf("2026-07-31"), 53);
  assert.equal(metrics.periodOf("2027-07-31"), 54);
  assert.deepEqual(metrics.periodInfo(53), { period: 53, label: "53期", start: "2025-08-01", end: "2026-07-31", span: "2025/8〜2026/7" });
  assert.deepEqual(metrics.periodMonths(54).slice(0, 2), ["2026-08", "2026-09"]);
  assert.equal(metrics.periodMonths(54).at(-1), "2027-07");
  // 日時で届く経費日は日本時間の日付にする
  assert.equal(metrics.dayOf("2026-07-31T15:00:00.000Z"), "2026-08-01");
  assert.equal(metrics.dayOf("2026-08-01"), "2026-08-01");
});

// 架空の応募者（実在の人物ではない）
async function scenario() {
  const candidates = [
    { ...blank, id: 1, applied_at: "2026-09-01" }, // 1〜3次面接完了 → 内定 → 入社
    { ...blank, id: 2, applied_at: "2026-08-10" }, // 1次面接完了後に辞退
    { ...blank, id: 3, applied_at: "2026-07-15" }, // 53期に受付、54期に1次面接を実施
    { ...blank, id: 4, applied_at: "2026-10-01" }, // 面接予定のみ（未来日）
    { ...blank, id: 5, applied_at: "2026-10-01" }, // 面接完了を取消
    { ...blank, id: 6, applied_at: "2026-07-01" }, // 面接の実施日を53期→54期へ訂正
    { ...blank, id: 7, applied_at: "2026-08-20" }, // 内定後に辞退（内定実績は残る）
    { ...blank, id: 8, applied_at: "2026-10-01" }, // 面接予定のまま音信不通
    // 旧データ（選考履歴なし）
    { ...blank, id: 11, status: 4, applied_at: "2026-08-25", interview_1_date: "2026-09-05", interview_2_date: "2026-09-15" },
    { ...blank, id: 12, status: 6, applied_at: "2026-06-01", expected_join_date: "2026-08-01" },
    { ...blank, id: 13, status: 9, applied_at: "2026-09-01", decline_reason: "1次面接辞退: 架空の理由" },
    // 論理削除済み（実績は残す）・協力業者
    { ...blank, id: 21, is_deleted: true, applied_at: "2026-10-01" },
    { ...blank, id: 31, is_coop: true, applied_at: "2026-10-03" },
  ];
  const store = createMemorySelectionStore(candidates);
  const version = async id => (await selection.getTimeline(store, id)).version;
  const step = async (id, kind, event_date, extra = {}) =>
    selection.addStep(store, id, { expected_version: await version(id), kind, event_date, ...extra }, "test@web");
  const latestId = async id => (await selection.getTimeline(store, id)).records.at(-1).id;

  for (const [n, date] of [[1, "2026-09-10"], [2, "2026-09-20"], [3, "2026-10-01"]]) {
    await step(1, "interview_scheduled", date);
    await step(1, "interview_completed", date);
    assert.equal(n, (await selection.getTimeline(store, 1)).records.at(-1).stage_number);
  }
  await step(1, "offer", "2026-10-05");
  await step(1, "join_planned", "2026-11-01");
  await step(1, "joined", "2026-11-01");

  await step(2, "interview_scheduled", "2026-08-20");
  await step(2, "interview_completed", "2026-08-20");
  await step(2, "declined", "2026-08-25", { note: "架空の理由" });

  await step(3, "interview_scheduled", "2026-07-25");
  await step(3, "interview_completed", "2026-08-02");

  await step(4, "interview_scheduled", "2026-10-30");

  await step(5, "interview_scheduled", "2026-10-10");
  await step(5, "interview_completed", "2026-10-10");
  await selection.voidStep(store, 5, await latestId(5), { expected_version: await version(5), reason: "架空の誤登録" }, "test@web");

  await step(6, "interview_scheduled", "2026-07-30");
  await step(6, "interview_completed", "2026-07-30");
  await selection.correctStep(store, 6, await latestId(6), { expected_version: await version(6), event_date: "2026-08-03", reason: "架空の訂正" }, "test@web");

  await step(7, "interview_scheduled", "2026-09-01");
  await step(7, "interview_completed", "2026-09-01");
  await step(7, "offer", "2026-09-10");
  await step(7, "declined", "2026-09-15", { note: "架空の理由" });

  await step(8, "interview_scheduled", "2026-10-10");
  await step(8, "no_contact", "2026-10-11");

  await step(21, "interview_scheduled", "2026-10-02");
  await step(21, "interview_completed", "2026-10-02");

  const events = candidates.flatMap(c => store.log(c.id).map(e => ({ ...e, candidate_id: String(c.id) })));
  return { candidates, store, facts: buildFacts(candidates, events) };
}

const expenses = [
  { expense_date: "2026-10-01", amount: "300000" },
  { expense_date: "2026-08-31T15:00:00.000Z", amount: 100000 }, // 日本時間 2026-09-01
  { expense_date: "2026-07-31", amount: 50000 }, // 53期
];

test("period metrics count completed interviews (people and rounds), offers, joins and endings by their own dates", async () => {
  const { facts } = await scenario();
  const m = metrics.buildPeriodMetrics({ facts, expenses, period: 54, asOf });
  const t = m.totals;
  assert.equal(m.label, "54期");
  assert.equal(m.is_current, true);
  assert.equal(t.applied, 9);
  assert.equal(t.coop_applied, 1);
  // 面接実績＝完了した実人数、面談回数＝完了の延べ回数（予定のみ・取消は含めない。訂正後の日付で判定）
  assert.equal(t.interviewed, 6);
  assert.equal(t.interviews, 8);
  assert.deepEqual(t.interview_stages, [{ stage: 1, count: 6 }, { stage: 2, count: 1 }, { stage: 3, count: 1 }]);
  // 内定は通知日。後日の辞退でも残る
  assert.equal(t.offers, 2);
  // 入社は入社済みの記録（旧データは入社済み status の入社日欄）
  assert.equal(t.joins, 2);
  assert.equal(t.legacy_joins, 1);
  assert.equal(t.declined, 2);
  assert.equal(t.rejected, 1);
  assert.equal(t.no_contact, 1);
  assert.equal(t.expense, 400000);
  assert.equal(t.cost_per_join, 200000);
  const sep = m.months.find(x => x.month === "2026-09");
  assert.deepEqual([sep.interviews, sep.interviewed, sep.offers, sep.declined, sep.expense], [3, 2, 1, 1, 100000]);
  assert.equal(m.months.length, 12);
  // 旧データは推測せず参考件数として分ける
  assert.deepEqual(m.reference, {
    unconfirmed_interviews: 2, unconfirmed_people: 1,
    undated_interviews: 0, undated_interview_people: 0,
    undated_offers: 1, undated_joins: 0, undated_ended: { rejected: 0, no_contact: 0, declined: 1 },
  });
});

test("the previous period keeps its own results and moved/voided interviews are not left behind", async () => {
  const { facts } = await scenario();
  const m = metrics.buildPeriodMetrics({ facts, expenses, period: 53, asOf });
  assert.equal(m.is_current, false);
  assert.equal(m.totals.applied, 3);
  assert.equal(m.totals.interviews, 0); // 訂正前の 7/30・予定のみの 7/25 は含めない
  assert.equal(m.totals.joins, 0);
  assert.equal(m.totals.expense, 50000);
  assert.equal(m.totals.cost_per_join, null);
  assert.deepEqual(metrics.availablePeriods(facts, expenses, asOf), [54, 53]);
});

test("monthly offer/join applicants are the same people as the counts (declined offers and legacy joins included)", async () => {
  const { facts } = await scenario();
  const m = metrics.buildPeriodMetrics({ facts, expenses, period: 54, asOf });
  for (const row of [...m.months, m.totals]) {
    assert.equal(row.offer_ids.length, row.offers);
    assert.equal(row.join_ids.length, row.joins);
  }
  const month = key => m.months.find(x => x.month === key);
  assert.deepEqual(month("2026-09").offer_ids, ["7"]); // 内定後に辞退しても内定実績の対象者に残る
  assert.deepEqual(month("2026-10").offer_ids, ["1"]);
  assert.deepEqual(month("2026-08").join_ids, ["12"]); // 旧データ（入社済み status・入社日欄）
  assert.deepEqual(month("2026-11").join_ids, ["1"]);
});

test("until excludes records dated after today so the period total covers confirmed months only", async () => {
  const { facts } = await scenario();
  const m = metrics.buildPeriodMetrics({ facts, expenses, period: 54, asOf, until: asOf });
  assert.equal(m.totals.joins, 1); // 11/01 の入社済み登録（未到来）は含めない
  assert.deepEqual(m.totals.join_ids, ["12"]);
  assert.equal(m.months.find(x => x.month === "2026-11").joins, 0);
  assert.equal(m.totals.interviews, 8);
  assert.equal(m.totals.cost_per_join, 400000);
  // 指定しない場合の集計（既存の定義）は変わらない
  assert.equal(metrics.buildPeriodMetrics({ facts, expenses, period: 54, asOf }).totals.joins, 2);
});

test("ending or deleting an applicant keeps past interview results; scheduling alone never counts", async () => {
  const { facts } = await scenario();
  const byId = Object.fromEntries(facts.map(f => [f.id, f]));
  assert.deepEqual(byId[2].interviews, [{ stage: 1, date: "2026-08-20" }]);
  assert.deepEqual(byId[2].ended, { kind: "declined", date: "2026-08-25", legacy: false });
  assert.deepEqual(byId[4].interviews, []);
  assert.deepEqual(byId[5].interviews, []);
  assert.equal(byId[21].deleted, true);
  assert.equal(byId[21].interviews.length, 1);
  // 協力業者は受付件数だけ（選考の事実は持たない）
  assert.deepEqual(byId[31], { id: "31", coop: true, deleted: false, applied: "2026-10-03" });
  // 旧データの退職・終了日は推測しない
  assert.deepEqual(byId[13].ended, { kind: "declined", date: null, legacy: true });
  assert.deepEqual(byId[12].offers, [null]);
});

test("a legacy interview confirmed later counts on the entered date and leaves the unconfirmed reference", async () => {
  const candidates = [{ ...blank, id: 1, status: 1, applied_at: "2026-09-01", interview_1_date: "2026-09-20" }];
  const store = createMemorySelectionStore(candidates);
  assert.deepEqual(candidateFacts(candidates[0]).unconfirmed, [{ stage: 1, date: "2026-09-20" }]);
  const v = await selection.getTimeline(store, 1);
  await selection.addStep(store, 1, { expected_version: v.version, kind: "interview_completed", event_date: "2026-09-21" }, "test@web");
  const f = candidateFacts(candidates[0], store.log(1));
  assert.deepEqual(f.interviews, [{ stage: 1, date: "2026-09-21" }]);
  assert.deepEqual(f.unconfirmed, []);
  // 未来の面接予定は「実施未確認」にも入れない
  const future = candidateFacts({ ...blank, id: 2, status: 1, applied_at: "2026-10-01", interview_1_date: "2026-10-30" });
  const m = metrics.buildPeriodMetrics({ facts: [future], period: 54, asOf });
  assert.equal(m.reference.unconfirmed_interviews, 0);
});

test("legacy interviews without any date are kept as an undated reference (once per round, never in a period)", async () => {
  // 履歴なし・status 4・面接日なし（独立監査の再現条件）→ 1次（予定＋投影の完了）と2次を各1回
  const none = candidateFacts({ ...blank, id: 1, status: 4, applied_at: "2026-09-01" });
  assert.deepEqual(none.interviews, []);
  assert.deepEqual(none.undated_interviews, [1, 2]);
  // 1次は日付あり（実施未確認）・2次だけ日付なし → 二重に数えない
  const partial = candidateFacts({ ...blank, id: 2, status: 4, applied_at: "2026-09-01", interview_1_date: "2026-09-05" });
  assert.deepEqual(partial.unconfirmed, [{ stage: 1, date: "2026-09-05" }]);
  assert.deepEqual(partial.undated_interviews, [2]);
  const m = metrics.buildPeriodMetrics({ facts: [none, partial], period: 54, asOf });
  assert.equal(m.totals.interviews, 0);
  assert.deepEqual([m.reference.undated_interviews, m.reference.undated_interview_people], [3, 2]);
  assert.deepEqual([m.reference.unconfirmed_interviews, m.reference.unconfirmed_people], [1, 1]);
  // 後から実施日付きで完了を登録した回は日付不明から外れる
  const candidates = [{ ...blank, id: 3, status: 3, applied_at: "2026-09-01" }];
  const store = createMemorySelectionStore(candidates);
  const v = await selection.getTimeline(store, 3);
  await selection.addStep(store, 3, { expected_version: v.version, kind: "interview_completed", event_date: "2026-09-10" }, "test@web");
  const f = candidateFacts(candidates[0], store.log(3));
  assert.deepEqual(f.interviews, [{ stage: 1, date: "2026-09-10" }]);
  assert.deepEqual(f.undated_interviews, []);
});

test("the list exposes the corrected end date of terminal steps only", () => {
  assert.deepEqual(flow.listSelectionFields("declined", null, "2026-09-15"),
    { selection_label: "辞退", selection_ended_kind: "declined", selection_ended_date: "2026-09-15" });
  assert.deepEqual(flow.listSelectionFields("interview_scheduled", 3, "2026-09-15"), { selection_label: "3次面接予定" });
});

// --- API（DBは偽物。SQLと返す項目を確認する） ---
function harness(respond) {
  const routes = new Map(), queries = [];
  const app = { use() {}, listen() {} };
  for (const method of ["get", "post", "put", "patch", "delete"])
    app[method] = (url, ...handlers) => routes.set(method + " " + url, handlers.at(-1));
  const express = () => app;
  express.json = express.static = () => () => {};
  const db = { async query(sql, params) { queries.push({ sql, params }); return { rows: respond(sql) }; } };
  const filename = new URL("../server.js", import.meta.url);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    process: { env: {} }, console, __dirname: path.dirname(filename.pathname),
    require: name => {
      if (name === "express") return express;
      if (name === "./auth") return { createAuth: () => ({ install() {}, requireSession() {}, requireMeeting() {} }) };
      if (name === "./db") return db;
      if (name === "dotenv") return { config() {} };
      if (name === "path") return path;
      return require("." + name);
    },
  }, { filename: "server.js" });
  const res = { code: 200, body: null, status(code) { this.code = code; return this; }, send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; } };
  return { routes, queries, res };
}

test("dashboard facts API reads only selection columns and groups history per applicant", async () => {
  const h = harness(sql => {
    if (/to_regclass/.test(sql)) return [{ ready: true }];
    if (/FROM public\.candidate_selection_events/.test(sql)) return [
      { candidate_id: "1", id: "10", seq: 1, kind: "interview_scheduled", stage_number: 1, event_date: "2026-09-10", source: "user", target_event_id: null },
      { candidate_id: "1", id: "11", seq: 2, kind: "interview_completed", stage_number: 1, event_date: "2026-09-10", source: "user", target_event_id: null },
    ];
    return [{ id: 1, is_coop: false, is_deleted: false, status: "3", applied_at: "2026-09-01" }, { id: 2, is_coop: false, status: "1", applied_at: "2026-09-02" }];
  });
  await h.routes.get("get /api/dashboard/facts")({}, h.res);
  assert.equal(h.res.code, 200);
  assert.equal(h.res.body.history_table, true);
  const candidateSql = h.queries.find(q => /FROM public\.candidates/.test(q.sql)).sql;
  assert.doesNotMatch(candidateSql, /\*|name_|tel|email|address/);
  assert.deepEqual(h.res.body.facts[0].interviews, [{ stage: 1, date: "2026-09-10" }]);
  assert.deepEqual(h.res.body.facts[1].interviews, []);
  assert.equal(JSON.stringify(h.res.body).includes("name_kanji"), false);
});

test("dashboard facts API works without the history table (no history query)", async () => {
  const h = harness(sql => /to_regclass/.test(sql) ? [{ ready: false }] : [{ id: 1, status: "6", applied_at: "2026-06-01", expected_join_date: "2026-08-01" }]);
  await h.routes.get("get /api/dashboard/facts")({}, h.res);
  assert.equal(h.res.code, 200);
  assert.equal(h.res.body.history_table, false);
  assert.equal(h.queries.some(q => /FROM public\.candidate_selection_events/.test(q.sql)), false);
  assert.deepEqual(h.res.body.facts[0].joined, { date: "2026-08-01", legacy: true });
});

test("candidate list returns the end kind and corrected end date for ended applicants", async () => {
  const h = harness(sql => /to_regclass/.test(sql) ? [{ ready: true }] : [
    { id: 1, status: "9", latest_selection_kind: "rejected", latest_selection_stage: null, latest_selection_date: "2026-10-03" },
    { id: 2, status: "3", latest_selection_kind: "interview_scheduled", latest_selection_stage: 1, latest_selection_date: "2026-10-30" },
  ]);
  await h.routes.get("get /api/candidates")({}, h.res);
  assert.match(h.queries.at(-1).sql, /x\.kind = 'correction' AND x\.target_event_id = e\.id/);
  assert.equal(h.res.body[0].selection_ended_date, "2026-10-03");
  assert.equal(h.res.body[0].selection_ended_kind, "rejected");
  assert.equal(h.res.body[1].selection_ended_date, undefined);
});
