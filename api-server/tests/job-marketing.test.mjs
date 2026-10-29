// 求人マーケティング分析（第4弾）。CSV解析・率・月次集計・比較・自動分析と、API手順（メモリ保存先）を検証する。
// フィクスチャーは架空のデータ（tests/fixtures/job-marketing）。DBには接続しない。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as jm from "../../shared/jobMarketing.mjs";

const require = createRequire(import.meta.url);
const service = require("../jobMarketingService.js");
const { createMemoryMarketingStore } = require("../jobMarketingMemoryStore.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "job-marketing");
const INDEED = "EngagementSummary_20260901_20260930_fictional.csv";
const LEGACY = "求人マーケティング(架空) - 架空CAD.csv";
const read = name => fs.readFileSync(path.join(fixtures, name));
const rowsOf = name => jm.parseCsv(jm.decodeCsv(read(name)).text);
const actor = "tester@web";
const rejectsWith = (promise, status, code) => assert.rejects(promise, err => err.status === status && (!code || err.code === code));
const hash = n => String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "a");

// CP932 のバイト列（Node の TextDecoder で2バイト文字を逆引きして作る）
function cp932(str) {
  const table = new Map();
  const dec = new TextDecoder("shift_jis");
  for (let lead = 0x81; lead <= 0xfc; lead += 1) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && !table.has(ch)) table.set(ch, [lead, trail]);
    }
  }
  const out = [];
  for (const ch of str) {
    if (ch.charCodeAt(0) < 0x80) out.push(ch.charCodeAt(0));
    else if (table.has(ch)) out.push(...table.get(ch));
    else throw new Error(`cp932 not found: ${ch}`);
  }
  return new Uint8Array(out);
}

const base = (categoryId, extra = {}) => ({
  category_id: categoryId, media: "Indeed", period_start: "2026-09-01", period_end: "2026-09-30", plan_type: "free",
  impressions: 1000, clicks: 50, apply_starts: 5, applies: 3, cost: "", note: "", ...extra,
});
async function setup() {
  const store = createMemoryMarketingStore();
  const data = await service.overview(store);
  const cat = name => data.categories.find(c => c.name === name).id;
  return { store, data, cat };
}

// ---------- 値・率 ----------

test("rates: CTR / ASR / completion / apply rate, with null for missing values and zero denominators", () => {
  const r = jm.rates({ impressions: 1598, clicks: 102, apply_starts: 1, applies: 1 });
  assert.equal(r.ctr.toFixed(2), "6.38");
  assert.equal(r.asr.toFixed(2), "0.98");
  assert.equal(r.completion, 100);
  assert.equal(r.apply_rate.toFixed(2), "0.98");
  const zero = jm.rates({ impressions: 0, clicks: 0, apply_starts: 0, applies: 0 });
  assert.deepEqual(zero, { ctr: null, asr: null, completion: null, apply_rate: null });
  const missing = jm.rates({ impressions: 100, clicks: null, apply_starts: 2, applies: null });
  assert.equal(missing.ctr, null);
  assert.equal(missing.asr, null);
  assert.equal(missing.completion, null);
  assert.equal(jm.fmtRate(null), "—");
  assert.equal(jm.fmtCount(null), "—");
  assert.equal(jm.fmtCount(0), "0");
});

test("counts are non-negative integers, blanks stay null (not zero), cost blank is not 0 yen", () => {
  assert.deepEqual(jm.parseCount(""), { value: null });
  assert.deepEqual(jm.parseCount(null), { value: null });
  assert.deepEqual(jm.parseCount("0"), { value: 0 });
  assert.deepEqual(jm.parseCount("1,598"), { value: 1598 });
  for (const bad of ["-1", "1.5", "abc", -3, 2.2]) assert.equal(jm.parseCount(bad).error, true, String(bad));
  assert.deepEqual(jm.parseCost(""), { value: null });
  assert.deepEqual(jm.parseCost("¥9,300"), { value: 9300 });
  assert.deepEqual(jm.parseCost("474.5"), { value: 474.5 });
  for (const bad of ["-1", "1.234", "無料"]) assert.equal(jm.parseCost(bad).error, true, bad);
  const r = jm.normalizeRecord(base("1", { cost: "", impressions: "", clicks: "0" }));
  assert.equal(r.cost, null);
  assert.equal(r.impressions, null);
  assert.equal(r.clicks, 0);
  assert.ok(jm.recordWarnings(r).some(w => w.includes("無料・0円とはみなしません")));
});

test("record validation: 4-digit dates, period order, plan type required, field errors listed", () => {
  assert.throws(() => jm.normalizeRecord(base("1", { period_start: "26-09-01" })), err => err.status === 400 && /西暦4桁/.test(err.message));
  assert.throws(() => jm.normalizeRecord(base("1", { period_start: "2026-02-30" })), /西暦4桁/);
  assert.throws(() => jm.normalizeRecord(base("1", { period_end: "2026-08-31" })), /終了日は開始日以降/);
  assert.throws(() => jm.normalizeRecord(base("1", { period_end: "2027-12-31" })), /366日以内/);
  assert.throws(() => jm.normalizeRecord(base("1", { plan_type: "" })), /無料／有料／不明/);
  assert.throws(() => jm.normalizeRecord(base("1", { clicks: "-1" })), /クリック数は0以上の整数/);
  assert.throws(() => jm.normalizeRecord(base("1", { cost: "-5" })), /掲載費用は0以上/);
  assert.throws(() => jm.normalizeRecord(base(null)), /職種を選択/);
  const err = (() => { try { jm.normalizeRecord(base("1", { clicks: "x", applies: "y" })); } catch (e) { return e; } })();
  assert.equal(err.fields.length, 2);
});

// ---------- CSV ----------

test("decodes UTF-8 with BOM, UTF-8 without BOM and CP932", () => {
  const withBom = jm.decodeCsv(read(INDEED));
  assert.equal(withBom.encoding, "UTF-8（BOMあり）");
  assert.ok(withBom.text.startsWith("キャンペーン"));
  const plain = jm.decodeCsv(read(LEGACY));
  assert.equal(plain.encoding, "UTF-8");
  const sjisText = "日付,表示回数,クリック数,応募開始数,応募数,費用\r\n2026-09-02,10,1,0,0,\r\n";
  const sjis = jm.decodeCsv(cp932(sjisText));
  assert.equal(sjis.encoding, "CP932（Shift_JIS）");
  assert.equal(sjis.text, sjisText);
  const rows = jm.parseCsv(sjis.text);
  assert.equal(jm.detectFormat(rows), "indeed");
  assert.equal(jm.parseIndeed(rows, "x.csv").groups[0].totals.impressions, 10);
});

test("CSV parser keeps quoted newlines and commas", () => {
  const rows = jm.parseCsv('a,"b,1","line1\nline2",""\r\nx,"say ""hi""",,\n');
  assert.deepEqual(rows, [["a", "b,1", "line1\nline2", ""], ["x", 'say "hi"', "", ""]]);
});

