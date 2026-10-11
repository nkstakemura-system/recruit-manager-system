import { useEffect, useState } from "react";

export default function Auth({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const expired = () => { setUser(null); setPassword(""); };
    window.addEventListener("recruit-auth-required", expired);
    fetch("/api/auth/me", { credentials: "include", cache: "no-store" })
      .then(async response => {
        if (response.ok) {
          const data = await response.json();
          if (active) setUser(data.user);
        } else if (response.status !== 401) throw new Error();
      }).catch(() => { if (active) setError("認証状態を確認できません"); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; window.removeEventListener("recruit-auth-required", expired); };
  }, []);
  async function login(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        setError(response.status === 429 ? "しばらく待って再試行してください" : "ログインできません");
        return;
      }
      const data = await response.json();
      setUser(data.user);
    } catch { setError("ログインできません"); }
    finally { setPassword(""); setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error();
      setUser(null); setPassword("");
    } catch { setError("ログアウトできません"); }
    finally { setBusy(false); }
  }
  if (checking) return <div style={{ padding: 24 }}>読込中...</div>;
  if (user) return <>
    <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 100 }}>
      {error && <span role="alert">{error} </span>}
      <button type="button" disabled={busy} onClick={logout}>ログアウト</button>
    </div>
    {children}
  </>;
  return <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", background: "#f8fafc" }}>
    <form onSubmit={login} style={{ width: 300, maxWidth: "calc(100vw - 32px)", display: "grid", gap: 12 }}>
      <label>ユーザー名<input required autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} style={{ display: "block", width: "100%", boxSizing: "border-box", padding: 10 }}/></label>
      <label>パスワード<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} style={{ display: "block", width: "100%", boxSizing: "border-box", padding: 10 }}/></label>
      {error && <div role="alert">{error}</div>}
      <button type="submit" disabled={busy}>ログイン</button>
    </form>
  </main>;
}