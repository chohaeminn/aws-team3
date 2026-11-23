import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server/app.js";
import type { EvidenceAnalysisInput, EvidenceAnalyzer } from "../src/server/evidence/analyzer.js";
import { createPaymentStore } from "../src/server/payments/store.js";
import type { AnalysisResult, PaymentView } from "../src/shared/types.js";
import { createMockEvidenceAnalyzer } from "./fixtures/mockEvidenceAnalyzer.js";

async function startApp(t: TestContext, evidenceAnalyzer?: EvidenceAnalyzer) {
  const server = createApp({ evidenceAnalyzer }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const postJson = (path: string, body: unknown) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const getPayments = async (): Promise<PaymentView[]> => {
    const response = await fetch(base + "/api/payments");
    assert.equal(response.status, 200);
    return response.json();
  };
  const getPayment = async (id: string): Promise<PaymentView> => {
    const response = await fetch(base + "/api/payments/" + id);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { base, postJson, getPayments, getPayment };
}

function assertOtherPaymentsUnchanged(before: PaymentView[], after: PaymentView[], changedId: string) {
  assert.deepEqual(after.filter(payment => payment.id !== changedId), before.filter(payment => payment.id !== changedId));
}

test("모의 분석 결과는 고객 확인 전 저장되지 않고 확인한 거래에만 연결된다", async t => {
  const [payment] = createPaymentStore();
  const result: AnalysisResult = {
    fields: { orderNumber: payment.orderNumber, amount: payment.amount, currency: payment.currency, cancelledOn: "2026-11-19" },
    candidatePaymentIds: [payment.id],
    provider: "bedrock",
  };
  const { postJson, getPayments, getPayment } = await startApp(t, createMockEvidenceAnalyzer(result));
  const before = await getPayments();
  const original = before.find(item => item.id === payment.id);
  assert.ok(original);

  const analysis = await postJson("/api/evidence/analyze", { text: "합성 취소 메일 ORDER-001 / 50,000원" });
  assert.equal(analysis.status, 200);
  const extracted: AnalysisResult = await analysis.json();
  assert.deepEqual(extracted, result);
  assert.deepEqual(await getPayments(), before);

  const endpoint = `/api/payments/${payment.id}/evidence`;
  const unconfirmed = await postJson(endpoint, { ...extracted.fields, confirmed: false });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json()).code, "INVALID_INPUT");
  assert.deepEqual(await getPayments(), before);

  const mismatched = await postJson("/api/payments/PAY-003/evidence", { ...extracted.fields, confirmed: true });
  assert.equal(mismatched.status, 409);
  assert.equal((await mismatched.json()).code, "PAYMENT_MISMATCH");
  assert.deepEqual(await getPayments(), before);

  const response = await postJson(endpoint, { ...extracted.fields, confirmed: true });
  assert.equal(response.status, 201);
  const updated: PaymentView = await response.json();
  assert.equal(updated.evidence.length, 1);
  const evidence = updated.evidence[0];
  assert.deepEqual({
    orderNumber: evidence.orderNumber, amount: evidence.amount, currency: evidence.currency, cancelledOn: evidence.cancelledOn,
  }, extracted.fields);
  assert.equal(evidence.source, "customer_confirmed");
  assert.ok(evidence.id.trim());
  assert.ok(Number.isFinite(Date.parse(evidence.confirmedAt)));
  assert.deepEqual(updated.events, [...original.events, {
    id: evidence.id, kind: "merchant_cancel", date: "2026-11-19", source: "고객 확인 취소 증빙", label: "가맹점 전액 취소 확인",
  }]);
  assert.equal(updated.events.some(event => event.kind === "cancel_requested"), false);
  assert.equal(updated.status.merchant, "confirmed");
  assert.equal(updated.status.card, "unconfirmed");

  const after = await getPayments();
  assert.deepEqual(after.find(item => item.id === payment.id), updated);
  assert.deepEqual(await getPayment(payment.id), updated);
  assertOtherPaymentsUnchanged(before, after, payment.id);
});

