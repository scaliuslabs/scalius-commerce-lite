import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import { customers, orders } from "@scalius/database/schema";
import * as schema from "@scalius/database/schema";

import { claimGuestOrderToAccount } from "./order-account-claim";

const migrationDirectory = fileURLToPath(new URL(
  "../../../../database/migrations/",
  import.meta.url,
));

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

function d1Statement(sqlite: DatabaseSync, query: string, values: SQLInputValue[] = []): SqliteD1Statement {
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
  for (const name of readdirSync(migrationDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(compileSqliteMigrationForProvider(readFileSync(`${migrationDirectory}/${name}`, "utf8"), "d1"));
  }
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

describe("guest order account claim", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    ({ sqlite, db } = createDatabase());
    await db.insert(customers).values([
      { id: "guest_crm", name: "Guest", email: "buyer@example.com", phone: "+8801711111111", totalOrders: 1, totalSpent: 0 },
      { id: "account_1", name: "Buyer", email: "buyer@example.com", phone: "+8801722222222" },
      { id: "account_2", name: "Other", email: "other@example.com", phone: "+8801733333333" },
    ]);
    await db.insert(orders).values({
      id: "order_1",
      customerName: "Buyer",
      customerPhone: "+8801722222222",
      customerEmail: "buyer@example.com",
      shippingAddress: "Dhaka",
      city: "dhaka",
      zone: "zone_1",
      totalAmount: 100,
      shippingCharge: 0,
      balanceDue: 100,
      customerId: "guest_crm",
      accountOwnerCustomerId: null,
    });
  });

  afterEach(() => sqlite.close());

  it("atomically adds private account ownership without changing the merchant CRM link or metrics", async () => {
    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_1",
      customerEmail: "BUYER@example.com",
      customerPhone: "+8801722222222",
    })).resolves.toEqual({
      orderId: "order_1",
      customerId: "account_1",
      alreadyClaimed: false,
    });

    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_1",
      customerEmail: "buyer@example.com",
      customerPhone: "+8801711111111",
    })).resolves.toMatchObject({ alreadyClaimed: true });

    const claimed = await db.select({
      customerId: orders.customerId,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
    }).from(orders).where(eq(orders.id, "order_1")).get();
    const account = await db.select({
      totalOrders: customers.totalOrders,
      totalSpent: customers.totalSpent,
    }).from(customers).where(eq(customers.id, "account_1")).get();
    expect(claimed).toEqual({ customerId: "guest_crm", accountOwnerCustomerId: "account_1" });
    expect(account).toEqual({ totalOrders: 0, totalSpent: 0 });
  });

  it("fails closed for a different contact and for an order already owned by another account", async () => {
    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_2",
      customerEmail: "other@example.com",
      customerPhone: "+8801733333333",
    })).rejects.toMatchObject({ status: 403 });

    sqlite.prepare("UPDATE orders SET account_owner_customer_id = ? WHERE id = ?").run("account_1", "order_1");
    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_2",
      customerEmail: "buyer@example.com",
      customerPhone: "+8801733333333",
    })).rejects.toMatchObject({ status: 409 });
  });
});
