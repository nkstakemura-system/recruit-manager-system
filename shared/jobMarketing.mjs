// 求人マーケティング分析（第4弾）。DBに接続しない純粋関数のみ（ブラウザ・APIサーバー・テストで共用）。
//
// 数値の扱い
// * 未取得は null（0件とは区別する）。費用の空欄は「無料・0円」とみなさない。
// * 率は分母0・未取得なら null（画面では「—」）。
// * 日別CSVは実際に存在する日付だけを集計し、記録のない日を0件扱いしない。
// * 同じ職種で期間が重なる記録は合算しない。月をまたぐ記録（日別データなし）は月次集計に入れない。

export const DEFAULT_MEDIA = "Indeed";
export const DEFAULT_CATEGORIES = ["営業", "CADオペ（ときがわ）", "CADオペ（本社）", "電気工事士"];
export const PLAN_TYPES = { free: "無料", paid: "有料", unknown: "不明" };
// 職種・求人原稿ごとの掲載状態（変更日つきの履歴で管理する）
export const PLAN_STATUS = { free: "無料掲載", paid: "有料掲載", unknown: "不明", stopped: "募集停止" };
export const SOURCES = { manual: "手入力", indeed_csv: "Indeed CSV", legacy_csv: "旧管理CSV" };
export const METRICS = ["impressions", "clicks", "apply_starts", "applies"];
export const METRIC_LABELS = { impressions: "表示回数", clicks: "クリック数", apply_starts: "応募開始数", applies: "応募完了数" };
export const RATE_LABELS = { ctr: "クリック率（CTR）", asr: "応募開始率（ASR）", completion: "応募完了率", apply_rate: "応募率" };
export const LIMITS = { note: 4000, reason: 500, media: 50, category: 50, company: 200, title: 200, url: 2000, memo: 2000, maxDays: 366, maxCount: 2147483647, maxCost: 999999999999 };

// 自動分析コメントの目安（画面にも表示する。原因の断定には使わない）
export const THRESHOLDS = {
  minImpressions: 100, // これ未満は母数が少なく判断を保留
  minClicks: 30,
  lowDailyImpressions: 10, // 1日あたりの表示回数
  lowCtr: 3, // %
  lowAsr: 5, // %
  lowCompletion: 50, // %
  minStartsForCompletion: 3,
  change: 20, // 前月比 ±20% 以上を「変化あり」とする
  minPlanDays: 7, // 無料・有料の比較に必要な日数（それぞれ）
};

const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, "0");

