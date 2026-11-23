import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalysisFailed, AnalysisUnavailable, analyzeEvidence, createGeminiAnalyzer, defaultGeminiModel, geminiEndpoint, thinkingConfigFromEnv } from "../src/server/evidence/analyzer.js";
import { createApp } from "../src/server/app.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const geminiBody = (payload: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
const png = new Uint8Array([137, 80, 78, 71]);

test("Gemini 요청에 텍스트·이미지·JSON 응답 설정을 담고 후보를 계산한다", async () => {
  let call: { url: string; init: RequestInit } | undefined;
  const analyze = createGeminiAnalyzer({ apiKey: "secret-key", fetchImpl: async (url, init) => {
    call = { url: String(url), init: init! };
    return geminiBody({ orderNumber: "ORDER-002", amount: 32000, currency: "KRW", cancelledOn: "2026-11-20" });
  } });
  const result = await analyze({ text: "취소 안내", images: [{ mediaType: "image/png", bytes: png }] });
  assert.equal(call?.url, geminiEndpoint(defaultGeminiModel));
  assert.equal((call?.init.headers as Record<string, string>)["x-goog-api-key"], "secret-key");
  assert.ok(!call?.url.includes("secret-key"));
  const sent = JSON.parse(String(call?.init.body));
  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  const parts = sent.contents[0].parts;
  assert.ok(parts.some((p: { text?: string }) => p.text?.includes("취소 안내")));
  assert.deepEqual(parts.find((p: { inlineData?: unknown }) => p.inlineData).inlineData, { mimeType: "image/png", data: Buffer.from(png).toString("base64") });
  assert.deepEqual(result, {
    fields: { orderNumber: "ORDER-002", amount: 32000, currency: "KRW", cancelledOn: "2026-11-20" },
    candidatePaymentIds: ["PAY-002"], provider: "gemini",
  });
});

test("불명확하거나 형식이 틀린 값은 생략하고 후보를 만들지 않는다", async () => {
  const analyze = createGeminiAnalyzer({ apiKey: "k", fetchImpl: async () => geminiBody({ orderNumber: " ", amount: "5만원", currency: "USD", cancelledOn: "2026-02-31" }) });
  assert.deepEqual(await analyze({ text: "x", images: [] }), { fields: {}, candidatePaymentIds: [], provider: "gemini" });
  const partial = createGeminiAnalyzer({ apiKey: "k", fetchImpl: async () => geminiBody({ orderNumber: "ORDER-001", amount: 50000 }) });
  const result = await partial({ text: "x", images: [] });
  assert.deepEqual(result.fields, { orderNumber: "ORDER-001", amount: 50000 });
  assert.deepEqual(result.candidatePaymentIds, []);
});

test("HTTP 오류·네트워크 오류·잘못된 응답은 AnalysisFailed이며 키를 노출하지 않는다", async t => {
  t.mock.method(console, "error", () => {});
  for (const fetchImpl of [
    async () => new Response("{}", { status: 429 }),
    async () => { throw new Error("network secret-key"); },
    async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 }),
  ]) {
    await assert.rejects(createGeminiAnalyzer({ apiKey: "secret-key", fetchImpl })({ text: "x", images: [] }), (error: Error) => {
      assert.ok(error instanceof AnalysisFailed);
      assert.ok(!error.message.includes("secret-key"));
      return true;
    });
  }
});

