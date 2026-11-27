import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { PaymentStore } from "../src/server/payments/contract.js";
import { PaymentRepository } from "../src/server/payments/repository.js";
import { DynamoPaymentRepository } from "../src/server/payments/dynamoRepository.js";
import { migrateOwnership } from "../src/server/payments/migrate.js";

const customerA = "11111111-1111-4111-8111-111111111111";
const customerB = "22222222-2222-4222-8222-222222222222";
const endpoint = process.env.DYNAMODB_ENDPOINT;

async function source() {
  const directory = await mkdtemp(join(tmpdir(), "refund-migrate-"));
  const path = join(directory, "payments.sqlite");
  const sqlite = new PaymentRepository(path);
  return { path, sqlite, directory };
}

// 대상은 DynamoDB Local이 있으면 DynamoDB, 없으면 새 SQLite 저장소다. 두 경우 모두 같은 PaymentStore 계약을 쓴다.
async function target(t: TestContext, directory: string): Promise<PaymentStore> {
  if (!endpoint) {
    const store = new PaymentRepository(join(directory, "target.sqlite"));
    // 열린 SQLite 파일은 Windows에서 지울 수 없으므로 닫은 뒤 폴더를 지운다.
    t.after(async () => { store.close(); await rm(directory, { recursive: true }); });
    return store;
  }
  const config = { endpoint, region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } };
  const tableName = `migrate-${randomUUID()}`;
  const admin = new DynamoDBClient(config);
  await admin.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }, { AttributeName: "SK", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }] }));
  const store = await DynamoPaymentRepository.open({ tableName, clientConfig: config });
  t.after(async () => { store.close(); await admin.send(new DeleteTableCommand({ TableName: tableName })); admin.destroy(); await rm(directory, { recursive: true }); });
  return store;
}

test("한 고객에게 배정된 SQLite 소유권을 옮기고, 다시 실행해도 결과가 같다", async t => {
  const { path, sqlite, directory } = await source();
  await sqlite.assignUnclaimed(customerA); sqlite.close();
  const store = await target(t, directory);
  assert.deepEqual(await migrateOwnership(path, store), { status: "migrated", assigned: 3, ownedAfter: 3 });
  assert.deepEqual(await migrateOwnership(path, store), { status: "migrated", assigned: 0, ownedAfter: 3 });
  assert.equal((await store.list(customerB)).length, 0);
});

test("SQLite 파일이 없거나 미배정이면 아무것도 바꾸지 않는다", async t => {
  const { path, sqlite, directory } = await source();
  sqlite.close();
  const store = await target(t, directory);
  assert.equal((await migrateOwnership(join(directory, "missing.sqlite"), store)).status, "nothing-to-migrate");
  assert.equal((await migrateOwnership(path, store)).status, "nothing-to-migrate");
  assert.equal(await store.assignUnclaimed(customerB), 3);
});

test("결제마다 소유자가 다르면 자동 이관하지 않고 중단한다", async t => {
  const { path, sqlite, directory } = await source();
  await sqlite.assignUnclaimed(customerA); sqlite.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE payments SET owner_id=? WHERE id='PAY-003'").run(customerB); db.close();
  const store = await target(t, directory);
  await assert.rejects(migrateOwnership(path, store), /mixed owners/);
  assert.equal((await store.list(customerA)).length, 0);
});