export function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1000 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}
function daysInMonth(year, month) {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
const utc = date => { const d = new Date(0); d.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))); return d.getTime(); };
const fromUtc = ms => { const d = new Date(ms); return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const addDays = (date, days) => fromUtc(utc(date) + days * DAY_MS);
export const spanDays = (start, end) => Math.round((utc(end) - utc(start)) / DAY_MS) + 1;
export function eachDay(start, end) {
  const out = [];
  for (let ms = utc(start), last = utc(end); ms <= last; ms += DAY_MS) out.push(fromUtc(ms));
  return out;
}
export const monthOf = date => date.slice(0, 7);
export function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: `${month}-${pad(daysInMonth(y, m))}`, days: daysInMonth(y, m) };
}
export function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${pad((index % 12) + 1)}`;
}
export const isMonth = value => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= "0001-01";
export const todayTokyo = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
export const monthLabel = month => `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
export const slashDate = date => date ? `${Number(date.slice(0, 4))}/${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : "";
export const periodLabel = (start, end) => `${slashDate(start)}〜${slashDate(end)}`;
// 日付の並び（昇順）を「9/1〜9/3、9/5」のような連続範囲にまとめる
export function dateRanges(dates) {
  const ranges = [];
  for (const date of dates) {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.end, 1) === date) last.end = date;
    else ranges.push({ start: date, end: date });
  }
  return ranges;
}
export const rangesLabel = dates => dateRanges(dates).map(r => r.start === r.end ? slashDate(r.start) : periodLabel(r.start, r.end)).join("、");

// ---------- 値の検証 ----------

function marketingError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
export { marketingError };

const text = value => typeof value === "string" ? value.trim() : "";
// 0以上の整数。空欄・未入力は null（未取得）
export function parseCount(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return { value: null };
  const raw = typeof value === "number" ? value : Number(String(value).replace(/[,，\s]/g, "").replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0 || raw > LIMITS.maxCount) return { error: true };
  return { value: raw };
}
// 0以上の金額（小数2桁まで）。空欄は null（未取得。0円ではない）
export function parseCost(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return { value: null };
  const s = typeof value === "number" ? String(value) : String(value).replace(/[,，¥￥円\s]/g, "").replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: true };
  const raw = Number(s);
  if (!Number.isFinite(raw) || raw > LIMITS.maxCost) return { error: true };
  return { value: raw };
}

const normalizeName = name => text(name).normalize("NFKC").replace(/\s+/g, " ");
export const sameCategoryName = (a, b) => normalizeName(a) === normalizeName(b);

export function validateCategoryName(name) {
  const value = text(name);
  if (!value) throw marketingError(400, "職種名を入力してください");
  if (value.length > LIMITS.category) throw marketingError(400, `職種名は${LIMITS.category}文字以内で入力してください`);
  return value;
}

// 日別の行（Indeed CSV）
function normalizeDaily(daily, start, end, errors) {
  if (daily == null) return null;
  if (!Array.isArray(daily) || daily.length === 0) { errors.push("日別データが空です"); return null; }
  const seen = new Set();
  const rows = [];
  for (const row of daily) {
    if (!row || !isDate(row.date)) { errors.push("日別データの日付が正しくありません"); return null; }
    if (seen.has(row.date)) { errors.push(`日別データに同じ日付が複数あります（${slashDate(row.date)}）`); return null; }
    if (start && end && (row.date < start || row.date > end)) { errors.push(`日別データの日付（${slashDate(row.date)}）が対象期間外です`); return null; }
    seen.add(row.date);
    const out = { date: row.date };
    for (const key of METRICS) {
      const parsed = parseCount(row[key]);
      if (parsed.error) { errors.push(`${slashDate(row.date)}の${METRIC_LABELS[key]}が正しくありません`); return null; }
      out[key] = parsed.value;
    }
    const cost = parseCost(row.cost);
    if (cost.error) { errors.push(`${slashDate(row.date)}の費用が正しくありません`); return null; }
    out.cost = cost.value;
    rows.push(out);
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// 日別データの合計。1日でも未取得があれば合計も未取得（一部だけの合計を実績として扱わない）
export function sumDaily(daily, key) {
  if (!daily.length) return null;
  let total = 0;
  for (const row of daily) {
    if (row[key] == null) return null;
    total += row[key];
  }
  return key === "cost" ? Math.round(total * 100) / 100 : total;
}

// 登録する1件の実績を検証・正規化する（手入力・CSVとも）。日別データがある場合、合計は日別から再計算する。
export function normalizeRecord(input) {
  const errors = [];
  const r = input || {};
  const out = {};
  if (r.category_id == null || !/^\d+$/.test(String(r.category_id))) errors.push("職種を選択してください");
  else out.category_id = String(r.category_id);
  out.media = text(r.media) || DEFAULT_MEDIA;
  if (out.media.length > LIMITS.media) errors.push(`掲載媒体は${LIMITS.media}文字以内で入力してください`);
  if (!isDate(r.period_start) || !isDate(r.period_end)) errors.push("対象期間は西暦4桁の正しい日付で入力してください");
  else if (r.period_end < r.period_start) errors.push("終了日は開始日以降にしてください");
  else if (spanDays(r.period_start, r.period_end) > LIMITS.maxDays) errors.push(`対象期間は${LIMITS.maxDays}日以内にしてください`);
  else { out.period_start = r.period_start; out.period_end = r.period_end; }
  out.plan_type = Object.hasOwn(PLAN_TYPES, r.plan_type) ? r.plan_type : null;
  if (!out.plan_type) errors.push("無料／有料／不明を選択してください");
  for (const key of METRICS) {
    const parsed = parseCount(r[key]);
    if (parsed.error) errors.push(`${METRIC_LABELS[key]}は0以上の整数で入力してください`);
    else out[key] = parsed.value;
  }
  const cost = parseCost(r.cost);
  if (cost.error) errors.push("掲載費用は0以上の金額（小数2桁まで）で入力してください");
  else out.cost = cost.value;
  out.note = text(r.note) || null;
  if (out.note && out.note.length > LIMITS.note) errors.push(`改善メモは${LIMITS.note}文字以内で入力してください`);
  out.source = Object.hasOwn(SOURCES, r.source) ? r.source : "manual";
  if (r.posting_id == null || r.posting_id === "") out.posting_id = null;
  else if (/^\d+$/.test(String(r.posting_id))) out.posting_id = String(r.posting_id);
  else errors.push("求人原稿の指定が正しくありません");
  out.daily = normalizeDaily(r.daily, out.period_start, out.period_end, errors);
  if (out.daily) {
    for (const key of METRICS) out[key] = sumDaily(out.daily, key);
    out.cost = out.daily.every(d => d.cost == null) ? null : sumDaily(out.daily, "cost");
  }
  out.source_meta = r.source_meta && typeof r.source_meta === "object" && !Array.isArray(r.source_meta) ? r.source_meta : null;
  if (out.source_meta && JSON.stringify(out.source_meta).length > 20000) errors.push("取り込み元の情報が大きすぎます");
  if (errors.length) throw marketingError(400, errors[0], { code: "invalid", fields: errors });
  return out;
}

// 数値の前後関係の注意（登録は止めない。提供元の定義により逆転しうるため）
export function recordWarnings(r) {
  const out = [];
  if (r.impressions != null && r.clicks != null && r.clicks > r.impressions) out.push("クリック数が表示回数を上回っています");
  if (r.clicks != null && r.apply_starts != null && r.apply_starts > r.clicks) out.push("応募開始数がクリック数を上回っています");
  if (r.apply_starts != null && r.applies != null && r.applies > r.apply_starts) out.push("応募完了数が応募開始数を上回っています（提供元の定義を確認してください）");
  if (r.cost == null) out.push("掲載費用は未入力です（無料・0円とはみなしません）");
  return out;
}

export function validateReference(input) {
  const r = input || {};
  const out = {};
  out.company_name = text(r.company_name);
  if (!out.company_name) throw marketingError(400, "会社名を入力してください");
  if (out.company_name.length > LIMITS.company) throw marketingError(400, `会社名は${LIMITS.company}文字以内で入力してください`);
  out.job_title = text(r.job_title) || null;
  if (out.job_title && out.job_title.length > LIMITS.title) throw marketingError(400, `求人タイトルは${LIMITS.title}文字以内で入力してください`);
  out.url = text(r.url) || null;
  if (out.url && !safeUrl(out.url)) throw marketingError(400, "参考求人URLは http:// または https:// で始まる正しいURLを入力してください");
  out.memo = text(r.memo) || null;
  if (out.memo && out.memo.length > LIMITS.memo) throw marketingError(400, `メモは${LIMITS.memo}文字以内で入力してください`);
  out.checked_on = r.checked_on ? String(r.checked_on) : null;
  if (out.checked_on && !isDate(out.checked_on)) throw marketingError(400, "確認日は西暦4桁の正しい日付で入力してください");
  return out;
}

// http / https のみ。表示・リンクには正規化したURLを使う
export function safeUrl(value) {
  if (typeof value !== "string" || value.length > LIMITS.url || /[\s<>"]/.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- 率 ----------

const ratio = (num, den) => num == null || den == null || den === 0 ? null : (num / den) * 100;
export function rates(t) {
  return {
    ctr: ratio(t.clicks, t.impressions),
    asr: ratio(t.apply_starts, t.clicks),
    completion: ratio(t.applies, t.apply_starts),
    apply_rate: ratio(t.applies, t.clicks),
  };
}
export const fmtRate = value => value == null ? "—" : `${value.toFixed(1)}%`;
export const fmtCount = value => value == null ? "—" : value.toLocaleString("ja-JP");
export const fmtYen = value => value == null ? "—" : `¥${Math.round(value).toLocaleString("ja-JP")}`;
// 費用と件数がそろうときだけ単価を出す（費用未入力は計算しない）
export const unitCost = (cost, count) => cost == null || count == null || count === 0 ? null : cost / count;

// ---------- 履歴の状態（追記専用） ----------

// 置換（修正）・取消された記録を除いた有効な実績。rows は全行（kind: metric / void）
export function recordStates(rows) {
  const replacedBy = new Map();
  for (const row of rows) if (row.supersedes_id != null) replacedBy.set(String(row.supersedes_id), row);
  return rows.filter(r => r.kind === "metric").map(r => {
    const by = replacedBy.get(String(r.id));
    return { ...r, state: by ? (by.kind === "void" ? "voided" : "superseded") : "active", replaced_by: by ? String(by.id) : null, void_reason: by?.kind === "void" ? by.reason : null };
  });
}
export const activeRecords = rows => recordStates(rows).filter(r => r.state === "active");

// 求人原稿の単位。同じ職種でも別の原稿（求人ID）どうしは同時掲載として合算できる。
// 原稿を特定しない記録（職種全体の合計）は、同じ職種のどの記録とも重複になりうる。
const postingKey = r => r.posting_id == null ? null : String(r.posting_id);
export const sameScope = (a, b) => postingKey(a) == null || postingKey(b) == null || postingKey(a) === postingKey(b);

// 同じ職種・媒体・原稿で期間が重なる有効な記録（ignore: 置き換え対象として除外するID）
export function findConflicts(active, record, ignore = []) {
  const skip = new Set(ignore.map(String));
  return active.filter(r => String(r.category_id) === String(record.category_id) && r.media === record.media && !skip.has(String(r.id))
    && sameScope(r, record) && r.period_start <= record.period_end && record.period_start <= r.period_end)
    .map(r => ({
      id: String(r.id), type: r.period_start === record.period_start && r.period_end === record.period_end ? "same_period" : "overlap",
      period_start: r.period_start, period_end: r.period_end, source: r.source, plan_type: r.plan_type,
    }));
}

// ---------- 掲載状態の履歴（追記専用） ----------

// 取消された変更を除く。rows は全行（kind: change / void）
export function planEventStates(rows) {
  const voided = new Map();
  for (const row of rows) if (row.kind === "void" && row.supersedes_id != null) voided.set(String(row.supersedes_id), row);
  return rows.filter(r => r.kind === "change").map(r => {
    const v = voided.get(String(r.id));
    return { ...r, state: v ? "voided" : "active", void_reason: v ? v.reason : null };
  });
}

// (職種, 原稿, 日付) → その日に有効な変更。職種全体の変更と原稿ごとの変更のうち、その日以前で最も新しいもの
export function planResolver(events) {
  const list = events.filter(e => e.kind !== "void" && e.state !== "voided")
    .slice().sort((a, b) => a.effective_date.localeCompare(b.effective_date) || Number(a.id) - Number(b.id));
  return (categoryId, postingId, date) => {
    let found = null;
    for (const e of list) {
      if (e.effective_date > date) break;
      if (String(e.category_id) !== String(categoryId)) continue;
      if (e.posting_id != null && String(e.posting_id) !== String(postingId ?? "")) continue;
      found = e;
    }
    return found;
  };
}

// 実績1日分の掲載種別。履歴で無料・有料が決まっていればそれを使い、無い日（不明・募集停止を含む）は記録の掲載種別
export function dayPlan(planAt, record, date) {
  const e = planAt ? planAt(record.category_id, record.posting_id, date) : null;
  return e && (e.status === "free" || e.status === "paid") ? e.status : record.plan_type;
}

export function validatePlanEvent(input) {
  const r = input || {};
  if (!/^\d+$/.test(String(r.category_id ?? ""))) throw marketingError(400, "職種を選択してください");
  if (r.posting_id != null && r.posting_id !== "" && !/^\d+$/.test(String(r.posting_id))) throw marketingError(400, "求人原稿の指定が正しくありません");
  if (!Object.hasOwn(PLAN_STATUS, r.status)) throw marketingError(400, "掲載状態を選択してください");
  if (!isDate(r.effective_date)) throw marketingError(400, `${r.status === "paid" ? "有料掲載開始日" : "変更日"}を西暦4桁の正しい日付で入力してください`);
  const budget = parseCost(r.budget);
  if (budget.error) throw marketingError(400, "予算・費用は0以上の金額で入力してください");
  const note = text(r.note) || null;
  if (note && note.length > LIMITS.note) throw marketingError(400, `メモは${LIMITS.note}文字以内で入力してください`);
  return {
    category_id: String(r.category_id), posting_id: r.posting_id == null || r.posting_id === "" ? null : String(r.posting_id),
    status: r.status, effective_date: r.effective_date, budget: r.status === "paid" ? budget.value : null, note,
  };
}

// ---------- 月次集計 ----------

// records: 有効な実績。月内に計上できる部分だけを集める
// planAt: planResolver の結果（掲載状態の履歴）。無ければ記録の掲載種別を使う
export function monthAggregate(records, { categoryId, media = DEFAULT_MEDIA, month, asOf, planAt }) {
  const range = monthRange(month);
  const lastExpected = asOf && asOf < range.end ? asOf : range.end;
  const future = Boolean(asOf) && range.start > asOf;
  const parts = [];
  const spanning = [];
  for (const r of records) {
    if (String(r.category_id) !== String(categoryId) || r.media !== media) continue;
    if (r.period_end < range.start || r.period_start > range.end) continue;
    if (Array.isArray(r.daily) && r.daily.length) {
      const rows = r.daily.filter(d => d.date >= range.start && d.date <= range.end);
      if (rows.length) parts.push({ record: r, dates: rows.map(d => d.date), rows });
      else if (r.period_start < range.start || r.period_end > range.end) continue;
    } else if (r.period_start >= range.start && r.period_end <= range.end) {
      parts.push({ record: r, dates: eachDay(r.period_start, r.period_end), rows: null });
    } else {
      spanning.push(r);
    }
  }
  // 同じ日に同じ原稿（または原稿を特定しない記録）が2件以上あれば重複として合算しない
  const seen = new Map();
  const overlapDates = new Set();
  for (const p of parts) {
    const key = postingKey(p.record) ?? "*";
    for (const date of p.dates) {
      const keys = seen.get(date) || new Set();
      if (keys.has(key) || keys.has("*") || (key === "*" && keys.size)) overlapDates.add(date);
      keys.add(key);
      seen.set(date, keys);
    }
  }
  const covered = [...seen.keys()].sort();
  const expected = future ? [] : eachDay(range.start, lastExpected);
  const coveredSet = new Set(covered);
  const missing = expected.filter(d => !coveredSet.has(d));
  const planTypes = [...new Set(parts.flatMap(p => p.dates.map(d => dayPlan(planAt, p.record, d))))];
  const overlap = overlapDates.size > 0;
  const totals = {};
  for (const key of [...METRICS, "cost"]) {
    if (!parts.length || overlap) { totals[key] = null; continue; }
    let sum = 0;
    for (const p of parts) {
      const value = p.rows ? (key === "cost" && p.rows.every(d => d.cost == null) ? null : sumDaily(p.rows, key)) : p.record[key];
      if (value == null) { sum = null; break; }
      sum += value;
    }
    totals[key] = sum == null ? null : key === "cost" ? Math.round(sum * 100) / 100 : sum;
  }
  const status = !parts.length ? "empty" : overlap ? "overlap" : "ok";
  return {
    month, category_id: String(categoryId), media, status, totals, rates: rates(totals),
    days_in_month: range.days, covered_days: covered.length, covered_dates: covered, missing_dates: missing,
    in_progress: Boolean(asOf) && !future && range.end > asOf, future,
    complete: status === "ok" && missing.length === 0 && !(Boolean(asOf) && range.end > asOf),
    plan: planTypes.length === 0 ? null : planTypes.length === 1 ? planTypes[0] : "mixed",
    plan_types: planTypes, record_ids: parts.map(p => String(p.record.id)), postings: new Set(parts.map(p => postingKey(p.record) ?? "*")).size,
    sources: [...new Set(parts.map(p => p.record.source))],
    overlap_dates: [...overlapDates].sort(), spanning: spanning.map(r => String(r.id)),
    notes: parts.filter(p => p.record.note).map(p => ({ id: String(p.record.id), period_start: p.record.period_start, period_end: p.record.period_end, note: p.record.note })),
  };
}

export function monthlySeries(records, { categoryId, media = DEFAULT_MEDIA, endMonth, count = 12, asOf, planAt }) {
  return Array.from({ length: count }, (_, i) => monthAggregate(records, { categoryId, media, month: shiftMonth(endMonth, i - count + 1), asOf, planAt }));
}

// 単純な前月比較ができるか。できない理由を返す（比較できないときは差分を出さない）
export function comparability(cur, prev) {
  const reasons = [];
  const name = a => `${Number(a.month.slice(5, 7))}月`;
  if (cur.status === "empty") reasons.push(`${name(cur)}の実績がありません`);
  if (prev.status === "empty") reasons.push(`${name(prev)}の実績がありません（比較データ不足）`);
  for (const a of [cur, prev]) {
    if (a.status === "empty") continue;
    if (a.status === "overlap") reasons.push(`${name(a)}は期間が重なる記録があり、合算していません`);
    if (a.in_progress) reasons.push(`${name(a)}は集計途中です`);
    else if (a.missing_dates.length) reasons.push(`${name(a)}は${a.covered_days}/${a.days_in_month}日分のみ（未収集日：${rangesLabel(a.missing_dates)}）`);
    if (a.plan === "mixed") reasons.push(`${name(a)}は無料／有料などの掲載種別が混在しています`);
  }
  if (cur.plan && prev.plan && cur.plan !== "mixed" && prev.plan !== "mixed" && cur.plan !== prev.plan)
    reasons.push(`掲載種別が異なります（${name(prev)}：${PLAN_TYPES[prev.plan]}、${name(cur)}：${PLAN_TYPES[cur.plan]}）`);
  const cautions = [];
  if (!reasons.length && (cur.plan === "unknown" || prev.plan === "unknown")) cautions.push("掲載種別が「不明」の月を含むため、無料／有料の違いは考慮していません");
  if (!reasons.length && (cur.spanning.length || prev.spanning.length)) cautions.push("月をまたぐ記録は月次の数値に含めていません");
  return { comparable: reasons.length === 0, reasons, cautions };
}

export function monthDeltas(cur, prev) {
  const out = {};
  for (const key of METRICS) {
    const a = cur.totals[key], b = prev.totals[key];
    out[key] = a == null || b == null ? null : { diff: a - b, pct: b === 0 ? null : ((a - b) / b) * 100 };
  }
  for (const key of Object.keys(RATE_LABELS)) {
    const a = cur.rates[key], b = prev.rates[key];
    out[key] = a == null || b == null ? null : { diff: a - b, pct: null };
  }
  return out;
}

// ---------- 無料・有料の比較 ----------

// 無料掲載と有料掲載の期間を分けて集計する（start〜end の範囲）。
// * 日別データは日ごとの掲載状態（履歴）で分ける。
// * 月間合計など日別でない記録は、期間中に掲載状態が変わっていれば「内訳不明」とし、日数で按分しない。
// * 同じ日・同じ原稿の記録が重なる場合は二重計上を避けるため比較から除く。範囲をまたぐ日別でない記録も除く。
export function planSplit(records, { categoryId, media = DEFAULT_MEDIA, start, end, planAt }) {
  const parts = [];
  for (const r of records) {
    if (String(r.category_id) !== String(categoryId) || r.media !== media) continue;
    if (r.period_end < start || r.period_start > end) continue;
    if (Array.isArray(r.daily) && r.daily.length) {
      const rows = r.daily.filter(d => d.date >= start && d.date <= end);
      if (rows.length) parts.push({ record: r, dates: rows.map(d => d.date), rows });
    } else if (r.period_start >= start && r.period_end <= end) {
      parts.push({ record: r, dates: eachDay(r.period_start, r.period_end), rows: null });
    }
  }
  const seen = new Map();
  const clash = new Set();
  parts.forEach((p, i) => {
    const key = postingKey(p.record) ?? "*";
    for (const date of p.dates) {
      const list = seen.get(date) || [];
      for (const o of list) if (o.key === key || o.key === "*" || key === "*") { clash.add(i); clash.add(o.i); }
      list.push({ key, i });
      seen.set(date, list);
    }
  });
  const bucket = () => ({ dates: new Set(), unit_days: 0, sum: { impressions: 0, clicks: 0, apply_starts: 0, applies: 0, cost: 0 }, missing: new Set(), records: new Set(), postings: new Set() });
  const b = { free: bucket(), paid: bucket(), unknown: bucket(), split: bucket() };
  const add = (target, record, dates, values) => {
    for (const d of dates) target.dates.add(d);
    target.unit_days += dates.length;
    target.records.add(String(record.id));
    target.postings.add(postingKey(record) ?? "*");
    for (const key of [...METRICS, "cost"]) {
      if (values[key] == null) target.missing.add(key);
      else target.sum[key] += values[key];
    }
  };
  parts.forEach((p, i) => {
    if (clash.has(i)) return;
    if (p.rows) {
      for (const row of p.rows) add(b[dayPlan(planAt, p.record, row.date)], p.record, [row.date], row);
    } else {
      const plans = new Set(p.dates.map(d => dayPlan(planAt, p.record, d)));
      add(plans.size === 1 ? b[[...plans][0]] : b.split, p.record, p.dates, p.record);
    }
  });
  const finish = (x, plan) => {
    if (!x.unit_days) return null;
    const totals = {};
    for (const key of [...METRICS, "cost"]) totals[key] = x.missing.has(key) ? null : key === "cost" ? Math.round(x.sum[key] * 100) / 100 : x.sum[key];
    const dates = [...x.dates].sort();
    const perDay = {};
    for (const key of METRICS) perDay[key] = totals[key] == null ? null : totals[key] / x.unit_days;
    return {
      plan, totals, rates: rates(totals), per_day: perDay, unit_cost: unitCost(totals.cost, totals.applies),
      day_count: dates.length, unit_days: x.unit_days, postings: x.postings.size, first: dates[0], last: dates[dates.length - 1],
      ranges: dateRanges(dates), record_ids: [...x.records],
    };
  };
  const free = finish(b.free, "free");
  const paid = finish(b.paid, "paid");
  const reasons = [];
  for (const [g, label] of [[free, "無料掲載"], [paid, "有料掲載"]]) {
    if (!g) { reasons.push(`${label}の実績がありません`); continue; }
    if (g.day_count < THRESHOLDS.minPlanDays) reasons.push(`${label}の実績が${g.day_count}日分のみです`);
    if (g.totals.impressions == null || g.totals.clicks == null) reasons.push(`${label}の表示回数またはクリック数が未取得です`);
  }
  const comparable = reasons.length === 0;
  let changes = null;
  if (comparable) {
    const pct = (a, c) => a == null || c == null || a === 0 ? null : ((c - a) / a) * 100;
    const diff = (a, c) => a == null || c == null ? null : c - a;
    changes = {
      impressions_per_day: pct(free.per_day.impressions, paid.per_day.impressions),
      clicks_per_day: pct(free.per_day.clicks, paid.per_day.clicks),
      applies_per_day: pct(free.per_day.applies, paid.per_day.applies),
      ctr: diff(free.rates.ctr, paid.rates.ctr), asr: diff(free.rates.asr, paid.rates.asr), apply_rate: diff(free.rates.apply_rate, paid.rates.apply_rate),
    };
  }
  return {
    free, paid, unknown: finish(b.unknown, "unknown"), split_unknown: finish(b.split, "split"),
    excluded: parts.filter((_, i) => clash.has(i)).map(p => String(p.record.id)), comparable, reasons, changes,
  };
}

// ---------- 自動分析コメント（ルールベース。外部AIは使わない） ----------

// 断定せず「確認候補」として返す。level: check（確認候補）/ info（参考）/ good（良い変化）/ hold（判断保留）
// priority が小さいほど重要（画面では上位3件を先に表示し、残りは折り畳む）
const signed = (value, digits, unit) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}${unit}`;
export function analyze({ current, previous, comparison, series = [], plans = null }) {
  const items = [];
  const push = (priority, level, title, body) => items.push({ priority, level, title, body });
  const t = current.totals;
  const r = current.rates;
  if (current.status === "empty") {
    push(1, "hold", "この月の実績が未登録です", "Indeedのアナリティクスから表示回数・クリック数・応募開始数・応募数を登録してください。");
    return { items, trend: "none" };
  }
  if (current.status === "overlap") {
    push(1, "hold", "期間が重なる記録があります", `${rangesLabel(current.overlap_dates)}が複数の記録に含まれるため、合算・分析をしていません。改善履歴から置き換えまたは取消してください。`);
    return { items, trend: "none" };
  }
  const days = current.covered_days || 0;
  const small = (t.impressions ?? 0) < THRESHOLDS.minImpressions || (t.clicks ?? 0) < THRESHOLDS.minClicks;

  const perDay = t.impressions != null && days ? t.impressions / days : null;
  if (perDay != null && perDay < THRESHOLDS.lowDailyImpressions)
    push(2, "check", "露出が少ない", `1日あたり約${perDay.toFixed(1)}回の表示です。掲載状況（停止・審査）、職種名・勤務地の表記、検索キーワード、有料掲載の予算を確認してください。`);
  if (r.ctr != null && t.impressions >= THRESHOLDS.minImpressions && r.ctr < THRESHOLDS.lowCtr)
    push(2, "check", "表示に対してクリックが少ない", `クリック率（CTR） ${fmtRate(r.ctr)}。求人タイトル・給与の見せ方・勤務地・冒頭文など、検索結果で目に入る部分の見直し候補です。`);
  if (r.asr != null && t.clicks >= THRESHOLDS.minClicks && r.asr < THRESHOLDS.lowAsr)
    push(2, "check", "クリック後の応募開始率が低い", `応募開始率 ${fmtRate(r.asr)}。仕事内容の具体性・応募条件・待遇・写真など、求人詳細ページの見直し候補です。`);
  if (r.completion != null && t.apply_starts >= THRESHOLDS.minStartsForCompletion && r.completion < THRESHOLDS.lowCompletion)
    push(2, "check", "応募開始から完了までの離脱", `応募完了率 ${fmtRate(r.completion)}。応募フォームの項目数・履歴書の要否・外部サイトへの遷移を確認してください。`);

  if (plans?.comparable && plans.changes) {
    const c = plans.changes;
    const parts = [];
    if (c.impressions_per_day != null && Math.abs(c.impressions_per_day) >= THRESHOLDS.change) parts.push(`1日あたり表示 ${signed(c.impressions_per_day, 0, "%")}`);
    if (c.clicks_per_day != null && Math.abs(c.clicks_per_day) >= THRESHOLDS.change) parts.push(`1日あたりクリック ${signed(c.clicks_per_day, 0, "%")}`);
    if (c.ctr != null && Math.abs(c.ctr) >= 1) parts.push(`クリック率（CTR） ${signed(c.ctr, 1, "pt")}`);
    const basis = `無料${plans.free.day_count}日・有料${plans.paid.day_count}日の比較`;
    if (parts.length) push(2, "info", "有料切替後の反応に変化があります", `${parts.join("、")}（${basis}）。原稿の変更や時期の影響も含まれるため、有料掲載だけの効果とは断定できません。`);
    else push(4, "info", "有料切替の前後で大きな変化はありません", `1日あたりの表示・クリック、クリック率（CTR）に大きな差はありません（${basis}）。`);
  }

  if (small)
    push(3, "hold", "母数が少なく判断保留", `表示${fmtCount(t.impressions)}回・クリック${fmtCount(t.clicks)}回では、率の上下が偶然による可能性があります。`);
  if (t.impressions == null || t.clicks == null)
    push(3, "hold", "表示回数またはクリック数が未取得", "未取得の項目があるため、率の一部を計算していません。");

  if (!comparison || !comparison.comparable) {
    const past = series.filter(m => m.month < current.month && m.status === "ok");
    push(4, "hold", "比較データ不足", past.length
      ? `前月との単純比較はできません（${(comparison?.reasons || []).join("／")}）。`
      : "比較できる過去の実績がまだありません。同じ条件（全日分・同じ掲載種別）の月がそろうと前月比を評価できます。");
  } else {
    const d = monthDeltas(current, previous);
    const changed = [];
    for (const key of METRICS) {
      const x = d[key];
      if (x?.pct != null && Math.abs(x.pct) >= THRESHOLDS.change) changed.push(`${METRIC_LABELS[key]} ${signed(x.pct, 0, "%")}`);
    }
    for (const key of ["ctr", "asr"]) {
      const x = d[key];
      if (x && Math.abs(x.diff) >= 1) changed.push(`${RATE_LABELS[key]} ${signed(x.diff, 1, "pt")}`);
    }
    const better = (d.applies?.diff ?? 0) > 0 || (d.apply_starts?.diff ?? 0) > 0 || (d.ctr?.diff ?? 0) >= 1;
    if (changed.length) push(3, better ? "good" : "info", "前月から変化があります", `${changed.join("、")}。記録された原稿の変更と照らし合わせてください（時期・競合の影響もありえます）。`);
    else push(5, "info", "前月と大きな変化なし", `主要な数値に±${THRESHOLDS.change}%以上の変化はありません。`);
    if (comparison.cautions.length) push(6, "info", "比較の注意", comparison.cautions.join("。") + "。");
  }
  if (current.missing_dates.length && !current.in_progress)
    push(5, "info", "未収集の日があります", `${current.covered_days}/${current.days_in_month}日分の実績です。記録のない日は0件として扱っていません。`);
  if (current.in_progress)
    push(5, "info", "集計途中の月です", `現時点で${days}日分です。月末後に最新のCSVで置き換えると比較しやすくなります。`);
  if (t.apply_starts == null || t.applies == null)
    push(6, "info", "応募開始数または応募完了数が未取得", "旧管理CSVの「応募」など、定義が不明な値は自動で割り当てていません。");
  if (t.cost != null) {
    const parts = [`掲載費用 ${fmtYen(t.cost)}`];
    if (unitCost(t.cost, t.clicks) != null) parts.push(`クリック単価 ${fmtYen(unitCost(t.cost, t.clicks))}`);
    if (unitCost(t.cost, t.applies) != null) parts.push(`応募単価 ${fmtYen(unitCost(t.cost, t.applies))}`);
    push(5, "info", "費用対効果", parts.join("、") + "。");
  }
  items.sort((a, b) => a.priority - b.priority);
  return { items, trend: comparison?.comparable ? "compared" : "insufficient" };
}

