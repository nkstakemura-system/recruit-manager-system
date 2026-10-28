// 連絡先の編集（専用API）と和暦入力の変換。DB・ネットワークには接続しない（PostgreSQL版は模擬の接続で確認）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import {
  normalizeContacts, resolvePrimary, contactSnapshot, sameContacts, contactList,
} from "../../shared/contacts.mjs";
import {
  eraDateToDate, eraYearToYear, yearToEras, yearLabel, dateToEra, dateLabel, yearToEraInput, isFourDigitDate,
} from "../../shared/wareki.mjs";

const require = createRequire(import.meta.url);
const { updateContacts, createMemoryContactStore, createPgContactStore } = require("../contactService.js");

const clone = value => JSON.parse(JSON.stringify(value));
const expectStatus = async (promise, status, code) => {
  await assert.rejects(promise, err => err.status === status && (!code || err.code === code));
};

// ---------- 連絡先：保存形式の正規化 ----------
test("contacts: both empty can be saved (primary keeps the registration default)", () => {
  assert.deepEqual(normalizeContacts({ tel: ["", "  "], email: [""], primary_contact: "email_0" }),
    { tel: [], email: [], primary_contact: "tel_0" });
  assert.deepEqual(normalizeContacts({}), { tel: [], email: [], primary_contact: "tel_0" });
});

test("contacts: primary index follows the entry after blanks are removed", () => {
  assert.deepEqual(normalizeContacts({ tel: ["", "090-0000-0001"], email: [], primary_contact: "tel_1" }),
    { tel: ["090-0000-0001"], email: [], primary_contact: "tel_0" });
  assert.deepEqual(normalizeContacts({ tel: ["03-0000-0000"], email: ["", "a@example.invalid", "b@example.invalid"], primary_contact: "email_2" }),
    { tel: ["03-0000-0000"], email: ["a@example.invalid", "b@example.invalid"], primary_contact: "email_1" });
});

test("contacts: a blank or missing primary falls back to the only/first registered contact", () => {
  assert.equal(normalizeContacts({ tel: ["090-0000-0001"], email: [""], primary_contact: "email_0" }).primary_contact, "tel_0");
  assert.equal(normalizeContacts({ tel: [""], email: ["a@example.invalid"], primary_contact: "tel_0" }).primary_contact, "email_0");
  assert.equal(normalizeContacts({ tel: ["090-0000-0001"], email: ["a@example.invalid"], primary_contact: "bogus" }).primary_contact, "tel_0");
  assert.equal(normalizeContacts({ tel: ["090-0000-0001"], email: ["a@example.invalid"], primary_contact: "email_9" }).primary_contact, "tel_0");
});

test("contacts: invalid values are rejected with the field", () => {
  assert.throws(() => normalizeContacts({ email: ["no-at-mark"] }), err => err.field === "email");
  assert.throws(() => normalizeContacts({ email: ["a@b"] }), err => err.field === "email");
  assert.throws(() => normalizeContacts({ tel: ["電話なし"] }), err => err.field === "tel");
  assert.throws(() => normalizeContacts({ tel: ["090\n0000"] }), err => err.field === "tel");
  assert.throws(() => normalizeContacts({ tel: ["0".repeat(31)] }), err => err.field === "tel");
  assert.throws(() => normalizeContacts({ tel: "090-0000-0000" }), err => err.field === "tel");
  assert.throws(() => normalizeContacts({ email: [123] }), err => err.field === "email");
  assert.throws(() => normalizeContacts({ tel: Array.from({ length: 11 }, (_, i) => `090-0000-00${String(i).padStart(2, "0")}`) }), err => err.field === "tel");
  // 複数のTEL・Email（既存の配列形式）は保持する
  assert.deepEqual(normalizeContacts({ tel: ["090-0000-0001", " 03-0000-0002 "], email: ["a@example.invalid", "b@example.invalid"], primary_contact: "tel_1" }),
    { tel: ["090-0000-0001", "03-0000-0002"], email: ["a@example.invalid", "b@example.invalid"], primary_contact: "tel_1" });
});

