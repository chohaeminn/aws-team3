import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { createApp } from "../src/server/app.js";
import { PaymentRepository } from "../src/server/payments/repository.js";
import { signedToken, verifiedPrincipal, customerA, customerB } from "../tests/fixtures/cognito.js";

const mode = process.argv[2] ?? "after";
if (!["before", "after"].includes(mode)) throw new Error("Use before or after");
await mkdir(".qa", { recursive: true });
const work = await mkdtemp(resolve(".qa/access-"));
const path = resolve(work, "payments.sqlite");
const repository = new PaymentRepository(path);
repository.assignUnclaimed(customerA);
const db = new DatabaseSync(path);
db.prepare("UPDATE payments SET owner_id=? WHERE id='PAY-003'").run(customerB);
db.close();
const baselineRevision = "25ccbb3fdb8a722108fda155b02482e8641a9504";
let appFactory = createApp;
if (mode === "before") {
  const source = execFileSync("git", ["show", `${baselineRevision}:src/server/app.ts`], { encoding: "utf8" });
  const relocated = source.replace(/from "(\.[^"]+)"/g, (_match, specifier: string) => `from "${pathToFileURL(resolve("src/server", specifier)).href}"`);
  const legacyPath = resolve(work, "legacy.ts");
  await writeFile(legacyPath, relocated);
  appFactory = (await import(pathToFileURL(legacyPath).href)).createApp;
}
const server = appFactory({ repository, principalResolver: verifiedPrincipal }).listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  const token = signedToken();
  const cases = [
    { name: "unauthenticated-list", path: "/api/payments", expected: 401, authenticated: false },
    { name: "other-customer-read", path: "/api/payments/PAY-003", expected: 404, authenticated: true },
    { name: "other-customer-write", path: "/api/payments/PAY-003/evidence", expected: 404, authenticated: true,
      body: { orderNumber: "ORDER-003", amount: 18000, currency: "KRW", cancelledOn: "2026-11-19", confirmed: true } },
    { name: "customer-admin-reset", path: "/api/demo/reset", expected: 403, authenticated: true, body: {} },
  ];
  const measured = [];
  for (const scenario of cases) {
    const responses = await Promise.all(Array.from({ length: 25 }, () => fetch(base + scenario.path, {
      method: scenario.body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(scenario.authenticated ? { Authorization: `Bearer ${token}` } : {}) },
      ...(scenario.body ? { body: JSON.stringify(scenario.body) } : {}),
    })));
    measured.push({ name: scenario.name, attempts: 25, denied: responses.filter(r => r.status === scenario.expected).length, expectedStatus: scenario.expected });
    await Promise.all(responses.map(r => r.arrayBuffer()));
  }
  const denied = measured.reduce((sum, result) => sum + result.denied, 0);
  if (mode === "after") assert.equal(denied, 100);
  const result = { mode, measuredAt: new Date().toISOString(), node: process.version, baselineRevision,
    authentication: "RS256 signatures verified against synthetic local JWKS; no live Cognito request", synthetic: true, transport: "HTTP loopback",
    cases: measured, totals: { attempts: 100, denied, deniedPercent: denied } };
  await mkdir("docs/measurements", { recursive: true });
  await writeFile(`docs/measurements/access-${mode}.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await new Promise<void>(done => server.close(() => done()));
  repository.close();
}
