export async function apiFetch(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: "include", cache: "no-store" });
  if (response.status === 401) {
    window.dispatchEvent(new Event("recruit-auth-required"));
    throw new Error("ログインしてください");
  }
  return response;
}