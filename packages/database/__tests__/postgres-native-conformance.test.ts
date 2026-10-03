import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import { safeBatch } from "../src/batch-helper";
import {
  connectPostgres,
  createPostgresDatabase,
} from "../src/postgres-adapter";
import { customers, customerSessions } from "../src/schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server. The suite
// creates its own database with the fresh schema there and drops it after.
const serverUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

async function freshDatabaseUrl(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `scalius_native_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl!);
  url.pathname = `/${name}`;
  const schema = new Client({ connectionString: url.toString() });
  await schema.connect();
  await schema.query((await compileCanonicalPostgresSchema()).sql);
  await schema.end();
  return {
    url: url.toString(),
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

describe.runIf(serverUrl)("native PostgreSQL adapter conformance", () => {
  it("persists, revokes, expires, and rolls back customer sessions", async () => {
    const target = await freshDatabaseUrl();
    const db = createPostgresDatabase(target.url, {
      connect: connectPostgres,
    });
    const scope = randomUUID().replaceAll("-", "");
    const customerId = `customer_pg_${scope}`;
    const rollbackCustomerId = `customer_pg_rollback_${scope}`;
    const tokenHashes = [
      `active_${scope}`,
      `expired_${scope}`,
      `rollback_${scope}`,
    ];
    const nowSeconds = Math.floor(Date.now() / 1_000);

    try {
      await safeBatch(db, [
        db.insert(customers).values({
          id: customerId,
          name: "Native PostgreSQL Buyer",
          email: `${scope}@example.test`,
          phone: `+${scope.slice(0, 24)}`,
        }),
        db.insert(customerSessions).values({
          tokenHash: tokenHashes[0]!,
          customerId,
          expiresAt: nowSeconds + 3_600,
        }),
      ] as const);

      const [activeRows] = await safeBatch(db, [
        db.select({
          customerId: customerSessions.customerId,
          name: customers.name,
        })
          .from(customerSessions)
          .innerJoin(customers, eq(customerSessions.customerId, customers.id))
          .where(and(
            eq(customerSessions.tokenHash, tokenHashes[0]!),
            isNull(customerSessions.revokedAt),
            gt(customerSessions.expiresAt, nowSeconds),
          )),
      ] as const);
      expect(activeRows).toEqual([{
        customerId,
        name: "Native PostgreSQL Buyer",
      }]);

      await db.update(customerSessions)
        .set({ revokedAt: nowSeconds, updatedAt: nowSeconds })
        .where(eq(customerSessions.tokenHash, tokenHashes[0]!));
      await expect(db.select({ tokenHash: customerSessions.tokenHash })
        .from(customerSessions)
        .where(and(
          eq(customerSessions.tokenHash, tokenHashes[0]!),
          isNull(customerSessions.revokedAt),
          gt(customerSessions.expiresAt, nowSeconds),
        ))
        .get()).resolves.toBeUndefined();

      await db.insert(customerSessions).values({
        tokenHash: tokenHashes[1]!,
        customerId,
        expiresAt: nowSeconds - 1,
      });
      await expect(db.select({ tokenHash: customerSessions.tokenHash })
        .from(customerSessions)
        .where(and(
          eq(customerSessions.tokenHash, tokenHashes[1]!),
          isNull(customerSessions.revokedAt),
          gt(customerSessions.expiresAt, nowSeconds),
        ))
        .get()).resolves.toBeUndefined();

      await expect(safeBatch(db, [
        db.insert(customers).values({
          id: rollbackCustomerId,
          name: "Native PostgreSQL Rollback Buyer",
          // A different length from the first buyer's phone, so the two can
          // never collide (scope.slice(0, 23) + "9" did when char 24 was 9).
          phone: `+${scope.slice(0, 22)}rb`,
        }),
        db.insert(customerSessions).values({
          tokenHash: tokenHashes[2]!,
          customerId: `missing_${scope}`,
          expiresAt: nowSeconds + 3_600,
        }),
      ] as const)).rejects.toThrow(/foreign key/i);
      await expect(db.select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, rollbackCustomerId))
        .get()).resolves.toBeUndefined();
    } finally {
      await db.delete(customerSessions).where(inArray(
        customerSessions.tokenHash,
        tokenHashes,
      ));
      await db.delete(customers).where(inArray(
        customers.id,
        [customerId, rollbackCustomerId],
      ));
      await target.drop();
    }
  });
});
