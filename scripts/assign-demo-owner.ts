import { PaymentRepository } from "../src/server/payments/repository.js";
const subject = process.argv[2];
if (!subject || !/^[a-f0-9-]{36}$/i.test(subject)) throw new Error("Pass the verified Cognito customer sub (UUID). No access token is required.");
const repository = new PaymentRepository(process.env.PAYMENT_DB_PATH ?? "data/payments.sqlite");
try { console.log(JSON.stringify({ assigned: repository.assignUnclaimed(subject) })); }
finally { repository.close(); }