test("PAY-003 증빙 연결은 기존 취소 요청 기록을 보존하고 가맹점 기록만 추가한다", async t => {
  const { postJson, getPayments, getPayment } = await startApp(t);
  const before = await getPayments();
  const original = before.find(payment => payment.id === "PAY-003");
  assert.ok(original);
  const request = original.events.find(event => event.kind === "cancel_requested");
  assert.ok(request);
  assert.equal(request.date, "2026-11-18");
  assert.match(request.source, /쇼핑몰.*접수/);
  assert.equal(original.status.merchant, "unconfirmed");
  assert.equal(original.status.card, "unconfirmed");

  const response = await postJson("/api/payments/PAY-003/evidence", {
    orderNumber: original.orderNumber, amount: original.amount, currency: original.currency,
    cancelledOn: "2026-11-19", confirmed: true,
  });
  assert.equal(response.status, 201);
  const updated: PaymentView = await response.json();
  assert.equal(updated.evidence.length, 1);
  assert.deepEqual(updated.events, [...original.events, {
    id: updated.evidence[0].id, kind: "merchant_cancel", date: "2026-11-19", source: "고객 확인 취소 증빙", label: "가맹점 전액 취소 확인",
  }]);
  assert.deepEqual(updated.events.filter(event => event.kind === "cancel_requested"), [request]);
  assert.equal(updated.status.merchant, "confirmed");
  assert.equal(updated.status.card, "unconfirmed");
  assert.match(updated.inquirySummary, /취소일: 2026-11-19/);
  assert.match(updated.inquirySummary, /카드 취소 반영 기록 없음/);

  const after = await getPayments();
  assert.deepEqual(after.find(payment => payment.id === original.id), updated);
  assert.deepEqual(await getPayment(original.id), updated);
  assertOtherPaymentsUnchanged(before, after, original.id);
});

test("PAY-002 증빙 추가는 기존 증빙과 요청·카드 기록 및 양쪽 확인 상태를 보존한다", async t => {
  const { postJson, getPayments, getPayment } = await startApp(t);
  const before = await getPayments();
  const original = before.find(payment => payment.id === "PAY-002");
  assert.ok(original);
  assert.equal(original.evidence.length, 1);
  assert.equal(original.evidence[0].cancelledOn, "2026-11-16");
  const card = original.events.find(event => event.kind === "card_cancel");
  assert.ok(card);
  assert.equal(card.date, "2026-11-18");

  const response = await postJson("/api/payments/PAY-002/evidence", {
    orderNumber: original.orderNumber, amount: original.amount, currency: original.currency,
    cancelledOn: "2026-11-19", confirmed: true,
  });
  assert.equal(response.status, 201);
  const updated: PaymentView = await response.json();
  assert.equal(updated.evidence.length, original.evidence.length + 1);
  assert.deepEqual(updated.evidence.slice(0, original.evidence.length), original.evidence);
  const added = updated.evidence[original.evidence.length];
  assert.equal(added.cancelledOn, "2026-11-19");
  assert.equal(added.source, "customer_confirmed");
  assert.deepEqual(updated.events, [...original.events, {
    id: added.id, kind: "merchant_cancel", date: "2026-11-19", source: "고객 확인 취소 증빙", label: "가맹점 전액 취소 확인",
  }]);
  assert.deepEqual(updated.events.filter(event => event.kind === "card_cancel"), [card]);
  assert.deepEqual(updated.events.filter(event => event.kind === "cancel_requested"), original.events.filter(event => event.kind === "cancel_requested"));
  assert.equal(updated.status.merchant, "confirmed");
  assert.equal(updated.status.card, "confirmed");
  assert.match(updated.inquirySummary, /취소일: 2026-11-16/);
  assert.match(updated.inquirySummary, /취소일: 2026-11-19/);
  assert.match(updated.inquirySummary, /카드 반영일: 2026-11-18/);
  assert.ok(updated.inquirySummary.includes(card.source));

  const after = await getPayments();
  assert.deepEqual(after.find(payment => payment.id === original.id), updated);
  assert.deepEqual(await getPayment(original.id), updated);
  assertOtherPaymentsUnchanged(before, after, original.id);
});

test("모의 분석 실패 후 동일 FormData를 재시도해도 입력과 전체 결제 기록이 보존된다", async t => {
  const [payment] = createPaymentStore();
  const result: AnalysisResult = {
    fields: { orderNumber: payment.orderNumber, amount: payment.amount, currency: payment.currency, cancelledOn: "2026-11-19" },
    candidatePaymentIds: [payment.id],
    provider: "bedrock",
  };
  const mock = createMockEvidenceAnalyzer(result);
  const received: EvidenceAnalysisInput[] = [];
  const { base, getPayments } = await startApp(t, async input => {
    received.push(structuredClone(input));
    if (received.length === 1) throw new Error("모의 분석 첫 요청 실패");
    return mock(input);
  });
  const before = await getPayments();
  const text = "  합성 취소 메일 ORDER-001 / 50,000원\r\n취소일 2026-11-19  ";
  const imageBytes = new Uint8Array(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=",
    "base64",
  ));
  const form = new FormData();
  form.set("text", text);
  form.append("images", new Blob([imageBytes], { type: "image/png" }), "capture.png");
  const analyze = () => fetch(base + "/api/evidence/analyze", { method: "POST", body: form });

  const failed = await analyze();
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { code: "INTERNAL_ERROR", message: "처리 중 오류가 발생했어요." });
  assert.deepEqual(await getPayments(), before);

  const retried = await analyze();
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), result);
  const input: EvidenceAnalysisInput = { text, images: [{ mediaType: "image/png", bytes: imageBytes }] };
  assert.deepEqual(received, [input, input]);
  assert.deepEqual(await getPayments(), before);
});
