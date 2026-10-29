"use strict";
// 求人分析のメモリ保存先。テストとローカルプレビュー専用（DBには接続しない）。
// PostgreSQL版と同じく、実績・取込・職種の変更履歴・求人原稿・掲載状態の履歴は追記のみ（変更・削除の手段を持たない）。
const DEFAULT_CATEGORIES = ["営業", "CADオペ（ときがわ）", "CADオペ（本社）", "電気工事士"];

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const now = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date());

function createMemoryMarketingStore({ ready = true, categories = DEFAULT_CATEGORIES } = {}) {
  const db = { categories: [], categoryEvents: [], postings: [], planEvents: [], records: [], imports: [], references: [] };
  let nextId = 1;
  categories.forEach((name, i) => db.categories.push({ id: String(nextId++), name, is_active: true, sort_order: (i + 1) * 10, created_at: now(), updated_at: now() }));
  let lock = Promise.resolve();

  const tx = {
    async lock() { /* transaction() が直列化している */ },
    async listCategories() { return clone(db.categories).sort((a, b) => a.sort_order - b.sort_order || Number(a.id) - Number(b.id)); },
    async listCategoryEvents() { return clone(db.categoryEvents); },
    async insertCategory({ name, sort_order }) {
      const row = { id: String(nextId++), name, is_active: true, sort_order, created_at: now(), updated_at: now() };
      db.categories.push(row);
      return clone(row);
    },
    async updateCategory(id, changes) {
      const row = db.categories.find(c => c.id === String(id));
      Object.assign(row, clone(changes), { updated_at: now() });
      return clone(row);
    },
    async insertCategoryEvent(event) { db.categoryEvents.push({ ...clone(event), id: String(nextId++), category_id: String(event.category_id), created_at: now() }); },
    async listPostings() { return clone(db.postings); },
    async insertPosting(row) {
      if (db.postings.some(p => p.media === row.media && p.external_key === row.external_key)) throw new Error("duplicate posting"); // PostgreSQL版の一意索引と同じ
      const posting = { id: String(nextId++), category_id: String(row.category_id), media: row.media, external_key: row.external_key, job_id: row.job_id ?? null, title: row.title ?? null, actor: row.actor ?? null, created_at: now() };
      db.postings.push(posting);
      return clone(posting);
    },
    async listPlanEvents() { return clone(db.planEvents); },
    async insertPlanEvent(row) {
      if (row.supersedes_id != null && db.planEvents.some(e => String(e.supersedes_id) === String(row.supersedes_id))) throw new Error("duplicate supersedes_id");
      const id = String(nextId++);
      db.planEvents.push({
        id, kind: row.kind, category_id: String(row.category_id), posting_id: row.posting_id == null ? null : String(row.posting_id),
        supersedes_id: row.supersedes_id == null ? null : String(row.supersedes_id), status: row.status ?? null, effective_date: row.effective_date ?? null,
        budget: row.budget ?? null, note: row.note ?? null, reason: row.reason ?? null, actor: row.actor ?? null, created_at: now(),
      });
      return id;
    },
    async listRecords() { return clone(db.records); },
    async insertRecord(row) {
      if (row.supersedes_id != null && db.records.some(r => String(r.supersedes_id) === String(row.supersedes_id)))
        throw new Error("duplicate supersedes_id"); // PostgreSQL版の一意索引と同じ
      const id = String(nextId++);
      db.records.push({
        id, kind: row.kind, category_id: String(row.category_id), supersedes_id: row.supersedes_id == null ? null : String(row.supersedes_id),
        media: row.media ?? null, period_start: row.period_start ?? null, period_end: row.period_end ?? null, plan_type: row.plan_type ?? null,
        impressions: row.impressions ?? null, clicks: row.clicks ?? null, apply_starts: row.apply_starts ?? null, applies: row.applies ?? null,
        cost: row.cost ?? null, note: row.note ?? null, source: row.source ?? null, posting_id: row.posting_id == null ? null : String(row.posting_id), import_id: row.import_id == null ? null : String(row.import_id),
        source_meta: clone(row.source_meta ?? null), daily: clone(row.daily ?? null), reason: row.reason ?? null, actor: row.actor ?? null, created_at: now(),
      });
      return id;
    },
    async listImports() { return clone(db.imports); },
    async insertImport(row) {
      const id = String(nextId++);
      db.imports.push({ ...clone(row), id, created_at: now() });
      return id;
    },
    async listReferences() { return clone(db.references); },
    async insertReference(row) {
      const ref = { id: String(nextId++), category_id: String(row.category_id), company_name: row.company_name, job_title: row.job_title ?? null, url: row.url ?? null, memo: row.memo ?? null, checked_on: row.checked_on ?? null, is_deleted: false, actor: row.actor ?? null, created_at: now(), updated_at: now() };
      db.references.push(ref);
      return clone(ref);
    },
    async updateReference(id, changes) {
      const ref = db.references.find(r => r.id === String(id));
      Object.assign(ref, clone(changes), { updated_at: now() });
      return clone(ref);
    },
  };

  return {
    ready: async () => ready,
    // 1件ずつ直列実行し、失敗時は全体を元に戻す（DBのトランザクション相当）
    transaction(work) {
      const run = lock.then(async () => {
        const snapshot = clone(db);
        const savedId = nextId;
        try {
          return await work(tx);
        } catch (err) {
          for (const key of Object.keys(db)) db[key] = snapshot[key];
          nextId = savedId;
          throw err;
        }
      });
      lock = run.catch(() => {});
      return run;
    },
    dump: () => clone(db),
  };
}

module.exports = { createMemoryMarketingStore, DEFAULT_CATEGORIES };
