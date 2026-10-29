"use strict";
// 求人マーケティング分析（第4弾）の読み書き手順。保存先（PostgreSQL / テスト・プレビュー用メモリ）は store で差し替える。
// 実績は追記のみ：修正は新しい行が旧行を置き換え（supersedes_id）、取消は void 行を追記する。元の行は変更しない。
// 掲載状態（無料・有料・不明・募集停止）も変更日つきの追記専用の履歴。職種全体の現在の状態が「募集停止」かどうかと、職種の募集状態（is_active）をそろえる。
// 書き込みは1トランザクション内で直列化（store.lock）してから、重複・期間の重なりを判定する。
// 応募者・採用経費・部長会・モバイルのテーブルと集計には触れない。
let shared;
const lib = () => (shared ||= import("../shared/jobMarketing.mjs"));

const UNAVAILABLE_MESSAGE = "求人分析のテーブルが未作成のため、求人分析は使用できません";

async function ensureReady(store) {
  const m = await lib();
  if (!(await store.ready())) throw m.marketingError(503, UNAVAILABLE_MESSAGE, { code: "marketing_unavailable" });
  return m;
}

async function overview(store) {
  const m = await lib();
  if (!(await store.ready())) return { ready: false, as_of: m.todayTokyo(), categories: [], records: [], imports: [], references: [], category_events: [], postings: [], plan_events: [] };
  return store.transaction(async tx => ({
    ready: true,
    as_of: m.todayTokyo(),
    categories: await tx.listCategories(),
    category_events: await tx.listCategoryEvents(),
    postings: await tx.listPostings(),
    plan_events: m.planEventStates(await tx.listPlanEvents()),
    records: m.recordStates(await tx.listRecords()),
    imports: await tx.listImports(),
    references: (await tx.listReferences()).filter(r => !r.is_deleted),
  }));
}

// ---------- 職種 ----------

async function createCategory(store, body, actor) {
  const m = await ensureReady(store);
  const name = m.validateCategoryName(body?.name);
  return store.transaction(async tx => {
    await tx.lock();
    const list = await tx.listCategories();
    if (list.some(c => m.sameCategoryName(c.name, name))) throw m.marketingError(409, "同じ名前の職種が既にあります");
    const sort = list.reduce((max, c) => Math.max(max, Number(c.sort_order) || 0), 0) + 10;
    const created = await tx.insertCategory({ name, sort_order: sort });
    await tx.insertCategoryEvent({ category_id: created.id, kind: "created", before: null, after: name, actor });
    return created;
  });
}

// 名称変更・募集停止・再開。実績はIDで関連付けているため、名称を変えても過去実績は保たれる
async function updateCategory(store, id, body, actor) {
  const m = await ensureReady(store);
  return store.transaction(async tx => {
    await tx.lock();
    const list = await tx.listCategories();
    const current = list.find(c => String(c.id) === String(id));
    if (!current) throw m.marketingError(404, "職種が見つかりません");
    const changes = {};
    if (body && Object.hasOwn(body, "name")) {
      const name = m.validateCategoryName(body.name);
      if (name !== current.name) {
        if (list.some(c => String(c.id) !== String(id) && m.sameCategoryName(c.name, name))) throw m.marketingError(409, "同じ名前の職種が既にあります");
        changes.name = name;
        await tx.insertCategoryEvent({ category_id: current.id, kind: "renamed", before: current.name, after: name, actor });
      }
    }
    if (body && Object.hasOwn(body, "is_active")) {
      if (typeof body.is_active !== "boolean") throw m.marketingError(400, "募集状態が正しくありません");
      if (body.is_active !== current.is_active) {
        changes.is_active = body.is_active;
        await tx.insertCategoryEvent({ category_id: current.id, kind: body.is_active ? "resumed" : "paused", before: null, after: null, actor });
        // 掲載状態の履歴にも本日付で記録する（再開後の掲載方法は分からないため「不明」）
        const today = m.todayTokyo();
        const status = (await currentStatus(tx, m, current.id, today))?.status;
        if (!body.is_active && status !== "stopped")
          await tx.insertPlanEvent({ kind: "change", category_id: current.id, posting_id: null, status: "stopped", effective_date: today, note: "職種の管理から募集停止", actor });
        if (body.is_active && status === "stopped")
          await tx.insertPlanEvent({ kind: "change", category_id: current.id, posting_id: null, status: "unknown", effective_date: today, note: "職種の管理から募集再開（掲載方法は未設定）", actor });
      }
    }
    if (!Object.keys(changes).length) return current;
    return tx.updateCategory(current.id, changes);
  });
}

