import { createContext, useContext, useEffect, useId } from "react";

// 入力途中・不正な和暦や年（保存値は直前の有効な値のまま）を親の保存処理へ知らせる。
// 値は (欄の識別子, エラー文) を受け取る関数。エラーが残っている間は保存しない。
export const WarekiErrorContext = createContext(null);
export function useReportError(error) {
  const report = useContext(WarekiErrorContext);
  const id = useId();
  useEffect(() => {
    report?.(id, error);
    return () => report?.(id, "");
  }, [report, id, error]);
}

// 年のみの欄で受け付けない西暦（5桁以上の数字）。その他の既存の記載（例：2015年4月）は従来どおり変更しない
export const LONG_YEAR_ERROR = "西暦4桁で入力してください";
export const isLongYear = (value) => /^\s*\d{5,}\s*$/.test(String(value ?? ""));