test("Indeed CSV: only actual dates are summed, missing days are listed (not zero), job must be chosen", () => {
  const rows = rowsOf(INDEED);
  assert.equal(jm.detectFormat(rows), "indeed");
  const parsed = jm.parseIndeed(rows, INDEED);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.groups.length, 1);
  const g = parsed.groups[0];
  assert.equal(g.day_count, 23);
  assert.deepEqual(g.period, { start: "2026-09-01", end: "2026-09-30" });
  assert.equal(g.first_date, "2026-09-02");
  assert.equal(g.last_date, "2026-09-25");
  assert.deepEqual(g.totals, { impressions: 2300, clicks: 115, apply_starts: 3, applies: 2, cost: null });
  assert.deepEqual(g.missing_dates, ["2026-09-01", "2026-09-05", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.ok(g.notes.some(n => n.includes("求人ID・職種名が空欄")));
  assert.ok(g.notes.some(n => n.includes("0件として扱わず")));
  assert.ok(g.notes.some(n => n.includes("費用が空欄")));
  assert.equal(g.job_id, null);
  // 応募開始・応募完了の定義を保持する
  assert.match(parsed.definitions.apply_starts, /応募開始数/);
  assert.match(parsed.definitions.applies, /応募数.*完了/);
});

test("Indeed CSV: duplicate dates block the group, blank metric cells make the total unknown, groups by job", () => {
  const head = "日付,表示回数,クリック数,応募開始数,応募数,費用,求人ID,職種名";
  const dup = jm.parseIndeed(jm.parseCsv(`${head}\n2026-09-01,10,1,0,0,,,\n2026-09-01,10,1,0,0,,,\n`), "a.csv");
  assert.equal(dup.groups[0].blocked, true);
  assert.equal(dup.groups[0].totals.impressions, 10, "duplicate rows are not summed");
  const blank = jm.parseIndeed(jm.parseCsv(`${head}\n2026-09-01,10,1,,0,,,\n2026-09-02,10,1,0,0,,,\n,30,2,0,0,,,\n`), "b.csv");
  assert.equal(blank.groups[0].totals.apply_starts, null);
  assert.ok(blank.warnings.some(w => w.includes("日付のない行")));
  const jobs = jm.parseIndeed(jm.parseCsv(`${head}\n2026-09-01,10,1,0,0,100,J1,営業\n2026-09-01,20,2,0,0,50,J2,電気工事士\n`), "c.csv");
  assert.equal(jobs.groups.length, 2);
  assert.deepEqual(jobs.groups.map(g => g.job_title), ["営業", "電気工事士"]);
  assert.equal(jobs.groups[0].totals.cost, 100);
  const bad = jm.parseIndeed(jm.parseCsv(`${head}\n2026/13/01,10,1,0,0,,,\n2026-09-02,-1,1,0,0,,,\n`), "d.csv");
  assert.equal(bad.errors.length, 2);
});

test("legacy CSV: periods without year need confirmation, overlaps are flagged, notes and references are kept", () => {
  const rows = rowsOf(LEGACY);
  assert.equal(jm.detectFormat(rows), "legacy");
  const parsed = jm.parseLegacy(rows, LEGACY);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.needs_year, true);
  assert.equal(parsed.has_ambiguous_apply, true);
  assert.equal(parsed.suggested_category, "架空CAD");
  assert.deepEqual(parsed.columns.map(c => c.period.label), ["8/1～8/31", "8/7～9/7", "9/1~9/30"]);
  assert.deepEqual(parsed.columns.map(c => [c.impressions, c.clicks, c.apply_raw]), [[200, 20, 1], [410, 41, 2], [300, 33, null]]);
  assert.equal(parsed.columns[1].note, "閲覧は多い。\n応募転換は弱い\n\n9/10：架空の備考メモ");
  assert.equal(parsed.columns[2].note, "タイトル変更");
  assert.deepEqual(parsed.references.map(r => r.company_name), ["架空工業株式会社", "架空設計有限会社"]);
  assert.equal(parsed.warnings.filter(w => w.includes("期間が重なって")).length, 2);
  // 年を確認するまで期間は確定しない
  assert.equal(jm.resolveLegacyPeriod(parsed.columns[0].period, ""), null);
  assert.deepEqual(jm.resolveLegacyPeriod(parsed.columns[1].period, 2026), { start: "2026-08-07", end: "2026-09-07" });
  assert.deepEqual(jm.resolveLegacyPeriod(jm.parseLegacyPeriod("12/15～1/14"), 2026), { start: "2026-12-15", end: "2027-01-14" });
  assert.deepEqual(jm.resolveLegacyPeriod(jm.parseLegacyPeriod("2025/9/1～2025/9/30"), null), { start: "2025-09-01", end: "2025-09-30" });
  assert.equal(jm.parseLegacyPeriod("改善案"), null);
});

test("legacy 応募 is assigned only as chosen; unknown keeps the raw value without assigning", () => {
  const col = jm.parseLegacy(rowsOf(LEGACY), LEGACY).columns[1];
  const opts = { categoryId: "1", year: 2026, planType: "unknown" };
  const starts = jm.legacyColumnRecord(col, { ...opts, applyMapping: "apply_starts" });
  assert.equal(starts.apply_starts, 2);
  assert.equal(starts.applies, null);
  const done = jm.legacyColumnRecord(col, { ...opts, applyMapping: "applies" });
  assert.equal(done.applies, 2);
  assert.equal(done.apply_starts, null);
  const unknown = jm.legacyColumnRecord(col, { ...opts, applyMapping: "unknown" });
  assert.equal(unknown.apply_starts, null);
  assert.equal(unknown.applies, null);
  assert.equal(unknown.source_meta.raw.apply, 2);
  assert.match(unknown.source_meta.definitions.apply, /定義不明/);
  assert.equal(unknown.source_meta.year_confirmed, 2026);
  assert.equal(jm.legacyColumnRecord(col, { ...opts, year: "" }), null);
});

test("category hint from the legacy file name is only a suggestion and must be unique", () => {
  const cats = jm.DEFAULT_CATEGORIES.map((name, i) => ({ id: String(i + 1), name }));
  assert.equal(jm.matchCategory(cats, "CADときがわ").name, "CADオペ（ときがわ）");
  assert.equal(jm.matchCategory(cats, "CAD本社").name, "CADオペ（本社）");
  assert.equal(jm.matchCategory(cats, "営業").name, "営業");
  assert.equal(jm.matchCategory(cats, "CAD"), null, "ambiguous");
  assert.equal(jm.matchCategory(cats, "施工管理"), null);
});

// ---------- 月次集計・比較 ----------

const rec = (id, extra) => ({ id: String(id), kind: "metric", category_id: "1", media: "Indeed", plan_type: "free", source: "manual", daily: null, note: null, cost: null, ...extra });

