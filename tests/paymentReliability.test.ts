import { testPrincipal } from "./fixtures/principal.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PaymentError, PaymentRepository } from "../src/server/payments/repository.js";
import { createApp } from "../src/server/app.js";

const body = { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19", confirmed: true };
const key = "reliability-operation-001";
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "refund-reliability-"));
  const path = join(directory, "test.sqlite");
  const repository = new PaymentRepository(path);
  const db = new DatabaseSync(path);
  t.after(async () => { repository.close(); db.close(); await rm(directory, { recursive: true }); });
  return { path, repository, db };
}
const count = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);

test("동일 키 재전송과 DB 재연결 후에도 최초 응답과 감사 기록 하나를 유지한다", async t => {
  const { repository, path, db } = await fixture(t);
  const first = await repository.connectEvidence("PAY-001", body, key);
  for (let i = 0; i < 100; i++) {
    const replay = await repository.connectEvidence("PAY-001", body, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
  }
  const reopened = new PaymentRepository(path);
  try { assert.deepEqual((await reopened.connectEvidence("PAY-001", body, key)).body, first.body); }
  finally { reopened.close(); }
  assert.equal((await repository.get("PAY-001"))!.evidence.length, 1);
  assert.equal(count(db, "idempotency"), 1);
  assert.equal(count(db, "audit_log"), 1);
});

test("같은 키의 다른 날짜·다른 거래는 409이고 키 없는 기존 중복 계약도 유지한다", async t => {
  const { repository, db } = await fixture(t);
  await repository.connectEvidence("PAY-001", body, key);
  for (const [id, changed] of [["PAY-001", { ...body, cancelledOn: "2026-11-20" }], ["PAY-003", { ...body, orderNumber: "ORDER-003", amount: 18000 }]] as const) {
    await assert.rejects(repository.connectEvidence(id, changed, key), error => error instanceof PaymentError && error.code === "IDEMPOTENCY_CONFLICT");
  }
  await assert.rejects(repository.connectEvidence("PAY-001", body), error => error instanceof PaymentError && error.code === "DUPLICATE_EVIDENCE");
  assert.equal(count(db, "audit_log"), 1);
});

for (const table of ["events", "audit_log", "idempotency"]) {
  test(`${table} 쓰기 실패를 주입하면 증빙·이벤트·감사·멱등성 기록이 모두 롤백된다`, async t => {
    const { repository, db } = await fixture(t);
    const before = await repository.list();
    db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    await assert.rejects(repository.connectEvidence("PAY-001", body, key), /injected failure/);
    assert.deepEqual(await repository.list(), before);
    assert.equal(count(db, "audit_log"), 0);
    assert.equal(count(db, "idempotency"), 0);
    db.exec("DROP TRIGGER fail_write");
    assert.equal((await repository.connectEvidence("PAY-001", body, key)).replayed, false);
  });
}

test("4개 독립 프로세스에서 같은 파일에 100회 요청해도 한 번만 저장한다", async t => {
  const { repository, path, db } = await fixture(t);
  const moduleUrl = pathToFileURL(resolve("src/server/payments/repository.ts")).href;
  const code = `import { PaymentRepository } from ${JSON.stringify(moduleUrl)};
    const r = new PaymentRepository(process.argv[1]);
    const results = []; for (let i = 0; i < 25; i++) results.push(await r.connectEvidence('PAY-001', ${JSON.stringify(body)}, '${key}'));
    r.close(); console.log(JSON.stringify(results));`;
  const batches = await Promise.all(Array.from({ length: 4 }, () => new Promise<{ replayed: boolean; body: unknown }[]>((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", reject);
    child.on("close", status => {
      if (status !== 0) { reject(new Error(errors)); return; }
      try { done(JSON.parse(output)); } catch (error) { reject(error); }
    });
  })));
  const results = batches.flat();
  assert.equal(results.length, 100);
  assert.equal(results.filter(r => !r.replayed).length, 1);
  for (const r of results) assert.deepEqual(r.body, results[0].body);
  assert.equal((await repository.get("PAY-001"))!.evidence.length, 1);
  assert.equal(count(db, "audit_log"), 1);
});

test("HTTP는 재전송 표시·잘못된 키·내용 충돌을 구분한다", async t => {
  const { repository } = await fixture(t);
  const server = createApp({ repository, principalResolver: testPrincipal }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (k: string, value = body) => fetch(base + "/api/payments/PAY-001/evidence", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": k }, body: JSON.stringify(value) });
  assert.equal((await post("invalid")).status, 400);
  const first = await post(key); assert.equal(first.status, 201); assert.equal(first.headers.get("Idempotency-Replayed"), "false");
  const replay = await post(key); assert.equal(replay.status, 201); assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await replay.json(), await first.json());
  const conflict = await post(key, { ...body, cancelledOn: "2026-11-20" });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
});

test("시연 초기화는 증빙과 멱등성 캐시를 비우고 초기화 감사 기록을 남긴다", async t => {
  const { repository, db } = await fixture(t);
  await repository.connectEvidence("PAY-001", body, key);
  await repository.reset();
  assert.equal((await repository.get("PAY-001"))!.evidence.length, 0);
  assert.equal(count(db, "idempotency"), 0);
  assert.equal(count(db, "audit_log"), 2);
  assert.equal((await repository.connectEvidence("PAY-001", body, key)).replayed, false);
});
