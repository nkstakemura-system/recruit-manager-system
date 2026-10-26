"use strict";
// 選考履歴のメモリ保存先。テストとローカルプレビュー専用（DBには接続しない）。
// PostgreSQL版と同じく、履歴は追記のみ（変更・削除の手段を持たない）。
const flow = require("./selectionFlow");

// PostgreSQL版と同じく、読み取れない日付は "invalid:元の値" として渡す
const day = value => flow.ymd(value) ?? (value == null || value === "" ? null : `invalid:${value}`);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// candidates: 応募者配列（呼び出し元と共有し、互換列の更新を反映する）
function createMemorySelectionStore(candidates, { ready = true, failOn = null } = {}) {
  const events = new Map();
  let nextId = 1;
  let lock = Promise.resolve();
  const find = id => candidates.find(c => String(c.id) === String(id));

  const tx = {
    async getCandidate(id) {
      const c = find(id);
      if (!c) return null;
      return {
        id: c.id, is_coop: c.is_coop === true, status: c.status == null ? null : String(c.status),
        applied_at: c.applied_at ?? null, applied_at_key: String(c.applied_at ?? ""),
        decline_reason: c.decline_reason ?? null,
        interview_1_date: day(c.interview_1_date), interview_2_date: day(c.interview_2_date),
        offer_date: day(c.offer_date), expected_join_date: day(c.expected_join_date),
        interview_2_attendee: c.interview_2_attendee ?? null,
        contact_history: Array.isArray(c.contact_history) ? clone(c.contact_history) : [],
      };
    },
    async listEvents(id) {
      return clone(events.get(String(id)) || []);
    },
    async insertEvent(id, event, seq) {
      const list = events.get(String(id)) || [];
      if (list.some(e => e.seq === seq)) throw new Error("duplicate seq");
      list.push({
        ...clone(event), id: String(nextId++), seq,
        target_event_id: event.target_event_id == null ? null : String(event.target_event_id),
        // PostgreSQL版と同じく日本時間の「YYYY-MM-DD HH:MM」
        created_at: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date()),
      });
      events.set(String(id), list);
    },
    async updateMirror(id, mirror) {
      if (failOn === "updateMirror") throw new Error("simulated failure");
      Object.assign(find(id), clone(mirror));
    },
    async updateAppliedAt(candidate, date) {
      find(candidate.id).applied_at = date;
    },
    async updateContactHistory(id, list) {
      find(id).contact_history = clone(list);
    },
  };

  return {
    ready: async () => ready,
    // 1件ずつ直列実行し、失敗時は応募者・履歴を元に戻す（DBのトランザクション相当）。
    transaction(work) {
      const run = lock.then(async () => {
        const snapshot = { candidates: clone(candidates), events: clone([...events]), nextId };
        try {
          return await work(tx);
        } catch (err) {
          // 呼び出し元が保持している応募者オブジェクトをそのまま元の内容へ戻す。
          snapshot.candidates.forEach((saved, i) => {
            const target = candidates[i];
            for (const key of Object.keys(target)) delete target[key];
            Object.assign(target, saved);
          });
          events.clear();
          for (const [key, value] of snapshot.events) events.set(key, value);
          nextId = snapshot.nextId;
          throw err;
        }
      });
      lock = run.catch(() => {});
      return run;
    },
    log(id) {
      return clone(events.get(String(id)) || []);
    },
    // 一覧バッジ用：最新の有効な工程（訂正後の日付）
    latest(id) {
      const steps = flow.effectiveSteps(events.get(String(id)) || []);
      return steps[steps.length - 1] || null;
    },
  };
}

module.exports = { createMemorySelectionStore };
