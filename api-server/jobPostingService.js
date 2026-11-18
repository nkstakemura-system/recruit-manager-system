"use strict";
// 求人一覧・求人詳細・応募者連携（第5弾）の読み書き手順。保存先（PostgreSQL / テスト・プレビュー用メモリ）は store で差し替える。
//
// * 求人は既存の求人原稿（job_marketing_postings）を共通利用する。掲載状態は既存の掲載状態の履歴、実績・改善メモは既存の実績を表示する。
// * 求人内容の版・公開／非公開・応募者とのひも付けは追記のみ（元の行は変更しない）。
// * 応募数＝その求人に現在ひも付いている応募者（協力業者を除く。選考終了・アーカイブ後も含む。応募者単位で重複なし）。
// * 採用数＝そのうち現在の選考状態が「内定」「入社予定」「入社済み」の応募者（選考履歴の有効な最新工程。履歴が無い場合は従来の進捗 5・6）。
//   内定辞退・辞退・不採用・内定の取消（取消された内定の記録）は含まない。入社後の退職は採用実績として残す。
// * 既存の応募者は自動でひも付けない。応募経路・媒体名の保存値は変更しない。
const crypto = require("node:crypto");
const flow = require("./selectionFlow");

let shared;
let marketingShared;
const lib = () => (shared ||= import("../shared/jobPostings.mjs"));
const mlib = () => (marketingShared ||= import("../shared/jobMarketing.mjs"));

const UNAVAILABLE_MESSAGE = "求人一覧のテーブルが未作成のため、求人一覧は使用できません";
const HIRED_KINDS = new Set(["offer", "join_planned", "joined"]);
const STATUS_LABELS = { 1: "受付", 2: "面接打診中", 3: "1次面接予定", 4: "2次面接予定", 5: "内定", 6: "入社" };

async function ensureReady(store) {
  const p = await lib();
  if (!(await store.ready())) throw p.postingError(503, UNAVAILABLE_MESSAGE, { code: "postings_unavailable" });
  return p;
}

// ---------- 選考状態（採用数の判定） ----------

// 応募者の現在の選考状態。log は選考履歴（seq 順）。協力業者は対象外（呼び出し元で除外）
function selectionState(candidate, log = []) {
  if (log.length) {
    const steps = flow.effectiveSteps(log);
    const last = steps[steps.length - 1];
    // 全工程が取消された場合・従来データの「受付のまま1次面接日のみ」は受付（一覧と同じ表示）
    if (!last || flow.isUnconfirmedLegacyInterview(last)) return { kind: null, label: "受付", hired: false };
    return { kind: last.kind, label: flow.badgeLabel(last.kind, last.stage_number) || "受付", hired: HIRED_KINDS.has(last.kind) };
  }
  const st = String(candidate.status ?? "");
  if (st === "9") {
    const kind = { declined: "declined", no_contact: "no_contact" }[flow.legacyEvents({ status: "9", decline_reason: candidate.decline_reason }).at(-1)?.kind] || "rejected";
    return { kind, label: flow.badgeLabel(kind), hired: false };
  }
  return { kind: null, label: STATUS_LABELS[st] || "受付", hired: st === "5" || st === "6" };
}

// 応募者ごとの現在のひも付け（最新の行）
function currentLinks(links) {
  const latest = new Map();
  for (const l of links) {
    const key = String(l.candidate_id);
    const prev = latest.get(key);
    if (!prev || Number(l.seq) > Number(prev.seq)) latest.set(key, l);
  }
  return latest;
}

function groupEvents(events) {
  const logs = new Map();
  for (const e of events) {
    const key = String(e.candidate_id);
    if (!logs.has(key)) logs.set(key, []);
    logs.get(key).push(e);
  }
  for (const list of logs.values()) list.sort((a, b) => Number(a.seq) - Number(b.seq));
  return logs;
}

