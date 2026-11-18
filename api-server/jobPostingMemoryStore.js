"use strict";
// 求人一覧（第5弾）のメモリ保存先。テストとローカルプレビュー専用（DBには接続しない）。
// PostgreSQL版と同じく、版・公開状態・ひも付けは追記のみ（変更・削除の手段を持たない）。
// 求人原稿・掲載状態・実績は求人分析のメモリ保存先と共有し、同じトランザクション（直列実行・失敗時は全体を元に戻す）で扱う。
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const now = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date());

// candidates: 応募者配列（呼び出し元と共有）、selectionStore: 選考履歴のメモリ保存先（log(id) を持つ）
function createMemoryJobPostingStore({ marketingStore, candidates = [], selectionStore = null, ready = true, failOn = null } = {}) {
  let db = { revisions: [], visibility: [], links: [] };
  let seq = {};
  const nextId = table => String(seq[table] = (seq[table] || 0) + 1);

  const own = {
    async listRevisions() { return clone(db.revisions); },
    async insertRevision(row) {
      if (db.revisions.some(r => r.posting_id === String(row.posting_id) && r.revision_no === row.revision_no)) throw Object.assign(new Error("duplicate revision"), { code: "23505" });
      db.revisions.push({ ...clone(row), id: nextId("revisions"), posting_id: String(row.posting_id), created_at: now() });
    },
    async listVisibility() { return clone(db.visibility); },
    async insertVisibility(row) {
      if (db.visibility.some(v => v.posting_id === String(row.posting_id) && v.seq === row.seq)) throw Object.assign(new Error("duplicate seq"), { code: "23505" });
      db.visibility.push({ ...clone(row), id: nextId("visibility"), posting_id: String(row.posting_id), created_at: now() });
    },
    async listLinks() {
      // 応募者の完全消去で連鎖削除される（PostgreSQL版の ON DELETE CASCADE と同じ）
      const ids = new Set(candidates.map(c => String(c.id)));
      return clone(db.links.filter(l => ids.has(l.candidate_id)));
    },
    async insertLink(row) {
      if (failOn === "insertLink") throw new Error("simulated failure");
      if (db.links.some(l => l.candidate_id === String(row.candidate_id) && l.seq === row.seq)) throw Object.assign(new Error("duplicate seq"), { code: "23505" });
      db.links.push({ ...clone(row), id: nextId("links"), candidate_id: String(row.candidate_id), posting_id: row.posting_id == null ? null : String(row.posting_id), created_at: now() });
    },
    async getCandidate(id) {
      const c = candidates.find(x => String(x.id) === String(id));
      return c ? { id: String(c.id), is_coop: c.is_coop === true, source_type: c.source_type ?? null } : null;
    },
    async listCandidatesBasic() {
      return candidates.map(c => ({
        id: String(c.id), name_kanji: c.name_kanji ?? null, applied_at: c.applied_at == null ? null : String(c.applied_at).slice(0, 10),
        status: c.status == null ? null : String(c.status), decline_reason: c.decline_reason ?? null,
        is_coop: c.is_coop === true, is_deleted: c.is_deleted === true, source_type: c.source_type ?? null, agent_name: c.agent_name ?? null,
      }));
    },
    async listSelectionEvents() {
      if (!selectionStore) return [];
      return candidates.flatMap(c => selectionStore.log(c.id).map(e => ({ ...e, candidate_id: String(c.id) })));
    },
  };

  return {
    ready: async () => ready && (await marketingStore.ready()),
    transaction(work) {
      return marketingStore.transaction(async mtx => {
        const snapshot = clone(db);
        const savedSeq = { ...seq };
        try {
          return await work({ ...mtx, ...own });
        } catch (err) {
          db = snapshot;
          seq = savedSeq;
          throw err;
        }
      });
    },
    dump: () => clone(db),
  };
}

module.exports = { createMemoryJobPostingStore };