test("contacts: display primary resolves the same fallback without changing data", () => {
  assert.deepEqual(resolvePrimary({ tel: ["090-0000-0001"], email: ["a@example.invalid"], primary_contact: "email_0" }),
    { kind: "email", index: 0, value: "a@example.invalid" });
  assert.deepEqual(resolvePrimary({ tel: [], email: ["a@example.invalid"], primary_contact: "tel_0" }),
    { kind: "email", index: 0, value: "a@example.invalid" });
  assert.deepEqual(resolvePrimary({ tel: ["090-0000-0001"], email: [], primary_contact: "email_1" }),
    { kind: "tel", index: 0, value: "090-0000-0001" });
  assert.equal(resolvePrimary({ tel: [], email: [], primary_contact: "tel_0" }), null);
  assert.equal(resolvePrimary({ tel: null, email: undefined }), null);
  assert.deepEqual(contactList('["090-0000-0001"]'), ["090-0000-0001"]);
  assert.deepEqual(contactSnapshot({ tel: null, email: undefined, primary_contact: undefined }), { tel: [], email: [], primary_contact: null });
  assert.equal(sameContacts({ tel: ["1"], email: [] }, { tel: ["1"], email: [], primary_contact: null }), true);
  assert.equal(sameContacts({ tel: ["1"] }, { tel: ["1"], primary_contact: "tel_0" }), false);
});

// ---------- 連絡先：専用API（メモリ保存先） ----------
function fixture() {
  return [
    {
      id: 1, name_kanji: "架空・一郎", status: "3", tel: [], email: [], primary_contact: "tel_0",
      birth_date: "1990-05-10", work_history: [{ company: "架空", start_year: "2010" }], licenses: [{ name: "架空", date: "2015" }],
      contact_history: [{ date: "2026-10-01", tel: true, email: false }], interview_1_date: "2026-10-05",
    },
    { id: 2, name_kanji: "架空・二郎", status: "1", tel: ["090-0000-0002"], email: ["b@example.invalid"], primary_contact: "email_0" },
  ];
}
const others = c => { const { tel, email, primary_contact, ...rest } = c; return rest; };

test("contact API: adds TEL/Email to an empty candidate without touching other fields", async () => {
  const candidates = fixture();
  const before = clone(candidates[0]);
  const store = createMemoryContactStore(candidates);
  const saved = await updateContacts(store, 1, {
    tel: ["090-0000-0001"], email: ["a@example.invalid"], primary_contact: "email_0",
    expected: { tel: [], email: [], primary_contact: "tel_0" },
    // 送られても連絡先以外は保存しない
    status: "9", name_kanji: "変更しない", birth_date: "2000-01-01",
  });
  assert.deepEqual(saved, { tel: ["090-0000-0001"], email: ["a@example.invalid"], primary_contact: "email_0" });
  assert.deepEqual(others(candidates[0]), others(before));
  assert.deepEqual(candidates[1], fixture()[1]);
});

test("contact API: edits existing contacts and keeps the chosen primary", async () => {
  const candidates = fixture();
  const store = createMemoryContactStore(candidates);
  const expected = contactSnapshot(candidates[1]);
  await updateContacts(store, 2, { tel: ["090-0000-0009", "03-0000-0000"], email: [""], primary_contact: "tel_1", expected });
  assert.deepEqual(contactSnapshot(candidates[1]), { tel: ["090-0000-0009", "03-0000-0000"], email: [], primary_contact: "tel_1" });
  // 削除して両方空欄にもできる
  await updateContacts(store, 2, { tel: [], email: [], primary_contact: "tel_1", expected: contactSnapshot(candidates[1]) });
  assert.deepEqual(contactSnapshot(candidates[1]), { tel: [], email: [], primary_contact: "tel_0" });
});

test("contact API: stale screen is rejected with 409 and nothing is written", async () => {
  const candidates = fixture();
  const store = createMemoryContactStore(candidates);
  const stale = contactSnapshot(candidates[1]);
  await updateContacts(store, 2, { tel: ["090-0000-0003"], email: ["b@example.invalid"], primary_contact: "tel_0", expected: stale });
  const after = clone(candidates[1]);
  await assert.rejects(
    updateContacts(store, 2, { tel: [], email: ["c@example.invalid"], primary_contact: "email_0", expected: stale }),
    err => err.status === 409 && err.code === "contact_conflict" && err.current.tel[0] === "090-0000-0003",
  );
  assert.deepEqual(candidates[1], after);
});

