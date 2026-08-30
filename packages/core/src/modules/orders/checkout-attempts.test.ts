import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { ConflictError } from "@scalius/core/errors";
import {
  buildCheckoutAttemptIdentity,
  buildCheckoutStatusTokenFromRequestKey,
  createAtomicCheckoutAttempt,
  getCheckoutAttemptRequestKeyFromStatusToken,
  prepareAtomicCheckoutAttemptCommit,
  resolveExistingCheckoutAttempt,
} from "./checkout-attempts";
import { hashOrderReceiptToken } from "./order-receipts";
import type { CreateStorefrontOrderInput } from "./orders.types";

type AttemptRow = typeof schema.checkoutAttempts.$inferSelect;

describe("atomic checkout attempts", () => {
  it("derives stable request and non-receipt status identities", async () => {
    const first = await buildCheckoutAttemptIdentity(buildInput());
    const same = await buildCheckoutAttemptIdentity(buildInput());
    const changed = await buildCheckoutAttemptIdentity(buildInput({ shippingCharge: 60 }));

    expect(first).toEqual(same);
    expect(first.requestKey).toMatch(/^checkout_submit:v1:[a-f0-9]{64}$/);
    expect(first.statusToken).toMatch(/^cst_[a-f0-9]{64}$/);
    expect(first.statusToken).not.toContain("chk_");
    expect(changed.requestKey).toBe(first.requestKey);
    expect(changed.requestHash).not.toBe(first.requestHash);
    expect(getCheckoutAttemptRequestKeyFromStatusToken(first.statusToken)).toBe(first.requestKey);
    expect(buildCheckoutStatusTokenFromRequestKey(first.requestKey)).toBe(first.statusToken);
    expect(getCheckoutAttemptRequestKeyFromStatusToken("chk_secret_receipt")).toBeNull();
  });

  it("binds idempotency meaning to the exact quote the buyer reviewed", async () => {
    const first = await buildCheckoutAttemptIdentity(buildInput());
    const changed = await buildCheckoutAttemptIdentity(buildInput({
      expectedQuoteFingerprint: "taxq_vutsrqponmlkjihgfedcba",
    }));

    expect(changed.requestKey).toBe(first.requestKey);
    expect(changed.requestHash).not.toBe(first.requestHash);
  });

  it("creates a memory-only candidate for the authoritative order transaction", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const attempt = createAtomicCheckoutAttempt(identity);

    expect(attempt).toMatchObject({
      commitMode: "atomic",
      origin: "new",
      requestKey: identity.requestKey,
      requestHash: identity.requestHash,
      statusToken: identity.statusToken,
    });
    expect(attempt.id).toMatch(/^coa_/);
    expect(attempt.checkoutToken).toMatch(/^chk_/);
    expect(attempt.orderId).toHaveLength(16);
  });

  it("replays committed rows and exposes active legacy processing rows", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const committed = createAttemptRow(identity, {
      status: "committed",
      responsePayload: JSON.stringify({ orderId: "order_committed" }),
    });
    await expect(resolveExistingCheckoutAttempt<{ orderId: string }>(
      createResolverDb(committed),
      identity,
    )).resolves.toEqual({
      status: "replay",
      response: { orderId: "order_committed" },
    });

    const active = createAttemptRow(identity, {
      status: "processing",
      claimExpiresAt: Math.floor(Date.now() / 1_000) + 60,
    });
    await expect(resolveExistingCheckoutAttempt(
      createResolverDb(active),
      identity,
    )).resolves.toEqual({
      status: "processing",
      orderId: active.orderId,
      statusToken: identity.statusToken,
    });
  });

  it("replays the aggregate authority before its compatibility projection exists", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: async () => {
              selectCount += 1;
              return selectCount === 1
                ? undefined
                : {
                    requestHash: identity.requestHash,
                    responsePayload: JSON.stringify({ orderId: "aggregate_order" }),
                  };
            },
          }),
        }),
      }),
    } as unknown as Database;

    await expect(resolveExistingCheckoutAttempt<{ orderId: string }>(db, identity))
      .resolves.toEqual({
        status: "replay",
        response: { orderId: "aggregate_order" },
      });
  });

  it("reuses failed and stale legacy identities in the new atomic commit", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    for (const row of [
      createAttemptRow(identity, { status: "failed", claimExpiresAt: null }),
      createAttemptRow(identity, {
        status: "processing",
        claimExpiresAt: Math.floor(Date.now() / 1_000) - 1,
      }),
    ]) {
      await expect(resolveExistingCheckoutAttempt(
        createResolverDb(row),
        identity,
      )).resolves.toMatchObject({
        status: "retry",
        attempt: {
          commitMode: "atomic",
          origin: "retry",
          id: row.id,
          orderId: row.orderId,
          checkoutToken: row.checkoutToken,
        },
      });
    }
  });

  it("rejects reuse of a request id for different checkout facts", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const changed = await buildCheckoutAttemptIdentity(buildInput({ shippingCharge: 60 }));
    const row = createAttemptRow(identity);

    await expect(resolveExistingCheckoutAttempt(
      createResolverDb(row),
      changed,
    )).rejects.toBeInstanceOf(ConflictError);
  });

  it("prepares candidate arbitration and receipt around one order commit", async () => {
    const db = drizzle({} as D1Database, { schema }) as unknown as Database;
    const plan = await prepareAtomicCheckoutAttemptCommit(
      db,
      {
        commitMode: "atomic",
        origin: "new",
        id: "attempt_atomic_1",
        requestKey: "checkout_submit:v1:atomic_key",
        requestHash: "atomic_request_hash",
        orderId: "order_atomic_1",
        checkoutToken: "chk_atomic_receipt_secret",
        statusToken: "cst_atomic_status",
      },
      {
        paymentMethod: "cod",
        totalAmount: 125,
        response: { orderId: "order_atomic_1", message: "Order created" },
      },
    );

    const attemptWrite = compile(plan.writesBeforeOrder[0]);
    const guard = compile(plan.writesBeforeOrder[1]);
    const receiptWrite = compile(plan.writesAfterOrder[0]);

    expect(plan.writesBeforeOrder).toHaveLength(2);
    expect(plan.writesAfterOrder).toHaveLength(1);
    expect(attemptWrite.sql.toLowerCase()).toContain('insert into "checkout_attempts"');
    expect(attemptWrite.sql.toLowerCase()).toContain("on conflict");
    expect(attemptWrite.params).toContain(JSON.stringify({
      orderId: "order_atomic_1",
      message: "Order created",
    }));
    expect(guard.sql).toContain("CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT");
    expect(receiptWrite.sql.toLowerCase()).toContain('insert into "order_receipts"');
    expect(receiptWrite.params).toContain(await hashOrderReceiptToken("chk_atomic_receipt_secret"));
  });

  it("rolls back a losing duplicate or any later order failure", async () => {
    const sqlite = createAtomicCheckoutTestDatabase();
    const db = drizzle({} as D1Database, { schema }) as unknown as Database;
    try {
      const winner = {
        commitMode: "atomic" as const,
        origin: "new" as const,
        id: "attempt_winner",
        requestKey: "checkout_submit:v1:shared_key",
        requestHash: "shared_hash",
        orderId: "order_winner",
        checkoutToken: "chk_winner_secret",
        statusToken: "cst_shared",
      };
      const winnerPlan = await prepareAtomicCheckoutAttemptCommit(db, winner, {
        paymentMethod: "cod",
        totalAmount: 125,
        response: { orderId: winner.orderId },
      });
      executeAtomicCheckoutTestTransaction(sqlite, winnerPlan, winner.orderId);

      const loser = {
        ...winner,
        id: "attempt_loser",
        orderId: "order_loser",
        checkoutToken: "chk_loser_secret",
      };
      const loserPlan = await prepareAtomicCheckoutAttemptCommit(db, loser, {
        paymentMethod: "cod",
        totalAmount: 125,
        response: { orderId: loser.orderId },
      });
      expect(() => executeAtomicCheckoutTestTransaction(sqlite, loserPlan, loser.orderId))
        .toThrow(/CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT/);

      const laterFailure = {
        ...winner,
        id: "attempt_later_failure",
        requestKey: "checkout_submit:v1:later_failure",
        orderId: "order_later_failure",
        checkoutToken: "chk_later_failure_secret",
      };
      const laterFailurePlan = await prepareAtomicCheckoutAttemptCommit(db, laterFailure, {
        paymentMethod: "cod",
        totalAmount: 125,
        response: { orderId: laterFailure.orderId },
      });
      expect(() => executeAtomicCheckoutTestTransaction(sqlite, laterFailurePlan, null))
        .toThrow(/NOT NULL constraint failed: orders\.id/);

      expect(sqlite.prepare("SELECT id FROM orders ORDER BY id").all()).toEqual([
        { id: "order_winner" },
      ]);
      expect(sqlite.prepare(
        "SELECT id, order_id AS orderId, status FROM checkout_attempts ORDER BY id",
      ).all()).toEqual([{
        id: "attempt_winner",
        orderId: "order_winner",
        status: "committed",
      }]);
      expect(sqlite.prepare("SELECT order_id AS orderId FROM order_receipts").all()).toEqual([
        { orderId: "order_winner" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

function createAttemptRow(
  identity: Awaited<ReturnType<typeof buildCheckoutAttemptIdentity>>,
  overrides: Partial<AttemptRow> = {},
): AttemptRow {
  return {
    id: "attempt_existing",
    requestKey: identity.requestKey,
    requestHash: identity.requestHash,
    checkoutToken: "chk_existing_secret",
    orderId: "order_existing",
    status: "processing",
    paymentMethod: null,
    totalAmount: null,
    responsePayload: null,
    attempts: 1,
    claimId: "legacy_claim",
    claimExpiresAt: Math.floor(Date.now() / 1_000) + 60,
    lastError: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

function createResolverDb(row: AttemptRow | undefined): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ get: async () => row }),
      }),
    }),
  } as unknown as Database;
}

