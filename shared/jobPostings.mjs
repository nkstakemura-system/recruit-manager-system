// 求人一覧・求人詳細（第5弾）の共通ルール。DBに接続しない純粋関数のみ（API・画面・テストで共用）。
//
// * 求人＝既存の求人原稿（job_marketing_postings）。職種・媒体・求人IDは原稿の値（変更しない）。
// * 求人内容は版（revision）で管理する。最新の版が現在の内容。版が無い求人は「初版未登録」（CSV由来の確認済み情報だけを表示）。
// * 公開／非公開はNKS内部の管理状態。切替の履歴から現在の状態と公開期間を求める。履歴が無い求人は「未設定（要設定）」。
// * 媒体名の表記揺れ（Indeed／インディードなど）は表示・絞り込みの上でだけまとめ、保存されている値は変更しない。

export function postingError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

const text = value => typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
const nfkc = value => text(value).normalize("NFKC");

export const todayTokyo = (now = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);

// 西暦4桁の実在日付
export function isDate(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// ---------- 媒体 ----------
// 選択肢の媒体（name が表示・新規保存の値）。aliases は表記揺れ（NFKC・小文字・空白除去後に一致）
export const MEDIA = [
  { name: "Indeed", aliases: ["indeed", "インディード", "いんでぃーど"] },
  { name: "ハローワーク", aliases: ["ハローワーク", "hellowork", "はろーわーく", "公共職業安定所", "職安"] },
  { name: "AirWORK", aliases: ["airwork", "エアワーク", "airワーク"] },
  { name: "engage", aliases: ["engage", "エンゲージ"] },
  { name: "自社ホームページ", aliases: ["自社ホームページ", "ホームページ", "自社hp", "hp", "自社サイト"] },
];
export const OTHER_MEDIA = "その他";
const squash = value => nfkc(value).toLowerCase().replace(/[\s・･]/g, "");

// 表記揺れをまとめた媒体名（選択肢に無い媒体は入力された値のまま。空は null）
export function mediaKey(value) {
  const key = squash(value);
  if (!key) return null;
  const found = MEDIA.find(m => m.aliases.some(a => squash(a) === key) || squash(m.name) === key);
  return found ? found.name : nfkc(value);
}
export const sameMedia = (a, b) => mediaKey(a) != null && mediaKey(a) === mediaKey(b);
// 選択肢（既定の媒体＋登録済みの求人の媒体）
export function mediaOptions(postings = []) {
  const names = MEDIA.map(m => m.name);
  for (const p of postings) {
    const key = mediaKey(p.media);
    if (key && !names.includes(key)) names.push(key);
  }
  return names;
}

// ---------- 求人内容（版） ----------
export const REVISION_FIELDS = [
  { key: "title", label: "求人タイトル", max: 200, required: true },
  { key: "body", label: "求人内容（全文）", max: 20000, multiline: true },
  { key: "url", label: "求人URL", max: 2000 },
  { key: "location", label: "勤務地", max: 200 },
  { key: "employment_type", label: "雇用形態", max: 50 },
  { key: "salary", label: "給与条件", max: 1000, multiline: true },
  { key: "work_hours", label: "勤務時間", max: 1000, multiline: true },
  { key: "holidays", label: "休日", max: 1000, multiline: true },
  { key: "other_conditions", label: "その他の条件", max: 4000, multiline: true },
  { key: "contact_person", label: "求人担当者", max: 100 },
];
export const CHANGE_LIMITS = { change_summary: 500, change_reason: 500, reason: 500, job_id: 200 };

// 求人IDの照合キー：CSV取込（shared/jobMarketing.mjs の postingOf）と同じく前後の空白だけ除く（全角・半角は変換しない）
const jobIdText = value => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim()).slice(0, 200);

// 改行コードはLFにそろえ、前後の空白だけ除く（全文は貼り付けたまま保存する）
const keepText = value => value == null ? "" : String(value).replace(/\r\n?/g, "\n").trim();

