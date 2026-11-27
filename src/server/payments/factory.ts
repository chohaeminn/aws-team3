import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PaymentStore } from "./contract.js";
import { PaymentRepository } from "./repository.js";
import { DynamoPaymentRepository } from "./dynamoRepository.js";

/**
 * PAYMENT_STORE=sqlite(기본)  → PAYMENT_DB_PATH (기본 data/payments.sqlite)
 * PAYMENT_STORE=dynamodb      → PAYMENT_TABLE, AWS_REGION. DYNAMODB_ENDPOINT는 로컬 에뮬레이터용
 * AWS 자격 증명은 SDK 기본 인증 체인(EC2 역할·로컬 프로필)을 사용하며 코드에 저장하지 않는다.
 */
export async function openPaymentStore(env: NodeJS.ProcessEnv = process.env): Promise<PaymentStore> {
  const kind = env.PAYMENT_STORE?.trim() || "sqlite";
  if (kind === "dynamodb") {
    return DynamoPaymentRepository.open({
      tableName: env.PAYMENT_TABLE?.trim() ?? "",
      clientConfig: { region: env.AWS_REGION, ...(env.DYNAMODB_ENDPOINT ? { endpoint: env.DYNAMODB_ENDPOINT } : {}) },
    });
  }
  if (kind !== "sqlite") throw new Error(`Unknown PAYMENT_STORE: ${kind}`);
  const path = env.PAYMENT_DB_PATH ?? "data/payments.sqlite";
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return new PaymentRepository(path);
}
