// CSV取込（Indeed公式形式・旧管理CSV）。形式はファイル名ではなく中身で判定し、取込前に内容を確認してから登録する。
// 職種・年・「応募」の意味など、CSVから確定できない情報は推測せず利用者が選ぶ（候補は表示するが自動では選ばない）。
// 重複・期間の重なりは入力がそろった時点でサーバーに確認（dry_run）し、問題が無いときだけ取り込める。
// Indeed「JobsCampaigns」（求人ごとの期間合計）は、職種・期間・主要数値を確認して登録する。同じ求人・同じ期間の既存実績は
// 「上書きしますか？」の確認だけで置き換え、同じ記録と断定できないもの（職種全体の記録・期間が異なる記録）だけ対象と理由を示して選ばせる。
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MEDIA, PLAN_TYPES, decodeCsv, detectFormat, eachDay, fmtCount, fmtRate, fmtYen, isDate, isFullMonth, jobsPostingRecord, legacyColumnRecord,
  matchCategory, parseCsv, parseIndeed, parseIndeedJobs, parseLegacy, periodLabel, planResolver, postingOf, rangesLabel, rates, relatedRecords,
  resolveLegacyPeriod, safeUrl, scopeMismatch, slashDate, suggestJobsCategory, unitCost,
} from "../../../shared/jobMarketing.mjs";
import { ConflictResolver, MIN_DATE, MAX_DATE, Modal, Segmented, Tip } from "./MarketingForms";
import { marketingApi, sha256Hex, errorText } from "./marketingApi";

const noResolve = () => ({ replace_ids: [], allow_overlap: false, overlap_reason: "" });
const planOptions = Object.entries(PLAN_TYPES);
const PREVIEW_ROWS = 8;

function CategorySelect({ categories, value, onChange, label }) {
  return (
    <select className={value ? "" : "is-required"} value={value} onChange={e => onChange(e.target.value)} aria-label={label} aria-required="true">
      <option value="">選択してください</option>
      {categories.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : "（停止中）"}</option>)}
    </select>
  );
}

// 候補の職種（CSV内の職種名・ファイル名から）。押したときだけ選ぶ
function Suggest({ category, from, onPick }) {
  if (!category) return null;
  return <button type="button" className="jm-suggest" onClick={() => onPick(category.id)}>候補：{category.name}<small>（{from}）</small></button>;
}

const Totals = ({ t }) => {
  const r = rates(t);
  return (
    <div className="jm-totals">
      <span>表示 <b>{fmtCount(t.impressions)}</b></span><span>クリック <b>{fmtCount(t.clicks)}</b></span>
      <span>応募開始 <b>{fmtCount(t.apply_starts)}</b></span><span>応募 <b>{fmtCount(t.applies)}</b></span>
      <span>クリック率（CTR） <b>{fmtRate(r.ctr)}</b></span>
    </div>
  );
};

const FORMAT_LABELS = { indeed: "Indeed形式（日別）", indeed_jobs: "Indeed形式（求人別・期間合計）", legacy: "旧管理表" };

// JobsCampaigns の主要数値（件数・率は件数から計算・費用は0円と未取得を区別）
function JobsNumbers({ t }) {
  const r = rates(t);
  const cells = [
    ["表示回数", fmtCount(t.impressions)], ["クリック数", fmtCount(t.clicks)], ["応募開始数", fmtCount(t.apply_starts)], ["応募完了数", fmtCount(t.applies)],
  ];
  const rateCells = [
    ["クリック率（CTR）", fmtRate(r.ctr, 2)], ["応募開始率", fmtRate(r.asr, 2)], ["応募完了率", fmtRate(r.completion, 2)], ["応募率", fmtRate(r.apply_rate, 2)],
    ["費用", t.cost == null ? "未取得" : fmtYen(t.cost)], ["応募単価", fmtYen(unitCost(t.cost, t.applies))],
  ];
  return (
    <div className="jm-jobs-nums">
      <div className="jm-jobs-counts">{cells.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
      <div className="jm-jobs-rates">{rateCells.map(([k, v]) => <span key={k}>{k} <b>{v}</b></span>)}</div>
    </div>
  );
}

const VALUE_COLUMNS = [["impressions", "表示回数"], ["clicks", "クリック数"], ["apply_starts", "応募開始数"], ["applies", "応募完了数"]];
const costText = v => v == null ? "未取得" : fmtYen(v);

// 上書き確認（JobsCampaigns）。現在の記録と新しいCSVの値を並べ、置き換え対象を示す。
// 同じ求人・同じ期間の記録は自動で対象。同じ記録と断定できない記録だけチェック欄で選ぶ（理由を表示）
function OverwriteConfirm({ items, onPick }) {
  return (
    <div className="jm-overwrite" role="alert">
      <strong className="jm-overwrite-title">既存データがあります。上書きしますか？</strong>
      {items.map(({ i, name, reference, category, period, totals, plan }) => (
        <div key={i} className="jm-overwrite-item">
          <p className="jm-overwrite-head"><b>{category}</b>・{name}{reference ? `（参照番号 ${reference}）` : ""}・{period}
            <span className="jm-chip is-warn">置き換え {plan.related.filter(r => r.checked).length}件</span></p>
          <div className="jm-table-wrap">
            <table className="jm-table jm-overwrite-table">
              <thead><tr><th></th><th>集計期間</th>{VALUE_COLUMNS.map(([, l]) => <th key={l}>{l}</th>)}<th>費用</th></tr></thead>
              <tbody>
                {plan.related.map(({ id, record: r, exact, mismatch, reason, checked }) => (
                  <tr key={id} className={checked ? "is-replace" : "is-keep"}>
                    <td>
                      {exact ? <span className="jm-chip">現在 #{id}</span> : plan.related.find(x => x.id === id)?.claimedBy ? <span className="jm-chip is-muted">#{id}</span> : (
                        <label className="jm-check"><input type="checkbox" checked={checked} onChange={e => onPick(i, id, e.target.checked)} aria-label={`#${id}を置き換える`} />#{id}</label>
                      )}
                    </td>
                    <td>{periodLabel(r.period_start, r.period_end)}</td>
                    {VALUE_COLUMNS.map(([k]) => <td key={k}>{fmtCount(r[k])}</td>)}<td>{costText(r.cost)}</td>
                  </tr>
                ))}
                <tr className="is-new"><td><span className="jm-chip is-ok">新しいCSV</span></td><td>{period}</td>
                  {VALUE_COLUMNS.map(([k]) => <td key={k}><b>{fmtCount(totals[k])}</b></td>)}<td><b>{costText(totals.cost)}</b></td></tr>
              </tbody>
            </table>
          </div>
          {plan.related.filter(r => !r.exact).map(r => (
            <p key={r.id} className={`jm-sub${r.mismatch ? " is-alert" : ""}`}>#{r.id}：{r.reason}{r.checked || r.claimedBy ? "" : r.kind === "spanning" ? "（置き換えずに残します。月別の合計には含まれません）" : "（置き換えずに残すと、この期間は記録が重なるため、月別の合計に反映されません）"}</p>
          ))}
        </div>
      ))}
      <p className="jm-sub">置き換えた記録は削除せず、履歴に残ります。月別の集計には新しい実績だけを使います。</p>
    </div>
  );
}