export function validateRevision(body) {
  const b = body && typeof body === "object" ? body : {};
  const out = {};
  const errors = [];
  for (const f of REVISION_FIELDS) {
    const raw = b[f.key];
    if (raw != null && typeof raw !== "string") { errors.push(`${f.label}が正しくありません`); continue; }
    const value = f.multiline ? keepText(raw) : text(raw).replace(/\s+/g, " ");
    if (f.required && !value) errors.push(`${f.label}を入力してください`);
    if (value.length > f.max) errors.push(`${f.label}は${f.max.toLocaleString()}文字以内で入力してください`);
    out[f.key] = value || null;
  }
  if (out.url && !/^https?:\/\/\S+$/i.test(out.url)) errors.push("求人URLは http:// または https:// で始まるURLを入力してください");
  for (const key of ["change_summary", "change_reason"]) {
    const raw = b[key];
    if (raw != null && typeof raw !== "string") { errors.push("修正内容・修正理由が正しくありません"); continue; }
    const value = keepText(raw);
    if (value.length > CHANGE_LIMITS[key]) errors.push(`${key === "change_summary" ? "修正内容" : "修正理由"}は${CHANGE_LIMITS[key]}文字以内で入力してください`);
    out[key] = value || null;
  }
  if (errors.length) throw postingError(400, errors.join("\n"), { code: "invalid", fields: errors });
  return out;
}

// 前の版との違い（項目ごとの修正前・修正後）。prev が無い場合は初版（登録した項目すべて）
export function revisionDiff(prev, next) {
  return REVISION_FIELDS
    .map(f => ({ key: f.key, label: f.label, before: prev ? prev[f.key] ?? null : null, after: next?.[f.key] ?? null }))
    .filter(d => (d.before ?? "") !== (d.after ?? ""));
}
export const sameContent = (a, b) => revisionDiff(a, b).length === 0;

// ---------- 公開／非公開 ----------
export const VISIBILITY = { public: "公開中", private: "非公開" };
export const visibilityLabel = v => VISIBILITY[v] || "要設定";

// events: その求人の切替履歴（seq 順）。現在の状態・公開期間（開始日〜非公開日）を返す
export function visibilityState(events = []) {
  const list = events.slice().sort((a, b) => Number(a.seq) - Number(b.seq));
  const last = list[list.length - 1] || null;
  const periods = [];
  for (const e of list) {
    if (e.visibility === "public") periods.push({ start: e.effective_date, end: null });
    else if (periods.length && periods[periods.length - 1].end == null) periods[periods.length - 1].end = e.effective_date;
  }
  return {
    current: last ? last.visibility : null,
    since: last ? last.effective_date : null,
    seq: last ? Number(last.seq) : 0,
    public_periods: periods,
    first_public: periods.length ? periods[0].start : null,
    last_private: [...list].reverse().find(e => e.visibility === "private")?.effective_date ?? null,
  };
}

export function validateVisibility(body, { current, since, today }) {
  const b = body && typeof body === "object" ? body : {};
  if (!["public", "private"].includes(b.visibility)) throw postingError(400, "公開状態が正しくありません");
  if (b.visibility === current) throw postingError(409, `この求人は既に「${VISIBILITY[current]}」です。画面を読み込み直してください`, { code: "stale" });
  const date = b.effective_date == null || b.effective_date === "" ? today : b.effective_date;
  if (!isDate(date)) throw postingError(400, `${b.visibility === "public" ? "公開開始日" : "非公開日"}は西暦4桁の正しい日付で入力してください`);
  if (date > today) throw postingError(400, `${b.visibility === "public" ? "公開開始日" : "非公開日"}は本日以前の日付を入力してください`);
  if (since && date < since) throw postingError(400, `日付は直前の切替日（${since}）以降を入力してください`);
  const reason = b.reason == null ? "" : String(b.reason).trim();
  if (reason.length > CHANGE_LIMITS.reason) throw postingError(400, `理由は${CHANGE_LIMITS.reason}文字以内で入力してください`);
  return { visibility: b.visibility, effective_date: date, reason: reason || null };
}