test("monthly aggregate: daily rows count only existing dates; full-month records count; spanning records are excluded", () => {
  const daily = jm.parseIndeed(rowsOf(INDEED), INDEED).groups[0].daily;
  const csv = rec(1, { period_start: "2026-09-01", period_end: "2026-09-30", source: "indeed_csv", daily, impressions: 2300, clicks: 115, apply_starts: 3, applies: 2 });
  const sep = jm.monthAggregate([csv], { categoryId: "1", month: "2026-09", asOf: "2026-10-27" });
  assert.equal(sep.status, "ok");
  assert.equal(sep.covered_days, 23);
  assert.equal(sep.missing_dates.length, 7);
  assert.equal(sep.complete, false);
  assert.equal(sep.totals.impressions, 2300);
  const spanning = rec(2, { period_start: "2026-10-07", period_end: "2026-11-06", impressions: 10, clicks: 1, apply_starts: 0, applies: 0 });
  const oct = rec(3, { period_start: "2026-10-01", period_end: "2026-10-31", impressions: 500, clicks: 40, apply_starts: 2, applies: 1 });
  const octAgg = jm.monthAggregate([oct, spanning], { categoryId: "1", month: "2026-10", asOf: "2026-11-05" });
  assert.equal(octAgg.totals.impressions, 500, "spanning record is not split or added");
  assert.deepEqual(octAgg.spanning, ["2"]);
  assert.equal(octAgg.complete, true);
  // 日別CSVが月をまたぐ場合は、その月の日付だけを計上する
  const cross = rec(4, { period_start: "2026-09-25", period_end: "2026-10-05", daily: [{ date: "2026-09-30", impressions: 5, clicks: 1, apply_starts: 0, applies: 0, cost: null }, { date: "2026-10-01", impressions: 7, clicks: 0, apply_starts: 0, applies: 0, cost: null }] });
  assert.equal(jm.monthAggregate([cross], { categoryId: "1", month: "2026-10", asOf: "2026-11-05" }).totals.impressions, 7);
});

test("monthly aggregate never adds overlapping records and flags mixed plans", () => {
  const a = rec(1, { period_start: "2026-09-01", period_end: "2026-09-30", impressions: 100, clicks: 10, apply_starts: 1, applies: 1 });
  const b = rec(2, { period_start: "2026-09-10", period_end: "2026-09-20", impressions: 50, clicks: 5, apply_starts: 0, applies: 0 });
  const agg = jm.monthAggregate([a, b], { categoryId: "1", month: "2026-09", asOf: "2026-10-27" });
  assert.equal(agg.status, "overlap");
  assert.equal(agg.totals.impressions, null);
  assert.equal(agg.overlap_dates.length, 11);
  const free = rec(3, { period_start: "2026-09-01", period_end: "2026-09-15", impressions: 100, clicks: 10, apply_starts: 1, applies: 1 });
  const paid = rec(4, { period_start: "2026-09-16", period_end: "2026-09-30", plan_type: "paid", cost: 4500, impressions: 300, clicks: 20, apply_starts: 2, applies: 1 });
  const mixed = jm.monthAggregate([free, paid], { categoryId: "1", month: "2026-09", asOf: "2026-10-27" });
  assert.equal(mixed.status, "ok");
  assert.equal(mixed.plan, "mixed");
  assert.equal(mixed.totals.impressions, 400);
  assert.equal(mixed.totals.cost, null, "free period has no cost entered, so total cost is unknown");
});

test("previous-month comparison only when both months are complete, single and same plan", () => {
  const agg = (records, month, asOf = "2026-12-01") => jm.monthAggregate(records, { categoryId: "1", month, asOf });
  const sep = rec(1, { period_start: "2026-09-01", period_end: "2026-09-30", impressions: 1000, clicks: 50, apply_starts: 5, applies: 2 });
  const oct = rec(2, { period_start: "2026-10-01", period_end: "2026-10-31", impressions: 1500, clicks: 90, apply_starts: 6, applies: 4 });
  const ok = jm.comparability(agg([sep, oct], "2026-10"), agg([sep, oct], "2026-09"));
  assert.equal(ok.comparable, true);
  const d = jm.monthDeltas(agg([sep, oct], "2026-10"), agg([sep, oct], "2026-09"));
  assert.equal(d.impressions.pct, 50);
  assert.equal(d.ctr.diff.toFixed(1), "1.0");
  // 初回（前月なし）
  const first = jm.comparability(agg([oct], "2026-10"), agg([oct], "2026-09"));
  assert.equal(first.comparable, false);
  assert.ok(first.reasons.some(r => r.includes("比較データ不足")));
  // 欠損日あり
  const partial = rec(3, { period_start: "2026-09-01", period_end: "2026-09-20", impressions: 600, clicks: 30, apply_starts: 2, applies: 1 });
  const gap = jm.comparability(agg([partial, oct], "2026-10"), agg([partial, oct], "2026-09"));
  assert.equal(gap.comparable, false);
  assert.ok(gap.reasons.some(r => r.includes("20/30日分のみ")));
  // 掲載種別が異なる
  const paidOct = { ...oct, plan_type: "paid", cost: 9000 };
  const plan = jm.comparability(agg([sep, paidOct], "2026-10"), agg([sep, paidOct], "2026-09"));
  assert.equal(plan.comparable, false);
  assert.ok(plan.reasons.some(r => r.includes("掲載種別が異なります")));
  // 集計途中の月
  const running = jm.comparability(agg([sep, oct], "2026-10", "2026-10-27"), agg([sep, oct], "2026-09", "2026-10-27"));
  assert.equal(running.comparable, false);
  assert.ok(running.reasons.some(r => r.includes("集計途中")));
});

test("automatic analysis: rule-based, no causal claims, first month says data is insufficient, never mentions AI", () => {
  const oct = rec(2, { period_start: "2026-10-01", period_end: "2026-10-31", impressions: 3000, clicks: 60, apply_starts: 1, applies: 0, note: "タイトル変更" });
  const current = jm.monthAggregate([oct], { categoryId: "1", month: "2026-10", asOf: "2026-12-01" });
  const previous = jm.monthAggregate([oct], { categoryId: "1", month: "2026-09", asOf: "2026-12-01" });
  const result = jm.analyze({ current, previous, comparison: jm.comparability(current, previous), series: [previous, current] });
  const titles = result.items.map(i => i.title);
  assert.ok(titles.includes("比較データ不足"));
  assert.ok(titles.includes("表示に対してクリックが少ない"), "CTR 2% < 3%");
  assert.ok(titles.includes("クリック後の応募開始率が低い"), "ASR 1.7% < 5%");
  assert.equal(result.trend, "insufficient");
  const all = JSON.stringify(result);
  assert.doesNotMatch(all, /AI|人工知能/);
  assert.doesNotMatch(all, /原因は|が原因/);
  // 小さい母数は保留
  const small = jm.monthAggregate([rec(3, { period_start: "2026-10-01", period_end: "2026-10-31", impressions: 44, clicks: 5, apply_starts: 0, applies: 0 })], { categoryId: "1", month: "2026-10", asOf: "2026-12-01" });
  const smallResult = jm.analyze({ current: small, previous, comparison: jm.comparability(small, previous) });
  assert.ok(smallResult.items.some(i => i.title.includes("母数が少なく")));
  assert.ok(smallResult.items.some(i => i.title.includes("露出が少ない")));
  const summary = jm.summaryText({ category: { name: "架空職種" }, current, previous, comparison: jm.comparability(current, previous), analysis: result });
  assert.match(summary, /外部AI不使用/);
  assert.match(summary, /掲載費用 未入力/);
});

