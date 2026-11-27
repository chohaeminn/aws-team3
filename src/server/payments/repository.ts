import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Evidence, EvidenceFields, Payment, PaymentView, TimelineEvent } from "../../shared/types.js";
import { createPaymentStore } from "./store.js";
import { toPaymentView } from "../status/paymentStatus.js";

export class PaymentError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new PaymentError(status, code, message); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Single-host demo repository. All evidence writes, replay records and audit records commit together. */
export class PaymentRepository {
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, order_number TEXT NOT NULL, merchant TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0 AND amount<=9007199254740991),
        currency TEXT NOT NULL CHECK(currency='KRW'), paid_on TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
        order_number TEXT NOT NULL, amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
        currency TEXT NOT NULL CHECK(currency='KRW'), cancelled_on TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source='customer_confirmed'), confirmed_at TEXT NOT NULL,
        UNIQUE(payment_id, cancelled_on)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
        kind TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, label TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_payment ON events(payment_id);
      CREATE TABLE IF NOT EXISTS idempotency (
        key_hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
        payment_id TEXT, evidence_id TEXT, request_hash TEXT, occurred_at TEXT NOT NULL
      );
    `);
    this.transaction(() => {
      if (!this.db.prepare("SELECT id FROM payments LIMIT 1").get()) this.seed();
    });
  }
  close() { this.db.close(); }
  private transaction<T>(operation: () => T, mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE"): T {
    if (this.inTransaction) return operation();
    this.db.exec(`BEGIN ${mode}`);
    this.inTransaction = true;
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.inTransaction = false; }
  }
  private seed() {
    for (const p of createPaymentStore()) {
      this.db.prepare("INSERT INTO payments VALUES(?,?,?,?,?,?)").run(p.id, p.orderNumber, p.merchant, p.amount, p.currency, p.paidOn);
      for (const e of p.evidence) this.insertEvidence(p.id, e);
      for (const event of p.events) this.insertEvent(p.id, event);
    }
  }
  private insertEvidence(paymentId: string, e: Evidence) {
    this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?)").run(e.id, paymentId, e.orderNumber, e.amount, e.currency, e.cancelledOn, e.source, e.confirmedAt);
  }
  private insertEvent(paymentId: string, e: TimelineEvent) {
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(e.id, paymentId, e.kind, e.date, e.source, e.label);
  }
  list(): Payment[] {
    return this.transaction(() => (this.db.prepare("SELECT id FROM payments ORDER BY rowid").all() as { id: string }[]).map(p => this.get(p.id)!), "DEFERRED");
  }
  get(id: string): Payment | undefined {
    return this.transaction(() => this.readPayment(id), "DEFERRED");
  }
  private readPayment(id: string): Payment | undefined {
    const row = this.db.prepare("SELECT id, order_number AS orderNumber, merchant, amount, currency, paid_on AS paidOn FROM payments WHERE id=?").get(id);
    if (!row) return undefined;
    const evidence = this.db.prepare("SELECT id, order_number AS orderNumber, amount, currency, cancelled_on AS cancelledOn, source, confirmed_at AS confirmedAt FROM evidence WHERE payment_id=? ORDER BY rowid").all(id);
    const events = this.db.prepare("SELECT id, kind, date, source, label FROM events WHERE payment_id=? ORDER BY rowid").all(id);
    return { ...row, evidence: evidence.map(e => ({ ...e })), events: events.map(e => ({ ...e })) } as unknown as Payment;
  }
  connectEvidence(paymentId: string, raw: unknown, key?: string): { body: PaymentView; replayed: boolean } {
    if (key !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(key)) fail(400, "INVALID_IDEMPOTENCY_KEY", "요청 키는 영문·숫자·하이픈·밑줄 16~128자로 보내 주세요.");
    return this.transaction(() => {
      const payment = this.get(paymentId);
      if (!payment) fail(404, "NOT_FOUND", "결제 건을 찾을 수 없어요.");
      const b = raw as Partial<EvidenceFields> & { confirmed?: unknown } | null;
      const validDate = typeof b?.cancelledOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.cancelledOn)
        && !Number.isNaN(Date.parse(b.cancelledOn)) && new Date(b.cancelledOn).toISOString().slice(0, 10) === b.cancelledOn;
      if (b?.confirmed !== true || typeof b.orderNumber !== "string" || !b.orderNumber.trim()
        || !Number.isSafeInteger(b.amount) || b.amount! <= 0 || b.currency !== "KRW" || !validDate) {
        fail(400, "INVALID_INPUT", "주문번호·금액·통화·유효한 취소일과 고객 확인이 필요해요.");
      }
      const fields: EvidenceFields = { orderNumber: b.orderNumber.trim(), amount: b.amount!, currency: "KRW", cancelledOn: b.cancelledOn! };
      const fingerprint = hash(JSON.stringify({ paymentId, ...fields, confirmed: true }));
      const keyHash = key ? hash(key) : undefined;
      if (keyHash) {
        const previous = this.db.prepare("SELECT fingerprint, response_json FROM idempotency WHERE key_hash=?").get(keyHash);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "같은 요청 키에 다른 내용을 사용할 수 없어요.");
          return { body: JSON.parse(String(previous.response_json)) as PaymentView, replayed: true };
        }
      }
      if (fields.orderNumber !== payment.orderNumber || fields.amount !== payment.amount || fields.currency !== payment.currency || fields.cancelledOn < payment.paidOn) {
        fail(409, "PAYMENT_MISMATCH", "선택한 결제의 주문번호·전액 금액·통화·결제일을 확인해 주세요.");
      }
      if (payment.evidence.some(e => e.cancelledOn === fields.cancelledOn)) fail(409, "DUPLICATE_EVIDENCE", "같은 취소일의 증빙이 이미 연결되어 있어요.");
      const id = randomUUID();
      const now = new Date().toISOString();
      const evidence: Evidence = { ...fields, id, source: "customer_confirmed", confirmedAt: now };
      const event: TimelineEvent = { id, kind: "merchant_cancel", date: fields.cancelledOn, source: "고객 확인 취소 증빙", label: "가맹점 전액 취소 확인" };
      this.insertEvidence(paymentId, evidence);
      this.insertEvent(paymentId, event);
      this.db.prepare("INSERT INTO audit_log(action,payment_id,evidence_id,request_hash,occurred_at) VALUES('evidence_connected',?,?,?,?)").run(paymentId, id, fingerprint, now);
      const body = toPaymentView({ ...payment, evidence: [...payment.evidence, evidence], events: [...payment.events, event] });
      if (keyHash) this.db.prepare("INSERT INTO idempotency VALUES(?,?,?,?)").run(keyHash, fingerprint, JSON.stringify(body), now);
      return { body, replayed: false };
    });
  }
  reset() {
    this.transaction(() => {
      this.db.exec("DELETE FROM idempotency; DELETE FROM events; DELETE FROM evidence; DELETE FROM payments;");
      this.seed();
      this.db.prepare("INSERT INTO audit_log(action,occurred_at) VALUES('demo_reset',?)").run(new Date().toISOString());
    });
  }
}
