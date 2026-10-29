// 求人分析（第4弾）。Indeed等の求人掲載の月次実績を職種別に記録・比較する。
// 集計・比較・自動分析は shared/jobMarketing.mjs（外部AIは使わないルールベース）。応募者情報は扱わない。
// 画面は上から「操作 → 主要KPI → 率 → 無料／有料の比較 → 月別推移 → 自動分析コメント → 履歴（折り畳み）」の順（F型・左寄せ）。
// ローカルプレビューの実CSVモード（overview に preview_pending_files がある場合）だけ、確認待ちのCSVを取得・表示する。本番では取得しない。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MEDIA, METRICS, METRIC_LABELS, PLAN_STATUS, RATE_LABELS, THRESHOLDS, analyze, comparability, fmtCount, fmtRate, fmtYen,
  monthAggregate, monthDeltas, monthLabel, monthRange, monthlySeries, periodLabel, planResolver, planSplit, rangesLabel, rates, safeUrl,
  shiftMonth, slashDate, summaryText, todayTokyo, unitCost,
} from "../../../shared/jobMarketing.mjs";
import { marketingApi, errorText, planLabel, postingLabel, sourceLabel, statusLabel } from "./marketingApi";
import CsvImport from "./CsvImport";
import MonthlyChart from "./MonthlyChart";
import { CategoryManager, PlanDialog, PlanVoidDialog, RecordForm, ReferenceForm, Tip, VoidDialog } from "./MarketingForms";
import "./marketing.css";

const STATUS_SHORT = { free: "無料", paid: "有料", unknown: "不明", stopped: "停止" };
const KPI_LABELS = { impressions: "表示回数", clicks: "クリック数", apply_starts: "応募開始数", applies: "応募数" };

// 集計状況の短い表示（全日分／N日分／重複／未登録）
function coverage(agg) {
  if (agg.status === "empty") return { text: "未登録", tone: "muted" };
  if (agg.status === "overlap") return { text: "期間重複", tone: "alert" };
  if (agg.in_progress) return { text: `集計途中・${agg.covered_days}日分`, tone: "warn" };
  if (agg.missing_dates.length) return { text: `${agg.covered_days}/${agg.days_in_month}日分`, tone: "warn", tip: `未収集日（0件扱いしません）：${rangesLabel(agg.missing_dates)}` };
  return { text: "全日分", tone: "ok" };
}
const Coverage = ({ agg }) => {
  const c = coverage(agg);
  return <span className={`jm-chip is-${c.tone}`}>{c.text}{c.tip && <Tip text={c.tip} />}</span>;
};

function Delta({ d, unit = "%" }) {
  if (!d) return null;
  const value = unit === "%" ? d.pct : d.diff;
  if (value == null) return null;
  return <span className={`jm-delta ${value > 0 ? "is-up" : value < 0 ? "is-down" : ""}`}>{value > 0 ? "▲" : value < 0 ? "▼" : "±"}{Math.abs(value).toFixed(unit === "%" ? 0 : 1)}{unit}</span>;
}