// ---------- 無料・有料 ----------

const ev = (id, extra) => ({ id: String(id), kind: "change", state: "active", category_id: "1", posting_id: null, effective_date: "2026-01-01", status: "free", ...extra });
// 架空の日別データ（日ごとに表示 i*10、クリック i、応募開始・応募は5日に1回）
const fakeDaily = (start, end, scale = 1) => jm.eachDay(start, end).map((date, i) => ({
  date, impressions: 50 * scale, clicks: 2 * scale, apply_starts: i % 5 === 0 ? 1 : 0, applies: i % 10 === 0 ? 1 : 0, cost: null,
}));

test("plan history: free -> paid -> free resolves by date, posting-level events and voids are respected", () => {
  const events = [
    ev(1, { status: "free", effective_date: "2026-07-01" }),
    ev(2, { status: "paid", effective_date: "2026-10-14", budget: 30000 }),
    ev(3, { status: "free", effective_date: "2026-11-10" }),
    ev(4, { status: "paid", effective_date: "2026-08-01", posting_id: "77" }),
    ev(5, { status: "stopped", effective_date: "2026-12-01", state: "voided" }),
  ];
  const at = jm.planResolver(events);
  assert.equal(at("1", null, "2026-06-30"), null, "before the first event the status is unknown (no event)");
  assert.equal(at("1", null, "2026-10-13").status, "free");
  assert.equal(at("1", null, "2026-10-14").status, "paid");
  assert.equal(at("1", null, "2026-11-10").status, "free");
  assert.equal(at("1", null, "2026-12-05").status, "free", "voided change is ignored");
  assert.equal(at("1", "77", "2026-09-01").status, "paid", "posting-level change applies only to that posting");
  assert.equal(at("1", "88", "2026-09-01").status, "free");
  assert.equal(at("1", "77", "2026-10-20").status, "paid");
  assert.equal(at("1", "77", "2026-11-12").status, "free", "a newer category-level change applies to every posting");
  assert.equal(at("2", null, "2026-10-20"), null, "other categories are not affected");
  // 履歴が無料・有料を決めていない日は記録の掲載種別
  assert.equal(jm.dayPlan(at, { category_id: "1", posting_id: null, plan_type: "unknown" }, "2026-06-30"), "unknown");
  assert.equal(jm.dayPlan(at, { category_id: "1", posting_id: null, plan_type: "unknown" }, "2026-10-20"), "paid");
  const states = jm.planEventStates([{ id: "1", kind: "change", status: "paid", effective_date: "2026-10-14" }, { id: "2", kind: "void", supersedes_id: "1", reason: "日付誤り" }]);
  assert.deepEqual(states.map(s => [s.state, s.void_reason]), [["voided", "日付誤り"]]);
  assert.throws(() => jm.validatePlanEvent({ category_id: "1", status: "paid", effective_date: "26-10-14" }), /有料掲載開始日/);
  assert.throws(() => jm.validatePlanEvent({ category_id: "1", status: "paid", effective_date: "20261-10-14" }), /西暦4桁/);
  assert.throws(() => jm.validatePlanEvent({ category_id: "1", status: "other", effective_date: "2026-10-14" }), /掲載状態/);
  assert.equal(jm.validatePlanEvent({ category_id: "1", status: "free", effective_date: "2026-10-14", budget: "5000" }).budget, null, "budget only for paid");
  assert.equal(jm.validatePlanEvent({ category_id: "1", status: "paid", effective_date: "2026-10-14", budget: "" }).budget, null, "blank budget is not 0 yen");
});

test("plan split: daily rows are split exactly at the switch date, totals are never counted twice", () => {
  const events = [ev(1, { status: "free", effective_date: "2026-09-01" }), ev(2, { status: "paid", effective_date: "2026-10-14" })];
  const daily = [...fakeDaily("2026-09-01", "2026-10-13"), ...fakeDaily("2026-10-14", "2026-10-26", 2)].map(d => d.date >= "2026-10-14" ? { ...d, cost: 300 } : d);
  const r = rec(1, { period_start: "2026-09-01", period_end: "2026-10-26", source: "indeed_csv", plan_type: "unknown", daily, impressions: null, clicks: null });
  const split = jm.planSplit([r], { categoryId: "1", start: "2026-01-01", end: "2026-10-31", planAt: jm.planResolver(events) });
  assert.equal(split.free.day_count, 43);
  assert.equal(split.paid.day_count, 13);
  assert.equal(split.free.totals.impressions, 43 * 50);
  assert.equal(split.paid.totals.impressions, 13 * 100);
  assert.equal(split.free.totals.impressions + split.paid.totals.impressions, daily.reduce((s, d) => s + d.impressions, 0), "no day is in both");
  assert.equal(split.free.per_day.impressions, 50);
  assert.equal(split.paid.per_day.impressions, 100);
  assert.equal(split.paid.totals.cost, 3900);
  assert.equal(split.free.totals.cost, null, "free days without cost stay unknown, not 0");
  assert.equal(split.comparable, true);
  assert.equal(Math.round(split.changes.impressions_per_day), 100);
  assert.equal(split.split_unknown, null);
  // 月の途中の切替でも月次の掲載種別は「混在」になり、単純な前月比較はしない
  const oct = jm.monthAggregate([r], { categoryId: "1", month: "2026-10", asOf: "2026-10-27", planAt: jm.planResolver(events) });
  assert.equal(oct.plan, "mixed");
  // 有料が短すぎる場合は比較データ不足
  const short = jm.planSplit([r], { categoryId: "1", start: "2026-01-01", end: "2026-10-16", planAt: jm.planResolver(events) });
  assert.equal(short.comparable, false);
  assert.ok(short.reasons.some(x => x.includes("有料掲載の実績が3日分")));
});