// ---------- 掲載状態 ----------

async function currentStatus(tx, m, categoryId, date) {
  return m.planResolver(m.planEventStates(await tx.listPlanEvents()))(categoryId, null, date);
}

// 職種全体の本日時点の掲載状態に合わせて、募集中／停止中をそろえる（有効な履歴が無くなった場合は募集中に戻す）
async function syncCategoryActive(tx, m, category, actor) {
  const status = (await currentStatus(tx, m, category.id, m.todayTokyo()))?.status;
  const shouldBeActive = status !== "stopped";
  if (category.is_active === shouldBeActive) return;
  await tx.updateCategory(category.id, { is_active: shouldBeActive });
  await tx.insertCategoryEvent({ category_id: category.id, kind: shouldBeActive ? "resumed" : "paused", before: null, after: null, actor });
}

// 掲載状態の変更（無料→有料など）。変更前の実績・履歴はそのまま残る
async function savePlanEvent(store, body, actor) {
  const m = await ensureReady(store);
  const value = m.validatePlanEvent(body);
  // 予定日の登録はしない（到来時に職種の募集状態と食い違うため）
  if (value.effective_date > m.todayTokyo()) throw m.marketingError(400, `${value.status === "paid" ? "有料掲載開始日" : "変更日"}は本日以前の日付を入力してください`);
  return store.transaction(async tx => {
    await tx.lock();
    const category = (await tx.listCategories()).find(c => String(c.id) === value.category_id);
    if (!category) throw m.marketingError(404, "職種が見つかりません");
    if (value.posting_id && !(await tx.listPostings()).some(p => String(p.id) === value.posting_id && String(p.category_id) === value.category_id))
      throw m.marketingError(400, "この職種の求人原稿ではありません");
    const id = await tx.insertPlanEvent({ kind: "change", ...value, actor });
    if (!value.posting_id) await syncCategoryActive(tx, m, category, actor);
    return { id: String(id) };
  });
}

async function voidPlanEvent(store, id, body, actor) {
  const m = await ensureReady(store);
  const reason = String(body?.reason || "").trim();
  if (!reason) throw m.marketingError(400, "取消の理由を入力してください");
  return store.transaction(async tx => {
    await tx.lock();
    const target = m.planEventStates(await tx.listPlanEvents()).find(e => String(e.id) === String(id) && e.state === "active");
    if (!target) throw m.marketingError(409, "この変更は既に取消されているか、見つかりません。画面を読み込み直してください", { code: "stale" });
    await tx.insertPlanEvent({ kind: "void", category_id: target.category_id, supersedes_id: target.id, reason: reason.slice(0, m.LIMITS.reason), actor });
    const category = (await tx.listCategories()).find(c => String(c.id) === String(target.category_id));
    if (!target.posting_id && category) await syncCategoryActive(tx, m, category, actor);
    return { ok: true };
  });
}

// ---------- 実績 ----------

