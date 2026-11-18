// 求人一覧・求人詳細・応募者連携（第5弾）。共通ルール・採用数の判定・API手順（メモリ保存先）を検証する。DBには接続しない。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as jp from "../../shared/jobPostings.mjs";
import * as jm from "../../shared/jobMarketing.mjs";

const require = createRequire(import.meta.url);
const service = require("../jobPostingService.js");
const marketing = require("../jobMarketingService.js");
const selection = require("../selectionService.js");
const flow = require("../selectionFlow.js");
const { createMemoryMarketingStore } = require("../jobMarketingMemoryStore.js");
const { createMemorySelectionStore } = require("../selectionMemoryStore.js");
const { createMemoryJobPostingStore } = require("../jobPostingMemoryStore.js");

const actor = "tester@web";
const today = jp.todayTokyo();
const rejectsWith = (promise, status, code) => assert.rejects(promise, err => err.status === status && (!code || err.code === code));
const blank = { tel: [], email: [], contact_history: [], is_deleted: false, is_retired: false };

function setup({ candidates = [], ready = true, failOn = null } = {}) {
  const list = candidates.map(c => ({ ...blank, ...c }));
  const marketingStore = createMemoryMarketingStore();
  const selectionStore = createMemorySelectionStore(list);
  const store = createMemoryJobPostingStore({ marketingStore, candidates: list, selectionStore, ready, failOn });
  return { list, marketingStore, selectionStore, store };
}
async function categoryId(marketingStore, name) {
  return (await marketing.overview(marketingStore)).categories.find(c => c.name === name).id;
}
async function step(selectionStore, id, kind, event_date, extra = {}) {
  const v = await selection.getTimeline(selectionStore, id);
  return selection.addStep(selectionStore, id, { expected_version: v.version, kind, event_date, ...extra }, actor);
}
const link = (store, candidateId, postingId, expected = null) => service.setCandidateLink(store, candidateId, { posting_id: postingId, expected_link_id: expected }, actor);

// ---------- 共通ルール ----------

test("media names are normalized only for display and filtering", () => {
  assert.equal(jp.mediaKey("インディード"), "Indeed");
  assert.equal(jp.mediaKey(" INDEED "), "Indeed");
  assert.equal(jp.mediaKey("ｲﾝﾃﾞｨｰﾄﾞ"), "Indeed");
  assert.equal(jp.mediaKey("ハローワーク"), "ハローワーク");
  assert.equal(jp.mediaKey("エアワーク"), "AirWORK");
  assert.equal(jp.mediaKey("AirWORK"), "AirWORK");
  assert.equal(jp.mediaKey("プレックス"), "プレックス"); // 選択肢に無い媒体は入力のまま
  assert.equal(jp.mediaKey("高卒"), "高卒"); // 誤入力とみられる値も補正しない
  assert.equal(jp.mediaKey(""), null);
  assert.ok(jp.sameMedia("Indeed", "インディード"));
  assert.deepEqual(jp.mediaOptions([{ media: "Indeed" }, { media: "duda" }]).slice(-1), ["duda"]);
});

test("revision input keeps pasted full text, validates limits and URL, and diffs versions", () => {
  const r = jp.validateRevision({ title: "  架空 求人  ", body: "1行目\r\n\r\n  2行目（字下げ）\r\n", url: "https://example.com/job/1", salary: " 月給 " });
  assert.equal(r.title, "架空 求人");
  assert.equal(r.body, "1行目\n\n  2行目（字下げ）");
  assert.equal(r.salary, "月給");
  assert.equal(r.location, null);
  assert.throws(() => jp.validateRevision({ title: "" }), /求人タイトルを入力/);
  assert.throws(() => jp.validateRevision({ title: "x", url: "javascript:alert(1)" }), /http/);
  assert.throws(() => jp.validateRevision({ title: "x", body: "あ".repeat(20001) }), /20,000文字以内/);
  assert.throws(() => jp.validateRevision({ title: "x", salary: 1 }), /正しくありません/);
  const next = { ...r, salary: "月給25万円", location: "架空市" };
  assert.deepEqual(jp.revisionDiff(r, next).map(d => [d.key, d.before, d.after]), [["location", null, "架空市"], ["salary", "月給", "月給25万円"]]);
  assert.ok(jp.sameContent(r, { ...r, change_summary: "違っても内容は同じ" }));
});

