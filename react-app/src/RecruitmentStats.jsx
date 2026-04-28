import React, { useState, useEffect, useMemo } from "react";

// 共通テーマ
const thm = {
  bg: "#f8fafc",
  crd: "#ffffff",
  txt: "#1e293b",
  mut: "#64748b",
  brd: "#e2e8f0",
  pri: "#3b82f6",
  dng: "#ef4444",
  side: "#1e293b",
};

const RecruitmentStats = () => {
  const [cands, setCands] = useState([]);
  const [exps, setExps] = useState([]);
  const [loading, setLoading] = useState(true);

  // --- 検索・絞り込み用ステート ---
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [expFilter, setExpFilter] = useState("すべて"); // すべて, 経験者, 未経験者
  const [sourceFilters, setSourceFilters] = useState({
    求人: true,
    紹介: true,
    人材紹介: true,
    新卒: true,
    その他: true,
  });

  const [selectedSource, setSelectedSource] = useState(null); // 円グラフドリルダウン用
  const [baseHeadcount, setBaseHeadcount] = useState(50); // 期首人数の仮置き

  useEffect(() => {
    Promise.all([
      fetch("http://192.168.11.18:5000/api/candidates").then((r) => r.json()),
      fetch("http://192.168.11.18:5000/api/expenses").then((r) => r.json()),
    ]).then(([cData, eData]) => {
      setCands(cData);
      setExps(eData);
      setLoading(false);
    });
  }, []);

  // ★ 応募経路の大分類を正確に判定する関数
  const getSourceType = (c) => {
    const validTypes = ["求人", "紹介", "人材紹介", "新卒"];
    // 登録データが正規の4つのどれかならそれを採用、それ以外（未入力含む）は「その他」
    if (validTypes.includes(c.source_type)) {
      return c.source_type;
    }
    return "その他";
  };

  // --- フィルター適用ロジック (useMemoで高速化) ---
  const filteredCands = useMemo(() => {
    return cands.filter((c) => {
      // ★ 統計の基本ルール: 協力業者のデータは採用統計(歩留まり・単価等)から除外する
      if (c.is_coop) return false;

      // 1. 期間フィルター (受付日で判定)
      if (dateRange.start || dateRange.end) {
        const applied = new Date(c.applied_at);
        if (dateRange.start && applied < new Date(dateRange.start))
          return false;
        if (dateRange.end && applied > new Date(dateRange.end + "T23:59:59"))
          return false;
      }

      // 2. 経験フィルター
      if (expFilter !== "すべて" && c.experience !== expFilter) return false;

      // 3. 応募経路フィルター (大分類で判定)
      const sType = getSourceType(c);
      if (!sourceFilters[sType]) return false;

      return true;
    });
  }, [cands, dateRange, expFilter, sourceFilters]);

  // 経費も期間で絞り込み
  const filteredExps = useMemo(() => {
    return exps.filter((e) => {
      if (!dateRange.start && !dateRange.end) return true;
      const expDate = new Date(e.expense_date);
      if (dateRange.start && expDate < new Date(dateRange.start)) return false;
      if (dateRange.end && expDate > new Date(dateRange.end + "T23:59:59"))
        return false;
      return true;
    });
  }, [exps, dateRange]);

  if (loading)
    return (
      <div style={{ padding: "40px", textAlign: "center" }}>
        統計データを集計中...
      </div>
    );

  // --- 指標の計算 (絞り込み結果を反映) ---
  const totalApplied = filteredCands.length;
  const totalJoined = filteredCands.filter(
    (c) => String(c.status) === "6",
  ).length;
  const totalExpenses = filteredExps.reduce(
    (sum, e) => sum + Number(e.amount),
    0,
  );
  const costPerHire =
    totalJoined > 0 ? Math.round(totalExpenses / totalJoined) : 0;

  // --- 離職率・定着率の計算 (※過去3年間・個人応募のみで算出) ---
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const joinedLast3Y = cands.filter(
    (c) =>
      !c.is_coop &&
      String(c.status) === "6" &&
      new Date(c.expected_join_date || c.applied_at) >= threeYearsAgo,
  ).length;

  const retiredLast3Y = cands.filter(
    (c) =>
      !c.is_coop &&
      c.is_retired &&
      new Date(c.retirement_date) >= threeYearsAgo,
  ).length;

  const quitWithin3Y = cands.filter(
    (c) =>
      !c.is_coop &&
      String(c.status) === "6" &&
      new Date(c.expected_join_date || c.applied_at) >= threeYearsAgo &&
      c.is_retired,
  ).length;

  // 指標算出
  const turnoverRate =
    baseHeadcount + joinedLast3Y > 0
      ? ((retiredLast3Y / (baseHeadcount + joinedLast3Y)) * 100).toFixed(1)
      : 0;

  const retentionRate =
    joinedLast3Y > 0
      ? (((joinedLast3Y - quitWithin3Y) / joinedLast3Y) * 100).toFixed(1)
      : 0;

  const earlyTurnoverRate =
    joinedLast3Y > 0 ? ((quitWithin3Y / joinedLast3Y) * 100).toFixed(1) : 0;

  // --- 経路別の大分類集計 ---
  const sourceColors = {
    求人: "#3b82f6",
    紹介: "#10b981",
    人材紹介: "#f59e0b",
    新卒: "#8b5cf6",
    その他: "#64748b",
  };

  const sourceCounts = filteredCands.reduce((acc, c) => {
    const s = getSourceType(c);
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  let accPercent = 0;
  const pieGradient =
    totalApplied === 0
      ? "#e2e8f0 0% 100%"
      : Object.entries(sourceCounts)
          .map(([key, val]) => {
            const pct = (val / totalApplied) * 100;
            const color = sourceColors[key] || "#ccc";
            const segment = `${color} ${accPercent}% ${accPercent + pct}%`;
            accPercent += pct;
            return segment;
          })
          .join(", ");

  // ★ ドリルダウン詳細集計 (大分類が選ばれた時、その中の「詳細(agent_name)」を集計する)
  const detailCounts = selectedSource
    ? filteredCands
        .filter((c) => getSourceType(c) === selectedSource)
        .reduce((acc, c) => {
          // 詳細名が空欄の場合は「詳細未入力」としてまとめる
          const name =
            c.agent_name && c.agent_name.trim() !== ""
              ? c.agent_name
              : "詳細未入力";
          acc[name] = (acc[name] || 0) + 1;
          return acc;
        }, {})
    : {};

  // --- クイック日付セット関数 ---
  const setQuickDate = (type) => {
    const today = new Date();
    const y = today.getFullYear();
    if (type === "今年")
      setDateRange({ start: `${y}-01-01`, end: `${y}-12-31` });
    if (type === "全期間") setDateRange({ start: "", end: "" });
  };

  const toggleSource = (key) =>
    setSourceFilters({ ...sourceFilters, [key]: !sourceFilters[key] });

  // 汎用ボタンスタイル
  const btnStyle = (isActive) => ({
    padding: "6px 16px",
    borderRadius: "20px",
    fontSize: "13px",
    fontWeight: "bold",
    cursor: "pointer",
    transition: "0.2s",
    border: isActive ? `1px solid ${thm.pri}` : `1px solid ${thm.brd}`,
    background: isActive ? "#eff6ff" : "#fff",
    color: isActive ? thm.pri : thm.mut,
  });

  return (
    <div style={{ padding: "30px", background: thm.bg, minHeight: "100vh" }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <h2
          style={{
            fontSize: "28px",
            fontWeight: "bold",
            margin: "0 0 24px 0",
            color: thm.txt,
          }}
        >
          採用統計ダッシュボード
        </h2>

        {/* ===== 検索・絞り込みパネル ===== */}
        <div
          style={{
            background: thm.crd,
            padding: "20px",
            borderRadius: "12px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
            border: `1px solid ${thm.brd}`,
            marginBottom: "24px",
          }}
        >
          <div style={{ display: "flex", gap: "32px", flexWrap: "wrap" }}>
            {/* 期間指定 */}
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  fontWeight: "bold",
                  marginBottom: "8px",
                }}
              >
                対象期間 (受付日基準)
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <input
                  type="date"
                  max="9999-12-31"
                  value={dateRange.start}
                  onChange={(e) =>
                    setDateRange({ ...dateRange, start: e.target.value })
                  }
                  style={{
                    padding: "6px",
                    borderRadius: "6px",
                    border: `1px solid ${thm.brd}`,
                  }}
                />
                <span style={{ color: thm.mut }}>〜</span>
                <input
                  type="date"
                  max="9999-12-31"
                  value={dateRange.end}
                  onChange={(e) =>
                    setDateRange({ ...dateRange, end: e.target.value })
                  }
                  style={{
                    padding: "6px",
                    borderRadius: "6px",
                    border: `1px solid ${thm.brd}`,
                  }}
                />
                <button
                  onClick={() => setQuickDate("今年")}
                  style={{
                    ...btnStyle(false),
                    marginLeft: "8px",
                    borderRadius: "6px",
                  }}
                >
                  今年
                </button>
                <button
                  onClick={() => setQuickDate("全期間")}
                  style={{ ...btnStyle(false), borderRadius: "6px" }}
                >
                  全期間
                </button>
              </div>
            </div>

            {/* 経験・未経験 */}
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  fontWeight: "bold",
                  marginBottom: "8px",
                }}
              >
                経験の有無
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                {["すべて", "経験者", "未経験者"].map((exp) => (
                  <button
                    key={exp}
                    onClick={() => setExpFilter(exp)}
                    style={btnStyle(expFilter === exp)}
                  >
                    {exp}
                  </button>
                ))}
              </div>
            </div>

            {/* 応募経路トグル */}
            <div>
              <div
                style={{
                  fontSize: "12px",
                  color: thm.mut,
                  fontWeight: "bold",
                  marginBottom: "8px",
                }}
              >
                応募経路 (複数選択可)
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                {Object.keys(sourceFilters).map((key) => (
                  <button
                    key={key}
                    onClick={() => toggleSource(key)}
                    style={btnStyle(sourceFilters[key])}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: sourceColors[key],
                        marginRight: "6px",
                        opacity: sourceFilters[key] ? 1 : 0.3,
                      }}
                    />
                    {key}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ===== KPI カード群 ===== */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: "16px",
            marginBottom: "30px",
          }}
        >
          <div
            style={{
              background: thm.crd,
              padding: "24px",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              border: `1px solid ${thm.brd}`,
            }}
          >
            <div
              style={{ fontSize: "14px", color: thm.mut, marginBottom: "8px" }}
            >
              絞り込み対象 応募数
            </div>
            <div
              style={{ fontSize: "32px", fontWeight: "bold", color: thm.txt }}
            >
              {totalApplied}
              <span style={{ fontSize: "16px", marginLeft: "4px" }}>名</span>
            </div>
          </div>

          <div
            style={{
              background: thm.crd,
              padding: "24px",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              border: `1px solid ${thm.brd}`,
            }}
          >
            <div
              style={{ fontSize: "14px", color: thm.mut, marginBottom: "8px" }}
            >
              絞り込み対象 入社数
            </div>
            <div
              style={{ fontSize: "32px", fontWeight: "bold", color: thm.pri }}
            >
              {totalJoined}
              <span style={{ fontSize: "16px", marginLeft: "4px" }}>名</span>
            </div>
          </div>

          <div
            style={{
              background: thm.crd,
              padding: "24px",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              border: `1px solid ${thm.brd}`,
            }}
          >
            <div
              style={{ fontSize: "14px", color: thm.mut, marginBottom: "8px" }}
            >
              平均採用単価
            </div>
            <div
              style={{ fontSize: "32px", fontWeight: "bold", color: "#f59e0b" }}
            >
              {costPerHire.toLocaleString()}
              <span style={{ fontSize: "16px", marginLeft: "4px" }}>円/人</span>
            </div>
          </div>

          <div
            style={{
              background: "#fef2f2",
              padding: "24px",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              border: "1px solid #fecdd3",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                color: thm.dng,
                marginBottom: "8px",
                fontWeight: "bold",
              }}
            >
              過去3年 離職率 (全体)
            </div>
            <div
              style={{ fontSize: "32px", fontWeight: "bold", color: thm.dng }}
            >
              {turnoverRate}
              <span style={{ fontSize: "16px", marginLeft: "4px" }}>%</span>
            </div>
            <div
              style={{
                fontSize: "11px",
                color: "#991b1b",
                marginTop: "8px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              期首人数基準:{" "}
              <input
                type="number"
                value={baseHeadcount}
                onChange={(e) => setBaseHeadcount(Number(e.target.value))}
                style={{
                  width: "40px",
                  padding: "2px",
                  border: "1px solid #fca5a5",
                  borderRadius: "4px",
                }}
              />{" "}
              名
            </div>
          </div>

          <div
            style={{
              background: "#f0fdfa",
              padding: "24px",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              border: "1px solid #bbf7d0",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                color: "#166534",
                marginBottom: "8px",
                fontWeight: "bold",
              }}
            >
              入社3年 定着率
            </div>
            <div
              style={{ fontSize: "32px", fontWeight: "bold", color: "#166534" }}
            >
              {retentionRate}
              <span style={{ fontSize: "16px", marginLeft: "4px" }}>%</span>
            </div>
            <div
              style={{
                fontSize: "11px",
                color: "#15803d",
                marginTop: "8px",
              }}
            >
              3年以内離職: {earlyTurnoverRate}% ({quitWithin3Y}/{joinedLast3Y}
              名)
            </div>
          </div>
        </div>

        {/* ===== グラフエリア ===== */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "24px",
          }}
        >
          {/* 大分類 円グラフ */}
          <div
            style={{
              background: thm.crd,
              padding: "30px",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              border: `1px solid ${thm.brd}`,
            }}
          >
            <h3
              style={{ margin: "0 0 20px 0", fontSize: "18px", color: thm.txt }}
            >
              応募経路の割合
            </h3>
            <div style={{ display: "flex", alignItems: "center", gap: "40px" }}>
              <div
                style={{
                  width: "200px",
                  height: "200px",
                  borderRadius: "50%",
                  background: `conic-gradient(${pieGradient})`,
                  boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
                }}
              />
              <div style={{ flex: 1 }}>
                {Object.entries(sourceCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, val]) => (
                    <div
                      key={key}
                      onClick={() => setSelectedSource(key)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "8px 12px",
                        marginBottom: "8px",
                        borderRadius: "6px",
                        cursor: "pointer",
                        background:
                          selectedSource === key ? "#f1f5f9" : "transparent",
                        border:
                          selectedSource === key
                            ? `1px solid ${thm.pri}`
                            : "1px solid transparent",
                        transition: "0.2s",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <span
                          style={{
                            width: "12px",
                            height: "12px",
                            borderRadius: "50%",
                            backgroundColor: sourceColors[key] || "#ccc",
                          }}
                        />
                        <span style={{ fontWeight: "bold", color: thm.txt }}>
                          {key}
                        </span>
                      </div>
                      <div style={{ color: thm.mut }}>
                        {val}名 ({((val / totalApplied) * 100).toFixed(1)}%)
                      </div>
                    </div>
                  ))}
                {totalApplied > 0 && (
                  <p
                    style={{
                      fontSize: "11px",
                      color: thm.mut,
                      marginTop: "16px",
                    }}
                  >
                    ※項目をクリックすると詳細内訳が表示されます
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* 媒体別 ドリルダウン */}
          <div
            style={{
              background: thm.crd,
              padding: "30px",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              border: `1px solid ${thm.brd}`,
            }}
          >
            <h3
              style={{ margin: "0 0 20px 0", fontSize: "18px", color: thm.txt }}
            >
              {selectedSource
                ? `「${selectedSource}」の詳細内訳`
                : "媒体・エージェント別 内訳"}
            </h3>
            {!selectedSource ? (
              <div
                style={{
                  height: "200px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: thm.mut,
                  background: "#f8fafc",
                  borderRadius: "8px",
                  border: `1px dashed ${thm.brd}`,
                }}
              >
                左のグラフの項目をクリックしてください
              </div>
            ) : Object.keys(detailCounts).length === 0 ? (
              <div style={{ color: thm.mut }}>データがありません</div>
            ) : (
              <div>
                {Object.entries(detailCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, count], i) => {
                    const maxCount = Math.max(...Object.values(detailCounts));
                    const barWidth = `${(count / maxCount) * 100}%`;
                    return (
                      <div key={i} style={{ marginBottom: "12px" }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: "13px",
                            marginBottom: "4px",
                          }}
                        >
                          <span style={{ fontWeight: "bold", color: thm.txt }}>
                            {name}
                          </span>
                          <span style={{ color: thm.mut }}>{count}名</span>
                        </div>
                        <div
                          style={{
                            width: "100%",
                            height: "12px",
                            background: "#e2e8f0",
                            borderRadius: "6px",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: barWidth,
                              height: "100%",
                              background:
                                sourceColors[selectedSource] || thm.pri,
                              borderRadius: "6px",
                              transition: "width 0.5s ease-out",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default RecruitmentStats;
