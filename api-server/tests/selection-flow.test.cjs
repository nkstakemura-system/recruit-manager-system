const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const flow = require("../selectionFlow");
const service = require("../selectionService");
const { createMemorySelectionStore } = require("../selectionMemoryStore");
const { shiftedAppliedAt, mirrorUpdate } = require("../selectionPgStore");

const actor = "tester@web";
const person = (id, extra = {}) => ({
  id, is_coop: false, status: 1, applied_at: "2026-10-01", decline_reason: null,
  interview_1_date: null, interview_2_date: null, offer_date: null, expected_join_date: null,
  interview_2_attendee: null, contact_history: [], ...extra,
});
const setup = (...rows) => ({ candidates: rows, store: createMemorySelectionStore(rows) });
const view = (store, id) => service.getTimeline(store, id);
const add = async (store, id, body) => service.addStep(store, id, { expected_version: (await view(store, id)).version, ...body }, actor);
const correct = async (store, id, eventId, body) => service.correctStep(store, id, eventId, { expected_version: (await view(store, id)).version, ...body }, actor);
const cancel = async (store, id, eventId, body = {}) => service.voidStep(store, id, eventId, { expected_version: (await view(store, id)).version, ...body }, actor);
const rejectsWith = (promise, status, code) => assert.rejects(promise, err => err.status === status && (!code || err.code === code));
const kinds = v => v.actions.map(a => a.kind);

test("four-digit year dates only (same rule as the existing offer date check)", () => {
  for (const ok of ["2026-10-23", "2024-02-29", "1000-01-01", "9999-12-31", "0001-01-01"]) assert.equal(flow.isDate(ok), true, ok);
  for (const bad of ["0000-01-01", "202610-01-01", "20261-01-01", "2026-02-30", "2026/10/23", "2026-1-1", "", null, 20261023])
    assert.equal(flow.isDate(bad), false, String(bad));
});

test("after application the choices are document arrival, 1st interview, declined and no contact", async () => {
  const { store } = setup(person(1));
  const v = await view(store, 1);
  assert.deepEqual(kinds(v), ["document_received", "interview_scheduled", "declined", "no_contact"]);
  assert.deepEqual(v.records, []);
  assert.equal(v.applied_date, "2026-10-01");
  assert.equal(v.actions[0].date_label, "書類到着日");
  assert.equal(v.actions[3].confirm, "音信不通として不採用にしますか？");
});

test("interviews separate scheduled and completed, have no round limit and keep statuses 3/4", async () => {
  const { candidates, store } = setup(person(1));
  const c = candidates[0];
  await add(store, 1, { kind: "document_received", event_date: "2026-10-02" });
  assert.equal(c.status, "1");
  assert.deepEqual(kinds(await view(store, 1)), ["interview_scheduled", "rejected", "declined", "no_contact"]);
  for (let stage = 1; stage <= 23; stage += 1) {
    const day = String(stage).padStart(2, "0");
    await add(store, 1, { kind: "interview_scheduled", event_date: `2026-11-${day}`, attendee: stage === 2 ? " 部長 " : "" });
    const v = await view(store, 1);
    assert.deepEqual(kinds(v), ["interview_completed", "declined", "no_contact"], `scheduled ${stage}`);
    assert.equal(v.actions[0].default_date, `2026-11-${day}`);
    await add(store, 1, { kind: "interview_completed", event_date: `2026-11-${day}` });
  }
  const v = await view(store, 1);
  assert.equal(v.actions.find(a => a.kind === "interview_scheduled").stage_number, 24);
  assert.equal(c.status, "4");
  assert.equal(c.interview_1_date, "2026-11-01");
  assert.equal(c.interview_2_date, "2026-11-02");
  assert.equal(c.interview_2_attendee, "部長");
  assert.equal(v.records.at(-1).label, "23次面接（完了）");
  assert.equal(flow.badgeLabel("interview_scheduled", 3), "3次面接予定");
});

