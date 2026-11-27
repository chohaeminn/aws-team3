import { createHash } from "node:crypto";
import type { EvidenceFields, Payment, PaymentView } from "../../shared/types.js";

export class PaymentError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new PaymentError(status, code, message); }
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface WriteContext { actorId: string; ownerId?: string; requestId?: string }
export interface ConnectResult { body: PaymentView; replayed: boolean }

/** 저장소 구현(SQLite·DynamoDB)이 공통으로 지키는 계약. 모든 메서드는 비동기다. */
export interface PaymentStore {
  list(ownerId?: string): Promise<Payment[]>;
  get(id: string, ownerId?: string): Promise<Payment | undefined>;
  connectEvidence(paymentId: string, raw: unknown, key?: string, context?: WriteContext): Promise<ConnectResult>;
  assignUnclaimed(ownerId: string): Promise<number>;
  reset(context?: WriteContext): Promise<void>;
  close(): void | Promise<void>;
}

export const unassigned = "unassigned";

export function assertValidKey(key: string | undefined) {
  if (key !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(key)) fail(400, "INVALID_IDEMPOTENCY_KEY", "요청 키는 영문·숫자·하이픈·밑줄 16~128자로 보내 주세요.");
}

export function assertOwnerSubject(ownerId: string) {
  if (!ownerId || ownerId === unassigned) throw new Error("A verified customer subject is required");
}

/** 고객 확인 증빙 입력을 검증하고, 재전송 비교용 지문과 주체별 키 해시를 만든다. */
export function parseConfirmedEvidence(paymentId: string, raw: unknown, key: string | undefined, actorId: string) {
  const b = raw as Partial<EvidenceFields> & { confirmed?: unknown } | null;
  const validDate = typeof b?.cancelledOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.cancelledOn)
    && !Number.isNaN(Date.parse(b.cancelledOn)) && new Date(b.cancelledOn).toISOString().slice(0, 10) === b.cancelledOn;
  if (b?.confirmed !== true || typeof b.orderNumber !== "string" || !b.orderNumber.trim()
    || !Number.isSafeInteger(b.amount) || b.amount! <= 0 || b.currency !== "KRW" || !validDate) {
    fail(400, "INVALID_INPUT", "주문번호·금액·통화·유효한 취소일과 고객 확인이 필요해요.");
  }
  const fields: EvidenceFields = { orderNumber: b.orderNumber.trim(), amount: b.amount!, currency: "KRW", cancelledOn: b.cancelledOn! };
  const fingerprint = hash(JSON.stringify({ paymentId, ...fields, confirmed: true }));
  const keyHash = key ? hash(JSON.stringify([actorId, key])) : undefined;
  return { fields, fingerprint, keyHash };
}

export function replayOrConflict(previous: { fingerprint: string; responseJson: string }, fingerprint: string): ConnectResult {
  if (previous.fingerprint !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "같은 요청 키에 다른 내용을 사용할 수 없어요.");
  return { body: JSON.parse(previous.responseJson) as PaymentView, replayed: true };
}

export function assertConnectable(payment: Payment, fields: EvidenceFields) {
  if (fields.orderNumber !== payment.orderNumber || fields.amount !== payment.amount || fields.currency !== payment.currency || fields.cancelledOn < payment.paidOn) {
    fail(409, "PAYMENT_MISMATCH", "선택한 결제의 주문번호·전액 금액·통화·결제일을 확인해 주세요.");
  }
  if (payment.evidence.some(e => e.cancelledOn === fields.cancelledOn)) duplicateEvidence();
}

export function duplicateEvidence(): never {
  fail(409, "DUPLICATE_EVIDENCE", "같은 취소일의 증빙이 이미 연결되어 있어요.");
}
export const notFound = (): never => fail(404, "NOT_FOUND", "결제 건을 찾을 수 없어요.");
