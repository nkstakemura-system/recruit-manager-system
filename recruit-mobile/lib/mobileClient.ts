export type SecureStorage = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};
type Session = { token: string; expiresAt: number };
const storageKey = "recruit-mobile-session";
export class AuthenticationRequired extends Error {}

export function createMobileClient(storage: SecureStorage, request: typeof fetch, baseUrl: string) {
  const listeners = new Set<() => void>();
  let generation = 0;
  let blocked = false;
  let mutations: Promise<void> = Promise.resolve();
  const mutate = (action: () => Promise<void>) => {
    const pending = mutations.then(action, action);
    mutations = pending.catch(() => {});
    return pending;
  };
  async function logout() {
    generation++;
    blocked = true;
    // Stop displaying data even if the native storage deletion fails.
    listeners.forEach(listener => listener());
    await mutate(() => storage.deleteItemAsync(storageKey));
  }
  async function session(): Promise<Session | null> {
    if (blocked) return null;
    const saved = await storage.getItemAsync(storageKey);
    if (!saved) return null;
    try {
      const value = JSON.parse(saved) as Session;
      if (typeof value.token !== "string" || !value.token || !Number.isFinite(value.expiresAt) ||
          value.expiresAt <= Date.now()) {
        await logout(); return null;
      }
      return value;
    } catch { await logout(); return null; }
  }
  async function apiFetch(path: string, options: RequestInit = {}) {
    if (!path.startsWith("/api/")) throw new Error("Invalid API path");
    const issued = generation;
    const current = await session();
    if (issued !== generation) throw new AuthenticationRequired();
    if (!current) throw new AuthenticationRequired();
    const headers = new Headers(options.headers);
    headers.set("Authorization", "Bearer " + current.token);
    const response = await request(baseUrl + path, { ...options, credentials: "omit", headers });
    if (issued !== generation) throw new AuthenticationRequired();
    if (response.status === 401) { await logout(); throw new AuthenticationRequired(); }
    return response;
  }
  async function login(username: string, password: string) {
    const issued = generation;
    const response = await request(baseUrl + "/api/auth/mobile/login", {
      method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? "しばらく待って再試行してください" : "ログインできません");
    const data = await response.json();
    if (issued !== generation) throw new AuthenticationRequired();
    if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_at) || data.expires_at <= Date.now())
      throw new Error("ログインできません");
    await mutate(async () => {
      if (issued !== generation) throw new AuthenticationRequired();
      await storage.setItemAsync(storageKey, JSON.stringify({ token: data.access_token, expiresAt: data.expires_at }));
      if (issued !== generation) throw new AuthenticationRequired();
      blocked = false;
      generation++;
    });
  }
  async function check() {
    if (!await session()) return null;
    const response = await apiFetch("/api/auth/me");
    if (!response.ok) throw new Error("認証状態を確認できません");
    await response.json();
    return (await session())?.expiresAt ?? null;
  }
  return { login, logout, check, apiFetch,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}