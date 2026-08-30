import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { adminOrderCreateAttempts } from "@scalius/database/schema";
import * as schema from "@scalius/database/schema";
import type { CreateOrderInput } from "./orders.validation";
import {
  ADMIN_ORDER_CREATE_REQUEST_MISMATCH,
  buildAdminOrderCreateAttemptCommit,
  buildAdminOrderCreateAttemptGuard,
  buildAdminOrderCreateAttemptIdentity,
  claimAdminOrderCreateAttempt,
  resolveAdminOrderCreateAttempt,
} from "./admin-order-create-attempts";

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function statementRows(statement: StatementSync, values: SQLInputValue[]) {
  return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: statementRows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...nextValues) => d1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = statementRows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createDatabase(): { sqlite: DatabaseSync; db: Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE admin_order_create_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      actor_id TEXT,
      request_key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      response_payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_id TEXT,
      claim_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX admin_order_create_attempts_key_unique
      ON admin_order_create_attempts(request_key_hash);
    CREATE UNIQUE INDEX admin_order_create_attempts_order_unique
      ON admin_order_create_attempts(order_id);
  `);
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    sqlite,
    db: drizzle(binding as unknown as D1Database, { schema }) as unknown as Database,
  };
}

function buildInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    requestKey: crypto.randomUUID(),
    customerName: "Test Customer",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "123 Test Street, Dhaka",
    city: "city_dhaka",
    zone: "zone_gulshan",
    area: null,
    notes: null,
    items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }],
    discountAmount: null,
    shippingCharge: 60,
    ...overrides,
  };
}

describe("admin order create attempt D1 fencing", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createDatabase());
  });

  afterEach(() => sqlite.close());

  it("atomically fences an expired old payload before permitting a fresh key", async () => {
    const requestKey = crypto.randomUUID();
    const original = await buildAdminOrderCreateAttemptIdentity(
      buildInput({ requestKey }),
      "admin_1",
    );
    const changed = await buildAdminOrderCreateAttemptIdentity(
      buildInput({ requestKey, shippingCharge: 80 }),
      "admin_1",
    );
    const claimed = await claimAdminOrderCreateAttempt<{ id: string }>(db, original);
    if (claimed.status !== "claimed") throw new Error("expected first claim");
    sqlite.prepare(`
      UPDATE admin_order_create_attempts
      SET claim_expires_at = unixepoch() - 1
      WHERE id = ?
    `).run(claimed.attempt.id);

    await expect(resolveAdminOrderCreateAttempt(db, changed)).rejects.toMatchObject({
      code: ADMIN_ORDER_CREATE_REQUEST_MISMATCH,
      details: { state: "failed", canRetryWithNewKey: true },
    });

    const fenced = await db
      .select({
        status: adminOrderCreateAttempts.status,
        claimId: adminOrderCreateAttempts.claimId,
        claimExpiresAt: adminOrderCreateAttempts.claimExpiresAt,
      })
      .from(adminOrderCreateAttempts)
      .where(eq(adminOrderCreateAttempts.id, claimed.attempt.id))
      .get();
    expect(fenced).toEqual({
      status: "failed",
      claimId: null,
      claimExpiresAt: null,
    });

    await expect(safeBatch(db, [
      buildAdminOrderCreateAttemptGuard(db, claimed.attempt),
    ])).rejects.toThrow();
    await expect(buildAdminOrderCreateAttemptCommit(
      db,
      claimed.attempt,
      { id: claimed.attempt.orderId },
    )).resolves.toEqual([]);
  });
});
