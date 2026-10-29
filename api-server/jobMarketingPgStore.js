"use strict";
// 求人分析のPostgreSQL保存先（migrations/004_job_marketing.sql のテーブル）。
// 実績・取込・職種の変更履歴・求人原稿・掲載状態の履歴は INSERT のみ（DB側のトリガーでも UPDATE・DELETE を禁止）。
// 職種（名称・募集状態）と参考求人（論理削除）だけを UPDATE する。既存の応募者関連テーブルには触れない。
const TABLES = [
  "job_marketing_categories", "job_marketing_category_events", "job_marketing_postings", "job_marketing_plan_events",
  "job_marketing_imports", "job_marketing_records", "job_marketing_references",
];
const tokyo = column => `to_char(${column} AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS ${column}`;
const num = value => value == null ? null : Number(value);

function createPgMarketingStore(db) {
  let readyCache = false;

  // テーブルの有無。「有る」は確定後キャッシュし、「無い」はキャッシュしない（migration直後に即時切り替わる）
  async function ready() {
    if (readyCache) return true;
    const checks = TABLES.map(t => `to_regclass('public.${t}') IS NOT NULL`).join(" AND ");
    const result = await db.query(`SELECT (${checks}) AS ready`);
    readyCache = result.rows?.[0]?.ready === true;
    return readyCache;
  }

  function tx(client) {
    return {
      // 書き込みを直列化する（重複・期間の重なりの判定と登録の間に、他の登録が入らないようにする）
      async lock() {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('nks_job_marketing'))");
      },
      async listCategories() {
        const result = await client.query(
          `SELECT id::text AS id, name, is_active, sort_order, ${tokyo("created_at")}, ${tokyo("updated_at")}
          FROM public.job_marketing_categories ORDER BY sort_order, id`,
        );
        return result.rows;
      },
      async listCategoryEvents() {
        const result = await client.query(
          `SELECT id::text AS id, category_id::text AS category_id, kind, before_value AS before, after_value AS after, actor, ${tokyo("created_at")}
          FROM public.job_marketing_category_events ORDER BY id`,
        );
        return result.rows;
      },
      async insertCategory({ name, sort_order }) {
        const result = await client.query(
          `INSERT INTO public.job_marketing_categories (name, sort_order) VALUES ($1::text, $2::integer)
          RETURNING id::text AS id, name, is_active, sort_order, ${tokyo("created_at")}, ${tokyo("updated_at")}`,
          [name, sort_order],
        );
        return result.rows[0];
      },
      async updateCategory(id, changes) {
        const result = await client.query(
          `UPDATE public.job_marketing_categories
          SET name = COALESCE($2::text, name), is_active = COALESCE($3::boolean, is_active), updated_at = NOW()
          WHERE id = $1::bigint
          RETURNING id::text AS id, name, is_active, sort_order, ${tokyo("created_at")}, ${tokyo("updated_at")}`,
          [id, changes.name ?? null, changes.is_active ?? null],
        );
        return result.rows[0];
      },
      async insertCategoryEvent(event) {
        await client.query(
          `INSERT INTO public.job_marketing_category_events (category_id, kind, before_value, after_value, actor)
          VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text)`,
          [event.category_id, event.kind, event.before, event.after, event.actor ?? null],
        );
      },
      async listPostings() {
        const result = await client.query(
          `SELECT id::text AS id, category_id::text AS category_id, media, external_key, job_id, title, actor, ${tokyo("created_at")}
          FROM public.job_marketing_postings ORDER BY id`,
        );
        return result.rows;
      },
      async insertPosting(row) {
        const result = await client.query(
          `INSERT INTO public.job_marketing_postings (category_id, media, external_key, job_id, title, actor)
          VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::text)
          RETURNING id::text AS id, category_id::text AS category_id, media, external_key, job_id, title, actor, ${tokyo("created_at")}`,
          [row.category_id, row.media, row.external_key, row.job_id ?? null, row.title ?? null, row.actor ?? null],
        );
        return result.rows[0];
      },
      async listPlanEvents() {
        const result = await client.query(
          `SELECT id::text AS id, kind, category_id::text AS category_id, posting_id::text AS posting_id, supersedes_id::text AS supersedes_id,
            status, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, budget, note, reason, actor, ${tokyo("created_at")}
          FROM public.job_marketing_plan_events ORDER BY id`,
        );
        return result.rows.map(r => ({ ...r, budget: num(r.budget) }));
      },
      async insertPlanEvent(row) {
        const result = await client.query(
          `INSERT INTO public.job_marketing_plan_events (kind, category_id, posting_id, supersedes_id, status, effective_date, budget, note, reason, actor)
          VALUES ($1::text, $2::bigint, $3::bigint, $4::bigint, $5::text, $6::date, $7::numeric, $8::text, $9::text, $10::text)
          RETURNING id::text AS id`,
          [row.kind, row.category_id, row.posting_id ?? null, row.supersedes_id ?? null, row.status ?? null, row.effective_date ?? null,
            row.budget ?? null, row.note ?? null, row.reason ?? null, row.actor ?? null],
        );
        return result.rows[0].id;
      },
      async listRecords() {
        const result = await client.query(
          `SELECT id::text AS id, kind, category_id::text AS category_id, supersedes_id::text AS supersedes_id, media,
            to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end, plan_type,
            impressions, clicks, apply_starts, applies, cost, note, source, import_id::text AS import_id, posting_id::text AS posting_id,
            source_meta, daily, reason, actor, ${tokyo("created_at")}
          FROM public.job_marketing_records ORDER BY id`,
        );
        return result.rows.map(r => ({ ...r, cost: num(r.cost) }));
      },
      async insertRecord(row) {
        const result = await client.query(
          `INSERT INTO public.job_marketing_records
            (kind, category_id, supersedes_id, media, period_start, period_end, plan_type,
             impressions, clicks, apply_starts, applies, cost, note, source, import_id, source_meta, daily, reason, actor, posting_id)
          VALUES ($1::text, $2::bigint, $3::bigint, $4::text, $5::date, $6::date, $7::text,
            $8::integer, $9::integer, $10::integer, $11::integer, $12::numeric, $13::text, $14::text, $15::bigint, $16::jsonb, $17::jsonb, $18::text, $19::text, $20::bigint)
          RETURNING id::text AS id`,
          [
            row.kind, row.category_id, row.supersedes_id ?? null, row.media ?? null, row.period_start ?? null, row.period_end ?? null, row.plan_type ?? null,
            row.impressions ?? null, row.clicks ?? null, row.apply_starts ?? null, row.applies ?? null, row.cost ?? null, row.note ?? null,
            row.source ?? null, row.import_id ?? null,
            row.source_meta == null ? null : JSON.stringify(row.source_meta), row.daily == null ? null : JSON.stringify(row.daily),
            row.reason ?? null, row.actor ?? null, row.posting_id ?? null,
          ],
        );
        return result.rows[0].id;
      },
      async listImports() {
        const result = await client.query(
          `SELECT id::text AS id, file_name, file_hash, format, record_count, actor, ${tokyo("created_at")}
          FROM public.job_marketing_imports ORDER BY id`,
        );
        return result.rows;
      },
      async insertImport(row) {
        const result = await client.query(
          `INSERT INTO public.job_marketing_imports (file_name, file_hash, format, record_count, actor)
          VALUES ($1::text, $2::text, $3::text, $4::integer, $5::text) RETURNING id::text AS id`,
          [row.file_name, row.file_hash, row.format, row.record_count, row.actor ?? null],
        );
        return result.rows[0].id;
      },
      async listReferences() {
        const result = await client.query(
          `SELECT id::text AS id, category_id::text AS category_id, company_name, job_title, url, memo,
            to_char(checked_on, 'YYYY-MM-DD') AS checked_on, is_deleted, actor, ${tokyo("created_at")}, ${tokyo("updated_at")}
          FROM public.job_marketing_references ORDER BY id`,
        );
        return result.rows;
      },
      async insertReference(row) {
        const result = await client.query(
          `INSERT INTO public.job_marketing_references (category_id, company_name, job_title, url, memo, checked_on, actor)
          VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::date, $7::text) RETURNING id::text AS id`,
          [row.category_id, row.company_name, row.job_title ?? null, row.url ?? null, row.memo ?? null, row.checked_on ?? null, row.actor ?? null],
        );
        return { ...row, id: result.rows[0].id, is_deleted: false };
      },
      async updateReference(id, changes) {
        if (changes.is_deleted === true) {
          await client.query("UPDATE public.job_marketing_references SET is_deleted = true, actor = $2::text, updated_at = NOW() WHERE id = $1::bigint", [id, changes.actor ?? null]);
          return { id: String(id), is_deleted: true };
        }
        await client.query(
          `UPDATE public.job_marketing_references
          SET company_name = $2::text, job_title = $3::text, url = $4::text, memo = $5::text, checked_on = $6::date, actor = $7::text, updated_at = NOW()
          WHERE id = $1::bigint`,
          [id, changes.company_name, changes.job_title ?? null, changes.url ?? null, changes.memo ?? null, changes.checked_on ?? null, changes.actor ?? null],
        );
        return { ...changes, id: String(id) };
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

module.exports = { createPgMarketingStore, TABLES };
