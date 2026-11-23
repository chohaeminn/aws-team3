import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server/app.js";
import type { EvidenceAnalysisInput, EvidenceAnalyzer } from "../src/server/evidence/analyzer.js";
import { createPaymentStore } from "../src/server/payments/store.js";
import type { AnalysisResult } from "../src/shared/types.js";
import { createMockEvidenceAnalyzer } from "./fixtures/mockEvidenceAnalyzer.js";

async function startApp(t: TestContext, evidenceAnalyzer?: EvidenceAnalyzer) {
  const server = createApp({ evidenceAnalyzer }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: BodyInit, headers?: HeadersInit) =>
    fetch(base + "/api/evidence/analyze", { method: "POST", headers, body });
  return { base, post };
}

const jsonHeaders = { "Content-Type": "application/json" };
const imageBytes = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=",
  "base64",
));

test("분석기가 JSON과 FormData 입력을 받고 동일한 모의 결과를 반환한다", async t => {
  const [payment] = createPaymentStore();
  const result: AnalysisResult = {
    fields: { orderNumber: payment.orderNumber, amount: payment.amount, currency: payment.currency, cancelledOn: "2026-11-19" },
    candidatePaymentIds: [payment.id],
    provider: "bedrock",
  };
  const mock = createMockEvidenceAnalyzer(result);
  const received: EvidenceAnalysisInput[] = [];
  const { base, post } = await startApp(t, input => {
    received.push(input);
    return mock(input);
  });
  const before = await fetch(base + "/api/payments").then(response => response.json());
  const text = "  합성 취소 메일 ORDER-001 / 50,000원  ";
  const textOnly = new FormData();
  textOnly.set("text", text);
  const imageOnly = new FormData();
  imageOnly.append("images", new Blob([imageBytes], { type: "image/png" }), "capture.png");
  const combined = new FormData();
  combined.set("text", text);
  combined.append("images", new Blob([imageBytes], { type: "image/png" }), "capture.png");
  const jpegBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  combined.append("images", new Blob([jpegBytes], { type: "image/jpeg" }), "capture.jpg");

  const requests = [
    () => post(JSON.stringify({ text }), jsonHeaders),
    () => post(textOnly),
    () => post(imageOnly),
    () => post(combined),
    () => post(combined),
  ];
  for (const request of requests) {
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
  }
  const png = { mediaType: "image/png", bytes: imageBytes };
  const jpeg = { mediaType: "image/jpeg", bytes: jpegBytes };
  assert.deepEqual(received, [
    { text, images: [] },
    { text, images: [] },
    { text: undefined, images: [png] },
    { text, images: [png, jpeg] },
    { text, images: [png, jpeg] },
  ]);
  assert.deepEqual(await fetch(base + "/api/payments").then(response => response.json()), before);
});

test("유효하지 않은 입력은 분석기 호출 전에 거절한다", async t => {
  let calls = 0;
  const { post } = await startApp(t, async () => {
    calls++;
    throw new Error("invalid input reached analyzer");
  });
  const empty = new FormData();
  empty.set("text", "  ");
  const wrongType = new FormData();
  wrongType.append("images", new Blob(["GIF"], { type: "image/gif" }), "capture.gif");
  const tooMany = new FormData();
  for (let index = 0; index < 5; index++) {
    tooMany.append("images", new Blob([imageBytes], { type: "image/png" }), "capture.png");
  }
  const tooLarge = new FormData();
  tooLarge.append("images", new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "image/png" }), "capture.png");
  for (const request of [
    () => post(JSON.stringify({ text: "" }), jsonHeaders),
    () => post(empty),
    () => post(wrongType),
    () => post(tooMany),
    () => post(tooLarge),
    () => post("invalid body", { "Content-Type": "multipart/form-data; boundary=missing" }),
  ]) {
    const response = await request();
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.deepEqual(body, { code: "INVALID_INPUT", message: body.message });
    assert.equal(typeof body.message, "string");
  }
  assert.equal(calls, 0);
});

test("기본 서버는 분석 미연결을 응답한다", async t => {
  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => { if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey; });
  const { base, post } = await startApp(t);
  const form = new FormData();
  form.append("images", new Blob([imageBytes], { type: "image/png" }), "capture.png");
  const response = await post(form);
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.deepEqual(body, { code: "AI_NOT_CONFIGURED", message: body.message });
  assert.match(body.message, /AI 분석/);
  assert.equal((await fetch(base + "/api/health").then(response => response.json())).aiConnected, false);
});

test("예상하지 못한 분석 오류는 기존 내부 오류 형식으로 응답한다", async t => {
  const { post } = await startApp(t, async () => { throw new Error("analyzer failure"); });
  const response = await post(JSON.stringify({ text: "합성 취소 메일" }), jsonHeaders);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: "INTERNAL_ERROR", message: "처리 중 오류가 발생했어요." });
});
