import React, { useState, useEffect, useCallback } from "react";
// ★ SafeAreaView を 'react-native' から外し、新しい専用ライブラリから読み込むように修正
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  StatusBar,
  TextInput,
  RefreshControl, // ★追加: 引っ張って更新用のコンポーネント
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// ★本番環境（Render）のAPI URLに完全固定
const BASE_URL = "https://recruit-manager-system.onrender.com";
const API_URL = `${BASE_URL}/api/candidates`;
const EXP_URL = `${BASE_URL}/api/expenses`;

const colors = {
  bg: "#f8fafc",
  card: "#ffffff",
  border: "#cbd5e1",
  text: "#0f172a",
  muted: "#64748b",
  primary: "#2563eb",
  danger: "#ef4444",
  success: "#16a34a",
  tabBg: "#1e293b",
};

// --- ステータスラベルの取得関数 ---
const getStatusLabel = (c) => {
  if (!c || !c.status) return "受付";
  const st = String(c.status);

  // ★修正：不採用(9)の場合は、理由に関わらず「不採用」と表示する
  if (st === "9") return "不採用";

  const labels = {
    "1": "受付",
    "2": "面接打診中",
    "3": "1次面接",
    "4": "2次面接",
    "5": "内定",
    "6": "入社",
  };
  return labels[st] || "受付";
};

