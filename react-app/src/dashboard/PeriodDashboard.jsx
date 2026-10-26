// 期別ダッシュボード（第3弾）。期の実績は選考履歴の事実（/api/dashboard/facts）から集計し、
// 現在の選考状況は応募者一覧の現在値から表示する（過去の状態は復元しない）。
// 部長会・モバイルは従来の集計定義のまま（shared/hrSummary.mjs）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api";
import { getPlannedJoiners, calendarDate } from "../../../shared/hrSummary.mjs";
import { availablePeriods, buildPeriodMetrics, periodInfo, periodOf } from "../../../shared/recruitMetrics.mjs";
import "./dashboard.css";

const yen = value => `¥${Math.round(value).toLocaleString()}`;
const slash = date => date.replaceAll("-", "/");
const monthLabel = month => `${Number(month.slice(5, 7))}月`;

// 現在の選考状況（個人応募・論理削除と退職を除く）。入社済みは入社日が未来の人だけ「入社前」に残す
const PIPELINE = [
  { status: "1", label: "受付" },
  { status: "2", label: "面接打診中" },
  { status: "3", label: "1次面接" },
  { status: "4", label: "2次以降の面接" },
  { status: "5", label: "内定・入社予定" },
  { status: "6", label: "入社前" },
];
function currentPipeline(cands, asOf) {
  const live = cands.filter(c => {
    if (c.is_coop || c.is_deleted || c.is_retired) return false;
    const st = String(c.status);
    if (st === "6") return Boolean(c.expected_join_date) && String(c.expected_join_date).slice(0, 10) > asOf;
    return ["1", "2", "3", "4", "5"].includes(st);
  });
  return PIPELINE.map(p => ({ ...p, count: live.filter(c => String(c.status) === p.status).length }));
}

// 数値の精度に関わる短い注意（詳しい内容はツールチップ）
const Note = ({ text, title, alert }) => (
  <span className={`nks-kpi-note${alert ? " is-alert" : ""}`} title={title}>{text}</span>
);

// KPIカード：見出し・大きな数字・単位。内訳・注意は数字の直下に左詰め
function KpiCard({ id, title, value, unit, tone, children }) {
  return (
    <div className={`nks-kpi-card${tone ? ` is-${tone}` : ""}`} data-kpi={id}>
      <span className="nks-kpi-title">{title}</span>
      <span className="nks-kpi-figure"><b className="nks-kpi-num">{value}</b>{unit && <span className="nks-kpi-unit">{unit}</span>}</span>
      {children}
    </div>
  );
}

const SERIES = [
  { key: "applied", label: "応募", className: "is-applied" },
  { key: "interviews", label: "面談回数", className: "is-interviews" },
  { key: "offers", label: "内定", className: "is-offers", ids: "offer_ids" },
  { key: "joins", label: "入社", className: "is-joins", ids: "join_ids" },
];

// 未到来の月はバーを出さない。内定・入社のバー（1件以上）は対象者を表示できるボタン
function MonthlyChart({ months, nowMonth, onOpen }) {
  const max = Math.max(1, ...months.filter(m => m.month <= nowMonth).flatMap(m => SERIES.map(s => m[s.key])));
  return (
    <div className="nks-chart-plot">
      {months.map(m => {
        const future = m.month > nowMonth;
        return (
          <div key={m.month} className={`nks-chart-col${future ? " is-future" : ""}`}>
            <div className="nks-chart-bars">
              {!future && SERIES.map(s => {
                const value = m[s.key];
                const style = { height: `${(value / max) * 100}%` };
                const label = value > 0 && <em>{value}</em>;
                return s.ids && value > 0 ? (
                  <button key={s.key} type="button" className={`nks-bar ${s.className} is-clickable`} style={style}
                    data-series={s.key} data-month={m.month}
                    aria-label={`${monthLabel(m.month)}の${s.label} ${value}名を表示`}
                    onClick={e => onOpen(e.currentTarget, m, s)}>{label}</button>
                ) : (
                  <span key={s.key} className={`nks-bar ${s.className}`} style={style} title={`${monthLabel(m.month)} ${s.label} ${value}`}>{label}</span>
                );
              })}
            </div>
            <span className="nks-chart-month">{monthLabel(m.month)}</span>
          </div>
        );
      })}
    </div>
  );
}

