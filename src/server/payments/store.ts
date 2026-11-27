import type { Payment } from "../../shared/types.js";

// 합성 시드 fixture. 실제 저장과 트랜잭션은 PaymentRepository가 담당한다.
export function createPaymentStore(): Payment[] {
  return [
    {
      id: "PAY-001", orderNumber: "ORDER-001", merchant: "샘플 스토어", amount: 50000,
      currency: "KRW", paidOn: "2026-11-15", evidence: [],
      events: [{ id: "EV-001", kind: "payment", date: "2026-11-15", source: "합성 카드 결제 기록", label: "결제 50,000 KRW" }],
    },
    {
      id: "PAY-002", orderNumber: "ORDER-002", merchant: "데모 마켓", amount: 32000,
      currency: "KRW", paidOn: "2026-11-14",
      evidence: [{ id: "EVID-SEED-002", orderNumber: "ORDER-002", amount: 32000, currency: "KRW", cancelledOn: "2026-11-16", source: "customer_confirmed", confirmedAt: "2026-11-16T03:00:00Z" }],
      events: [
        { id: "EV-002", kind: "payment", date: "2026-11-14", source: "합성 카드 결제 기록", label: "결제 32,000 KRW" },
        { id: "EV-006", kind: "cancel_requested", date: "2026-11-15", source: "합성 쇼핑몰 취소 요청 접수 내역", label: "고객 전액 취소 요청 접수" },
        { id: "EV-003", kind: "merchant_cancel", date: "2026-11-16", source: "고객 확인 취소 증빙 · 합성", label: "가맹점 전액 취소 확인" },
        { id: "EV-004", kind: "card_cancel", date: "2026-11-18", source: "합성 카드 취소 기록", label: "전액 취소 카드 반영 확인" },
      ],
    },
    {
      id: "PAY-003", orderNumber: "ORDER-003", merchant: "예시 숍", amount: 18000,
      currency: "KRW", paidOn: "2026-11-17", evidence: [],
      events: [
        { id: "EV-005", kind: "payment", date: "2026-11-17", source: "합성 카드 결제 기록", label: "결제 18,000 KRW" },
        { id: "EV-007", kind: "cancel_requested", date: "2026-11-18", source: "합성 쇼핑몰 취소 요청 접수 내역", label: "고객 전액 취소 요청 접수" },
      ],
    },
  ];
}
