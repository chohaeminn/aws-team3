import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/server/app.js";
import { createPrincipalResolver, adminGroup } from "../src/server/auth/principal.js";
import { PaymentRepository } from "../src/server/payments/repository.js";
import { signedToken, verifiedPrincipal, customerA, customerB } from "./fixtures/cognito.js";

const evidence = { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19", confirmed: true };
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "refund-access-"));
  const path = join(dir, "payments.sqlite");
  const repository = new PaymentRepository(path);
  repository.assignUnclaimed(customerA);
  const db = new DatabaseSync(path);
  db.prepare("UPDATE payments SET owner_id=? WHERE id='PAY-003'").run(customerB);
  const logs: Record<string, unknown>[] = [];
  const server = createApp({ repository, principalResolver: verifiedPrincipal, requestLogger: r => logs.push(r),
    evidenceAnalyzer: async () => ({ fields: {}, candidatePaymentIds: ["PAY-001", "PAY-003"], provider: "bedrock" }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise<void>(done => server.close(() => done())); repository.close(); db.close(); await rm(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, token?: string, body?: unknown, extraHeaders: Record<string, string> = {}) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { repository, db, logs, call };
}

test("JWT 실제 서명 검증은 만료·다른 발급자·다른 클라이언트·ID 토큰·변조를 거부한다", async () => {
  const good = signedToken();
  assert.deepEqual(await verifiedPrincipal(`Bearer ${good}`), { id: customerA, role: "customer" });
  for (const claims of [{ exp: 1 }, { iss: "https://wrong.example.com" }, { client_id: "another-client" }, { token_use: "id", aud: "fixtureclient123456" }]) {
    assert.equal(await verifiedPrincipal(`Bearer ${signedToken(claims)}`), undefined);
  }
  const [header, payload, signature] = good.split(".");
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: customerB })).toString("base64url");
  assert.equal(await verifiedPrincipal(`Bearer ${header}.${altered}.${signature}`), undefined);
  assert.equal(await verifiedPrincipal("Bearer not-a-token"), undefined);
  assert.equal(await createPrincipalResolver({})(`Bearer ${good}`), undefined);
});

test("미인증은 모든 업무 API에서 거부하고 고객은 자기 거래만 조회한다", async t => {
  const { call } = await fixture(t);
  for (const [path, body] of [["/api/payments", undefined], ["/api/payments/PAY-001", undefined], ["/api/payments/PAY-001/evidence", evidence], ["/api/evidence/analyze", { text: "synthetic" }], ["/api/demo/reset", {}]] as const) {
    assert.equal((await call(path, undefined, body)).status, 401);
  }
  const token = signedToken();
  assert.deepEqual((await call("/api/payments", token).then(r => r.json())).map((p: { id: string }) => p.id), ["PAY-001", "PAY-002"]);
  assert.equal((await call("/api/payments/PAY-003", token)).status, 404);
  assert.equal((await call("/api/payments/UNKNOWN", token)).status, 404);
  const analysis = await call("/api/evidence/analyze", token, { text: "synthetic" }).then(r => r.json());
  assert.deepEqual(analysis.candidatePaymentIds, ["PAY-001"]);
});

test("타인 거래 조회·쓰기와 고객 초기화 시도 총 100회에서 데이터가 보존된다", async t => {
  const { call, repository } = await fixture(t);
  const before = repository.list();
  const token = signedToken();
  const attempts = await Promise.all(Array.from({ length: 100 }, (_, i) => i % 3 === 0
    ? call("/api/payments/PAY-003", token)
    : i % 3 === 1 ? call("/api/payments/PAY-003/evidence", token, { ...evidence, orderNumber: "ORDER-003", amount: 18000, ownerId: customerA, role: "admin" })
      : call("/api/demo/reset", token, {})));
  assert.equal(attempts.filter(r => r.status === 404 || r.status === 403).length, 100);
  assert.deepEqual(repository.list(), before);
});

test("같은 멱등성 키를 다른 고객이 사용해도 응답이 섞이지 않고 감사 주체를 남긴다", async t => {
  const { call, db, logs } = await fixture(t);
  const headers = { "Idempotency-Key": "same-key-different-customers", "X-Request-Id": "untrusted-client-value" };
  const first = await call("/api/payments/PAY-001/evidence", signedToken(), evidence, headers);
  assert.equal(first.status, 201);
  const requestId = first.headers.get("X-Request-Id");
  assert.notEqual(requestId, "untrusted-client-value");
  const second = await call("/api/payments/PAY-003/evidence", signedToken({ sub: customerB }), { ...evidence, orderNumber: "ORDER-003", amount: 18000 }, headers);
  assert.equal(second.status, 201);
  const audit = db.prepare("SELECT actor_id,request_id FROM audit_log WHERE payment_id='PAY-001' AND action='evidence_connected'").get();
  assert.equal(audit!.actor_id, customerA); assert.equal(audit!.request_id, requestId);
  assert.ok(logs.every(record => !JSON.stringify(record).includes("ORDER-001") && !JSON.stringify(record).includes("Bearer")));
});

test("관리자만 초기화·운영 지표에 접근하고 초기화 후 소유권은 보존된다", async t => {
  const { call, repository } = await fixture(t);
  assert.equal((await call("/api/admin/metrics", signedToken())).status, 403);
  const admin = signedToken({ "cognito:groups": [adminGroup] });
  assert.equal((await call("/api/demo/reset", admin, {})).status, 200);
  assert.equal(repository.list(customerA).length, 2); assert.equal(repository.list(customerB).length, 1);
  assert.equal((await call("/api/admin/metrics", admin)).status, 200);
});
