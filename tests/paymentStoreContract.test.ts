import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PaymentError, type PaymentStore } from "../src/server/payments/contract.js";
import { PaymentRepository } from "../src/server/payments/repository.js";
import { DynamoPaymentRepository, type DynamoPaymentRepositoryOptions } from "../src/server/payments/dynamoRepository.js";
import { createApp } from "../src/server/app.js";
import { testPrincipal } from "./fixtures/principal.js";
import { once } from "node:events";

// 같은 계약을 SQLite와 DynamoDB 저장소에 똑같이 적용한다.
// DynamoDB는 DYNAMODB_ENDPOINT(로컬 에뮬레이터)가 있을 때만 실행한다: npm run test:dynamodb
const customerA = "11111111-1111-4111-8111-111111111111";
const customerB = "22222222-2222-4222-8222-222222222222";
const body = { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19", confirmed: true };
const key = "contract-operation-0001";
const code = (expected: string) => (error: unknown) => error instanceof PaymentError && error.code === expected;

interface Harness {
  /** 같은 저장 공간을 여는 새 인스턴스(프로세스 재시작에 해당). */
  open(options?: Pick<DynamoPaymentRepositoryOptions, "transformTransaction">): Promise<PaymentStore>;
  auditActions(): Promise<string[]>;
}
type HarnessFactory = (t: TestContext) => Promise<Harness>;

const sqlite: HarnessFactory = async t => {
  const directory = await mkdtemp(join(tmpdir(), "refund-contract-"));
  const path = join(directory, "payments.sqlite");
  const opened: PaymentStore[] = [];
  const db = () => new DatabaseSync(path);
  t.after(async () => { for (const store of opened) await store.close(); await rm(directory, { recursive: true }); });
  return {
    async open() { const store = new PaymentRepository(path); opened.push(store); return store; },
    async auditActions() {
      const handle = db();
      try { return (handle.prepare("SELECT action FROM audit_log ORDER BY sequence").all() as { action: string }[]).map(r => r.action); }
      finally { handle.close(); }
    },
  };
};

const endpoint = process.env.DYNAMODB_ENDPOINT;
const localConfig = { endpoint, region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } };
const dynamodb: HarnessFactory = async t => {
  const tableName = `payments-${randomUUID()}`;
  const admin = new DynamoDBClient(localConfig);
  await admin.send(new CreateTableCommand({
    TableName: tableName, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }, { AttributeName: "SK", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
  }));
  const opened: PaymentStore[] = [];
  let reader: DynamoPaymentRepository | undefined;
  t.after(async () => { for (const store of opened) await store.close(); await admin.send(new DeleteTableCommand({ TableName: tableName })); admin.destroy(); });
  const harness: Harness = {
    async open(options = {}) { const store = await DynamoPaymentRepository.open({ tableName, clientConfig: localConfig, ...options }); opened.push(store); return store; },
    async auditActions() {
      reader ??= await harness.open() as DynamoPaymentRepository;
      const page = await reader.documentClient.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "AUDIT" }, ConsistentRead: true }));
      return (page.Items ?? []).map(item => String(item.action));
    },
  };
  return harness;
};

const stores: [string, HarnessFactory, boolean][] = [["SQLite", sqlite, true], ["DynamoDB", dynamodb, Boolean(endpoint)]];

