import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { Evidence, Payment, TimelineEvent } from "../../shared/types.js";
import { createPaymentStore } from "./store.js";
import { toPaymentView } from "../status/paymentStatus.js";
import { assertConnectable, assertOwnerSubject, assertValidKey, notFound, parseConfirmedEvidence, replayOrConflict, unassigned,
  type ConnectResult, type PaymentStore, type WriteContext } from "./contract.js";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type Item = Record<string, unknown>;

/*
 * 단일 테이블 설계 (PK·SK 모두 문자열, 온디맨드 과금)
 *   STATE        / STATE                      현재 시연 세대(generation). 초기화마다 1 증가
 *   PAYMENTS     / PAYMENT#<id>               결제 정보와 소유자(ownerId). 초기화해도 유지
 *   PAYMENT#<id> / G#<세대>#EVIDENCE#<취소일>   증빙. 키 자체로 같은 취소일 중복을 막는다
 *   PAYMENT#<id> / G#<세대>#EVENT#<순서>        타임라인 이벤트
 *   IDEMPOTENCY#<세대>#<키 해시> / IDEMPOTENCY  최초 응답. 초기화하면 새 세대에서 보이지 않는다
 *   AUDIT        / <시각>#<uuid>               감사 기록. 지우지 않는다
 * 증빙·이벤트·감사·멱등성 기록은 TransactWriteItems 한 번으로 함께 커밋된다.
 */
const stateKey = { PK: "STATE", SK: "STATE" };
const paymentKey = (id: string) => ({ PK: "PAYMENTS", SK: `PAYMENT#${id}` });
const generationPrefix = (generation: number) => `G#${generation}#`;
const idempotencyKey = (generation: number, keyHash: string) => ({ PK: `IDEMPOTENCY#${generation}#${keyHash}`, SK: "IDEMPOTENCY" });
const seedPosition = (index: number) => `0#${String(index).padStart(4, "0")}`;
const maxAttempts = 25;

export interface DynamoPaymentRepositoryOptions {
  tableName: string;
  client?: DynamoDBClient;
  clientConfig?: DynamoDBClientConfig;
  /** 테스트 전용: 커밋 직전 트랜잭션 항목을 바꿔 실패를 주입한다. */
  transformTransaction?: (items: TransactItem[]) => TransactItem[];
}

export class DynamoPaymentRepository implements PaymentStore {
  readonly tableName: string;
  readonly documentClient: DynamoDBDocumentClient;
  private readonly ownsClient: boolean;
  private readonly baseClient: DynamoDBClient;
  private readonly transformTransaction: (items: TransactItem[]) => TransactItem[];

  private constructor({ tableName, client, clientConfig, transformTransaction }: DynamoPaymentRepositoryOptions) {
    if (!tableName) throw new Error("PAYMENT_TABLE is required for the DynamoDB payment store");
    this.tableName = tableName;
    this.ownsClient = !client;
    this.baseClient = client ?? new DynamoDBClient({ maxAttempts: 3, ...clientConfig });
    this.documentClient = DynamoDBDocumentClient.from(this.baseClient, { marshallOptions: { removeUndefinedValues: true } });
    this.transformTransaction = transformTransaction ?? (items => items);
  }

  /** 테이블이 비어 있으면 합성 결제 3건을 1세대로 원자적으로 시드한다. 여러 프로세스가 동시에 열어도 한 번만 시드된다. */
  static async open(options: DynamoPaymentRepositoryOptions): Promise<DynamoPaymentRepository> {
    const repository = new DynamoPaymentRepository(options);
    await repository.seedIfEmpty();
    return repository;
  }

  close() { if (this.ownsClient) this.baseClient.destroy(); }

