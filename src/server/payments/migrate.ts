import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { unassigned, type PaymentStore } from "./contract.js";

export interface OwnershipMigration { status: "migrated" | "nothing-to-migrate"; assigned: number; ownedAfter: number }

/**
 * SQLite에서 DynamoDB로 바꿀 때 고객 소유권만 옮긴다. 시연 데이터의 증빙·이벤트는 합성 시드와 같고,
 * 재전송 기록은 일시적이므로 옮기지 않는다. 여러 번 실행해도 결과가 같다.
 * 결제마다 소유자가 다르거나 일부만 배정된 경우는 자동으로 옮기지 않고 중단한다.
 */
export async function migrateOwnership(sqlitePath: string, target: PaymentStore): Promise<OwnershipMigration> {
  if (!existsSync(sqlitePath)) return { status: "nothing-to-migrate", assigned: 0, ownedAfter: 0 };
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  let rows: { id: string; owner: string }[];
  try { rows = db.prepare("SELECT id, owner_id AS owner FROM payments").all() as typeof rows; }
  finally { db.close(); }
  const owners = [...new Set(rows.map(r => r.owner))];
  if (owners.length === 1 && owners[0] === unassigned) return { status: "nothing-to-migrate", assigned: 0, ownedAfter: 0 };
  if (owners.length !== 1) throw new Error("SQLite payments have mixed owners; migrate ownership manually");
  const owner = owners[0];
  const assigned = await target.assignUnclaimed(owner);
  const ownedAfter = (await target.list(owner)).length;
  if (ownedAfter !== rows.length) throw new Error(`Ownership mismatch after migration: expected ${rows.length}, found ${ownedAfter}`);
  return { status: "migrated", assigned, ownedAfter };
}
