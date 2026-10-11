export const calendarDate = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);

const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
const dateOnly = value => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? calendarDate(value) : "";
  if (typeof value !== "string") return "";
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? calendarDate(date) : "";
  }
  return value.slice(0, 10);
};
const flagged = value => value === true || value === "true" || value === "t" || value === 1;

export function isActiveApplicant(candidate, asOf) {
  const retiredOn = dateOnly(candidate.retirement_date);
  return !flagged(candidate.is_coop) && !flagged(candidate.is_deleted) &&
    !flagged(candidate.is_retired) && (!retiredOn || retiredOn > asOf);
}

export function getPlannedJoiners(candidates, asOf = calendarDate()) {
  return candidates.filter(candidate => {
    const date = dateOnly(candidate.expected_join_date);
    return isActiveApplicant(candidate, asOf) &&
      ["5", "6"].includes(String(candidate.status)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= asOf;
  }).map(candidate => ({
    id: candidate.id,
    name_kanji: text(candidate.name_kanji),
    expected_join_date: dateOnly(candidate.expected_join_date),
    planned_department: text(candidate.planned_department),
    job_title: text(candidate.job_title),
    employment_type: text(candidate.employment_type),
  })).sort((a, b) => a.expected_join_date.localeCompare(b.expected_join_date));
}

export function reportMonth(value, asOf = calendarDate()) {
  const month = value === undefined ? asOf.slice(0, 7) : value;
  if (typeof month !== "string" || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new RangeError("Invalid report month");
  }
  return month;
}

// Until completion flags exist, interview dates on/before today count as conducted.
export function countCompletedInterviews(candidates, month, asOf) {
  return candidates.reduce((total, candidate) => total +
    [candidate.interview_1_date, candidate.interview_2_date].filter(value => {
      const date = dateOnly(value);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && date.startsWith(month + "-") && date <= asOf;
    }).length, 0);
}

export function monthlyResults(candidates, month, asOf = calendarDate()) {
  const active = candidates.filter(candidate => isActiveApplicant(candidate, asOf));
  const inMonth = value => /^\d{4}-\d{2}-\d{2}$/.test(dateOnly(value)) && dateOnly(value).startsWith(month + "-");
  return {
    received: active.filter(candidate => inMonth(candidate.applied_at)).length,
    interviews: countCompletedInterviews(active, month, asOf),
    offers: active.filter(candidate => inMonth(candidate.offer_date)).length,
  };
}

export function buildHrSummary(candidates, asOf = calendarDate(), requestedMonth) {
  const report_month = reportMonth(requestedMonth, asOf);
  const active = candidates.filter(candidate => isActiveApplicant(candidate, asOf));
  const statuses = { received: "1", contacting: "2", interview1: "3", interview2: "4", offered: "5" };
  const counts = Object.fromEntries(Object.entries(statuses).map(([name, status]) =>
    [name, active.filter(candidate => String(candidate.status) === status).length]));
  const planned_joiners = getPlannedJoiners(active, asOf);
  return { as_of: asOf, report_month, counts: { ...counts, planned_join: planned_joiners.length }, monthly: monthlyResults(active, report_month, asOf), current: { in_selection: active.filter(candidate => ["1", "2", "3", "4"].includes(String(candidate.status))).length, planned_join: planned_joiners.length }, planned_joiners };
}