test("visibility history yields the current state and public periods", () => {
  assert.deepEqual(jp.visibilityState([]), { current: null, since: null, seq: 0, public_periods: [], first_public: null, last_private: null });
  const s = jp.visibilityState([
    { seq: 2, visibility: "private", effective_date: "2026-09-30" },
    { seq: 1, visibility: "public", effective_date: "2026-09-01" },
    { seq: 3, visibility: "public", effective_date: "2026-10-10" },
  ]);
  assert.equal(s.current, "public");
  assert.equal(s.seq, 3);
  assert.deepEqual(s.public_periods, [{ start: "2026-09-01", end: "2026-09-30" }, { start: "2026-10-10", end: null }]);
  assert.equal(s.first_public, "2026-09-01");
  assert.equal(s.last_private, "2026-09-30");
  assert.equal(jp.visibilityLabel(null), "要設定");
  const ctx = { current: "public", since: "2026-10-10", today: "2026-11-18" };
  assert.throws(() => jp.validateVisibility({ visibility: "public" }, ctx), err => err.status === 409);
  assert.throws(() => jp.validateVisibility({ visibility: "private", effective_date: "2026-11-19" }, ctx), /本日以前/);
  assert.throws(() => jp.validateVisibility({ visibility: "private", effective_date: "2026-10-09" }, ctx), /以降/);
  assert.throws(() => jp.validateVisibility({ visibility: "private", effective_date: "26-10-09" }, ctx), /西暦4桁/);
  assert.deepEqual(jp.validateVisibility({ visibility: "private" }, ctx), { visibility: "private", effective_date: "2026-11-18", reason: null });
});

test("new posting keys: job ID matches CSV import, otherwise an NKS key", () => {
  assert.equal(jp.externalKeyFor("ABC-1", "r"), "id:ABC-1");
  assert.equal(jp.externalKeyFor("", "r1"), "nks:r1");
  assert.equal(jp.validateNewPosting({ category_id: "1", media: "インディード" }).media, "Indeed");
  assert.throws(() => jp.validateNewPosting({ category_id: "", media: "" }), /職種を選択[\s\S]*掲載媒体を選択/);
});

test("job ID keys follow the CSV import rule exactly (no width conversion), so a manual posting and a CSV row match", () => {
  for (const id of ["A1", "Ａ１", " J-1 ", "00000000-0000-4000-8000-000000000001"])
    assert.equal(jp.externalKeyFor(id, "r"), jm.postingOf({ job_id: id, job_title: "x" }).key, id);
  assert.notEqual(jp.externalKeyFor("Ａ１", "r"), jp.externalKeyFor("A1", "r")); // 既存の値を勝手に変換しない
  assert.equal(jp.validateNewPosting({ category_id: "1", media: "Indeed", job_id: " Ａ１ " }).job_id, "Ａ１");
});

test("improvement history merges revision notes, record notes and plan notes without storing copies", () => {
  const items = jp.improvementTimeline({
    revisions: [{ id: "1", revision_no: 1, created_at: "2026-09-01 10:00" }, { id: "2", revision_no: 2, change_summary: "給与を変更", change_reason: "応募が少ない", created_at: "2026-10-05 09:00" },
      { id: "3", revision_no: 3, created_at: "2026-10-06 09:00" }],
    records: [{ id: "9", kind: "metric", state: "active", note: "タイトル変更", period_start: "2026-10-01", period_end: "2026-10-31", created_at: "2026-11-01 10:00" },
      { id: "8", kind: "metric", state: "superseded", note: "古いメモ", period_start: "2026-10-01", period_end: "2026-10-19" }],
    planEvents: [{ id: "4", kind: "change", state: "active", note: "有料へ切替", effective_date: "2026-10-14", created_at: "2026-10-14 09:00" }],
  });
  assert.deepEqual(items.map(i => i.ref), ["plan:4", "revision:2", "record:9", "revision:1"]);
  assert.match(items[1].note, /給与を変更\n理由：応募が少ない/);
});

