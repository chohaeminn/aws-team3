import type { Evidence, Payment, PaymentView, TimelineEvent } from "../../shared/types.js";

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function buildInquirySummary(
  payment: Payment,
  status: PaymentView["status"],
  evidence: Evidence[],
  cardRecords: TimelineEvent[],
): string {
  const request = status.card === "confirmed"
    ? status.merchant === "confirmed"
      ? "가맹점 취소 증빙과 카드 취소 기록이 확인되었습니다. 문의 시 위 기록의 날짜와 금액을 함께 확인해 주세요."
      : "카드 취소 기록은 확인되었습니다. 가맹점의 취소 처리 내역과 증빙을 확인 부탁드립니다."
    : status.merchant === "confirmed"
      ? "위 주문의 취소 안내를 받았습니다. 해당 결제의 카드 취소 반영 여부를 확인 부탁드립니다."
      : "해당 주문의 취소 처리 여부와 취소 증빙을 확인 부탁드립니다.";

  return [
    "[합성 데이터 · 문의용 요약]",
    `거래 ID: ${singleLine(payment.id)}`,
    `주문번호: ${singleLine(payment.orderNumber)}`,
    `가맹점: ${singleLine(payment.merchant)}`,
    `결제금액: ${payment.amount.toLocaleString("ko-KR")} ${payment.currency}`,
    `결제일: ${payment.paidOn}`,
    `현재 상태: ${status.label}`,
    "",
    "[가맹점 취소 증빙]",
    ...(evidence.length ? evidence.map(item =>
      `취소일: ${item.cancelledOn} / 출처: 고객이 확인한 취소 증빙 / 증빙 ID: ${singleLine(item.id)} / 고객 확인: ${item.confirmedAt}`,
    ) : ["해당 결제와 일치하는 고객 확인 취소 증빙 없음"]),
    "",
    "[카드 반영 기록]",
    ...(cardRecords.length ? cardRecords.map(item =>
      `카드 반영일: ${item.date} / 출처: ${singleLine(item.source)} / 기록 ID: ${singleLine(item.id)} / 전액 취소 기록`,
    ) : ["카드 취소 반영 기록 없음 · 반영 미확인"]),
    "",
    "[문의·확인할 내용]",
    request,
    "미확인은 확보한 기록만으로 확인할 수 없다는 뜻입니다. 실제 처리 결과를 단정하지 않습니다.",
  ].join("\n");
}