// 無料／有料の比較カード（合計に加えて1日平均と率を併記する）
function PlanCard({ g, title, plan, budget }) {
  if (!g) {
    return (
      <div className={`jm-vs-card is-${plan} is-empty`}>
        <div className="jm-vs-head"><span className={`jm-status is-${plan}`}>{title}</span></div>
        <p className="jm-sub">実績なし</p>
      </div>
    );
  }
  const per = v => v == null ? "—" : v.toFixed(v < 10 ? 1 : 0);
  const rows = [
    ["表示回数", fmtCount(g.totals.impressions), `1日 ${per(g.per_day.impressions)}`],
    ["クリック数", fmtCount(g.totals.clicks), `1日 ${per(g.per_day.clicks)}`],
    ["クリック率（CTR）", fmtRate(g.rates.ctr), ""],
    ["応募開始数", fmtCount(g.totals.apply_starts), ""],
    ["応募完了数", fmtCount(g.totals.applies), ""],
    ["応募率", fmtRate(g.rates.apply_rate), ""],
    ["掲載費用", g.totals.cost == null ? "未入力" : fmtYen(g.totals.cost), budget != null ? `予算 ${fmtYen(budget)}` : ""],
    ["応募単価", fmtYen(g.unit_cost), ""],
  ];
  return (
    <div className={`jm-vs-card is-${plan}`}>
      <div className="jm-vs-head">
        <span className={`jm-status is-${plan}`}>{title}</span>
        <span className="jm-sub">{g.ranges.map(r => r.start === r.end ? slashDate(r.start) : periodLabel(r.start, r.end)).join("、")}</span>
      </div>
      <div className="jm-vs-big"><b>{per(g.per_day.impressions)}</b><span>1日平均 表示{g.postings > 1 ? `（1原稿あたり・${g.postings}原稿）` : ""}</span><em>{g.day_count}日分</em></div>
      <dl className="jm-vs-rows">
        {rows.map(([k, v, sub]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}{sub && <>{" "}<small>{sub}</small></>}</dd></React.Fragment>)}
      </dl>
    </div>
  );
}

// 無料／有料の区分に使った条件（掲載状態の履歴）。履歴が無ければ各記録の掲載種別で区分する
function PlanBasis({ events }) {
  const list = events.filter(e => e.state === "active").slice().sort((x, y) => x.effective_date.localeCompare(y.effective_date) || Number(x.id) - Number(y.id));
  return (
    <p className="jm-sub jm-basis">
      <b>区分の条件</b>
      {list.length ? `掲載状態の履歴を優先（${list.map(e => `${slashDate(e.effective_date)}〜 ${PLAN_STATUS[e.status]}${e.posting_id ? "（原稿別）" : ""}`).join("、")}）。日別データは日ごと、月間合計は期間全体で判定`
        : "掲載状態の履歴が未登録のため、各記録の掲載種別（無料／有料／不明）で区分"}
    </p>
  );
}

function PlanCompare({ plans, budget, events }) {
  return (
    <>
      <PlanBasis events={events} />
      {!plans.comparable && (
        <p className="jm-insufficient"><strong>比較データ不足</strong><span>{plans.reasons[0]}</span>
          {plans.reasons.length > 1 && <Tip text={plans.reasons.join("／")} />}</p>
      )}
      <div className="jm-vs">
        <PlanCard g={plans.free} title="無料掲載" plan="free" />
        <PlanCard g={plans.paid} title="有料掲載" plan="paid" budget={budget} />
      </div>
      {plans.split_unknown && (
        <p className="jm-sub is-info">掲載方法別の内訳不明：{plans.split_unknown.ranges.map(r => periodLabel(r.start, r.end)).join("、")}（月間合計のみのため按分していません）</p>
      )}
      {plans.excluded.length > 0 && <p className="jm-sub">期間が重なる記録{plans.excluded.length}件は比較から除外しています。</p>}
      <p className="jm-sub">原稿内容・時期の違いも含むため、差は掲載方法だけの効果とは限りません。</p>
    </>
  );
}

const Item = ({ item }) => (
  <li className={`is-${item.level}`}>
    <span className="jm-level">{{ check: "改善候補", info: "参考", good: "良い変化", hold: "保留" }[item.level]}</span>
    <div><strong>{item.title}</strong><p>{item.body}</p></div>
  </li>
);

