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
  bg: "#f8fafc",
  side: "#1e293b",
  crd: "#ffffff",
  brd: "#cbd5e1",
  txt: "#0f172a",
  mut: "#64748b",
  pri: "#2563eb",
  dng: "#ef4444",
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
    padding: "40px",
    position: "relative",
    boxSizing: "border-box",
  },
  card: {
    backgroundColor: thm.crd,
    borderRadius: "8px",
    padding: "30px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    border: `1px solid ${thm.brd}`,
    marginBottom: "24px",
    textAlign: "left",
  },
  inp: {
    width: "100%",
    padding: "10px 12px",
    border: `1px solid ${thm.brd}`,
    borderRadius: "6px",
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
    padding: "12px 24px",
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
    padding: "4px 8px",
    borderRadius: "4px",
    fontSize: "12px",
    fontWeight: "bold",
    display: "inline-block",
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
const ProgressStatus = ({ candidate, s, thm }) => {
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
    <div style={{ textAlign: "left" }}>
      <div style={{ marginBottom: "4px" }}>
        <span style={badgeStyle}>{label}</span>
      </div>
      {subText && (
        <div
          style={{
            fontSize: "11px",
            fontWeight: "bold",
            color: isAlert ? "#dc2626" : thm.mut,
          }}
        >
          {subText}
        </div>
      )}
    </div>
  );
};

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

  // フォームデータ
  const [f, setF] = useState({});
  const [qa1, setQa1] = useState([]);
  const [qa2, setQa2] = useState([]);
  const [workHist, setWorkHist] = useState([]);
  const [lic, setLic] = useState([]);
  const [fam, setFam] = useState([]);
  const currYear = new Date().getFullYear();

  // ★ タイムラインでの辞退処理用ステート
  const [timelineDecline, setTimelineDecline] = useState({
    active: false,
    stage: "",
    reason: "",
  });

  useEffect(() => {
    fetch(`http://192.168.11.18:5000/api/candidates/${id}`)
      .then((res) => res.json())
      .then((d) => {
        setCand(d);
        const fmtDt = (str) => (str ? str.split("T")[0] : "");
        setF({
          ...d, // 全てのカラム（is_coop含む）をロード
          source_type: d.source_type || "求人", // ★追加：デフォルトは「求人」
          introducer_fee: d.introducer_fee || "", // ★追加
          status: String(d.status || "1"),
          birth_date: fmtDt(d.birth_date),
          expected_join_date: fmtDt(d.expected_join_date),
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
          await fetch("http://192.168.11.18:5000/api/expenses", {
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
      const res = await fetch(
        `http://192.168.11.18:5000/api/candidates/${id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (res.ok) {
        alert("データを保存・更新しました");
        setShowRetireInput(false);
        // 保存後に元データの状態も更新（二重計上防止）
        setCand({ ...cand, status: payload.status });
        setF((prev) => ({
          ...prev,
          status: payload.status,
          decline_reason: payload.decline_reason || prev.decline_reason,
        }));
      } else alert("保存失敗");
    } catch (e) {
      alert("通信エラー");
    }
  };

  // ★ タイムライン用：辞退入力の表示トリガー
  const triggerDecline = (stageName) => {
    setTimelineDecline({ active: true, stage: stageName, reason: "" });
  };

  // ★ タイムライン用：辞退処理の実行（API経由で保存）
  const executeDecline = async (stageName, reasonType) => {
    let finalReason = "";
    if (reasonType === "無断") {
      finalReason = `${stageName}無断辞退`;
      if (!window.confirm(`「${finalReason}」として処理を終了しますか？`))
        return;
    } else {
      if (timelineDecline.reason.trim() === "") {
        alert("辞退理由を入力してください");
        return;
      }
      finalReason = `${stageName}辞退: ${timelineDecline.reason}`;
      if (!window.confirm(`辞退処理を確定しますか？`)) return;
    }

    await handleSave({ status: "9", decline_reason: finalReason });
    setTimelineDecline({ active: false, stage: "", reason: "" });
  };

  // ★ タイムラインノード描画コンポーネント
  const renderTimelineNode = (
    label,
    dateKey,
    stageName,
    showDecline,
    isLast = false,
  ) => (
    <div
      style={{
        display: "flex",
        gap: "12px",
        marginBottom: "16px",
        position: "relative",
      }}
    >
      {!isLast && (
        <div
          style={{
            position: "absolute",
            left: "7px",
            top: "24px",
            bottom: "-20px",
            width: "2px",
            background: thm.brd,
          }}
        />
      )}
      <div
        style={{
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          background: f[dateKey] ? thm.pri : thm.brd,
          position: "relative",
          zIndex: 1,
          marginTop: "4px",
        }}
      />
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: "bold",
            marginBottom: "4px",
            color: thm.txt,
          }}
        >
          {label}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <input
            type="date"
            max="9999-12-31"
            name={dateKey}
            value={f[dateKey] || ""}
            onChange={hChg}
            style={{
              ...s.inp,
              padding: "4px",
              fontSize: "12px",
              width: "130px",
              margin: 0,
            }}
          />
          {/* 終了ステータス以外なら辞退ボタンを表示 */}
          {showDecline && f.status !== "9" && f.status !== "6" && (
            <>
              <button
                onClick={() => triggerDecline(stageName)}
                style={{
                  ...s.actBtn,
                  padding: "4px 8px",
                  fontSize: "11px",
                  color: thm.mut,
                }}
              >
                辞退
              </button>
              <button
                onClick={() => executeDecline(stageName, "無断")}
                style={{
                  ...s.actBtn,
                  padding: "4px 8px",
                  fontSize: "11px",
                  color: thm.dng,
                  borderColor: "#fca5a5",
                }}
              >
                無断
              </button>
            </>
          )}
        </div>
        {/* インライン辞退理由入力エリア */}
        {timelineDecline.active && timelineDecline.stage === stageName && (
          <div
            style={{
              marginTop: "8px",
              padding: "8px",
              background: "#fef2f2",
              border: "1px solid #fecdd3",
              borderRadius: "4px",
            }}
          >
            <input
              type="text"
              placeholder="辞退理由..."
              value={timelineDecline.reason}
              onChange={(e) =>
                setTimelineDecline({
                  ...timelineDecline,
                  reason: e.target.value,
                })
              }
              style={{
                ...s.inp,
                padding: "4px",
                fontSize: "12px",
                marginBottom: "8px",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <div
              style={{
                display: "flex",
                gap: "4px",
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() =>
                  setTimelineDecline({ active: false, stage: "", reason: "" })
                }
                style={{ ...s.actBtn, padding: "4px 8px", fontSize: "11px" }}
              >
                ｷｬﾝｾﾙ
              </button>
              <button
                onClick={() => executeDecline(stageName, "reason")}
                style={{
                  ...s.btn,
                  background: thm.dng,
                  padding: "4px 8px",
                  fontSize: "11px",
                }}
              >
                確定
              </button>
            </div>
          </div>
        )}
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

            {/* ★ここに追加：選考タイムライン（日付編集・即時辞退機能） */}
            <div
              style={{
                fontSize: "13px",
                borderTop: `1px solid ${thm.brd}`,
                paddingTop: "16px",
                marginTop: "16px",
              }}
            >
              <strong
                style={{
                  display: "block",
                  marginBottom: "16px",
                  color: thm.txt,
                }}
              >
                選考タイムライン (日付編集)
              </strong>
              <div style={{ position: "relative" }}>
                {renderTimelineNode(
                  "受付・応募",
                  "applied_at",
                  "応募",
                  !isCoop,
                )}
                {renderTimelineNode(
                  isCoop ? "商談" : "1次面接",
                  "interview_1_date",
                  isCoop ? "商談" : "1次面接",
                  !isCoop,
                )}
                {!isCoop &&
                  renderTimelineNode(
                    "2次面接",
                    "interview_2_date",
                    "2次面接",
                    true,
                  )}
                {renderTimelineNode(
                  isCoop ? "稼働予定" : "入社予定",
                  "expected_join_date",
                  isCoop ? "稼働前" : "入社前",
                  !isCoop,
                  true,
                )}

                {/* 終了・退職ステータスの表示 */}
                {f.status === "9" && (
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
                {f.status === "6" && !f.is_retired && (
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
                <div
                  style={{
                    marginBottom: "16px",
                    padding: "16px",
                    background: "#f8fafc",
                    borderRadius: "6px",
                    border: `1px solid ${thm.brd}`,
                  }}
                >
                  <label
                    style={{ ...s.lbl, marginBottom: "8px", display: "block" }}
                  >
                    応募経路の種別
                  </label>
                  <div
                    style={{
                      display: "flex",
                      gap: "16px",
                      marginBottom: "12px",
                      flexWrap: "wrap",
                    }}
                  >
                    {["求人", "紹介", "人材紹介", "新卒", "その他"].map(
                      (type) => (
                        <label
                          key={type}
                          style={{
                            fontSize: "14px",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          <input
                            type="radio"
                            name="source_type"
                            value={type}
                            checked={f.source_type === type}
                            onChange={hChg}
                          />{" "}
                          {type}
                        </label>
                      ),
                    )}
                  </div>

                  <label style={s.lbl}>
                    {f.source_type === "求人"
                      ? "媒体名 (Indeed, engageなど)"
                      : f.source_type === "紹介"
                        ? "紹介者名 (社員名など)"
                        : f.source_type === "人材紹介"
                          ? "エージェント会社名"
                          : f.source_type === "新卒"
                            ? "卒業学校名"
                            : "詳細 (直電など)"}
                  </label>
                  <input
                    type="text"
                    name="agent_name"
                    value={f.agent_name}
                    onChange={hChg}
                    style={s.inp}
                  />

                  {/* 人材紹介の時だけ紹介料入力枠を出す */}
                  {f.source_type === "人材紹介" && (
                    <div
                      style={{
                        marginTop: "16px",
                        padding: "12px",
                        background: "#f0fdf4",
                        borderRadius: "6px",
                        border: "1px solid #bbf7d0",
                      }}
                    >
                      <label style={{ ...s.lbl, color: "#166534" }}>
                        紹介料（入社処理時に自動で経費計上されます）
                      </label>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <span style={{ fontWeight: "bold", color: "#166534" }}>
                          ¥
                        </span>
                        <input
                          type="number"
                          name="introducer_fee"
                          value={f.introducer_fee}
                          onChange={hChg}
                          placeholder="例: 800000"
                          style={{ ...s.inp, width: "200px", margin: 0 }}
                        />
                      </div>
                    </div>
                  )}
                </div>
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

                {/* 緊急連絡先 */}
                <div
                  style={{
                    background: "#fff1f2",
                    padding: "20px",
                    borderRadius: "6px",
                    border: "1px solid #fecdd3",
                    marginBottom: "24px",
                  }}
                >
                  <h5
                    style={{
                      margin: "0 0 16px 0",
                      color: thm.dng,
                      fontSize: "15px",
                    }}
                  >
                    緊急連絡先
                  </h5>
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
    </div>
  );
};

// --- 進捗モーダル ---
const ProgressModal = ({ cand, onClose, onUpdate }) => {
  const [f, setF] = useState({
    status: "1",
    decline_reason: "",
    interview_1_date: "",
    interview_2_date: "",
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

      const res = await fetch(
        `http://192.168.11.18:5000/api/candidates/${cand.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (res.ok) {
        onUpdate();
        onClose();
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
const CandidateList = () => {
  const [cands, setCands] = useState([]);
  const [ld, setLd] = useState(true);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "applied_at", dir: "desc" });
  const [progMod, setProgMod] = useState(null);

  // 表示モード管理: 'all' (すべて), 'indiv' (個人), 'coop' (協力業者), 'archive' (退職・削除済)
  const [viewMode, setViewMode] = useState("all"); // ★デフォルトをすべてに変更

  const nav = useNavigate();

  const fetchC = () => {
    fetch("http://192.168.11.18:5000/api/candidates")
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
      await fetch(`http://192.168.11.18:5000/api/candidates/${id}`, {
        method: "DELETE",
      });
      fetchC();
    } catch (e) {}
  };

  const hRestore = async (id) => {
    if (!window.confirm("このデータを復元しますか？")) return;
    try {
      await fetch(`http://192.168.11.18:5000/api/candidates/${id}/restore`, {
        method: "PATCH",
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

  // --- フィルタリングロジック ---
  let filt = cands.filter((c) => {
    const retDate = c.retirement_date ? new Date(c.retirement_date) : null;
    if (retDate) retDate.setHours(0, 0, 0, 0);
    const isPastRetirement = retDate && retDate <= today;
    const isArchived = c.is_deleted || isPastRetirement || c.is_retired;

    // アーカイブモードならアーカイブのみ表示
    if (viewMode === "archive") return isArchived;

    // それ以外のモードではアーカイブ（退職・削除済）は一律非表示
    if (isArchived) return false;

    if (viewMode === "indiv") return !c.is_coop;
    if (viewMode === "coop") return c.is_coop;
    return true; // 'all' の場合
  });

  if (q)
    filt = filt.filter(
      (c) => c.name_kanji?.includes(q) || c.name_kana?.includes(q),
    );

  filt.sort((a, b) => {
    const A = a[sort.key];
    const B = b[sort.key];
    if (A < B) return sort.dir === "asc" ? -1 : 1;
    if (A > B) return sort.dir === "asc" ? 1 : -1;
    return 0;
  });

  const renderContact = (c) => {
    const isE = c.primary_contact?.startsWith("email");
    const idx = parseInt(c.primary_contact?.split("_")[1] || 0);
    if (isE && c.email && c.email[idx])
      return (
        <div>
          <span style={{ ...s.badge, background: "#ede9fe", color: "#8b5cf6" }}>
            ✉
          </span>{" "}
          <a
            href={`mailto:${c.email[idx]}`}
            style={{ color: thm.txt, textDecoration: "none" }}
          >
            {c.email[idx]}
          </a>
        </div>
      );
    if (c.tel && c.tel[idx])
      return (
        <div>
          <span style={{ ...s.badge, background: "#d1fae5", color: "#059669" }}>
            TEL
          </span>{" "}
          {c.tel[idx]}
        </div>
      );
    return <span>-</span>;
  };

  return (
    <div style={s.main}>
      <div style={{ maxWidth: "1000px", margin: "0 auto" }}>
        {/* ヘッダー固定 */}
        <div
          style={{
            position: "sticky",
            top: 0,
            backgroundColor: thm.bg,
            zIndex: 10,
            paddingBottom: "16px",
            paddingTop: "20px",
            marginTop: "-20px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h2 style={{ fontSize: "24px", margin: 0 }}>応募者一覧</h2>

            <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
              {/* 表示切替タブ */}
              <div
                style={{
                  display: "flex",
                  background: "#e2e8f0",
                  padding: "4px",
                  borderRadius: "8px",
                  gap: "4px",
                }}
              >
                {[
                  { id: "all", label: "すべて" }, // ★追加
                  { id: "indiv", label: "個人応募" },
                  { id: "coop", label: "協力業者" },
                  { id: "archive", label: "退職・削除済" },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setViewMode(tab.id)}
                    style={{
                      border: "none",
                      padding: "6px 12px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: "bold",
                      cursor: "pointer",
                      backgroundColor:
                        viewMode === tab.id ? "#fff" : "transparent",
                      color: viewMode === tab.id ? thm.pri : thm.mut,
                      boxShadow:
                        viewMode === tab.id
                          ? "0 1px 3px rgba(0,0,0,0.1)"
                          : "none",
                      transition: "0.2s",
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <input
                type="text"
                placeholder="氏名・会社名検索..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ ...s.inp, width: "180px" }}
              />
              <Link
                to="/register"
                style={{
                  ...s.btn,
                  textDecoration: "none",
                  padding: "10px 16px",
                }}
              >
                新規登録
              </Link>
            </div>
          </div>
        </div>

        <div
          style={{
            backgroundColor: thm.crd,
            borderRadius: "8px",
            padding: "30px",
            border: `1px solid ${thm.brd}`,
            marginBottom: "24px",
          }}
        >
          {ld ? (
            <p>読込中...</p>
          ) : (
            <div style={s.tableContainer}>
              <table style={s.tbl}>
                <thead>
                  <tr>
                    <th style={{ ...s.th, width: "60px" }}>詳細</th>
                    <th style={s.th} onClick={() => reqSort("applied_at")}>
                      受付日{" "}
                      {sort.key === "applied_at" &&
                        (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th
                      style={{ ...s.th, minWidth: "180px" }}
                      onClick={() => reqSort("name_kana")}
                    >
                      氏名 / 会社名{" "}
                      {sort.key === "name_kana" &&
                        (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th style={s.th} onClick={() => reqSort("age")}>
                      年齢{" "}
                      {sort.key === "age" && (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th style={s.th}>連絡先</th>
                    <th style={s.th} onClick={() => reqSort("status")}>
                      進捗{" "}
                      {sort.key === "status" &&
                        (sort.dir === "asc" ? "▲" : "▼")}
                    </th>
                    <th style={{ ...s.th, width: "80px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filt.map((c) => {
                    const retDate = c.retirement_date
                      ? new Date(c.retirement_date)
                      : null;
                    if (retDate) retDate.setHours(0, 0, 0, 0);

                    const rowBg =
                      viewMode === "archive"
                        ? "#f8fafc"
                        : c.is_coop
                          ? "#f0f9ff"
                          : "transparent";

                    return (
                      <tr
                        key={c.id}
                        style={{
                          backgroundColor: rowBg,
                          opacity: viewMode === "archive" ? 0.7 : 1,
                        }}
                      >
                        <td style={s.td}>
                          <button
                            onClick={() =>
                              nav(`/candidates/${c.id}?view=detail`)
                            }
                            style={s.actBtn}
                          >
                            詳細
                          </button>
                        </td>
                        <td style={s.td}>
                          {new Date(c.applied_at).toLocaleDateString("ja-JP")}
                        </td>
                        <td style={s.td}>
                          <div
                            style={{
                              fontWeight: "bold",
                              fontSize: "15px",
                              textAlign: "left",
                            }}
                          >
                            {c.name_kanji}
                          </div>
                          <div
                            style={{
                              fontSize: "11px",
                              color: thm.mut,
                              marginTop: "2px",
                              marginBottom: "8px",
                              textAlign: "left",
                            }}
                          >
                            {c.name_kana}
                          </div>
                          {/* 協力業者(is_coop)以外の場合のみ「面接」ボタンを表示 */}
                          {!c.is_coop && (
                            <button
                              onClick={() =>
                                nav(`/candidates/${c.id}?view=interview`)
                              }
                              style={{
                                ...s.actBtn,
                                borderColor: thm.pri,
                                color: thm.pri,
                              }}
                            >
                              面接
                            </button>
                          )}
                        </td>
                        <td style={s.td}>
                          {c.is_coop
                            ? "-"
                            : calcCurrentAge(c.birth_date) || c.age || "-"}
                        </td>
                        <td style={s.td}>{renderContact(c)}</td>
                        <td style={s.td}>
                          <div
                            style={{ marginBottom: "8px", textAlign: "left" }}
                          >
                            {c.is_retired ? (
                              <span
                                style={{
                                  ...s.badge,
                                  background: "#fef2f2",
                                  color: thm.dng,
                                }}
                              >{`${retDate?.getMonth() + 1}月${retDate?.getDate()}日退職済`}</span>
                            ) : (
                              <ProgressStatus candidate={c} s={s} thm={thm} />
                            )}
                          </div>
                          {viewMode !== "archive" && c.status != 6 && (
                            <button
                              onClick={() => setProgMod(c)}
                              style={s.actBtn}
                            >
                              更新
                            </button>
                          )}
                        </td>
                        <td style={s.td}>
                          {viewMode === "archive" ? (
                            <button
                              onClick={() => hRestore(c.id)}
                              style={{
                                ...s.actBtn,
                                color: thm.pri,
                                borderColor: thm.pri,
                              }}
                            >
                              復元
                            </button>
                          ) : (
                            <button
                              onClick={() => hDel(c.id)}
                              style={{
                                ...s.actBtn,
                                color: thm.dng,
                                borderColor: "#fca5a5",
                              }}
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
                          padding: "30px",
                          textAlign: "center",
                          color: thm.mut,
                        }}
                      >
                        データがありません
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
    applied_at: new Date().toISOString().split("T")[0],
    introducer: "", // ★紹介元
    internal_contact: "", // ★社内担当
    desired_dept: "", // ★希望部署
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
    if (!f.applied_at) {
      alert("受付日を入力してください");
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
      const res = await fetch("http://192.168.11.18:5000/api/candidates", {
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
          applied_at: new Date().toISOString().split("T")[0],
          introducer: "",
          internal_contact: "",
          desired_dept: "",
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
const Dashboard = () => {
  const [cands, setCands] = useState([]);
  const [exps, setExps] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      fetch("http://192.168.11.18:5000/api/candidates").then((res) =>
        res.json(),
      ),
      fetch("http://192.168.11.18:5000/api/expenses").then((res) => res.json()),
    ])
      .then(([candData, expData]) => {
        setCands(candData);
        setExps(expData);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const monthsInPeriod = React.useMemo(() => {
    const list = [];
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    let startYear = currentMonth >= 8 ? currentYear : currentYear - 1;

    let y = startYear;
    let m = 8;
    while (true) {
      list.push({
        y,
        m,
        key: `${y}-${String(m).padStart(2, "0")}`,
        label: `${y}/${m}`,
      });
      if (y === currentYear && m === currentMonth) break;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return list;
  }, []);

  if (loading) return <div style={s.main}>読み込み中...</div>;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 【滞留用】有効なデータのみ。入社予定日が過去の人は滞留から外す
  const activeCands = cands.filter((c) => {
    if (c.is_deleted || c.is_retired) return false;
    const st = String(c.status);
    if (st === "6" && c.expected_join_date) {
      const joinDate = new Date(c.expected_join_date);
      joinDate.setHours(0, 0, 0, 0);
      return joinDate > today; // 未来ならまだ滞留（入社前）
    }
    return ["1", "2", "3", "4", "5"].includes(st);
  });

  const totalActive = activeCands.filter((c) => !c.is_coop).length;
  const inProgress = activeCands.filter(
    (c) => !c.is_coop && ["1", "2", "3", "4"].includes(String(c.status)),
  ).length;
  const hiredOrOffer = activeCands.filter(
    (c) => !c.is_coop && ["5", "6"].includes(String(c.status)),
  ).length;

  // 累計の不採用・辞退者は、削除済みデータも含めて全件からカウント！
  const declined = cands.filter(
    (c) => !c.is_coop && String(c.status) === "9",
  ).length;

  // 選考パイプライン（個人応募のみ・滞留状況）
  const pipeline = [
    {
      id: "1",
      label: "受付",
      count: activeCands.filter((c) => !c.is_coop && String(c.status) === "1")
        .length,
      color: "#94a3b8",
    },
    {
      id: "2",
      label: "面接打診中",
      count: activeCands.filter((c) => !c.is_coop && String(c.status) === "2")
        .length,
      color: "#f97316",
    },
    {
      id: "3",
      label: "1次面接予定",
      count: activeCands.filter((c) => !c.is_coop && String(c.status) === "3")
        .length,
      color: "#22c55e",
    },
    {
      id: "4",
      label: "2次面接予定",
      count: activeCands.filter((c) => !c.is_coop && String(c.status) === "4")
        .length,
      color: "#10b981",
    },
    {
      id: "5",
      label: "内定",
      count: activeCands.filter((c) => !c.is_coop && String(c.status) === "5")
        .length,
      color: "#3b82f6",
    },
    {
      id: "6",
      label: "入社前",
      count: activeCands.filter((c) => !c.is_coop && String(c.status) === "6")
        .length,
      color: "#8b5cf6",
    },
  ];
  const maxPipeline = Math.max(...pipeline.map((p) => p.count), 1);

  // 直近の入社予定（個人応募のみ）
  const upcomingJoins = activeCands
    .filter(
      (c) =>
        !c.is_coop &&
        (String(c.status) === "5" || String(c.status) === "6") &&
        c.expected_join_date,
    )
    .filter((c) => new Date(c.expected_join_date) >= today)
    .sort(
      (a, b) => new Date(a.expected_join_date) - new Date(b.expected_join_date),
    )
    .slice(0, 3);

  // ★統計処理: イベント発生ベースで集計する（削除データも含む）
  const monthlyStats = monthsInPeriod.map((mon) => {
    // 1. 応募数（その月にapplied_atがある）
    const appCands = cands.filter((c) => {
      if (!c.applied_at) return false;
      const d = new Date(c.applied_at);
      return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
    });

    // 2. 面接数（その月にinterview_1_dateがある）
    const intCands = cands.filter((c) => {
      if (!c.interview_1_date) return false;
      const d = new Date(c.interview_1_date);
      return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
    });

    // 3. 内定数（ステータス5以上で、その月にexpected_join_dateがある）
    const offerCands = cands.filter((c) => {
      if (!["5", "6"].includes(String(c.status)) || !c.expected_join_date)
        return false;
      const d = new Date(c.expected_join_date);
      return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
    });

    // 4. 入社数（ステータス6で、その月にexpected_join_dateがある）
    const joinCands = cands.filter((c) => {
      if (String(c.status) !== "6" || !c.expected_join_date) return false;
      const d = new Date(c.expected_join_date);
      return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
    });

    const countTotal = appCands.length;
    const coops = appCands.filter((c) => c.is_coop).length;
    const countIndiv = countTotal - coops;

    const interviews = intCands.filter((c) => !c.is_coop).length;
    const offers = offerCands.filter((c) => !c.is_coop).length;
    const joins = joinCands.filter((c) => !c.is_coop).length;

    // 辞退数は日付データがないため、応募月ベースの参考値として算出
    const declinesCount = cands.filter((c) => {
      if (String(c.status) !== "9" || c.is_coop || !c.applied_at) return false;
      const d = new Date(c.applied_at);
      return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
    }).length;

    const expense = exps
      .filter((e) => {
        const d = new Date(e.expense_date);
        return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
      })
      .reduce((sum, e) => sum + e.amount, 0);

    return {
      ...mon,
      countTotal,
      countIndiv,
      coops,
      interviews,
      offers,
      joins,
      declinesCount,
      expense,
      interviewRate: countIndiv
        ? Math.round((interviews / countIndiv) * 100)
        : 0,
      hireRate: countIndiv ? Math.round((offers / countIndiv) * 100) : 0,
    };
  });

  const totalPeriodCands = monthlyStats.reduce(
    (sum, m) => sum + m.countTotal,
    0,
  );
  const totalPeriodCoops = monthlyStats.reduce((sum, m) => sum + m.coops, 0);
  const totalPeriodIndivs = totalPeriodCands - totalPeriodCoops;

  const totalPeriodInterviews = monthlyStats.reduce(
    (sum, m) => sum + m.interviews,
    0,
  );
  const totalPeriodOffers = monthlyStats.reduce((sum, m) => sum + m.offers, 0);
  const totalPeriodJoins = monthlyStats.reduce((sum, m) => sum + m.joins, 0);

  const periodInterviewRate = totalPeriodIndivs
    ? Math.round((totalPeriodInterviews / totalPeriodIndivs) * 100)
    : 0;
  const periodOfferRate = totalPeriodIndivs
    ? Math.round((totalPeriodOffers / totalPeriodIndivs) * 100)
    : 0;
  const periodJoinRate = totalPeriodIndivs
    ? Math.round((totalPeriodJoins / totalPeriodIndivs) * 100)
    : 0;

  const totalExpPeriod = monthlyStats.reduce((sum, m) => sum + m.expense, 0);
  const costPerHire =
    totalPeriodOffers > 0 ? Math.round(totalExpPeriod / totalPeriodOffers) : 0;

  const chartMaxVal = Math.max(
    ...monthlyStats.map((m) => Math.max(m.countIndiv, m.coops, m.interviews)),
    1,
  );

  const yTicks = [];
  const step = Math.ceil(chartMaxVal / 4) || 1;
  for (let i = 0; i <= chartMaxVal; i += step) {
    if (!yTicks.includes(i)) yTicks.push(i);
  }
  if (!yTicks.includes(chartMaxVal)) yTicks.push(chartMaxVal);

  const generateWavyLinePath = () => {
    if (monthlyStats.length === 0) return "";
    const points = monthlyStats.map((m, i) => {
      const x = ((i + 0.5) / monthlyStats.length) * 100;
      const y = 100 - (m.joins / chartMaxVal) * 100;
      return { x, y };
    });
    let path = `M ${points[0].x} ${points[0].y} `;
    for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i + 1];
      const midX = (curr.x + next.x) / 2;
      path += `C ${midX} ${curr.y}, ${midX} ${next.y}, ${next.x} ${next.y} `;
    }
    return path;
  };

  return (
    <div style={s.main} className="dashboard-container">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 10mm; }
          nav { display: none !important; }
          .print-hide { display: none !important; }
          .dashboard-container { padding: 0 !important; overflow: visible !important; zoom: 0.6; }
          .s-card { page-break-inside: avoid; margin-bottom: 10px !important; padding: 16px !important; }
          table th, table td { padding: 4px 6px !important; font-size: 11px !important; }
          .chart-container { height: 180px !important; margin-bottom: 70px !important; }
          body { background: white !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>

      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <div
          className="print-hide"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: "16px",
          }}
        >
          <button
            onClick={() => window.print()}
            style={{
              ...s.actBtn,
              border: `1px solid ${thm.mut}`,
              padding: "8px 16px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <svg
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
              />
            </svg>
            A4印刷
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {[
            {
              title: "現在の有効応募 (個人滞留)",
              value: totalActive,
              color: thm.txt,
            },
            {
              title: "選考進行中 (個人滞留)",
              value: inProgress,
              color: thm.pri,
            },
            {
              title: "内定・入社 (個人滞留)",
              value: hiredOrOffer,
              color: "#16a34a",
            },
            {
              title: "不採用・辞退 (累計全件)",
              value: declined,
              color: thm.dng,
            },
          ].map((kpi, i) => (
            <div
              key={i}
              className="s-card"
              style={{ ...s.card, padding: "20px", marginBottom: 0 }}
            >
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  fontWeight: "bold",
                  marginBottom: "4px",
                }}
              >
                {kpi.title}
              </div>
              <div
                style={{
                  fontSize: "28px",
                  fontWeight: "bold",
                  color: kpi.color,
                  lineHeight: 1,
                }}
              >
                {kpi.value}{" "}
                <span style={{ fontSize: "14px", color: thm.mut }}>名</span>
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "20px",
            marginBottom: "30px",
          }}
        >
          <div
            className="s-card"
            style={{
              ...s.card,
              padding: "20px",
              marginBottom: 0,
              backgroundColor: "#f8fafc",
            }}
          >
            <div
              style={{
                fontSize: "12px",
                color: thm.mut,
                fontWeight: "bold",
                marginBottom: "4px",
              }}
            >
              今期 採用人数 (内定含)
            </div>
            <div
              style={{ fontSize: "24px", fontWeight: "bold", color: thm.txt }}
            >
              {totalPeriodOffers}{" "}
              <span style={{ fontSize: "14px", color: thm.mut }}>名</span>
            </div>
          </div>
          <div
            className="s-card"
            style={{
              ...s.card,
              padding: "20px",
              marginBottom: 0,
              backgroundColor: "#f8fafc",
            }}
          >
            <div
              style={{
                fontSize: "12px",
                color: thm.mut,
                fontWeight: "bold",
                marginBottom: "4px",
              }}
            >
              今期 採用経費
            </div>
            <div
              style={{ fontSize: "24px", fontWeight: "bold", color: thm.txt }}
            >
              ¥{totalExpPeriod.toLocaleString()}
            </div>
          </div>
          <div
            className="s-card"
            style={{
              ...s.card,
              padding: "20px",
              marginBottom: 0,
              border: `2px solid ${thm.pri}`,
            }}
          >
            <div
              style={{
                fontSize: "12px",
                color: thm.pri,
                fontWeight: "bold",
                marginBottom: "4px",
              }}
            >
              一人当たり採用単価
            </div>
            <div
              style={{ fontSize: "28px", fontWeight: "bold", color: thm.pri }}
            >
              ¥{costPerHire.toLocaleString()}
            </div>
          </div>
        </div>

        <div
          className="s-card"
          style={{
            ...s.card,
            padding: "20px 24px",
            marginBottom: "24px",
            backgroundColor: "#f1f5f9",
            borderLeft: `4px solid ${thm.pri}`,
          }}
        >
          <h3
            style={{ margin: "0 0 16px 0", fontSize: "15px", color: thm.txt }}
          >
            【{monthsInPeriod[0]?.y}/08～ 期】 累計実績
          </h3>
          <div style={{ display: "flex", gap: "40px", flexWrap: "wrap" }}>
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  marginBottom: "4px",
                }}
              >
                全応募数
              </div>
              <strong style={{ fontSize: "28px" }}>{totalPeriodCands}</strong>
              <span style={{ fontSize: "14px", color: thm.mut }}>名</span>
            </div>
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: "#475569",
                  marginBottom: "4px",
                }}
              >
                協力業者
              </div>
              <strong style={{ fontSize: "28px", color: "#475569" }}>
                {totalPeriodCoops}
              </strong>
              <span style={{ fontSize: "14px", color: thm.mut }}>件</span>
            </div>
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  marginBottom: "4px",
                }}
              >
                面接実績 (個人)
              </div>
              <strong style={{ fontSize: "28px" }}>
                {totalPeriodInterviews}
              </strong>
              <span style={{ fontSize: "14px", color: thm.mut }}>
                名 ({periodInterviewRate}%)
              </span>
            </div>
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  marginBottom: "4px",
                }}
              >
                内定実績 (個人)
              </div>
              <strong style={{ fontSize: "28px", color: "#ef4444" }}>
                {totalPeriodOffers}
              </strong>
              <span style={{ fontSize: "14px", color: thm.mut }}>
                名 ({periodOfferRate}%)
              </span>
            </div>
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  marginBottom: "4px",
                }}
              >
                入社実績 (個人)
              </div>
              <strong style={{ fontSize: "28px", color: "#8b4513" }}>
                {totalPeriodJoins}
              </strong>
              <span style={{ fontSize: "14px", color: thm.mut }}>
                名 ({periodJoinRate}%)
              </span>
            </div>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr",
            gap: "24px",
            alignItems: "start",
            marginBottom: "24px",
          }}
        >
          <div className="s-card" style={{ ...s.card, marginBottom: 0 }}>
            <h3
              style={{
                margin: "0 0 16px 0",
                fontSize: "15px",
                borderBottom: `1px solid ${thm.brd}`,
                paddingBottom: "8px",
              }}
            >
              選考パイプライン（個人応募の滞留状況）
            </h3>
            <div>
              {pipeline.map((step) => (
                <div
                  key={step.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <div
                    style={{
                      width: "90px",
                      fontSize: "12px",
                      fontWeight: "bold",
                      color: thm.txt,
                    }}
                  >
                    {step.label}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      backgroundColor: "#f1f5f9",
                      height: "20px",
                      borderRadius: "10px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${(step.count / maxPipeline) * 100}%`,
                        backgroundColor: step.color,
                        height: "100%",
                      }}
                    ></div>
                  </div>
                  <div
                    style={{
                      width: "40px",
                      textAlign: "right",
                      fontSize: "13px",
                      fontWeight: "bold",
                    }}
                  >
                    {step.count}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div
            className="s-card"
            style={{ ...s.card, marginBottom: 0, padding: "0" }}
          >
            <div
              style={{ padding: "16px", borderBottom: `1px solid ${thm.brd}` }}
            >
              <h3 style={{ margin: 0, fontSize: "15px" }}>
                直近の入社予定 (個人)
              </h3>
            </div>
            <div style={{ padding: "8px 16px 16px 16px" }}>
              {upcomingJoins.length > 0 ? (
                upcomingJoins.map((c) => {
                  const joinDate = new Date(c.expected_join_date);
                  return (
                    <div
                      key={c.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 0",
                        borderBottom: `1px dashed ${thm.brd}`,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: "13px",
                            fontWeight: "bold",
                            cursor: "pointer",
                            color: thm.pri,
                          }}
                          onClick={() => navigate(`/candidates/${c.id}`)}
                        >
                          {c.name_kanji}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: thm.mut,
                            marginTop: "2px",
                          }}
                        >
                          予定日: {joinDate.toLocaleDateString("ja-JP")}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div
                  style={{
                    fontSize: "12px",
                    color: thm.mut,
                    textAlign: "center",
                    padding: "16px 0",
                  }}
                >
                  なし
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="s-card" style={{ ...s.card, paddingBottom: "40px" }}>
          <h3 style={{ margin: "0 0 20px 0", fontSize: "16px" }}>
            月別実績推移 ({monthsInPeriod[0]?.y}/08～ 期)
          </h3>

          <div
            className="chart-container"
            style={{
              position: "relative",
              height: "240px",
              borderLeft: `1px solid ${thm.brd}`,
              marginBottom: "80px",
              marginTop: "30px",
              marginLeft: "30px",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                pointerEvents: "none",
              }}
            >
              {yTicks.map((t) => (
                <div
                  key={`tick-${t}`}
                  style={{
                    position: "absolute",
                    bottom: `${(t / chartMaxVal) * 100}%`,
                    left: 0,
                    right: 0,
                    borderBottom:
                      t > 0 ? `1px dashed #cbd5e1` : `1px solid #94a3b8`,
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      left: "-25px",
                      bottom: "-8px",
                      fontSize: "11px",
                      color: thm.mut,
                    }}
                  >
                    {t}
                  </span>
                </div>
              ))}
            </div>

            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                zIndex: 10,
                pointerEvents: "none",
                overflow: "visible",
              }}
            >
              <path
                d={generateWavyLinePath()}
                fill="none"
                stroke="#8b4513"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                height: "100%",
                width: "100%",
                position: "relative",
              }}
            >
              {monthlyStats.map((m) => (
                <div
                  key={m.key}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    height: "100%",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      width: "80%",
                      height: "100%",
                      display: "flex",
                      alignItems: "flex-end",
                      justifyContent: "center",
                      gap: "2px",
                    }}
                  >
                    {/* ★ 個人応募バー (薄いグレー) */}
                    <div
                      style={{
                        width: "30%",
                        height: `${(m.countIndiv / chartMaxVal) * 100}%`,
                        background: "#cbd5e1",
                        borderRadius: "2px 2px 0 0",
                      }}
                    ></div>

                    {/* ★ 協力業者バー (濃いグレー) */}
                    <div
                      style={{
                        width: "30%",
                        height: `${(m.coops / chartMaxVal) * 100}%`,
                        background: "#475569",
                        borderRadius: "2px 2px 0 0",
                      }}
                    ></div>

                    {/* 面接・内定は個人応募のバーに重ねる */}
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: "10%",
                        width: "20%",
                        height: `${(m.interviews / chartMaxVal) * 100}%`,
                        background: "#3b82f6",
                        borderRadius: "2px 2px 0 0",
                        opacity: 0.8,
                      }}
                    ></div>
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: "10%",
                        width: "20%",
                        height: `${(m.offers / chartMaxVal) * 100}%`,
                        background: "#ef4444",
                        borderRadius: "2px 2px 0 0",
                        opacity: 0.8,
                      }}
                    ></div>

                    <div
                      style={{
                        position: "absolute",
                        bottom: `${(m.joins / chartMaxVal) * 100}%`,
                        width: "10px",
                        height: "10px",
                        backgroundColor: "#8b4513",
                        borderRadius: "50%",
                        border: "2px solid #fff",
                        zIndex: 20,
                        transform: "translateY(50%)",
                      }}
                    ></div>
                  </div>

                  <div
                    style={{
                      position: "absolute",
                      bottom: "-55px",
                      textAlign: "center",
                      width: "100%",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: "bold",
                        color: thm.txt,
                      }}
                    >
                      {m.m}月
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: thm.mut,
                        marginTop: "4px",
                      }}
                    >
                      ¥{Math.round(m.expense / 1000)}k
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: "24px",
              marginTop: "20px",
              fontSize: "13px",
              justifyContent: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div
                style={{
                  width: "16px",
                  height: "16px",
                  background: "#cbd5e1",
                  borderRadius: "2px",
                }}
              ></div>
              個人応募
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div
                style={{
                  width: "16px",
                  height: "16px",
                  background: "#475569",
                  borderRadius: "2px",
                }}
              ></div>
              協力業者
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div
                style={{
                  width: "16px",
                  height: "16px",
                  background: "#3b82f6",
                  borderRadius: "2px",
                }}
              ></div>
              面接(個人)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div
                style={{
                  width: "16px",
                  height: "16px",
                  background: "#ef4444",
                  borderRadius: "2px",
                }}
              ></div>
              内定(個人)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div
                style={{
                  width: "20px",
                  height: "4px",
                  background: "#8b4513",
                  borderRadius: "2px",
                }}
              ></div>
              入社(個人)
            </div>
          </div>
        </div>

        <div className="s-card" style={s.card}>
          <h3 style={{ margin: "0 0 20px 0", fontSize: "16px" }}>
            月別詳細実績
          </h3>
          <div style={s.tableContainer}>
            <table style={s.tbl}>
              <thead>
                <tr>
                  <th style={s.th}>月</th>
                  <th style={s.th}>応募者 (個人)</th>
                  <th style={s.th}>協力業者</th>
                  <th style={s.th}>面接 (率)</th>
                  <th style={s.th}>内定 (率)</th>
                  <th style={s.th}>入社</th>
                  <th style={s.th}>採用経費</th>
                </tr>
              </thead>
              <tbody>
                {monthlyStats.map((m) => (
                  <tr key={m.key}>
                    <td style={s.td}>{m.label}</td>
                    <td style={s.td}>{m.countIndiv}名</td>
                    <td style={s.td}>{m.coops}件</td>
                    <td style={s.td}>
                      {m.interviews}名{" "}
                      <span style={{ color: thm.mut, fontSize: "11px" }}>
                        ({m.interviewRate}%)
                      </span>
                    </td>
                    <td style={s.td}>
                      {m.offers}名{" "}
                      <span style={{ color: thm.mut, fontSize: "11px" }}>
                        ({m.hireRate}%)
                      </span>
                    </td>
                    <td style={{ ...s.td, fontWeight: "bold" }}>{m.joins}名</td>
                    <td style={s.td}>¥{m.expense.toLocaleString()}</td>
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
    fetch("http://192.168.11.18:5000/api/expenses")
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
      const res = await fetch("http://192.168.11.18:5000/api/expenses", {
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
      const res = await fetch(`http://192.168.11.18:5000/api/expenses/${id}`, {
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
      await fetch(`http://192.168.11.18:5000/api/expenses/${id}`, {
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
          color: a ? "#fff" : thm.mut,
          background: a ? thm.side : "transparent",
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
        background: "#0f172a",
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

export default function App() {
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
