import { createApp } from "./app.js";
import { openPaymentStore } from "./payments/factory.js";
// .env가 있으면 읽는다(GEMINI_API_KEY 등). 파일이 없으면 무시하고, 이미 설정된 환경 변수는 덮어쓰지 않는다.
try { process.loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const repository = await openPaymentStore();
const server = createApp({ repository }).listen(port, host, () => console.log(`환불 추적 시연: http://localhost:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.close(async () => { await repository.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
