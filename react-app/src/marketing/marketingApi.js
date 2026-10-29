import { apiFetch } from "../api";
import { PLAN_STATUS, PLAN_TYPES, SOURCES } from "../../../shared/jobMarketing.mjs";

// 求人分析API。失敗時も例外にせず { ok, status, data } を返す（409・503 を画面側で扱うため）。
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

const base = "/api/job-marketing";
const id = value => encodeURIComponent(value);

export const marketingApi = {
  load: () => request(base),
  createCategory: body => request(`${base}/categories`, "POST", body),
  updateCategory: (categoryId, body) => request(`${base}/categories/${id(categoryId)}`, "PATCH", body),
  // 掲載状態の変更（無料→有料など）と取消
  savePlanEvent: body => request(`${base}/plan-events`, "POST", body),
  voidPlanEvent: (eventId, body) => request(`${base}/plan-events/${id(eventId)}/void`, "POST", body),
  // 修正は supersedes_id、期間の重なりは replace_ids（置き換え）か allow_overlap + overlap_reason
  saveRecord: body => request(`${base}/records`, "POST", body),
  voidRecord: (recordId, body) => request(`${base}/records/${id(recordId)}/void`, "POST", body),
  importCsv: body => request(`${base}/imports`, "POST", body),
  createReference: body => request(`${base}/references`, "POST", body),
  updateReference: (refId, body) => request(`${base}/references/${id(refId)}`, "PUT", body),
  deleteReference: refId => request(`${base}/references/${id(refId)}`, "DELETE"),
  // ローカルプレビュー専用（--real-csv）。確認待ちの実CSV。本番には無いため 404 になり、画面には出さない
  pendingFiles: () => request(`${base}/pending-files`),
};

// 取り込んだファイルの識別（同じCSVの二重登録の判定用）
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export const errorText = (res, fallback) => res?.data?.error || fallback;
export const sourceLabel = s => SOURCES[s] || s || "—";
export const planLabel = p => p === "mixed" ? "混在" : PLAN_TYPES[p] || "—";
export const statusLabel = s => PLAN_STATUS[s] || "未設定";
export const postingLabel = p => p ? (p.title || "") + (p.job_id ? `（求人ID ${p.job_id}）` : "") || "求人原稿" : "職種全体";
