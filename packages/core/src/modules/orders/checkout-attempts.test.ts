import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";

import { ConflictError } from "@scalius/core/errors";
import {
  type AtomicCheckoutAttempt,
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

  it("commits one attempt, order and hashed receipt; a losing duplicate or later failure rolls back", async () => {
    const { sqlite, db } = createSqliteD1Database({ foreignKeys: true });
    const commit = async (attempt: AtomicCheckoutAttempt, orderId = attempt.orderId) => {
      const plan = await prepareAtomicCheckoutAttemptCommit(db, attempt, {
        paymentMethod: "cod",
        totalAmountMinor: 12_500,
        response: { orderId: attempt.orderId },
      });
      await db.batch([
        ...plan.writesBeforeOrder,
        db.insert(schema.orders).values({
          id: orderId, customerName: "Buyer", customerPhone: "+8801712345678",
          shippingAddress: "Address", city: "city_1", zone: "zone_1", totalAmountMinor: 12_500,
        }),
        ...plan.writesAfterOrder,
      ] as never);
    };
    const winner: AtomicCheckoutAttempt = {
      commitMode: "atomic",
      origin: "new",
      id: "attempt_winner",
      requestKey: "checkout_submit:v1:shared_key",
      requestHash: "shared_hash",
      orderId: "order_winner",
      checkoutToken: "chk_winner_secret",
      statusToken: "cst_shared",
    };

    await commit(winner);
    await expect(commit({ ...winner, id: "attempt_loser", orderId: "order_loser", checkoutToken: "chk_loser_secret" }))
      .rejects.toThrow(/CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT/);
    await expect(commit({
      ...winner,
      id: "attempt_later_failure",
      requestKey: "checkout_submit:v1:later_failure",
      orderId: "order_later_failure",
      checkoutToken: "chk_later_failure_secret",
    }, "order_winner")).rejects.toThrow(/UNIQUE constraint failed: orders\.id/);

    expect(sqlite.prepare("SELECT id FROM orders").all()).toEqual([{ id: "order_winner" }]);
    expect(sqlite.prepare("SELECT id, order_id AS orderId, status, response_payload AS response FROM checkout_attempts").all())
      .toEqual([{ id: "attempt_winner", orderId: "order_winner", status: "committed", response: '{"orderId":"order_winner"}' }]);
    expect(sqlite.prepare("SELECT token_hash AS tokenHash, order_id AS orderId FROM order_receipts").all())
      .toEqual([{ tokenHash: await hashOrderReceiptToken("chk_winner_secret"), orderId: "order_winner" }]);
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
    totalAmountMinor: null,
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
