// DynamoDB Local(인메모리)을 띄워 저장소 계약 테스트를 실행하고 종료한다. AWS 계정·비용과 무관하다.
// 준비: AWS 공식 배포본을 .dynamodb-local/ 에 압축 해제 (docs/DYNAMODB.md 참고), Java 17 이상
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = resolve(".dynamodb-local");
if (!existsSync(resolve(home, "DynamoDBLocal.jar"))) {
  console.error("DynamoDB Local이 없습니다. docs/DYNAMODB.md의 로컬 준비 절차를 따라 .dynamodb-local/ 에 압축을 풀어 주세요.");
  process.exit(1);
}
const port = await new Promise<number>((done, reject) => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
  probe.on("error", reject);
});
const ddb = spawn("java", [`-Djava.library.path=${resolve(home, "DynamoDBLocal_lib")}`, "-jar", resolve(home, "DynamoDBLocal.jar"), "-inMemory", "-disableTelemetry", "-port", String(port)], { stdio: ["ignore", "ignore", "inherit"] });
const stop = () => { if (ddb.exitCode === null) ddb.kill(); };
process.on("exit", stop);
for (let i = 0; ; i++) {
  const ready = await new Promise<boolean>(done => { const socket = connect(port, "127.0.0.1", () => { socket.end(); done(true); }); socket.on("error", () => done(false)); });
  if (ready) break;
  if (i > 100 || ddb.exitCode !== null) { console.error("DynamoDB Local을 시작하지 못했습니다."); process.exit(1); }
  await sleep(100);
}
const files = process.argv.slice(2);
const runner = spawn(process.execPath, ["--import", "tsx", "--test", ...(files.length ? files : ["tests/paymentStoreContract.test.ts"])], {
  stdio: "inherit", env: { ...process.env, DYNAMODB_ENDPOINT: `http://127.0.0.1:${port}` },
});
runner.on("close", status => { stop(); process.exit(status ?? 1); });