test("키가 없으면 AnalysisUnavailable, 키가 있으면 /api/health가 aiConnected를 반영한다", async t => {
  const saved = process.env.GEMINI_API_KEY;
  t.after(() => { if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved; });
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const health = () => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`).then(r => r.json());
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(analyzeEvidence({ text: "x", images: [] }), AnalysisUnavailable);
  assert.equal((await health()).aiConnected, false);
  process.env.GEMINI_API_KEY = "test-key";
  assert.equal((await health()).aiConnected, true);
});

test("200이 아닌 응답은 상태 코드와 Google 오류 본문을 콘솔에 남기되 키는 가린다", async t => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.join(" ")); });
  const body = JSON.stringify({ error: { code: 404, message: "models/x is not found (key secret-key)", status: "NOT_FOUND" } });
  const analyze = createGeminiAnalyzer({ apiKey: "secret-key", model: "x", fetchImpl: async () => new Response(body, { status: 404 }) });
  await assert.rejects(analyze({ text: "t", images: [] }), AnalysisFailed);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /HTTP 404/);
  assert.match(logged[0], /models\/x is not found/);
  assert.ok(!logged[0].includes("secret-key"));
});

test("GEMINI_MODEL로 모델을 바꿀 수 있다", async t => {
  const saved = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  t.after(() => { for (const [name, value] of [["GEMINI_API_KEY", saved.key], ["GEMINI_MODEL", saved.model]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.GEMINI_API_KEY = "k"; process.env.GEMINI_MODEL = "custom-model";
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => { urls.push(String(url)); return new Response("{}", { status: 404 }); });
  t.mock.method(console, "error", () => {});
  await assert.rejects(analyzeEvidence({ text: "t", images: [] }), AnalysisFailed);
  assert.equal(urls[0], geminiEndpoint("custom-model"));
});

test("금액은 숫자 문자열도 정수로 받고, 날짜는 미래라도 유효하면 통과시킨다", async () => {
  const run = (payload: unknown) => createGeminiAnalyzer({ apiKey: "k", fetchImpl: async () => geminiBody(payload) })({ text: "x", images: [] });
  for (const amount of [50000, "50000", "50,000", " 50,000 "]) {
    const result = await run({ orderNumber: "ORDER-001", amount, currency: "KRW", cancelledOn: "2030-12-31" });
    assert.deepEqual(result.fields, { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2030-12-31" });
    assert.deepEqual(result.candidatePaymentIds, ["PAY-001"]);
  }
  for (const amount of ["5만원", "50,00", "-100", "0", 1.5, 0, null, "1e3"]) {
    assert.equal((await run({ amount })).fields.amount, undefined, String(amount));
  }
  assert.equal((await run({ cancelledOn: "2026-11-19" })).fields.cancelledOn, "2026-11-19");
  for (const date of ["2026.11.19", "2026-13-01", "2026-02-30", "19/11/2026"]) {
    assert.equal((await run({ cancelledOn: date })).fields.cancelledOn, undefined, date);
  }
});

test("요청 스키마는 amount를 INTEGER로, 프롬프트는 형식 예시를 담는다", async () => {
  let sent: any;
  await createGeminiAnalyzer({ apiKey: "k", fetchImpl: async (_url, init) => { sent = JSON.parse(String(init?.body)); return geminiBody({}); } })({ text: "x", images: [] });
  assert.equal(sent.generationConfig.responseSchema.properties.amount.type, "INTEGER");
  const prompt: string = sent.contents[0].parts[0].text;
  assert.match(prompt, /50000/);
  assert.match(prompt, /YYYY-MM-DD/);
  assert.match(prompt, /2026-11-19/);
});

test("fields로 감싼 응답과 최상위 응답을 같은 결과로 정리한다", async t => {
  const expected = { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19" };
  const run = (payload: unknown) => createGeminiAnalyzer({ apiKey: "k", fetchImpl: async () => geminiBody(payload) })({ text: "x", images: [] });
  for (const payload of [
    { orderNumber: "ORDER-001", amount: "50,000", currency: "krw", cancelledOn: "2026-11-19" },
    { fields: { orderNumber: "ORDER-001", amount: "50000", currency: "KRW", cancelledOn: "2026-11-19" } },
    [{ fields: { orderNumber: "ORDER-001", amount: 50000 }, currency: "KRW", cancelledOn: "2026-11-19" }],
  ]) {
    const result = await run(payload);
    assert.deepEqual(result.fields, expected);
    assert.deepEqual(result.candidatePaymentIds, ["PAY-001"]);
  }
});

test("스키마는 4개 키를 required·nullable로 지정하고 thinkingBudget 0을 보낸다", async () => {
  let sent: any;
  const analyzer = (extra = {}) => createGeminiAnalyzer({ apiKey: "k", ...extra, fetchImpl: async (_url, init) => { sent = JSON.parse(String(init?.body)); return geminiBody({}); } });
  await analyzer({ thinkingConfig: thinkingConfigFromEnv("") })({ text: "x", images: [] });
  const schema = sent.generationConfig.responseSchema;
  assert.deepEqual(schema.required, ["orderNumber", "amount", "currency", "cancelledOn"]);
  for (const key of schema.required) assert.equal(schema.properties[key].nullable, true, key);
  assert.deepEqual(sent.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.match(sent.contents[0].parts[0].text, /4개 필드를 모두 추출/);
  await analyzer({ thinkingConfig: thinkingConfigFromEnv("none") })({ text: "x", images: [] });
  assert.equal("thinkingConfig" in sent.generationConfig, false);
  assert.deepEqual(thinkingConfigFromEnv("512"), { thinkingBudget: 512 });
});

test("null 값은 없는 값으로 처리하고 후보를 만들지 않는다", async t => {
  const run = (payload: unknown) => createGeminiAnalyzer({ apiKey: "k", fetchImpl: async () => geminiBody(payload) })({ text: "x", images: [] });
  const result = await run({ orderNumber: "ORDER-001", amount: null, currency: null, cancelledOn: null });
  assert.deepEqual(result.fields, { orderNumber: "ORDER-001" });
  assert.deepEqual(result.candidatePaymentIds, []);
  const wrapped = await run({ orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19", fields: { amount: null, cancelledOn: null } });
  assert.deepEqual(wrapped.fields, { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19" });
  assert.equal(JSON.stringify(await run({ orderNumber: null, amount: null, currency: null, cancelledOn: null })), JSON.stringify({ fields: {}, candidatePaymentIds: [], provider: "gemini" }));
});

test("HTTP 상태 코드별로 사용자 안내 메시지를 나눈다", async t => {
  t.mock.method(console, "error", () => {});
  const messageFor = async (status: number) => {
    const analyze = createGeminiAnalyzer({ apiKey: "k", fetchImpl: async () => new Response("{}", { status }) });
    return analyze({ text: "x", images: [] }).then(() => "", (error: Error) => error.message);
  };
  const keyMessage = (status: number) => `AI API 키가 유효하지 않거나 접근 권한이 없어요. 서버의 GEMINI_API_KEY 설정을 확인해 주세요. (HTTP ${status})`;
  assert.equal(await messageFor(401), keyMessage(401));
  assert.equal(await messageFor(403), keyMessage(403));
  assert.equal(await messageFor(429), "AI 요청 한도를 초과했어요. 잠시 후 다시 시도해 주세요. (HTTP 429)");
  for (const status of [400, 404, 500, 503]) {
    assert.equal(await messageFor(status), `AI 서버가 오류를 반환했어요. 잠시 후 다시 시도해 주세요. (HTTP ${status})`);
  }
});