// 外部の詳細分析（ChatGPT等）へ手動で貼り付ける用の月次サマリー。個人情報は含めない。
export function summaryText({ category, current, comparison, previous, analysis, plans }) {
  const t = current.totals;
  const r = current.rates;
  const lines = [
    `【求人マーケティング月次サマリー】${monthLabel(current.month)}／${category.name}／${current.media}`,
    `集計日数：${current.covered_days}/${current.days_in_month}日${current.in_progress ? "（集計途中）" : ""}${current.missing_dates.length ? `　未収集日：${rangesLabel(current.missing_dates)}` : ""}`,
    `掲載種別：${current.plan ? (current.plan === "mixed" ? "混在" : PLAN_TYPES[current.plan]) : "—"}`,
    `表示回数 ${fmtCount(t.impressions)}／クリック数 ${fmtCount(t.clicks)}／応募開始数 ${fmtCount(t.apply_starts)}／応募完了数 ${fmtCount(t.applies)}`,
    `クリック率（CTR） ${fmtRate(r.ctr)}／応募開始率 ${fmtRate(r.asr)}／応募完了率 ${fmtRate(r.completion)}／応募率 ${fmtRate(r.apply_rate)}`,
    `掲載費用 ${t.cost == null ? "未入力" : fmtYen(t.cost)}`,
  ];
  if (previous && comparison?.comparable) {
    const p = previous.totals;
    lines.push(`前月（${monthLabel(previous.month)}）：表示 ${fmtCount(p.impressions)}／クリック ${fmtCount(p.clicks)}／応募開始 ${fmtCount(p.apply_starts)}／応募完了 ${fmtCount(p.applies)}／クリック率（CTR） ${fmtRate(previous.rates.ctr)}`);
  } else if (comparison) {
    lines.push(`前月比較：不可（${comparison.reasons.join("／")}）`);
  }
  if (plans?.comparable) {
    const g = x => `${x.day_count}日・1日あたり表示 ${x.per_day.impressions.toFixed(1)}回・クリック率（CTR） ${fmtRate(x.rates.ctr)}・応募率 ${fmtRate(x.rates.apply_rate)}`;
    lines.push(`無料掲載：${g(plans.free)}`, `有料掲載：${g(plans.paid)}${plans.paid.totals.cost == null ? "" : `・費用 ${fmtYen(plans.paid.totals.cost)}`}`);
  }
  if (current.notes.length) lines.push("改善メモ：", ...current.notes.map(n => `・${periodLabel(n.period_start, n.period_end)} ${n.note.replace(/\s+/g, " ")}`));
  if (analysis?.items?.length) lines.push("自動分析コメント（ルールベース・外部AI不使用）：", ...analysis.items.map(i => `・${i.title}：${i.body}`));
  return lines.join("\n");
}

