interface AuthConfig { domain: string; clientId: string }
interface PendingLogin extends AuthConfig { state: string; verifier: string; createdAt: number }
let token: { value: string; expiresAt: number } | undefined;
let initialization: Promise<void> | undefined;
const storageKey = "refund-login-pkce";
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function config(): Promise<AuthConfig> {
  const response = await fetch("/api/auth/config");
  if (!response.ok) throw new Error("로그인 설정을 불러오지 못했어요.");
  const data = await response.json() as AuthConfig;
  if (!/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(data.domain) || !/^[a-z0-9]+$/i.test(data.clientId)) throw new Error("아직 로그인 서비스가 설정되지 않았어요. 관리자에게 문의해 주세요.");
  return data;
}
export async function beginLogin() {
  const auth = await config();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const pending: PendingLogin = { ...auth, state, verifier, createdAt: Date.now() };
  sessionStorage.setItem(storageKey, JSON.stringify(pending));
  const params = new URLSearchParams({ response_type: "code", client_id: auth.clientId, redirect_uri: location.origin + "/", scope: "openid profile", state, code_challenge: challenge, code_challenge_method: "S256" });
  location.assign(`https://${auth.domain}/oauth2/authorize?${params}`);
}
export function initializeLogin(): Promise<void> {
  return initialization ??= (async () => {
    const query = new URLSearchParams(location.search);
    if (!query.has("code") && !query.has("error")) return;
    const saved = sessionStorage.getItem(storageKey);
    sessionStorage.removeItem(storageKey);
    history.replaceState(null, "", location.pathname);
    if (!saved) throw new Error("로그인 요청이 만료됐어요. 다시 로그인해 주세요.");
    const pending = JSON.parse(saved) as PendingLogin;
    if (query.get("state") !== pending.state || Date.now() - pending.createdAt > 600_000 || query.has("error")) throw new Error("로그인 요청을 확인할 수 없어요. 다시 로그인해 주세요.");
    const auth = await config();
    if (auth.domain !== pending.domain || auth.clientId !== pending.clientId) throw new Error("로그인 설정이 변경됐어요. 다시 시도해 주세요.");
    const response = await fetch(`https://${auth.domain}/oauth2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: auth.clientId, code: query.get("code")!, redirect_uri: location.origin + "/", code_verifier: pending.verifier }),
    });
    if (!response.ok) throw new Error("로그인을 완료하지 못했어요. 다시 시도해 주세요.");
    const data = await response.json();
    if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 3600) throw new Error("올바른 로그인 응답이 아니에요.");
    // Access and refresh tokens are never persisted in browser storage.
    token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  })();
}
export function hasSession() { return Boolean(token && token.expiresAt > Date.now()); }
export async function authenticatedFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (hasSession()) headers.set("Authorization", `Bearer ${token!.value}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) { token = undefined; window.dispatchEvent(new Event("refund-session-expired")); }
  return response;
}
export async function logout() {
  token = undefined;
  const auth = await config();
  location.assign(`https://${auth.domain}/logout?${new URLSearchParams({ client_id: auth.clientId, logout_uri: location.origin + "/" })}`);
}
