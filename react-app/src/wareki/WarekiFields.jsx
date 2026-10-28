import { useState } from "react";
import {
  ERAS, dateLabel, dateToEra, eraDateToDate, eraYearToYear, isFourDigitDate, yearLabel, yearToEraInput,
} from "../../../shared/wareki.mjs";
import { LONG_YEAR_ERROR, isLongYear, useReportError } from "./warekiErrors";
import "./wareki.css";

// 和暦入力の切替（対象項目の見出しの横に置く）。表示の切替だけで、入力済みの値は変更しない。
export function WarekiToggle({ checked, onChange, label = "和暦入力" }) {
  return (
    <label className="nks-wareki-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function EraSelect({ value, onChange, label }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={`${label}の元号`} className="nks-wareki-era">
      {ERAS.map((era) => <option key={era.id} value={era.id}>{era.name}</option>)}
    </select>
  );
}

const NumberBox = ({ value, onChange, label }) => (
  <input
    type="text"
    inputMode="numeric"
    value={value}
    onChange={(event) => onChange(event.target.value)}
    aria-label={label}
    className="nks-wareki-num"
  />
);

// 日付（生年月日など）：標準カレンダー（type="date"）はそのまま使い、和暦入力では元号・年・月・日から西暦の日付を入れる。
// 保存する値は従来どおり YYYY-MM-DD。
export function DateWithWareki({ value, onChange, wareki, label, inputProps = {}, style }) {
  const invalid = Boolean(value) && !isFourDigitDate(value);
  useReportError(!wareki && invalid ? `${label}は西暦4桁の正しい日付で入力してください` : "");
  return (
    <div className="nks-wareki-field">
      <input type="date" min="1000-01-01" max="9999-12-31" value={value || ""}
        onChange={(event) => onChange(event.target.value)} aria-label={label} style={style} {...inputProps} />
      {wareki
        ? <EraDateRow value={value} onChange={onChange} label={label} />
        : invalid
          ? <div className="nks-wareki-error" role="alert">西暦4桁の正しい日付で入力してください</div>
          : value && dateLabel(value) && <div className="nks-wareki-hint">{dateLabel(value)}</div>}
    </div>
  );
}

function datePartsOf(value) {
  const era = dateToEra(value);
  return era
    ? { era: era.eraId, year: String(era.year), month: String(era.month), day: String(era.day) }
    : { era: "showa", year: "", month: "", day: "" };
}

function EraDateRow({ value, onChange, label }) {
  const [parts, setParts] = useState(() => datePartsOf(value));
  const [error, setError] = useState("");
  const [synced, setSynced] = useState(value);
  const [emitted, setEmitted] = useState(value);
  // カレンダーで選んだ・読み直したなど、この欄以外から値が変わった場合は和暦の欄も合わせる
  if (value !== synced) {
    setSynced(value);
    if (value !== emitted) {
      setEmitted(value);
      setParts(datePartsOf(value));
      setError("");
    }
  }
  useReportError(error && `${label}：${error}`);

  const emit = (next) => {
    setEmitted(next);
    onChange(next);
  };
  const update = (key, input) => {
    const next = { ...parts, [key]: input };
    setParts(next);
    const filled = [next.year, next.month, next.day].filter((v) => String(v).trim()).length;
    // 年月日をすべて消した場合は日付を消す（元号の選択だけでは変えない）。一部だけの入力は確定するまで保存しない
    if (filled === 0) { setError(""); return key === "era" ? undefined : emit(""); }
    if (filled < 3) return setError("年月日をすべて入力してください");
    const result = eraDateToDate(next.era, next.year, next.month, next.day);
    if (result.error) return setError(result.error);
    setError("");
    emit(result.date);
  };

  return (
    <div className="nks-wareki-row">
      <EraSelect value={parts.era} onChange={(v) => update("era", v)} label={label} />
      <NumberBox value={parts.year} onChange={(v) => update("year", v)} label={`${label}の和暦の年`} />年
      <NumberBox value={parts.month} onChange={(v) => update("month", v)} label={`${label}の月`} />月
      <NumberBox value={parts.day} onChange={(v) => update("day", v)} label={`${label}の日`} />日
      {error && <span className="nks-wareki-error" role="alert">{error}</span>}
    </div>
  );
}

// 年のみの項目（卒業年・入社年・退社年・資格の取得年）。保存する値は従来どおり西暦の年の文字列。
// 西暦入力では枠外に和暦を表示する（1989年・2019年のように複数の元号にまたがる年は両方を表示し、月日は推測しない）。
export function YearWithWareki({ value, onChange, wareki, label, placeholder, style }) {
  if (wareki) return <EraYearInput value={value} onChange={onChange} label={label} />;
  return <WesternYearInput value={value} onChange={onChange} label={label} placeholder={placeholder} style={style} />;
}

function WesternYearInput({ value, onChange, label, placeholder, style }) {
  const tooLong = isLongYear(value);
  useReportError(tooLong ? `${label}は${LONG_YEAR_ERROR}` : "");
  const hint = yearLabel(value);
  return (
    <div className="nks-wareki-field">
      <input type="text" value={value || ""} onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder} aria-label={label} style={style} />
      {tooLong
        ? <div className="nks-wareki-error" role="alert">{LONG_YEAR_ERROR}</div>
        : hint && <div className="nks-wareki-hint">{hint}</div>}
    </div>
  );
}

// 値から和暦の欄を求める（西暦4桁の年のみ。それ以外の記載は変更しない）
function yearPartsOf(value) {
  const initial = yearToEraInput(value);
  return initial ? { era: initial.eraId, year: initial.year } : { era: "heisei", year: "" };
}

function EraYearInput({ value, onChange, label }) {
  const [parts, setParts] = useState(() => yearPartsOf(value));
  const [error, setError] = useState("");
  const [synced, setSynced] = useState(value);
  const [emitted, setEmitted] = useState(value);
  // 行の削除・読み直しなどで、この欄以外から値が変わった場合は和暦の欄も合わせる（別の行の入力を引き継がない）
  if (value !== synced) {
    setSynced(value);
    if (value !== emitted) {
      setEmitted(value);
      setParts(yearPartsOf(value));
      setError("");
    }
  }
  // 西暦欄で入力した5桁以上の年は、和暦入力に切り替えても保存を止めたままにする
  const shown = error || (isLongYear(value) ? LONG_YEAR_ERROR : "");
  useReportError(shown && `${label}：${shown}`);

  const emit = (next) => {
    setEmitted(next);
    onChange(next);
  };
  const update = (key, input) => {
    const next = { ...parts, [key]: input };
    setParts(next);
    // 年を消した場合は値を消す（元号の選択だけでは変えない）
    if (!String(next.year).trim()) {
      setError("");
      return key === "year" ? emit("") : undefined;
    }
    const result = eraYearToYear(next.era, next.year);
    if (result.error) return setError(result.error);
    setError("");
    emit(String(result.year));
  };
  const converted = /^\d{4}$/.test(String(value || "")) ? `${value}年` : value ? `現在：${value}` : "";
  return (
    <div className="nks-wareki-field">
      <div className="nks-wareki-row">
        <EraSelect value={parts.era} onChange={(v) => update("era", v)} label={label} />
        <NumberBox value={parts.year} onChange={(v) => update("year", v)} label={`${label}の和暦の年`} />年
      </div>
      <div className={shown ? "nks-wareki-error" : "nks-wareki-hint"} role={shown ? "alert" : undefined}>
        {shown ? (error || `${LONG_YEAR_ERROR}（現在：${value}）`) : converted}
      </div>
    </div>
  );
}