for (const [name, factory, enabled] of stores) {
  const skip = enabled ? false : "DYNAMODB_ENDPOINT 없음 — npm run test:dynamodb 로 실행";

  test(`[${name}] 합성 결제 3건을 한 번만 시드하고 소유자별로 조회한다`, { skip }, async t => {
    const harness = await factory(t);
    const [first, second] = await Promise.all([harness.open(), harness.open()]);
    assert.deepEqual((await first.list()).map(p => p.id), ["PAY-001", "PAY-002", "PAY-003"]);
    assert.deepEqual((await second.get("PAY-003"))!.events.map(e => e.id), ["EV-005", "EV-007"]);
    assert.equal(await first.assignUnclaimed(customerA), 3);
    assert.equal(await second.assignUnclaimed(customerB), 0);
    assert.equal((await second.list(customerA)).length, 3);
    assert.equal((await second.list(customerB)).length, 0);
    assert.equal(await second.get("PAY-001", customerB), undefined);
    await assert.rejects(second.assignUnclaimed("unassigned"), /verified customer subject/);
  });

  test(`[${name}] 네 인스턴스에서 같은 키로 100회 동시 요청해도 한 번만 저장하고 최초 응답을 재현한다`, { skip }, async t => {
    const harness = await factory(t);
    const instances = await Promise.all(Array.from({ length: 4 }, () => harness.open()));
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => instances[i % 4].connectEvidence("PAY-001", body, key)));
    assert.equal(results.filter(r => !r.replayed).length, 1);
    for (const r of results) assert.deepEqual(r.body, results[0].body);
    const restarted = await harness.open();
    const replay = await restarted.connectEvidence("PAY-001", body, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, results[0].body);
    const payment = (await restarted.get("PAY-001"))!;
    assert.equal(payment.evidence.length, 1);
    assert.deepEqual(payment.events.map(e => e.kind), ["payment", "merchant_cancel"]);
    assert.deepEqual(await harness.auditActions(), ["evidence_connected"]);
  });

  test(`[${name}] 다른 키로 같은 취소일을 동시에 보내면 하나만 저장하고 나머지는 중복으로 거절한다`, { skip }, async t => {
    const harness = await factory(t);
    const store = await harness.open();
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => store.connectEvidence("PAY-001", body, `contract-distinct-${String(i).padStart(4, "0")}`)));
    assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
    for (const o of outcomes) if (o.status === "rejected") assert.ok(code("DUPLICATE_EVIDENCE")(o.reason), String(o.reason));
    assert.equal((await store.get("PAY-001"))!.evidence.length, 1);
    assert.deepEqual(await harness.auditActions(), ["evidence_connected"]);
  });

  test(`[${name}] 입력·키·내용 충돌·결제 불일치·소유권 오류를 구분하고 아무것도 저장하지 않는다`, { skip }, async t => {
    const harness = await factory(t);
    const store = await harness.open();
    await store.assignUnclaimed(customerA);
    await assert.rejects(store.connectEvidence("PAY-001", body, "short"), code("INVALID_IDEMPOTENCY_KEY"));
    await assert.rejects(store.connectEvidence("PAY-001", { ...body, confirmed: false }), code("INVALID_INPUT"));
    await assert.rejects(store.connectEvidence("PAY-001", { ...body, amount: 49000 }), code("PAYMENT_MISMATCH"));
    await assert.rejects(store.connectEvidence("PAY-001", body, key, { actorId: customerB, ownerId: customerB }), code("NOT_FOUND"));
    await assert.rejects(store.connectEvidence("UNKNOWN", body), code("NOT_FOUND"));
    assert.deepEqual(await harness.auditActions(), ["ownership_assigned"]);
    await store.connectEvidence("PAY-001", body, key, { actorId: customerA, ownerId: customerA });
    await assert.rejects(store.connectEvidence("PAY-001", { ...body, cancelledOn: "2026-11-20" }, key, { actorId: customerA, ownerId: customerA }), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(store.connectEvidence("PAY-001", body), code("DUPLICATE_EVIDENCE"));
    // 같은 키라도 다른 주체의 요청은 섞이지 않는다.
    await assert.rejects(store.connectEvidence("PAY-001", body, key, { actorId: "admin-subject" }), code("DUPLICATE_EVIDENCE"));
  });

  test(`[${name}] HTTP API가 저장소와 무관하게 같은 응답 계약을 지킨다`, { skip }, async t => {
    const harness = await factory(t);
    const repository = await harness.open();
    const server = createApp({ repository, principalResolver: testPrincipal }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(done => server.close(() => done())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (k: string, value: unknown = body) => fetch(base + "/api/payments/PAY-001/evidence", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": k }, body: JSON.stringify(value) });
    assert.deepEqual((await fetch(base + "/api/payments").then(r => r.json())).map((p: { id: string }) => p.id), ["PAY-001", "PAY-002", "PAY-003"]);
    const first = await post(key);
    assert.equal(first.status, 201); assert.equal(first.headers.get("Idempotency-Replayed"), "false");
    const firstBody = await first.json();
    assert.equal(firstBody.status.merchant, "confirmed");
    const replay = await post(key);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(await replay.json(), firstBody);
    assert.equal((await post(key, { ...body, cancelledOn: "2026-11-20" })).status, 409);
    assert.equal((await fetch(base + "/api/payments/UNKNOWN")).status, 404);
    assert.equal((await fetch(base + "/api/demo/reset", { method: "POST" })).status, 200);
    assert.equal((await fetch(base + "/api/payments/PAY-001").then(r => r.json())).evidence.length, 0);
  });

  test(`[${name}] 초기화하면 증빙·재전송 기록을 비우고 소유권과 감사 기록은 보존한다`, { skip }, async t => {
    const harness = await factory(t);
    const store = await harness.open();
    await store.assignUnclaimed(customerA);
    await store.connectEvidence("PAY-001", body, key);
    await store.reset({ actorId: "admin-subject", requestId: "request-1" });
    const after = (await store.get("PAY-001"))!;
    assert.equal(after.evidence.length, 0);
    assert.deepEqual(after.events.map(e => e.id), ["EV-001"]);
    assert.deepEqual((await store.get("PAY-002"))!.evidence.map(e => e.id), ["EVID-SEED-002"]);
    assert.equal((await store.list(customerA)).length, 3);
    assert.equal((await store.connectEvidence("PAY-001", body, key)).replayed, false);
    // DynamoDB 감사 기록은 시각순 키라서 같은 밀리초 안의 순서는 보장하지 않는다. 건수와 종류를 비교한다.
    assert.deepEqual((await harness.auditActions()).sort(), ["demo_reset", "evidence_connected", "evidence_connected", "ownership_assigned"]);
  });
}

test("[DynamoDB] 트랜잭션의 한 항목이 실패하면 증빙·이벤트·감사·재전송 기록이 모두 롤백된다", { skip: endpoint ? false : "DYNAMODB_ENDPOINT 없음" }, async t => {
  const harness = await dynamodb(t);
  const healthy = await harness.open();
  const before = await healthy.list();
  // 존재하지 않는 항목을 요구하는 조건을 끼워 넣어 실제 DynamoDB가 트랜잭션 전체를 취소하게 한다.
  const failing = await harness.open({ transformTransaction: items => [...items, { ConditionCheck: {
    TableName: (healthy as DynamoPaymentRepository).tableName, Key: { PK: "FAULT", SK: "INJECTED" }, ConditionExpression: "attribute_exists(PK)",
  } }] });
  await assert.rejects(failing.connectEvidence("PAY-001", body, key), (error: Error) => error.name === "TransactionCanceledException");
  await assert.rejects(failing.reset(), (error: Error) => error.name === "TransactionCanceledException");
  assert.deepEqual(await healthy.list(), before);
  assert.deepEqual(await harness.auditActions(), []);
  assert.equal((await healthy.connectEvidence("PAY-001", body, key)).replayed, false);
});