test("offer date, planned join date and explicit joining keep existing columns in sync", async () => {
  const { candidates, store } = setup(person(1));
  const c = candidates[0];
  await add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-05" });
  await rejectsWith(add(store, 1, { kind: "offer", event_date: "2026-10-06" }), 409); // 面接完了前は内定不可
  await add(store, 1, { kind: "interview_completed", event_date: "2026-10-05" });
  assert.deepEqual(kinds(await view(store, 1)), ["interview_scheduled", "offer", "rejected", "declined"]);
  await add(store, 1, { kind: "offer", event_date: "2026-10-10" });
  assert.equal(c.status, "5"); assert.equal(c.offer_date, "2026-10-10");
  await add(store, 1, { kind: "join_planned", event_date: "2026-11-01" });
  assert.equal(c.expected_join_date, "2026-11-01"); assert.equal(c.status, "5");
  const v = await view(store, 1);
  const joined = v.actions.find(a => a.kind === "joined");
  assert.equal(joined.label, "入社済みにする");
  assert.ok(joined.confirm);
  assert.equal(joined.default_date, "2026-11-01");
  await add(store, 1, { kind: "joined", event_date: "2026-11-01" });
  assert.equal(c.status, "6");
  assert.deepEqual((await view(store, 1)).actions, []);
});

test("cancelling a planned join records the original date and the offer decline date", async () => {
  const { candidates, store } = setup(person(1, { status: 5, interview_1_date: "2026-09-02", offer_date: "2026-10-01", expected_join_date: "2026-11-01" }));
  let v = await view(store, 1);
  const decline = v.actions.find(a => a.kind === "declined");
  assert.equal(decline.label, "内定辞退");
  assert.equal(decline.date_label, "内定辞退日");
  assert.match(decline.confirm, /元の入社予定日は履歴に残ります/);
  await rejectsWith(add(store, 1, { kind: "declined", event_date: "2026-10-20" }), 400); // 理由必須
  v = await add(store, 1, { kind: "declined", event_date: "2026-10-20", note: "他社に決定" });
  const c = candidates[0];
  assert.equal(c.status, "9");
  assert.equal(c.decline_reason, "内定辞退: 他社に決定");
  assert.equal(c.expected_join_date, "2026-11-01");
  assert.deepEqual(v.records.map(r => [r.label, r.event_date]), [
    ["1次面接（予定）", "2026-09-02"], ["1次面接（完了）", null], ["内定通知", "2026-10-01"], ["入社予定", "2026-11-01"], ["内定辞退", "2026-10-20"],
  ]);
  assert.equal(v.records.at(-1).ended_stage, "内定");
});

test("no contact becomes a rejection with the stage recorded; declined and rejected keep reasons", async () => {
  const { candidates, store } = setup(person(1), person(2), person(3));
  await add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-05" });
  await add(store, 1, { kind: "no_contact", event_date: "2026-10-06" });
  assert.equal(candidates[0].status, "9");
  assert.equal(candidates[0].decline_reason, "1次面接音信不通（不採用）");
  await add(store, 2, { kind: "declined", event_date: "2026-10-03", note: "家庭の事情" });
  assert.equal(candidates[1].decline_reason, "応募辞退: 家庭の事情");
  await add(store, 3, { kind: "document_received", event_date: "2026-10-02" });
  await add(store, 3, { kind: "rejected", event_date: "2026-10-04", note: "経験不足" });
  assert.equal(candidates[2].decline_reason, "書類選考不採用: 経験不足");
});

