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
  kind: "payment" | "merchant_cancel" | "card_cancel";
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