test("plan split: monthly totals spanning the switch are not prorated and go to 内訳不明", () => {
  const events = [ev(1, { status: "free", effective_date: "2026-07-01" }), ev(2, { status: "paid", effective_date: "2026-09-15" })];
  const records = [
    rec(1, { period_start: "2026-08-01", period_end: "2026-08-31", impressions: 620, clicks: 31, apply_starts: 2, applies: 1 }),
    rec(2, { period_start: "2026-09-01", period_end: "2026-09-30", impressions: 900, clicks: 45, apply_starts: 3, applies: 2, plan_type: "paid" }),
    rec(3, { period_start: "2026-10-01", period_end: "2026-10-31", impressions: 1240, clicks: 70, apply_starts: 6, applies: 4, plan_type: "paid", cost: 9300 }),
  ];
  const split = jm.planSplit(records, { categoryId: "1", start: "2026-01-01", end: "2026-10-31", planAt: jm.planResolver(events) });
  assert.deepEqual(split.free.record_ids, ["1"]);
  assert.deepEqual(split.paid.record_ids, ["3"]);
  assert.deepEqual(split.split_unknown.record_ids, ["2"], "September has only a monthly total across the switch");
  assert.equal(split.split_unknown.totals.impressions, 900);
  assert.equal(split.free.totals.impressions, 620, "nothing from September is added to free");
  assert.equal(split.paid.totals.impressions, 1240, "nothing from September is added to paid");
  assert.equal(split.paid.unit_cost, 9300 / 4);
  assert.equal(split.comparable, true);
  // 期間が重なる記録は比較から除外（二重計上しない）
  const overlap = rec(4, { period_start: "2026-10-07", period_end: "2026-10-20", impressions: 1, clicks: 1, apply_starts: 0, applies: 0 });
  const withOverlap = jm.planSplit([...records, overlap], { categoryId: "1", start: "2026-01-01", end: "2026-10-31", planAt: jm.planResolver(events) });
  assert.deepEqual(withOverlap.excluded.sort(), ["3", "4"]);
  assert.equal(withOverlap.paid, null);
  assert.equal(withOverlap.comparable, false);
});

test("postings: different job postings of one category are summed, a category-wide record overlapping them is not", () => {
  const a = rec(1, { period_start: "2026-09-01", period_end: "2026-09-30", posting_id: "10", impressions: 100, clicks: 10, apply_starts: 1, applies: 1 });
  const b = rec(2, { period_start: "2026-09-01", period_end: "2026-09-30", posting_id: "11", impressions: 50, clicks: 5, apply_starts: 0, applies: 0 });
  const sep = jm.monthAggregate([a, b], { categoryId: "1", month: "2026-09", asOf: "2026-10-27" });
  assert.equal(sep.status, "ok");
  assert.equal(sep.totals.impressions, 150);
  assert.equal(sep.postings, 2);
  assert.deepEqual(jm.findConflicts([a], { ...b, id: undefined }), [], "another posting is not a conflict");
  const whole = rec(3, { period_start: "2026-09-01", period_end: "2026-09-30", impressions: 150, clicks: 15, apply_starts: 1, applies: 1 });
  assert.equal(jm.monthAggregate([a, b, whole], { categoryId: "1", month: "2026-09", asOf: "2026-10-27" }).status, "overlap");
  assert.equal(jm.findConflicts([a, b], whole).length, 2);
  assert.equal(jm.findConflicts([a], { ...a, id: "9" })[0].type, "same_period", "same posting, same period");
  assert.deepEqual(jm.postingOf({ job_id: "123", job_title: "営業" }), { key: "id:123", job_id: "123", title: "営業" });
  assert.equal(jm.postingOf({ job_id: "", job_title: "" }), null);
});

test("analysis: the most important items come first and the paid switch is described without causal claims", () => {
  const events = [ev(1, { status: "free", effective_date: "2026-09-01" }), ev(2, { status: "paid", effective_date: "2026-10-01" })];
  const planAt = jm.planResolver(events);
  const daily = [...fakeDaily("2026-09-01", "2026-09-30"), ...fakeDaily("2026-10-01", "2026-10-31", 3)];
  const r = rec(1, { period_start: "2026-09-01", period_end: "2026-10-31", source: "indeed_csv", plan_type: "unknown", daily });
  const current = jm.monthAggregate([r], { categoryId: "1", month: "2026-10", asOf: "2026-11-05", planAt });
  const previous = jm.monthAggregate([r], { categoryId: "1", month: "2026-09", asOf: "2026-11-05", planAt });
  const plans = jm.planSplit([r], { categoryId: "1", start: "2026-01-01", end: "2026-10-31", planAt });
  const comparison = jm.comparability(current, previous);
  assert.equal(comparison.comparable, false, "free month vs paid month is not a simple comparison");
  const result = jm.analyze({ current, previous, comparison, series: [previous, current], plans });
  const top = result.items.slice(0, 3).map(i => i.title);
  assert.ok(top.includes("有料切替後の反応に変化があります"), top.join(","));
  const item = result.items.find(i => i.title === "有料切替後の反応に変化があります");
  assert.match(item.body, /断定できません/);
  assert.match(item.body, /1日あたり表示 \+200%/);
  for (let i = 1; i < result.items.length; i += 1) assert.ok(result.items[i - 1].priority <= result.items[i].priority);
  assert.ok(result.items.some(i => i.title === "比較データ不足"));
  assert.doesNotMatch(JSON.stringify(result), /AI|業界平均|Indeed基準/);
  const summary = jm.summaryText({ category: { name: "架空" }, current, previous, comparison, analysis: result, plans });
  assert.match(summary, /無料掲載：30日/);
  assert.match(summary, /有料掲載：31日/);
});

// ---------- API手順（メモリ保存先） ----------

test("categories: initial four, IDs keep history linked across rename, pause/resume logged, duplicates rejected", async () => {
  const { store, data, cat } = await setup();
  assert.deepEqual(data.categories.map(c => c.name), jm.DEFAULT_CATEGORIES);
  const id = cat("営業");
  await service.saveRecord(store, { record: base(id) }, actor);
  await service.updateCategory(store, id, { name: "法人営業" }, actor);
  await service.updateCategory(store, id, { is_active: false }, actor);
  let view = await service.overview(store);
  const renamed = view.categories.find(c => c.id === id);
  assert.equal(renamed.name, "法人営業");
  assert.equal(renamed.is_active, false);
  assert.equal(view.records.filter(r => r.category_id === id && r.state === "active").length, 1, "past data kept after rename/pause");
  await service.updateCategory(store, id, { is_active: true }, actor);
  view = await service.overview(store);
  assert.deepEqual(view.category_events.filter(e => e.category_id === id).map(e => e.kind), ["renamed", "paused", "resumed"]);
  const added = await service.createCategory(store, { name: "施工管理" }, actor);
  assert.ok(added.id);
  await rejectsWith(service.createCategory(store, { name: " 施工管理 " }, actor), 409);
  await rejectsWith(service.createCategory(store, { name: "" }, actor), 400);
  await rejectsWith(service.updateCategory(store, cat("電気工事士"), { name: "施工管理" }, actor), 409);
});