test("corrections and cancellations are appended; original events are never changed or removed", async () => {
  const { candidates, store } = setup(person(1));
  await add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-05", attendee: "課長" });
  await add(store, 1, { kind: "interview_completed", event_date: "2026-10-05" });
  await add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-12", attendee: "部長" });
  const before = store.log(1);
  let v = await view(store, 1);
  const first = v.records[0];
  v = await correct(store, 1, first.id, { event_date: "2026-10-06", reason: "日程変更" });
  assert.equal(candidates[0].interview_1_date, "2026-10-06");
  assert.equal(v.records[0].event_date, "2026-10-06");
  assert.equal(v.records[0].original_date, "2026-10-05");
  assert.equal(v.records[0].corrected, true);
  // 2次面接予定を取消 → 2次面接日・同席者が消え、status は 1次面接へ戻る
  v = await cancel(store, 1, v.records.at(-1).id, { reason: "誤登録" });
  const c = candidates[0];
  assert.equal(c.status, "3");
  assert.equal(c.interview_2_date, null);
  assert.equal(c.interview_2_attendee, null);
  assert.equal(v.records.length, 2);
  const after = store.log(1);
  // 既存の行は1件も変わらず、末尾に追記されただけ
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length).map(e => e.kind), ["correction", "void"]);
  assert.deepEqual(v.history.slice(-2).map(h => h.label), ["訂正：1次面接（予定）", "取消：2次面接（予定）"]);
  assert.equal(v.history.at(-1).reason, "誤登録");
  assert.equal(after.at(-1).actor, actor);
});

test("only the latest step can be cancelled; double cancel and stale screens are refused", async () => {
  const { candidates, store } = setup(person(1));
  await add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-05" });
  await add(store, 1, { kind: "no_contact", event_date: "2026-10-06" });
  let v = await view(store, 1);
  const terminal = v.records.at(-1);
  await rejectsWith(cancel(store, 1, v.records[0].id), 409);
  const stale = v.version;
  v = await cancel(store, 1, terminal.id);
  assert.equal(candidates[0].status, "3");
  assert.equal(candidates[0].decline_reason, null);
  await rejectsWith(service.voidStep(store, 1, terminal.id, { expected_version: stale }, actor), 409, "stale");
  await rejectsWith(cancel(store, 1, terminal.id), 409); // 取消済み
  await rejectsWith(correct(store, 1, terminal.id, { event_date: "2026-10-07" }), 409);
  await rejectsWith(cancel(store, 1, "999"), 404);
  // 取消と再登録を繰り返しても状態・日付・履歴が整合する
  for (let i = 0; i < 3; i += 1) {
    await add(store, 1, { kind: "declined", event_date: "2026-10-08", note: `理由${i}` });
    assert.equal(candidates[0].decline_reason, `1次面接辞退: 理由${i}`);
    v = await view(store, 1);
    await cancel(store, 1, v.records.at(-1).id);
    assert.equal(candidates[0].status, "3");
    assert.equal(candidates[0].decline_reason, null);
  }
  v = await view(store, 1);
  assert.equal(v.records.length, 1);
  assert.equal(store.log(1).filter(e => e.kind === "void").length, 4);
});

test("existing status 2 is kept as is and offers 1st interview, decline and no contact", async () => {
  const { candidates, store } = setup(person(1, { status: 2, contact_history: [{ date: "2026-10-03", tel: true, email: false }] }));
  let v = await view(store, 1);
  assert.equal(v.stored, false);
  assert.deepEqual(v.records.map(r => r.label), ["面接打診"]);
  assert.deepEqual(kinds(v), ["interview_scheduled", "declined", "no_contact"]);
  // 受付日・連絡履歴の変更では status 2 を書き換えない
  v = await service.setAppliedDate(store, 1, { expected_version: v.version, date: "2026-09-30" }, actor);
  v = await service.setContactHistory(store, 1, { expected_version: v.version, contact_history: [{ date: "2026-10-04", tel: true }] }, actor);
  assert.equal(candidates[0].status, 2);
  assert.equal(candidates[0].applied_at, "2026-09-30");
  assert.deepEqual(store.log(1).map(e => e.kind), ["baseline", "contacting", "applied_date_changed", "contact_history_changed"]);
  assert.equal(store.log(1)[0].payload.status, "2");
  await add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-10" });
  assert.equal(candidates[0].status, "3");
});