// 求人ごとの応募者（現在のひも付け）。協力業者は除外。選考終了・アーカイブも応募実績として含む
// 読み取り（一覧・詳細・応募者モーダル）。保存先が read（PostgreSQL：1回の往復でまとめて読む）を持てばそれを使い、
// 持たなければ（メモリ）トランザクション内で同じデータを読む。書き込みは従来どおりトランザクションとロックで行う
const TX_READERS = {
  categories: tx => tx.listCategories(), postings: tx => tx.listPostings(), revisions: tx => tx.listRevisions(), visibility: tx => tx.listVisibility(),
  planEvents: tx => tx.listPlanEvents(), records: tx => tx.listRecords(), candidates: tx => tx.listCandidatesBasic(), links: tx => tx.listLinks(),
  selectionEvents: tx => tx.listSelectionEvents(),
};
const SUMMARY_KEYS = ["categories", "postings", "revisions", "visibility", "planEvents", "records", "candidates", "links", "selectionEvents"];
async function readData(store, keys, opts = {}) {
  if (typeof store.read === "function") return store.read(keys, opts);
  return store.transaction(async tx => {
    const out = {};
    for (const k of keys) out[k] = await TX_READERS[k](tx);
    return out;
  });
}

function applicantsByPosting({ candidates, links, selectionEvents }) {
  const linkOf = currentLinks(links);
  const logs = groupEvents(selectionEvents);
  const byPosting = new Map();
  for (const c of candidates) {
    if (c.is_coop === true) continue;
    const link = linkOf.get(String(c.id));
    if (!link || link.posting_id == null) continue;
    const state = selectionState(c, logs.get(String(c.id)) || []);
    const key = String(link.posting_id);
    if (!byPosting.has(key)) byPosting.set(key, []);
    byPosting.get(key).push({ candidate: c, state, link });
  }
  return byPosting;
}

// ---------- 求人の要約 ----------

function latestBy(rows, key, order) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[key]);
    const prev = map.get(k);
    if (!prev || Number(r[order]) > Number(prev[order])) map.set(k, r);
  }
  return map;
}

// CSV由来の確認済み情報（その求人原稿の最新の有効な実績の source_meta）
function csvInfo(records, postingId) {
  const rows = records.filter(r => r.kind === "metric" && r.state === "active" && String(r.posting_id) === String(postingId) && r.source_meta)
    .sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)) || Number(b.id) - Number(a.id));
  const meta = rows[0]?.source_meta;
  if (!meta) return null;
  return {
    reference: meta.reference || null, job_title: meta.job_title || null, job_url: meta.job_url || null, location: meta.location || null,
    csv_status: meta.csv_status || null, period_start: rows[0].period_start, period_end: rows[0].period_end, record_id: String(rows[0].id),
  };
}

const withoutDaily = ({ daily: _daily, ...rest }) => rest;

function summaries(data, p, m) {
  const { categories, postings, revisions, visibility, planEvents, records } = data;
  const applicants = applicantsByPosting(data);
  const plans = m.planEventStates(planEvents);
  const planAt = m.planResolver(plans);
  const recs = m.recordStates(records);
  const latestRev = latestBy(revisions, "posting_id", "revision_no");
  const today = p.todayTokyo();
  const rows = postings.map(posting => {
    const category = categories.find(c => String(c.id) === String(posting.category_id));
    const rev = latestRev.get(String(posting.id)) || null;
    const vis = p.visibilityState(visibility.filter(v => String(v.posting_id) === String(posting.id)));
    const people = applicants.get(String(posting.id)) || [];
    const csv = csvInfo(recs, posting.id);
    // 「実績あり」は求人分析で表示できる実績だけを数える（求人分析の集計は既定の媒体＝Indeed の実績が対象）
    const recordCount = recs.filter(r => r.kind === "metric" && r.state === "active" && String(r.posting_id) === String(posting.id) && r.media === m.DEFAULT_MEDIA).length;
    return {
      id: String(posting.id), category_id: String(posting.category_id), category_name: category?.name || "（不明な職種）", category_active: category?.is_active !== false,
      media: posting.media, media_key: p.mediaKey(posting.media), job_id: posting.job_id || null, external_key: posting.external_key,
      csv_title: posting.title || null, title: rev?.title || posting.title || posting.job_id || `求人#${posting.id}`,
      revision_no: rev ? Number(rev.revision_no) : 0, url: rev?.url || null, location: rev?.location || null, employment_type: rev?.employment_type || null,
      visibility: vis.current, visibility_since: vis.since, visibility_seq: vis.seq, first_public: vis.first_public, last_private: vis.last_private,
      applicants: people.length, hires: people.filter(x => x.state.hired).length,
      plan_status: planAt(posting.category_id, posting.id, today)?.status || null, record_count: recordCount,
      csv: csv ? { job_url: csv.job_url, csv_status: csv.csv_status, period_start: csv.period_start, period_end: csv.period_end } : null,
      created_at: posting.created_at,
    };
  });
  return { categories, rows, revisions, visibility, plans, recs, applicants };
}