// ---------- CSV ----------

// UTF-8（BOMあり／なし）を優先し、UTF-8として不正なら CP932（Shift_JIS）として読む
export function decodeCsv(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(data.subarray(3)), encoding: "UTF-8（BOMあり）" };
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
    const le = data[0] === 0xff;
    return { text: new TextDecoder(le ? "utf-16le" : "utf-16be").decode(data.subarray(2)), encoding: "UTF-16" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(data), encoding: "CP932（Shift_JIS）" };
  }
}

// RFC 4180 形式（引用符内の改行・カンマ・"" を扱う）。区切りはカンマ、またはタブ（Indeedの一部出力）
export function parseCsv(textValue) {
  const src = textValue.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] || "";
  const sep = !firstLine.includes(",") && firstLine.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(v => v.replace(/\r\n?/g, "\n")));
}

const cleanHeader = h => String(h ?? "").replace(/^﻿/, "").replace(/\s+/g, "").normalize("NFKC");
const isBlankRow = row => row.every(c => String(c ?? "").trim() === "");

const INDEED_COLUMNS = {
  date: ["日付", "Date"],
  impressions: ["表示回数", "Impressions"],
  clicks: ["クリック数", "Clicks"],
  apply_starts: ["応募開始数", "Applystarts"],
  applies: ["応募数", "Applies"],
  cost: ["費用", "Cost", "Spend"],
  job_id: ["求人ID", "JobID"],
  job_title: ["職種名", "Jobtitle"],
  currency: ["通貨", "Currency"],
};

