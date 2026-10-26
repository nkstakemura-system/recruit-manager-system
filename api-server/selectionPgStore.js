"use strict";
// 選考履歴のPostgreSQL保存先。candidates.id の型は推測せず、パラメータ型を列から推論させる。
// 履歴テーブルへは INSERT のみ行う（UPDATE・DELETE はしない。DB側のトリガーでも禁止）。
const flow = require("./selectionFlow");

const PG_DATE = 1082;
const PG_TIMESTAMP = 1114;
const PG_TIMESTAMPTZ = 1184;

function appliedKey(value) {
  if (value == null) return "";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "invalid";
  return String(value);
}

// 選考の日付列。西暦1〜9999年の範囲外（to_char では紀元前・5桁年を正しく表せない）は "invalid:元の値" として渡し、
// 選考の更新を409で停止する（黙って消去・上書きしない。初回履歴化の基準値には元の値が残る）。
const dateColumn = column => `CASE WHEN ${column} IS NULL THEN NULL
            WHEN ${column} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN to_char(${column}, 'YYYY-MM-DD')
            ELSE 'invalid:' || ${column}::text END AS ${column}`;

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

const DAY_MS = 86400000;
const TOKYO_OFFSET_MS = 9 * 3600000; // 日本時間は夏時間なしの UTC+9

// YYYY-MM-DD の UTC 0時。Date.UTC は 0〜99年を1900年代に読み替えるため setUTCFullYear を使う。
function utcDay(date) {
  const day = new Date(0);
  day.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return day.getTime();
}

// 受付日の日付部分だけを変更し、時刻部分（日本時間）は保持する。
function shiftedAppliedAt(oldValue, date) {
  if (!(oldValue instanceof Date) || !Number.isFinite(oldValue.getTime())) return new Date(`${date}T00:00:00+09:00`);
  // 現在値の日本時間での日付（UTC 0時換算）
  const source = Math.floor((oldValue.getTime() + TOKYO_OFFSET_MS) / DAY_MS) * DAY_MS;
  return new Date(oldValue.getTime() + (utcDay(date) - source));
}

// 互換列の更新SQL。渡された列だけを更新し、各パラメータは1回だけ参照する。
const MIRROR_SQL = {
  status: n => `status = $${n}`,
  interview_1_date: n => `interview_1_date = $${n}::date`,
  interview_2_date: n => `interview_2_date = $${n}::date`,
  interview_2_attendee: n => `interview_2_attendee = $${n}::text`,
  offer_date: n => `offer_date = $${n}::date`,
  expected_join_date: n => `expected_join_date = $${n}::date`,
  decline_reason: n => `decline_reason = $${n}::text`,
};

function mirrorUpdate(id, mirror) {
  const sets = [];
  const params = [id];
  for (const field of Object.keys(MIRROR_SQL)) {
    if (!Object.prototype.hasOwnProperty.call(mirror, field)) continue;
    params.push(mirror[field]);
    sets.push(MIRROR_SQL[field](params.length));
  }
  return sets.length ? { sql: `UPDATE public.candidates SET ${sets.join(", ")} WHERE id = $1`, params } : null;
}

function createPgSelectionStore(db) {
  let readyCache = false;

  // 選考履歴テーブルの有無。この判定を一覧・PUT・選考APIで共用する。
  // 「有る」は確定後キャッシュし、「無い」はキャッシュしない（migration直後に即時切り替わる）。
  // conn: トランザクション中の接続（PUTは応募者行をロックした後、同じ接続で確認する）
  async function ready(conn = db) {
    if (readyCache) return true;
    const result = await conn.query("SELECT to_regclass('public.candidate_selection_events') IS NOT NULL AS ready");
    readyCache = result.rows?.[0]?.ready === true;
    return readyCache;
  }

  function tx(client) {
    return {
      async getCandidate(id, { lock } = {}) {
        const result = await client.query(
          `SELECT id, is_coop, status::text AS status, applied_at, decline_reason,
            ${dateColumn("interview_1_date")}, ${dateColumn("interview_2_date")},
            ${dateColumn("offer_date")}, ${dateColumn("expected_join_date")},
            interview_2_attendee, contact_history
          FROM public.candidates WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
          [id],
        );
        const row = result.rows[0];
        if (!row) return null;
        const field = (result.fields || []).find(f => f.name === "applied_at");
        return {
          ...row,
          is_coop: row.is_coop === true,
          contact_history: parseJsonArray(row.contact_history),
          applied_at_key: appliedKey(row.applied_at),
          applied_at_type: field?.dataTypeID,
        };
      },
      async listEvents(id) {
        const result = await client.query(
          `SELECT id::text AS id, seq, kind, stage_number, to_char(event_date, 'YYYY-MM-DD') AS event_date,
            note, attendee, ended_stage, source, target_event_id::text AS target_event_id, payload, actor,
            to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS created_at
          FROM public.candidate_selection_events WHERE candidate_id = $1 ORDER BY seq`,
          [id],
        );
        return result.rows;
      },
      async insertEvent(id, event, seq) {
        await client.query(
          `INSERT INTO public.candidate_selection_events
            (candidate_id, seq, kind, stage_number, event_date, note, attendee, ended_stage, source, target_event_id, payload, actor)
          VALUES ($1, $2::integer, $3::text, $4::integer, $5::date, $6::text, $7::text, $8::text, $9::text, $10::bigint, $11::jsonb, $12::text)`,
          [
            id, seq, event.kind, event.stage_number, event.event_date, event.note, event.attendee, event.ended_stage,
            event.source, event.target_event_id, event.payload == null ? null : JSON.stringify(event.payload), event.actor ?? null,
          ],
        );
      },
      async updateMirror(id, mirror) {
        const update = mirrorUpdate(id, mirror);
        if (update) await client.query(update.sql, update.params);
      },
      async updateAppliedAt(candidate, date) {
        if (candidate.applied_at_type === PG_DATE) {
          await client.query("UPDATE public.candidates SET applied_at = $2::date WHERE id = $1", [candidate.id, date]);
        } else if (candidate.applied_at_type === PG_TIMESTAMP || candidate.applied_at_type === PG_TIMESTAMPTZ) {
          await client.query("UPDATE public.candidates SET applied_at = $2 WHERE id = $1", [candidate.id, shiftedAppliedAt(candidate.applied_at, date)]);
        } else {
          throw flow.selectionError(409, "受付日の列型が想定外のため変更できません");
        }
      },
      async updateContactHistory(id, list) {
        await client.query("UPDATE public.candidates SET contact_history = $2 WHERE id = $1", [id, JSON.stringify(list)]);
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

  return { ready, transaction };
}

module.exports = { createPgSelectionStore, shiftedAppliedAt, mirrorUpdate, dateColumn };
