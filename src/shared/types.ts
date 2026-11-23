export interface EvidenceFields {
  orderNumber: string;
  amount: number; // 통화의 주요 단위. 현재 합성 데이터는 KRW 정수만 사용
  currency: "KRW";
  cancelledOn: string; // YYYY-MM-DD
}
export interface Evidence extends EvidenceFields {
  id: string;
  source: "customer_confirmed";
  confirmedAt: string;
}
export interface TimelineEvent {
  id: string;
  // 취소 요청은 접수된 사실만 나타낸다. 가맹점 확인과 카드 반영은 각각의 근거로 판단한다.
  kind: "payment" | "cancel_requested" | "merchant_cancel" | "card_cancel";
  date: string;
  source: string;
  label: string;
}
export interface Payment {
  id: string;
  orderNumber: string;
  merchant: string;
  amount: number;
  currency: "KRW";
  paidOn: string;
  evidence: Evidence[];
  events: TimelineEvent[];
}
export interface PaymentView extends Payment {
  status: {
    merchant: "confirmed" | "unconfirmed";
    card: "confirmed" | "unconfirmed";
    label: string;
  };
  nextAction: string;
  inquirySummary: string;
}
export interface ApiError { code: string; message: string }
export interface AnalysisResult {
  fields: Partial<EvidenceFields>;
  candidatePaymentIds: string[];
  provider: "bedrock";
}