// ---------- 求人の新規登録 ----------
// 求人IDがあれば「id:求人ID」（CSV取込と同じ照合キー）、無ければNKS採番「nks:…」
export function externalKeyFor(jobId, random) {
  const id = jobIdText(jobId);
  return id ? `id:${id}` : `nks:${random}`;
}
export function validateNewPosting(body) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];
  const categoryId = b.category_id == null ? "" : String(b.category_id);
  if (!/^\d+$/.test(categoryId)) errors.push("職種を選択してください");
  const media = text(b.media);
  if (!media) errors.push("掲載媒体を選択してください");
  if (media.length > 50) errors.push("掲載媒体は50文字以内で入力してください");
  if (b.job_id != null && typeof b.job_id !== "string") errors.push("求人ID・参照番号が正しくありません");
  const jobId = typeof b.job_id === "string" ? b.job_id.trim() : "";
  if (jobId.length > CHANGE_LIMITS.job_id) errors.push(`求人ID・参照番号は${CHANGE_LIMITS.job_id}文字以内で入力してください`);
  const visibility = b.visibility == null || b.visibility === "" ? null : b.visibility;
  if (visibility != null && !["public", "private"].includes(visibility)) errors.push("公開状態が正しくありません");
  if (errors.length) throw postingError(400, errors.join("\n"), { code: "invalid", fields: errors });
  // 表記揺れのある媒体名は、選択肢の表記で保存する（CSV取込の「Indeed」と同じ求人として照合できるように）
  return { category_id: categoryId, media: mediaKey(media), job_id: jobId || null, visibility };
}

// ---------- 改善履歴（既存の記録を時系列にまとめる。別には保存しない） ----------
// revisions: 版、records: 実績（recordStates 済み）、planEvents: 掲載状態の変更（planEventStates 済み）
export function improvementTimeline({ revisions = [], records = [], planEvents = [] }) {
  const items = [];
  for (const r of revisions) {
    if (!r.change_summary && !r.change_reason && Number(r.revision_no) !== 1) continue;
    items.push({ kind: "revision", at: r.created_at, date: String(r.created_at || "").slice(0, 10), label: Number(r.revision_no) === 1 ? "初版登録" : `求人内容の修正（第${r.revision_no}版）`,
      note: [r.change_summary, r.change_reason ? `理由：${r.change_reason}` : ""].filter(Boolean).join("\n") || null, actor: r.actor || null, ref: `revision:${r.id}` });
  }
  for (const r of records) {
    if (r.kind !== "metric" || !r.note || r.state === "superseded") continue;
    items.push({ kind: "record", at: r.created_at, date: r.period_start, label: `実績メモ（${r.period_start}〜${r.period_end}）`, note: r.note, actor: r.actor || null,
      state: r.state, ref: `record:${r.id}` });
  }
  for (const e of planEvents) {
    if (e.kind === "void" || !e.note) continue;
    items.push({ kind: "plan", at: e.created_at, date: e.effective_date, label: `掲載状態の変更メモ（${e.effective_date}）`, note: e.note, actor: e.actor || null,
      state: e.state, ref: `plan:${e.id}` });
  }
  // 新しい順（業務上の日付 → 登録日時）
  return items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.at || "").localeCompare(String(a.at || "")));
}

// ---------- 一覧の絞り込み ----------
export function filterPostings(rows, { view = "public", media = "" } = {}) {
  return rows.filter(p => (view === "all" || (view === "unset" ? p.visibility == null : p.visibility === view))
    && (!media || mediaKey(p.media) === media));
}
export function visibilityCounts(rows) {
  return {
    public: rows.filter(p => p.visibility === "public").length,
    private: rows.filter(p => p.visibility === "private").length,
    unset: rows.filter(p => p.visibility == null).length,
    all: rows.length,
  };
}