// ---------- 採用数の判定 ----------

test("hire state: offer / planned join / joined count; declined, rejected, voided offers do not", async () => {
  const { selectionStore, list } = setup({ candidates: [
    { id: 1, status: 1, applied_at: "2026-09-01" }, { id: 2, status: 1, applied_at: "2026-09-01" }, { id: 3, status: 1, applied_at: "2026-09-01" },
    { id: 4, status: 1, applied_at: "2026-09-01" }, { id: 5, status: 1, applied_at: "2026-09-01" },
  ] });
  const state = id => service.selectionState(list.find(c => c.id === id), selectionStore.log(id));
  for (const id of [1, 2, 3, 4, 5]) { await step(selectionStore, id, "interview_scheduled", "2026-09-05"); await step(selectionStore, id, "interview_completed", "2026-09-05"); }
  await step(selectionStore, 1, "offer", "2026-09-10");
  assert.deepEqual(state(1), { kind: "offer", label: "内定", hired: true });
  await step(selectionStore, 2, "offer", "2026-09-10");
  await step(selectionStore, 2, "join_planned", "2026-10-01");
  assert.equal(state(2).hired, true);
  await step(selectionStore, 3, "offer", "2026-09-10");
  await step(selectionStore, 3, "join_planned", "2026-10-01");
  await step(selectionStore, 3, "joined", "2026-10-01");
  assert.deepEqual(state(3), { kind: "joined", label: "入社", hired: true });
  await step(selectionStore, 4, "offer", "2026-09-10");
  await step(selectionStore, 4, "declined", "2026-09-12", { note: "他社決定" });
  assert.deepEqual(state(4), { kind: "declined", label: "辞退", hired: false }); // 内定辞退は除外（内定の履歴は残る）
  assert.ok(selectionStore.log(4).some(e => e.kind === "offer"));
  await step(selectionStore, 5, "offer", "2026-09-10");
  const v = await selection.getTimeline(selectionStore, 5);
  await selection.voidStep(selectionStore, 5, v.records.at(-1).id, { expected_version: v.version, reason: "内定取消" }, actor);
  assert.equal(state(5).hired, false); // 取消された内定は除外
  // 選考履歴がある応募者は、既存の進捗（選考APIが同期する status）と判定が一致する
  for (const c of list) {
    const log = selectionStore.log(c.id);
    const mirror = flow.deriveMirror(flow.effectiveSteps(log), log.filter(e => !flow.META_KINDS.includes(e.kind)));
    assert.equal(state(c.id).hired, ["5", "6"].includes(mirror.status), `candidate ${c.id}`);
    assert.equal(String(c.status), mirror.status);
  }
});

test("hire state without selection history follows the existing status (5・6 only); unconfirmed legacy interview stays 受付", () => {
  const s = c => service.selectionState(c, []);
  assert.equal(s({ status: 5 }).hired, true);
  assert.equal(s({ status: 6 }).hired, true);
  assert.equal(s({ status: 6, is_retired: true }).hired, true); // 入社後の退職は採用実績として残る
  for (const st of [1, 2, 3, 4]) assert.equal(s({ status: st }).hired, false);
  assert.deepEqual(s({ status: 9, decline_reason: "内定辞退: 他社" }), { kind: "declined", label: "辞退", hired: false });
  assert.deepEqual(s({ status: 9, decline_reason: "音信不通" }), { kind: "no_contact", label: "音信不通", hired: false });
  assert.deepEqual(s({ status: 9, decline_reason: "書類選考" }), { kind: "rejected", label: "不採用", hired: false });
  assert.equal(s({ status: 1, offer_date: "2026-09-20" }).hired, false); // 不整合データは進捗（受付）のまま。推測しない
  const legacy = [{ id: "1", seq: 1, kind: "baseline", source: "legacy" },
    { id: "2", seq: 2, kind: "interview_scheduled", stage_number: 1, event_date: "2026-09-01", source: "legacy", payload: { legacy_status: "1" } }];
  assert.deepEqual(s({ status: 1 }), { kind: null, label: "受付", hired: false });
  assert.deepEqual(service.selectionState({ status: 1 }, legacy), { kind: null, label: "受付", hired: false });
});

