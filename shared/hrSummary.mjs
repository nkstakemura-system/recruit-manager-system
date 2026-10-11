export const calendarDate = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);

const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
const dateOnly = value => value instanceof Date
  ? calendarDate(value)
  : typeof value === "string" ? value.slice(0, 10) : "";
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

export function buildHrSummary(candidates, asOf = calendarDate()) {
  const active = candidates.filter(candidate => isActiveApplicant(candidate, asOf));
  const statuses = { received: "1", contacting: "2", interview1: "3", interview2: "4", offered: "5" };
  const counts = Object.fromEntries(Object.entries(statuses).map(([name, status]) =>
    [name, active.filter(candidate => String(candidate.status) === status).length]));
  const planned_joiners = getPlannedJoiners(active, asOf);
  return { as_of: asOf, counts: { ...counts, planned_join: planned_joiners.length }, planned_joiners };
}