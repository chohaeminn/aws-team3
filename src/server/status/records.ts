import type { Evidence, Payment, TimelineEvent } from "../../shared/types.js";

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isConfirmationTime(value: string): boolean {
  const time = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && isCalendarDate(value.slice(0, 10)) && Number.isFinite(time)
    && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function hasValidPayment(payment: Payment): boolean {
  return isCalendarDate(payment.paidOn) && Number.isSafeInteger(payment.amount) && payment.amount > 0;
}

// API 검증뿐 아니라 향후 저장소에서 읽은 기록에도 같은 상태 기준을 적용한다.
export function confirmedEvidence(payment: Payment): Evidence[] {
  if (!hasValidPayment(payment)) return [];
  return payment.evidence.filter(item =>
    item.source === "customer_confirmed" && item.id.trim().length > 0
    && item.orderNumber === payment.orderNumber
    && item.amount === payment.amount && item.currency === payment.currency
    && isCalendarDate(item.cancelledOn) && item.cancelledOn >= payment.paidOn
    && isConfirmationTime(item.confirmedAt),
  ).sort((a, b) => a.cancelledOn.localeCompare(b.cancelledOn) || a.id.localeCompare(b.id));
}

// 현재 계약: 거래 안에 연결된 card_cancel은 전액 취소 카드 기록이다.
// 카드 반영은 가맹점 취소 증빙의 유무나 날짜와 독립적으로 판단한다.
export function cardCancellationRecords(payment: Payment): TimelineEvent[] {
  if (!hasValidPayment(payment)) return [];
  return payment.events.filter(item =>
    item.kind === "card_cancel" && item.id.trim().length > 0 && item.source.trim().length > 0
    && isCalendarDate(item.date) && item.date >= payment.paidOn,
  ).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