// ---------- API手順 ----------

async function seeded() {
  const ctx = setup({ candidates: [
    { id: 11, name_kanji: "架空・一", status: 1, applied_at: "2026-10-01", source_type: "求人", agent_name: "インディード" },
    { id: 12, name_kanji: "架空・二", status: 6, applied_at: "2026-08-01", source_type: "求人", agent_name: "Indeed" },
    { id: 13, name_kanji: "架空・三", status: 9, decline_reason: "1次面接辞退", applied_at: "2026-09-01", source_type: "求人", agent_name: "Indeed", is_deleted: true },
    { id: 14, name_kanji: "架空協力", status: 1, applied_at: "2026-09-01", is_coop: true },
    { id: 15, name_kanji: "架空・五", status: 5, applied_at: "2026-09-15", source_type: "求人", agent_name: "ハローワーク" },
  ] });
  const sales = await categoryId(ctx.marketingStore, "営業");
  const indeed = await service.createPosting(ctx.store, { category_id: sales, media: "Indeed", job_id: "J-1", visibility: "public", effective_date: "2026-09-01", title: "架空：営業", body: "全文" }, actor);
  const hw = await service.createPosting(ctx.store, { category_id: sales, media: "ハローワーク", job_id: "00000-1", title: "架空：営業（HW）" }, actor);
  return { ...ctx, sales, indeed, hw };
}

test("create posting: first version, optional visibility, duplicate check across media spelling, NKS key without ID", async () => {
  const { store, sales, indeed } = await seeded();
  const view = await service.overview(store);
  const row = view.postings.find(p => p.id === indeed.id);
  assert.equal(row.revision_no, 1);
  assert.equal(row.visibility, "public");
  assert.equal(row.external_key, "id:J-1");
  assert.deepEqual(view.counts, { public: 1, private: 0, unset: 1, all: 2 }); // ハローワークの求人は未設定（要設定）
  await rejectsWith(service.createPosting(store, { category_id: sales, media: "インディード", job_id: "J-1", title: "重複" }, actor), 409, "duplicate");
  const air = await service.createPosting(store, { category_id: sales, media: "エアワーク", title: "架空：IDなし" }, actor);
  const airRow = (await service.overview(store)).postings.find(p => p.id === air.id);
  assert.match(airRow.external_key, /^nks:[\w-]+$/);
  assert.equal(airRow.media, "AirWORK");
  await rejectsWith(service.createPosting(store, { category_id: "999", media: "Indeed", title: "x" }, actor), 400);
  await rejectsWith(service.createPosting(store, { category_id: sales, media: "Indeed", title: "x", visibility: "public", effective_date: "2999-01-01" }, actor), 400);
});