export function detectFormat(rows) {
  const header = (rows[0] || []).map(cleanHeader);
  const has = names => names.some(n => header.includes(cleanHeader(n)));
  if (has(INDEED_COLUMNS.date) && has(INDEED_COLUMNS.impressions) && has(INDEED_COLUMNS.clicks)) return "indeed";
  const labels = rows.map(r => cleanHeader(r[0]));
  if (labels.some(l => LEGACY_LABELS[l] === "impressions") && (rows[0] || []).slice(1).some(c => parseLegacyPeriod(c))) return "legacy";
  return null;
}

export function fileNamePeriod(fileName) {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})/.exec(fileName || "");
  if (!m) return null;
  const start = `${m[1]}-${m[2]}-${m[3]}`;
  const end = `${m[4]}-${m[5]}-${m[6]}`;
  return isDate(start) && isDate(end) && start <= end ? { start, end } : null;
}

function parseCsvDate(value) {
  const m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return isDate(date) ? date : null;
}

// Indeed「EngagementSummary」形式（日別の行）。求人ID・職種名ごとにまとめ、職種は利用者が指定する
export function parseIndeed(rows, fileName = "") {
  const header = rows[0].map(cleanHeader);
  const col = {};
  for (const [key, names] of Object.entries(INDEED_COLUMNS)) {
    const index = header.findIndex(h => names.some(n => cleanHeader(n) === h));
    col[key] = index >= 0 ? index : null;
  }
  const warnings = [];
  const errors = [];
  const missingColumns = ["apply_starts", "applies", "cost"].filter(k => col[k] == null).map(k => k === "cost" ? "費用" : METRIC_LABELS[k]);
  if (missingColumns.length) warnings.push(`CSVに${missingColumns.join("・")}の列がありません（未取得として扱います）`);
  const groups = new Map();
  let skippedNoDate = 0;
  const currencies = new Set();
  rows.slice(1).forEach((row, i) => {
    if (isBlankRow(row)) return;
    const line = i + 2;
    const rawDate = col.date == null ? "" : row[col.date];
    const date = parseCsvDate(rawDate);
    if (!date) {
      if (String(rawDate ?? "").trim()) errors.push(`${line}行目：日付「${rawDate}」を読み取れません`);
      else skippedNoDate += 1;
      return;
    }
    const jobId = col.job_id == null ? "" : String(row[col.job_id] ?? "").trim();
    const jobTitle = col.job_title == null ? "" : String(row[col.job_title] ?? "").trim();
    if (col.currency != null && String(row[col.currency] ?? "").trim()) currencies.add(String(row[col.currency]).trim());
    const key = `${jobId}\u0000${jobTitle}`;
    if (!groups.has(key)) groups.set(key, { key, job_id: jobId || null, job_title: jobTitle || null, daily: [], dupDates: [] });
    const g = groups.get(key);
    const out = { date };
    for (const metric of METRICS) {
      const parsed = col[metric] == null ? { value: null } : parseCount(row[col[metric]]);
      if (parsed.error) { errors.push(`${line}行目：${METRIC_LABELS[metric]}「${row[col[metric]]}」が0以上の整数ではありません`); out[metric] = null; }
      else out[metric] = parsed.value;
    }
    const cost = col.cost == null ? { value: null } : parseCost(row[col.cost]);
    if (cost.error) { errors.push(`${line}行目：費用「${row[col.cost]}」を読み取れません`); out.cost = null; } else out.cost = cost.value;
    if (g.daily.some(d => d.date === date)) g.dupDates.push(date);
    else g.daily.push(out);
  });
  if (skippedNoDate) warnings.push(`日付のない行（合計行など）${skippedNoDate}行は取り込みません`);
  if ([...currencies].some(c => c.toUpperCase() !== "JPY")) warnings.push(`通貨が円以外の行があります（${[...currencies].join("・")}）。費用の扱いを確認してください`);
  const filePeriod = fileNamePeriod(fileName);
  const list = [...groups.values()].map(g => {
    g.daily.sort((a, b) => a.date.localeCompare(b.date));
    const first = g.daily[0]?.date ?? null;
    const last = g.daily[g.daily.length - 1]?.date ?? null;
    const period = filePeriod && first && filePeriod.start <= first && last <= filePeriod.end ? filePeriod : first ? { start: first, end: last } : null;
    const dates = new Set(g.daily.map(d => d.date));
    const missing = period ? eachDay(period.start, period.end).filter(d => !dates.has(d)) : [];
    const totals = {};
    for (const metric of METRICS) totals[metric] = sumDaily(g.daily, metric);
    totals.cost = g.daily.every(d => d.cost == null) ? null : sumDaily(g.daily, "cost");
    const notes = [];
    if (g.dupDates.length) notes.push(`同じ日付の行が複数あります（${rangesLabel([...new Set(g.dupDates)].sort())}）。合算せず、この求人は取り込めません`);
    for (const metric of METRICS) if (totals[metric] == null && g.daily.some(d => d[metric] != null)) notes.push(`${METRIC_LABELS[metric]}が空欄の日があります（合計は未取得「—」として扱います）`);
    if (g.daily.some(d => d.cost != null) && g.daily.some(d => d.cost == null)) notes.push("費用が一部の日だけ入力されています（合計は未取得として扱います）");
    if (totals.cost == null) notes.push("費用が空欄です（無料・0円とはみなしません）");
    if (missing.length) notes.push(`記録のない日が${missing.length}日あります（${rangesLabel(missing)}）。0件として扱わず、未収集日とします`);
    if (!g.job_id && !g.job_title) notes.push("求人ID・職種名が空欄のため、職種を自動で判定できません。登録先の職種を選択してください");
    return {
      key: g.key, job_id: g.job_id, job_title: g.job_title, daily: g.daily, first_date: first, last_date: last,
      period, file_period: filePeriod, day_count: g.daily.length, missing_dates: missing, totals, rates: rates(totals),
      notes, blocked: g.dupDates.length > 0,
    };
  });
  if (filePeriod && list.some(g => g.first_date && (g.first_date < filePeriod.start || g.last_date > filePeriod.end)))
    warnings.push("ファイル名の期間の外にある日付が含まれています。対象期間を確認してください");
  if (!list.length && !errors.length) errors.push("取り込める日別の行がありません");
  return {
    format: "indeed", groups: list, file_period: filePeriod, warnings, errors,
    definitions: {
      impressions: "Indeed「表示回数」", clicks: "Indeed「クリック数」",
      apply_starts: "Indeed「応募開始数」（応募を開始した数）", applies: "Indeed「応募数」（応募を完了した数）", cost: "Indeed「費用」",
    },
  };
}