export default function App() {
  const [candidates, setCandidates] = useState([]);
  const [exps, setExps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // ★追加: 更新中かどうかの判定用ステート
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  // ★追加: データの取得処理を共通化
  const fetchData = useCallback(async () => {
    try {
      const [candRes, expRes] = await Promise.all([
        fetch(API_URL),
        fetch(EXP_URL),
      ]);
      const candData = await candRes.json();
      const expData = await expRes.json();
      setCandidates(candData);
      setExps(expData);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false); // 更新完了でスピナーを消す
    }
  }, []);

  // 初回読み込み
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ★追加: 下に引っ張った時の処理
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  // ★変更: 引っ張って更新の時は全画面ローディングを出さない
  if (loading && !refreshing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{ marginTop: 12, color: colors.muted }}>
          読み込み中...
        </Text>
      </View>
    );
  }

  const activeCands = candidates.filter((c) => !c.is_deleted && !c.is_retired);

  // --- ① ダッシュボード ---
  const renderDashboard = () => {
    const total = activeCands.length;
    const inProgress = activeCands.filter((c) =>
      ["1", "2", "3", "4"].includes(String(c.status)),
    ).length;
    const offers = activeCands.filter((c) =>
      ["5", "6"].includes(String(c.status)),
    ).length;
    const declined = activeCands.filter((c) => String(c.status) === "9").length;

    const pipeline = [
      {
        id: "1",
        label: "受付",
        count: activeCands.filter((c) => String(c.status) === "1").length,
        color: "#94a3b8",
      },
      {
        id: "2",
        label: "面接打診中",
        count: activeCands.filter((c) => String(c.status) === "2").length,
        color: "#f97316",
      },
      {
        id: "3",
        label: "1次面接予定",
        count: activeCands.filter((c) => String(c.status) === "3").length,
        color: "#22c55e",
      },
      {
        id: "4",
        label: "2次面接予定",
        count: activeCands.filter((c) => String(c.status) === "4").length,
        color: "#10b981",
      },
      {
        id: "5",
        label: "内定",
        count: activeCands.filter((c) => String(c.status) === "5").length,
        color: "#3b82f6",
      },
      {
        id: "6",
        label: "入社前",
        count: activeCands.filter((c) => {
          if (String(c.status) !== "6" || !c.expected_join_date) return false;
          const joinDate = new Date(c.expected_join_date);
          joinDate.setHours(0, 0, 0, 0);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          // 入社日が「今日以降」の未来であれば滞留（入社前）としてカウント
          return joinDate >= today;
        }).length,
        color: "#8b5cf6",
      },
    ];
    const maxPipeline = Math.max(...pipeline.map((p) => p.count), 1);

    const upcomingJoins = activeCands
      .filter(
        (c) =>
          (String(c.status) === "5" || String(c.status) === "6") &&
          c.expected_join_date,
      )
      .filter(
        (c) =>
          new Date(c.expected_join_date) >=
          new Date(new Date().setHours(0, 0, 0, 0)),
      )
      .sort(
        (a, b) =>
          new Date(a.expected_join_date) - new Date(b.expected_join_date),
      )
      .slice(0, 3);

    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    let startYear = currentMonth >= 8 ? currentYear : currentYear - 1;

    const monthsInPeriod = [];
    let y = startYear;
    let m = 8;
    while (true) {
      // ★ key（背番号）を追加してエラーを解消
      monthsInPeriod.push({ y, m, key: `${y}-${m}`, label: `${y}/${m}` });
      if (y === currentYear && m === currentMonth) break;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }

    const periodCands = candidates.filter((c) => !c.is_deleted);
    const monthlyStats = monthsInPeriod.map((mon) => {
      const monthCands = periodCands.filter((c) => {
        const d = new Date(c.applied_at);
        return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
      });
      const count = monthCands.length;
      const interviews = monthCands.filter(
        (c) =>
          c.interview_1_date || ["3", "4", "5", "6"].includes(String(c.status)),
      ).length;
      const offersCount = monthCands.filter((c) =>
        ["5", "6"].includes(String(c.status)),
      ).length;
      const joins = monthCands.filter((c) => String(c.status) === "6").length;
      const declinesCount = monthCands.filter(
        (c) => String(c.status) === "9",
      ).length;
      const expense = exps
        .filter((e) => {
          const d = new Date(e.expense_date);
          return d.getFullYear() === mon.y && d.getMonth() + 1 === mon.m;
        })
        .reduce((sum, e) => sum + e.amount, 0);

      return {
        ...mon,
        count,
        interviews,
        offers: offersCount,
        joins,
        declinesCount,
        expense,
        interviewRate: count ? Math.round((interviews / count) * 100) : 0,
        hireRate: count ? Math.round((offersCount / count) * 100) : 0,
      };
    });

    const chartMaxVal = Math.max(...monthlyStats.map((m) => m.count), 1);
    const totalPeriodCands = monthlyStats.reduce((sum, m) => sum + m.count, 0);
    const totalPeriodInterviews = monthlyStats.reduce(
      (sum, m) => sum + m.interviews,
      0,
    );
    const totalPeriodOffers = monthlyStats.reduce(
      (sum, m) => sum + m.offers,
      0,
    );
    const totalPeriodJoins = monthlyStats.reduce((sum, m) => sum + m.joins, 0);

    return (
      <ScrollView
        style={styles.page}
        showsVerticalScrollIndicator={false}
        // ★追加: 引っ張って更新
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {/* 1. 選考パイプライン */}
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.cardTitle}>選考パイプライン</Text>
          {pipeline.map((step) => (
            <View
              key={step.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <Text
                style={{
                  width: 80,
                  fontSize: 12,
                  fontWeight: "bold",
                  color: colors.text,
                }}
              >
                {step.label}
              </Text>
              <View
                style={{
                  flex: 1,
                  backgroundColor: "#f1f5f9",
                  height: 16,
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${(step.count / maxPipeline) * 100}%`,
                    backgroundColor: step.color,
                    height: "100%",
                  }}
                />
              </View>
              <Text
                style={{
                  width: 30,
                  textAlign: "right",
                  fontSize: 12,
                  fontWeight: "bold",
                }}
              >
                {step.count}
              </Text>
            </View>
          ))}
        </View>

        {/* 2. 累計実績 */}
        <View
          style={[
            styles.card,
            {
              borderLeftWidth: 4,
              borderLeftColor: colors.primary,
              backgroundColor: "#f1f5f9",
            },
          ]}
        >
          <Text style={styles.cardTitle}>期別 累計実績</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            <View style={{ width: "45%" }}>
              <Text style={{ fontSize: 12, color: colors.muted }}>
                全応募数
              </Text>
              <Text style={{ fontSize: 20, fontWeight: "bold" }}>
                {totalPeriodCands}名
              </Text>
            </View>
            <View style={{ width: "45%" }}>
              <Text style={{ fontSize: 12, color: colors.muted }}>
                面接実績
              </Text>
              <Text style={{ fontSize: 20, fontWeight: "bold" }}>
                {totalPeriodInterviews}名
              </Text>
            </View>
            <View style={{ width: "45%" }}>
              <Text style={{ fontSize: 12, color: colors.muted }}>
                内定実績
              </Text>
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: "bold",
                  color: colors.danger,
                }}
              >
                {totalPeriodOffers}名
              </Text>
            </View>
            <View style={{ width: "45%" }}>
              <Text style={{ fontSize: 12, color: colors.muted }}>
                入社実績
              </Text>
              <Text
                style={{ fontSize: 20, fontWeight: "bold", color: "#8b4513" }}
              >
                {totalPeriodJoins}名
              </Text>
            </View>
          </View>
        </View>

        {/* 3. 現在の有効KPI */}
        <View style={styles.kpiGrid}>
          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>有効応募 (滞留)</Text>
            <Text style={styles.kpiValue}>{total}名</Text>
          </View>
          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>進行中 (滞留)</Text>
            <Text style={[styles.kpiValue, { color: colors.primary }]}>
              {inProgress}名
            </Text>
          </View>
          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>内定・入社 (滞留)</Text>
            <Text style={[styles.kpiValue, { color: colors.success }]}>
              {offers}名
            </Text>
          </View>
          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>不採用・辞退 (累計)</Text>
            <Text style={[styles.kpiValue, { color: colors.danger }]}>
              {declined}名
            </Text>
          </View>
        </View>

        {/* 4. 月別実績推移 (グラフ) */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>月別実績推移</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingVertical: 10 }}
          >
            {monthlyStats.map((m) => (
              <View
                key={m.key}
                style={{ alignItems: "center", width: 40, marginRight: 15 }}
              >
                <View
                  style={{
                    height: 120,
                    width: 24,
                    justifyContent: "flex-end",
                    backgroundColor: "#f1f5f9",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      height: `${(m.count / chartMaxVal) * 100}%`,
                      backgroundColor: "#cbd5e1",
                      width: "100%",
                      position: "absolute",
                      bottom: 0,
                    }}
                  />
                  <View
                    style={{
                      height: `${(m.interviews / chartMaxVal) * 100}%`,
                      backgroundColor: "#3b82f6",
                      width: "100%",
                      position: "absolute",
                      bottom: 0,
                    }}
                  />
                  <View
                    style={{
                      height: `${(m.offers / chartMaxVal) * 100}%`,
                      backgroundColor: "#ef4444",
                      width: "100%",
                      position: "absolute",
                      bottom: 0,
                    }}
                  />
                </View>
                <Text
                  style={{
                    fontSize: 12,
                    marginTop: 8,
                    color: colors.text,
                    fontWeight: "bold",
                  }}
                >
                  {m.m}月
                </Text>
              </View>
            ))}
          </ScrollView>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              marginTop: 10,
              gap: 15,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  backgroundColor: "#cbd5e1",
                  marginRight: 4,
                }}
              />
              <Text style={{ fontSize: 10 }}>応募</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  backgroundColor: "#3b82f6",
                  marginRight: 4,
                }}
              />
              <Text style={{ fontSize: 10 }}>面接</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  backgroundColor: "#ef4444",
                  marginRight: 4,
                }}
              />
              <Text style={{ fontSize: 10 }}>内定</Text>
            </View>
          </View>
        </View>

        {/* 5. 月別詳細実績 (テーブル) */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>月別詳細実績</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View
                style={{
                  flexDirection: "row",
                  borderBottomWidth: 1,
                  borderColor: colors.border,
                  paddingBottom: 8,
                  marginBottom: 8,
                }}
              >
                <Text
                  style={{
                    width: 50,
                    fontWeight: "bold",
                    color: colors.muted,
                    fontSize: 12,
                  }}
                >
                  月
                </Text>
                <Text
                  style={{
                    width: 50,
                    fontWeight: "bold",
                    color: colors.muted,
                    fontSize: 12,
                  }}
                >
                  応募
                </Text>
                <Text
                  style={{
                    width: 80,
                    fontWeight: "bold",
                    color: colors.muted,
                    fontSize: 12,
                  }}
                >
                  面接(率)
                </Text>
                <Text
                  style={{
                    width: 80,
                    fontWeight: "bold",
                    color: colors.muted,
                    fontSize: 12,
                  }}
                >
                  内定(率)
                </Text>
                <Text
                  style={{
                    width: 50,
                    fontWeight: "bold",
                    color: colors.muted,
                    fontSize: 12,
                  }}
                >
                  入社
                </Text>
                <Text
                  style={{
                    width: 50,
                    fontWeight: "bold",
                    color: colors.muted,
                    fontSize: 12,
                  }}
                >
                  辞退
                </Text>
                <Text
                  style={{
                    width: 80,
                    fontWeight: "bold",
                    color: colors.muted,
                    fontSize: 12,
                  }}
                >
                  経費
                </Text>
              </View>
              {monthlyStats.map((m) => (
                <View
                  key={m.key}
                  style={{
                    flexDirection: "row",
                    paddingVertical: 10,
                    borderBottomWidth: 1,
                    borderColor: "#f1f5f9",
                  }}
                >
                  <Text style={{ width: 50, fontSize: 12 }}>{m.label}</Text>
                  <Text style={{ width: 50, fontSize: 12 }}>{m.count}</Text>
                  <Text style={{ width: 80, fontSize: 12 }}>
                    {m.interviews} ({m.interviewRate}%)
                  </Text>
                  <Text style={{ width: 80, fontSize: 12 }}>
                    {m.offers} ({m.hireRate}%)
                  </Text>
                  <Text style={{ width: 50, fontSize: 12, fontWeight: "bold" }}>
                    {m.joins}
                  </Text>
                  <Text style={{ width: 50, fontSize: 12 }}>
                    {m.declinesCount}
                  </Text>
                  <Text style={{ width: 80, fontSize: 12 }}>
                    ¥{m.expense.toLocaleString()}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>

        {/* 6. 直近の入社予定 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>直近の入社予定</Text>
          {upcomingJoins.length > 0 ? (
            upcomingJoins.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={styles.listItem}
                onPress={() => setSelectedCandidate(c)}
              >
                <View>
                  <Text style={styles.listName}>{c.name_kanji}</Text>
                  <Text
                    style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}
                  >
                    予定日:{" "}
                    {new Date(c.expected_join_date).toLocaleDateString("ja-JP")}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          ) : (
            <Text
              style={{
                textAlign: "center",
                color: colors.muted,
                marginVertical: 10,
              }}
            >
              なし
            </Text>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    );
  };

  // --- ② 応募者一覧 ---
  const renderList = () => {
    const filteredCands = activeCands.filter((c) => {
      const q = searchQuery.trim();
      if (!q) return true;
      return (
        (c.name_kanji && c.name_kanji.includes(q)) ||
        (c.name_kana && c.name_kana.includes(q))
      );
    });

    return (
      <View style={styles.page}>
        <View
          style={{
            backgroundColor: "#fff",
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 12,
            marginTop: 10,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <TextInput
            style={{ fontSize: 16, color: colors.text }}
            placeholder="氏名検索"
            placeholderTextColor="#94a3b8"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        <FlatList
          data={filteredCands}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingBottom: 20 }}
          // ★追加: 引っ張って更新
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => setSelectedCandidate(item)}
            >
              <View style={styles.listRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.listName}>{item.name_kanji}</Text>
                  <Text style={styles.listKana}>{item.name_kana}</Text>
                  <Text style={styles.listSub}>
                    受付:{" "}
                    {new Date(item.applied_at).toLocaleDateString("ja-JP")}
                  </Text>
                </View>
                <View
                  style={{ alignItems: "flex-end", justifyContent: "center" }}
                >
                  <View style={[styles.badge, { backgroundColor: "#e2e8f0" }]}>
                    <Text style={[styles.badgeText, { color: "#334155" }]}>
                      {getStatusLabel(item)}
                    </Text>
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      </View>
    );
  };

  // --- ③ 詳細閲覧 ---
  const renderDetail = () => {
    const c = selectedCandidate;
    const bdate = c.birth_date ? c.birth_date.split("T")[0] : null;
    const ageDisplay = bdate
      ? `${new Date().getFullYear() - new Date(bdate).getFullYear()}歳`
      : c.age
        ? `${c.age}歳`
        : "-";

    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={styles.detailHeader}>
          <TouchableOpacity
            onPress={() => setSelectedCandidate(null)}
            style={styles.backBtn}
          >
            <Text style={styles.backBtnText}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={styles.detailTitle}>詳細情報</Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          // ★追加: 引っ張って更新
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
        >
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>基本情報</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>氏名</Text>
              <Text style={styles.detailValue}>{c.name_kanji}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>フリガナ</Text>
              <Text style={styles.detailValue}>{c.name_kana}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>年齢</Text>
              <Text style={styles.detailValue}>{ageDisplay}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>職種経験</Text>
              <Text style={styles.detailValue}>{c.experience || "-"}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>現住所</Text>
              <Text style={styles.detailValue}>
                〒{c.zip_code || "-"}
                {"\n"}
                {c.address}
                {c.address_banchi}
                {c.address_building}
              </Text>
            </View>
          </View>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>連絡先</Text>
            {(c.tel || []).map((t, i) =>
              t ? (
                <View key={`t${i}`} style={styles.detailRow}>
                  <Text style={styles.detailLabel}>TEL {i + 1}</Text>
                  <Text style={styles.detailValue}>{t}</Text>
                </View>
              ) : null,
            )}
            {(c.email || []).map((e, i) =>
              e ? (
                <View key={`e${i}`} style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Mail {i + 1}</Text>
                  <Text style={styles.detailValue}>{e}</Text>
                </View>
              ) : null,
            )}
          </View>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>進捗・日程</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>ステータス</Text>
              <Text
                style={[
                  styles.detailValue,
                  { fontWeight: "bold", color: colors.primary },
                ]}
              >
                {getStatusLabel(c)}
              </Text>
            </View>
            {c.interview_1_date && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>1次面接</Text>
                <Text style={styles.detailValue}>
                  {c.interview_1_date.split("T")[0]}
                </Text>
              </View>
            )}
            {c.interview_2_date && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>2次面接</Text>
                <Text style={styles.detailValue}>
                  {c.interview_2_date.split("T")[0]}
                </Text>
              </View>
            )}
            {c.expected_join_date && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>入社予定日</Text>
                <Text style={styles.detailValue}>
                  {c.expected_join_date.split("T")[0]}
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
      {selectedCandidate ? (
        renderDetail()
      ) : (
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>
            {activeTab === "dashboard" ? renderDashboard() : renderList()}
          </View>
          <View style={styles.tabBar}>
            <TouchableOpacity
              style={styles.tabBtn}
              onPress={() => setActiveTab("dashboard")}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === "dashboard" && styles.tabTextActive,
                ]}
              >
                📊 ダッシュ
              </Text>
            </TouchableOpacity>
            <View style={styles.tabDivider} />
            <TouchableOpacity
              style={styles.tabBtn}
              onPress={() => setActiveTab("list")}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === "list" && styles.tabTextActive,
                ]}
              >
                👥 応募者
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: Platform.OS === "android" ? 30 : 0,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  page: { flex: 1, paddingHorizontal: 16 },
  pageTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
    marginBottom: 20,
    marginTop: 8,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: colors.text,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 8,
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  kpiCard: {
    backgroundColor: colors.card,
    width: "48%",
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kpiLabel: {
    fontSize: 11,
    color: colors.muted,
    fontWeight: "bold",
    marginBottom: 8,
  },
  kpiValue: { fontSize: 20, fontWeight: "bold", color: colors.text },
  listItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  listRow: { flexDirection: "row", justifyContent: "space-between" },
  listName: {
    fontSize: 18,
    fontWeight: "bold",
    color: colors.text,
    marginBottom: 2,
  },
  listKana: { fontSize: 12, color: colors.muted, marginBottom: 8 },
  listSub: { fontSize: 13, color: colors.muted },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#eff6ff",
  },
  badgeText: { fontSize: 12, fontWeight: "bold", color: colors.primary },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#f1f5f9",
    borderRadius: 8,
  },
  backBtnText: { color: colors.text, fontWeight: "bold" },
  detailTitle: { fontSize: 18, fontWeight: "bold", color: colors.text },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: colors.primary,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eff6ff",
    paddingBottom: 6,
  },
  detailRow: { flexDirection: "row", marginBottom: 12 },
  detailLabel: {
    width: 90,
    fontSize: 14,
    color: colors.muted,
    fontWeight: "bold",
  },
  detailValue: { flex: 1, fontSize: 15, color: colors.text },
  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.tabBg,
    paddingBottom: Platform.OS === "ios" ? 24 : 0,
  },
  tabBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
  },
  tabText: { color: "#94a3b8", fontSize: 14, fontWeight: "bold" },
  tabTextActive: { color: "#ffffff" },
  tabDivider: { width: 1, backgroundColor: "#334155", marginVertical: 12 },
});