test("records: same period is rejected, overlaps need an explicit reason, corrections and voids keep history", async () => {
  const { store, cat } = await setup();
  const id = cat("電気工事士");
  const first = await service.saveRecord(store, { record: base(id, { note: "タイトル変更" }) }, actor);
  await rejectsWith(service.saveRecord(store, { record: base(id) }, actor), 409, "same_period");
  await rejectsWith(service.saveRecord(store, { record: base(id), allow_overlap: true, overlap_reason: "x" }, actor), 409, "same_period");
  const overlap = base(id, { period_start: "2026-09-07", period_end: "2026-10-07" });
  const dry = await service.saveRecord(store, { record: overlap, dry_run: true }, actor);
  assert.equal(dry.problems[0].code, "overlap");
  assert.equal(dry.conflicts[0].id, first.id);
  await rejectsWith(service.saveRecord(store, { record: overlap }, actor), 409, "overlap");
  await rejectsWith(service.saveRecord(store, { record: overlap, allow_overlap: true }, actor), 409, "overlap_reason");
  const kept = await service.saveRecord(store, { record: overlap, allow_overlap: true, overlap_reason: "旧管理表の集計期間" }, actor);
  // 他の職種は重ならない
  await service.saveRecord(store, { record: base(cat("営業")) }, actor);
  // 修正：元の記録は superseded として残る
  // 修正後も 9/7～10/7 の記録と重なるため、重複の理由は改めて必要
  await rejectsWith(service.saveRecord(store, { record: base(id, { clicks: 55 }), supersedes_id: first.id }, actor), 409, "overlap");
  const fixed = await service.saveRecord(store, { record: base(id, { clicks: 55 }), supersedes_id: first.id, allow_overlap: true, overlap_reason: "旧管理表の集計期間" }, actor);
  let view = await service.overview(store);
  const old = view.records.find(r => r.id === first.id);
  assert.equal(old.state, "superseded");
  assert.equal(old.replaced_by, fixed.id);
  assert.equal(old.clicks, 50, "original values are not overwritten");
  assert.equal(view.records.find(r => r.id === kept.id).source_meta.overlap.reason, "旧管理表の集計期間");
  await rejectsWith(service.saveRecord(store, { record: base(id), supersedes_id: first.id }, actor), 409, "stale");
  // 取消
  await rejectsWith(service.voidRecord(store, fixed.id, { reason: "" }, actor), 400);
  await service.voidRecord(store, fixed.id, { reason: "登録誤り" }, actor);
  await rejectsWith(service.voidRecord(store, fixed.id, { reason: "二重" }, actor), 409, "stale");
  view = await service.overview(store);
  const voided = view.records.find(r => r.id === fixed.id);
  assert.equal(voided.state, "voided");
  assert.equal(voided.void_reason, "登録誤り");
  assert.equal(view.records.length, 4, "all metric rows remain");
  // 取消後は同じ期間を再登録できる
  await service.saveRecord(store, { record: base(id), replace_ids: [] , allow_overlap: true, overlap_reason: "再登録" }, actor);
});

function indeedEntries(categoryId, plan = "free") {
  const g = jm.parseIndeed(rowsOf(INDEED), INDEED).groups[0];
  return [{ record: { category_id: categoryId, media: "Indeed", period_start: g.period.start, period_end: g.period.end, plan_type: plan, daily: g.daily, source_meta: { definitions: {} } } }];
}

test("CSV import: totals recomputed from daily rows, same file rejected, manual month not double counted", async () => {
  const { store, cat } = await setup();
  const id = cat("CADオペ（ときがわ）");
  const fileHash = "a".repeat(64);
  const tampered = indeedEntries(id);
  tampered[0].record.impressions = 999999; // 日別から再計算されるため無視される
  const res = await service.importCsv(store, { file_name: INDEED, file_hash: fileHash, format: "indeed", entries: tampered }, actor);
  let view = await service.overview(store);
  const saved = view.records.find(r => r.id === res.ids[0]);
  assert.equal(saved.impressions, 2300);
  assert.equal(saved.cost, null);
  assert.equal(saved.source, "indeed_csv");
  assert.equal(saved.daily.length, 23);
  assert.equal(view.imports.length, 1);
  // 同じファイルを別の職種へ取り込んでも二重登録として拒否
  await rejectsWith(service.importCsv(store, { file_name: INDEED, file_hash: fileHash, format: "indeed", entries: indeedEntries(cat("営業")) }, actor), 409, "duplicate_file");
  const dry = await service.importCsv(store, { file_name: INDEED, file_hash: fileHash, format: "indeed", entries: indeedEntries(cat("営業")), dry_run: true }, actor);
  assert.equal(dry.problems[0].code, "duplicate_file");
  // 同じ月の手入力は二重計上になるため、置き換えか理由付きの重複登録が必要
  await rejectsWith(service.saveRecord(store, { record: base(id) }, actor), 409, "same_period");
  // 手入力で9月分を置き換えると、CSVの記録は履歴に残る
  await service.saveRecord(store, { record: base(id), replace_ids: [saved.id] }, actor);
  view = await service.overview(store);
  assert.equal(view.records.find(r => r.id === saved.id).state, "superseded");
  // CSVの記録が無効になった後は、同じファイルを再取り込みできる（期間が重なるため置き換え指定）
  const active = view.records.find(r => r.state === "active" && r.category_id === id);
  const again = indeedEntries(id);
  again[0].replace_ids = [active.id];
  await service.importCsv(store, { file_name: INDEED, file_hash: fileHash, format: "indeed", entries: again }, actor);
  // 日別データが無い Indeed 取り込みは拒否
  await rejectsWith(service.importCsv(store, { file_name: "x.csv", file_hash: "b".repeat(64), format: "indeed", entries: [{ record: base(cat("営業")) }] }, actor), 400);
  await rejectsWith(service.importCsv(store, { file_name: "x.csv", file_hash: "nothex", format: "indeed", entries: indeedEntries(id) }, actor), 400);
});

test("legacy CSV import: overlapping columns inside one file need a reason, references are registered", async () => {
  const { store, cat } = await setup();
  const id = cat("CADオペ（本社）");
  const parsed = jm.parseLegacy(rowsOf(LEGACY), LEGACY);
  const entries = parsed.columns.map(c => ({ record: jm.legacyColumnRecord(c, { categoryId: id, year: 2026, applyMapping: "unknown", planType: "unknown" }) }));
  const dry = await service.importCsv(store, { file_name: LEGACY, file_hash: "c".repeat(64), format: "legacy", entries, dry_run: true }, actor);
  assert.deepEqual(dry.problems.map(p => [p.index, p.code]), [[1, "overlap"]]);
  // 重なる2列目は理由を付けて登録（合算はされない）
  entries[1].allow_overlap = true;
  entries[1].overlap_reason = "旧管理表の集計期間（参考）";
  // 3列目は2列目と重なるため同様
  entries[2].allow_overlap = true;
  entries[2].overlap_reason = "旧管理表の集計期間（参考）";
  const refs = parsed.references.map(r => ({ category_id: id, company_name: r.company_name, memo: "旧CSVの備考欄から取り込み" }));
  const res = await service.importCsv(store, { file_name: LEGACY, file_hash: "c".repeat(64), format: "legacy", entries, references: refs }, actor);
  assert.equal(res.ids.length, 3);
  assert.equal(res.references, 2);
  const view = await service.overview(store);
  const sep = jm.monthAggregate(jm.activeRecords(view.records.map(r => ({ ...r }))), { categoryId: id, month: "2026-09", asOf: "2026-10-27" });
  assert.equal(sep.totals.impressions, 300, "only the in-month column counts; 8/7～9/7 spans months and is excluded");
  assert.deepEqual(view.references.map(r => r.company_name), ["架空工業株式会社", "架空設計有限会社"]);
  const notes = view.records.map(r => r.note);
  assert.ok(notes.includes("閲覧は多い。\n応募転換は弱い\n\n9/10：架空の備考メモ"));
});