test("revisions: stale screens get 409, unchanged content 400, later versions need a change summary; history keeps before/after", async () => {
  const { store, indeed } = await seeded();
  await rejectsWith(service.addRevision(store, indeed.id, { expected_revision_no: 0, title: "架空：営業" }, actor), 409, "stale");
  await rejectsWith(service.addRevision(store, indeed.id, { expected_revision_no: 1, title: "架空：営業", body: "全文" }, actor), 400);
  await rejectsWith(service.addRevision(store, indeed.id, { expected_revision_no: 1, title: "架空：営業", body: "全文（改）" }, actor), 400);
  assert.deepEqual(await service.addRevision(store, indeed.id, { expected_revision_no: 1, title: "架空：営業", body: "全文（改）", change_summary: "本文を修正", change_reason: "誤字" }, actor), { id: indeed.id, revision_no: 2 });
  // 同じ版からの2つ目の保存（古い画面）は409
  await rejectsWith(service.addRevision(store, indeed.id, { expected_revision_no: 1, title: "別の内容", change_summary: "x" }, actor), 409, "stale");
  const d = await service.detail(store, indeed.id);
  assert.equal(d.current.revision_no, 2);
  assert.deepEqual(d.revisions.map(r => r.revision_no), [2, 1]);
  assert.deepEqual(d.revisions[0].changes, [{ key: "body", label: "求人内容（全文）", before: "全文", after: "全文（改）" }]);
  assert.equal(d.revisions[0].actor, actor);
  assert.ok(d.improvements.some(i => i.ref.startsWith("revision:") && /本文を修正/.test(i.note)));
});

test("visibility switch records before/after, date and reason; stale or repeated switches are rejected", async () => {
  const { store, indeed, hw } = await seeded();
  await rejectsWith(service.setVisibility(store, indeed.id, { expected_seq: 0, visibility: "private" }, actor), 409, "stale");
  await rejectsWith(service.setVisibility(store, indeed.id, { expected_seq: 1, visibility: "public" }, actor), 409, "stale");
  await service.setVisibility(store, indeed.id, { expected_seq: 1, visibility: "private", effective_date: today, reason: "充足" }, actor);
  await service.setVisibility(store, hw.id, { expected_seq: 0, visibility: "public", effective_date: "2026-10-01" }, actor); // 要設定 → 公開
  const d = await service.detail(store, indeed.id);
  assert.equal(d.visibility.current, "private");
  assert.deepEqual(d.visibility.events.map(e => [e.seq, e.previous_visibility, e.visibility, e.reason]), [[2, "public", "private", "充足"], [1, null, "public", null]]);
  assert.deepEqual(d.visibility.public_periods, [{ start: "2026-09-01", end: today }]);
  assert.deepEqual((await service.overview(store)).counts, { public: 1, private: 1, unset: 0, all: 2 });
});

test("applications and hires per posting: unique candidates, archived kept, co-op excluded, decline removes from hires", async () => {
  const { store, list, selectionStore, indeed, hw } = await seeded();
  await link(store, 11, indeed.id);
  await link(store, 12, indeed.id);
  await link(store, 13, indeed.id);
  await rejectsWith(link(store, 14, indeed.id), 400); // 協力業者はひも付けできない
  await link(store, 15, hw.id);
  let row = (await service.overview(store)).postings.find(p => p.id === indeed.id);
  assert.deepEqual([row.applicants, row.hires], [3, 1]); // 13（アーカイブ・辞退）は応募に含み、採用には含まない
  const modal = await service.candidates(store, indeed.id, "applied");
  assert.deepEqual(modal.candidates.map(c => [c.id, c.selection_label, c.archived]), [["11", "受付", false], ["13", "辞退", true], ["12", "入社", false]]);
  assert.deepEqual((await service.candidates(store, indeed.id, "hired")).candidates.map(c => c.id), ["12"]);
  await rejectsWith(service.candidates(store, indeed.id, "all"), 400);
  // 同じ求人を選び直しても重複しない（変更なし）
  const current = await service.candidateLink(store, 11);
  assert.deepEqual(await link(store, 11, indeed.id, current.link_id), { changed: false });
  // 選考：内定→採用数+1、内定辞退→採用数から除外
  await step(selectionStore, 11, "document_received", "2026-10-02");
  await step(selectionStore, 11, "interview_scheduled", "2026-10-05");
  await step(selectionStore, 11, "interview_completed", "2026-10-05");
  await step(selectionStore, 11, "offer", "2026-10-10");
  row = (await service.overview(store)).postings.find(p => p.id === indeed.id);
  assert.deepEqual([row.applicants, row.hires], [3, 2]);
  await step(selectionStore, 11, "declined", "2026-10-12", { note: "内定辞退" });
  row = (await service.overview(store)).postings.find(p => p.id === indeed.id);
  assert.deepEqual([row.applicants, row.hires], [3, 1]);
  // 求人を変更すると、元の求人から外れて新しい求人に数える（履歴は残る）
  await link(store, 12, hw.id, (await service.candidateLink(store, 12)).link_id, "変更");
  const rows = (await service.overview(store)).postings;
  assert.deepEqual([rows.find(p => p.id === indeed.id).applicants, rows.find(p => p.id === hw.id).applicants, rows.find(p => p.id === hw.id).hires], [2, 2, 2]);
  const hist = await service.candidateLink(store, 12);
  assert.deepEqual(hist.history.map(h => [h.seq, h.posting?.id, h.previous?.id ?? null]), [[2, hw.id, indeed.id], [1, indeed.id, null]]);
  // 完全消去された応募者は数えない（連鎖削除）
  list.splice(list.findIndex(c => c.id === 12), 1);
  assert.equal((await service.overview(store)).postings.find(p => p.id === hw.id).applicants, 1);
});