test("consistent existing data is stored as baseline + legacy steps without changing any value", async () => {
  const rows = [
    person(1), person(2, { status: 2 }), person(3, { status: 3, interview_1_date: "2026-10-05" }),
    person(4, { status: 4, interview_1_date: "2026-10-05", interview_2_date: "2026-10-09", interview_2_attendee: " 部長 " }),
    person(5, { status: 5, interview_1_date: "2026-10-05", offer_date: "2026-10-10", expected_join_date: "2026-11-01" }),
    person(6, { status: 5 }), person(7, { status: 6, offer_date: "2026-10-10", expected_join_date: "2026-10-15" }),
    person(8, { status: 9, interview_1_date: "2026-10-05", decline_reason: "1次面接辞退: 他社決定" }),
    person(9, { status: 9, decline_reason: null }), person(10, { status: 3, decline_reason: "古い理由", interview_2_attendee: "古い同席者" }),
  ];
  const { candidates, store } = setup(...rows);
  const original = JSON.parse(JSON.stringify(candidates));
  for (const c of original) {
    const v = await view(store, c.id);
    assert.deepEqual(v.sync_issues, [], `candidate ${c.id}`);
    await service.setAppliedDate(store, c.id, { expected_version: v.version, date: c.applied_at }, actor); // 履歴化だけを起こす
  }
  assert.deepEqual(candidates.map(c => ({ ...c })), original);
  // 元から持っていた値は、関係する工程が無ければ消さない
  const v10 = await view(store, 10);
  await add(store, 10, { kind: "interview_completed", event_date: "2026-10-06" });
  assert.equal(candidates[9].decline_reason, "古い理由");
  assert.equal(candidates[9].interview_2_attendee, "古い同席者");
  assert.ok(v10.stored);
});

test("inconsistent existing data is refused with 409 and never auto-corrected", async () => {
  const { candidates, store } = setup(
    person(1, { status: 1, offer_date: "2026-10-01" }),
    person(2, { status: 2, interview_1_date: "2026-10-05" }),
    person(3, { status: 3, interview_2_date: "2026-10-09" }),
  );
  const original = JSON.parse(JSON.stringify(candidates));
  for (const id of [1, 2, 3]) {
    const v = await view(store, id);
    assert.ok(v.sync_issues.length > 0, `candidate ${id}`);
    assert.deepEqual(v.actions, []);
    await rejectsWith(service.addStep(store, id, { expected_version: v.version, kind: "declined", event_date: "2026-10-10", note: "x" }, actor), 409, "out_of_sync");
    await rejectsWith(service.correctStep(store, id, "legacy-0", { expected_version: v.version, event_date: "2026-10-10" }, actor), 409, "out_of_sync");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(candidates)), original);
  for (const id of [1, 2, 3]) assert.deepEqual(store.log(id), []);
});

test("changes made outside the history (old code after rollback) stop further updates with 409", async () => {
  const { candidates, store } = setup(person(1));
  await add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-05" });
  candidates[0].status = "5"; // 旧コードのPUTで直接変更された想定
  await rejectsWith(add(store, 1, { kind: "interview_completed", event_date: "2026-10-05" }), 409, "out_of_sync");
  const v = await view(store, 1);
  assert.deepEqual(v.sync_issues, ["進捗"]);
  assert.equal(candidates[0].status, "5");
});

test("a failure in the middle rolls back history and candidate columns together", async () => {
  const candidates = [person(1, { status: 3, interview_1_date: "2026-10-05" })];
  const store = createMemorySelectionStore(candidates, { failOn: "updateMirror" });
  const v = await service.getTimeline(store, 1);
  await assert.rejects(service.addStep(store, 1, { expected_version: v.version, kind: "interview_completed", event_date: "2026-10-05" }, actor));
  assert.deepEqual(store.log(1), []);
  assert.equal(candidates[0].status, 3);
});

