// DATE input is optional; omitted means preserve, explicit null/empty means clear.
function normalizeOfferDate(value) {
  if (value === null || value === "" || value === undefined) return null;
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Invalid offer date");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError("Invalid offer date");
  return value;
}
const todayTokyo = (now = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
function initialOfferDate(status, value, today = todayTokyo()) {
  return normalizeOfferDate(value) || (String(status) === "5" ? today : null);
}
// PostgreSQL SET expressions use the pre-update row. No read/update race or backfill.
const offerDateUpdateSql = `offer_date=CASE
  WHEN $65::boolean AND $66::date IS NOT NULL THEN $66::date
  WHEN offer_date IS NULL AND status::text IS DISTINCT FROM '5' AND $7::text = '5' THEN $67::date
  WHEN $65::boolean THEN $66::date
  ELSE offer_date END`;
module.exports = { normalizeOfferDate, initialOfferDate, todayTokyo, offerDateUpdateSql };