// 登録前の判定。conflicts（重なる有効な記録）は、置き換え（replace_ids）か、理由付きの重複登録（allow_overlap）で解消する。
// 期間が完全に同じ記録は二重計上を防ぐため重複登録できない（置き換えのみ）。
function resolvePlan(m, active, categories, entries, postings = []) {
  const planned = [];
  const problems = [];
  entries.forEach((entry, index) => {
    const { record } = entry;
    const category = categories.find(c => String(c.id) === String(record.category_id));
    if (!category) { problems.push({ index, code: "category", message: "職種が見つかりません" }); return; }
    if (record.posting_id && !String(record.posting_id).startsWith("pending:")
      && !postings.some(p => String(p.id) === String(record.posting_id) && String(p.category_id) === String(record.category_id))) {
      problems.push({ index, code: "posting", message: "この職種の求人原稿ではありません" });
      return;
    }
    const replaceIds = (entry.replace_ids || []).map(String);
    for (const rid of replaceIds) {
      const target = active.find(r => String(r.id) === rid);
      // 職種の登録先を誤った記録の修正もできるよう、置き換え先の職種は問わない
      if (!target) { problems.push({ index, code: "stale", message: "置き換え対象の記録が既に修正・取消されています。画面を読み込み直してください" }); return; }
    }
    const others = [...active, ...planned.map(p => ({ ...p.record, id: `new-${p.index}` }))];
    const conflicts = m.findConflicts(others, record, replaceIds);
    const same = conflicts.filter(c => c.type === "same_period");
    if (same.length) {
      problems.push({ index, code: "same_period", message: `${m.periodLabel(record.period_start, record.period_end)}は同じ期間の記録が既にあります。二重計上を防ぐため、既存の記録を置き換えてください`, conflicts });
      return;
    }
    if (conflicts.length && !entry.allow_overlap) {
      problems.push({ index, code: "overlap", message: `${m.periodLabel(record.period_start, record.period_end)}は期間が重なる記録があります（合算はしません）`, conflicts });
      return;
    }
    if (conflicts.length && !String(entry.overlap_reason || "").trim()) {
      problems.push({ index, code: "overlap_reason", message: "期間が重なったまま登録する理由を入力してください", conflicts });
      return;
    }
    planned.push({ index, record, replaceIds, conflicts, overlapReason: conflicts.length ? String(entry.overlap_reason).trim().slice(0, m.LIMITS.reason) : null });
  });
  return { planned, problems };
}

function normalizeEntry(m, raw, defaults = {}) {
  const record = m.normalizeRecord({ ...raw?.record, ...defaults });
  return {
    record,
    replace_ids: Array.isArray(raw?.replace_ids) ? raw.replace_ids.filter(v => /^\d+$/.test(String(v))).map(String) : [],
    allow_overlap: raw?.allow_overlap === true,
    overlap_reason: typeof raw?.overlap_reason === "string" ? raw.overlap_reason : "",
    posting: raw?.posting ? m.postingOf(raw.posting) : null,
  };
}

async function writePlanned(tx, m, planned, actor, importId, pendingPostings = new Map()) {
  const ids = [];
  const created = new Map();
  for (const p of planned) {
    // 新しい求人原稿は実績の登録時に作成する
    const pid = p.record.posting_id;
    if (pid && String(pid).startsWith("pending:")) {
      if (!created.has(pid)) created.set(pid, (await tx.insertPosting({ ...pendingPostings.get(pid), actor })).id);
      p.record = { ...p.record, posting_id: created.get(pid) };
    }
    const [first, ...rest] = p.replaceIds;
    const meta = { ...(p.record.source_meta || {}) };
    if (p.overlapReason) meta.overlap = { reason: p.overlapReason, with: p.conflicts.map(c => c.id) };
    const id = await tx.insertRecord({
      ...p.record, kind: "metric", supersedes_id: first ?? null, import_id: importId ?? null,
      source_meta: Object.keys(meta).length ? meta : null, reason: null, actor,
    });
    // 2件目以降の置き換え対象は取消の行を追記する（どの記録で置き換えたかを残す）
    for (const rid of rest) {
      await tx.insertRecord({ kind: "void", supersedes_id: rid, category_id: p.record.category_id, reason: `記録#${id}で置き換え`, source_meta: { replaced_by: String(id) }, actor });
    }
    ids.push(String(id));
  }
  return ids;
}

function conflictError(m, problems) {
  const first = problems[0];
  return m.marketingError(409, first.message, { code: first.code, problems });
}

