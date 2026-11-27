import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, release } from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const label = process.argv[2] ?? "after";
if (!["before", "after"].includes(label)) throw new Error("Use before or after");
await mkdir(".qa", { recursive: true });
const work = await mkdtemp(resolve(".qa/reliability-"));
const dbPath = resolve(work, "payments.sqlite");
const baselineRevision = "544704609a76595b9cef262da0912cb72b9781ff";
let entryArgs = ["--import", "tsx", "src/server/index.ts"];
if (label === "after") {
  const appUrl = pathToFileURL(resolve("src/server/app.ts")).href;
  const repoUrl = pathToFileURL(resolve("src/server/payments/repository.ts")).href;
  const fixtureUrl = pathToFileURL(resolve("tests/fixtures/principal.ts")).href;
  entryArgs = ["--import", "tsx", "--input-type=module", "-e", `import {createApp} from ${JSON.stringify(appUrl)}; import {PaymentRepository} from ${JSON.stringify(repoUrl)}; import {testPrincipal} from ${JSON.stringify(fixtureUrl)}; const repository=new PaymentRepository(process.env.PAYMENT_DB_PATH); createApp({repository,principalResolver:testPrincipal}).listen(Number(process.env.PORT),'127.0.0.1');`];
}
if (label === "before") {
  // Keep the original HTTP handler reproducible without reverting the working tree.
  const original = execFileSync("git", ["show", `${baselineRevision}:src/server/app.ts`], { encoding: "utf8" });
  const relocated = original.replace(/from "(\.[^"]+)"/g, (_match, specifier: string) => `from "${pathToFileURL(resolve("src/server", specifier)).href}"`);
  const legacyPath = resolve(work, "legacy-app.ts");
  await writeFile(legacyPath, relocated);
  entryArgs = ["--import", "tsx", "--input-type=module", "-e", `import { createApp } from ${JSON.stringify(pathToFileURL(legacyPath).href)}; createApp().listen(Number(process.env.PORT), '127.0.0.1');`];
}
const reserve = createServer().listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = (reserve.address() as { port: number }).port;
await new Promise<void>(done => reserve.close(() => done()));
const base = `http://127.0.0.1:${port}`;
let child: ChildProcess | undefined;
let logs = "";
async function start() {
  logs = "";
  child = spawn(process.execPath, entryArgs, {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PAYMENT_DB_PATH: dbPath, AI_PROVIDER: "gemini", GEMINI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", data => { logs += data; });
  child.stderr?.on("data", data => { logs += data; });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Server startup timed out: " + logs);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
  child = undefined;
}
const payload = { orderNumber: "ORDER-001", amount: 50000, currency: "KRW", cancelledOn: "2026-11-19", confirmed: true };
async function post(body = payload) {
  const started = performance.now();
  const response = await fetch(base + "/api/payments/PAY-001/evidence", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "benchmark-operation-001" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), latencyMs: performance.now() - started };
}
try {
  await start();
  const first = await post();
  assert.equal(first.status, 201);
  const started = performance.now();
  const retries = await Promise.all(Array.from({ length: 100 }, () => post()));
  const elapsedMs = performance.now() - started;
  const beforeRestart = await fetch(base + "/api/payments/PAY-001").then(r => r.json());
  const changed = await post({ ...payload, cancelledOn: "2026-11-20" });
  await stop();
  await start();
  const afterRestart = await fetch(base + "/api/payments/PAY-001").then(r => r.json());
  const resumed = await post();
  const times = retries.map(r => r.latencyMs).sort((a, b) => a - b);
  const result = {
    label, measuredAt: new Date().toISOString(), baselineRevision,
    environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cpuCount: cpus().length },
    scenario: { synthetic: true, transport: "HTTP loopback", concurrency: 100, retryRequests: 100, processRestarts: 1 },
    metrics: {
      retrySuccesses: retries.filter(r => r.status === 201).length,
      identicalReplays: retries.filter(r => r.status === 201 && JSON.stringify(r.body) === JSON.stringify(first.body)).length,
      evidenceAfterRetries: beforeRestart.evidence.length,
      modifiedPayloadStatus: changed.status,
      originalEvidenceSurvivedRestart: afterRestart.evidence.some((e: { id: string }) => e.id === first.body.evidence[0].id),
      identicalReplayAfterRestart: resumed.status === 201 && JSON.stringify(resumed.body) === JSON.stringify(first.body),
      retryElapsedMs: Number(elapsedMs.toFixed(2)),
      retryP50Ms: Number(times[49].toFixed(2)), retryP95Ms: Number(times[94].toFixed(2)),
    },
  };
  if (label === "after") {
    assert.equal(result.metrics.identicalReplays, 100);
    assert.equal(result.metrics.evidenceAfterRetries, 1);
    assert.equal(result.metrics.modifiedPayloadStatus, 409);
    assert.equal(result.metrics.originalEvidenceSurvivedRestart, true);
    assert.equal(result.metrics.identicalReplayAfterRestart, true);
  }
  await mkdir("docs/measurements", { recursive: true });
  const output = `docs/measurements/reliability-${label}.json`;
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await stop(); }