async function overview(store) {
  const p = await lib();
  if (!(await store.ready())) return { ready: false, as_of: p.todayTokyo(), postings: [], categories: [], media: p.mediaOptions([]) };
  const m = await mlib();
  const { categories, rows } = summaries(await readData(store, SUMMARY_KEYS), p, m);
  // 職種の並び順 → 登録順
  const order = new Map(categories.map((c, i) => [String(c.id), i]));
  rows.sort((a, b) => (order.get(a.category_id) ?? 999) - (order.get(b.category_id) ?? 999) || Number(a.id) - Number(b.id));
  return {
    ready: true, as_of: p.todayTokyo(), postings: rows, counts: p.visibilityCounts(rows), media: p.mediaOptions(rows),
    categories: categories.map(c => ({ id: String(c.id), name: c.name, is_active: c.is_active })),
  };
}

async function detail(store, id) {
  const p = await ensureReady(store);
  const m = await mlib();
  {
    const { categories, rows, revisions, visibility, plans, recs } = summaries(await readData(store, SUMMARY_KEYS, { fullRevisions: true }), p, m);
    const posting = rows.find(r => r.id === String(id));
    if (!posting) throw p.postingError(404, "求人が見つかりません");
    const revs = revisions.filter(r => String(r.posting_id) === posting.id).sort((a, b) => Number(a.revision_no) - Number(b.revision_no));
    const history = revs.map((r, i) => ({ ...r, revision_no: Number(r.revision_no), changes: p.revisionDiff(i ? revs[i - 1] : null, r) })).reverse();
    const visEvents = visibility.filter(v => String(v.posting_id) === posting.id).sort((a, b) => Number(a.seq) - Number(b.seq));
    const planList = plans.filter(e => String(e.category_id) === posting.category_id && (e.posting_id == null || String(e.posting_id) === posting.id));
    const postingRecords = recs.filter(r => r.kind === "metric" && String(r.posting_id) === posting.id);
    const categoryRecords = recs.filter(r => r.kind === "metric" && r.posting_id == null && String(r.category_id) === posting.category_id && r.state === "active");
    return {
      ready: true, as_of: p.todayTokyo(), posting,
      category: categories.find(c => String(c.id) === posting.category_id) || null,
      current: revs.length ? revs[revs.length - 1] : null,
      revisions: history,
      visibility: { ...p.visibilityState(visEvents), events: visEvents.slice().reverse() },
      plan_events: planList.slice().reverse(),
      // 日別データ（daily）は詳細画面で使わないため返さない（一覧・詳細の読み取りでは読まない）
      records: postingRecords.slice().reverse().map(withoutDaily),
      category_records: categoryRecords.slice().reverse().map(withoutDaily),
      improvements: p.improvementTimeline({ revisions: revs, records: [...postingRecords, ...categoryRecords], planEvents: planList }),
      csv: csvInfo(recs, posting.id),
    };
  }
}