test("invalid inputs are rejected without any change", async () => {
  const { candidates, store } = setup(person(1));
  await rejectsWith(add(store, 1, { kind: "offer", event_date: "2026-10-05" }), 409);
  await rejectsWith(add(store, 1, { kind: "contacting", event_date: "2026-10-05" }), 409);
  for (const date of ["0000-10-05", "202610-10-05", "2026-02-30", "", undefined])
    await rejectsWith(add(store, 1, { kind: "interview_scheduled", event_date: date }), 400);
  await rejectsWith(add(store, 1, { kind: "interview_scheduled", event_date: "2026-10-05", note: "x".repeat(1001) }), 400);
  await rejectsWith(service.setContactHistory(store, 1, { expected_version: (await view(store, 1)).version, contact_history: [{ date: "202610-01-01" }] }, actor), 400);
  assert.deepEqual(store.log(1), []);
  assert.equal(candidates[0].status, 1);
});

test("cooperative records, missing records and a missing history table are refused", async () => {
  const { store } = setup(person(1, { is_coop: true }));
  await rejectsWith(view(store, 1), 400);
  await rejectsWith(view(store, 99), 404);
  const offline = createMemorySelectionStore([person(1)], { ready: false });
  await rejectsWith(service.getTimeline(offline, 1), 503, "selection_unavailable");
});

test("PostgreSQL mirror update only touches derived columns and references each parameter once", () => {
  assert.equal(mirrorUpdate(7, {}), null);
  const { sql, params } = mirrorUpdate(7, { status: "3", interview_1_date: "2026-10-05" });
  assert.equal(sql, "UPDATE public.candidates SET status = $2, interview_1_date = $3::date WHERE id = $1");
  assert.deepEqual(params, [7, "3", "2026-10-05"]);
});

test("applied date change keeps the Tokyo time of day", () => {
  const old = new Date("2026-10-01T01:30:00Z"); // 日本時間 10:30
  assert.equal(shiftedAppliedAt(old, "2026-09-28").toISOString(), "2026-09-28T01:30:00.000Z");
  assert.equal(shiftedAppliedAt(null, "2026-10-05").toISOString(), "2026-10-04T15:00:00.000Z");
  // 日本時間の日付が UTC と異なる時刻（日本時間 2026-10-02 08:00）
  assert.equal(shiftedAppliedAt(new Date("2026-10-01T23:00:00Z"), "2026-10-05").toISOString(), "2026-10-04T23:00:00.000Z");
  // 0〜99年も1900年代に読み替えない（R1-02）
  assert.equal(shiftedAppliedAt(old, "0099-10-23").toISOString(), "0099-10-23T01:30:00.000Z");
  assert.equal(shiftedAppliedAt(new Date("0050-03-01T01:30:00Z"), "2026-10-01").toISOString(), old.toISOString());
  assert.equal(shiftedAppliedAt(null, "0099-10-23").toISOString(), "0099-10-22T15:00:00.000Z");
});

