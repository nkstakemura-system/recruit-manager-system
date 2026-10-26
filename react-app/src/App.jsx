import Auth from "./Auth";
import { apiFetch } from "./api";
import React, { useState, useEffect } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  useLocation,
  useParams,
  useNavigate,
} from "react-router-dom";
import RecruitmentStats from "./RecruitmentStats";
import SelectionModal from "./selection/SelectionModal";
import SelectionTimeline from "./selection/SelectionTimeline";
import Dashboard from "./dashboard/PeriodDashboard";
import { selectionApi, mirrorForForm, SELECTION_OWNED_FIELDS } from "./selection/selectionApi";

// --- 入力フィルター ---
const cleanText = (str) =>
  !str
    ? ""
    : str
        .replace(/[！-～]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[\s\u3000]+/g, "");
const forceHalfWidthNumber = (str) =>
  !str
    ? ""
    : str
        .replace(/[０-９]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[^0-9]/g, "");
const forceHalfWidthTel = (str) =>
  !str
    ? ""
    : str
        .replace(/[０-９]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[ー－]/g, "-")
        .replace(/[^0-9-]/g, "");
const forceHalfWidthEmail = (str) =>
  !str
    ? ""
    : str
        .replace(/[Ａ-Ｚａ-ｚ０-９．＠＿－]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[^a-zA-Z0-9.@_-]/g, "");
const toHalfWidth = (str) =>
  !str
    ? ""
    : str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) =>
        String.fromCharCode(s.charCodeAt(0) - 0xfee0),
      );