// 掲載状態の履歴から、期間内の掲載種別を求める（free / paid / split（途中で変更）/ null（履歴なし））
function historyPlan(planAt, categoryId, postingId, dates) {
  if (!categoryId || !dates.length) return { plan: null };
  const byDate = dates.map(d => ({ d, s: planAt(categoryId, postingId, d)?.status }));
  const known = byDate.filter(x => x.s === "free" || x.s === "paid");
  if (known.length !== byDate.length) return { plan: null };
  const kinds = [...new Set(known.map(x => x.s))];
  if (kinds.length === 1) return { plan: kinds[0] };
  const label = ["free", "paid"].map(k => `${rangesLabel(byDate.filter(x => x.s === k).map(x => x.d))} ${PLAN_TYPES[k]}`).join("／");
  return { plan: "split", label };
}

// initialFile: 確認待ちのCSV（ローカルプレビュー）。{ name, base64 } を開いた直後に読み込む
export default function CsvImport({ categories, records, postings = [], planEvents = [], imports = [], initialFile = null, onClose, onDone }) {
  const [file, setFile] = useState(null); // { name, hash, encoding, format, parsed, rows, raw }
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [groups, setGroups] = useState([]); // Indeed: 求人ごとの登録設定
  const [legacy, setLegacy] = useState(null); // 旧CSV: 共通設定と列ごとの設定
  const [jobs, setJobs] = useState([]); // JobsCampaigns: 求人ごとの登録設定
  const [refs, setRefs] = useState([]);
  const [resolves, setResolves] = useState({});
  const [check, setCheck] = useState({ key: null, problems: [], error: "" });
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const planAt = useMemo(() => planResolver(planEvents), [planEvents]);

  const postingIdOf = (g, categoryId) => {
    const p = postingOf(g);
    const found = p && postings.find(x => x.media === DEFAULT_MEDIA && x.external_key === p.key);
    return found && String(found.category_id) === String(categoryId) ? found.id : null;
  };

  async function load(f) {
    setError(""); setFile(null); setResolves({}); setGroups([]); setLegacy(null); setRefs([]); setJobs([]);
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setError("CSVが大きすぎます（2MBまで）"); return; }
    const buffer = await f.arrayBuffer();
    const { text, encoding } = decodeCsv(new Uint8Array(buffer));
    const rows = parseCsv(text);
    const format = detectFormat(rows);
    if (!format) { setError("CSVの形式を判定できませんでした。Indeedのレポート（日付・表示回数・クリック数の列、または参照番号・表示回数・クリック数の列）か、旧管理表（表示の行と集計期間の列）を選んでください。"); return; }
    const hash = await sha256Hex(buffer);
    const raw = rows.filter(r => r.some(c => String(c).trim())).slice(0, PREVIEW_ROWS + 1);
    if (format === "indeed_jobs") {
      // 生の行は保持しない（連絡先などの列を画面にも出さない）。集計期間はファイル名の期間を初期値にし、確認は利用者が行う
      const parsed = parseIndeedJobs(rows, f.name);
      setJobs(parsed.postings.map(pj => {
        const start = parsed.file_period?.start ?? "";
        const end = parsed.file_period?.end ?? "";
        const known = knownPosting(pj);
        const plan = known ? defaultPlan(known, start, end) : { plan_type: "", plan_from: null };
        return {
          include: !pj.blocked, category_id: known ? String(known.category_id) : "", category_from: known ? "posting" : null,
          period_start: start, period_end: end, period_confirmed: false, posting_start: "", note: "", picks: {}, ...plan,
        };
      }));
      setFile({ name: f.name, hash, encoding, format, parsed, rows: rows.length - 1, raw: null });
    } else if (format === "indeed") {
      const parsed = parseIndeed(rows, f.name);
      setGroups(parsed.groups.map(g => ({
        include: !g.blocked, category_id: "", period_start: g.period?.start ?? "", period_end: g.period?.end ?? "", plan_type: "", plan_touched: false, note: "",
      })));
      setFile({ name: f.name, hash, encoding, format, parsed, rows: rows.length - 1, raw });
    } else {
      const parsed = parseLegacy(rows, f.name);
      setLegacy({ category_id: "", apply_mapping: "", columns: parsed.columns.map(c => ({ include: true, year: c.period.start_year ? String(c.period.start_year) : "", plan_type: "", plan_touched: false })) });
      setRefs(parsed.references.map(r => ({ ...r, include: true })));
      setFile({ name: f.name, hash, encoding, format, parsed, rows: rows.length - 1, raw });
    }
  }

  useEffect(() => {
    if (!initialFile) return;
    const bytes = Uint8Array.from(atob(initialFile.base64), c => c.charCodeAt(0));
    Promise.resolve().then(() => load(new File([bytes], initialFile.name, { type: "text/csv" })));
  }, [initialFile]);

  const p = file?.parsed;
  // 職種を選んだとき、掲載種別が未選択なら掲載状態の履歴から初期値を入れる
  const updateGroup = (i, patch) => setGroups(list => list.map((g, j) => {
    if (j !== i) return g;
    const next = { ...g, ...patch };
    if (patch.plan_type) next.plan_touched = true;
    if (!next.plan_touched && (patch.category_id !== undefined || patch.period_start !== undefined || patch.period_end !== undefined)) {
      const pg = p.groups[i];
      const h = historyPlan(planAt, next.category_id, postingIdOf(pg, next.category_id), pg.daily.map(d => d.date));
      next.plan_type = h.plan === "split" ? "unknown" : h.plan || "";
    }
    return next;
  }));
  const columnDates = (c, s) => { const period = resolveLegacyPeriod(c.period, s.year); return period ? eachDay(period.start, period.end) : []; };
  const updateLegacy = patch => setLegacy(l => {
    const next = { ...l, ...patch };
    if (patch.category_id !== undefined || patch.columns) {
      next.columns = next.columns.map((s, j) => {
        if (s.plan_touched) return s;
        const h = historyPlan(planAt, next.category_id, null, columnDates(p.columns[j], s));
        return { ...s, plan_type: h.plan === "free" || h.plan === "paid" ? h.plan : s.plan_type };
      });
    }
    return next;
  });
  const updateColumn = (i, patch) => updateLegacy({ columns: legacy.columns.map((c, j) => j === i ? { ...c, ...patch, ...(patch.plan_type ? { plan_touched: true } : {}) } : c) });
  // 職種・期間を変えたら、期間の確認と置き換えの選択をやり直す（変更前の条件で選んだ対象を、見えないまま送らない）
  // 掲載種別を自動で入れた場合（plan_from あり）は、期間を変えたら初期値を求め直す。利用者が選んだ掲載種別はそのまま
  const updateJob = (i, patch) => {
    const periodChanged = patch.period_start !== undefined || patch.period_end !== undefined;
    const scopeChanged = periodChanged || patch.category_id !== undefined;
    setJobs(list => list.map((s, j) => {
      if (j !== i) return s;
      const next = {
        ...s, ...patch,
        ...(periodChanged ? { period_confirmed: false } : {}),
        ...(patch.category_id !== undefined ? { category_from: null } : {}),
        ...(patch.plan_type !== undefined ? { plan_from: null } : {}),
        ...(scopeChanged ? { picks: {} } : {}),
      };
      if (periodChanged && patch.plan_type === undefined && (s.plan_from || !s.plan_type)) Object.assign(next, defaultPlan(knownPosting(p.postings[i]), next.period_start, next.period_end));
      return next;
    }));
  };
  const pickJob = (i, id, checked) => setJobs(list => list.map((s, j) => j !== i ? s : { ...s, picks: { ...s.picks, [id]: checked } }));
  const jobPosting = pj => ({ job_id: pj.reference, job_title: pj.title });
  function knownPosting(pj) {
    const key = postingOf(jobPosting(pj))?.key;
    return key ? postings.find(x => x.media === DEFAULT_MEDIA && x.external_key === key) || null : null;
  }
  // 掲載種別の初期値：掲載状態の履歴で期間全体が無料／有料なら履歴から、無ければ同じ求人の直前の記録から（変更できる）
  // 優先順：同じ期間の記録（上書き対象）→ 掲載状態の履歴（期間全体が無料／有料）→ 対象期間より前の記録。後の月の記録からは推測しない
  function defaultPlan(known, start, end) {
    if (!known || !isDate(start) || !isDate(end) || start > end) return { plan_type: "", plan_from: null };
    const same = records.find(r => String(r.posting_id) === String(known.id) && r.period_start === start && r.period_end === end);
    if (same) return { plan_type: same.plan_type, plan_from: "上書き前の記録" };
    const h = historyPlan(planAt, known.category_id, known.id, eachDay(start, end));
    if (h.plan === "free" || h.plan === "paid") return { plan_type: h.plan, plan_from: "掲載状態の履歴" };
    const prev = isDate(start) ? records.filter(r => String(r.posting_id) === String(known.id) && r.period_end < start).sort((a, b) => b.period_end.localeCompare(a.period_end))[0] : null;
    return prev ? { plan_type: prev.plan_type, plan_from: `前回（${periodLabel(prev.period_start, prev.period_end)}）` } : { plan_type: "", plan_from: null };
  }
  // このCSVで登録済みか（同じ原稿・現在の対象期間・同じファイル由来の有効な記録がある）。期間を変えるたびに判定し直す
  const sameFileIds = new Set(file ? imports.filter(x => x.file_hash === file.hash).map(x => String(x.id)) : []);
  function alreadyOf(pj, s) {
    const known = knownPosting(pj);
    return Boolean(known && s) && records.some(r => sameFileIds.has(String(r.import_id)) && String(r.posting_id) === String(known.id)
      && r.period_start === s.period_start && r.period_end === s.period_end);
  }
  // 取込全体の置き換え計画（求人の並び順に、先の求人が置き換える旧記録を後の求人では対象から外す）
  function jobPlans() {
    const claimed = new Map();
    return (p?.postings || []).map((pj, i) => {
      const s = jobs[i];
      if (!s?.include || pj.blocked || alreadyOf(pj, s) || !s.category_id || !isDate(s.period_start) || !isDate(s.period_end) || s.period_end < s.period_start) return null;
      const plan = jobPlan(pj, s, claimed);
      for (const id of plan.replaceIds) claimed.set(id, pj.title || pj.reference || "求人");
      return plan;
    });
  }
  // 期間がファイル名の期間と同じなら、登録・上書きの操作で確認したものとする（違う場合だけ確認のチェックを求める）
  const periodOk = (s) => s.period_confirmed || Boolean(p?.file_period && s.period_start === p.file_period.start && s.period_end === p.file_period.end);
  // 置き換え計画：同じ求人・同じ期間の記録は自動で対象。同じ記録と断定できない記録は理由を示し、
  // 旧記録の方が数値が大きい（集計対象が異なる可能性）ものは未選択から、それ以外は置き換えを提案（選択済み）から始める
  const rank = r => r.exact ? 0 : r.kind === "spanning" ? 2 : 1;
  function jobPlan(pj, s, claimed = new Map()) {
    const postingId = postingIdOf(jobPosting(pj), s.category_id);
    const period = { start: s.period_start, end: s.period_end };
    const related = relatedRecords(records, { categoryId: s.category_id, periodStart: s.period_start, periodEnd: s.period_end, postingId }).map(x => {
      const r = x.record;
      const exact = postingId != null && String(r.posting_id) === String(postingId) && x.kind === "same_period";
      const mismatch = !exact && r.posting_id == null && scopeMismatch(r, pj.totals, period);
      const reason = exact ? "" : [
        r.posting_id == null ? "求人原稿の指定がない記録（職種全体の合計の可能性）" : "同じ求人原稿",
        x.kind === "spanning" ? `期間が異なります（${periodLabel(r.period_start, r.period_end)}）。置き換える場合は記録全体が対象です（日割りしません）`
          : x.kind === "partial" ? "月の途中までの記録" : "同じ期間",
        mismatch ? `旧記録の方が多い（表示 ${fmtCount(r.impressions)}→${fmtCount(pj.totals.impressions)}、クリック ${fmtCount(r.clicks)}→${fmtCount(pj.totals.clicks)}）。集計対象が異なる可能性があるため、確認してから選んでください` : null,
      ].filter(Boolean).join("・");
      const by = claimed.get(x.id);
      if (by) return { ...x, exact: false, mismatch: false, reason: `この取込の「${by}」で置き換えます`, checked: false, claimedBy: by };
      const checked = exact || (s.picks[x.id] ?? !mismatch);
      return { ...x, exact, mismatch, reason, checked };
    });
    return {
      postingId, related,
      // 先頭の記録が「置換済み」、2件目以降は「この記録で置き換え」の取消になる。同じ記録→期間内の途中実績→期間外にはみ出す記録の順
      replaceIds: related.filter(r => r.checked).sort((x, y) => rank(x) - rank(y)).map(r => r.id),
      kept: related.filter(r => !r.checked && !r.claimedBy).map(r => r.id),
      scopeConfirmed: related.some(r => r.mismatch && r.checked),
    };
  }

  // 登録内容（entries の index と画面の行を対応づける）
  function build() {
    const issues = [];
    const entries = [];
    const rowsOfEntry = [];
    if (!file) return { issues: ["CSVを選択してください"], entries, rowsOfEntry, references: [] };
    if (file.format === "indeed_jobs") {
      const plans = jobPlans();
      p.postings.forEach((pj, i) => {
        const s = jobs[i];
        if (!s?.include || pj.blocked || alreadyOf(pj, s)) return;
        const name = pj.title || pj.reference || "求人";
        if (!s.category_id) issues.push(`${name}：取込先の職種を選択してください`);
        if (!isDate(s.period_start) || !isDate(s.period_end)) issues.push(`${name}：集計期間を入力してください`);
        else if (s.period_end < s.period_start) issues.push(`${name}：集計期間の終了日は開始日以降にしてください`);
        else if (!periodOk(s)) issues.push(`${name}：集計期間を確認してチェックしてください`);
        if (!s.plan_type) issues.push(`${name}：掲載種別（無料／有料／不明）を選択してください`);
        if (s.posting_start && !isDate(s.posting_start)) issues.push(`${name}：掲載開始日は正しい日付で入力してください`);
        else if (s.posting_start && isDate(s.period_end) && s.posting_start > s.period_end) issues.push(`${name}：掲載開始日が集計期間の終了日より後です`);
        if (pj.totals.cost != null && pj.currency && pj.currency.toUpperCase() !== "JPY") issues.push(`${name}：通貨が円以外（${pj.currency}）の費用は取り込めません`);
        const plan = plans[i] || { replaceIds: [], kept: [], scopeConfirmed: false };
        const rec = jobsPostingRecord(pj, {
          categoryId: s.category_id, periodStart: s.period_start, periodEnd: s.period_end, planType: s.plan_type, postingStart: s.posting_start,
          periodConfirmed: periodOk(s), scopeConfirmed: plan.scopeConfirmed, note: s.note, filePeriod: p.file_period,
        });
        entries.push({
          ...rec, replace_ids: plan.replaceIds, allow_overlap: plan.kept.length > 0,
          overlap_reason: plan.kept.length ? `上書き時に置き換えずに残した記録（${plan.kept.map(id => "#" + id).join("、")}）` : "",
        });
        rowsOfEntry.push(i);
      });
    } else if (file.format === "indeed") {
      p.groups.forEach((g, i) => {
        const s = groups[i];
        if (!s?.include) return;
        const name = g.job_title || g.job_id || "求人";
        if (!s.category_id) issues.push(`${name}：取込先の職種を選択してください`);
        if (!s.period_start || !s.period_end) issues.push(`${name}：集計期間を入力してください`);
        else if (g.daily.some(d => d.date < s.period_start || d.date > s.period_end)) issues.push(`${name}：集計期間の外にある日付が含まれています`);
        if (!s.plan_type) issues.push(`${name}：掲載種別（無料／有料／不明）を選択してください`);
        const posting = postingOf(g);
        entries.push({
          record: {
            category_id: s.category_id, media: DEFAULT_MEDIA, period_start: s.period_start, period_end: s.period_end, plan_type: s.plan_type, note: s.note,
            daily: g.daily, source_meta: { definitions: p.definitions, job_id: g.job_id, job_title: g.job_title, file_period: g.file_period, csv_days: g.day_count },
          },
          ...(posting ? { posting: { job_id: g.job_id, job_title: g.job_title } } : {}),
          ...(resolves[i] || noResolve()),
        });
        rowsOfEntry.push(i);
      });
    } else {
      if (!legacy.category_id) issues.push("取込先の職種を選択してください");
      if (p.has_ambiguous_apply && !legacy.apply_mapping) issues.push("「応募」の意味を選択してください");
      p.columns.forEach((c, i) => {
        const s = legacy.columns[i];
        if (!s.include) return;
        if (!resolveLegacyPeriod(c.period, s.year)) { issues.push(`「${c.period.label}」の年（西暦4桁）を入力してください`); return; }
        if (!s.plan_type) issues.push(`「${c.period.label}」の掲載種別を選択してください`);
        const record = legacyColumnRecord(c, { categoryId: legacy.category_id, year: s.year, applyMapping: legacy.apply_mapping || "unknown", planType: s.plan_type, media: DEFAULT_MEDIA });
        entries.push({ record, ...(resolves[i] || noResolve()) });
        rowsOfEntry.push(i);
      });
    }
    if (!entries.length) issues.push(file.format === "indeed_jobs" && jobs.length && jobs.some((x, j) => alreadyOf(p.postings[j], x)) && jobs.every((x, j) => alreadyOf(p.postings[j], x) || p.postings[j].blocked) ? "このCSVは登録済みです（変更はありません）" : "取り込む行を1件以上選択してください");
    const references = file.format === "legacy" ? refs.filter(r => r.include).map(r => ({ category_id: legacy.category_id, company_name: r.company_name, memo: "旧管理CSVの備考欄（参考求人）から取込" })) : [];
    return { issues, entries, rowsOfEntry, references };
  }

  const built = build();
  const blocked = !file || p.errors.length > 0;
  const payload = blocked || built.issues.length ? null : { file_name: file.name, file_hash: file.hash, format: file.format, entries: built.entries, references: built.references };
  const key = payload ? JSON.stringify(payload) : null;

  // 入力がそろったら重複・期間の重なりを自動で確認する
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const timer = setTimeout(async () => {
      const res = await marketingApi.importCsv({ ...JSON.parse(key), dry_run: true });
      if (!alive) return;
      if (res.ok) setCheck({ key, problems: res.data.problems || [], error: "" });
      else setCheck({ key, problems: [], error: errorText(res, "重複を確認できませんでした") });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [key]);

  const current = check.key === key ? check : null;
  const problems = (current?.problems || []).map(x => ({ ...x, row: x.index == null ? null : built.rowsOfEntry[x.index] }));
  const ready = Boolean(key && current && !current.error && problems.length === 0);
  const problemFor = i => problems.find(x => x.row === i);
  const fileProblems = problems.filter(x => x.row == null);

  // 上書き確認に出す求人（取り込む求人のうち、期間が重なる既存実績があるもの）
  const allPlans = file?.format === "indeed_jobs" ? jobPlans() : [];
  const overwriteItems = file?.format === "indeed_jobs" ? p.postings.map((pj, i) => {
    const s = jobs[i];
    const plan = allPlans[i];
    if (!plan) return null;
    if (!plan.related.length) return null;
    return { i, name: pj.title || "求人名なし", reference: pj.reference, category: categories.find(c => String(c.id) === String(s.category_id))?.name || "",
      period: periodLabel(s.period_start, s.period_end), totals: pj.totals, plan };
  }).filter(Boolean) : [];

  async function submit() {
    setError("");
    setBusy(true);
    const res = await marketingApi.importCsv(payload);
    setBusy(false);
    if (res.ok) { onDone(res.data); return; }
    if (res.status === 409) setCheck({ key, problems: res.data?.problems || [], error: "" });
    setError(errorText(res, "取り込めませんでした"));
  }

  const onDrop = e => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) load(f);
  };
  const changeResolve = (i, v) => setResolves(r => ({ ...r, [i]: v }));

  return (
    <Modal title="CSV取込" onClose={onClose} wide>
      {!file ? (
        <div className={`jm-drop${dragging ? " is-over" : ""}`} data-testid="csv-drop"
          onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 15v4h14v-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <strong>CSVをここにドラッグ＆ドロップ</strong>
          <button type="button" className="jm-btn is-primary" onClick={() => inputRef.current?.click()}>ファイルを選択</button>
          <span className="jm-sub">Indeedのレポート（日別・求人別）／旧管理表（UTF-8・Shift_JIS）</span>
        </div>
      ) : (
        <div className="jm-filebar">
          <strong className="jm-filename">{file.name}</strong>
          <span className="jm-chip">{FORMAT_LABELS[file.format]}</span>
          <span className="jm-chip">{file.encoding}</span>
          <span className="jm-chip">{file.rows}行</span>
          <button type="button" className="jm-btn is-small" onClick={() => { setFile(null); setError(""); }}>別のファイル</button>
        </div>
      )}
      <input ref={inputRef} type="file" accept=".csv,text/csv" hidden aria-label="CSVファイルを選択" onChange={e => { load(e.target.files?.[0]); e.target.value = ""; }} />

      {p && (p.errors.length > 0 || p.warnings.length > 0) && (
        <ul className="jm-warn">
          {p.errors.map(w => <li key={w} className="is-error">{w}</li>)}
          {p.warnings.map(w => <li key={w}>{w}</li>)}
        </ul>
      )}

      {file?.raw && (
        <details className="jm-fold jm-raw" open>
          <summary>内容プレビュー<small>先頭{Math.min(PREVIEW_ROWS, file.raw.length - 1)}行</small></summary>
          <div className="jm-table-wrap">
            <table className="jm-table is-raw">
              <thead><tr>{file.raw[0].map((h, i) => <th key={i}>{String(h).slice(0, 24)}</th>)}</tr></thead>
              <tbody>{file.raw.slice(1).map((row, i) => <tr key={i}>{file.raw[0].map((_, j) => <td key={j}>{String(row[j] ?? "").replace(/\s+/g, " ").slice(0, 24)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
      )}

      {file?.format === "indeed_jobs" && (
        <details className="jm-fold">
          <summary>CSVの列<small>取り込む {p.columns.used.length}列・取り込まない {p.columns.ignored.length + p.columns.sensitive.length}列</small></summary>
          <p className="jm-sub"><b>取り込む：</b>{p.columns.used.join("、") || "—"}</p>
          {p.columns.ignored.length > 0 && <p className="jm-sub"><b>取り込まない：</b>{p.columns.ignored.join("、")}</p>}
          {p.columns.sensitive.length > 0 && <p className="jm-sub"><b>保存しない（連絡先など・値は表示しません）：</b>{p.columns.sensitive.join("、")}</p>}
          <p className="jm-sub">表示する率は件数から計算します（CSVの率は照合のために保持します）。企業名は確認用の表示のみで保存しません。</p>
        </details>
      )}
      {file?.format === "indeed_jobs" && p.postings.length > 1 && (
        <p className="jm-notice">このCSVには{p.postings.length}件の求人が含まれます。求人ごとに取込先の職種を選んでください。</p>
      )}
      {file?.format === "indeed_jobs" && p.postings.map((pj, i) => {
        const s = jobs[i];
        if (!s) return null;
        const prob = problemFor(i);
        const hint = suggestJobsCategory(categories, pj);
        const url = safeUrl(pj.url);
        const fullMonth = isFullMonth(s.period_start, s.period_end);
        const fromFile = Boolean(p.file_period && s.period_start === p.file_period.start && s.period_end === p.file_period.end);
        return (
          <section key={`${pj.key}-${pj.line}`} className={`jm-import-card jm-jobs-card${s.include && !pj.blocked ? "" : " is-off"}`}>
            <header>
              {p.postings.length > 1 && <input type="checkbox" aria-label="この求人を取り込む" checked={s.include && !pj.blocked && !alreadyOf(pj, s)} disabled={pj.blocked || alreadyOf(pj, s)} onChange={e => updateJob(i, { include: e.target.checked })} />}
              <strong>{pj.title || "求人名なし"}</strong>
              {pj.reference && <span className="jm-sub">参照番号 {pj.reference}</span>}
              {pj.blocked && <span className="jm-chip is-alert">取り込めません</span>}
              {alreadyOf(pj, s) && <span className="jm-chip is-ok">このCSVで登録済み（変更なし）</span>}
            </header>
            {!pj.blocked && (
              <div className="jm-jobs-keys">
                <label><span>対象職種<span className="jm-req">必須</span></span>
                  <CategorySelect categories={categories} value={s.category_id} label="対象職種" onChange={v => updateJob(i, { category_id: v })} />
                  {s.category_from === "posting" && <small className="jm-sub">登録済みの求人のため同じ職種</small>}
                  {!s.category_id && <Suggest category={hint} from="求人名・勤務地" onPick={v => updateJob(i, { category_id: v })} />}
                </label>
                <label><span>対象期間{fullMonth ? <span className="jm-chip is-ok">月間合計</span> : isDate(s.period_start) && isDate(s.period_end) ? <span className="jm-chip is-warn">月の途中</span> : null}</span>
                  <span className="jm-period-inputs">
                    <input type="date" min={MIN_DATE} max={MAX_DATE} value={s.period_start} aria-label="集計開始日" onChange={e => updateJob(i, { period_start: e.target.value })} />
                    〜<input type="date" min={MIN_DATE} max={MAX_DATE} value={s.period_end} aria-label="集計終了日" onChange={e => updateJob(i, { period_end: e.target.value })} />
                  </span>
                </label>
                <div><span className="jm-field-label">掲載種別<span className="jm-req">必須</span><Tip text="費用が0円でも、無料掲載とは自動で判定しません。" /></span>
                  <Segmented name={`jplan-${i}`} label="掲載種別" options={planOptions} value={s.plan_type} onChange={v => updateJob(i, { plan_type: v })} />
                  {s.plan_from && <small className="jm-sub">{s.plan_from}と同じ（変更できます）</small>}
                </div>
              </div>
            )}
            <JobsNumbers t={pj.totals} />
            {pj.notes.length > 0 && <ul className="jm-warn">{pj.notes.map(n => <li key={n}>{n}</li>)}</ul>}
            {!pj.blocked && !fromFile && isDate(s.period_start) && isDate(s.period_end) && (
              <label className={`jm-check jm-confirm${s.period_confirmed ? "" : " is-required"}`}>
                <input type="checkbox" checked={s.period_confirmed} onChange={e => updateJob(i, { period_confirmed: e.target.checked })} />
                <span>対象期間 {periodLabel(s.period_start, s.period_end)} を確認しました
                  <small>（{p.file_period ? `ファイル名の期間 ${periodLabel(p.file_period.start, p.file_period.end)} と異なります` : "ファイル名に期間がありません"}。作成日・最終更新日は集計期間ではありません）</small></span>
              </label>
            )}
            <details className="jm-fold">
              <summary>求人の詳細・掲載開始日</summary>
              <p className="jm-sub jm-jobs-meta">
                {[pj.company, pj.location].filter(Boolean).join("・")}
                {pj.csv_status && <>・CSVの状態：{pj.csv_status}（職種の募集状態は変更しません）</>}
                {url && <> ・<a href={url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">求人ページ</a></>}
                {(pj.created_on || pj.updated_on) && <>・作成日 {pj.created_on ? slashDate(pj.created_on) : "—"}／最終更新日 {pj.updated_on ? slashDate(pj.updated_on) : "—"}（集計期間ではありません）</>}
              </p>
              {!pj.blocked && (
                <label className="jm-inline-field"><span>実際の掲載開始日<small className="jm-opt">任意・空欄は未確認</small></span>
                  <input type="date" min={MIN_DATE} max={MAX_DATE} value={s.posting_start} onChange={e => updateJob(i, { posting_start: e.target.value })} aria-label="実際の掲載開始日" />
                </label>
              )}
              {!pj.blocked && <textarea className="jm-input" rows={2} maxLength={4000} placeholder="改善メモ（任意）" value={s.note} onChange={e => updateJob(i, { note: e.target.value })} />}
            </details>
            {prob && <p className="jm-error">{prob.message}</p>}
          </section>
        );
      })}

      {file?.format === "indeed" && p.groups.length > 1 && (
        <p className="jm-notice">このCSVには{p.groups.length}件の求人が含まれます。求人ごとに取込先の職種を選んでください。</p>
      )}
      {file?.format === "indeed" && p.groups.map((g, i) => {
        const s = groups[i];
        if (!s) return null;
        const prob = problemFor(i);
        const hint = matchCategory(categories, g.job_title);
        const h = historyPlan(planAt, s.category_id, postingIdOf(g, s.category_id), g.daily.map(d => d.date));
        return (
          <section key={g.key} className={`jm-import-card${s.include ? "" : " is-off"}`}>
            <header>
              {p.groups.length > 1 && <input type="checkbox" aria-label="この求人を取り込む" checked={s.include} disabled={g.blocked} onChange={e => updateGroup(i, { include: e.target.checked })} />}
              <strong>{g.job_title || g.job_id ? `${g.job_title || ""}${g.job_id ? `（求人ID ${g.job_id}）` : ""}` : "求人の指定なし"}</strong>
              <span className="jm-sub">{g.first_date ? periodLabel(g.first_date, g.last_date) : "—"}・{g.day_count}日分</span>
              {g.missing_dates.length > 0 && <span className="jm-chip is-warn">未収集 {g.missing_dates.length}日<Tip text={`記録のない日（0件として扱いません）：${rangesLabel(g.missing_dates)}`} /></span>}
            </header>
            <Totals t={g.totals} />
            <div className="jm-form-grid">
              <label><span>取込先の職種<span className="jm-req">必須</span></span>
                <CategorySelect categories={categories} value={s.category_id} label="取込先の職種" onChange={v => updateGroup(i, { category_id: v })} />
                {!s.category_id && <Suggest category={hint} from="CSVの職種名" onPick={v => updateGroup(i, { category_id: v })} />}
              </label>
              <label>集計開始日<input type="date" min={MIN_DATE} max={MAX_DATE} value={s.period_start} onChange={e => updateGroup(i, { period_start: e.target.value })} /></label>
              <label>集計終了日<input type="date" min={MIN_DATE} max={MAX_DATE} value={s.period_end} onChange={e => updateGroup(i, { period_end: e.target.value })} /></label>
            </div>
            <div className="jm-field-label">掲載種別<span className="jm-req">必須</span></div>
            <Segmented name={`plan-${i}`} label="掲載種別" options={planOptions} value={s.plan_type} onChange={v => updateGroup(i, { plan_type: v })} />
            {h.plan === "split" && <p className="jm-sub is-info">掲載状態の履歴により日別に分けて集計します：{h.label}</p>}
            {(h.plan === "free" || h.plan === "paid") && !s.plan_touched && <p className="jm-sub">掲載状態の履歴から選択しています。</p>}
            {g.notes.filter(n => !n.startsWith("記録のない日") && !n.startsWith("費用が空欄") && !n.startsWith("求人ID・職種名が空欄")).length > 0 && (
              <ul className="jm-warn">{g.notes.filter(n => !n.startsWith("記録のない日") && !n.startsWith("費用が空欄") && !n.startsWith("求人ID・職種名が空欄")).map(n => <li key={n}>{n}</li>)}</ul>
            )}
            <details className="jm-fold">
              <summary>改善メモを追加</summary>
              <textarea className="jm-input" rows={2} maxLength={4000} value={s.note} onChange={e => updateGroup(i, { note: e.target.value })} />
            </details>
            {prob && !prob.conflicts && <p className="jm-error">{prob.message}</p>}
            <ConflictResolver problem={prob} records={records} value={resolves[i] || noResolve()} onChange={v => changeResolve(i, v)} />
          </section>
        );
      })}

      {file?.format === "legacy" && legacy && (
        <>
          <div className="jm-form-grid">
            <label><span>取込先の職種<span className="jm-req">必須</span></span>
              <CategorySelect categories={categories} value={legacy.category_id} label="取込先の職種" onChange={v => updateLegacy({ category_id: v })} />
              {!legacy.category_id && <Suggest category={matchCategory(categories, p.suggested_category)} from="ファイル名" onPick={v => updateLegacy({ category_id: v })} />}
            </label>
            {p.needs_year && (
              <label><span>年（全列）<span className="jm-req">必須</span></span>
                <input type="number" min="1000" max="9999" placeholder="例：2026" aria-label="年（全列）"
                  onChange={e => { const year = e.target.value; updateLegacy({ columns: legacy.columns.map((c, j) => p.columns[j].period.start_year ? c : { ...c, year }) }); }} />
              </label>
            )}
          </div>
          {p.has_ambiguous_apply && (
            <>
              <div className="jm-field-label">「応募」の意味<span className="jm-req">必須</span><Tip text="旧管理表の「応募」は定義が不明なため自動では割り当てません。「不明」は元の値だけを保持します。" /></div>
              <Segmented name="apply-map" label="「応募」の意味" options={[["apply_starts", "応募開始数"], ["applies", "応募完了数"], ["unknown", "不明"]]}
                value={legacy.apply_mapping} onChange={v => updateLegacy({ apply_mapping: v })} />
            </>
          )}
          {p.columns.map((c, i) => {
            const s = legacy.columns[i];
            const period = resolveLegacyPeriod(c.period, s.year);
            const prob = problemFor(i);
            const r = rates(c);
            const h = historyPlan(planAt, legacy.category_id, null, columnDates(c, s));
            return (
              <section key={c.index} className={`jm-import-card${s.include ? "" : " is-off"}`}>
                <header>
                  <input type="checkbox" aria-label={`${c.period.label}を取り込む`} checked={s.include} onChange={e => updateColumn(i, { include: e.target.checked })} />
                  <strong>{c.period.label}</strong>
                  <span className="jm-sub">{period ? periodLabel(period.start, period.end) : "年が未確定"}</span>
                  {!c.period.start_year && <input className="jm-year" type="number" min="1000" max="9999" placeholder="年" aria-label={`${c.period.label}の年`} value={s.year} onChange={e => updateColumn(i, { year: e.target.value })} />}
                </header>
                <div className="jm-totals">
                  <span>表示 <b>{fmtCount(c.impressions)}</b></span><span>クリック <b>{fmtCount(c.clicks)}</b></span>
                  <span>応募 <b>{fmtCount(c.apply_raw)}</b></span><span>クリック率（CTR） <b>{fmtRate(r.ctr)}</b></span>
                </div>
                <Segmented name={`lplan-${i}`} label="掲載種別" options={planOptions} value={s.plan_type} onChange={v => updateColumn(i, { plan_type: v })} />
                {h.plan === "split" && <p className="jm-sub is-info">期間中に掲載状態が変わるため、無料／有料の比較では「内訳不明」として扱います（按分しません）。</p>}
                {(c.note || c.issues.length > 0) && (
                  <details className="jm-fold">
                    <summary>{c.note ? "改善案・メモ" : ""}{c.note && c.issues.length ? "・" : ""}{c.issues.length ? `注意 ${c.issues.length}件` : ""}</summary>
                    {c.note && <p className="jm-note">{c.note}</p>}
                    {c.issues.length > 0 && <ul className="jm-warn">{c.issues.map(n => <li key={n}>{n}</li>)}</ul>}
                  </details>
                )}
                {prob && !prob.conflicts && <p className="jm-error">{prob.message}</p>}
                <ConflictResolver problem={prob} records={records} value={resolves[i] || noResolve()} onChange={v => changeResolve(i, v)} />
              </section>
            );
          })}
          {refs.length > 0 && (
            <section className="jm-import-card">
              <header><strong>備考欄の参考求人</strong></header>
              <div className="jm-ref-picks">
                {refs.map((r, i) => (
                  <label key={`${r.company_name}-${i}`} className="jm-check"><input type="checkbox" checked={r.include} onChange={e => setRefs(list => list.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />{r.company_name}</label>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {overwriteItems.length > 0 && <OverwriteConfirm items={overwriteItems} onPick={pickJob} />}
      {fileProblems.map(fp => <p key={fp.message} className="jm-error" role="alert">{fp.message}</p>)}
      {error && <p className="jm-error" role="alert">{error}</p>}
      {file && (
        <div className="jm-import-foot">
          <span className={`jm-check-status${ready ? " is-ok" : problems.length || current?.error ? " is-ng" : ""}`} role="status">
            {built.issues.length ? built.issues[0]
              : current?.error ? current.error
                : !current ? "重複を確認しています…"
                  : problems.length ? `重複・期間の重なりが${problems.length}件あります` : "✓ 重複なし。取り込めます"}
          </span>
          <div className="jm-actions">
            <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
            <button type="button" className="jm-btn is-primary" disabled={busy || !ready} onClick={submit}>{file.format === "indeed_jobs" ? (overwriteItems.length ? "上書きする" : "登録する") : "取り込む"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