test("contact API: concurrent saves from the same screen state -> one succeeds, one 409", async () => {
  const candidates = fixture();
  const store = createMemoryContactStore(candidates);
  const expected = contactSnapshot(candidates[0]);
  const results = await Promise.allSettled([
    updateContacts(store, 1, { tel: ["090-0000-0011"], email: [], primary_contact: "tel_0", expected }),
    updateContacts(store, 1, { tel: [], email: ["z@example.invalid"], primary_contact: "email_0", expected }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
});

test("contact API: missing expected, invalid input and unknown candidate", async () => {
  const candidates = fixture();
  const before = clone(candidates);
  const store = createMemoryContactStore(candidates);
  await expectStatus(updateContacts(store, 1, { tel: ["090-0000-0001"] }), 400, "expected_required");
  await expectStatus(updateContacts(store, 1, null), 400, "expected_required");
  await expectStatus(updateContacts(store, 1, { email: ["bad"], expected: contactSnapshot(candidates[0]) }), 400, "invalid_contact");
  await expectStatus(updateContacts(store, 999, { tel: [], expected: { tel: [], email: [] } }), 404, "not_found");
  assert.deepEqual(candidates, before);
});

// ---------- 連絡先：PostgreSQL保存先（模擬の接続でSQLの流れを確認） ----------
function fakeDb(row, { failSelect } = {}) {
  const log = [];
  let released = 0;
  const client = {
    async query(sql, params) {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (failSelect && sql.startsWith("SELECT")) throw Object.assign(new Error("bad id"), { code: failSelect });
      if (sql.startsWith("SELECT")) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
    release() { released += 1; },
  };
  return { db: { connect: async () => client }, log, released: () => released };
}

test("contact PG store: locks the row, updates only the 3 contact columns, commits", async () => {
  const { db, log, released } = fakeDb({ tel: ["090-0000-0001"], email: [], primary_contact: "tel_0" });
  await updateContacts(createPgContactStore(db), "7", {
    tel: ["090-0000-0001"], email: ["a@example.invalid"], primary_contact: "email_0",
    expected: { tel: ["090-0000-0001"], email: [], primary_contact: "tel_0" },
  });
  assert.deepEqual(log.map(q => q.sql), [
    "BEGIN",
    "SELECT tel, email, primary_contact FROM candidates WHERE id = $1 FOR UPDATE",
    "UPDATE candidates SET tel = $2, email = $3, primary_contact = $4 WHERE id = $1",
    "COMMIT",
  ]);
  assert.deepEqual(log[1].params, ["7"]);
  assert.deepEqual(log[2].params, ["7", '["090-0000-0001"]', '["a@example.invalid"]', "email_0"]);
  assert.equal(released(), 1);
});

test("contact PG store: conflict / not found roll back without UPDATE", async () => {
  const conflict = fakeDb({ tel: ["090-0000-0002"], email: [], primary_contact: "tel_0" });
  await expectStatus(updateContacts(createPgContactStore(conflict.db), "7", { tel: [], expected: { tel: [], email: [] } }), 409);
  assert.deepEqual(conflict.log.map(q => q.sql.split(" ")[0]), ["BEGIN", "SELECT", "ROLLBACK"]);
  assert.equal(conflict.released(), 1);
  const missing = fakeDb(null);
  await expectStatus(updateContacts(createPgContactStore(missing.db), "7", { tel: [], expected: { tel: [], email: [] } }), 404);
  const badId = fakeDb(null, { failSelect: "22P02" });
  await expectStatus(updateContacts(createPgContactStore(badId.db), "x", { tel: [], expected: { tel: [], email: [] } }), 404);
  assert.deepEqual(badId.log.map(q => q.sql.split(" ")[0]), ["BEGIN", "SELECT", "ROLLBACK"]);
  // 型の不一致以外のDBエラーは500（そのまま投げる）
  const broken = fakeDb(null, { failSelect: "57014" });
  await assert.rejects(updateContacts(createPgContactStore(broken.db), "7", { tel: [], expected: { tel: [], email: [] } }), err => err.code === "57014");
});

test("server: full-field PUT no longer writes contacts; contact route uses session auth", () => {
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /tel=COALESCE\(\$5, tel\), email=COALESCE\(\$6, email\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(b\.(tel|email)/);
  assert.doesNotMatch(source, /primary_contact\s*=\s*\$/);
  const auth = source.indexOf('app.use("/api", auth.requireSession)');
  const route = source.indexOf('app.patch("/api/candidates/:id/contacts"');
  assert.ok(auth > 0 && route > auth, "連絡先APIはログイン必須の範囲に置く");
});

// ---------- 和暦 ----------
test("wareki: era boundaries for full dates (昭和64年・平成元年・平成31年・令和元年)", () => {
  assert.deepEqual(eraDateToDate("showa", "64", "1", "7"), { date: "1989-01-07" });
  assert.match(eraDateToDate("showa", "64", "1", "8").error, /昭和は/);
  assert.deepEqual(eraDateToDate("heisei", "元", "1", "8"), { date: "1989-01-08" });
  assert.deepEqual(eraDateToDate("heisei", "1", "1", "8"), { date: "1989-01-08" });
  assert.match(eraDateToDate("heisei", "1", "1", "7").error, /平成は/);
  assert.deepEqual(eraDateToDate("heisei", "31", "4", "30"), { date: "2019-04-30" });
  assert.match(eraDateToDate("heisei", "31", "5", "1").error, /平成は/);
  assert.deepEqual(eraDateToDate("reiwa", "1", "5", "1"), { date: "2019-05-01" });
  assert.match(eraDateToDate("reiwa", "1", "4", "30").error, /令和は/);
  assert.deepEqual(eraDateToDate("showa", "1", "12", "25"), { date: "1926-12-25" });
  assert.match(eraDateToDate("showa", "1", "12", "24").error, /昭和は/);
  assert.deepEqual(eraDateToDate("showa", "２", "５", "１０"), { date: "1927-05-10" });
  assert.deepEqual(eraDateToDate("heisei", "4", "2", "29"), { date: "1992-02-29" });
});

test("wareki: invalid dates and years are rejected", () => {
  assert.match(eraDateToDate("heisei", "2", "2", "30").error, /存在しない/);
  assert.match(eraDateToDate("heisei", "3", "2", "29").error, /存在しない/);
  assert.match(eraDateToDate("heisei", "2", "13", "1").error, /月日/);
  assert.match(eraDateToDate("heisei", "2", "0", "1").error, /月日/);
  assert.match(eraDateToDate("heisei", "0", "1", "1").error, /年/);
  assert.match(eraDateToDate("taisho", "1", "1", "1").error, /元号/);
  assert.match(eraYearToYear("showa", "65").error, /64年まで/);
  assert.match(eraYearToYear("heisei", "32").error, /31年まで/);
  assert.match(eraYearToYear("reiwa", "-1").error, /年/);
  assert.match(eraYearToYear("reiwa", "123456").error, /年/);
  assert.match(eraYearToYear("reiwa", "abc").error, /年/);
  assert.match(eraYearToYear("reiwa", "7982").error, /令和は/);
  for (const bad of ["123456-01-01", "+12345-01-01", "0000-01-01", "2023-02-29", "2024-13-01", "20240101", "", null]) {
    assert.equal(isFourDigitDate(bad), false, String(bad));
  }
  assert.equal(isFourDigitDate("2024-02-29"), true);
});

test("wareki: year-only fields convert without guessing the month", () => {
  assert.deepEqual(eraYearToYear("showa", "64"), { year: 1989 });
  assert.deepEqual(eraYearToYear("heisei", "元"), { year: 1989 });
  assert.deepEqual(eraYearToYear("heisei", "31"), { year: 2019 });
  assert.deepEqual(eraYearToYear("reiwa", "元"), { year: 2019 });
  assert.deepEqual(eraYearToYear("showa", "1"), { year: 1926 });
  assert.deepEqual(eraYearToYear("reiwa", "8"), { year: 2026 });
  assert.equal(yearLabel("1989"), "昭和64年・平成元年");
  assert.equal(yearLabel("2019"), "平成31年・令和元年");
  assert.equal(yearLabel("1926"), "昭和元年");
  assert.equal(yearLabel("2007"), "平成19年");
  assert.equal(yearLabel("1925"), "");
  assert.equal(yearLabel("123456"), "");
  assert.equal(yearLabel("2015年4月"), "");
  assert.deepEqual(yearToEras("1989").map(e => e.eraId), ["showa", "heisei"]);
});

test("wareki: toggling to wareki input never changes the saved western year", () => {
  for (let year = 1926; year <= 2040; year += 1) {
    const input = yearToEraInput(String(year));
    assert.deepEqual(eraYearToYear(input.eraId, input.year), { year }, String(year));
  }
  assert.equal(yearToEraInput("2015年4月"), null);
  assert.equal(yearToEraInput(""), null);
  for (const date of ["1926-12-25", "1989-01-07", "1989-01-08", "2019-04-30", "2019-05-01", "1990-05-10", "2026-10-28"]) {
    const era = dateToEra(date);
    assert.deepEqual(eraDateToDate(era.eraId, String(era.year), String(era.month), String(era.day)), { date }, date);
  }
});

test("wareki: labels for western dates", () => {
  assert.equal(dateLabel("1989-01-07"), "昭和64年1月7日");
  assert.equal(dateLabel("1989-01-08"), "平成元年1月8日");
  assert.equal(dateLabel("2019-04-30"), "平成31年4月30日");
  assert.equal(dateLabel("2019-05-01"), "令和元年5月1日");
  assert.equal(dateLabel("1926-12-24"), "");
  assert.equal(dateLabel("123456-01-01"), "");
  assert.equal(dateToEra("2019-02-30"), null);
});