test("candidate link: stale screens 409, unknown posting 400, 'none' after a posting is recorded, failures roll back", async () => {
  const { store, indeed, hw } = await seeded();
  await link(store, 11, indeed.id);
  await rejectsWith(link(store, 11, hw.id, null), 409, "link_stale");
  const cur = await service.candidateLink(store, 11);
  await rejectsWith(link(store, 11, "9999", cur.link_id), 400);
  await rejectsWith(link(store, 11, "abc", cur.link_id), 400);
  assert.deepEqual(await link(store, 11, null, cur.link_id), { changed: true }); // 該当求人なし・不明に変更
  const after = await service.candidateLink(store, 11);
  assert.equal(after.current, null);
  assert.equal(after.history.length, 2);
  assert.deepEqual(await link(store, 12, null), { changed: false }); // 未選択のまま「なし」は記録しない
  await rejectsWith(link(store, 99999, indeed.id), 404);
  // 保存の途中で失敗した場合は何も残らない
  const failing = setup({ candidates: [{ id: 1, status: 1, source_type: "求人" }], failOn: "insertLink" });
  const cat = await categoryId(failing.marketingStore, "営業");
  const p = await service.createPosting(failing.store, { category_id: cat, media: "Indeed", title: "x" }, actor);
  await assert.rejects(link(failing.store, 1, p.id), /simulated failure/);
  assert.equal(failing.store.dump().links.length, 0);
});