// 旧管理CSV（列：集計期間、行：表示・クリック・応募・CTR・クリック→応募・改善案）
const LEGACY_LABELS = {
  表示: "impressions", 表示回数: "impressions", 表示数: "impressions",
  クリック: "clicks", クリック数: "clicks",
  応募: "apply", 応募数: "apply",
  応募開始: "apply_starts", 応募開始数: "apply_starts",
  応募完了: "applies", 応募完了数: "applies",
  CTR: "ctr", クリック率: "ctr", "クリック率(CTR)": "ctr",
  "クリック→応募": "conversion", 応募率: "conversion", "クリック→応募率": "conversion",
  費用: "cost", 掲載費用: "cost",
  改善案: "note", メモ: "note", 改善メモ: "note", 変更内容: "note",
  備考欄: "remarks", 備考: "remarks",
};

// 「9/7～10/7」「10/1~10/19」「2026/9/1～2026/9/30」など。年が無い場合は year: null（推測しない）
export function parseLegacyPeriod(value) {
  const s = String(value ?? "").normalize("NFKC").replace(/\s+/g, "");
  const m = /^(?:(\d{4})[/年])?(\d{1,2})[/月](\d{1,2})日?[~～〜\-ー－]+(?:(\d{4})[/年])?(?:(\d{1,2})[/月])?(\d{1,2})日?$/.exec(s);
  if (!m) return null;
  const [, sy, sm, sd, ey, em, ed] = m;
  const startMonth = Number(sm), startDay = Number(sd), endMonth = em ? Number(em) : Number(sm), endDay = Number(ed);
  if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) return null;
  return { label: String(value).trim(), start_year: sy ? Number(sy) : null, end_year: ey ? Number(ey) : null, start_month: startMonth, start_day: startDay, end_month: endMonth, end_day: endDay };
}