  private async seedIfEmpty() {
    if (await this.getItem(stateKey)) return;
    const items: TransactItem[] = [{ Put: { TableName: this.tableName, Item: { ...stateKey, generation: 1 }, ConditionExpression: "attribute_not_exists(PK)" } }];
    createPaymentStore().forEach((p, index) => {
      items.push({ Put: { TableName: this.tableName, ConditionExpression: "attribute_not_exists(PK)", Item: {
        ...paymentKey(p.id), id: p.id, orderNumber: p.orderNumber, merchant: p.merchant, amount: p.amount, currency: p.currency, paidOn: p.paidOn,
        ownerId: unassigned, position: index,
      } } });
    });
    items.push(...this.seedHistory(1));
    try { await this.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
    catch (error) {
      // 다른 프로세스가 먼저 시드했다면 정상이다.
      if (!(isCanceled(error) && await this.getItem(stateKey))) throw error;
    }
  }

  private seedHistory(generation: number): TransactItem[] {
    const items: TransactItem[] = [];
    for (const p of createPaymentStore()) {
      p.evidence.forEach((e, index) => items.push(this.put(this.evidenceItem(p.id, generation, e, seedPosition(index)))));
      p.events.forEach((e, index) => items.push(this.put(this.eventItem(p.id, generation, e, seedPosition(index)))));
    }
    return items;
  }

  private evidenceItem(paymentId: string, generation: number, e: Evidence, position: string): Item {
    return { PK: `PAYMENT#${paymentId}`, SK: `${generationPrefix(generation)}EVIDENCE#${e.cancelledOn}`, type: "evidence", position,
      id: e.id, orderNumber: e.orderNumber, amount: e.amount, currency: e.currency, cancelledOn: e.cancelledOn, source: e.source, confirmedAt: e.confirmedAt };
  }
  private eventItem(paymentId: string, generation: number, e: TimelineEvent, position: string): Item {
    return { PK: `PAYMENT#${paymentId}`, SK: `${generationPrefix(generation)}EVENT#${position}`, type: "event", position,
      id: e.id, kind: e.kind, date: e.date, source: e.source, label: e.label };
  }
  private auditItem(record: { action: string; occurredAt: string; actorId?: string; requestId?: string; paymentId?: string; evidenceId?: string; requestHash?: string }): Item {
    return { PK: "AUDIT", SK: `${record.occurredAt}#${randomUUID()}`, ...record };
  }
  private put(item: Item, condition?: string): TransactItem {
    return { Put: { TableName: this.tableName, Item: item, ...(condition ? { ConditionExpression: condition } : {}) } };
  }

  private async getItem(key: Item): Promise<Item | undefined> {
    return (await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }))).Item;
  }
  private async queryAll(input: { pk: string; skPrefix?: string }): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName, ConsistentRead: true, ExclusiveStartKey: start,
        KeyConditionExpression: input.skPrefix ? "PK = :pk AND begins_with(SK, :sk)" : "PK = :pk",
        ExpressionAttributeValues: { ":pk": input.pk, ...(input.skPrefix ? { ":sk": input.skPrefix } : {}) },
      }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }
  private async generation(): Promise<number> {
    const state = await this.getItem(stateKey);
    if (!state) throw new Error("Payment table is not initialized");
    return Number(state.generation);
  }

  private async readPayment(id: string, ownerId: string | undefined, generation: number): Promise<Payment | undefined> {
    const meta = await this.getItem(paymentKey(id));
    if (!meta || (ownerId !== undefined && meta.ownerId !== ownerId)) return undefined;
    const history = (await this.queryAll({ pk: `PAYMENT#${id}`, skPrefix: generationPrefix(generation) }))
      .sort((a, b) => String(a.position).localeCompare(String(b.position)));
    const evidence = history.filter(item => item.type === "evidence").map(item => ({
      id: item.id, orderNumber: item.orderNumber, amount: item.amount, currency: item.currency, cancelledOn: item.cancelledOn, source: item.source, confirmedAt: item.confirmedAt,
    }) as Evidence);
    const events = history.filter(item => item.type === "event").map(item => ({
      id: item.id, kind: item.kind, date: item.date, source: item.source, label: item.label,
    }) as TimelineEvent);
    return { id: String(meta.id), orderNumber: String(meta.orderNumber), merchant: String(meta.merchant), amount: Number(meta.amount),
      currency: "KRW", paidOn: String(meta.paidOn), evidence, events };
  }

  async list(ownerId?: string): Promise<Payment[]> {
    const generation = await this.generation();
    const metas = (await this.queryAll({ pk: "PAYMENTS" }))
      .filter(meta => ownerId === undefined || meta.ownerId === ownerId)
      .sort((a, b) => Number(a.position) - Number(b.position));
    const payments = await Promise.all(metas.map(meta => this.readPayment(String(meta.id), ownerId, generation)));
    return payments.filter((p): p is Payment => p !== undefined);
  }

  async get(id: string, ownerId?: string): Promise<Payment | undefined> {
    return this.readPayment(id, ownerId, await this.generation());
  }

  async connectEvidence(paymentId: string, raw: unknown, key?: string, context: WriteContext = { actorId: "system-test" }): Promise<ConnectResult> {
    assertValidKey(key);
    for (let attempt = 1; ; attempt++) {
      const generation = await this.generation();
      const payment = await this.readPayment(paymentId, context.ownerId, generation) ?? notFound();
      const { fields, fingerprint, keyHash } = parseConfirmedEvidence(paymentId, raw, key, context.actorId);
      if (keyHash) {
        const previous = await this.getItem(idempotencyKey(generation, keyHash));
        if (previous) return replayOrConflict({ fingerprint: String(previous.fingerprint), responseJson: String(previous.responseJson) }, fingerprint);
      }
      assertConnectable(payment, fields);
      const id = randomUUID();
      const now = new Date().toISOString();
      const evidence: Evidence = { ...fields, id, source: "customer_confirmed", confirmedAt: now };
      const event: TimelineEvent = { id, kind: "merchant_cancel", date: fields.cancelledOn, source: "고객 확인 취소 증빙", label: "가맹점 전액 취소 확인" };
      const body = toPaymentView({ ...payment, evidence: [...payment.evidence, evidence], events: [...payment.events, event] });
      const position = `1#${now}#${id}`;
      const items: TransactItem[] = [
        { ConditionCheck: { TableName: this.tableName, Key: stateKey, ConditionExpression: "generation = :g", ExpressionAttributeValues: { ":g": generation } } },
        { ConditionCheck: { TableName: this.tableName, Key: paymentKey(paymentId), ...(context.ownerId === undefined
          ? { ConditionExpression: "attribute_exists(PK)" }
          : { ConditionExpression: "ownerId = :o", ExpressionAttributeValues: { ":o": context.ownerId } }) } },
        this.put(this.evidenceItem(paymentId, generation, evidence, position), "attribute_not_exists(PK)"),
        this.put(this.eventItem(paymentId, generation, event, position), "attribute_not_exists(PK)"),
        this.put(this.auditItem({ action: "evidence_connected", paymentId, evidenceId: id, requestHash: fingerprint, occurredAt: now, actorId: context.actorId, requestId: context.requestId })),
        ...(keyHash ? [this.put({ ...idempotencyKey(generation, keyHash), fingerprint, responseJson: JSON.stringify(body), createdAt: now }, "attribute_not_exists(PK)")] : []),
      ];
      try {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: this.transformTransaction(items) }));
        return { body, replayed: false };
      } catch (error) {
        const reasons = cancellationCodes(error);
        if (!reasons) throw error;
        if (reasons[1] === "ConditionalCheckFailed") notFound();
        // 초기화·같은 키·같은 취소일 경쟁에서 졌거나 동시 트랜잭션 충돌이면, 최신 상태를 다시 읽어
        // 최초 응답 재현·중복 거절 중 맞는 결과를 돌려준다.
        const retryable = reasons[0] === "ConditionalCheckFailed" || reasons[2] === "ConditionalCheckFailed"
          || reasons[5] === "ConditionalCheckFailed" || reasons.includes("TransactionConflict");
        if (!retryable || attempt >= maxAttempts) throw error;
        await backoff(attempt);
      }
    }
  }

  async assignUnclaimed(ownerId: string): Promise<number> {
    assertOwnerSubject(ownerId);
    for (let attempt = 1; ; attempt++) {
      const targets = (await this.queryAll({ pk: "PAYMENTS" })).filter(meta => meta.ownerId === unassigned);
      if (targets.length === 0) return 0;
      const items: TransactItem[] = targets.map(meta => ({ Update: { TableName: this.tableName, Key: paymentKey(String(meta.id)),
        UpdateExpression: "SET ownerId = :o", ConditionExpression: "ownerId = :u", ExpressionAttributeValues: { ":o": ownerId, ":u": unassigned } } }));
      items.push(this.put(this.auditItem({ action: "ownership_assigned", actorId: "operator-cli", occurredAt: new Date().toISOString() })));
      try {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
        return targets.length;
      } catch (error) {
        // 다른 운영자가 먼저 배정했거나 동시 트랜잭션과 충돌했으면 최신 상태로 다시 시도한다.
        const reasons = cancellationCodes(error);
        if (!reasons || !reasons.some(code => code === "ConditionalCheckFailed" || code === "TransactionConflict") || attempt >= maxAttempts) throw error;
        await backoff(attempt);
      }
    }
  }

  async reset(context: WriteContext = { actorId: "system-test" }): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const generation = await this.generation();
      const next = generation + 1;
      const items: TransactItem[] = [
        { Update: { TableName: this.tableName, Key: stateKey, UpdateExpression: "SET generation = :n", ConditionExpression: "generation = :g",
          ExpressionAttributeValues: { ":n": next, ":g": generation } } },
        ...this.seedHistory(next),
        this.put(this.auditItem({ action: "demo_reset", occurredAt: new Date().toISOString(), actorId: context.actorId, requestId: context.requestId })),
      ];
      try {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: this.transformTransaction(items) }));
        return;
      } catch (error) {
        // 세대 번호 경쟁(동시 초기화)이나 트랜잭션 충돌만 재시도한다.
        const reasons = cancellationCodes(error);
        if (!reasons || !(reasons[0] === "ConditionalCheckFailed" || reasons.includes("TransactionConflict")) || attempt >= maxAttempts) throw error;
        await backoff(attempt);
      }
    }
  }
}

function isCanceled(error: unknown) {
  return error instanceof Error && error.name === "TransactionCanceledException";
}
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!isCanceled(error)) return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map(reason => reason.Code);
}
function backoff(attempt: number) {
  return sleep(Math.min(200, 5 * 2 ** Math.min(attempt, 6)) * Math.random());
}
