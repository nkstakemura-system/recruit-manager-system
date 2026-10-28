// 和暦（昭和・平成・令和）と西暦の変換。入力補助と表示だけに使い、保存する値は従来どおり西暦。
// 改元日：昭和 1926-12-25〜1989-01-07、平成 1989-01-08〜2019-04-30、令和 2019-05-01〜。

export const ERAS = [
  { id: "showa", name: "昭和", start: "1926-12-25", end: "1989-01-07", offset: 1925 },
  { id: "heisei", name: "平成", start: "1989-01-08", end: "2019-04-30", offset: 1988 },
  { id: "reiwa", name: "令和", start: "2019-05-01", end: null, offset: 2018 },
];
const MAX_YEAR = 9999;
const eraById = id => ERAS.find(era => era.id === id);
const pad = (n, width = 2) => String(n).padStart(width, "0");
const eraYearLabel = year => (year === 1 ? "元" : String(year));

// 西暦4桁（0000年を除く）の実在日付か
export function isFourDigitDate(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 和暦の年として入力された文字列（全角数字・「元」に対応）。読めなければ null。
export function parseEraYear(text) {
  const value = String(text ?? "").trim().replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
  if (value === "元") return 1;
  return /^\d{1,4}$/.test(value) && Number(value) >= 1 ? Number(value) : null;
}

// 和暦の年のみ → 西暦の年。元年〜最終年（昭和64年・平成31年）までを受け付ける。
export function eraYearToYear(eraId, eraYear) {
  const era = eraById(eraId);
  if (!era) return { error: "元号を選択してください" };
  const year = parseEraYear(eraYear);
  if (year == null) return { error: "年を数字で入力してください" };
  const western = era.offset + year;
  const last = era.end ? Number(era.end.slice(0, 4)) : MAX_YEAR;
  if (western > last) return { error: `${era.name}は${last - era.offset}年までです` };
  return { year: western };
}

// 和暦の年月日 → 西暦の日付（YYYY-MM-DD）。その元号の期間外（昭和64年1月8日など）は受け付けない。
export function eraDateToDate(eraId, eraYear, month, day) {
  const yearResult = eraYearToYear(eraId, eraYear);
  if (yearResult.error) return yearResult;
  const m = parseEraYear(month);
  const d = parseEraYear(day);
  if (m == null || d == null || m > 12 || d > 31) return { error: "月日を正しく入力してください" };
  const date = `${pad(yearResult.year, 4)}-${pad(m)}-${pad(d)}`;
  if (!isFourDigitDate(date)) return { error: "存在しない日付です" };
  const era = eraById(eraId);
  if (date < era.start) return { error: `${era.name}は${dateLabel(era.start)}からです` };
  if (era.end && date > era.end) return { error: `${era.name}は${dateLabel(era.end)}までです` };
  return { date };
}

// 西暦の日付 → 和暦（元号は日付で一意に決まる）。昭和より前・不正な日付は null。
export function dateToEra(value) {
  if (!isFourDigitDate(value)) return null;
  const era = [...ERAS].reverse().find(e => value >= e.start);
  if (!era) return null;
  const year = Number(value.slice(0, 4)) - era.offset;
  return { eraId: era.id, eraName: era.name, year, month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
}

export function dateLabel(value) {
  const era = dateToEra(value);
  return era ? `${era.eraName}${eraYearLabel(era.year)}年${era.month}月${era.day}日` : "";
}

// 西暦の年 → その年に含まれる和暦すべて（1989年は昭和64年・平成元年、2019年は平成31年・令和元年）。
// 年だけでは月日が分からないため、どちらか一方に決めない。
export function yearToEras(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}$/.test(text) || text === "0000") return [];
  const year = Number(text);
  return ERAS
    .filter(era => Number(era.start.slice(0, 4)) <= year && (!era.end || Number(era.end.slice(0, 4)) >= year))
    .map(era => ({ eraId: era.id, eraName: era.name, year: year - era.offset }));
}

export const yearLabel = value => yearToEras(value).map(e => `${e.eraName}${eraYearLabel(e.year)}年`).join("・");

// 和暦入力を開いたときの初期値。年が複数の元号にまたがる場合は新しい元号（例：1989年→平成元年）。
// どちらを選んでも同じ西暦の年に戻るため、入力済みの値は変わらない。
export function yearToEraInput(value) {
  const eras = yearToEras(value);
  const last = eras.at(-1);
  return last ? { eraId: last.eraId, year: String(last.year) } : null;
}
