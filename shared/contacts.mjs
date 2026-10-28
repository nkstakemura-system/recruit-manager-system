// 応募者の連絡先（TEL・Email・代表連絡先）。画面・API・ローカルプレビューで共通。
// 保存形式は既存のまま：tel・email は文字列の配列、代表連絡先 primary_contact は "tel_0" / "email_1" のような種類_番号。

export const CONTACT_KINDS = ["tel", "email"];
export const CONTACT_LIMITS = { entries: 10, tel: 30, email: 254 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 制御文字（改行・タブなど）
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

// 既存データの配列（JSON文字列で届く場合も読む）。読めない値は空として扱う。
export function contactList(value) {
  let list = value;
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return []; }
  }
  return Array.isArray(list) ? list.map(v => (v == null ? "" : String(v))) : [];
}

// 同時編集の確認に使う、画面が読み込んだ時点の連絡先（値は加工しない）
export function contactSnapshot(candidate) {
  return {
    tel: contactList(candidate?.tel),
    email: contactList(candidate?.email),
    primary_contact: typeof candidate?.primary_contact === "string" ? candidate.primary_contact : null,
  };
}

export const sameContacts = (a, b) => JSON.stringify(contactSnapshot(a)) === JSON.stringify(contactSnapshot(b));

export function parsePrimary(value) {
  const match = /^(tel|email)_(\d{1,3})$/.exec(typeof value === "string" ? value : "");
  return match ? { kind: match[1], index: Number(match[2]) } : null;
}

// 表示用の代表連絡先。指定先が空・範囲外なら、登録済みの TEL → Email の順で最初のものを代表とする。
export function resolvePrimary(candidate) {
  const lists = { tel: contactList(candidate?.tel), email: contactList(candidate?.email) };
  const chosen = parsePrimary(candidate?.primary_contact);
  if (chosen && lists[chosen.kind][chosen.index]?.trim()) {
    return { ...chosen, value: lists[chosen.kind][chosen.index].trim() };
  }
  for (const kind of CONTACT_KINDS) {
    const index = lists[kind].findIndex(v => v.trim());
    if (index >= 0) return { kind, index, value: lists[kind][index].trim() };
  }
  return null;
}

function contactError(message, field) {
  return Object.assign(new Error(message), { field });
}

// 保存する連絡先。空欄を除き、代表連絡先の番号を空欄除去後の位置に合わせる。
// 代表に空欄・未指定を選んだ場合は、登録済みの TEL → Email の順で最初のものを代表にする。
// 両方空欄でも保存できる（代表は新規登録の既定値と同じ "tel_0"）。
export function normalizeContacts(input) {
  const kept = {};
  const position = {};
  for (const kind of CONTACT_KINDS) {
    const raw = input?.[kind] ?? [];
    if (!Array.isArray(raw)) throw contactError(`${kind === "tel" ? "TEL" : "Email"}の形式が正しくありません`, kind);
    kept[kind] = [];
    position[kind] = new Map();
    raw.forEach((value, index) => {
      if (value != null && typeof value !== "string") throw contactError(`${kind === "tel" ? "TEL" : "Email"}の形式が正しくありません`, kind);
      const text = (value || "").trim();
      if (!text) return;
      if (kind === "tel" && (text.length > CONTACT_LIMITS.tel || CONTROL_PATTERN.test(text) || !/\d/.test(text))) {
        throw contactError(`TEL「${text.slice(0, 40)}」を確認してください（${CONTACT_LIMITS.tel}文字以内の電話番号）`, "tel");
      }
      if (kind === "email" && (text.length > CONTACT_LIMITS.email || !EMAIL_PATTERN.test(text))) {
        throw contactError(`Email「${text.slice(0, 60)}」の形式を確認してください`, "email");
      }
      position[kind].set(index, kept[kind].length);
      kept[kind].push(text);
    });
    if (kept[kind].length > CONTACT_LIMITS.entries) {
      throw contactError(`${kind === "tel" ? "TEL" : "Email"}は${CONTACT_LIMITS.entries}件までです`, kind);
    }
  }
  const chosen = parsePrimary(input?.primary_contact);
  let primary = chosen && position[chosen.kind].has(chosen.index)
    ? `${chosen.kind}_${position[chosen.kind].get(chosen.index)}`
    : null;
  if (!primary) primary = kept.tel.length ? "tel_0" : kept.email.length ? "email_0" : "tel_0";
  return { tel: kept.tel, email: kept.email, primary_contact: primary };
}
