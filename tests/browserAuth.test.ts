import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

async function browser(t: TestContext) {
  const stored = new Map<string, string>();
  const urls: string[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const events: string[] = [];
  const location = { origin: "http://localhost:3000", pathname: "/", search: "", assign: (url: string) => urls.push(url) };
  const replacements: Record<string, unknown> = {
    location, history: { replaceState: () => { location.search = ""; } },
    sessionStorage: { setItem: (k: string, v: string) => stored.set(k, v), getItem: (k: string) => stored.get(k) ?? null, removeItem: (k: string) => stored.delete(k) },
    window: { dispatchEvent: (event: Event) => { events.push(event.type); return true; } },
    fetch: async (path: string, init?: RequestInit) => {
      calls.push({ url: path, init });
      if (path === "/api/auth/config") return Response.json({ domain: "fixture.auth.ap-northeast-2.amazoncognito.com", clientId: "client123" });
      if (path.endsWith("/oauth2/token")) return Response.json({ access_token: "synthetic-browser-token", expires_in: 900 });
      return Response.json({}, { status: path.endsWith("expired") ? 401 : 200 });
    },
  };
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => {
    for (const key of Object.keys(replacements)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const auth = await import(`../src/web/auth.ts?fixture=${randomUUID()}`) as typeof import("../src/web/auth.js");
  return { auth, location, stored, calls, urls, events };
}

test("PKCE 로그인은 상태·challenge를 검증하고 중복 콜백 교환과 토큰 영속 저장을 방지한다", async t => {
  const b = await browser(t);
  await b.auth.beginLogin();
  const pending = JSON.parse(b.stored.get("refund-login-pkce")!);
  const redirect = new URL(b.urls[0]);
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
  assert.equal(redirect.searchParams.get("code_challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
  assert.equal(redirect.searchParams.get("state"), pending.state);
  b.location.search = `?code=single-use&state=${pending.state}`;
  await Promise.all([b.auth.initializeLogin(), b.auth.initializeLogin()]);
  assert.equal(b.calls.filter(call => call.url.endsWith("/oauth2/token")).length, 1);
  assert.equal(b.stored.size, 0);
  assert.equal(b.auth.hasSession(), true);
  await b.auth.authenticatedFetch("/api/payments");
  assert.equal(new Headers(b.calls.at(-1)!.init!.headers).get("Authorization"), "Bearer synthetic-browser-token");
  await b.auth.authenticatedFetch("/api/expired");
  assert.equal(b.auth.hasSession(), false);
  assert.deepEqual(b.events, ["refund-session-expired"]);
});

test("다른 OAuth state는 토큰 교환 전에 거부한다", async t => {
  const b = await browser(t);
  await b.auth.beginLogin();
  b.location.search = "?code=untrusted&state=wrong-state";
  await assert.rejects(b.auth.initializeLogin());
  assert.equal(b.calls.filter(call => call.url.endsWith("/oauth2/token")).length, 0);
  assert.equal(b.stored.size, 0);
});