const formatTelOnBlur = (val) => {
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

// 生年月日から現在の年齢を自動計算
const calcCurrentAge = (bdate) => {
  if (!bdate) return "";
  const birth = new Date(bdate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
};

// 郵便番号から住所検索API
const fetchAddress = async (zipcode, callback) => {
  const zip = zipcode.replace(/[^0-9]/g, "");
  if (zip.length !== 7) {
    alert("郵便番号は7桁の数字で入力してください");
    return;
  }
  try {
    const res = await fetch(
      `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`,
    );
    const data = await res.json();
    if (data.results) {
      const addr = `${data.results[0].address1}${data.results[0].address2}${data.results[0].address3}`;
      callback(addr);
    } else {
      alert("住所が見つかりませんでした");
    }
  } catch (err) {
    alert("住所検索に失敗しました");
  }
};

// --- UI部品 ---
const IcoDash = () => (
  <svg
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zm-10 10a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
    />
  </svg>
);
const IcoAdd = () => (
  <svg
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
    />
  </svg>
);
const IcoUsers = () => (
  <svg
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
    />
  </svg>
);
const IcoMoney = () => (
  <svg
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);
const thm = {
  bg: "#f4f6fa",
  side: "#001a3d",
  crd: "#ffffff",
  brd: "#dbe2ec",
  txt: "#202c3d",
  mut: "#64748b",
  pri: "#001a3d",
  dng: "#e60012",
};
const s = {
  wrap: {
    display: "flex",
    height: "100vh",
    width: "100vw",
    overflow: "hidden",
    backgroundColor: thm.bg,
    color: thm.txt,
    fontFamily: "system-ui, sans-serif",
  },
  main: {
    flex: 1,
    minWidth: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "clamp(20px, 2.5vw, 34px)",
    position: "relative",
    boxSizing: "border-box",
  },
  card: {
    backgroundColor: thm.crd,
    borderRadius: "12px",
    padding: "24px",
    boxShadow: "0 2px 10px rgba(0,26,61,0.045)",
    border: `1px solid ${thm.brd}`,
    marginBottom: "24px",
    textAlign: "left",
  },
  inp: {
    width: "100%",
    padding: "9px 12px",
    minHeight: "40px",
    border: `1px solid ${thm.brd}`,
    borderRadius: "8px",
    fontSize: "14px",
    outline: "none",
    backgroundColor: "#ffffff",
    color: "#000",
    boxSizing: "border-box",
    textAlign: "left",
  },
  txtArea: {
    width: "100%",
    padding: "10px 12px",
    border: `1px solid ${thm.brd}`,
    borderRadius: "6px",
    fontSize: "14px",
    outline: "none",
    backgroundColor: "#ffffff",
    color: "#000",
    minHeight: "60px",
    resize: "vertical",
    boxSizing: "border-box",
    textAlign: "left",
  },
  btn: {
    padding: "10px 18px",
    background: thm.pri,
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  lbl: {
    display: "block",
    fontWeight: "bold",
    fontSize: "13px",
    marginBottom: "6px",
    color: thm.txt,
    textAlign: "left",
  },
  tableContainer: { overflowX: "auto", width: "100%" },
  tbl: {
    width: "100%",
    minWidth: "900px",
    borderCollapse: "collapse",
    textAlign: "left",
  },
  th: {
    padding: "12px 16px",
    borderBottom: `2px solid ${thm.brd}`,
    color: thm.mut,
    fontSize: "13px",
    fontWeight: "bold",
    textAlign: "left",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "16px",
    borderBottom: `1px solid ${thm.brd}`,
    fontSize: "14px",
    color: thm.txt,
    verticalAlign: "top",
    textAlign: "left",
  },
  badge: {
    padding: "0 10px",
    height: "24px",
    boxSizing: "border-box",
    borderRadius: "4px",
    fontSize: "12px",
    fontWeight: "bold",
    display: "inline-flex",
    alignItems: "center",
    whiteSpace: "nowrap",
  },
  actBtn: {
    padding: "6px 12px",
    border: `1px solid ${thm.brd}`,
    background: "#ffffff",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: "bold",
    color: thm.txt,
    whiteSpace: "nowrap",
    display: "inline-block",
  },
  tab: {
    padding: "12px 24px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: "15px",
    borderBottom: "3px solid transparent",
    background: "none",
    borderTop: "none",
    borderLeft: "none",
    borderRight: "none",
  },
  flexRow: {
    display: "flex",
    gap: "16px",
    marginBottom: "16px",
    alignItems: "flex-start",
  },
};

// 進捗バッジと日時の表示コンポーネント
const ProgressStatus = ({ candidate, s }) => {
  const c = candidate;
  const isCoop = c.is_coop; // ★協力業者フラグ
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const st = String(c.status);
  const offerDate = c.expected_join_date
    ? new Date(c.expected_join_date)
    : null;
  if (offerDate) offerDate.setHours(0, 0, 0, 0);

  let label = "受付";
  let badgeStyle = {
    ...s.badge,
    background: "#f1f5f9",
    color: "#475569",
    border: "1px solid #e2e8f0",
  };
  let subText = null;
  let isAlert = false;

  // --- ステータスラベルの定義 ---
  const labels = isCoop
    ? {
        1: "受付",
        2: "連絡待ち",
        9: c.subcontract_status || "終了",
      }
    : {
        1: "受付",
        2: "面接打診中",
        3: "1次面接予定",
        4: "2次面接予定",
        5: "内定",
        6: "入社",
        9: "不採用", // ★ここに追加
      };

  // ★修正：不採用（9）かつ個人（!isCoop）のときは、文字を「不採用」に固定する
  label = String(st) === "9" && !isCoop ? "不採用" : labels[st] || "受付";
  // 選考履歴がある場合は最新工程の表示名（書類選考中・3次面接予定・辞退など）を優先する
  if (!isCoop && c.selection_label) label = c.selection_label;

  // --- スタイル適用 ---

  // 面接予定 (個人用)
  if (!isCoop && (st === "3" || st === "4")) {
    badgeStyle = {
      ...s.badge,
      background: "#dcfce7",
      color: "#166534",
      border: "1px solid #bbf7d0",
    };
  }
  // 打診中 / 連絡待ち (オレンジ系)
  else if (st === "2") {
    badgeStyle = {
      ...s.badge,
      background: "#fff7ed",
      color: "#9a3412",
      border: "1px solid #fed7aa",
    };
  }
  // 内定 (個人用)
  else if (!isCoop && st === "5") {
    badgeStyle = {
      ...s.badge,
      background: "#dbeafe",
      color: "#1e40af",
      border: "1px solid #bfdbfe",
    };
    if (offerDate) {
      subText = `${offerDate.getMonth() + 1}/${offerDate.getDate()}入社予定`;
      if (offerDate < today) {
        isAlert = true;
        badgeStyle = {
          ...s.badge,
          background: "#fee2e2",
          color: "#991b1b",
          border: "1px solid #fecaca",
        };
      }
    }
  }
  // 入社 (個人用)
  else if (!isCoop && st === "6") {
    badgeStyle = {
      ...s.badge,
      background: "#f3e8ff",
      color: "#6b21a8",
      border: "1px solid #e9d5ff",
    };
    if (offerDate) {
      subText = `${offerDate.getMonth() + 1}/${offerDate.getDate()}入社`;
    }
  }
  // 終了 / 登録完了 (濃い灰色)
  else if (st === "9") {
    badgeStyle = {
      ...s.badge,
      background: "#f3f4f6",
      color: "#1f2937",
      border: "1px solid #d1d5db",
    };
  }

  // --- 協力業者専用のサブテキスト (社内担当者を表示) ---
  if (isCoop && c.internal_contact) {
    subText = `担当: ${c.internal_contact}`;
  }

  return (
    <div className="nks-list-cell-main">
      <span style={badgeStyle}>{label}</span>
      {subText && (
        <span className={`nks-status-sub${isAlert ? " is-alert" : ""}`}>{subText}</span>
      )}
    </div>
  );
};

const EMPLOYMENT_TYPES = ["正社員", "パート・アルバイト", "派遣", "委託"];
const SOURCE_TYPES = ["求人", "紹介", "人材紹介", "新卒", "その他"];
const sourceDetailLabel = (type) => ({
  求人: "媒体名（Indeed、engageなど）",
  紹介: "紹介者名",
  人材紹介: "エージェント会社名",
  新卒: "学校名",
  その他: "応募経路の詳細",
}[type] || "応募経路の詳細");
const todayTokyo = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const validFourDigitDate = (value) => !value || /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value);

const OfferDateField = ({ value, onChange }) => (
  <label style={{ ...s.lbl, marginBottom: "12px" }}>内定日
    <input name="offer_date" type="date" min="1000-01-01" max="9999-12-31"
      value={(value || "").slice(0, 10)}
      onChange={event => { if (validFourDigitDate(event.target.value)) onChange(event.target.value); }}
      style={{ ...s.inp, width: "180px", marginTop: "6px", display: "block" }} />
  </label>
);
const EmploymentFields = ({ value, onChange }) => (
  <div style={{ ...s.flexRow, flexWrap: "wrap", gap: "12px" }}>
    {[ ["job_title", "職種"], ["planned_department", "配属予定部署"] ].map(([name, label]) => (
      <label key={name} style={{ ...s.lbl, flex: "1 1 180px", marginBottom: 0 }}>
        {label}
        <input name={name} value={value[name] || ""} onChange={onChange}
          style={{ ...s.inp, marginTop: "6px" }} />
      </label>
    ))}
    <label style={{ ...s.lbl, flex: "1 1 180px", marginBottom: 0 }}>
      雇用形態
      <select name="employment_type" value={value.employment_type || ""} onChange={onChange}
        style={{ ...s.inp, marginTop: "6px" }}>
        <option value="">未設定</option>
        {value.employment_type && !EMPLOYMENT_TYPES.includes(value.employment_type) && (
          <option value={value.employment_type}>{value.employment_type}（既存値）</option>
        )}
        {EMPLOYMENT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
      </select>
    </label>
  </div>
);
const SourceTypeFields = ({ value, onChange }) => (
  <section className="nks-source-fields">
    <label style={s.lbl}>応募経路の種別</label>
    <div className="nks-choice-group">
      {SOURCE_TYPES.map(type => (
        <label key={type} className="nks-choice">
          <input type="radio" name="source_type" value={type}
            checked={value.source_type === type} onChange={onChange} />
          {type}
        </label>
      ))}
    </div>
    {value.source_type && (
      <label style={{ ...s.lbl, marginTop: "12px" }}>
        {sourceDetailLabel(value.source_type)}
        <input type="text" name="agent_name" value={value.agent_name || ""}
          onChange={onChange} style={{ ...s.inp, marginTop: "6px" }} />
      </label>
    )}
    {value.source_type === "人材紹介" && (
      <label style={{ ...s.lbl, marginTop: "12px" }}>
        紹介料（入社時の経費処理用・任意）
        <input type="number" min="0" name="introducer_fee" value={value.introducer_fee || ""}
          onChange={onChange} style={{ ...s.inp, marginTop: "6px" }} />
      </label>
    )}
  </section>
);
// --- 詳細・選考入力画面 ---
const CandidateDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [cand, setCand] = useState(null);
  const [activeTab, setActiveTab] = useState(
    new URLSearchParams(location.search).get("view") || "detail",
  );
  const [showRetireInput, setShowRetireInput] = useState(false);
  const [editingSource, setEditingSource] = useState(false);

  // フォームデータ
  const [f, setF] = useState({});
  const [qa1, setQa1] = useState([]);
  const [qa2, setQa2] = useState([]);
  const [workHist, setWorkHist] = useState([]);
  const [lic, setLic] = useState([]);
  const [fam, setFam] = useState([]);
  const currYear = new Date().getFullYear();

  // 選考履歴（個人応募）。selUnavailable は選考履歴テーブル未作成時（従来の進捗更新で代替）
  const [selView, setSelView] = useState(null);
  const [selOpen, setSelOpen] = useState(false);
  const [selUnavailable, setSelUnavailable] = useState(false);
  const [legacyProgress, setLegacyProgress] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    apiFetch(`/api/candidates/${id}`)
      .then((res) => res.json())
      .then((d) => {
        setCand(d);
        const fmtDt = (str) => (str ? str.split("T")[0] : "");
        setF({
          ...d, // 全てのカラム（is_coop含む）をロード
          source_type: d.source_type || "", // 未設定を勝手に求人へ変更しない
          introducer_fee: d.introducer_fee || "", // ★追加
          status: String(d.status || "1"),
          birth_date: fmtDt(d.birth_date),
          expected_join_date: fmtDt(d.expected_join_date),
          offer_date: fmtDt(d.offer_date),
          job_title: d.job_title || "",
          planned_department: d.planned_department || "",
          employment_type: d.employment_type || "",
          interview_1_date: fmtDt(d.interview_1_date),
          interview_2_date: fmtDt(d.interview_2_date),
          retirement_date: fmtDt(d.retirement_date),
          tel: d.tel || [""],
          email: d.email || [""],
        });
        setQa1(d.qa_1 || []);
        setQa2(d.qa_2 || []);
        setWorkHist(d.work_history || []);
        setLic(d.licenses || []);
        setFam(d.family || []);
        setLoading(false);
      })
      .catch(() => alert("取得失敗"));
  }, [id]);

  const candIsCoop = cand?.is_coop === true;
  const candLoaded = cand != null;
  useEffect(() => {
    if (!candLoaded || candIsCoop) return;
    let active = true;
    selectionApi.load(id).then(result => {
      if (!active) return;
      if (result.status === 503) setSelUnavailable(true);
      else if (result.ok) { setSelUnavailable(false); setSelView(result.data); }
    }).catch(() => {});
    return () => { active = false; };
  }, [id, candLoaded, candIsCoop, reloadKey]);

  // 選考の更新結果を画面へ反映する（入力途中の他の項目は保持）
  const applySelection = (view) => {
    setSelView(view);
    setCand((previous) => ({ ...previous, ...view.candidate }));
    setF((previous) => ({ ...previous, ...mirrorForForm(view.candidate) }));
  };

  // 従来の進捗モーダル（DB適用前）で保存した後は、選考列だけを読み直す（未保存の入力は保持）
  const refreshSelectionFields = async () => {
    try {
      const res = await apiFetch(`/api/candidates/${id}`);
      if (!res.ok) return;
      const d = await res.json();
      const picked = Object.fromEntries(SELECTION_OWNED_FIELDS.map((field) => [field, d[field] ?? null]));
      setCand((previous) => ({ ...previous, ...picked }));
      setF((previous) => ({ ...previous, ...mirrorForForm(picked) }));
      setReloadKey((key) => key + 1);
    } catch {
      alert("最新の進捗を読み込めませんでした。画面を再読み込みしてください。");
    }
  };

  const hChg = (e) =>
    setF({
      ...f,
      [e.target.name]:
        e.target.type === "checkbox" ? e.target.checked : e.target.value,
    });

  const hBlurHW = (e) =>
    setF({ ...f, [e.target.name]: toHalfWidth(e.target.value) });

  const updArr = (setter, idx, fld, val) =>
    setter((p) => {
      const n = [...p];
      n[idx][fld] = val;
      return n;
    });
  const addArr = (setter, obj) => setter((p) => [...p, obj]);
  const rmArr = (setter, idx) => setter((p) => p.filter((_, i) => i !== idx));

  const calcYears = (start, end) => {
    if (!start) return "";
    const s = parseInt(start);
    const e = end ? parseInt(end) : currYear;
    if (isNaN(s) || isNaN(e) || s > e) return "";
    return `${e - s}年`;
  };

  const handleToggleCoop = () => {
    const nextMode = !f.is_coop;
    const modeName = nextMode ? "協力業者" : "個人応募";
    if (window.confirm(`この応募者を「${modeName}」に切り替えますか？`)) {
      setF({ ...f, is_coop: nextMode });
      alert(
        `【注意】管理種別を「${modeName}」に変更しました。氏名の右（${nextMode ? "会社名" : "フリガナ"}欄）を正しく入力し直してください。`,
      );
    }
  };

  // ★引数 overrideData を受け取れるように変更（タイムライン辞退処理用）
  const handleSave = async (overrideData = null) => {
    const currentOverrides = overrideData || {};
    const targetStatus = currentOverrides.status || f.status;

    // 紹介料の自動経費計上ロジック
    if (
      String(cand?.status) !== "6" &&
      targetStatus === "6" &&
      f.source_type === "人材紹介" &&
      f.introducer_fee
    ) {
      if (
        window.confirm(
          `入社処理が行われました。\n人材紹介会社（${f.agent_name || "名称未設定"}）への紹介料 ${parseInt(f.introducer_fee, 10).toLocaleString()}円 を採用経費として自動計上しますか？`,
        )
      ) {
        const joinDate = new Date(f.expected_join_date || new Date());
        joinDate.setDate(1);
        const expDateStr = joinDate.toISOString().split("T")[0];

        try {
          await apiFetch("/api/expenses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              payee: f.agent_name || "人材紹介会社",
              amount: parseInt(f.introducer_fee, 10),
              expense_date: expDateStr,
            }),
          });
          alert("紹介料を経費として自動計上しました！");
        } catch (e) {
          alert(
            "経費の自動計上に失敗しました。経費画面から手動で登録してください。",
          );
        }
      }
    }

    // 既存の保存処理
    try {
      const payload = {
        ...cand,
        ...f,
        qa_1: qa1,
        qa_2: qa2,
        work_history: workHist,
        licenses: lic,
        family: fam,
        ...currentOverrides, // ★引数で上書きされたデータ（ステータス9等）を適用
      };
      // 個人応募の選考列は選考の更新（共通モーダル）だけで変更する。基本情報の保存では送らない
      const isCoopRecord = cand?.is_coop === true;
      if (!isCoopRecord) for (const field of SELECTION_OWNED_FIELDS) delete payload[field];
      const res = await apiFetch(`/api/candidates/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        alert("データを保存・更新しました");
        setShowRetireInput(false);
        setEditingSource(false);
        // 保存後に元データの状態も更新（二重計上防止）。管理種別の変更も反映し、
        // 次回の保存で送る項目と、個人応募の選考情報の読み込みを変更後の種別に合わせる
        setCand((previous) => ({
          ...previous,
          ...(isCoopRecord ? { status: payload.status } : {}),
          is_coop: Boolean(payload.is_coop),
          source_type: payload.source_type, agent_name: payload.agent_name, introducer_fee: payload.introducer_fee,
        }));
        if (isCoopRecord) {
          setF((prev) => ({
            ...prev,
            status: payload.status,
            decline_reason: payload.decline_reason || prev.decline_reason,
          }));
        }
      } else if (res.status === 409) {
        const data = await res.json().catch(() => null);
        alert(data?.error || "画面が古いため保存できません。再読み込みしてください。");
      } else alert("保存失敗");
    } catch (e) {
      alert("通信エラー");
    }
  };

  // 協力業者用タイムラインの1行（日付は詳細画面の保存ボタンで確定）
  const renderTimelineNode = (label, dateKey, isLast = false) => (
    <div style={{ display: "flex", gap: "12px", marginBottom: "16px", position: "relative" }}>
      {!isLast && (
        <div style={{ position: "absolute", left: "7px", top: "24px", bottom: "-20px", width: "2px", background: thm.brd }} />
      )}
      <div
        style={{
          width: "16px", height: "16px", borderRadius: "50%",
          background: f[dateKey] ? thm.pri : thm.brd, position: "relative", zIndex: 1, marginTop: "4px",
        }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "13px", fontWeight: "bold", marginBottom: "4px", color: thm.txt }}>{label}</div>
        <input
          type="date"
          max="9999-12-31"
          name={dateKey}
          value={f[dateKey] || ""}
          onChange={hChg}
          style={{ ...s.inp, padding: "4px", fontSize: "12px", width: "130px", margin: 0 }}
        />
      </div>
    </div>
  );

  if (loading) return <div style={s.main}>読込中...</div>;

  const isJoined = f.status === "6";
  const isCoop = f.is_coop;

  return (
    <div style={s.main}>
      <div style={{ maxWidth: "1200px" }}>
        {/* タブ・ヘッダー */}
        <div
          style={{
            position: "sticky",
            top: 0,
            backgroundColor: thm.bg,
            zIndex: 20,
            display: "flex",
            alignItems: "flex-end",
            gap: "24px",
            borderBottom: `1px solid ${thm.brd}`,
            padding: "20px 0",
            margin: "-40px 0 24px 0",
          }}
        >
          <div style={{ paddingBottom: "10px" }}>
            <button
              onClick={() => navigate("/candidates")}
              style={{ ...s.actBtn, padding: "8px 16px", fontSize: "14px" }}
            >
              ← 一覧へ戻る
            </button>
          </div>
          <div style={{ display: "flex" }}>
            <button
              onClick={() => setActiveTab("detail")}
              style={{
                ...s.tab,
                color: activeTab === "detail" ? thm.pri : thm.mut,
                borderBottomColor:
                  activeTab === "detail" ? thm.pri : "transparent",
              }}
            >
              基本情報・{isCoop ? "資格" : "履歴書"}
            </button>
            <button
              onClick={() => setActiveTab("interview")}
              style={{
                ...s.tab,
                color: activeTab === "interview" ? thm.pri : thm.mut,
                borderBottomColor:
                  activeTab === "interview" ? thm.pri : "transparent",
              }}
            >
              {isCoop ? "商談・ヒアリング" : "面接・ヒアリング"}
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "280px 1fr",
            gap: "24px",
            alignItems: "start",
          }}
        >
          {/* 左サイド：サマリーカード */}
          <div
            style={{
              ...s.card,
              padding: "20px",
              position: "sticky",
              top: "100px",
              alignSelf: "start",
              borderTop: isCoop ? `6px solid #0ea5e9` : `6px solid ${thm.pri}`,
            }}
          >
            <div
              style={{ fontSize: "12px", color: thm.mut, marginBottom: "4px" }}
            >
              受付: {new Date(cand.applied_at).toLocaleDateString("ja-JP")}
            </div>
            <h3 style={{ margin: "0 0 4px 0", fontSize: "20px" }}>
              {f.name_kanji} 様
            </h3>
            <div
              style={{ fontSize: "12px", color: thm.mut, marginBottom: "16px" }}
            >
              {f.name_kana}
            </div>

            {/* 切替ボタン */}
            <button
              onClick={handleToggleCoop}
              style={{
                ...s.actBtn,
                width: "100%",
                marginBottom: "16px",
                fontSize: "12px",
                borderColor: isCoop ? thm.pri : "#94a3b8",
                color: isCoop ? thm.pri : "#64748b",
              }}
            >
              {isCoop ? "➡ 個人応募へ切替" : "➡ 協力業者へ切替"}
            </button>

            {!isCoop && (
              <div
                style={{
                  display: "flex",
                  gap: "12px",
                  marginBottom: "16px",
                  alignItems: "center",
                }}
              >
                <span style={{ fontWeight: "bold" }}>
                  {calcCurrentAge(f.birth_date)
                    ? `${calcCurrentAge(f.birth_date)}歳`
                    : f.age
                      ? `${f.age}歳`
                      : "-"}
                </span>
                <span style={{ color: thm.mut }}>|</span>

                {/* プルダウン */}
                <select
                  value={f.experience || "不明"}
                  onChange={(e) => setF({ ...f, experience: e.target.value })}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    border: `1px solid ${thm.pri}`,
                    color: thm.pri,
                    fontSize: "12px",
                    fontWeight: "bold",
                    cursor: "pointer",
                    background: "#fff",
                    outline: "none",
                  }}
                >
                  <option value="経験者">経験者</option>
                  <option value="未経験者">未経験者</option>
                  <option value="不明">不明</option>
                </select>
              </div>
            )}

            <div
              style={{
                fontSize: "13px",
                borderTop: `1px solid ${thm.brd}`,
                paddingTop: "16px",
              }}
            >
              <strong style={{ display: "block", marginBottom: "8px" }}>
                連絡先
              </strong>
              {f.tel.map(
                (t, i) =>
                  t && (
                    <div key={i} style={{ marginBottom: "4px" }}>
                      TEL: {t}
                    </div>
                  ),
              )}
              {f.email.map(
                (e, i) =>
                  e && (
                    <div
                      key={i}
                      style={{ marginBottom: "4px", overflowWrap: "anywhere" }}
                    >
                      ✉: {e}
                    </div>
                  ),
              )}
            </div>

            {/* 選考タイムライン：個人応募は選考履歴（共通更新モーダルで更新）、協力業者は従来の日付入力 */}
            <div
              style={{
                fontSize: "13px",
                borderTop: `1px solid ${thm.brd}`,
                paddingTop: "16px",
                marginTop: "16px",
              }}
            >
              {!isCoop ? (
                <div className="nks-sel-panel-head">
                  <strong>選考タイムライン</strong>
                  {selUnavailable ? (
                    <button type="button" className="nks-row-btn nks-row-btn-primary" onClick={() => setLegacyProgress(true)}>
                      進捗を更新
                    </button>
                  ) : (
                    <button type="button" className="nks-row-btn nks-row-btn-primary" disabled={!selView} onClick={() => setSelOpen(true)}>
                      選考を更新
                    </button>
                  )}
                </div>
              ) : (
                <strong
                  style={{
                    display: "block",
                    marginBottom: "16px",
                    color: thm.txt,
                  }}
                >
                  選考タイムライン (日付編集)
                </strong>
              )}
              {!isCoop && !selUnavailable && (
                selView ? <SelectionTimeline view={selView} /> : <div className="nks-sel-panel-note">読込中...</div>
              )}
              {!isCoop && selUnavailable && (
                <div className="nks-sel-panel-note">選考履歴は未設定です（DB適用前のため従来の進捗更新を使用）。</div>
              )}
              <div style={{ position: "relative" }}>
                {isCoop && (
                  <>
                    {renderTimelineNode("受付・応募", "applied_at")}
                    {renderTimelineNode("商談", "interview_1_date")}
                    {renderTimelineNode("稼働予定", "expected_join_date", true)}
                  </>
                )}

                {/* 終了・退職ステータスの表示（個人応募は選考履歴に表示するため、従来表示は協力業者とDB適用前のみ） */}
                {(isCoop || selUnavailable) && f.status === "9" && (
                  <div
                    style={{
                      display: "flex",
                      gap: "12px",
                      position: "relative",
                      marginTop: "16px",
                    }}
                  >
                    <div
                      style={{
                        width: "16px",
                        height: "16px",
                        borderRadius: "50%",
                        background: thm.dng,
                        position: "relative",
                        zIndex: 1,
                        marginTop: "2px",
                      }}
                    />
                    <div>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: "bold",
                          color: thm.dng,
                        }}
                      >
                        終了 / 不採用
                      </div>
                      <div
                        style={{
                          fontSize: "11px",
                          color: thm.mut,
                          marginTop: "4px",
                        }}
                      >
                        {f.decline_reason}
                      </div>
                    </div>
                  </div>
                )}
                {(isCoop || selUnavailable) && f.status === "6" && !f.is_retired && (
                  <div
                    style={{
                      display: "flex",
                      gap: "12px",
                      position: "relative",
                      marginTop: "16px",
                    }}
                  >
                    <div
                      style={{
                        width: "16px",
                        height: "16px",
                        borderRadius: "50%",
                        background: thm.pri,
                        position: "relative",
                        zIndex: 1,
                        marginTop: "2px",
                      }}
                    />
                    <div>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: "bold",
                          color: thm.pri,
                        }}
                      >
                        {isCoop ? "稼働中" : "入社済"}
                      </div>
                    </div>
                  </div>
                )}
                {f.is_retired && (
                  <div
                    style={{
                      display: "flex",
                      gap: "12px",
                      position: "relative",
                      marginTop: "16px",
                    }}
                  >
                    <div
                      style={{
                        width: "16px",
                        height: "16px",
                        borderRadius: "50%",
                        background: thm.dng,
                        position: "relative",
                        zIndex: 1,
                        marginTop: "2px",
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: "bold",
                          color: thm.dng,
                          marginBottom: "4px",
                        }}
                      >
                        退職済
                      </div>
                      <input
                        type="date"
                        max="9999-12-31"
                        name="retirement_date"
                        value={f.retirement_date || ""}
                        onChange={hChg}
                        style={{
                          ...s.inp,
                          padding: "4px",
                          fontSize: "12px",
                          width: "130px",
                          margin: 0,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 右サイド：入力エリア */}
          <div style={{ ...s.card, padding: "30px", marginTop: 0 }}>
            {activeTab === "detail" && (
              <div>
                <h4
                  style={{
                    margin: "0 0 16px 0",
                    borderBottom: `1px solid ${thm.brd}`,
                    paddingBottom: "8px",
                  }}
                >
                  基本情報
                </h4>
                {/* 内定日は選考タイムラインの「内定通知」で登録する（二重入力を廃止） */}
                {!isCoop && <EmploymentFields value={f} onChange={hChg} />}
                <section className="nks-source-detail">
                  <div className="nks-section-heading">
                    <strong>応募経路</strong>
                    <button type="button" style={s.actBtn} onClick={() => {
                      if (editingSource) {
                        setF(previous => ({ ...previous, source_type: cand?.source_type || "", agent_name: cand?.agent_name || "", introducer_fee: cand?.introducer_fee || "" }));
                      }
                      setEditingSource(current => !current);
                    }}>
                      {editingSource ? "キャンセル" : "編集"}
                    </button>
                  </div>
                  {editingSource ? (
                    <>
                      <SourceTypeFields value={f} onChange={hChg} />
                      <div className="nks-inline-note">変更後は画面下部の保存ボタンで確定してください。</div>
                    </>
                  ) : (
                    <div className="nks-static-value">
                      <strong>{f.source_type || "未設定"}</strong>
                      {f.agent_name && <span>{f.agent_name}</span>}
                    </div>
                  )}
                </section>
                <div style={s.flexRow}>
                  <div style={{ flex: 1 }}>
                    <label style={s.lbl}>{isCoop ? "担当者名" : "氏名"}</label>
                    <input
                      type="text"
                      name="name_kanji"
                      value={f.name_kanji}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      style={s.inp}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={s.lbl}>
                      {isCoop ? "会社名" : "フリガナ"}
                    </label>
                    <input
                      type="text"
                      name="name_kana"
                      value={f.name_kana}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      style={s.inp}
                    />
                  </div>
                </div>

                {!isCoop && (
                  <div
                    style={{
                      ...s.flexRow,
                      background: "#f8fafc",
                      padding: "16px",
                      borderRadius: "6px",
                      border: `1px solid ${thm.brd}`,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <label style={s.lbl}>生年月日（履歴書記載）</label>
                      <input
                        type="date"
                        max="9999-12-31"
                        name="birth_date"
                        value={f.birth_date}
                        onChange={hChg}
                        style={s.inp}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={s.lbl}>年齢 (自動計算)</label>
                      <input
                        type="text"
                        readOnly
                        value={calcCurrentAge(f.birth_date)}
                        style={{
                          ...s.inp,
                          backgroundColor: "#e2e8f0",
                          cursor: "not-allowed",
                        }}
                      />
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: "24px", marginTop: "24px" }}>
                  <label style={s.lbl}>現住所</label>
                  <div
                    style={{ display: "flex", gap: "8px", marginBottom: "8px" }}
                  >
                    <input
                      type="text"
                      name="zip_code"
                      value={f.zip_code}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      placeholder="郵便番号"
                      style={{ ...s.inp, width: "150px" }}
                    />
                    <button
                      onClick={() =>
                        fetchAddress(f.zip_code, (addr) =>
                          setF({ ...f, address: addr }),
                        )
                      }
                      style={{
                        ...s.actBtn,
                        padding: "10px 16px",
                        height: "40px",
                      }}
                    >
                      検索
                    </button>
                  </div>
                  <input
                    type="text"
                    name="address"
                    value={f.address}
                    onChange={hChg}
                    placeholder="住所"
                    style={{ ...s.inp, marginBottom: "8px" }}
                  />
                  <div style={{ display: "flex", gap: "12px" }}>
                    <input
                      type="text"
                      name="address_banchi"
                      value={f.address_banchi}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      placeholder="番地"
                      style={s.inp}
                    />
                    <input
                      type="text"
                      name="address_building"
                      value={f.address_building}
                      onChange={hChg}
                      placeholder="建物名"
                      style={s.inp}
                    />
                    <input
                      type="text"
                      name="address_room"
                      value={f.address_room}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      placeholder="部屋番号"
                      style={s.inp}
                    />
                  </div>
                </div>

                {/* 緊急連絡先：必要なときだけ開く */}
                <details className="nks-emergency">
                  <summary>緊急連絡先 <span>クリックして入力・確認</span></summary>
                  <div className="nks-emergency-body">
                  <div style={s.flexRow}>
                    <div style={{ flex: 1 }}>
                      <label style={s.lbl}>氏名</label>
                      <input
                        type="text"
                        name="emerg_name"
                        value={f.emerg_name}
                        onChange={hChg}
                        style={s.inp}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={s.lbl}>続柄</label>
                      <input
                        type="text"
                        name="emerg_relation"
                        value={f.emerg_relation}
                        onChange={hChg}
                        style={s.inp}
                      />
                    </div>
                  </div>
                  <div style={{ marginBottom: "16px" }}>
                    <label style={s.lbl}>電話番号</label>
                    <input
                      type="text"
                      name="emerg_tel"
                      value={f.emerg_tel}
                      onChange={hChg}
                      onBlur={(e) =>
                        setF({
                          ...f,
                          emerg_tel: formatTelOnBlur(e.target.value),
                        })
                      }
                      style={s.inp}
                    />
                  </div>
                  <div
                    style={{ display: "flex", gap: "8px", marginBottom: "8px" }}
                  >
                    <input
                      type="text"
                      name="emerg_zip_code"
                      value={f.emerg_zip_code}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      placeholder="郵便番号"
                      style={{ ...s.inp, width: "150px" }}
                    />
                    <button
                      onClick={() =>
                        fetchAddress(f.emerg_zip_code, (addr) =>
                          setF({ ...f, emerg_address: addr }),
                        )
                      }
                      style={{
                        ...s.actBtn,
                        padding: "10px 16px",
                        height: "40px",
                      }}
                    >
                      検索
                    </button>
                  </div>
                  <input
                    type="text"
                    name="emerg_address"
                    value={f.emerg_address}
                    onChange={hChg}
                    placeholder="住所"
                    style={{ ...s.inp, marginBottom: "8px" }}
                  />
                  <div style={{ display: "flex", gap: "12px" }}>
                    <input
                      type="text"
                      name="emerg_address_banchi"
                      value={f.emerg_address_banchi}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      placeholder="番地"
                      style={s.inp}
                    />
                    <input
                      type="text"
                      name="emerg_address_building"
                      value={f.emerg_address_building}
                      onChange={hChg}
                      placeholder="建物名"
                      style={s.inp}
                    />
                    <input
                      type="text"
                      name="emerg_address_room"
                      value={f.emerg_address_room}
                      onChange={hChg}
                      onBlur={hBlurHW}
                      placeholder="部屋番号"
                      style={s.inp}
                    />
                  </div>
                  </div>
                </details>

                <h4
                  style={{
                    margin: "40px 0 16px 0",
                    borderBottom: `1px solid ${thm.brd}`,
                    paddingBottom: "8px",
                  }}
                >
                  {isCoop ? "保有資格" : "学歴・職歴・資格"}
                </h4>

                {!isCoop && (
                  <>
                    <div style={s.flexRow}>
                      <div style={{ flex: 1 }}>
                        <label style={s.lbl}>最終学歴</label>
                        <input
                          type="text"
                          name="education"
                          value={f.education}
                          onChange={hChg}
                          style={s.inp}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={s.lbl}>卒業年 (西暦)</label>
                        <input
                          type="text"
                          name="graduation_year"
                          value={f.graduation_year}
                          onChange={hChg}
                          onBlur={hBlurHW}
                          style={s.inp}
                        />
                      </div>
                    </div>
                    <div style={{ marginBottom: "24px" }}>
                      <label style={s.lbl}>職歴</label>
                      {workHist.map((w, i) => (
                        <div
                          key={i}
                          style={{
                            background: "#f8fafc",
                            border: `1px solid ${thm.brd}`,
                            padding: "12px",
                            borderRadius: "6px",
                            marginBottom: "8px",
                            display: "flex",
                            gap: "12px",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <input
                            type="text"
                            value={w.company || ""}
                            onChange={(e) =>
                              updArr(setWorkHist, i, "company", e.target.value)
                            }
                            placeholder="会社名"
                            style={{ ...s.inp, width: "220px" }}
                          />
                          <input
                            type="text"
                            value={w.start_year || ""}
                            onChange={(e) =>
                              updArr(
                                setWorkHist,
                                i,
                                "start_year",
                                toHalfWidth(e.target.value),
                              )
                            }
                            placeholder="入社年"
                            style={{ ...s.inp, width: "80px" }}
                          />
                          <span>〜</span>
                          <input
                            type="text"
                            value={w.end_year || ""}
                            onChange={(e) =>
                              updArr(
                                setWorkHist,
                                i,
                                "end_year",
                                toHalfWidth(e.target.value),
                              )
                            }
                            placeholder="退社年"
                            style={{ ...s.inp, width: "80px" }}
                          />
                          <span
                            style={{
                              fontSize: "12px",
                              fontWeight: "bold",
                              color: thm.mut,
                            }}
                          >
                            {calcYears(w.start_year, w.end_year)}
                          </span>
                          <label
                            style={{
                              fontSize: "13px",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={w.is_same_industry}
                              onChange={(e) =>
                                updArr(
                                  setWorkHist,
                                  i,
                                  "is_same_industry",
                                  e.target.checked,
                                )
                              }
                            />{" "}
                            同業
                          </label>
                          <label
                            style={{
                              fontSize: "13px",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={w.is_same_job}
                              onChange={(e) =>
                                updArr(
                                  setWorkHist,
                                  i,
                                  "is_same_job",
                                  e.target.checked,
                                )
                              }
                            />{" "}
                            同職種
                          </label>
                          <button
                            onClick={() => rmArr(setWorkHist, i)}
                            style={{
                              ...s.actBtn,
                              color: thm.dng,
                              border: "none",
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() =>
                          addArr(setWorkHist, {
                            company: "",
                            start_year: "",
                            end_year: "",
                            is_same_industry: false,
                            is_same_job: false,
                          })
                        }
                        style={s.actBtn}
                      >
                        ＋ 職歴を追加
                      </button>
                    </div>
                  </>
                )}

                {/* 資格 (共通) */}
                <div style={{ marginBottom: "24px" }}>
                  <label style={s.lbl}>資格</label>
                  {lic.map((l, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: "12px",
                        marginBottom: "8px",
                      }}
                    >
                      <input
                        type="text"
                        value={l.name || ""}
                        onChange={(e) =>
                          updArr(setLic, i, "name", e.target.value)
                        }
                        placeholder="資格名"
                        style={{ ...s.inp, flex: 1 }}
                      />
                      <input
                        type="text"
                        value={l.date || ""}
                        onChange={(e) =>
                          updArr(setLic, i, "date", toHalfWidth(e.target.value))
                        }
                        placeholder="取得年"
                        style={{ ...s.inp, width: "140px" }}
                      />
                      <button
                        onClick={() => rmArr(setLic, i)}
                        style={{ ...s.actBtn, color: thm.dng, border: "none" }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addArr(setLic, { name: "", date: "" })}
                    style={s.actBtn}
                  >
                    ＋ 資格を追加
                  </button>
                </div>

                {!isCoop && (
                  <>
                    <div style={{ marginBottom: "32px" }}>
                      <label style={s.lbl}>履歴書記載の志望動機</label>
                      <textarea
                        name="resume_memo"
                        value={f.resume_memo}
                        onChange={hChg}
                        style={{ ...s.txtArea, minHeight: "120px" }}
                      />
                    </div>
                    <h4
                      style={{
                        margin: "40px 0 16px 0",
                        borderBottom: `1px solid ${thm.brd}`,
                        paddingBottom: "8px",
                      }}
                    >
                      家族構成・その他
                    </h4>
                    <div style={{ marginBottom: "24px" }}>
                      <label style={s.lbl}>家族構成</label>
                      {fam.map((fa, i) => (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            gap: "12px",
                            marginBottom: "8px",
                            alignItems: "center",
                          }}
                        >
                          <input
                            type="text"
                            value={fa.relation || ""}
                            onChange={(e) =>
                              updArr(setFam, i, "relation", e.target.value)
                            }
                            placeholder="続柄"
                            style={{ ...s.inp, width: "100px" }}
                          />
                          <input
                            type="text"
                            value={fa.name || ""}
                            onChange={(e) =>
                              updArr(setFam, i, "name", e.target.value)
                            }
                            placeholder="名前"
                            style={{ ...s.inp, width: "200px" }}
                          />
                          <input
                            type="text"
                            value={fa.tel || ""}
                            onChange={(e) =>
                              updArr(
                                setFam,
                                i,
                                "tel",
                                formatTelOnBlur(e.target.value),
                              )
                            }
                            placeholder="連絡先"
                            style={{ ...s.inp, width: "160px" }}
                          />
                          <label
                            style={{
                              fontSize: "13px",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={fa.is_dependent}
                              onChange={(e) =>
                                updArr(
                                  setFam,
                                  i,
                                  "is_dependent",
                                  e.target.checked,
                                )
                              }
                            />{" "}
                            扶養
                          </label>
                          <button
                            onClick={() => rmArr(setFam, i)}
                            style={{
                              ...s.actBtn,
                              color: thm.dng,
                              border: "none",
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() =>
                          addArr(setFam, {
                            relation: "",
                            name: "",
                            tel: "",
                            is_dependent: false,
                          })
                        }
                        style={s.actBtn}
                      >
                        ＋ 家族を追加
                      </button>
                    </div>
                    <div style={s.flexRow}>
                      <div style={{ flex: 1 }}>
                        <label style={s.lbl}>通勤手段</label>
                        <input
                          type="text"
                          name="commute_method"
                          value={f.commute_method}
                          onChange={hChg}
                          style={s.inp}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={s.lbl}>通勤時間 (分)</label>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <input
                            type="text"
                            name="commute_time"
                            value={f.commute_time}
                            onChange={hChg}
                            onBlur={hBlurHW}
                            style={{ ...s.inp, width: "100px" }}
                          />
                          <span>分</span>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeTab === "interview" && (
              <div
                style={isJoined ? { opacity: 0.6, pointerEvents: "none" } : {}}
              >
                {isJoined && (
                  <div
                    style={{
                      color: thm.dng,
                      fontWeight: "bold",
                      marginBottom: "16px",
                    }}
                  >
                    ※入社済みのため編集ロック
                  </div>
                )}

                <div style={{ marginBottom: "40px" }}>
                  <h4
                    style={{
                      margin: "0 0 20px 0",
                      fontSize: "18px",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        backgroundColor: isCoop ? thm.pri : thm.side,
                        color: "#fff",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontSize: "14px",
                        marginRight: "10px",
                      }}
                    >
                      {isCoop ? "商談" : "1次面接"}
                    </span>
                    ヒアリング事項
                  </h4>

                  {!isCoop && (
                    <>
                      <div style={s.flexRow}>
                        <div style={{ flex: 1 }}>
                          <label style={s.lbl}>前職給与</label>
                          <input
                            type="text"
                            name="prev_salary"
                            value={f.prev_salary}
                            onChange={hChg}
                            onBlur={hBlurHW}
                            style={s.inp}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={s.lbl}>希望給与</label>
                          <input
                            type="text"
                            name="desired_salary"
                            value={f.desired_salary}
                            onChange={hChg}
                            onBlur={hBlurHW}
                            style={s.inp}
                          />
                        </div>
                      </div>
                      <div style={{ marginBottom: "20px" }}>
                        <label style={s.lbl}>他社の選考状況</label>
                        <input
                          type="text"
                          name="other_selection_status"
                          value={f.other_selection_status}
                          onChange={hChg}
                          style={s.inp}
                        />
                      </div>
                      <div style={{ marginBottom: "20px" }}>
                        <label style={s.lbl}>経験内容・社名等詳細</label>
                        <textarea
                          name="experience_memo"
                          value={f.experience_memo}
                          onChange={hChg}
                          style={s.txtArea}
                        />
                      </div>
                      <div style={{ marginBottom: "20px" }}>
                        <label style={s.lbl}>面接時の志望動機補足</label>
                        <textarea
                          name="motivation_memo"
                          value={f.motivation_memo}
                          onChange={hChg}
                          style={s.txtArea}
                        />
                      </div>
                    </>
                  )}

                  <div style={{ marginBottom: "24px" }}>
                    <label style={s.lbl}>質疑応答 (Q&A)</label>
                    {qa1.map((qa, i) => (
                      <div
                        key={i}
                        style={{
                          background: "#f1f5f9",
                          padding: "16px",
                          borderRadius: "6px",
                          marginBottom: "12px",
                          border: `1px solid ${thm.brd}`,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginBottom: "8px",
                          }}
                        >
                          <select
                            value={qa.asker}
                            onChange={(e) =>
                              updArr(setQa1, i, "asker", e.target.value)
                            }
                            style={{
                              padding: "6px",
                              borderRadius: "4px",
                              background:
                                qa.asker === "candidate"
                                  ? "#fffbeb"
                                  : "#eff6ff",
                              border: `1px solid ${thm.brd}`,
                              fontWeight: "bold",
                            }}
                          >
                            <option value="interviewer">
                              {isCoop ? "Q. 自社" : "Q. 面接官 / 人事"}
                            </option>
                            <option value="candidate">
                              {isCoop ? "Q. 協力業者" : "Q. 応募者"}
                            </option>
                          </select>
                          <button
                            onClick={() => rmArr(setQa1, i)}
                            style={{
                              border: "none",
                              background: "none",
                              color: thm.dng,
                              cursor: "pointer",
                              fontWeight: "bold",
                            }}
                          >
                            削除 ×
                          </button>
                        </div>
                        <textarea
                          value={qa.q}
                          onChange={(e) =>
                            updArr(setQa1, i, "q", e.target.value)
                          }
                          placeholder="質問内容..."
                          style={{
                            ...s.txtArea,
                            minHeight: "50px",
                            marginBottom: "8px",
                          }}
                        />
                        <textarea
                          value={qa.a}
                          onChange={(e) =>
                            updArr(setQa1, i, "a", e.target.value)
                          }
                          placeholder="回答・メモ..."
                          style={{ ...s.txtArea, minHeight: "50px" }}
                        />
                      </div>
                    ))}
                    <button
                      onClick={() =>
                        addArr(setQa1, { asker: "interviewer", q: "", a: "" })
                      }
                      style={s.actBtn}
                    >
                      ＋ 質疑応答を追加
                    </button>
                  </div>
                  <div>
                    <label style={s.lbl}>特記事項（全体所感・メモ）</label>
                    <textarea
                      name="other_memo"
                      value={f.other_memo}
                      onChange={hChg}
                      style={s.txtArea}
                    />
                  </div>
                </div>

                {!isCoop && (
                  <div
                    style={{
                      borderTop: `2px dashed ${thm.brd}`,
                      paddingTop: "30px",
                    }}
                  >
                    <h4
                      style={{
                        margin: "0 0 20px 0",
                        fontSize: "18px",
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{
                          backgroundColor: thm.pri,
                          color: "#fff",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "14px",
                          marginRight: "10px",
                        }}
                      >
                        2次面接用
                      </span>
                      事前確認・面接議事録
                    </h4>
                    <div style={{ marginBottom: "24px" }}>
                      <label style={s.lbl}>質疑応答 (Q&A)</label>
                      {qa2.map((qa, i) => (
                        <div
                          key={i}
                          style={{
                            background: "#f1f5f9",
                            padding: "16px",
                            borderRadius: "6px",
                            marginBottom: "12px",
                            border: `1px solid ${thm.brd}`,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: "8px",
                            }}
                          >
                            <select
                              value={qa.asker}
                              onChange={(e) =>
                                updArr(setQa2, i, "asker", e.target.value)
                              }
                              style={{
                                padding: "6px",
                                borderRadius: "4px",
                                background:
                                  qa.asker === "candidate"
                                    ? "#fffbeb"
                                    : "#eff6ff",
                                border: `1px solid ${thm.brd}`,
                                fontWeight: "bold",
                              }}
                            >
                              <option value="interviewer">
                                Q. 面接官 / 人事
                              </option>
                              <option value="candidate">Q. 応募者</option>
                            </select>
                            <button
                              onClick={() => rmArr(setQa2, i)}
                              style={{
                                border: "none",
                                background: "none",
                                color: thm.dng,
                                cursor: "pointer",
                                fontWeight: "bold",
                              }}
                            >
                              削除 ×
                            </button>
                          </div>
                          <textarea
                            value={qa.q}
                            onChange={(e) =>
                              updArr(setQa2, i, "q", e.target.value)
                            }
                            placeholder="質問内容..."
                            style={{
                              ...s.txtArea,
                              minHeight: "50px",
                              marginBottom: "8px",
                            }}
                          />
                          <textarea
                            value={qa.a}
                            onChange={(e) =>
                              updArr(setQa2, i, "a", e.target.value)
                            }
                            placeholder="回答・メモ..."
                            style={{ ...s.txtArea, minHeight: "50px" }}
                          />
                        </div>
                      ))}
                      <button
                        onClick={() =>
                          addArr(setQa2, { asker: "interviewer", q: "", a: "" })
                        }
                        style={s.actBtn}
                      >
                        ＋ 質疑応答を追加
                      </button>
                    </div>
                    <div>
                      <label style={s.lbl}>2次面接 特記事項・最終所感</label>
                      <textarea
                        name="interview_2_memo"
                        value={f.interview_2_memo}
                        onChange={hChg}
                        style={{ ...s.txtArea, minHeight: "120px" }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 下部アクションボタン */}
            <div
              style={{
                display: "flex",
                justifyContent:
                  activeTab === "detail" && !isCoop
                    ? "space-between"
                    : "flex-end",
                alignItems: "center",
                marginTop: "30px",
                borderTop: `1px solid ${thm.brd}`,
                paddingTop: "20px",
              }}
            >
              {activeTab === "detail" && !isCoop && (
                <div>
                  {!showRetireInput ? (
                    <button
                      onClick={() => setShowRetireInput(true)}
                      style={{
                        ...s.actBtn,
                        color: thm.mut,
                        borderColor: thm.brd,
                      }}
                    >
                      退職処理
                    </button>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        background: "#fef2f2",
                        padding: "8px 16px",
                        borderRadius: "6px",
                        border: "1px solid #fecdd3",
                      }}
                    >
                      <label
                        style={{
                          fontSize: "13px",
                          color: thm.dng,
                          fontWeight: "bold",
                          margin: 0,
                        }}
                      >
                        退職日
                      </label>
                      <input
                        type="date"
                        max="9999-12-31"
                        name="retirement_date"
                        value={f.retirement_date}
                        onChange={hChg}
                        style={{
                          ...s.inp,
                          width: "150px",
                          padding: "6px",
                          margin: 0,
                        }}
                      />
                      <button
                        onClick={() => handleSave()}
                        style={{
                          ...s.btn,
                          background: thm.dng,
                          padding: "8px 16px",
                          fontSize: "13px",
                        }}
                      >
                        退職日確定
                      </button>
                    </div>
                  )}
                </div>
              )}
              {!(activeTab === "interview" && isJoined) && (
                <button onClick={() => handleSave()} style={s.btn}>
                  この内容を保存する
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {selOpen && (
        <SelectionModal
          candidate={cand}
          onClose={() => setSelOpen(false)}
          onChanged={applySelection}
          onUnavailable={() => { setSelOpen(false); setSelUnavailable(true); }}
        />
      )}
      {legacyProgress && (
        <ProgressModal
          cand={cand}
          onClose={() => setLegacyProgress(false)}
          onUpdate={refreshSelectionFields}
        />
      )}
    </div>
  );
};

// --- 進捗モーダル（協力業者、および選考履歴テーブル未作成時の個人応募） ---
const ProgressModal = ({ cand, onClose, onUpdate }) => {
  const [f, setF] = useState({
    status: "1",
    decline_reason: "",
    interview_1_date: "",
    interview_2_date: "",
    offer_date: "",
    expected_join_date: "",
    interview_2_attendee: "",
    applied_at: "",
    internal_contact: "", // ★協力業者用の社内担当者を追加
  });
  const [contactHist, setContactHist] = useState([]);
  const [ld, setLd] = useState(false);
  const [declineMode, setDeclineMode] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  useEffect(() => {
    if (cand) {
      setF({
        status: String(cand.status || "1"),
        offer_date: cand.offer_date ? cand.offer_date.slice(0, 10) : "",
        decline_reason: cand.decline_reason || "",
        interview_1_date: cand.interview_1_date
          ? cand.interview_1_date.split("T")[0]
          : "",
        interview_2_date: cand.interview_2_date
          ? cand.interview_2_date.split("T")[0]
          : "",
        expected_join_date: cand.expected_join_date
          ? cand.expected_join_date.split("T")[0]
          : "",
        interview_2_attendee: cand.interview_2_attendee || "",
        applied_at: cand.applied_at ? cand.applied_at.split("T")[0] : "",
        internal_contact: cand.internal_contact || "", // ★初期値セット
      });
      setContactHist(cand.contact_history || []);
      setDeclineMode(false);
      setDeclineReason("");
    }
  }, [cand]);

  if (!cand) return null;

  const handleSave = async (overrideData = null) => {
    setLd(true);
    try {
      // 基本のペイロード作成
      let payload = {
        ...cand,
        ...f,
        contact_history: contactHist,
        ...(overrideData || {}),
      };

      // ★協力業者フローの自動完了ロジック
      // ステータスが「2 (担当者設定)」で、担当者名が入力されていれば「9 (完了)」に書き換えて保存
      if (cand.is_coop && f.status === "2") {
        if (!f.internal_contact.trim()) {
          alert("社内担当者名を入力してください");
          setLd(false);
          return;
        }
        payload.status = "9";
      }

      const res = await apiFetch(`/api/candidates/${cand.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        onUpdate();
        onClose();
      } else if (res.status === 409) {
        // 選考履歴の利用開始後は、個人応募の進捗は選考の更新から変更する
        const data = await res.json().catch(() => null);
        alert(data?.error || "画面が古いため保存できません。再読み込みしてください。");
      } else {
        alert(
          `保存エラー (エラーコード: ${res.status})\n\nAPIサーバーがパニックを起こしています。\nVSCodeの「api-serverのターミナル」に詳細なエラー原因（英語）が出ているので確認してください。`,
        );
      }
    } catch (e) {
      alert("通信エラー");
    } finally {
      setLd(false);
    }
  };

  const submitDecline = (type) => {
    let stage =
      f.status === "3"
        ? "1次面接"
        : f.status === "4"
          ? "2次面接"
          : f.status === "5"
            ? "内定"
            : "";
    if (type === "無断辞退") {
      if (window.confirm("無断辞退として処理しますか？"))
        handleSave({ status: "9", decline_reason: `${stage}無断辞退` });
    } else {
      if (!declineReason.trim()) {
        alert("辞退理由を入力してください");
        return;
      }
      handleSave({
        status: "9",
        decline_reason: `${stage}辞退: ${declineReason}`,
      });
    }
  };

  const updateCH = (i, fld, val) => {
    const n = [...contactHist];
    n[i][fld] = val;
    setContactHist(n);
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: thm.crd,
          padding: "30px",
          borderRadius: "8px",
          width: "450px",
          border: `1px solid ${thm.brd}`,
          maxHeight: "90vh",
          overflowY: "auto",
          position: "relative",
        }}
      >
        {/* クルクル */}
        {ld && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(255, 255, 255, 0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                width: "40px",
                height: "40px",
                border: `4px solid ${thm.mut}`,
                borderTop: `4px solid ${thm.pri}`,
                borderRadius: "50%",
                animation: "spin 1s linear infinite",
              }}
            />
          </div>
        )}

        <h3 style={{ marginTop: 0, color: thm.txt }}>
          進捗更新: {cand.name_kanji}様
        </h3>

        {/* 受付日の修正 */}
        <div
          style={{
            marginBottom: "20px",
            borderBottom: `1px solid ${thm.brd}`,
            paddingBottom: "16px",
          }}
        >
          <label style={s.lbl}>受付日の修正</label>
          <input
            type="date"
            max="9999-12-31"
            value={f.applied_at}
            onChange={(e) => setF({ ...f, applied_at: e.target.value })}
            style={s.inp}
          />
        </div>

        <label style={s.lbl}>ステータス</label>
        <select
          name="status"
          value={f.status}
          onChange={(e) => {
            setF({ ...f, status: e.target.value });
            setDeclineMode(false);
          }}
          style={{ ...s.inp, marginBottom: "20px" }}
        >
          {cand.is_coop ? (
            /* ★協力業者用オプション */
            <>
              <option value="1">受付</option>
              <option value="2">担当者設定</option>
              <option value="9">完了</option>
            </>
          ) : (
            /* 個人用オプション */
            <>
              <option value="1">受付</option>
              <option value="2">面接打診中</option>
              <option value="3">1次面接予定</option>
              <option value="4">2次面接予定</option>
              <option value="5">内定</option>
              <option value="6">入社</option>
              <option value="9">不採用 / 終了</option>
            </>
          )}
        </select>

        {/* ★協力業者：担当者入力欄 (ステータス2の時だけ出す) */}
        {cand.is_coop && f.status === "2" && (
          <div
            style={{
              marginBottom: "20px",
              background: "#f0f9ff",
              padding: "16px",
              borderRadius: "6px",
              border: `1px solid ${thm.pri}`,
            }}
          >
            <label style={s.lbl}>社内担当者名を入力</label>
            <input
              type="text"
              value={f.internal_contact}
              onChange={(e) => setF({ ...f, internal_contact: e.target.value })}
              placeholder="例: 山田太郎"
              style={s.inp}
            />
            <p
              style={{
                fontSize: "11px",
                color: thm.pri,
                marginTop: "8px",
                fontWeight: "bold",
              }}
            >
              ※保存すると自動的に「完了」ステータスになります。
            </p>
          </div>
        )}

        {/* --- 個人用：連絡履歴 (協力業者でも表示する場合は残す) --- */}
        {!cand.is_coop && f.status === "2" && (
          <div
            style={{
              marginBottom: "20px",
              background: "#f8fafc",
              padding: "16px",
              borderRadius: "6px",
              border: `1px solid ${thm.brd}`,
            }}
          >
            <label style={s.lbl}>面接打診の連絡履歴</label>
            {contactHist.map((ch, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "12px",
                  marginBottom: "8px",
                  alignItems: "center",
                }}
              >
                <input
                  type="date"
                  max="9999-12-31"
                  value={ch.date || ""}
                  onChange={(e) => updateCH(i, "date", e.target.value)}
                  style={{ ...s.inp, width: "130px", padding: "6px" }}
                />
                <label
                  style={{
                    fontSize: "13px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ch.tel || false}
                    onChange={(e) => updateCH(i, "tel", e.target.checked)}
                  />{" "}
                  TEL
                </label>
                <label
                  style={{
                    fontSize: "13px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ch.email || false}
                    onChange={(e) => updateCH(i, "email", e.target.checked)}
                  />{" "}
                  Mail
                </label>
                <button
                  onClick={() =>
                    setContactHist(contactHist.filter((_, idx) => idx !== i))
                  }
                  style={{
                    ...s.actBtn,
                    color: thm.dng,
                    border: "none",
                    background: "none",
                    padding: 0,
                  }}
                >
                  {" "}
                  ×{" "}
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setContactHist([
                  ...contactHist,
                  { date: "", tel: false, email: false },
                ])
              }
              style={s.actBtn}
            >
              {" "}
              ＋ 追加{" "}
            </button>
          </div>
        )}

        {/* --- 個人用：面接予定・入社予定 --- */}
        {!cand.is_coop && f.status === "3" && (
          <div style={{ marginBottom: "20px" }}>
            <label style={s.lbl}>1次面接 予定日</label>
            <input
              type="date"
              max="9999-12-31"
              value={f.interview_1_date}
              onChange={(e) => setF({ ...f, interview_1_date: e.target.value })}
              style={s.inp}
            />
          </div>
        )}

        {!cand.is_coop && f.status === "4" && (
          <div style={{ marginBottom: "20px" }}>
            <label style={s.lbl}>2次面接 予定日</label>
            <input
              type="date"
              max="9999-12-31"
              value={f.interview_2_date}
              onChange={(e) => setF({ ...f, interview_2_date: e.target.value })}
              style={{ ...s.inp, marginBottom: "12px" }}
            />
            <label style={s.lbl}>同席者</label>
            <input
              type="text"
              value={f.interview_2_attendee}
              onChange={(e) =>
                setF({ ...f, interview_2_attendee: e.target.value })
              }
              placeholder="例: 山田部長"
              style={s.inp}
            />
          </div>
        )}

        {!cand.is_coop && <OfferDateField value={f.offer_date} onChange={value => setF(previous => ({ ...previous, offer_date: value }))}/>}
        {!cand.is_coop && f.status === "5" && (
          <div style={{ marginBottom: "20px" }}>
            <label style={s.lbl}>入社予定日</label>
            <input
              type="date"
              max="9999-12-31"
              value={f.expected_join_date}
              onChange={(e) =>
                setF({ ...f, expected_join_date: e.target.value })
              }
              style={s.inp}
            />
          </div>
        )}

        {/* 不採用理由 (個人用) */}
        {!cand.is_coop && f.status === "9" && (
          <div style={{ marginBottom: "20px" }}>
            <label style={{ ...s.lbl, color: thm.dng }}>不採用・終了理由</label>
            <textarea
              value={f.decline_reason}
              onChange={(e) => setF({ ...f, decline_reason: e.target.value })}
              placeholder="不採用の理由など..."
              style={s.txtArea}
            />
          </div>
        )}

        {/* --- アクションボタン --- */}
        {!declineMode ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "24px",
              borderTop: `1px solid ${thm.brd}`,
              paddingTop: "16px",
            }}
          >
            <div style={{ display: "flex", gap: "8px", width: "100%" }}>
              <button onClick={onClose} style={s.actBtn} disabled={ld}>
                キャンセル
              </button>
              <button
                onClick={() => handleSave()}
                disabled={ld}
                style={{
                  ...s.btn,
                  padding: "8px 16px",
                  fontSize: "13px",
                  flex: 1,
                }}
              >
                保存
              </button>

              {/* 協力業者以外の場合のみ辞退ボタンを表示 */}
              {!cand.is_coop &&
                (f.status === "3" || f.status === "4" || f.status === "5") && (
                  <button
                    onClick={() => setDeclineMode(true)}
                    disabled={ld}
                    style={{ ...s.actBtn, color: thm.mut, marginLeft: "12px" }}
                  >
                    辞退
                  </button>
                )}
              {!cand.is_coop && (f.status === "3" || f.status === "4") && (
                <button
                  onClick={() => submitDecline("無断辞退")}
                  disabled={ld}
                  style={{
                    ...s.actBtn,
                    color: thm.dng,
                    borderColor: "#fca5a5",
                  }}
                >
                  無断辞退
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            style={{
              marginTop: "20px",
              borderTop: `1px dashed ${thm.dng}`,
              paddingTop: "16px",
            }}
          >
            <label style={{ ...s.lbl, color: thm.dng }}>辞退理由を入力</label>
            <textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="他社で内定が出たため、等"
              style={{ ...s.txtArea, marginBottom: "8px" }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
              }}
            >
              <button
                onClick={() => setDeclineMode(false)}
                style={s.actBtn}
                disabled={ld}
              >
                {" "}
                戻る{" "}
              </button>
              <button
                onClick={() => submitDecline("辞退")}
                disabled={ld}
                style={{
                  ...s.btn,
                  background: thm.dng,
                  padding: "8px 16px",
                  fontSize: "13px",
                }}
              >
                {" "}
                辞退確定{" "}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// --- 一覧画面 ---
// 一覧のタブ（表示上の分類のみ。不採用・辞退になっても is_deleted などの値は変更しない）
// 従来の「退職・削除済」（論理削除・退職）は終了・削除済タブに含め、復元・完全消去の操作も従来どおりその行だけに出す。
const LIST_TABS = [
  { id: "active", label: "進行中" },
  { id: "joined", label: "入社済" },
  { id: "ended", label: "終了・削除済" },
  { id: "coop", label: "協力業者" },
];
const retiredOn = (c) => {
  if (!c.retirement_date) return null;
  const d = new Date(c.retirement_date);
  d.setHours(0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
};
const isArchivedRow = (c, today) => {
  const ret = retiredOn(c);
  return Boolean(c.is_deleted || c.is_retired || (ret && ret <= today));
};
const listTab = (c, today) => {
  if (isArchivedRow(c, today)) return "ended";
  if (c.is_coop) return "coop";
  const st = String(c.status);
  if (st === "9") return "ended";
  if (st === "6") return "joined";
  return "active";
};
// 氏名（漢字・かな）・会社名。空白（全角を含む）の有無・英字の大小は区別しない
const searchKey = (v) => String(v ?? "").toLowerCase().replace(/\s+/g, "");
const matchesSearch = (c, q) => {
  const key = searchKey(q);
  return !key || [c.name_kanji, c.name_kana, c.company_name].some((v) => searchKey(v).includes(key));
};
const slashDate = (d) => (d ? `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");

const CandidateList = () => {
  const [cands, setCands] = useState([]);
  const [ld, setLd] = useState(true);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "applied_at", dir: "desc" });
  const [progMod, setProgMod] = useState(null);
  // 個人応募の「更新」は共通の選考更新モーダル（協力業者・DB適用前は従来の進捗モーダル）
  const [selMod, setSelMod] = useState(null);
  const openUpdate = (c) => (c.is_coop ? setProgMod(c) : setSelMod(c));
  const thList = { ...s.th, padding: "8px 10px" };
  const tdMid = { ...s.td, padding: "6px 10px", verticalAlign: "middle" };

  const [viewMode, setViewMode] = useState("active");

  const nav = useNavigate();

  const fetchC = () => {
    apiFetch("/api/candidates")
      .then((r) => r.json())
      .then((d) => {
        setCands(d);
        setLd(false);
      });
  };
  useEffect(() => fetchC(), []);

  const hDel = async (id) => {
    if (!window.confirm("一覧から削除（非表示に）しますか？")) return;
    try {
      await apiFetch(`/api/candidates/${id}`, {
        method: "DELETE",
      });
      fetchC();
    } catch (e) {}
  };

  const hRestore = async (id) => {
    if (!window.confirm("このデータを復元しますか？")) return;
    try {
      await apiFetch(`/api/candidates/${id}/restore`, {
        method: "PATCH",
      });
      fetchC();
    } catch (e) {}
  };

  // ★追加：完全消去機能
  const hHardDel = async (id) => {
    if (
      !window.confirm(
        "【警告】データベースから完全に消去します。\n統計からも消滅し、二度と復元できません。本当に完全消去しますか？",
      )
    )
      return;
    try {
      await apiFetch(`/api/candidates/${id}/physical`, {
        method: "DELETE",
      });
      fetchC();
    } catch (e) {}
  };

  const reqSort = (k) =>
    setSort({
      key: k,
      dir: sort.key === k && sort.dir === "asc" ? "desc" : "asc",
    });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 検索は全タブに適用し、各タブの件数に該当件数を表示する
  const hits = cands.filter((c) => matchesSearch(c, q));
  const tabCount = (id) => hits.filter((c) => listTab(c, today) === id).length;
  const filt = hits.filter((c) => listTab(c, today) === viewMode);

  filt.sort((a, b) => {
    const A = a[sort.key];
    const B = b[sort.key];
    if (A < B) return sort.dir === "asc" ? -1 : 1;
    if (A > B) return sort.dir === "asc" ? 1 : -1;
    return 0;
  });

  // 連絡先：バッジを上段、電話番号・アドレスを下段
  const renderContact = (c) => {
    const isE = c.primary_contact?.startsWith("email");
    const idx = parseInt(c.primary_contact?.split("_")[1] || 0);
    if (isE && c.email && c.email[idx])
      return (
        <div className="nks-contact">
          <span className="nks-contact-badge is-mail">メール</span>
          <a href={`mailto:${c.email[idx]}`} className="nks-contact-value">
            {c.email[idx]}
          </a>
        </div>
      );
    if (c.tel && c.tel[idx])
      return (
        <div className="nks-contact">
          <span className="nks-contact-badge is-tel">TEL</span>
          <span className="nks-contact-value">{c.tel[idx]}</span>
        </div>
      );
    return <span>-</span>;
  };

  // 終了・削除済タブの補足（終了理由・終了日。日付が分からない場合は推測しない）
  const renderEndNote = (c) => {
    const notes = [];
    if (c.is_deleted) notes.push(<span key="del" className="nks-end-tag">削除済</span>);
    if (String(c.status) === "9" && !c.is_coop) {
      notes.push(
        <span key="date" className="nks-end-date">
          {c.selection_ended_date ? `終了日 ${slashDate(c.selection_ended_date)}` : "終了日不明"}
        </span>,
      );
      if (c.decline_reason) notes.push(<span key="reason" className="nks-end-reason" title={c.decline_reason}>{c.decline_reason}</span>);
    }
    return notes.length ? <div className="nks-end-note">{notes}</div> : null;
  };

  return (
    <div style={s.main}>
      <div style={{ maxWidth: "1100px" }}>
        {/* ヘッダー固定：見出し・タブ・検索・新規登録を左寄せで1段に集約 */}
        <div className="nks-list-head" style={{ backgroundColor: thm.bg }}>
          <h2>応募者一覧</h2>
          <div className="nks-list-tabs" role="tablist">
            {LIST_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={viewMode === tab.id}
                className={viewMode === tab.id ? "is-active" : ""}
                onClick={() => setViewMode(tab.id)}
              >
                {tab.label}
                <span className="nks-list-tab-count">{tabCount(tab.id)}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder="氏名・会社名で検索（全タブ）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="nks-list-search"
          />
          <Link to="/register" className="nks-list-new">
            新規登録
          </Link>
        </div>

        <div className="nks-list-card">
          {ld ? (
            <p>読込中...</p>
          ) : (
            <div style={s.tableContainer}>
              <table style={s.tbl}>
                <thead>
                  <tr>
                    <th style={{ ...thList, width: "60px" }}>詳細</th>
                    <th style={thList} onClick={() => reqSort("applied_at")}>
                      受付日{" "}
                      {sort.key === "applied_at" &&
                        (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th
                      style={{ ...thList, minWidth: "180px" }}
                      onClick={() => reqSort("name_kana")}
                    >
                      氏名 / 会社名{" "}
                      {sort.key === "name_kana" &&
                        (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th style={thList} onClick={() => reqSort("age")}>
                      年齢{" "}
                      {sort.key === "age" && (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th style={thList}>連絡先</th>
                    <th style={thList} onClick={() => reqSort("status")}>
                      進捗{" "}
                      {sort.key === "status" &&
                        (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th style={{ ...thList, width: "80px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filt.map((c) => {
                    const ret = retiredOn(c);
                    const archived = isArchivedRow(c, today);
                    const retired = c.is_retired || (ret && ret <= today);
                    const ended = viewMode === "ended";

                    return (
                      <tr
                        key={c.id}
                        className={ended ? "nks-row-ended" : undefined}
                        style={{ backgroundColor: c.is_coop ? "#f0f9ff" : "transparent" }}
                      >
                        <td style={tdMid}>
                          <button
                            type="button"
                            onClick={() =>
                              nav(`/candidates/${c.id}?view=detail`)
                            }
                            className="nks-row-btn"
                          >
                            詳細
                          </button>
                        </td>
                        <td style={tdMid}>
                          {new Date(c.applied_at).toLocaleDateString("ja-JP")}
                        </td>
                        <td style={tdMid}>
                          <div className="nks-list-cell">
                            <div className="nks-list-cell-main">
                              <span style={{ fontWeight: "bold", fontSize: "15px" }}>
                                {c.name_kanji}
                              </span>
                              <span style={{ fontSize: "11px", color: thm.mut }}>
                                {c.name_kana}
                                {c.is_coop && c.company_name ? ` ／ ${c.company_name}` : ""}
                              </span>
                            </div>
                            {!c.is_coop && (
                              <button
                                type="button"
                                onClick={() =>
                                  nav(`/candidates/${c.id}?view=interview`)
                                }
                                className="nks-row-btn nks-row-btn-primary"
                              >
                                面接
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={tdMid}>
                          {c.is_coop
                            ? "-"
                            : calcCurrentAge(c.birth_date) || c.age || "-"}
                        </td>
                        <td style={tdMid}>{renderContact(c)}</td>
                        <td style={tdMid}>
                          <div className="nks-list-cell">
                            <div className="nks-list-cell-main">
                              {retired ? (
                                <span
                                  style={{
                                    ...s.badge,
                                    background: "#fef2f2",
                                    color: thm.dng,
                                  }}
                                >{ret ? `${ret.getMonth() + 1}月${ret.getDate()}日退職済` : "退職済"}</span>
                              ) : (
                                <ProgressStatus candidate={c} s={s} thm={thm} />
                              )}
                              {ended && renderEndNote(c)}
                            </div>
                            {/* 更新できない行も同じ幅を確保し、バッジ・ボタンの位置を揃える */}
                            {!archived && String(c.status) !== "6" ? (
                              <button
                                type="button"
                                onClick={() => openUpdate(c)}
                                className="nks-row-btn"
                              >
                                更新
                              </button>
                            ) : (
                              <span className="nks-row-btn nks-row-btn-placeholder" aria-hidden="true">更新</span>
                            )}
                          </div>
                        </td>
                        <td style={tdMid}>
                          {archived ? (
                            <div className="nks-list-buttons">
                              <button
                                type="button"
                                onClick={() => hRestore(c.id)}
                                className="nks-row-btn nks-row-btn-primary"
                              >
                                復元
                              </button>
                              <button
                                type="button"
                                onClick={() => hHardDel(c.id)}
                                className="nks-row-btn nks-row-btn-solid-danger"
                              >
                                完全消去
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => hDel(c.id)}
                              className="nks-row-btn nks-row-btn-danger"
                            >
                              削除
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filt.length === 0 && (
                    <tr>
                      <td
                        colSpan="7"
                        style={{
                          padding: "24px",
                          textAlign: "center",
                          color: thm.mut,
                        }}
                      >
                        {q ? "このタブに該当する応募者はいません（他のタブの件数を確認してください）" : "データがありません"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <ProgressModal
        cand={progMod}
        onClose={() => setProgMod(null)}
        onUpdate={fetchC}
      />
      {selMod && (
        <SelectionModal
          candidate={selMod}
          onClose={() => setSelMod(null)}
          onChanged={fetchC}
          onUnavailable={() => { setProgMod(selMod); setSelMod(null); }}
        />
      )}
    </div>
  );
};

// --- 受付（新規登録） ---
const RegistrationForm = () => {
  const [f, setF] = useState({
    is_coop: false, // ★個人(false)か協力業者(true)か
    is_solo: false, // ★個人事業主チェック
    name_kanji: "",
    name_kana: "",
    company_name: "", // ★協力業者用
    age: "",
    birth_year: "",
    experience: "不明",
    tel: [""],
    email: [""],
    primary_contact: "tel_0",
    applied_at: todayTokyo(),
    introducer: "", // ★紹介元
    internal_contact: "", // ★社内担当
    desired_dept: "", // ★希望部署
    job_title: "",
    planned_department: "",
    employment_type: "",
    source_type: "",
    agent_name: "",
    introducer_fee: "",
  });

  const hChg = (e) => setF({ ...f, [e.target.name]: e.target.value });
  const curr = new Date().getFullYear();

  const hAge = (e) => {
    const v = forceHalfWidthNumber(e.target.value);
    setF({
      ...f,
      age: v,
      birth_year: v && !isNaN(v) ? String(curr - parseInt(v)) : "",
    });
  };

  const hBy = (e) => {
    const v = forceHalfWidthNumber(e.target.value);
    setF({
      ...f,
      birth_year: v,
      age: v.length === 4 && !isNaN(v) ? String(curr - parseInt(v)) : "",
    });
  };

  const handleSave = async () => {
    if (!f.applied_at || !validFourDigitDate(f.applied_at)) {
      alert("受付日を西暦4桁で入力してください");
      return;
    }

    // 協力業者の場合の「進捗」初期値設定
    const initialStatus = f.is_coop && f.internal_contact ? "2" : "1";

    // name_kana の決定ロジック
    let finalNameKana = cleanText(f.name_kana);
    if (f.is_coop) {
      // 協力業者かつ個人事業主チェックがあれば「個人事業主」、なければ会社名
      finalNameKana = f.is_solo ? "個人事業主" : cleanText(f.company_name);
    }

    try {
      const res = await apiFetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...f,
          name_kanji: cleanText(f.name_kanji),
          name_kana: finalNameKana, // 決定した値を送る
          status: initialStatus,
          tel: f.tel.filter((t) => t !== ""),
          email: f.email.filter((e) => e !== ""),
        }),
      });
      if (res.ok) {
        alert("完了");
        setF({
          is_coop: false,
          is_solo: false,
          name_kanji: "",
          name_kana: "",
          company_name: "",
          age: "",
          birth_year: "",
          experience: "不明",
          tel: [""],
          email: [""],
          primary_contact: "tel_0",
          applied_at: todayTokyo(),
          introducer: "",
          internal_contact: "",
          desired_dept: "",
          job_title: "",
          planned_department: "",
          employment_type: "",
          source_type: "",
          agent_name: "",
          introducer_fee: "",
        });
      }
    } catch (e) {
      alert("エラー");
    }
  };

  const updA = (arr, i, v) =>
    setF({ ...f, [arr]: f[arr].map((x, idx) => (idx === i ? v : x)) });

  return (
    <div style={s.main}>
      <div style={{ maxWidth: "600px", margin: "0 auto" }}>
        <h2 style={{ fontSize: "24px", margin: "0 0 24px 0" }}>新規受付</h2>

        {/* カテゴリ選択 (個人 or 協力業者) */}
        <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
          <button
            onClick={() => setF({ ...f, is_coop: false })}
            style={{
              ...s.btn,
              flex: 1,
              background: !f.is_coop ? thm.pri : "#e2e8f0",
              color: !f.is_coop ? "#fff" : thm.txt,
            }}
          >
            個人応募
          </button>
          <button
            onClick={() => setF({ ...f, is_coop: true })}
            style={{
              ...s.btn,
              flex: 1,
              background: f.is_coop ? "#0ea5e9" : "#e2e8f0",
              color: f.is_coop ? "#fff" : thm.txt,
            }}
          >
            協力業者
          </button>
        </div>

        <div
          style={{
            ...s.card,
            borderTop: f.is_coop ? `6px solid #0ea5e9` : `6px solid ${thm.pri}`,
          }}
        >
          {/* 受付日 (全モード共通) */}
          <div style={{ marginBottom: "20px" }}>
            <label style={s.lbl}>受付日 (必須)</label>
            <input
              type="date"
              max="9999-12-31"
              value={f.applied_at}
              onChange={(e) => setF({ ...f, applied_at: e.target.value })}
              style={s.inp}
            />
          </div>

          {/* --- モード別入力項目 --- */}
          {!f.is_coop ? (
            /* 個人の場合 */
            <>
              <div style={s.flexRow}>
                <div style={{ flex: 1 }}>
                  <label style={s.lbl}>氏名</label>
                  <input
                    name="name_kanji"
                    value={f.name_kanji}
                    onChange={hChg}
                    onBlur={(e) =>
                      setF({ ...f, name_kanji: cleanText(e.target.value) })
                    }
                    style={s.inp}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.lbl}>フリガナ</label>
                  <input
                    name="name_kana"
                    value={f.name_kana}
                    onChange={hChg}
                    onBlur={(e) =>
                      setF({ ...f, name_kana: cleanText(e.target.value) })
                    }
                    style={s.inp}
                  />
                </div>
              </div>

              <div
                style={{
                  ...s.flexRow,
                  background: "#f8fafc",
                  padding: "16px",
                  borderRadius: "6px",
                  border: `1px solid ${thm.brd}`,
                  marginBottom: "16px",
                }}
              >
                <div style={{ flex: 1 }}>
                  <label style={s.lbl}>参考年齢</label>
                  <input value={f.age} onChange={hAge} style={s.inp} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.lbl}>参考生年</label>
                  <input value={f.birth_year} onChange={hBy} style={s.inp} />
                </div>
              </div>

              <div className="nks-secondary-fields">
                <div className="nks-secondary-title">採用条件 <span>任意</span></div>
                <EmploymentFields value={f} onChange={hChg} />
              </div>
              <div style={{ marginBottom: "16px" }}>
                <label style={s.lbl}>職種経験</label>
                <div style={{ display: "flex", gap: "16px" }}>
                  {["経験者", "未経験者", "不明"].map((x) => (
                    <label key={x} style={{ fontSize: "14px" }}>
                      <input
                        type="radio"
                        value={x}
                        checked={f.experience === x}
                        onChange={(e) =>
                          setF({ ...f, experience: e.target.value })
                        }
                      />{" "}
                      {x}
                    </label>
                  ))}
                </div>
              </div>
              <SourceTypeFields value={f} onChange={hChg} />
            </>
          ) : (
            /* 協力業者の場合 */
            <>
              <div style={{ marginBottom: "16px" }}>
                <label style={s.lbl}>応募経路・紹介元</label>
                <input
                  name="introducer"
                  value={f.introducer}
                  onChange={hChg}
                  placeholder="例：〇〇紹介、ホームページ等"
                  style={s.inp}
                />
              </div>

              <div style={s.flexRow}>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-end",
                      marginBottom: "4px",
                    }}
                  >
                    <label style={{ ...s.lbl, marginBottom: 0 }}>会社名</label>
                    <label
                      style={{
                        fontSize: "12px",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        color: thm.pri,
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={f.is_solo}
                        onChange={(e) =>
                          setF({ ...f, is_solo: e.target.checked })
                        }
                      />
                      個人事業主
                    </label>
                  </div>
                  <input
                    name="company_name"
                    value={f.company_name}
                    onChange={hChg}
                    disabled={f.is_solo} // チェック時は会社名入力を無効化
                    placeholder={f.is_solo ? "（個人事業主）" : "株式会社〇〇"}
                    style={s.inp}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.lbl}>担当者名</label>
                  <input
                    name="name_kanji"
                    value={f.name_kanji}
                    onChange={hChg}
                    placeholder="連絡先担当者"
                    style={s.inp}
                  />
                </div>
              </div>

              <div style={s.flexRow}>
                <div style={{ flex: 1 }}>
                  <label style={s.lbl}>希望部署</label>
                  <input
                    name="desired_dept"
                    value={f.desired_dept}
                    onChange={hChg}
                    placeholder="例：工事部、営業部"
                    style={s.inp}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.lbl}>社内担当者名</label>
                  <input
                    name="internal_contact"
                    value={f.internal_contact}
                    onChange={hChg}
                    placeholder="連絡を担当する社員"
                    style={s.inp}
                  />
                </div>
              </div>
            </>
          )}

          {/* 連絡先 (共通) */}
          <div
            style={{
              marginBottom: "16px",
              marginTop: f.is_coop ? "20px" : "0",
            }}
          >
            <label style={s.lbl}>連絡先 TEL</label>
            {f.tel.map((t, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "8px",
                  marginBottom: "8px",
                  alignItems: "center",
                }}
              >
                <input
                  value={t}
                  onChange={(e) =>
                    updA("tel", i, forceHalfWidthTel(e.target.value))
                  }
                  onBlur={() => updA("tel", i, formatTelOnBlur(f.tel[i]))}
                  style={s.inp}
                />
                <label
                  style={{
                    fontSize: "13px",
                    color: thm.pri,
                    fontWeight: "bold",
                    whiteSpace: "nowrap",
                  }}
                >
                  <input
                    type="radio"
                    checked={f.primary_contact === `tel_${i}`}
                    onChange={() => setF({ ...f, primary_contact: `tel_${i}` })}
                  />{" "}
                  代表
                </label>
                {i === f.tel.length - 1 && (
                  <button
                    onClick={() => setF({ ...f, tel: [...f.tel, ""] })}
                    style={{
                      ...s.actBtn,
                      borderRadius: "50%",
                      width: "32px",
                      height: "32px",
                      padding: 0,
                    }}
                  >
                    ＋
                  </button>
                )}
              </div>
            ))}
          </div>

          <div style={{ marginBottom: "24px" }}>
            <label style={s.lbl}>連絡先 Email</label>
            {f.email.map((e, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "8px",
                  marginBottom: "8px",
                  alignItems: "center",
                }}
              >
                <input
                  value={e}
                  onChange={(ev) =>
                    updA("email", i, forceHalfWidthEmail(ev.target.value))
                  }
                  style={s.inp}
                />
                <label
                  style={{
                    fontSize: "13px",
                    color: thm.pri,
                    fontWeight: "bold",
                    whiteSpace: "nowrap",
                  }}
                >
                  <input
                    type="radio"
                    checked={f.primary_contact === `email_${i}`}
                    onChange={() =>
                      setF({ ...f, primary_contact: `email_${i}` })
                    }
                  />{" "}
                  代表
                </label>
                {i === f.email.length - 1 && (
                  <button
                    onClick={() => setF({ ...f, email: [...f.email, ""] })}
                    style={{
                      ...s.actBtn,
                      borderRadius: "50%",
                      width: "32px",
                      height: "32px",
                      padding: 0,
                    }}
                  >
                    ＋
                  </button>
                )}
              </div>
            ))}
          </div>

          <button
            onClick={handleSave}
            style={{ ...s.btn, background: f.is_coop ? "#0ea5e9" : thm.pri }}
          >
            {f.is_coop ? "協力業者として登録" : "個人応募として登録"}
          </button>
        </div>
      </div>
    </div>
  );
};

// --- ダッシュボード画面 (統合版・A4印刷対応) ---
// --- 採用経費入力画面 ---
const ExpensePage = () => {
  const [exps, setExps] = useState([]);
  const [payee, setPayee] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  // ★ インライン編集用のステート（これがないと編集ボタンを押しても何も起きません）
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    payee: "",
    amountStr: "",
    expense_date: "",
  });

  const fetchExps = () => {
    apiFetch("/api/expenses")
      .then((res) => res.json())
      .then((data) => setExps(data))
      .catch((err) => console.error("経費取得エラー:", err));
  };

  useEffect(() => {
    fetchExps();
  }, []);

  const handleAmountChange = (e) => {
    const val = forceHalfWidthNumber(e.target.value);
    setAmountStr(val);
  };

  // ★ 編集用の金額入力制御
  const handleEditAmountChange = (e) => {
    const val = forceHalfWidthNumber(e.target.value);
    setEditForm({ ...editForm, amountStr: val });
  };

  const handleSave = async () => {
    if (!payee || !amountStr) {
      alert("支払先と金額を入力してください");
      return;
    }
    try {
      const res = await apiFetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payee,
          amount: parseInt(amountStr, 10),
          expense_date: date,
        }),
      });
      if (res.ok) {
        alert("登録しました");
        setPayee("");
        setAmountStr("");
        fetchExps();
      }
    } catch (err) {
      alert("エラーが発生しました");
    }
  };

  // ★ 編集モード開始処理
  const startEdit = (exp) => {
    setEditingId(exp.id);
    setEditForm({
      payee: exp.payee,
      amountStr: String(exp.amount),
      expense_date: exp.expense_date ? exp.expense_date.split("T")[0] : "",
    });
  };

  // ★ 更新（PUT）処理
  const handleUpdate = async (id) => {
    if (!editForm.payee || !editForm.amountStr) {
      alert("支払先と金額を入力してください");
      return;
    }
    try {
      const res = await apiFetch(`/api/expenses/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payee: editForm.payee,
          amount: parseInt(editForm.amountStr, 10),
          expense_date: editForm.expense_date,
        }),
      });
      if (res.ok) {
        setEditingId(null);
        fetchExps();
      } else {
        alert("更新エラー");
      }
    } catch (err) {
      alert("通信エラー");
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("削除しますか？")) return;
    try {
      await apiFetch(`/api/expenses/${id}`, {
        method: "DELETE",
      });
      fetchExps();
    } catch (err) {
      alert("通信エラー");
    }
  };

  return (
    <div style={s.main}>
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
        <h2
          style={{
            fontSize: "24px",
            fontWeight: "bold",
            margin: "0 0 24px 0",
            color: "#1e293b",
          }}
        >
          採用経費入力
        </h2>

        {/* --- 新規登録エリア --- */}
        <div style={s.card}>
          <div style={s.flexRow}>
            <div style={{ flex: 2 }}>
              <label style={s.lbl}>支払先</label>
              <input
                type="text"
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                placeholder="例: タウンワーク、紹介会社A"
                style={s.inp}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.lbl}>金額</label>
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: "12px",
                    top: "11px",
                    color: thm.mut,
                    fontWeight: "bold",
                  }}
                >
                  ¥
                </span>
                <input
                  type="text"
                  value={
                    amountStr ? parseInt(amountStr, 10).toLocaleString() : ""
                  }
                  onChange={handleAmountChange}
                  placeholder="300,000"
                  style={{ ...s.inp, paddingLeft: "30px" }}
                />
              </div>
            </div>
          </div>
          <div style={s.flexRow}>
            <div style={{ flex: 1 }}>
              <label style={s.lbl}>計上日</label>
              <input
                type="date"
                max="9999-12-31"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={s.inp}
              />
            </div>
            <div style={{ flex: 1, paddingTop: "23px", textAlign: "right" }}>
              <button onClick={handleSave} style={s.btn}>
                経費を登録する
              </button>
            </div>
          </div>
        </div>

        {/* --- 登録済み経費一覧エリア --- */}
        <div style={s.card}>
          <h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>
            登録済み経費一覧
          </h3>
          <div style={s.tableContainer}>
            <table
              style={{
                ...s.tbl,
                width: "100%",
                minWidth: "100%",
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr>
                  {/* 操作以外の幅を固定し、支払先を伸び縮みさせる */}
                  <th style={{ ...s.th, width: "100px" }}>計上日</th>
                  <th style={{ ...s.th }}>支払先</th>
                  <th style={{ ...s.th, width: "90px" }}>金額</th>
                  <th style={{ ...s.th, width: "100px", textAlign: "center" }}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {exps.map((e) => (
                  <tr key={e.id}>
                    {editingId === e.id ? (
                      /* ===== 編集モード ===== */
                      <>
                        <td style={{ ...s.td, padding: "8px 4px" }}>
                          <input
                            type="date"
                            max="9999-12-31"
                            value={editForm.expense_date}
                            onChange={(ev) =>
                              setEditForm({
                                ...editForm,
                                expense_date: ev.target.value,
                              })
                            }
                            style={{
                              ...s.inp,
                              padding: "4px",
                              margin: 0,
                              width: "100%",
                              boxSizing: "border-box",
                              fontSize: "12px",
                            }}
                          />
                        </td>
                        <td style={{ ...s.td, padding: "8px 4px" }}>
                          <input
                            type="text"
                            value={editForm.payee}
                            onChange={(ev) =>
                              setEditForm({
                                ...editForm,
                                payee: ev.target.value,
                              })
                            }
                            style={{
                              ...s.inp,
                              padding: "4px",
                              margin: 0,
                              width: "100%",
                              boxSizing: "border-box",
                              fontSize: "12px",
                            }}
                          />
                        </td>
                        <td style={{ ...s.td, padding: "8px 4px" }}>
                          <input
                            type="text"
                            value={
                              editForm.amountStr
                                ? parseInt(
                                    editForm.amountStr,
                                    10,
                                  ).toLocaleString()
                                : ""
                            }
                            onChange={handleEditAmountChange}
                            style={{
                              ...s.inp,
                              padding: "4px",
                              margin: 0,
                              width: "100%",
                              boxSizing: "border-box",
                              textAlign: "right",
                              fontSize: "12px",
                            }}
                          />
                        </td>
                        <td style={{ ...s.td, padding: "8px 4px" }}>
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              justifyContent: "center",
                            }}
                          >
                            <button
                              onClick={() => handleUpdate(e.id)}
                              style={{
                                ...s.btn,
                                padding: "4px",
                                fontSize: "11px",
                                background: thm.pri,
                                flex: 1,
                              }}
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              style={{
                                ...s.actBtn,
                                padding: "4px",
                                fontSize: "11px",
                                color: thm.mut,
                                flex: 1,
                              }}
                            >
                              取消
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      /* ===== 通常モード ===== */
                      <>
                        <td style={s.td}>
                          {new Date(e.expense_date).toLocaleDateString("ja-JP")}
                        </td>
                        <td
                          style={{
                            ...s.td,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {e.payee}
                        </td>
                        <td style={s.td}>¥{e.amount.toLocaleString()}</td>
                        <td style={{ ...s.td, padding: "8px 4px" }}>
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              justifyContent: "center",
                            }}
                          >
                            <button
                              onClick={() => startEdit(e)}
                              style={{
                                ...s.actBtn,
                                color: thm.pri,
                                borderColor: thm.pri,
                                padding: "4px",
                                fontSize: "11px",
                                flex: 1,
                              }}
                            >
                              編集
                            </button>
                            <button
                              onClick={() => handleDelete(e.id)}
                              style={{
                                ...s.actBtn,
                                color: thm.dng,
                                borderColor: "#fca5a5",
                                padding: "4px",
                                fontSize: "11px",
                                flex: 1,
                              }}
                            >
                              削除
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
// --- 統計用の簡単アイコン（追加） ---
const IcoChart = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 20V10M12 20V4M6 20v-6" />
  </svg>
);

// --- サイドバー ---
const Sidebar = () => {
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  const Nav = ({ to, l, ic }) => {
    const a =
      loc.pathname === to || (to !== "/" && loc.pathname.startsWith(to));
    return (
      <Link
        to={to}
        style={{
          display: "flex",
          padding: "12px",
          color: a ? "#fff" : "#c8d4e5",
          background: a ? "rgba(255,255,255,0.12)" : "transparent",
          borderLeft: a ? "3px solid #e60012" : "3px solid transparent",
          borderRadius: "6px",
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        {ic}
        {open && <span style={{ marginLeft: "12px" }}>{l}</span>}
      </Link>
    );
  };

  return (
    <nav
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{
        width: open ? "200px" : "60px",
        background: thm.side,
        padding: "20px 10px",
        overflowY: "auto",
        transition: "width 0.2s",
        height: "100vh",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div
        style={{
          color: "#fff",
          fontWeight: "bold",
          marginBottom: "30px",
          paddingLeft: "10px",
        }}
      >
        {open ? "RM" : "RM"}
      </div>
      <Nav to="/" l="ダッシュボード" ic={<IcoDash />} />
      <Nav to="/register" l="新規受付" ic={<IcoAdd />} />
      <Nav to="/candidates" l="応募者一覧" ic={<IcoUsers />} />
      <Nav to="/expenses" l="採用経費" ic={<IcoMoney />} />
      {/* ★ ここに追加！ */}
      <Nav to="/stats" l="統計ダッシュボード" ic={<IcoChart />} />
    </nav>
  );
};

function ManagementApp() {
  return (
    <Router>
      <div style={s.wrap}>
        <Sidebar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/register" element={<RegistrationForm />} />
          <Route path="/candidates" element={<CandidateList />} />
          <Route path="/candidates/:id" element={<CandidateDetail />} />
          <Route path="/expenses" element={<ExpensePage />} />
          <Route path="/stats" element={<RecruitmentStats />} />
        </Routes>
      </div>
    </Router>
  );
}

export default function App() { return <Auth><ManagementApp /></Auth>; }
