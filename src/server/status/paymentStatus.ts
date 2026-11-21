import type { Payment, PaymentView } from "../../shared/types.js";
import { confirmedEvidence, cardCancellationRecords } from "./records.js";
import { buildInquirySummary } from "./inquirySummary.js";

// ③ 담당: 가맹점 증빙과 카드 기록을 독립적으로 판단한다.
export function toPaymentView(payment: Payment): PaymentView {
  const evidence = confirmedEvidence(payment);
  const cardRecords = cardCancellationRecords(payment);
  const merchant = evidence.length > 0 ? "confirmed" : "unconfirmed";
  const card = cardRecords.length > 0 ? "confirmed" : "unconfirmed";
  const label = `가맹점 취소 ${merchant === "confirmed" ? "확인" : "미확인"} / 카드 반영 ${card === "confirmed" ? "확인" : "미확인"}`;
  const status: PaymentView["status"] = { merchant, card, label };
  const nextAction = merchant === "unconfirmed"
    ? card === "confirmed"
      ? "카드 취소 기록은 확인됐어요. 가맹점 취소 증빙을 확보해 내용을 확인하고 연결해 주세요."
      : "가맹점에 취소 처리 여부와 증빙을 확인해 주세요. 확보한 증빙은 내용을 확인한 뒤 결제에 연결해 주세요."
    : card === "unconfirmed"
      ? "가맹점 취소 증빙은 확인됐어요. 아래 자료로 카드사에 취소 반영 여부를 문의할 수 있어요."
      : "가맹점 증빙과 카드 취소 기록이 모두 확인됐어요. 각 기록의 날짜와 금액을 확인해 주세요.";
  return { ...payment, status, nextAction, inquirySummary: buildInquirySummary(payment, status, evidence, cardRecords) };
}
