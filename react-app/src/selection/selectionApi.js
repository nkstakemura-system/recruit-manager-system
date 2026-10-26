import { apiFetch } from "../api";

// 選考履歴API。失敗時も例外にせず { ok, status, data } を返す（409・503 を画面側で扱うため）。
async function request(url, method = "GET", body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await apiFetch(url, options);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

const base = id => `/api/candidates/${encodeURIComponent(id)}/selection`;
const eventPath = (id, eventId, action) => `${base(id)}/events/${encodeURIComponent(eventId)}/${action}`;

export const selectionApi = {
  load: id => request(base(id)),
  addStep: (id, body) => request(`${base(id)}/events`, "POST", body),
  // 訂正・取消は元の工程を残したまま記録を追記する
  correct: (id, eventId, body) => request(eventPath(id, eventId, "correction"), "POST", body),
  cancel: (id, eventId, body) => request(eventPath(id, eventId, "void"), "POST", body),
  setAppliedDate: (id, body) => request(`${base(id)}/applied-date`, "PATCH", body),
  setContactHistory: (id, body) => request(`${base(id)}/contact-history`, "PATCH", body),
};

// 個人応募で選考履歴APIだけが更新する列（基本情報の保存では送らない）
export const SELECTION_OWNED_FIELDS = [
  "status", "decline_reason", "interview_1_date", "interview_2_date", "interview_2_attendee",
  "offer_date", "expected_join_date", "applied_at", "contact_history",
];

// 標準カレンダーの入力範囲（既存の内定日欄と同じ）
export const MIN_DATE = "1000-01-01";
export const MAX_DATE = "9999-12-31";

// 西暦4桁（0000年を除く）の実在日付か（API側・既存の内定日検証と同じ基準）
export function isFourDigitDate(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const todayTokyo = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

export function formatDate(value) {
  if (!value) return "日付未登録";
  const [y, m, d] = value.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

// 一覧・詳細の state へ反映する選考列（日付は YYYY-MM-DD）
export function mirrorForForm(candidate) {
  const day = value => (value ? String(value).slice(0, 10) : "");
  return {
    status: String(candidate.status ?? "1"),
    decline_reason: candidate.decline_reason || "",
    interview_1_date: day(candidate.interview_1_date),
    interview_2_date: day(candidate.interview_2_date),
    interview_2_attendee: candidate.interview_2_attendee || "",
    offer_date: day(candidate.offer_date),
    expected_join_date: day(candidate.expected_join_date),
    applied_at: candidate.applied_at ?? null,
    contact_history: candidate.contact_history || [],
  };
}
