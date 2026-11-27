import { openPaymentStore } from "../src/server/payments/factory.js";
const subject = process.argv[2];
if (!subject || !/^[a-f0-9-]{36}$/i.test(subject)) throw new Error("Pass the verified Cognito customer sub (UUID). No access token is required.");
// PAYMENT_STORE·PAYMENT_DB_PATH·PAYMENT_TABLE은 앱과 같은 환경 변수를 사용한다.
const repository = await openPaymentStore();
try { console.log(JSON.stringify({ assigned: await repository.assignUnclaimed(subject) })); }
finally { await repository.close(); }
