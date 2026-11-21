import { test } from "node:test";
import assert from "node:assert/strict";
import type { Evidence, TimelineEvent } from "../src/shared/types.js";
import { createPaymentStore } from "../src/server/payments/store.js";
import { toPaymentView } from "../src/server/status/paymentStatus.js";

const paymentWithRecords = () => createPaymentStore()[1];

for (const merchant of [false, true]) {
  for (const card of [false, true]) {
    test(`가맹점 ${merchant ? "확인" : "미확인"} · 카드 ${card ? "확인" : "미확인"} 상태와 문의 대상`, () => {
      const payment = paymentWithRecords();
      if (!merchant) payment.evidence = [];
      if (!card) payment.events = payment.events.filter(event => event.kind !== "card_cancel");
      const view = toPaymentView(payment);
      assert.equal(view.status.merchant, merchant ? "confirmed" : "unconfirmed");
      assert.equal(view.status.card, card ? "confirmed" : "unconfirmed");
      assert.match(view.inquirySummary, /합성 데이터/);
      assert.match(view.inquirySummary, /ORDER-002/);
      assert.match(view.inquirySummary, /32,000 KRW/);
      assert.match(view.inquirySummary, /결제일: 2026-11-14/);
      assert.ok(view.inquirySummary.includes(view.status.label));
      assert.doesNotMatch(view.inquirySummary, /환불 완료|취소 실패|영업일/);
      if (merchant) {
        assert.match(view.inquirySummary, /취소일: 2026-11-16/);
        assert.match(view.inquirySummary, /출처: 고객이 확인한 취소 증빙/);
        assert.match(view.inquirySummary, /고객 확인: 2026-11-16T03:00:00Z/);
      } else {
        assert.doesNotMatch(view.inquirySummary, /EVID-SEED-002/);
      }
      if (card) {
        assert.match(view.inquirySummary, /카드 반영일: 2026-11-18/);
        assert.match(view.inquirySummary, /출처: 합성 카드 취소 기록/);
        assert.doesNotMatch(view.nextAction, /카드사에.*문의/);
      } else {
        assert.match(view.inquirySummary, /카드 취소 반영 기록 없음/);
      }
      if (!merchant) assert.match(view.nextAction, /가맹점/);
      else if (!card) assert.match(view.nextAction, /카드사/);
      else assert.match(view.nextAction, /날짜와 금액/);
    });
  }
}

const invalidEvidence: [string, Partial<Evidence>][] = [
  ["다른 주문번호", { orderNumber: "ORDER-OTHER" }],
  ["부분 금액", { amount: 16000 }],
  ["다른 통화", { currency: "USD" as Evidence["currency"] }],
  ["결제 전 취소일", { cancelledOn: "2026-11-13" }],
  ["존재하지 않는 취소일", { cancelledOn: "2026-02-30" }],
  ["형식이 다른 취소일", { cancelledOn: "2026/11/16" }],
  ["고객 확인 시각 없음", { confirmedAt: "" }],
  ["잘못된 고객 확인 시각", { confirmedAt: "2026-02-30T03:00:00Z" }],
  ["UTC 없는 고객 확인 시각", { confirmedAt: "2026-11-16T03:00:00" }],
  ["범위 밖 확인 시각", { confirmedAt: "2026-11-16T24:00:00Z" }],
  ["고객 확인 전 AI 출처", { source: "bedrock" as Evidence["source"] }],
  ["증빙 ID 없음", { id: " " }],
];
for (const [name, patch] of invalidEvidence) {
  test(`${name} 증빙은 가맹점 확인과 문의자료 근거에서 제외`, () => {
    const payment = paymentWithRecords();
    payment.evidence = [{ ...payment.evidence[0], ...patch }];
    const view = toPaymentView(payment);
    assert.equal(view.status.merchant, "unconfirmed");
    assert.equal(view.status.card, "confirmed");
    assert.match(view.inquirySummary, /고객 확인 취소 증빙 없음/);
    assert.doesNotMatch(view.inquirySummary, /증빙 ID:/);
  });
}