test("the read-only precheck SQL uses the same consistency rule as the API", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../tools/sql/selection_precheck_readonly.sql"), "utf8");
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/i);
  // SQL の NG 判定（status ごとに許されない日付）を再現し、API の判定と全組み合わせで一致することを確認
  const ng = (st, i1, i2, offer, joinp) => {
    if (!["1", "2", "3", "4", "5", "6", "9"].includes(st)) return true; // 未定義の status は日付に関係なく停止
    if (st === "1") return i2 || offer || joinp; // 受付＋1次面接日のみは互換扱い
    if (st === "2") return i1 || i2 || offer || joinp;
    if (st === "3") return i2 || offer || joinp;
    if (st === "4") return offer || joinp;
    return false;
  };
  for (const st of ["1", "2", "3", "4", "5", "6", "9", "7", "0", ""]) {
    for (let bits = 0; bits < 16; bits += 1) {
      const [i1, i2, offer, joinp] = [1, 2, 4, 8].map(b => Boolean(bits & b));
      const c = person(1, {
        status: st, interview_1_date: i1 ? "2026-10-01" : null, interview_2_date: i2 ? "2026-10-02" : null,
        offer_date: offer ? "2026-10-03" : null, expected_join_date: joinp ? "2026-10-04" : null,
      });
      const all = flow.legacyEvents(c);
      assert.equal(flow.syncIssues(c, all, all).length > 0, ng(st, i1, i2, offer, joinp), `status ${st} bits ${bits}`);
    }
  }
  // 日付の範囲判定（7・9）は PostgreSQL 版の保存先と同じ境界（西暦1〜9999年）
  const pg = fs.readFileSync(path.join(__dirname, "../selectionPgStore.js"), "utf8");
  assert.match(pg, /BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN to_char/);
  assert.equal((sql.match(/NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'/g) || []).length, 8);
  for (const column of ["interview_1_date", "interview_2_date", "offer_date", "expected_join_date"]) {
    assert.match(sql, new RegExp(`${column} NOT BETWEEN DATE`), column);
  }
});

test("the precheck SQL is read-only and outputs counts and structure only (no personal information)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../tools/sql/selection_precheck_readonly.sql"), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /\b(SET|BEGIN|COMMIT|ROLLBACK|DO|COPY|CALL|LOCK|VACUUM|ANALYZE|EXECUTE|PREPARE|nextval|setval|pg_terminate_backend|pg_cancel_backend)\b/i);
  assert.doesNotMatch(code, /SELECT\s+\*/i);
  assert.doesNotMatch(code, /\b(name_kanji|name_kana|tel|email|address\w*|zip_code|birth_\w+|emerg_\w+|family|memo|motivation_memo|interview_2_memo|resume_memo|qa_1|qa_2)\b/i);
  // 理由の文面・同席者名・連絡履歴の中身は出力しない（列名の一覧と件数の判定にのみ使う）
  for (const statement of code.split(";")) {
    const select = /SELECT([\s\S]*?)\bFROM\b/i.exec(statement)?.[1] || "";
    assert.doesNotMatch(select.replace(/count\(\*\) FILTER \([\s\S]*?\) AS \w+/g, "").replace(/'[^']*'/g, ""),
      /\b(decline_reason|interview_2_attendee|contact_history|applied_at)\b(?!::text)/, statement.slice(0, 80));
  }
});

test("undefined statuses and unreadable dates stop selection updates without touching the values", async () => {
  const { candidates, store } = setup(
    person(1, { status: 7 }), person(2, { status: null }),
    person(3, { status: 3, interview_1_date: "12345-01-01" }), // 5桁年（保存先からは "invalid:元の値" として渡る）
    person(4, { status: 1, offer_date: "invalid" }), person(5, { status: 5, expected_join_date: "invalid" }),
  );
  const original = JSON.parse(JSON.stringify(candidates));
  for (const c of original) {
    const v = await view(store, c.id);
    assert.ok(v.sync_issues.length > 0, `candidate ${c.id}`);
    assert.deepEqual(v.actions, []);
    await rejectsWith(service.addStep(store, c.id, { expected_version: v.version, kind: "declined", event_date: "2026-10-10", note: "x" }, actor), 409, "out_of_sync");
  }
  assert.deepEqual((await view(store, 1)).sync_issues, ["進捗"]);
  assert.deepEqual((await view(store, 3)).sync_issues, ["1次面接日"]);
  assert.deepEqual(JSON.parse(JSON.stringify(candidates)), original);
  for (const c of original) assert.deepEqual(store.log(c.id), []);
  // 受付日の変更（選考の工程に関わらない）で履歴化した場合も、読み取れない日付は元の文字列のまま基準値に残す
  const v3 = await view(store, 3);
  await service.setAppliedDate(store, 3, { expected_version: v3.version, date: "2026-10-02" }, actor);
  assert.equal(store.log(3)[0].payload.interview_1_date, "invalid:12345-01-01");
  assert.equal(candidates[2].interview_1_date, "12345-01-01");
});

test("the PUT conflict rule: type change with history first, then stale selection columns", () => {
  const rule = args => flow.candidatePutConflict({ managed: true, currentIsCoop: false, nextIsCoop: false, hasHistory: false, body: {}, ...args })?.code ?? null;
  assert.equal(rule({}), null);
  assert.equal(rule({ nextIsCoop: true, hasHistory: true }), "coop_change_has_history");
  assert.equal(rule({ currentIsCoop: true, nextIsCoop: false, hasHistory: true, body: { status: "1" } }), "coop_change_has_history");
  assert.equal(rule({ nextIsCoop: true, hasHistory: false }), null);
  assert.equal(rule({ currentIsCoop: true, nextIsCoop: true, hasHistory: true, body: { status: "9" } }), null);
  assert.equal(rule({ body: { status: "3" } }), "selection_fields_rejected");
  assert.equal(rule({ managed: false, nextIsCoop: true, hasHistory: true, body: { status: "3" } }), null);
});

