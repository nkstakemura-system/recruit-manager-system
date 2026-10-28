// TEL・Email の入力補助（新規受付・連絡先モーダルで共通）
export const forceHalfWidthTel = (str) =>
  !str
    ? ""
    : str
        .replace(/[０-９]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[ー－]/g, "-")
        .replace(/[^0-9-]/g, "");
export const forceHalfWidthEmail = (str) =>
  !str
    ? ""
    : str
        .replace(/[Ａ-Ｚａ-ｚ０-９．＠＿－]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[^a-zA-Z0-9.@_-]/g, "");
export const formatTelOnBlur = (val) => {
  if (!val) return "";
  let v = val.replace(/[^0-9]/g, "");
  if (v.length === 10)
    return v.startsWith("03") || v.startsWith("06")
      ? `${v.slice(0, 2)}-${v.slice(2, 6)}-${v.slice(6, 10)}`
      : `${v.slice(0, 3)}-${v.slice(3, 6)}-${v.slice(6, 10)}`;
  if (v.length === 11)
    return `${v.slice(0, 3)}-${v.slice(3, 7)}-${v.slice(7, 11)}`;
  return v;
};
