// DynamoDB로 전환할 때 SQLite의 고객 소유권을 옮긴다. 배포 스크립트(infra/install.sh)가 앱 시작 전에 실행한다.
// 고객 ID는 출력하지 않는다. 여러 번 실행해도 결과가 같다.
import { openPaymentStore } from "../src/server/payments/factory.js";
import { migrateOwnership } from "../src/server/payments/migrate.js";

if (process.env.PAYMENT_STORE !== "dynamodb") throw new Error("Set PAYMENT_STORE=dynamodb and PAYMENT_TABLE to migrate");
const store = await openPaymentStore();
try { console.log(JSON.stringify(await migrateOwnership(process.env.PAYMENT_DB_PATH ?? "data/payments.sqlite", store))); }
finally { await store.close(); }
