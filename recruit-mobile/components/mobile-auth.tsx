import React, { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Button, Platform, Text, TextInput, View } from "react-native";
import { mobileClient } from "../lib/nativeClient";

export default function MobileAuth({ children }: { children: React.ReactNode }) {
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const unsubscribe = mobileClient.subscribe(() => {
      if (mounted) { setExpiresAt(null); setPassword(""); }
    });
    async function check() {
      try {
        const expiry = await mobileClient.check();
        if (mounted) setExpiresAt(expiry);
      } catch { if (mounted) { setExpiresAt(null); setError("認証状態を確認できません"); } }
      finally { if (mounted) setChecking(false); }
    }
    if (Platform.OS === "web") { setChecking(false); setError("モバイル版を使用してください"); }
    else void check();
    const foreground = AppState.addEventListener("change", state => {
      if (state === "active" && Platform.OS !== "web") { setChecking(true); void check(); }
    });
    return () => { mounted = false; unsubscribe(); foreground.remove(); };
  }, []);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => {
      void mobileClient.logout().catch(() => setError("保存情報を削除できません"));
    }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  async function login() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await mobileClient.login(username, password);
      setExpiresAt(await mobileClient.check());
    } catch (err) { setError(err instanceof Error && err.message ? err.message : "ログインできません"); }
    finally { setPassword(""); setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError("");
    try { await mobileClient.logout(); }
    catch { setError("保存情報を削除できません"); }
    finally { setBusy(false); }
  }
  if (checking) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><ActivityIndicator /></View>;
  if (expiresAt) return <View style={{ flex: 1 }}>
    <View style={{ alignItems: "flex-end", padding: 8 }}><Button title="ログアウト" disabled={busy} onPress={logout}/></View>
    {children}
  </View>;
  return <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12, backgroundColor: "#f8fafc" }}>
    <Text>ユーザー名</Text>
    <TextInput autoCapitalize="none" autoCorrect={false} autoComplete="username" value={username}
      onChangeText={setUsername} style={{ borderWidth: 1, borderColor: "#cbd5e1", padding: 12, borderRadius: 6 }}/>
    <Text>パスワード</Text>
    <TextInput secureTextEntry autoCapitalize="none" autoComplete="password" value={password}
      onChangeText={setPassword} style={{ borderWidth: 1, borderColor: "#cbd5e1", padding: 12, borderRadius: 6 }}/>
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    <Button title="ログイン" disabled={busy || !username || !password || Platform.OS === "web"} onPress={login}/>
  </View>;
}