// --- 従来データ：受付（status 1）のまま1次面接日だけが登録されている応募者 ---
const today = flow.todayTokyo();
const shiftDay = days => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

test("status 1 with only a 1st interview date (future or past) is kept as is and shown as a scheduled 1st interview", async () => {
  for (const date of [shiftDay(14), shiftDay(-14)]) {
    const { candidates, store } = setup(person(1, { status: 1, interview_1_date: date }));
    const original = JSON.parse(JSON.stringify(candidates));
    let v = await view(store, 1);
    assert.deepEqual(v.sync_issues, [], date);
    assert.equal(v.status, "1");
    assert.deepEqual(v.records.map(r => [r.label, r.event_date, r.source]), [["1次面接（予定）", date, "legacy"]]);
    assert.equal(v.notices.length, 1);
    assert.match(v.notices[0], /推定していません/);
    // 過去日でも実施済みと推定しない：完了は利用者の明示操作で、実施日は空欄から入力
    assert.deepEqual(kinds(v), ["interview_completed", "declined", "no_contact"]);
    const done = v.actions[0];
    assert.equal(done.default_date, null);
    assert.equal(done.date_must_be_entered, true);
    assert.match(done.confirm, new RegExp(`1次面接日（${date}）`));
    assert.ok(!v.records.some(r => r.kind === "interview_completed"));
    // 閲覧・受付日の変更（履歴化）では既存値を変えない
    await service.setAppliedDate(store, 1, { expected_version: v.version, date: "2026-10-01" }, actor);
    assert.deepEqual(JSON.parse(JSON.stringify(candidates)), original);
    v = await view(store, 1);
    assert.equal(v.stored, true);
    assert.deepEqual(v.sync_issues, []);
    assert.equal(v.notices.length, 1);
    assert.deepEqual(store.log(1).map(e => e.kind), ["baseline", "interview_scheduled", "applied_date_changed"]);
    assert.deepEqual(store.log(1)[1].payload, { legacy_status: "1" });
    // 実施日の入力が無ければ登録しない
    await rejectsWith(add(store, 1, { kind: "interview_completed", event_date: "" }), 400);
    assert.equal(candidates[0].status, 1);
    // 明示的に完了を登録した時点で初めて 1次面接（status 3）になる。面接日はそのまま
    v = await add(store, 1, { kind: "interview_completed", event_date: date });
    assert.equal(candidates[0].status, "3");
    assert.equal(candidates[0].interview_1_date, date);
    assert.deepEqual(v.notices, []);
  }
});

test("the legacy scheduled interview can be corrected, declined or cancelled without guessing completion", async () => {
  const future = shiftDay(10);
  const { candidates, store } = setup(person(1, { status: 1, interview_1_date: future }), person(2, { status: 1, interview_1_date: future }),
    person(3, { status: 1, interview_1_date: future }));
  // 訂正：日付だけ変わり、status は受付のまま
  let v = await view(store, 1);
  v = await correct(store, 1, v.records[0].id, { event_date: shiftDay(12), reason: "日程変更" });
  assert.equal(String(candidates[0].status), "1");
  assert.equal(candidates[0].interview_1_date, shiftDay(12));
  assert.equal(v.notices.length, 1);
  assert.deepEqual(kinds(v), ["interview_completed", "declined", "no_contact"]);
  // 辞退：利用者の明示操作で終了（段階は1次面接）
  await add(store, 2, { kind: "declined", event_date: today, note: "架空の理由" });
  assert.equal(candidates[1].status, "9");
  assert.equal(candidates[1].decline_reason, "1次面接辞退: 架空の理由");
  // 取消：予定を取り消すと受付に戻り、1次面接日は空になる（元の日付は履歴に残る）
  v = await view(store, 3);
  v = await cancel(store, 3, v.records[0].id, { reason: "誤登録" });
  assert.equal(candidates[2].status, "1");
  assert.equal(candidates[2].interview_1_date, null);
  assert.equal(store.log(3).find(e => e.kind === "interview_scheduled").event_date, future);
});

