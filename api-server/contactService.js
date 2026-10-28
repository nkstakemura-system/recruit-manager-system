"use strict";
// 連絡先（TEL・Email・代表連絡先）の更新。連絡先専用API・ローカルプレビュー・テストで共通。
// tel・email・primary_contact の3列だけを更新し、他の応募者情報・選考列・選考履歴は変更しない。
// 同時編集：画面が読み込んだ時点の連絡先（expected）と現在の値が違う場合は409で停止する（上書きしない）。
const contactsModule = () => import("../shared/contacts.mjs");

class ContactError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

async function updateContacts(store, id, body) {
  const { normalizeContacts, contactSnapshot, sameContacts } = await contactsModule();
  if (!body || typeof body !== "object" || !body.expected || typeof body.expected !== "object") {
    throw new ContactError(400, "画面が古いため保存できません。再読み込みしてください。", "expected_required");
  }
  let next;
  try { next = normalizeContacts(body); }
  catch (err) { throw new ContactError(400, err.message, "invalid_contact", { field: err.field }); }
  return store.withCandidateLock(id, async (current, save) => {
    if (!current) throw new ContactError(404, "応募者が見つかりません", "not_found");
    if (!sameContacts(current, body.expected)) {
      throw new ContactError(409, "他の画面で連絡先が更新されています。最新の内容を表示します。", "contact_conflict",
        { current: contactSnapshot(current) });
    }
    await save(next);
    return next;
  });
}

// PostgreSQL：応募者行を FOR UPDATE でロックしてから確認・更新する（基本情報の保存・選考履歴APIと同じ行ロック）。
// candidates.id の型は推測せず、パラメータ型を列から推論させる。tel・email は既存の保存処理と同じく JSON 文字列で渡す。
function createPgContactStore(db) {
  return {
    async withCandidateLock(id, work) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        let current;
        try {
          current = (await client.query(
            "SELECT tel, email, primary_contact FROM candidates WHERE id = $1 FOR UPDATE", [id],
          )).rows[0] || null;
        } catch (err) {
          // id の形式が列の型と合わない（22P02）場合は存在しない応募者として扱う
          if (err.code !== "22P02") throw err;
          current = null;
        }
        const result = await work(current, async next => {
          await client.query(
            "UPDATE candidates SET tel = $2, email = $3, primary_contact = $4 WHERE id = $1",
            [id, JSON.stringify(next.tel), JSON.stringify(next.email), next.primary_contact],
          );
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* 接続断時は元のエラーを優先 */ }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// メモリ：テストとローカルプレビュー専用（DBには接続しない）。応募者ごとではなく全体を直列化する。
function createMemoryContactStore(candidates) {
  let lock = Promise.resolve();
  return {
    withCandidateLock(id, work) {
      const run = lock.then(async () => {
        const candidate = candidates.find(c => String(c.id) === String(id));
        const current = candidate
          ? { tel: candidate.tel ?? null, email: candidate.email ?? null, primary_contact: candidate.primary_contact ?? null }
          : null;
        return work(current, async next => {
          candidate.tel = [...next.tel];
          candidate.email = [...next.email];
          candidate.primary_contact = next.primary_contact;
        });
      });
      lock = run.catch(() => {});
      return run;
    },
  };
}

module.exports = { updateContacts, createPgContactStore, createMemoryContactStore, ContactError };