// 重要な指摘を最大3件だけ先に表示し、残りと判定の目安は折り畳む
function Analysis({ result }) {
  const top = result.items.slice(0, 3);
  const rest = result.items.slice(3);
  return (
    <div className="jm-analysis">
      <ul>{top.map(item => <Item key={item.title} item={item} />)}</ul>
      <details className="jm-fold">
        <summary>{rest.length ? `ほか${rest.length}件・判定の目安` : "判定の目安"}</summary>
        {rest.length > 0 && <ul>{rest.map(item => <Item key={item.title} item={item} />)}</ul>}
        <p className="jm-sub">暫定の目安（NKS内の仮設定で、業界平均やIndeedの基準ではありません）：クリック率（CTR） {THRESHOLDS.lowCtr}%・応募開始率 {THRESHOLDS.lowAsr}%・応募完了率 {THRESHOLDS.lowCompletion}%・表示 1日{THRESHOLDS.lowDailyImpressions}回。表示{THRESHOLDS.minImpressions}回・クリック{THRESHOLDS.minClicks}回未満は判断を保留。登録された数値からの定型ルールによる分析で、原因は断定しません。</p>
      </details>
    </div>
  );
}

function RecordRow({ r, postings, onEdit, onVoid }) {
  const rt = rates(r);
  const meta = r.source_meta || {};
  const posting = r.posting_id ? postings.find(p => p.id === r.posting_id) : null;
  return (
    <li className={`jm-hist is-${r.state}`}>
      <div className="jm-hist-head">
        <strong>{periodLabel(r.period_start, r.period_end)}</strong>
        <span className="jm-chip">{sourceLabel(r.source)}</span>
        <span className="jm-chip">{planLabel(r.plan_type)}</span>
        {posting && <span className="jm-chip">{postingLabel(posting)}</span>}
        {r.media !== DEFAULT_MEDIA && <span className="jm-chip">{r.media}</span>}
        {r.state === "superseded" && <span className="jm-chip is-muted">置換済み</span>}
        {r.state === "voided" && <span className="jm-chip is-muted">取消済み：{r.void_reason}</span>}
        {meta.overlap && <span className="jm-chip is-warn">重複を承知で登録<Tip text={`理由：${meta.overlap.reason}`} /></span>}
        {r.state === "active" && (
          <span className="jm-hist-actions">
            <button type="button" className="jm-link" onClick={() => onEdit(r)}>修正</button>
            <button type="button" className="jm-link is-danger" onClick={() => onVoid(r)}>取消</button>
          </span>
        )}
      </div>
      <div className="jm-totals">
        {METRICS.map(k => <span key={k}>{METRIC_LABELS[k]} <b>{fmtCount(r[k])}</b></span>)}
        <span>クリック率（CTR） <b>{fmtRate(rt.ctr)}</b></span><span>費用 <b>{r.cost == null ? "未入力" : fmtYen(r.cost)}</b></span>
        {r.daily && <span>日別 <b>{r.daily.length}</b>日分</span>}
      </div>
      {r.note && <p className="jm-note">{r.note}</p>}
      <p className="jm-meta">#{r.id}・{r.created_at}{r.actor ? `・${r.actor}` : ""}{meta.definitions?.apply ? `・${meta.definitions.apply}` : ""}{meta.year_confirmed ? `・年は${meta.year_confirmed}年と確認` : ""}</p>
    </li>
  );
}

