// 月別推移グラフ（1指標ずつ切り替える大きな棒グラフ・1軸）。
// * 値は monthAggregate の集計結果をそのまま使う。データの無い月を0件で補完しない。
// * 未登録（記録なし）・未取得（記録はあるが項目が空欄）・期間重複（合算しない）・0件を区別し、未到来の月は空欄にする。
// * PCは縦棒、スマートフォン幅では横棒（月を行）にしてラベルを読めるようにする（CSSで切り替え）。
import React, { useState } from "react";
import { fmtCount, fmtRate, monthLabel } from "../../../shared/jobMarketing.mjs";
import { Segmented } from "./MarketingForms";

const OPTIONS = [
  ["impressions", "表示回数", "回"], ["clicks", "クリック数", "回"], ["apply_starts", "応募開始数", "件"],
  ["applies", "応募数", "件"], ["ctr", "クリック率（CTR）", ""],
];

function cellOf(m, metric) {
  if (m.future) return { kind: "future", text: "" };
  if (m.status === "empty") return { kind: "none", text: "未登録" };
  if (m.status === "overlap") return { kind: "overlap", text: "重複" };
  const v = metric === "ctr" ? m.rates.ctr : m.totals[metric];
  if (v == null) return { kind: "missing", text: "未取得" };
  return { kind: "value", v, text: metric === "ctr" ? fmtRate(v) : fmtCount(v), partial: !m.complete };
}

function note(m) {
  if (m.future) return "未到来";
  if (m.status === "empty") return "実績の登録なし";
  if (m.status === "overlap") return "期間が重なる記録があるため合算していません";
  const parts = [];
  if (m.in_progress) parts.push(`集計途中・${m.covered_days}日分`);
  else if (m.missing_dates.length) parts.push(`${m.covered_days}/${m.days_in_month}日分`);
  else parts.push("全日分");
  if (m.plan_types.includes("paid")) parts.push(m.plan === "mixed" ? "月の途中で掲載方法を変更" : "有料掲載");
  return parts.join("・");
}

export default function MonthlyChart({ series, selectedMonth }) {
  const [metric, setMetric] = useState("impressions");
  const [active, setActive] = useState(null);
  const [, label, unit] = OPTIONS.find(o => o[0] === metric);
  const cells = series.map(m => ({ m, ...cellOf(m, metric) }));
  const max = Math.max(1, ...cells.filter(c => c.kind === "value").map(c => c.v));
  return (
    <div className="jm-chart-wrap">
      <Segmented name="chart-metric" label="グラフの指標" options={OPTIONS.map(([k, l]) => [k, l])} value={metric} onChange={v => { setMetric(v); setActive(null); }} />
      <div className="jm-chart" role="list" aria-label={`${label}の月別推移`} onMouseLeave={() => setActive(null)}>
        {cells.map((c, i) => {
          const share = c.kind === "value" ? c.v / max : 0;
          const tip = `${monthLabel(c.m.month)}：${label} ${c.kind === "value" ? `${c.text}${unit}` : c.text || "—"}（${note(c.m)}）`;
          return (
            <div key={c.m.month} role="listitem" tabIndex={c.kind === "future" ? -1 : 0} aria-label={tip}
              className={`jm-chart-col is-${c.kind}${c.partial ? " is-partial" : ""}${c.m.month === selectedMonth ? " is-selected" : ""}${active === i ? " is-active" : ""}`}
              style={{ "--v": share }}
              onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} onClick={() => setActive(active === i ? null : i)}>
              <span className="jm-chart-month">{Number(c.m.month.slice(5, 7))}月</span>
              <span className="jm-chart-area">
                {c.kind === "value" && <i className="jm-chart-bar" />}
                <span className="jm-chart-value">{c.text}</span>
              </span>
              {active === i && c.kind !== "future" && <span className="jm-chart-tip" role="tooltip">{tip}</span>}
            </div>
          );
        })}
      </div>
      <p className="jm-legend">
        <i className="is-bar" />全日分<i className="is-partial" />未収集日あり・集計途中
        <span>「未登録」は記録なし、「未取得」は項目が空欄（どちらも0件ではありません）</span>
      </p>
    </div>
  );
}