// 手入力の登録・修正。修正は supersedes_id に元の記録を指定する（元の記録は履歴として残る）
// CSVの日別実績を修正するときは、日別データ・期間・取込元（取込記録との関連を含む）を元の記録から引き継ぎ、
// 掲載種別とメモだけを反映する（数値を直す場合は取消して再取込する）。日別データが失われて集計が変わるのを防ぐ。
const DAILY_KEEP = ["category_id", "media", "period_start", "period_end", "impressions", "clicks", "apply_starts", "applies", "cost", "source", "source_meta", "daily", "posting_id"];

async function saveRecord(store, body, actor) {
  const m = await ensureReady(store);
  normalizeEntry(m, body); // 入力の形式チェック（トランザクション前）
  return store.transaction(async tx => {
    await tx.lock();
    const active = m.activeRecords(await tx.listRecords());
    const categories = await tx.listCategories();
    const target = body?.supersedes_id == null ? null : active.find(r => String(r.id) === String(body.supersedes_id));
    const keepDaily = Boolean(target && Array.isArray(target.daily) && target.daily.length);
    const entry = normalizeEntry(m, keepDaily
      ? { ...body, record: { ...Object.fromEntries(DAILY_KEEP.map(k => [k, target[k]])), plan_type: body.record?.plan_type, note: body.record?.note } }
      : body);
    if (body?.supersedes_id != null) entry.replace_ids = [String(body.supersedes_id), ...entry.replace_ids.filter(id => id !== String(body.supersedes_id))];
    const { planned, problems } = resolvePlan(m, active, categories, [entry], await tx.listPostings());
    const warnings = m.recordWarnings(entry.record);
    if (body?.dry_run === true) return { dry_run: true, problems, warnings, conflicts: problems[0]?.conflicts || [] };
    if (problems.length) throw conflictError(m, problems);
    const [id] = await writePlanned(tx, m, planned, actor, keepDaily ? target.import_id : null);
    return { id, warnings, kept_daily: keepDaily };
  });
}

async function voidRecord(store, id, body, actor) {
  const m = await ensureReady(store);
  const reason = String(body?.reason || "").trim();
  if (!reason) throw m.marketingError(400, "取消の理由を入力してください");
  return store.transaction(async tx => {
    await tx.lock();
    const target = m.activeRecords(await tx.listRecords()).find(r => String(r.id) === String(id));
    if (!target) throw m.marketingError(409, "この記録は既に修正・取消されているか、見つかりません。画面を読み込み直してください", { code: "stale" });
    await tx.insertRecord({ kind: "void", supersedes_id: target.id, category_id: target.category_id, reason: reason.slice(0, m.LIMITS.reason), source_meta: null, actor });
    return { ok: true };
  });
}