test("references: only http/https URLs, edit and soft delete", async () => {
  const { store, cat } = await setup();
  const id = cat("電気工事士");
  for (const url of ["javascript:alert(1)", "ftp://example.com/x", "example.com", "https://exa mple.com", "data:text/html,x"]) {
    await rejectsWith(service.createReference(store, { category_id: id, company_name: "架空電設", url }, actor), 400);
  }
  await rejectsWith(service.createReference(store, { category_id: id, company_name: "" }, actor), 400);
  await rejectsWith(service.createReference(store, { category_id: "999", company_name: "架空電設" }, actor), 400);
  await rejectsWith(service.createReference(store, { category_id: id, company_name: "架空電設", checked_on: "26-10-01" }, actor), 400);
  const ref = await service.createReference(store, { category_id: id, company_name: "架空電設", job_title: "電気工事士（未経験可）", url: "https://example.com/jobs/1", memo: "給与表記が具体的", checked_on: "2026-10-20" }, actor);
  await service.updateReference(store, ref.id, { company_name: "架空電設", url: "http://example.com/jobs/2" }, actor);
  let view = await service.overview(store);
  assert.equal(view.references[0].url, "http://example.com/jobs/2");
  await service.deleteReference(store, ref.id, actor);
  view = await service.overview(store);
  assert.equal(view.references.length, 0);
  await rejectsWith(service.deleteReference(store, ref.id, actor), 404);
  assert.equal(jm.safeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(jm.safeUrl("JavaScript:alert(1)"), null);
});

test("without the migration the overview reports not ready and writes return 503", async () => {
  const store = createMemoryMarketingStore({ ready: false });
  const view = await service.overview(store);
  assert.equal(view.ready, false);
  assert.deepEqual(view.records, []);
  await rejectsWith(service.saveRecord(store, { record: base("1") }, actor), 503, "marketing_unavailable");
  await rejectsWith(service.createReference(store, { category_id: "1", company_name: "x" }, actor), 503);
});

test("failed writes roll back the whole transaction", async () => {
  const { store, cat } = await setup();
  const id = cat("営業");
  const before = store.dump();
  const entries = [{ record: base(id) }, { record: base(id, { period_start: "2026-10-01", period_end: "2026-10-31" }) }, { record: base(id) }];
  await rejectsWith(service.importCsv(store, { file_name: "x.csv", file_hash: "d".repeat(64), format: "legacy", entries }, actor), 409, "same_period");
  assert.deepEqual(store.dump(), before);
});

test("server: job marketing routes are behind the session check and do not touch candidate tables", () => {
  const server = fs.readFileSync(path.join(here, "..", "server.js"), "utf8");
  const guard = server.indexOf('app.use("/api", auth.requireSession)');
  assert.ok(guard > 0);
  for (const route of ['"/api/job-marketing"', '"/api/job-marketing/records"', '"/api/job-marketing/imports"', '"/api/job-marketing/references/:id"'])
    assert.ok(server.indexOf(route) > guard, route);
  for (const file of ["jobMarketingService.js", "jobMarketingPgStore.js"]) {
    const src = fs.readFileSync(path.join(here, "..", file), "utf8");
    assert.doesNotMatch(src, /candidates|expenses|candidate_selection_events/, file);
  }
  const sql = fs.readFileSync(path.join(here, "..", "migrations", "004_job_marketing.sql"), "utf8");
  assert.doesNotMatch(sql, /ALTER TABLE public\.candidates|candidate_selection_events|expenses/);
});

test("plan events API: free -> paid -> free keeps every change and the past results; void and validation", async () => {
  const { store, cat } = await setup();
  const id = cat("営業");
  await service.saveRecord(store, { record: base(id, { period_start: "2026-08-01", period_end: "2026-08-31" }) }, actor);
  await service.savePlanEvent(store, { category_id: id, status: "free", effective_date: "2026-08-01" }, actor);
  const paid = await service.savePlanEvent(store, { category_id: id, status: "paid", effective_date: "2026-09-14", budget: "30000", note: "タイトル変更と同時に有料化" }, actor);
  await service.savePlanEvent(store, { category_id: id, status: "free", effective_date: "2026-10-10" }, actor);
  let view = await service.overview(store);
  const mine = view.plan_events.filter(e => e.category_id === id);
  assert.deepEqual(mine.map(e => [e.status, e.effective_date, e.state]), [["free", "2026-08-01", "active"], ["paid", "2026-09-14", "active"], ["free", "2026-10-10", "active"]]);
  // 予定日（本日より後）は登録しない（到来時に職種の募集状態と食い違うため）
  await rejectsWith(service.savePlanEvent(store, { category_id: id, status: "stopped", effective_date: jm.addDays(jm.todayTokyo(), 1) }, actor), 400);
  assert.equal(mine[1].budget, 30000);
  assert.equal(view.records.filter(r => r.category_id === id && r.state === "active").length, 1, "the free-period result is kept");
  await rejectsWith(service.savePlanEvent(store, { category_id: id, status: "paid", effective_date: "" }, actor), 400);
  await rejectsWith(service.savePlanEvent(store, { category_id: id, status: "paid", effective_date: "202-10-14" }, actor), 400);
  await rejectsWith(service.savePlanEvent(store, { category_id: "99999", status: "paid", effective_date: "2026-10-14" }, actor), 404);
  await rejectsWith(service.savePlanEvent(store, { category_id: id, posting_id: "99999", status: "paid", effective_date: "2026-10-14" }, actor), 400);
  await rejectsWith(service.voidPlanEvent(store, paid.id, { reason: "" }, actor), 400);
  await service.voidPlanEvent(store, paid.id, { reason: "開始日の入力誤り" }, actor);
  await rejectsWith(service.voidPlanEvent(store, paid.id, { reason: "again" }, actor), 409, "stale");
  view = await service.overview(store);
  const voided = view.plan_events.find(e => e.id === paid.id);
  assert.equal(voided.state, "voided");
  assert.equal(voided.void_reason, "開始日の入力誤り");
});

test("plan events API: 募集停止 and the category's active flag stay in sync both ways", async () => {
  const { store, cat } = await setup();
  const id = cat("電気工事士");
  const today = jm.todayTokyo();
  await service.savePlanEvent(store, { category_id: id, status: "stopped", effective_date: today }, actor);
  let view = await service.overview(store);
  assert.equal(view.categories.find(c => c.id === id).is_active, false);
  await service.savePlanEvent(store, { category_id: id, status: "free", effective_date: today }, actor);
  view = await service.overview(store);
  assert.equal(view.categories.find(c => c.id === id).is_active, true);
  // 職種の管理からの停止・再開は、掲載状態の履歴にも本日付で残る（再開後は「不明」）
  await service.updateCategory(store, id, { is_active: false }, actor);
  await service.updateCategory(store, id, { is_active: true }, actor);
  view = await service.overview(store);
  const statuses = view.plan_events.filter(e => e.category_id === id).map(e => e.status);
  assert.deepEqual(statuses, ["stopped", "free", "stopped", "unknown"]);
  assert.deepEqual(view.category_events.filter(e => e.category_id === id).map(e => e.kind), ["paused", "resumed", "paused", "resumed"]);
  // 過去日の停止は、現在の状態を変えない
  const other = cat("営業");
  await service.savePlanEvent(store, { category_id: other, status: "paid", effective_date: "2026-01-10" }, actor);
  await service.savePlanEvent(store, { category_id: other, status: "stopped", effective_date: "2025-12-01" }, actor);
  view = await service.overview(store);
  assert.equal(view.categories.find(c => c.id === other).is_active, true);
});

test("CSV import with job postings: postings are created, other postings are not conflicts, reassignment is refused", async () => {
  const { store, cat } = await setup();
  const sales = cat("営業");
  const entry = (categoryId, jobId, title, start = "2026-09-01", end = "2026-09-10") => ({
    record: { category_id: categoryId, media: "Indeed", period_start: start, period_end: end, plan_type: "free", daily: fakeDaily(start, end) },
    posting: { job_id: jobId, job_title: title },
  });
  const res = await service.importCsv(store, { file_name: "multi.csv", file_hash: "1".repeat(64), format: "indeed", entries: [entry(sales, "A1", "法人営業"), entry(sales, "A2", "ルート営業")] }, actor);
  assert.equal(res.ids.length, 2, "two postings of one category on the same days are not duplicates");
  let view = await service.overview(store);
  assert.deepEqual(view.postings.map(p => [p.external_key, p.category_id]), [["id:A1", sales], ["id:A2", sales]]);
  const sep = jm.monthAggregate(view.records.filter(r => r.state === "active"), { categoryId: sales, month: "2026-09", asOf: "2026-10-27" });
  assert.equal(sep.totals.impressions, 1000);
  // 同じ求人IDを別の職種へ取り込もうとすると拒否（曖昧なまま混ぜない）
  const dry = await service.importCsv(store, { file_name: "b.csv", file_hash: "2".repeat(64), format: "indeed", entries: [entry(cat("電気工事士"), "A1", "法人営業", "2026-10-01", "2026-10-10")], dry_run: true }, actor);
  assert.equal(dry.problems[0].code, "posting_category");
  // 職種全体の手入力は、原稿ごとの記録と重なるため二重計上として止める
  await rejectsWith(service.saveRecord(store, { record: base(sales, { period_start: "2026-09-01", period_end: "2026-09-30" }) }, actor), 409, "overlap");
  // 原稿ごとの掲載状態（A1だけ有料）
  const a1 = view.postings.find(p => p.external_key === "id:A1");
  await service.savePlanEvent(store, { category_id: sales, posting_id: a1.id, status: "paid", effective_date: "2026-09-06" }, actor);
  view = await service.overview(store);
  const split = jm.planSplit(view.records.filter(r => r.state === "active"), { categoryId: sales, start: "2026-09-01", end: "2026-09-30", planAt: jm.planResolver(view.plan_events) });
  assert.equal(split.paid.unit_days, 5);
  assert.equal(split.free.unit_days, 15);
  assert.equal(split.free.postings, 2);
  view = await service.overview(store);
  assert.equal(view.categories.find(c => c.id === sales).is_active, true, "posting-level events do not change the category");
});

test("Codex review fixes: CSV corrections keep daily data, voiding the only stop restores the category, years before 1000 are rejected", async () => {
  const { store, cat } = await setup();
  const id = cat("CADオペ（本社）");
  const res = await service.importCsv(store, { file_name: INDEED, file_hash: "e".repeat(64), format: "indeed", entries: indeedEntries(id) }, actor);
  let view = await service.overview(store);
  const original = view.records.find(r => r.id === res.ids[0]);
  // 画面から数値・期間・職種を変えて送っても、日別の実績は元の記録から引き継ぎ、掲載種別とメモだけを反映する
  const fixed = await service.saveRecord(store, { supersedes_id: original.id, record: { ...base(cat("営業")), impressions: 1, period_start: "2026-09-05", note: "メモだけ修正", plan_type: "paid" } }, actor);
  assert.equal(fixed.kept_daily, true);
  view = await service.overview(store);
  const next = view.records.find(r => r.id === fixed.id);
  assert.equal(view.records.find(r => r.id === original.id).state, "superseded");
  assert.deepEqual([next.category_id, next.period_start, next.period_end, next.impressions, next.source, next.daily.length, next.import_id],
    [id, original.period_start, original.period_end, 2300, "indeed_csv", 23, original.import_id]);
  assert.deepEqual([next.note, next.plan_type], ["メモだけ修正", "paid"]);
  // 取込記録との関連が残るため、同じCSVは引き続き二重登録できない
  await rejectsWith(service.importCsv(store, { file_name: INDEED, file_hash: "e".repeat(64), format: "indeed", entries: indeedEntries(cat("営業")) }, actor), 409, "duplicate_file");
  // 唯一の「募集停止」を取消すと、職種は募集中に戻る
  const other = cat("電気工事士");
  const stop = await service.savePlanEvent(store, { category_id: other, status: "stopped", effective_date: jm.todayTokyo() }, actor);
  view = await service.overview(store);
  assert.equal(view.categories.find(c => c.id === other).is_active, false);
  await service.voidPlanEvent(store, stop.id, { reason: "誤登録" }, actor);
  view = await service.overview(store);
  assert.equal(view.categories.find(c => c.id === other).is_active, true);
  // 西暦は1000年以降（画面の入力範囲と同じ）
  assert.equal(jm.isDate("0999-12-31"), false);
  assert.equal(jm.isDate("1000-01-01"), true);
  await rejectsWith(service.savePlanEvent(store, { category_id: other, status: "free", effective_date: "0999-01-01" }, actor), 400);
});
