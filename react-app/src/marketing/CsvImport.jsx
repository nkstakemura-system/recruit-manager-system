// CSV取込（Indeed公式形式・旧管理CSV）。形式はファイル名ではなく中身で判定し、取込前に内容を確認してから登録する。
// 職種・年・「応募」の意味など、CSVから確定できない情報は推測せず利用者が選ぶ（候補は表示するが自動では選ばない）。
// 重複・期間の重なりは入力がそろった時点でサーバーに確認（dry_run）し、問題が無いときだけ取り込める。
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MEDIA, PLAN_TYPES, decodeCsv, detectFormat, eachDay, fmtCount, fmtRate, legacyColumnRecord, matchCategory,
  parseCsv, parseIndeed, parseLegacy, periodLabel, planResolver, postingOf, rangesLabel, rates, resolveLegacyPeriod,
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
export default function CsvImport({ categories, records, postings = [], planEvents = [], initialFile = null, onClose, onDone }) {
  const [file, setFile] = useState(null); // { name, hash, encoding, format, parsed, rows, raw }
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [groups, setGroups] = useState([]); // Indeed: 求人ごとの登録設定
  const [legacy, setLegacy] = useState(null); // 旧CSV: 共通設定と列ごとの設定
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
    setError(""); setFile(null); setResolves({}); setGroups([]); setLegacy(null); setRefs([]);
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setError("CSVが大きすぎます（2MBまで）"); return; }
    const buffer = await f.arrayBuffer();
    const { text, encoding } = decodeCsv(new Uint8Array(buffer));
    const rows = parseCsv(text);
    const format = detectFormat(rows);
    if (!format) { setError("CSVの形式を判定できませんでした。Indeedのレポート（日付・表示回数・クリック数の列）か、旧管理表（表示の行と集計期間の列）を選んでください。"); return; }
    const hash = await sha256Hex(buffer);
    const raw = rows.filter(r => r.some(c => String(c).trim())).slice(0, PREVIEW_ROWS + 1);
    if (format === "indeed") {
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

  // 登録内容（entries の index と画面の行を対応づける）
  function build() {
    const issues = [];
    const entries = [];
    const rowsOfEntry = [];
    if (!file) return { issues: ["CSVを選択してください"], entries, rowsOfEntry, references: [] };
    if (file.format === "indeed") {
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
    if (!entries.length) issues.push("取り込む行を1件以上選択してください");
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
          <span className="jm-sub">Indeedのレポート／旧管理表（UTF-8・Shift_JIS）</span>
        </div>
      ) : (
        <div className="jm-filebar">
          <strong className="jm-filename">{file.name}</strong>
          <span className="jm-chip">{file.format === "indeed" ? "Indeed形式" : "旧管理表"}</span>
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

      {file && (
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
            <button type="button" className="jm-btn is-primary" disabled={busy || !ready} onClick={submit}>取り込む</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
