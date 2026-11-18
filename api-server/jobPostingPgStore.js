"use strict";
// 求人一覧（第5弾）のPostgreSQL保存先（migrations/005_job_postings.sql のテーブル）。
// 求人内容の版・公開／非公開の履歴・応募者とのひも付け履歴は INSERT のみ（DB側のトリガーでも UPDATE・DELETE を禁止）。
// 求人原稿・掲載状態・実績は求人分析の保存先（jobMarketingPgStore）と同じ接続・同じトランザクションで読む。
// 応募者は読み取りのみ（ひも付けの変更時に行をロックするだけで、candidates の値は変更しない）。
const TABLES = ["job_marketing_posting_revisions", "job_marketing_posting_visibility", "candidate_job_posting_links"];
const tokyo = column => `to_char(${column} AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS ${column}`;

function createPgJobPostingStore(db, marketingStore) {
  let readyCache = false;

  // 新しいテーブルと求人分析のテーブルの有無。「有る」は確定後キャッシュし、「無い」はキャッシュしない
  async function ready(conn = db) {
    if (readyCache) return true;
    if (!(await marketingStore.ready())) return false;
    const checks = TABLES.map(t => `to_regclass('public.${t}') IS NOT NULL`).join(" AND ");
    const result = await conn.query(`SELECT (${checks}) AS ready`);
    readyCache = result.rows?.[0]?.ready === true;
    return readyCache;
  }

  function tx(client) {
    return {
      ...marketingStore.tx(client),
      async listRevisions() {
        const result = await client.query(
          `SELECT id::text AS id, posting_id::text AS posting_id, revision_no, title, body, url, location, employment_type, salary, work_hours,
            holidays, other_conditions, contact_person, change_summary, change_reason, actor, ${tokyo("created_at")}
          FROM public.job_marketing_posting_revisions ORDER BY posting_id, revision_no`,
        );
        return result.rows;
      },
      async insertRevision(row) {
        await client.query(
          `INSERT INTO public.job_marketing_posting_revisions
            (posting_id, revision_no, title, body, url, location, employment_type, salary, work_hours, holidays, other_conditions, contact_person,
             change_summary, change_reason, actor)
          VALUES ($1::bigint, $2::integer, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::text, $12::text,
            $13::text, $14::text, $15::text)`,
          [row.posting_id, row.revision_no, row.title, row.body ?? null, row.url ?? null, row.location ?? null, row.employment_type ?? null,
            row.salary ?? null, row.work_hours ?? null, row.holidays ?? null, row.other_conditions ?? null, row.contact_person ?? null,
            row.change_summary ?? null, row.change_reason ?? null, row.actor ?? null],
        );
      },
      async listVisibility() {
        const result = await client.query(
          `SELECT id::text AS id, posting_id::text AS posting_id, seq, visibility, previous_visibility,
            to_char(effective_date, 'YYYY-MM-DD') AS effective_date, reason, actor, ${tokyo("created_at")}
          FROM public.job_marketing_posting_visibility ORDER BY posting_id, seq`,
        );
        return result.rows;
      },
      async insertVisibility(row) {
        await client.query(
          `INSERT INTO public.job_marketing_posting_visibility (posting_id, seq, visibility, previous_visibility, effective_date, reason, actor)
          VALUES ($1::bigint, $2::integer, $3::text, $4::text, $5::date, $6::text, $7::text)`,
          [row.posting_id, row.seq, row.visibility, row.previous_visibility ?? null, row.effective_date, row.reason ?? null, row.actor ?? null],
        );
      },
      async listLinks() {
        const result = await client.query(
          `SELECT id::text AS id, candidate_id::text AS candidate_id, seq, posting_id::text AS posting_id, reason, actor, ${tokyo("created_at")}
          FROM public.candidate_job_posting_links ORDER BY candidate_id, seq`,
        );
        return result.rows;
      },
      async insertLink(row) {
        // candidate_id の型は列から推論させる（candidates.id の型を推測しない）
        await client.query(
          `INSERT INTO public.candidate_job_posting_links (candidate_id, seq, posting_id, reason, actor)
          VALUES ($1, $2::integer, $3::bigint, $4::text, $5::text)`,
          [row.candidate_id, row.seq, row.posting_id ?? null, row.reason ?? null, row.actor ?? null],
        );
      },
      async getCandidate(id, { lock } = {}) {
        const result = await client.query(`SELECT id::text AS id, is_coop, source_type FROM public.candidates WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
        const row = result.rows[0];
        return row ? { id: row.id, is_coop: row.is_coop === true, source_type: row.source_type ?? null } : null;
      },
      // 応募数・採用数の判定に使う列だけを読む（連絡先などは読まない）
      async listCandidatesBasic() {
        const result = await client.query(
          `SELECT id::text AS id, name_kanji, to_char(applied_at, 'YYYY-MM-DD') AS applied_at, status::text AS status, decline_reason,
            is_coop, is_deleted, source_type, agent_name
          FROM public.candidates`,
        );
        return result.rows.map(r => ({ ...r, is_coop: r.is_coop === true, is_deleted: r.is_deleted === true }));
      },
      // 選考履歴（テーブル未作成なら空。従来の進捗で判定する）
      async listSelectionEvents() {
        const has = await client.query("SELECT to_regclass('public.candidate_selection_events') IS NOT NULL AS ok");
        if (has.rows?.[0]?.ok !== true) return [];
        const result = await client.query(
          `SELECT candidate_id::text AS candidate_id, id::text AS id, seq, kind, stage_number, to_char(event_date, 'YYYY-MM-DD') AS event_date,
            note, attendee, ended_stage, source, target_event_id::text AS target_event_id, payload
          FROM public.candidate_selection_events ORDER BY candidate_id, seq`,
        );
        return result.rows;
      },
    };
  }

  async function transaction(work) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await work(tx(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* 接続断時は元のエラーを優先 */ }
      throw err;
    } finally {
      client.release();
    }
  }

  return { ready, transaction, tx };
}

module.exports = { createPgJobPostingStore, TABLES };