// 利用者が確認した年（開始月の年）から期間を確定する。終了月が開始月より前なら翌年とする
export function resolveLegacyPeriod(p, year) {
  const startYear = p.start_year ?? (Number.isInteger(Number(year)) && Number(year) >= 1000 ? Number(year) : null);
  if (!startYear) return null;
  const endYear = p.end_year ?? (p.end_month < p.start_month ? startYear + 1 : startYear);
  const start = `${startYear}-${pad(p.start_month)}-${pad(p.start_day)}`;
  const end = `${endYear}-${pad(p.end_month)}-${pad(p.end_day)}`;
  return isDate(start) && isDate(end) && start <= end ? { start, end } : null;
}

const parsePercent = value => {
  const s = String(value ?? "").trim().normalize("NFKC");
  if (!s) return null;
  const m = /^(-?\d+(?:\.\d+)?)%?$/.exec(s);
  return m ? Number(m[1]) : null;
};

export function parseLegacy(rows, fileName = "") {
  const header = rows[0] || [];
  const warnings = [];
  const errors = [];
  const columns = [];
  header.forEach((cell, index) => {
    if (index === 0) return;
    const period = parseLegacyPeriod(cell);
    if (period) columns.push({ index, period, impressions: null, clicks: null, apply_raw: null, apply_starts: null, applies: null, cost: null, ctr_raw: null, conversion_raw: null, notes: [], issues: [] });
    else if (String(cell ?? "").trim()) warnings.push(`1行目の「${String(cell).trim()}」は集計期間として読み取れないため取り込みません`);
  });
  if (!columns.length) errors.push("集計期間（例：9/7～10/7）の列が見つかりません");
  const references = [];
  const unmapped = [];
  let inRemarks = false;
  let inReferences = false;
  rows.slice(1).forEach((row, i) => {
    if (isBlankRow(row)) return;
    const line = i + 2;
    const label = cleanHeader(row[0]);
    const kind = LEGACY_LABELS[label];
    if (kind === "remarks") {
      inRemarks = true;
      if (row.slice(1).some(c => /参考求人/.test(String(c)))) inReferences = true;
      return;
    }
    if (!label && inReferences) {
      for (const cell of row.slice(1)) {
        const name = String(cell ?? "").trim();
        if (name && name.length <= LIMITS.company) references.push({ company_name: name, line });
      }
      return;
    }
    if (!kind) {
      // ラベルの無い行・不明な行の文章は、同じ列の集計期間のメモとして保持する
      let kept = false;
      for (const c of columns) {
        const value = String(row[c.index] ?? "").trim();
        if (value) { c.notes.push(label ? `【${String(row[0]).trim()}】${value}` : value); kept = true; }
      }
      const outside = row.map((v, j) => ({ v: String(v ?? "").trim(), j })).filter(({ v, j }) => v && j !== 0 && !columns.some(c => c.index === j));
      if (label && !kept) unmapped.push(`${line}行目「${String(row[0]).trim()}」`);
      if (outside.length) unmapped.push(...outside.map(({ v }) => `${line}行目「${v.slice(0, 30)}」`));
      if (!label && inRemarks && !kept) unmapped.push(`${line}行目`);
      return;
    }
    for (const c of columns) {
      const raw = row[c.index];
      const value = String(raw ?? "").trim();
      if (kind === "note") { if (value) c.notes.push(value); continue; }
      if (kind === "ctr") { c.ctr_raw = value || null; continue; }
      if (kind === "conversion") { c.conversion_raw = value || null; continue; }
      const parsed = kind === "cost" ? parseCost(raw) : parseCount(raw);
      if (parsed.error) { c.issues.push(`${line}行目：「${value}」を数値として読み取れません（未取得として扱います）`); continue; }
      if (kind === "apply") c.apply_raw = parsed.value;
      else c[kind] = parsed.value;
    }
  });
  for (const c of columns) {
    c.note = c.notes.join("\n\n") || null;
    // CSVに記載された率と、件数から再計算した率の差（大きい場合のみ注意）
    const ctrCsv = parsePercent(c.ctr_raw);
    const ctrCalc = rates({ clicks: c.clicks, impressions: c.impressions }).ctr;
    if (ctrCsv != null && ctrCalc != null && Math.abs(ctrCsv - ctrCalc) > 0.5) c.issues.push(`CSVのクリック率（CTR）（${c.ctr_raw}）と件数からの計算値（${fmtRate(ctrCalc)}）が異なります。件数から計算した値を使います`);
    if (c.impressions == null) c.issues.push("表示回数がありません");
    if (c.clicks == null) c.issues.push("クリック数がありません");
  }
  // 同じファイル内で期間が重なる列（年は未確定でも月日で判定）
  const md = p => [p.start_month * 100 + p.start_day, (p.end_month < p.start_month ? p.end_month + 12 : p.end_month) * 100 + p.end_day];
  for (let a = 0; a < columns.length; a += 1) for (let b = a + 1; b < columns.length; b += 1) {
    const [as, ae] = md(columns[a].period), [bs, be] = md(columns[b].period);
    if (as <= be && bs <= ae) warnings.push(`「${columns[a].period.label}」と「${columns[b].period.label}」は期間が重なっています。合算はしません。どちらを登録するか選んでください`);
  }
  if (unmapped.length) warnings.push(`取り込み先が無い内容があります：${unmapped.slice(0, 5).join("、")}${unmapped.length > 5 ? " ほか" : ""}`);
  const needsYear = columns.some(c => c.period.start_year == null);
  const hasApply = columns.some(c => c.apply_raw != null);
  return {
    format: "legacy", columns, references, warnings, errors, needs_year: needsYear, has_ambiguous_apply: hasApply,
    suggested_category: suggestLegacyCategory(fileName),
  };
}