// 応募数・採用数の対象者（氏名・応募日・応募経路・現在の選考状態）。ログイン利用者のみ（部長会トークンでは使えない）
async function candidates(store, id, kind) {
  const p = await ensureReady(store);
  if (!["applied", "hired"].includes(kind)) throw p.postingError(400, "対象が正しくありません");
  {
    const data = await readData(store, ["postings", "candidates", "links", "selectionEvents"]);
    const posting = data.postings.find(x => String(x.id) === String(id));
    if (!posting) throw p.postingError(404, "求人が見つかりません");
    const people = applicantsByPosting(data).get(String(posting.id)) || [];
    const list = people.filter(x => kind === "applied" || x.state.hired).map(({ candidate: c, state }) => ({
      id: String(c.id), name: c.name_kanji || "（氏名未登録）", applied_date: flow.ymd(c.applied_at),
      source_type: c.source_type || null, agent_name: c.agent_name || null, selection_label: state.label, hired: state.hired, archived: c.is_deleted === true,
    })).sort((a, b) => String(b.applied_date || "").localeCompare(String(a.applied_date || "")) || Number(b.id) - Number(a.id));
    return { posting_id: String(posting.id), kind, candidates: list };
  }
}

// ---------- 求人の登録・修正・公開状態 ----------

const randomKey = () => crypto.randomBytes(9).toString("base64url");

async function createPosting(store, body, actor) {
  const p = await ensureReady(store);
  const head = p.validateNewPosting(body);
  const rev = p.validateRevision(body);
  const today = p.todayTokyo();
  const vis = head.visibility ? p.validateVisibility({ visibility: head.visibility, effective_date: body.effective_date, reason: body.visibility_reason }, { current: null, since: null, today }) : null;
  return store.transaction(async tx => {
    await tx.lock();
    if (!(await tx.listCategories()).some(c => String(c.id) === head.category_id)) throw p.postingError(400, "職種が見つかりません");
    const postings = await tx.listPostings();
    // 登録済みの求人と表記だけが違う媒体名は、登録済みの表記にそろえる（表記揺れによる媒体の重複を防ぐ）
    head.media = p.canonicalMedia(head.media, postings.map(x => x.media));
    const external_key = p.externalKeyFor(head.job_id, randomKey());
    // 既存の求人は、表記だけが違う媒体名（例：「求人 ボックス」）でも同じ媒体として重複を判定する（既存の値は書き換えない）
    const dup = postings.find(x => p.mediaMatchKey(x.media) === p.mediaMatchKey(head.media) && x.external_key === external_key);
    if (dup) throw p.postingError(409, `この媒体・求人IDの求人は既に登録されています（${dup.title || dup.job_id}）`, { code: "duplicate", posting_id: String(dup.id) });
    const posting = await tx.insertPosting({ category_id: head.category_id, media: head.media, external_key, job_id: head.job_id, title: rev.title, actor });
    await tx.insertRevision({ ...rev, posting_id: posting.id, revision_no: 1, actor });
    if (vis) await tx.insertVisibility({ posting_id: posting.id, seq: 1, previous_visibility: null, ...vis, actor });
    return { id: String(posting.id) };
  });
}

