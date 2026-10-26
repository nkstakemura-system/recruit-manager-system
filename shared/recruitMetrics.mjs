// 期別の採用実績（Webダッシュボード用）。DBに接続しない純粋関数のみ。
// NKSの期は8月1日〜翌7月31日（2026/8〜2027/7 が54期）。
//
// facts は /api/dashboard/facts が選考履歴から作る応募者ごとの事実（api-server/dashboardFacts.js）。
// 日付が不明な工程（date: null）は他の日付で補わず、期別実績に入れずに参考件数として返す。
// 論理削除・終了した応募者も、過去の実績として集計に含める。協力業者は受付件数のみ数える。
// 部長会・モバイルの集計（shared/hrSummary.mjs ほか）とは定義が異なる（未統一）。

const FIRST_YEAR = 1972; // 1972/8〜1973/7 を0期とすると、2026/8〜 が54期
const isDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const tokyoDay = date => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(date);

// 経費日など、API から日付・日時のどちらで届いても日本時間の日付にそろえる
export function dayOf(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? tokyoDay(value) : null;
  if (typeof value !== "string") return null;
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? tokyoDay(date) : null;
  }
  return isDay(value.slice(0, 10)) ? value.slice(0, 10) : null;
}

export function periodOf(date) {
  const year = Number(date.slice(0, 4));
  return (Number(date.slice(5, 7)) >= 8 ? year : year - 1) - FIRST_YEAR;
}

export function periodInfo(period) {
  const year = period + FIRST_YEAR;
  return { period, label: `${period}期`, start: `${year}-08-01`, end: `${year + 1}-07-31`, span: `${year}/8〜${year + 1}/7` };
}

export function periodMonths(period) {
  const year = period + FIRST_YEAR;
  return Array.from({ length: 12 }, (_, i) => {
    const month = ((7 + i) % 12) + 1;
    return `${month >= 8 ? year : year + 1}-${String(month).padStart(2, "0")}`;
  });
}

// 選択できる期（当期から、データのある最も古い期まで。新しい順）
export function availablePeriods(facts, expenses, asOf) {
  const current = periodOf(asOf);
  let oldest = current;
  const see = date => { if (isDay(date) && date <= asOf) oldest = Math.min(oldest, periodOf(date)); };
  for (const f of facts) {
    see(f.applied);
    for (const i of f.interviews || []) see(i.date);
    for (const d of f.offers || []) see(d);
    see(f.joined?.date);
    see(f.ended?.date);
  }
  for (const e of expenses) see(dayOf(e.expense_date));
  return Array.from({ length: current - oldest + 1 }, (_, i) => current - i);
}

const emptyRow = () => ({
  applied: 0, coop_applied: 0, interviewed: new Set(), interviews: 0, offers: new Set(), joins: new Set(),
  rejected: 0, no_contact: 0, declined: 0, expense: 0,
});
// 内定・入社は件数と同じ集合から応募者IDも返す（グラフから対象者を確認するため。氏名は持たない）
const finish = row => ({
  ...row, interviewed: row.interviewed.size, offers: row.offers.size, joins: row.joins.size,
  offer_ids: [...row.offers], join_ids: [...row.joins],
});

// until: 指定すると、その日より後の日付の記録を数えない（当期の確定済み実績だけにする表示用）
export function buildPeriodMetrics({ facts, expenses = [], period, asOf, until = null }) {
  const info = periodInfo(period);
  const months = periodMonths(period);
  const inPeriod = date => isDay(date) && date >= info.start && date <= info.end && (!until || date <= until);
  const total = emptyRow();
  const byMonth = new Map(months.map(month => [month, emptyRow()]));
  const stages = {};
  const legacyJoins = new Set();
  const reference = {
    unconfirmed_interviews: 0, unconfirmed_people: new Set(),
    undated_interviews: 0, undated_interview_people: 0,
    undated_offers: 0, undated_joins: 0, undated_ended: { rejected: 0, no_contact: 0, declined: 0 },
  };
  // 期内の日付なら期の合計と該当月の両方に加算する
  const add = (date, apply) => {
    if (!inPeriod(date)) return;
    apply(total);
    apply(byMonth.get(date.slice(0, 7)));
  };

  for (const f of facts) {
    if (f.coop) { add(f.applied, r => { r.coop_applied += 1; }); continue; }
    add(f.applied, r => { r.applied += 1; });
    for (const i of f.interviews || []) {
      add(i.date, r => { r.interviews += 1; r.interviewed.add(f.id); });
      if (inPeriod(i.date)) stages[i.stage] = (stages[i.stage] || 0) + 1;
    }
    for (const i of f.unconfirmed || []) {
      if (!inPeriod(i.date) || i.date > asOf) continue;
      reference.unconfirmed_interviews += 1;
      reference.unconfirmed_people.add(f.id);
    }
    // 日付不明の旧面接は期を判定できないため、全期間の参考件数として数える
    const undated = (f.undated_interviews || []).length;
    if (undated) { reference.undated_interviews += undated; reference.undated_interview_people += 1; }
    const offers = f.offers || [];
    if (offers.some(date => !isDay(date))) reference.undated_offers += 1;
    for (const date of offers) add(date, r => { r.offers.add(f.id); });
    if (f.joined) {
      if (!isDay(f.joined.date)) reference.undated_joins += 1;
      add(f.joined.date, r => { r.joins.add(f.id); });
      if (f.joined.legacy && inPeriod(f.joined.date)) legacyJoins.add(f.id);
    }
    if (f.ended) {
      if (!isDay(f.ended.date)) reference.undated_ended[f.ended.kind] += 1;
      add(f.ended.date, r => {
        if (f.ended.kind === "declined") r.declined += 1;
        else { r.rejected += 1; if (f.ended.kind === "no_contact") r.no_contact += 1; }
      });
    }
  }
  for (const e of expenses) add(dayOf(e.expense_date), r => { r.expense += Number(e.amount) || 0; });

  const totals = finish(total);
  // 1次・2次は常に表示し、3次以降は実績のある回だけ表示する
  const maxStage = Math.max(2, ...Object.keys(stages).map(Number));
  return {
    ...info,
    as_of: asOf,
    is_current: periodOf(asOf) === period,
    totals: {
      ...totals,
      interview_stages: Array.from({ length: maxStage }, (_, i) => ({ stage: i + 1, count: stages[i + 1] || 0 }))
        .filter(s => s.stage <= 2 || s.count > 0),
      legacy_joins: legacyJoins.size,
      // 採用単価 = 期の採用経費 ÷ 期の入社実人数（入社0名なら算出しない）
      cost_per_join: totals.joins ? Math.round(totals.expense / totals.joins) : null,
    },
    months: months.map(month => ({ month, ...finish(byMonth.get(month)) })),
    reference: { ...reference, unconfirmed_people: reference.unconfirmed_people.size },
  };
}