const invalidCardRecords: [string, Partial<TimelineEvent>][] = [
  ["가맹점 이벤트", { kind: "merchant_cancel" }],
  ["결제 전 카드 반영일", { date: "2026-11-13" }],
  ["존재하지 않는 카드 반영일", { date: "2026-02-30" }],
  ["형식이 다른 카드 반영일", { date: "2026/11/18" }],
  ["출처 없음", { source: " " }],
  ["기록 ID 없음", { id: "" }],
];
for (const [name, patch] of invalidCardRecords) {
  test(`${name} 기록은 카드 확인 근거로 사용하지 않음`, () => {
    const payment = paymentWithRecords();
    payment.events = [{ ...payment.events.find(event => event.kind === "card_cancel")!, ...patch }];
    const view = toPaymentView(payment);
    assert.equal(view.status.merchant, "confirmed");
    assert.equal(view.status.card, "unconfirmed");
    assert.doesNotMatch(view.inquirySummary, /카드 반영일:/);
  });
}

test("결제 당일 취소와 밀리초 확인 시각을 허용하고 카드 날짜를 증빙 날짜로 추정하지 않음", () => {
  const payment = paymentWithRecords();
  payment.evidence[0].cancelledOn = payment.paidOn;
  payment.evidence[0].confirmedAt = "2026-11-16T03:00:00.123Z";
  const view = toPaymentView(payment);
  assert.equal(view.status.merchant, "confirmed");
  assert.match(view.inquirySummary, /취소일: 2026-11-14/);
  assert.match(view.inquirySummary, /카드 반영일: 2026-11-18/);
});

test("유효 기록만 날짜순으로 요약하며 원본 배열을 변경하지 않음", () => {
  const payment = paymentWithRecords();
  payment.evidence.unshift({ ...payment.evidence[0], id: "EVID-LATER", cancelledOn: "2026-11-19" });
  payment.evidence.push({ ...payment.evidence[0], id: "OTHER-ORDER", orderNumber: "ORDER-OTHER" });
  payment.events.unshift({ id: "CARD-LATER", kind: "card_cancel", date: "2026-11-20", source: "합성 카드 기록", label: "전액 취소 카드 반영 확인" });
  const before = structuredClone(payment);
  const first = toPaymentView(payment);
  const second = toPaymentView(payment);
  assert.deepEqual(payment, before);
  assert.deepEqual(first, second);
  assert.ok(first.inquirySummary.indexOf("취소일: 2026-11-16") < first.inquirySummary.indexOf("취소일: 2026-11-19"));
  assert.ok(first.inquirySummary.indexOf("카드 반영일: 2026-11-18") < first.inquirySummary.indexOf("카드 반영일: 2026-11-20"));
  assert.doesNotMatch(first.inquirySummary, /OTHER-ORDER/);
});

test("현재 결제의 잘못된 금액·결제일은 상태 확인 근거로 사용하지 않음", () => {
  for (const patch of [{ amount: -1 }, { amount: Number.NaN }, { paidOn: "2026-02-30" }]) {
    const view = toPaymentView({ ...paymentWithRecords(), ...patch });
    assert.equal(view.status.merchant, "unconfirmed");
    assert.equal(view.status.card, "unconfirmed");
  }
});

test("문의자료에 저장된 텍스트의 줄바꿈이 제목·상태를 가장하지 않음", () => {
  const payment = paymentWithRecords();
  payment.merchant = "합성 상점\n현재 상태: 임의 문구";
  payment.events.find(event => event.kind === "card_cancel")!.source = "카드 기록\n가짜 제목";
  const summary = toPaymentView(payment).inquirySummary;
  assert.equal(summary.split("\n").filter(line => line.startsWith("현재 상태:")).length, 1);
  assert.match(summary, /출처: 카드 기록 가짜 제목/);
});