// 内定・入社の対象者（氏名・配属予定部署のみ）。Esc・閉じるボタン・外側クリックで閉じる
function PeoplePopover({ detail, onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="nks-pop-backdrop print-hide" onClick={onClose}>
      <div className="nks-pop" role="dialog" aria-modal="true" aria-labelledby="nks-pop-title" onClick={e => e.stopPropagation()}>
        <div className="nks-pop-head">
          <strong id="nks-pop-title">{detail.title}</strong>
          <button ref={closeRef} type="button" className="nks-pop-close" aria-label="閉じる" onClick={onClose}>×</button>
        </div>
        <ul className="nks-pop-list">
          {detail.people.map(p => (
            <li key={p.id}><span className="nks-pop-name">{p.name}</span><span className="nks-pop-dept">{p.dept}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function PeriodDashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState(null);
  const [detail, setDetail] = useState(null);
  const trigger = useRef(null);

  useEffect(() => {
    const json = path => apiFetch(path).then(r => {
      if (!r.ok) throw new Error(path);
      return r.json();
    });
    Promise.all([json("/api/dashboard/facts"), json("/api/expenses"), json("/api/candidates")])
      .then(([facts, expenses, cands]) => setData({ ...facts, expenses, cands }))
      .catch(() => setError("ダッシュボードの集計データを読み込めませんでした。再読み込みしてください。"));
  }, []);

  const asOf = data?.as_of || calendarDate();
  const periods = useMemo(() => data ? availablePeriods(data.facts, data.expenses, asOf) : [], [data, asOf]);
  const current = periodOf(asOf);
  const selected = period ?? current;
  // 期計・KPIは実績が確定している日（今日）までの記録で集計する
  const m = useMemo(() => data ? buildPeriodMetrics({ facts: data.facts, expenses: data.expenses, period: selected, asOf, until: asOf }) : null,
    [data, selected, asOf]);
  const byId = useMemo(() => new Map((data?.cands || []).map(c => [String(c.id), c])), [data]);

  const closeDetail = useCallback(() => {
    setDetail(null);
    trigger.current?.focus();
  }, []);
  const openDetail = (button, row, series) => {
    trigger.current = button;
    const people = row[series.ids].map(id => {
      const c = byId.get(String(id));
      return { id, name: c?.name_kanji || "—", dept: (c?.planned_department || "").trim() || "—" };
    });
    setDetail({ title: `${row.month.slice(0, 4)}年${monthLabel(row.month)}の${series.label}（${people.length}名）`, people });
  };

  if (error) return <div className="nks-dash"><p className="nks-dash-error" role="alert">{error}</p></div>;
  if (!data || !m) return <div className="nks-dash">読み込み中...</div>;

  const t = m.totals;
  const ref = m.reference;
  const nowMonth = asOf.slice(0, 7);
  const index = periods.indexOf(selected);
  const pipeline = currentPipeline(data.cands, asOf);
  const pipelineTotal = pipeline.reduce((sum, p) => sum + p.count, 0);
  const pipelineMax = Math.max(1, ...pipeline.map(p => p.count));
  const joiners = getPlannedJoiners(data.cands, asOf).slice(0, 3);
  const undatedEnded = ref.undated_ended.rejected + ref.undated_ended.no_contact + ref.undated_ended.declined;
  const cell = (row, value) => (row.month > nowMonth ? "" : value);

  return (
    <div className="nks-dash">
      <style>{`@media print { @page { size: A4 portrait; margin: 10mm; } nav { display: none !important; } }`}</style>
      <header className="nks-dash-head">
        <div className="nks-dash-title">
          <h2>採用ダッシュボード</h2>
          <span>{m.label}の実績 ／ {slash(m.start)}〜{slash(m.end)} ／ 個人応募・{slash(asOf)} 時点</span>
        </div>
        <div className="nks-dash-tools">
          <div className="nks-period" role="group" aria-label="期の選択">
            <button type="button" aria-label="前の期" disabled={index < 0 || index >= periods.length - 1}
              onClick={() => setPeriod(periods[index + 1])}>◀</button>
            <select value={selected} onChange={e => setPeriod(Number(e.target.value))} aria-label="表示する期">
              {periods.map(p => <option key={p} value={p}>{periodInfo(p).label}（{periodInfo(p).span}）</option>)}
            </select>
            <button type="button" aria-label="次の期" disabled={index <= 0} onClick={() => setPeriod(periods[index - 1])}>▶</button>
          </div>
          {m.is_current
            ? <span className="nks-period-tag">当期</span>
            : <button type="button" className="nks-dash-btn print-hide" onClick={() => setPeriod(current)}>当期へ</button>}
          <button type="button" className="nks-dash-btn print-hide" onClick={() => window.print()}>A4印刷</button>
        </div>
      </header>

      {!data.history_table && (
        <p className="nks-dash-alert">選考履歴テーブルが未作成のため、面接実績は0件です。</p>
      )}

      <div className="nks-kpi-grid">
        <KpiCard id="applied" title="応募数" value={t.applied} unit="名">
          {t.coop_applied > 0 && <Note text={`協力業者 ${t.coop_applied}件は別`} />}
        </KpiCard>
        <KpiCard id="interviewed" title="面接実績" value={t.interviewed} unit="人">
          {ref.unconfirmed_interviews > 0 && (
            <Note text="実施未確認あり" title={`旧データで予定日を過ぎた面接 ${ref.unconfirmed_interviews}回（${ref.unconfirmed_people}人）は、実施の記録が無いため含めていません`} />
          )}
          {ref.undated_interview_people > 0 && (
            <Note text={`面接日不明 ${ref.undated_interview_people}人あり`} title={`旧データで面接日が無い面接 ${ref.undated_interviews}回（${ref.undated_interview_people}人）は、どの期にも含めていません`} />
          )}
        </KpiCard>
        <KpiCard id="interviews" title="面談回数" value={t.interviews} unit="回">
          <span className="nks-kpi-breakdown">
            {t.interview_stages.map(s => <span key={s.stage}>{s.stage}次 <b>{s.count}</b>回</span>)}
          </span>
        </KpiCard>
        <KpiCard id="offers" title="内定数" value={t.offers} unit="名">
          {ref.undated_offers > 0 && (
            <Note text={`内定日不明 ${ref.undated_offers}名あり`} title="旧データで内定日が無いため、どの期にも含めていません" />
          )}
        </KpiCard>
        <KpiCard id="joins" title="入社数" value={t.joins} unit="名">
          {t.legacy_joins > 0 && <Note text={`旧データ ${t.legacy_joins}名含む`} title="旧データは進捗「入社」と従来の入社日欄で計上しています" />}
          {ref.undated_joins > 0 && <Note text={`入社日不明 ${ref.undated_joins}名あり`} title="入社日が無いため、どの期にも含めていません" />}
        </KpiCard>
      </div>

      <div className="nks-dash-row2">
        <KpiCard id="ended" title="終了実績" value={t.rejected + t.declined} unit="名" tone="end">
          <span className="nks-kpi-breakdown is-end">
            <span>不採用 <b>{t.rejected}</b>名</span>
            <span>辞退 <b>{t.declined}</b>名</span>
          </span>
          {t.no_contact > 0 && <Note text={`不採用のうち音信不通 ${t.no_contact}名`} />}
          {undatedEnded > 0 && <Note text={`終了日不明 ${undatedEnded}名あり`} title="旧データで終了日が無いため、どの期にも含めていません" />}
        </KpiCard>
        <div className="nks-kpi-card nks-cost-card" data-kpi="cost">
          <span className="nks-kpi-title">採用経費</span>
          <span className="nks-kpi-figure">
            <b className="nks-kpi-num" data-cost="expense">{yen(t.expense)}</b>
            <span className="nks-cost-joins">/ <b data-cost="joins">{t.joins}</b>人</span>
          </span>
          <span className="nks-kpi-figure nks-cost-unit">
            <b data-cost="unit">{t.cost_per_join == null ? "—" : yen(t.cost_per_join)}</b>
            <span className="nks-kpi-unit">※採用単価</span>
          </span>
          {ref.undated_joins > 0 && <Note alert text="入社日不明あり・単価は不完全" title="入社日が無い旧データは入社人数に含まれていません" />}
        </div>
      </div>

      <section className="nks-dash-card nks-now" aria-label="現在の選考状況">
        <h3>現在の選考状況 <small>現在値（{slash(asOf)} 時点・期の選択とは連動しません）・進行中 {pipelineTotal}名</small></h3>
        <div className="nks-now-grid">
          {pipeline.map(p => (
            <div key={p.status} className="nks-now-item">
              <span className="nks-now-label">{p.label}</span>
              <b>{p.count}</b>
              <span className="nks-now-bar"><i style={{ width: `${(p.count / pipelineMax) * 100}%` }} /></span>
            </div>
          ))}
        </div>
        <div className="nks-now-joiners">
          <span className="nks-now-label">直近の入社予定</span>
          {joiners.length ? joiners.map(c => (
            <span key={c.id} className="nks-now-joiner">
              {slash(c.expected_join_date).slice(5)}{" "}
              <button type="button" className="nks-link" onClick={() => navigate(`/candidates/${c.id}`)}>{c.name_kanji}</button>
            </span>
          )) : <span className="nks-dash-muted">なし</span>}
        </div>
      </section>

      <section className="nks-dash-card">
        <div className="nks-chart-head">
          <h3>月別推移 <small>{m.label}（{m.span}）・内定／入社のバーで対象者を表示</small></h3>
          <div className="nks-chart-legend">
            {SERIES.map(s => <span key={s.key}><i className={s.className} />{s.label}</span>)}
          </div>
        </div>
        <MonthlyChart months={m.months} nowMonth={nowMonth} onOpen={openDetail} />
        <div className="nks-period-total" aria-label="期計">
          <strong>期計{m.is_current ? `（${Number(nowMonth.slice(5, 7))}月${Number(asOf.slice(8, 10))}日まで）` : ""}</strong>
          <span>応募 <b>{t.applied}</b></span>
          <span>面接実績 <b>{t.interviewed}</b>人</span>
          <span>面談 <b>{t.interviews}</b>回</span>
          <span>内定 <b>{t.offers}</b></span>
          <span>入社 <b>{t.joins}</b></span>
          <span>不採用 <b>{t.rejected}</b></span>
          <span>辞退 <b>{t.declined}</b></span>
          <span>経費 <b>{yen(t.expense)}</b></span>
        </div>
        <details className="nks-fold nks-month-detail">
          <summary>月別詳細表</summary>
          <div className="nks-month-wrap">
            <table className="nks-month-table">
              <thead>
                <tr><th>月</th><th>応募</th><th>協力業者</th><th>面接実績</th><th>面談回数</th><th>内定</th><th>入社</th><th>不採用</th><th>辞退</th><th>採用経費</th></tr>
              </thead>
              <tbody>
                {m.months.map(row => (
                  <tr key={row.month} className={row.month > nowMonth ? "is-future" : ""}>
                    <td>{row.month.slice(0, 4)}/{Number(row.month.slice(5, 7))}</td>
                    <td>{cell(row, row.applied)}</td><td>{cell(row, row.coop_applied)}</td>
                    <td>{cell(row, `${row.interviewed}人`)}</td><td>{cell(row, `${row.interviews}回`)}</td>
                    <td>{cell(row, row.offers)}</td><td>{cell(row, row.joins)}</td>
                    <td>{cell(row, row.rejected)}</td><td>{cell(row, row.declined)}</td><td>{cell(row, yen(row.expense))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>期計</td><td>{t.applied}</td><td>{t.coop_applied}</td><td>{t.interviewed}人</td><td>{t.interviews}回</td>
                  <td>{t.offers}</td><td>{t.joins}</td><td>{t.rejected}</td><td>{t.declined}</td><td>{yen(t.expense)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </details>
      </section>

      {detail && <PeoplePopover detail={detail} onClose={closeDetail} />}
    </div>
  );
}
