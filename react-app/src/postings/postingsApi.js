import { apiFetch } from "../api";

// 求人一覧API（第5弾）。失敗時も例外にせず { ok, status, data } を返す（409・503 を画面側で扱うため）。
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

const base = "/api/job-postings";
const id = value => encodeURIComponent(value);

export const postingsApi = {
  list: () => request(base),
  create: body => request(base, "POST", body),
  detail: postingId => request(`${base}/${id(postingId)}`),
  candidates: (postingId, kind) => request(`${base}/${id(postingId)}/candidates?kind=${id(kind)}`),
  addRevision: (postingId, body) => request(`${base}/${id(postingId)}/revisions`, "POST", body),
  setVisibility: (postingId, body) => request(`${base}/${id(postingId)}/visibility`, "POST", body),
  candidateLink: candidateId => request(`/api/candidates/${id(candidateId)}/job-posting`),
};

export const errorText = (res, fallback) => res?.data?.error || fallback;