test("other inconsistent combinations around status 1 are still refused with 409", async () => {
  const d = shiftDay(5);
  const { candidates, store } = setup(
    person(1, { status: 1, interview_1_date: d, interview_2_date: d }),
    person(2, { status: 1, interview_1_date: d, offer_date: d }),
    person(3, { status: 1, interview_1_date: d, expected_join_date: d }),
    person(4, { status: 1, interview_2_date: d }),
    person(5, { status: 2, interview_1_date: d }),
    person(6, { status: 1, interview_1_date: "12345-01-01" }),
    person(7, { status: 7, interview_1_date: d }),
  );
  const original = JSON.parse(JSON.stringify(candidates));
  for (const c of original) {
    const v = await view(store, c.id);
    assert.ok(v.sync_issues.length > 0, `candidate ${c.id}`);
    assert.deepEqual(v.actions, []);
    assert.deepEqual(v.notices, []);
    await rejectsWith(service.addStep(store, c.id, { expected_version: v.version, kind: "interview_completed", event_date: d }, actor), 409, "out_of_sync");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(candidates)), original);
  // 互換扱いは従来データ由来の行だけ：利用者が登録した1次面接予定は通常どおり status 3
  const fresh = setup(person(9));
  await add(fresh.store, 9, { kind: "interview_scheduled", event_date: d });
  assert.equal(fresh.candidates[0].status, "3");
  assert.deepEqual((await view(fresh.store, 9)).notices, []);
  assert.equal(flow.isUnconfirmedLegacyInterview({ kind: "interview_scheduled", stage_number: 1, source: "user", payload: { legacy_status: "1" } }), false);
});

test("after the first history entry, columns without steps are compared with the baseline (L-01)", async () => {
  const d = shiftDay(5);
  for (const [field, value] of [["offer_date", d], ["interview_2_date", d], ["expected_join_date", d], ["decline_reason", "後から追加"], ["interview_2_attendee", "後から追加"]]) {
    const { candidates, store } = setup(person(1, { status: 1, interview_1_date: d }));
    let v = await view(store, 1);
    await service.setAppliedDate(store, 1, { expected_version: v.version, date: "2026-10-01" }, actor); // 履歴化
    candidates[0][field] = value; // 旧コード等で、工程の無い列だけが変更された想定
    v = await view(store, 1);
    assert.ok(v.sync_issues.length > 0, field);
    assert.deepEqual(v.actions, [], field);
    await rejectsWith(correct(store, 1, v.records[0].id, { event_date: d }), 409, "out_of_sync");
    await rejectsWith(add(store, 1, { kind: "interview_completed", event_date: d }), 409, "out_of_sync");
    assert.equal(candidates[0][field], value, field);
    assert.equal(candidates[0].status, 1, field);
  }
});

test("a date changed before the first history entry makes an open screen stale (L-02)", async () => {
  const { candidates, store } = setup(person(1, { status: 1, interview_1_date: shiftDay(5) }));
  const v = await view(store, 1);
  candidates[0].interview_1_date = shiftDay(8); // 旧コード等で面接日だけが変更された（status は受付のまま）
  await rejectsWith(service.correctStep(store, 1, "legacy-0", { expected_version: v.version, event_date: shiftDay(6) }, actor), 409, "stale");
  await rejectsWith(service.addStep(store, 1, { expected_version: v.version, kind: "declined", event_date: today, note: "x" }, actor), 409, "stale");
  assert.equal(candidates[0].interview_1_date, shiftDay(8));
  assert.deepEqual(store.log(1), []);
});
