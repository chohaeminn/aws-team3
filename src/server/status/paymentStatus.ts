import type { Payment, PaymentView } from "../../shared/types.js";

// ③ 담당: 가맹점 증빙과 카드 기록을 독립적으로 판단한다.
export function toPaymentView(payment: Payment): PaymentView {
  const merchant = payment.evidence.length > 0 ? "confirmed" : "unconfirmed";
  const card = payment.events.some(event => event.kind === "card_cancel") ? "confirmed" : "unconfirmed";
  const label = `가맹점 취소 ${merchant === "confirmed" ? "확인" : "미확인"} / 카드 반영 ${card === "confirmed" ? "확인" : "미확인"}`;
  const nextAction = merchant === "unconfirmed"
    ? "가맹점 취소 증빙을 확인해 연결해 주세요."
    : card === "unconfirmed"
      ? "가맹점 취소 증빙은 확인됐어요. 아래 자료로 카드사에 취소 반영 여부를 문의할 수 있어요."
      : "가맹점 증빙과 카드 취소 기록이 모두 확인됐어요. 각 기록의 날짜와 금액을 확인해 주세요.";
  const evidence = payment.evidence.map(item => `취소일: ${item.cancelledOn} / 증빙: ${item.id} / 고객 확인: ${item.confirmedAt}`).join("\n") || "확인된 가맹점 취소 증빙 없음";
  const inquirySummary = [
    "[합성 데이터 · 문의용 요약]", `거래 ID: ${payment.id}`, `주문번호: ${payment.orderNumber}`,
    `가맹점: ${payment.merchant}`, `결제금액: ${payment.amount.toLocaleString("ko-KR")} ${payment.currency}`,
    `결제일: ${payment.paidOn}`, evidence, `현재 상태: ${label}`,
    card === "confirmed" ? "해당 거래의 카드 취소 기록이 확인되었습니다."
      : merchant === "confirmed" ? "위 주문의 취소 안내를 받았습니다. 해당 결제의 카드 취소 반영 여부를 확인 부탁드립니다."
      : "해당 주문의 취소 처리 여부와 취소 증빙을 확인 부탁드립니다.",
  ].join("\n");
  return { ...payment, status: { merchant, card, label }, nextAction, inquirySummary };
}