// ファイル名の末尾（「… - CADときがわ.csv」）から職種名の候補を返す（確定はしない）
export function suggestLegacyCategory(fileName) {
  const m = /-\s*([^-\\/]+?)\.csv$/i.exec(fileName || "");
  return m ? m[1].trim() : null;
}
export function matchCategory(categories, hint) {
  if (!hint) return null;
  const h = normalizeName(hint).replace(/[()（）\s]/g, "");
  const exact = categories.find(c => normalizeName(c.name).replace(/[()（）\s]/g, "") === h);
  if (exact) return exact;
  // 「CADときがわ」→「CADオペ（ときがわ）」のように、候補の文字がすべて順に含まれる職種が1つだけなら候補にする
  const loose = categories.filter(c => {
    const name = normalizeName(c.name).replace(/[()（）\s]/g, "");
    let pos = 0;
    for (const ch of h) { pos = name.indexOf(ch, pos); if (pos < 0) return false; pos += 1; }
    return true;
  });
  return loose.length === 1 ? loose[0] : null;
}

// 旧管理CSVの1列を登録用の実績にする。apply_mapping: apply_starts / applies / unknown（利用者が選択）
export function legacyColumnRecord(column, { categoryId, year, applyMapping, planType, media = DEFAULT_MEDIA }) {
  const period = resolveLegacyPeriod(column.period, year);
  if (!period) return null;
  const record = {
    category_id: categoryId, media, period_start: period.start, period_end: period.end, plan_type: planType,
    impressions: column.impressions, clicks: column.clicks,
    apply_starts: column.apply_starts, applies: column.applies, cost: column.cost, note: column.note, source: "legacy_csv",
  };
  if (column.apply_raw != null) {
    if (applyMapping === "apply_starts" && record.apply_starts == null) record.apply_starts = column.apply_raw;
    if (applyMapping === "applies" && record.applies == null) record.applies = column.apply_raw;
  }
  record.source_meta = {
    column_label: column.period.label,
    year_confirmed: column.period.start_year == null ? Number(year) : null,
    apply_mapping: column.apply_raw == null ? null : applyMapping,
    raw: { apply: column.apply_raw, ctr: column.ctr_raw, conversion: column.conversion_raw },
    definitions: {
      apply: column.apply_raw == null ? null
        : applyMapping === "apply_starts" ? "旧CSV「応募」を応募開始数として登録"
          : applyMapping === "applies" ? "旧CSV「応募」を応募完了数として登録" : "旧CSV「応募」は定義不明のため未割当（元の値のみ保持）",
    },
  };
  return record;
}

// Indeed CSV の求人ごとのまとまりを求人原稿として識別するキー（求人ID優先、無ければ職種名）。どちらも無ければ null（職種全体の記録）
export function postingOf(group) {
  const jobId = text(group?.job_id).slice(0, LIMITS.title);
  const title = text(group?.job_title).slice(0, LIMITS.title);
  if (!jobId && !title) return null;
  return { key: jobId ? `id:${jobId}` : `title:${title}`, job_id: jobId || null, title: title || null };
}