function compile(statement: unknown): { sql: string; params: unknown[] } {
  return (statement as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

function createAtomicCheckoutTestDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE checkout_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      checkout_token TEXT NOT NULL,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      payment_method TEXT,
      total_amount REAL,
      response_payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_id TEXT,
      claim_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX checkout_attempts_request_key_unique
      ON checkout_attempts(request_key);
    CREATE UNIQUE INDEX checkout_attempts_checkout_token_unique
      ON checkout_attempts(checkout_token);
    CREATE TABLE orders (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE order_receipts (
      token_hash TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return sqlite;
}

function executeCompiledStatement(sqlite: DatabaseSync, statement: unknown): void {
  const compiled = compile(statement);
  const prepared = sqlite.prepare(compiled.sql);
  if (/^\s*select\b/i.test(compiled.sql)) {
    prepared.all(...compiled.params as never[]);
  } else {
    prepared.run(...compiled.params as never[]);
  }
}

function executeAtomicCheckoutTestTransaction(
  sqlite: DatabaseSync,
  plan: Awaited<ReturnType<typeof prepareAtomicCheckoutAttemptCommit>>,
  orderId: string | null,
): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of plan.writesBeforeOrder) {
      executeCompiledStatement(sqlite, statement);
    }
    sqlite.prepare("INSERT INTO orders (id) VALUES (?)").run(orderId);
    for (const statement of plan.writesAfterOrder) {
      executeCompiledStatement(sqlite, statement);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

function buildInput(overrides: Partial<CreateStorefrontOrderInput> = {}): CreateStorefrontOrderInput {
  return {
    checkoutRequestId: "chkreq_test_1234567890",
    expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    customerName: "Test Buyer",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "123 Test Street",
    city: "city_1",
    zone: "zone_1",
    area: null,
    cityName: "Dhaka",
    zoneName: "Mirpur",
    areaName: null,
    notes: null,
    items: [{
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
      productName: "Product 1",
      variantLabel: null,
    }],
    discountAmount: null,
    discountCode: null,
    shippingCharge: 20,
    shippingMethodId: "ship_1",
    paymentMethod: "cod",
    inventoryPool: "regular",
    ...overrides,
  };
}