// CSV取り込み。ブラウザで解析・確認した内容（日別データを含む）を受け取り、サーバーで再検証して登録する。
// 同じファイル（SHA-256）の有効な記録がある場合は二重登録として拒否する。
async function importCsv(store, body, actor) {
  const m = await ensureReady(store);
  const fileHash = String(body?.file_hash || "");
  if (!/^[0-9a-f]{64}$/.test(fileHash)) throw m.marketingError(400, "ファイルの識別情報が正しくありません");
  const fileName = String(body?.file_name || "").trim().slice(0, 255) || "(名称なし)";
  const format = body?.format === "indeed" ? "indeed_csv" : body?.format === "legacy" ? "legacy_csv" : null;
  if (!format) throw m.marketingError(400, "CSVの形式が正しくありません");
  const rawEntries = Array.isArray(body?.entries) ? body.entries : [];
  if (!rawEntries.length) throw m.marketingError(400, "登録する実績を1件以上選択してください");
  if (rawEntries.length > 50) throw m.marketingError(400, "一度に登録できる実績は50件までです");
  const entries = rawEntries.map(raw => normalizeEntry(m, raw, { source: format }));
  if (format === "indeed_csv" && entries.some(e => !e.record.daily)) throw m.marketingError(400, "Indeed CSVの実績には日別データが必要です");
  const references = (Array.isArray(body?.references) ? body.references : []).slice(0, 50).map(ref => ({ category_id: String(ref?.category_id ?? ""), ...m.validateReference(ref) }));
  return store.transaction(async tx => {
    await tx.lock();
    const rows = await tx.listRecords();
    const active = m.activeRecords(rows);
    const imports = await tx.listImports();
    const previous = imports.filter(i => i.file_hash === fileHash);
    const stillActive = previous.filter(i => active.some(r => String(r.import_id) === String(i.id)));
    const categories = await tx.listCategories();
    // 求人原稿（求人ID・職種名）の割当。既存の原稿は登録済みの職種と一致する必要がある（曖昧なまま別の職種へ混ぜない）
    const postings = await tx.listPostings();
    const pendingPostings = new Map();
    const postingProblems = [];
    entries.forEach((e, index) => {
      if (!e.posting) return;
      const found = postings.find(p => p.media === e.record.media && p.external_key === e.posting.key);
      if (found) {
        if (String(found.category_id) !== e.record.category_id) {
          const name = categories.find(c => String(c.id) === String(found.category_id))?.name || "別の職種";
          postingProblems.push({ index, code: "posting_category", message: `求人「${e.posting.title || e.posting.job_id}」は「${name}」に登録済みです。取込先の職種を確認してください` });
        } else e.record.posting_id = String(found.id);
        return;
      }
      const pid = `pending:${e.record.media}:${e.posting.key}`;
      const prev = pendingPostings.get(pid);
      if (prev && prev.category_id !== e.record.category_id) postingProblems.push({ index, code: "posting_category", message: "同じ求人が別々の職種に割り当てられています" });
      pendingPostings.set(pid, { category_id: e.record.category_id, media: e.record.media, external_key: e.posting.key, job_id: e.posting.job_id, title: e.posting.title });
      e.record.posting_id = pid;
    });
    const { planned, problems } = resolvePlan(m, active, categories, entries, postings);
    problems.push(...postingProblems);
    if (stillActive.length) problems.unshift({ index: null, code: "duplicate_file", message: `このCSVは登録済みです（${stillActive[0].created_at} 取込）。修正する場合は、登録済みの記録を取消してから取り込んでください` });
    for (const ref of references) if (!categories.some(c => String(c.id) === ref.category_id)) problems.push({ index: null, code: "category", message: "参考求人の職種が見つかりません" });
    const warnings = entries.map(e => m.recordWarnings(e.record));
    if (body?.dry_run === true) return { dry_run: true, problems, warnings, previous_imports: previous.length };
    if (problems.length) throw conflictError(m, problems);
    const importId = await tx.insertImport({ file_name: fileName, file_hash: fileHash, format, record_count: planned.length, actor });
    const ids = await writePlanned(tx, m, planned, actor, importId, pendingPostings);
    for (const ref of references) await tx.insertReference({ ...ref, actor });
    return { import_id: String(importId), ids, references: references.length };
  });
}

// ---------- 参考求人 ----------

async function createReference(store, body, actor) {
  const m = await ensureReady(store);
  const value = m.validateReference(body);
  return store.transaction(async tx => {
    const categories = await tx.listCategories();
    if (!categories.some(c => String(c.id) === String(body?.category_id))) throw m.marketingError(400, "職種を選択してください");
    return tx.insertReference({ ...value, category_id: String(body.category_id), actor });
  });
}

async function updateReference(store, id, body, actor) {
  const m = await ensureReady(store);
  const value = m.validateReference(body);
  return store.transaction(async tx => {
    const current = (await tx.listReferences()).find(r => String(r.id) === String(id) && !r.is_deleted);
    if (!current) throw m.marketingError(404, "参考求人が見つかりません");
    return tx.updateReference(current.id, { ...value, actor });
  });
}

async function deleteReference(store, id, actor) {
  const m = await ensureReady(store);
  return store.transaction(async tx => {
    const current = (await tx.listReferences()).find(r => String(r.id) === String(id) && !r.is_deleted);
    if (!current) throw m.marketingError(404, "参考求人が見つかりません");
    await tx.updateReference(current.id, { is_deleted: true, actor });
    return { ok: true };
  });
}

module.exports = {
  overview, createCategory, updateCategory, savePlanEvent, voidPlanEvent, saveRecord, voidRecord, importCsv,
  createReference, updateReference, deleteReference, UNAVAILABLE_MESSAGE,
};