// 求人内容の修正（新しい版を追加）。expected_revision_no は編集を始めたときの版（初版未登録は 0）
async function addRevision(store, id, body, actor) {
  const p = await ensureReady(store);
  const rev = p.validateRevision(body);
  const expected = Number(body?.expected_revision_no);
  if (!Number.isInteger(expected) || expected < 0) throw p.postingError(400, "版の情報が正しくありません。画面を読み込み直してください");
  return store.transaction(async tx => {
    await tx.lock();
    const posting = (await tx.listPostings()).find(x => String(x.id) === String(id));
    if (!posting) throw p.postingError(404, "求人が見つかりません");
    const revs = (await tx.listRevisions()).filter(r => String(r.posting_id) === String(posting.id));
    const latest = revs.reduce((max, r) => Number(r.revision_no) > Number(max?.revision_no || 0) ? r : max, null);
    const latestNo = latest ? Number(latest.revision_no) : 0;
    if (expected !== latestNo)
      throw p.postingError(409, "他の画面で求人内容が修正されています。画面を読み込み直してから修正してください（今回の内容は保存していません）", { code: "stale" });
    if (latest && p.sameContent(latest, rev)) throw p.postingError(400, "求人内容に変更がありません");
    if (latest && !rev.change_summary) throw p.postingError(400, "修正内容を入力してください");
    await tx.insertRevision({ ...rev, posting_id: posting.id, revision_no: latestNo + 1, actor });
    return { id: String(posting.id), revision_no: latestNo + 1 };
  });
}

// 公開／非公開の切替（NKS内部の管理状態。外部サイトには何も送らない）。expected_seq は画面で表示していた切替履歴の件数
async function setVisibility(store, id, body, actor) {
  const p = await ensureReady(store);
  const expected = Number(body?.expected_seq);
  if (!Number.isInteger(expected) || expected < 0) throw p.postingError(400, "公開状態の情報が正しくありません。画面を読み込み直してください");
  return store.transaction(async tx => {
    await tx.lock();
    const posting = (await tx.listPostings()).find(x => String(x.id) === String(id));
    if (!posting) throw p.postingError(404, "求人が見つかりません");
    const state = p.visibilityState((await tx.listVisibility()).filter(v => String(v.posting_id) === String(posting.id)));
    if (expected !== state.seq)
      throw p.postingError(409, "他の画面で公開状態が変更されています。画面を読み込み直してください（今回の切替は保存していません）", { code: "stale" });
    const value = p.validateVisibility(body, { current: state.current, since: state.since, today: p.todayTokyo() });
    await tx.insertVisibility({ posting_id: posting.id, seq: state.seq + 1, previous_visibility: state.current, ...value, actor });
    return { id: String(posting.id), visibility: value.visibility, seq: state.seq + 1 };
  });
}

// ---------- 応募者とのひも付け ----------

// 応募者の現在のひも付けと履歴
async function candidateLink(store, candidateId) {
  const p = await lib();
  if (!(await store.ready())) return { ready: false, current: null, history: [] };
  {
    const data = await readData(store, ["links", "postings", "revisions"]);
    const links = data.links.filter(l => String(l.candidate_id) === String(candidateId)).sort((a, b) => Number(a.seq) - Number(b.seq));
    const postings = data.postings;
    const revisions = latestBy(data.revisions, "posting_id", "revision_no");
    const label = pid => {
      if (pid == null) return null;
      const x = postings.find(q => String(q.id) === String(pid));
      return x ? { id: String(x.id), media: x.media, title: revisions.get(String(x.id))?.title || x.title || x.job_id || `求人#${x.id}`, job_id: x.job_id || null } : { id: String(pid), media: null, title: `求人#${pid}`, job_id: null };
    };
    const history = links.map((l, i) => ({ id: String(l.id), seq: Number(l.seq), posting: label(l.posting_id), previous: i ? label(links[i - 1].posting_id) : null, reason: l.reason || null, actor: l.actor || null, created_at: l.created_at }));
    const last = links[links.length - 1] || null;
    return { ready: true, link_id: last ? String(last.id) : null, current: last ? label(last.posting_id) : null, history: history.reverse(), media: p.mediaOptions(postings) };
  }
}