export default function JobMarketing() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [month, setMonth] = useState(null);
  const [categoryId, setCategoryId] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [chartOpen, setChartOpen] = useState(false);
  const [pending, setPending] = useState([]);

  // 確認待ちのCSV（ローカルプレビューのみ。本番では 404 のため表示しない）
  const loadPending = useCallback(() => marketingApi.pendingFiles().then(res => setPending(res.ok && Array.isArray(res.data?.files) ? res.data.files : [])).catch(() => setPending([])), []);
  const load = useCallback(() => marketingApi.load().then(res => {
    if (!res.ok) { setError(errorText(res, "求人分析のデータを読み込めませんでした")); return; }
    setData(res.data);
    setError("");
  }).catch(() => setError("求人分析のデータを読み込めませんでした。再読み込みしてください。")), []);
  useEffect(() => {
    let alive = true;
    marketingApi.load().then(res => {
      if (!alive) return;
      if (!res.ok) { setError(errorText(res, "求人分析のデータを読み込めませんでした")); return; }
      setData(res.data);
      if (res.data?.preview_pending_files) marketingApi.pendingFiles().then(p => { if (alive && p.ok && Array.isArray(p.data?.files)) setPending(p.data.files); }).catch(() => {});
    }).catch(() => alive && setError("求人分析のデータを読み込めませんでした。再読み込みしてください。"));
    return () => { alive = false; };
  }, []);

  const asOf = data?.as_of || todayTokyo();
  const nowMonth = asOf.slice(0, 7);
  const selectedMonth = month || nowMonth;
  const categories = useMemo(() => data?.categories || [], [data]);
  const postings = useMemo(() => data?.postings || [], [data]);
  const planEvents = useMemo(() => data?.plan_events || [], [data]);
  const planAt = useMemo(() => planResolver(planEvents), [planEvents]);
  const selected = categories.find(c => c.id === categoryId) || categories.find(c => c.is_active) || categories[0];
  const active = useMemo(() => (data?.records || []).filter(r => r.state === "active"), [data]);
  const months = useMemo(() => {
    const set = new Set(Array.from({ length: 24 }, (_, i) => shiftMonth(nowMonth, -i)));
    for (const r of active) { set.add(r.period_start.slice(0, 7)); set.add(r.period_end.slice(0, 7)); }
    return [...set].filter(m => m <= nowMonth).sort().reverse();
  }, [active, nowMonth]);

  const summary = useMemo(() => categories.map(c => ({ category: c, agg: monthAggregate(active, { categoryId: c.id, month: selectedMonth, asOf, planAt }) })), [categories, active, selectedMonth, asOf, planAt]);
  const view = useMemo(() => {
    if (!selected) return null;
    const opts = { categoryId: selected.id, asOf, planAt };
    const cur = monthAggregate(active, { ...opts, month: selectedMonth });
    const prev = monthAggregate(active, { ...opts, month: shiftMonth(selectedMonth, -1) });
    const series = monthlySeries(active, { ...opts, endMonth: selectedMonth, count: 12 });
    // グラフは選択月の2か月先まで表示する（未到来の月は空欄）
    const chart = monthlySeries(active, { ...opts, endMonth: shiftMonth(selectedMonth, 2), count: 12 });
    const comparison = comparability(cur, prev);
    const plans = planSplit(active, { categoryId: selected.id, start: `${shiftMonth(selectedMonth, -11)}-01`, end: monthRange(selectedMonth).end, planAt });
    return { cur, prev, series, chart, comparison, plans, analysis: analyze({ current: cur, previous: prev, comparison, series, plans }) };
  }, [selected, active, selectedMonth, asOf, planAt]);

  const done = message => { setDialog(null); setNotice(message); load(); if (data?.preview_pending_files) loadPending(); };
  const copySummary = async () => {
    const text = summaryText({ category: selected, current: view.cur, previous: view.prev, comparison: view.comparison, analysis: view.analysis, plans: view.plans });
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setDialog({ type: "copy", text }); }
  };

  if (error) return <div className="jm-page"><p className="jm-error" role="alert">{error}</p></div>;
  if (!data) return <div className="jm-page"><p className="jm-sub">読み込み中…</p></div>;
  if (!data.ready) {
    return (
      <div className="jm-page">
        <h2 className="jm-h2">求人分析</h2>
        <p className="jm-error">求人分析のテーブルが未作成のため使用できません（migrations/004_job_marketing.sql の適用が必要です）。</p>
      </div>
    );
  }

  const categoryRecords = (data.records || []).filter(r => r.category_id === selected?.id)
    .filter(r => showHistory || r.state === "active").sort((a, b) => b.period_start.localeCompare(a.period_start) || Number(b.id) - Number(a.id));
  const references = (data.references || []).filter(r => r.category_id === selected?.id);
  const categoryPostings = postings.filter(p => p.category_id === selected?.id);
  const categoryEvents = planEvents.filter(e => e.category_id === selected?.id).sort((a, b) => b.effective_date.localeCompare(a.effective_date) || Number(b.id) - Number(a.id));
  const currentPlan = selected ? planAt(selected.id, null, asOf) : null;
  const lastPaid = categoryEvents.find(e => e.state === "active" && e.status === "paid" && e.posting_id == null && e.effective_date <= asOf);
  const monthIndex = months.indexOf(selectedMonth);
  const cur = view?.cur;
  const deltas = view && view.comparison.comparable ? monthDeltas(view.cur, view.prev) : null;
  const cost = cur?.totals.cost;

  return (
    <div className="jm-page">
      <div className="jm-bar">
        <h2 className="jm-h2">求人分析</h2>
        <span className="jm-month">
          <button type="button" aria-label="前の月" disabled={monthIndex >= months.length - 1} onClick={() => setMonth(months[monthIndex + 1])}>‹</button>
          <select value={selectedMonth} aria-label="対象月" onChange={e => setMonth(e.target.value)}>
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button type="button" aria-label="次の月" disabled={monthIndex <= 0} onClick={() => setMonth(months[monthIndex - 1])}>›</button>
        </span>
        <div className="jm-bar-actions">
          <button type="button" className="jm-btn is-primary" onClick={() => setDialog({ type: "csv" })}>CSV取込</button>
          <button type="button" className="jm-btn" onClick={() => setDialog({ type: "record" })}>実績を登録</button>
          <button type="button" className="jm-btn" onClick={() => setDialog({ type: "categories" })}>職種の管理</button>
        </div>
      </div>

      <div className="jm-tabs" role="tablist" aria-label="職種">
        {categories.map(c => {
          const st = planAt(c.id, null, asOf)?.status;
          return (
            <button key={c.id} type="button" role="tab" aria-selected={c.id === selected?.id} className={`jm-tab${c.id === selected?.id ? " is-on" : ""}${c.is_active ? "" : " is-off"}`} onClick={() => setCategoryId(c.id)}>
              {c.name}{st && <span className={`jm-dot is-${st}`}>{STATUS_SHORT[st]}</span>}
            </button>
          );
        })}
      </div>
      {notice && <p className="jm-ok" role="status">{notice}</p>}
      {pending.length > 0 && (
        <div className="jm-pending">
          <strong>確認待ちのCSV<Tip text="ローカルプレビューで読み込んだ実ファイルです。まだ登録していません。職種・年・「応募」の意味などを確認して取り込んでください。" /></strong>
          <div className="jm-pending-list">
            {pending.map(p => (
              <button key={p.hash} type="button" className={`jm-pending-file${p.imported ? " is-done" : ""}`} onClick={() => setDialog({ type: "csv", initialFile: p })}>
                <span>{p.name}</span><em>{p.imported ? "取込済み" : "確認待ち"}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && view && (
        <>
          <div className="jm-plan-row">
            <span className="jm-plan-label">掲載状態</span>
            <span className={`jm-status is-${currentPlan?.status || "none"}`}>{statusLabel(currentPlan?.status)}</span>
            {currentPlan && <span className="jm-sub">{slashDate(currentPlan.effective_date)}〜{currentPlan.status === "paid" && currentPlan.budget != null ? `・予算 ${fmtYen(currentPlan.budget)}` : ""}</span>}
            <button type="button" className="jm-btn is-small" onClick={() => setDialog({ type: "plan" })}>{currentPlan?.status === "free" ? "有料掲載に切替" : "掲載状態を変更"}</button>
            <span className="jm-plan-sep" />
            <Coverage agg={cur} />
            {cur.plan === "mixed" && <span className="jm-chip">月の途中で掲載方法を変更</span>}
          </div>

          {cur.status === "empty" ? (
            <div className="jm-empty">
              <strong>{monthLabel(selectedMonth)}の実績はまだありません</strong>
              <div className="jm-actions is-left">
                <button type="button" className="jm-btn is-primary" onClick={() => setDialog({ type: "csv" })}>CSV取込</button>
                <button type="button" className="jm-btn" onClick={() => setDialog({ type: "record" })}>実績を登録</button>
              </div>
            </div>
          ) : cur.status === "overlap" ? (
            <p className="jm-alert" role="alert">{rangesLabel(cur.overlap_dates)}に重なる記録があるため合算していません。下の「改善履歴・登録実績」から置き換えまたは取消してください。</p>
          ) : (
            <>
              <div className="jm-kpis">
                {METRICS.map(k => (
                  <div key={k} className="jm-kpi">
                    <span className="jm-kpi-label">{KPI_LABELS[k]}</span>
                    <b className="jm-kpi-value">{fmtCount(cur.totals[k])}</b>
                    <span className="jm-kpi-sub">{deltas ? <><Delta d={deltas[k]} /> 前月比</> : cur.totals[k] == null ? "未取得" : " "}</span>
                  </div>
                ))}
              </div>
              <div className="jm-rates">
                {[["ctr", "クリック数 ÷ 表示回数"], ["asr", "応募開始数 ÷ クリック数"], ["completion", "応募完了数 ÷ 応募開始数"], ["apply_rate", "応募完了数 ÷ クリック数"]].map(([k, formula]) => (
                  <div key={k} className="jm-rate">
                    <span className="jm-rate-label">{RATE_LABELS[k].replace("（ASR）", "")}<Tip text={formula} /></span>
                    <b>{fmtRate(cur.rates[k])}</b>
                    {deltas && <Delta d={deltas[k]} unit="pt" />}
                  </div>
                ))}
                <div className="jm-rate">
                  <span className="jm-rate-label">応募単価<Tip text="掲載費用÷応募完了数（費用が入力された月のみ）" /></span>
                  <b>{fmtYen(unitCost(cost, cur.totals.applies))}</b>
                  <span className="jm-sub">費用 {cost == null ? "未入力" : fmtYen(cost)}</span>
                </div>
              </div>
            </>
          )}

          <section className="jm-card">
            <h3>無料／有料掲載の比較<span className="jm-h3-sub">直近12か月</span></h3>
            <PlanCompare plans={view.plans} budget={lastPaid?.budget ?? null} events={categoryEvents} />
          </section>

          <section className="jm-card jm-month-card">
            <div className="jm-month-sum">
              <strong>{monthLabel(selectedMonth)}の実績</strong>
              {cur.status === "ok" ? (
                <span className="jm-month-nums">
                  <span>表示 <b>{fmtCount(cur.totals.impressions)}</b>回</span><span>クリック <b>{fmtCount(cur.totals.clicks)}</b>回</span>
                  <span>応募開始 <b>{fmtCount(cur.totals.apply_starts)}</b>件</span><span>応募 <b>{fmtCount(cur.totals.applies)}</b>件</span>
                </span>
              ) : <span className="jm-sub">{cur.status === "overlap" ? "期間重複のため合算していません" : "未登録"}</span>}
            </div>
            <button type="button" className="jm-btn is-small jm-chart-toggle" aria-expanded={chartOpen} onClick={() => setChartOpen(o => !o)}>{chartOpen ? "月別グラフを閉じる ▲" : "月別グラフを見る ▼"}</button>
            {chartOpen && (
              <>
                <MonthlyChart series={view.chart} selectedMonth={selectedMonth} />
                <details className="jm-fold">
                  <summary>数値の表</summary>
                  <div className="jm-table-wrap">
                    <table className="jm-table">
                      <thead><tr><th>月</th>{METRICS.map(k => <th key={k}>{KPI_LABELS[k]}</th>)}<th>クリック率（CTR）</th><th>応募開始率</th><th>費用</th><th>掲載</th><th>集計</th></tr></thead>
                      <tbody>{view.series.slice().reverse().map(m => (
                        <tr key={m.month}><td>{monthLabel(m.month)}</td>{METRICS.map(k => <td key={k}>{m.status === "empty" ? "未登録" : fmtCount(m.totals[k])}</td>)}
                          <td>{fmtRate(m.rates.ctr)}</td><td>{fmtRate(m.rates.asr)}</td><td>{fmtYen(m.totals.cost)}</td><td>{planLabel(m.plan)}</td><td><Coverage agg={m} /></td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </section>

          <section className="jm-card">
            <h3>自動分析コメント
              <button type="button" className="jm-btn is-small jm-h3-action" onClick={copySummary}>{copied ? "コピーしました" : "サマリーをコピー"}</button>
            </h3>
            <Analysis result={view.analysis} />
          </section>

          <details className="jm-card jm-fold-card">
            <summary>掲載状態の履歴<span className="jm-count">{categoryEvents.filter(e => e.state === "active").length}</span></summary>
            {categoryEvents.length ? (
              <ul className="jm-plan-hist">
                {categoryEvents.map(e => {
                  const posting = e.posting_id ? postings.find(p => p.id === e.posting_id) : null;
                  return (
                    <li key={e.id} className={`is-${e.state}`}>
                      <span className="jm-plan-date">{slashDate(e.effective_date)}〜</span>
                      <span className={`jm-status is-${e.status}`}>{PLAN_STATUS[e.status]}</span>
                      <span className="jm-sub">{postingLabel(posting)}{e.budget != null ? `・予算 ${fmtYen(e.budget)}` : ""}</span>
                      {e.note && <span className="jm-plan-note">{e.note}</span>}
                      {e.state === "voided" ? <span className="jm-chip is-muted">取消済み：{e.void_reason}</span>
                        : <button type="button" className="jm-link is-danger" onClick={() => setDialog({ type: "planVoid", event: e })}>取消</button>}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="jm-sub">まだ登録がありません。</p>}
            {categoryPostings.length > 0 && <p className="jm-sub">求人原稿：{categoryPostings.map(postingLabel).join("、")}</p>}
          </details>

          <details className="jm-card jm-fold-card">
            <summary>改善履歴・登録実績<span className="jm-count">{(data.records || []).filter(r => r.category_id === selected.id && r.state === "active").length}</span></summary>
            <label className="jm-check jm-fold-tool"><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)} />置換済み・取消済みも表示</label>
            {categoryRecords.length ? (
              <ul className="jm-hist-list">
                {categoryRecords.map(r => <RecordRow key={r.id} r={r} postings={postings} onEdit={rec => setDialog({ type: "record", initial: rec })} onVoid={rec => setDialog({ type: "void", record: rec })} />)}
              </ul>
            ) : <p className="jm-sub">この職種の実績はまだありません。</p>}
          </details>

          <details className="jm-card jm-fold-card">
            <summary>参考求人<span className="jm-count">{references.length}</span></summary>
            {references.length > 0 && (
              <ul className="jm-refs">
                {references.map(r => {
                  const url = safeUrl(r.url);
                  return (
                    <li key={r.id}>
                      <div className="jm-ref-head">
                        <strong>{r.company_name}</strong>
                        {r.job_title && <span>{r.job_title}</span>}
                        {r.checked_on && <span className="jm-sub">確認日 {slashDate(r.checked_on)}</span>}
                        <span className="jm-hist-actions">
                          <button type="button" className="jm-link" onClick={() => setDialog({ type: "reference", initial: r })}>編集</button>
                          <button type="button" className="jm-link is-danger" onClick={async () => {
                            if (!window.confirm(`参考求人「${r.company_name}」を削除しますか？`)) return;
                            const res = await marketingApi.deleteReference(r.id);
                            if (res.ok) done("参考求人を削除しました"); else setNotice(errorText(res, "削除できませんでした"));
                          }}>削除</button>
                        </span>
                      </div>
                      {url && <a href={url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="jm-ref-url">{url}</a>}
                      {r.memo && <p className="jm-note">{r.memo}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" className="jm-btn is-small" onClick={() => setDialog({ type: "reference" })}>参考求人を追加</button>
          </details>

          <details className="jm-card jm-fold-card">
            <summary>全職種の{monthLabel(selectedMonth)}</summary>
            <div className="jm-table-wrap">
              <table className="jm-table is-summary">
                <thead><tr><th>職種</th><th>表示</th><th>クリック</th><th>クリック率（CTR）</th><th>応募開始</th><th>応募</th><th>掲載</th><th>集計</th></tr></thead>
                <tbody>
                  {summary.map(({ category, agg }) => (
                    <tr key={category.id} className={category.id === selected?.id ? "is-selected" : ""} onClick={() => setCategoryId(category.id)}>
                      <td><button type="button" className="jm-link" onClick={() => setCategoryId(category.id)}>{category.name}</button></td>
                      <td>{fmtCount(agg.totals.impressions)}</td><td>{fmtCount(agg.totals.clicks)}</td><td>{fmtRate(agg.rates.ctr)}</td>
                      <td>{fmtCount(agg.totals.apply_starts)}</td><td>{fmtCount(agg.totals.applies)}</td><td>{planLabel(agg.plan)}</td><td><Coverage agg={agg} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      {dialog?.type === "record" && (
        <RecordForm categories={categories} postings={postings} records={active} initial={dialog.initial} defaultCategory={selected?.id} defaultMonth={selectedMonth}
          onClose={() => setDialog(null)} onSaved={() => done(dialog.initial ? "実績を修正しました（元の記録は履歴に残っています）" : "実績を登録しました")} />
      )}
      {dialog?.type === "void" && <VoidDialog record={dialog.record} onClose={() => setDialog(null)} onSaved={() => done("記録を取消しました（履歴に残っています）")} />}
      {dialog?.type === "csv" && (
        <CsvImport categories={categories} records={active} postings={postings} planEvents={planEvents} initialFile={dialog.initialFile} onClose={() => setDialog(null)}
          onDone={res => done(`CSVを取り込みました（実績 ${res.ids.length}件${res.references ? `・参考求人 ${res.references}件` : ""}）`)} />
      )}
      {dialog?.type === "categories" && <CategoryManager categories={categories} onClose={() => setDialog(null)} onSaved={load} />}
      {dialog?.type === "plan" && selected && (
        <PlanDialog category={selected} postings={categoryPostings} current={currentPlan} today={asOf} onClose={() => setDialog(null)}
          onSaved={() => done("掲載状態を変更しました（変更前の実績・履歴は残っています）")} />
      )}
      {dialog?.type === "planVoid" && <PlanVoidDialog event={dialog.event} onClose={() => setDialog(null)} onSaved={() => done("掲載状態の変更を取消しました")} />}
      {dialog?.type === "reference" && selected && (
        <ReferenceForm categoryId={selected.id} initial={dialog.initial} onClose={() => setDialog(null)} onSaved={() => done("参考求人を保存しました")} />
      )}
      {dialog?.type === "copy" && (
        <div className="jm-backdrop" onClick={() => setDialog(null)}>
          <div className="jm-modal" onClick={e => e.stopPropagation()}>
            <div className="jm-modal-head"><strong>月次サマリー</strong><button type="button" className="jm-close" onClick={() => setDialog(null)}>×</button></div>
            <div className="jm-modal-body"><textarea readOnly rows={14} className="jm-input" value={dialog.text} onFocus={e => e.target.select()} /></div>
          </div>
        </div>
      )}
    </div>
  );
}