test("CSV import shares the posting master: matching job ID reuses the posting, CSV-only postings stay 'first version not registered'", async () => {
  const { store, marketingStore, sales, indeed } = await seeded();
  const header = ["求人名", "参照番号", "表示回数", "クリック数", "クリック率", "応募開始数", "応募数", "費用", "通貨"];
  const parsed = jm.parseIndeedJobs([header, ["架空：営業（CSVの名称）", "J-1", "52", "6", "0.115385", "1", "1", "0", "JPY"], ["架空：CSVだけの求人", "J-9", "10", "1", "0.1", "0", "0", "0", "JPY"]], "JobsCampaigns_20261001_20261031.csv");
  const range = jm.monthRange("2026-10");
  const entries = parsed.postings.map(p => jm.jobsPostingRecord(p, { categoryId: sales, periodStart: range.start, periodEnd: range.end, planType: "free", periodConfirmed: true, filePeriod: { start: range.start, end: range.end } }));
  await marketing.importCsv(marketingStore, { file_name: "JobsCampaigns_20261001_20261031.csv", file_hash: "a".repeat(64), format: "indeed_jobs", entries }, actor);
  const view = await service.overview(store);
  assert.equal(view.postings.length, 3); // J-1 は既存の求人と同じ（新しい求人原稿は作らない）
  const csvOnly = view.postings.find(p => p.job_id === "J-9");
  assert.deepEqual([csvOnly.revision_no, csvOnly.visibility, csvOnly.title], [0, null, "架空：CSVだけの求人"]);
  const d = await service.detail(store, indeed.id);
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].impressions, 52);
  assert.equal(d.posting.title, "架空：営業"); // NKSの求人タイトル（版）を優先。CSVの名称は csv_title に残る
  assert.equal(d.posting.csv_title, "架空：営業");
  // 求人原稿の名称（CSV）・版・掲載状態はそれぞれ別の記録（互いに上書きしない）
  await marketing.savePlanEvent(marketingStore, { category_id: sales, posting_id: indeed.id, status: "paid", effective_date: "2026-10-14", budget: "30000", note: "有料に切替" }, actor);
  const d2 = await service.detail(store, indeed.id);
  assert.equal(d2.posting.plan_status, "paid");
  assert.ok(d2.improvements.some(i => i.ref.startsWith("plan:") && i.note === "有料に切替"));
  const mv = await marketing.overview(marketingStore);
  assert.ok(mv.plan_events.some(e => e.posting_id === indeed.id && e.status === "paid")); // 求人分析にも同じ履歴が表示される
  assert.equal((await service.detail(store, csvOnly.id)).csv.reference, "J-9");
});

test("link consistency: a linked applicant cannot leave the 求人 route or become co-op unless the link is cleared in the same save", async () => {
  const { store, list, indeed } = await seeded();
  await link(store, 11, indeed.id);
  const linkId = (await service.candidateLink(store, 11)).link_id;
  const inTx = work => store.transaction(work);
  // 求人以外の応募経路・協力業者になるのに、ひも付けが残る保存は409
  await rejectsWith(inTx(tx => service.assertLinkConsistent(tx, { id: "11", is_coop: false, source_type: "紹介" })), 409, "link_required");
  await rejectsWith(inTx(tx => service.assertLinkConsistent(tx, { id: "11", is_coop: true, source_type: "求人" })), 409, "link_required");
  await rejectsWith(inTx(tx => service.assertLinkConsistent(tx, { id: "11", is_coop: false, source_type: null })), 409, "link_required");
  await inTx(tx => service.assertLinkConsistent(tx, { id: "11", is_coop: false, source_type: "求人" }));
  await inTx(tx => service.assertLinkConsistent(tx, { id: "12", is_coop: false, source_type: "紹介" })); // ひも付けが無ければ従来どおり
  // 同じ保存でひも付けを外せば保存できる（協力業者でも外す操作は受け付ける）
  await inTx(async tx => {
    await service.applyLink(tx, { id: "11", is_coop: true, source_type: "求人" }, { posting_id: null, expected_link_id: linkId, reason: "協力業者に変更" }, actor);
    await service.assertLinkConsistent(tx, { id: "11", is_coop: true, source_type: "求人" });
  });
  assert.equal((await service.candidateLink(store, 11)).current, null);
  // 求人を選べるのは応募経路の種別が「求人」の場合だけ
  await rejectsWith(inTx(tx => service.applyLink(tx, { id: "12", is_coop: false, source_type: "紹介" }, { posting_id: indeed.id, expected_link_id: null }, actor)), 400);
  list.find(c => c.id === 12).source_type = "紹介";
  await rejectsWith(link(store, 12, indeed.id), 400);
});

test("readiness: without migration 005 the list reports ready:false and writes return 503", async () => {
  const { store } = setup({ ready: false });
  assert.equal((await service.overview(store)).ready, false);
  assert.equal((await service.candidateLink(store, 1)).ready, false);
  await rejectsWith(service.detail(store, "1"), 503, "postings_unavailable");
  await rejectsWith(service.createPosting(store, { category_id: "1", media: "Indeed", title: "x" }, actor), 503);
});