// 応募者の保存（基本情報のPUT・新規登録のPOST）と同じトランザクション内で呼ぶ。応募者の行はロック済みであること。
// candidate: { id, is_coop, source_type }（保存後の値。source_type を持たない場合は応募経路の確認をしない）
// value: { posting_id: 求人ID | null（該当求人なし・不明）, expected_link_id: 画面で表示していた現在のひも付け（無ければ null）, reason }
async function applyLink(tx, candidate, value, actor) {
  const p = await lib();
  if (!value || typeof value !== "object") throw p.postingError(400, "求人の選択が正しくありません");
  const postingId = value.posting_id == null || value.posting_id === "" ? null : String(value.posting_id);
  // 協力業者は求人にひも付けない（外す操作だけは受け付ける）
  if (candidate.is_coop === true && postingId != null) throw p.postingError(400, "協力業者は求人にひも付けできません");
  // 求人を選べるのは、応募経路の種別が「求人」の場合だけ
  if (postingId != null && Object.hasOwn(candidate, "source_type") && candidate.source_type !== "求人")
    throw p.postingError(400, "求人を選べるのは、応募経路の種別が「求人」の場合だけです");
  if (postingId != null && !/^\d+$/.test(postingId)) throw p.postingError(400, "求人の選択が正しくありません");
  const reason = value.reason == null ? null : String(value.reason).trim().slice(0, 500) || null;
  const links = (await tx.listLinks()).filter(l => String(l.candidate_id) === String(candidate.id));
  const last = links.reduce((max, l) => Number(l.seq) > Number(max?.seq || 0) ? l : max, null);
  const expected = value.expected_link_id == null || value.expected_link_id === "" ? null : String(value.expected_link_id);
  if ((last ? String(last.id) : null) !== expected)
    throw p.postingError(409, "この応募者の求人のひも付けが他の画面で変更されています。画面を読み込み直してから保存してください（今回の保存は行っていません）", { code: "link_stale" });
  const currentPosting = last?.posting_id == null ? null : String(last.posting_id);
  if (currentPosting === postingId && (last || postingId == null)) return { changed: false };
  if (postingId != null && !(await tx.listPostings()).some(x => String(x.id) === postingId)) throw p.postingError(400, "選択した求人が見つかりません");
  await tx.insertLink({ candidate_id: candidate.id, seq: (last ? Number(last.seq) : 0) + 1, posting_id: postingId, reason, actor });
  return { changed: true };
}

// 保存後の応募者の状態とひも付けの整合（PUTのトランザクション内、ひも付けの保存の後に呼ぶ）。
// 協力業者、または応募経路の種別が「求人」以外になるのに求人へのひも付けが残る場合は、保存しない（409）。
// 新しい画面は、この場合ひも付けを外す指定（posting_id: null）を同時に送る。ひも付けを読み込めていない画面・古い画面からは保存できない。
async function assertLinkConsistent(tx, candidate) {
  const p = await lib();
  if (candidate.is_coop !== true && candidate.source_type === "求人") return;
  const links = (await tx.listLinks()).filter(l => String(l.candidate_id) === String(candidate.id));
  const last = links.reduce((max, l) => Number(l.seq) > Number(max?.seq || 0) ? l : max, null);
  if (!last || last.posting_id == null) return;
  throw p.postingError(409, "この応募者は求人にひも付いているため、" + (candidate.is_coop === true ? "協力業者への変更" : "応募経路の種別の変更")
    + "は、画面を読み込み直してから保存してください（ひも付けは外され、履歴に残ります）。今回の保存は行っていません", { code: "link_required" });
}

// 単独のひも付け変更（PUTを使わない画面・テスト用）。応募者の行をロックしてから判定する
async function setCandidateLink(store, candidateId, value, actor) {
  const p = await ensureReady(store);
  if (!/^\d+$/.test(String(candidateId))) throw p.postingError(404, "応募者が見つかりません");
  return store.transaction(async tx => {
    const candidate = await tx.getCandidate(candidateId, { lock: true });
    if (!candidate) throw p.postingError(404, "応募者が見つかりません");
    return applyLink(tx, candidate, value, actor);
  });
}

module.exports = {
  overview, detail, candidates, createPosting, addRevision, setVisibility, candidateLink, applyLink, assertLinkConsistent, setCandidateLink,
  selectionState, currentLinks, HIRED_KINDS, UNAVAILABLE_MESSAGE,
};
