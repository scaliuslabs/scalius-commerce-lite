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
  isEndedCheckoutOrder,
  prepareAtomicCheckoutAttemptCommit,
  resolveCheckoutAttemptRow,
  resolveExistingCheckoutAttempt,
  selectCheckoutAttemptByKey,
  type CheckoutAttemptRow,
} from "./attempts";
import { hashOrderReceiptToken } from "../orders/receipts";
import type { CreateStorefrontOrderInput } from "../orders/types";

type AttemptRow = CheckoutAttemptRow;

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

  it("binds canonical separate WhatsApp numbers into the request hash", async () => {
    const none = await buildCheckoutAttemptIdentity(buildInput());
    for (const customerWhatsapp of [undefined, null, "", "  "]) {
      expect((await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp }))).requestHash).toBe(none.requestHash);
    }
    const first = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: "01812345678" }));
    const same = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: " +8801812345678 " }));
    const changed = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: "+8801912345678" }));
    expect(first).toEqual(same);
    expect(first.requestHash).not.toBe(none.requestHash);
    expect(first.requestHash).not.toBe(changed.requestHash);
  });

  it("protects a changed WhatsApp number on an exact retry", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: "+8801812345678" }));
    const row = createAttemptRow(identity, {
      status: "committed", linkedOrderId: "order_existing",
      responsePayload: JSON.stringify({ receiptToken: "chk_existing_secret" }),
    });
    expect(resolveCheckoutAttemptRow(row, identity)).toMatchObject({ status: "replay" });
    for (const customerWhatsapp of [null, "+8801912345678"]) {
      const changed = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp }));
      expect(() => resolveCheckoutAttemptRow(row, changed)).toThrow(expect.objectContaining({ code: "CHECKOUT_ATTEMPT_CONFLICT" }));
    }
    const changed = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: "+8801912345678" }));
    expect(() => resolveCheckoutAttemptRow({ ...row, linkedOrderAccountOwnerCustomerId: "owner" }, changed))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => resolveCheckoutAttemptRow({ ...row, linkedOrderStatus: "cancelled", linkedOrderDeletedAt: 1,
      linkedOrderPaymentStatus: "unpaid", linkedOrderPaidAmountMinor: 0 }, changed))
      .toThrow(expect.objectContaining({ code: "CHECKOUT_ATTEMPT_EXPIRED" }));
  });

  it("replays a new exact WhatsApp request even when contact settings discarded the number", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: "ignored hidden input" }));
    const row = createAttemptRow(identity, {
      status: "committed", linkedOrderId: "order_existing",
      responsePayload: JSON.stringify({ orderId: "order_existing" }),
    });
    expect(resolveCheckoutAttemptRow(row, identity)).toMatchObject({ status: "replay" });
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
      linkedOrderId: "order_committed",
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

  it.each([
    { paymentMethod: "scalius.bangladesh:bkash" },
    { expectedQuoteFingerprint: "taxq_vutsrqponmlkjihgfedcba" },
    { shippingCharge: 60 },
    { notes: "Changed delivery instructions" },
  ])("keeps a changed checkout bound to its live order: %j", async (change) => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const changed = await buildCheckoutAttemptIdentity(buildInput(change));
    const row = createAttemptRow(identity, {
      status: "committed",
      linkedOrderId: "order_existing",
      linkedOrderPaymentMethod: "cod",
      responsePayload: JSON.stringify({ receiptToken: "chk_existing_secret" }),
    });

    try {
      resolveCheckoutAttemptRow(row, changed);
      expect.fail("Changed checkout must not replay or start another order");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        status: 409,
        code: "CHECKOUT_ATTEMPT_CONFLICT",
        details: { orderId: "order_existing", paymentMethod: "cod" },
      });
      expect((error as ConflictError).details).toEqual({ orderId: "order_existing", paymentMethod: "cod" });
      expect(JSON.stringify(error)).not.toContain("chk_existing_secret");
      expect(JSON.stringify(error)).not.toContain(identity.statusToken);
    }
  });

  it.each(["failed", "processing", "committed"])("does not reopen a mismatched %s attempt with a missing order", async (status) => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const changed = await buildCheckoutAttemptIdentity(buildInput({ shippingCharge: 60 }));
    const row = createAttemptRow(identity, { status, claimExpiresAt: 0 });

    try {
      resolveCheckoutAttemptRow(row, changed);
      expect.fail("An unproven old attempt must remain sealed to its request");
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "CHECKOUT_ATTEMPT_CONFLICT" });
      expect((error as ConflictError).details).toBeUndefined();
    }
  });

  it("does not replay a committed payload when its order is missing", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    expect(() => resolveCheckoutAttemptRow(createAttemptRow(identity, {
      status: "committed",
      responsePayload: JSON.stringify({ receiptToken: "chk_existing_secret" }),
    }), identity)).toThrow("Checkout order is unavailable");
  });

  it.each([null, "customer_other"])("does not reveal an account-owned attempt to customer %s", async (customerId) => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const changed = await buildCheckoutAttemptIdentity(buildInput({ shippingCharge: 60 }));
    for (const linkedOrderDeletedAt of [null, 1_700_000_000]) {
      const row = createAttemptRow(identity, {
        status: "committed", linkedOrderId: "order_existing", linkedOrderAccountOwnerCustomerId: "customer_owner",
        linkedOrderStatus: "cancelled", linkedOrderDeletedAt, linkedOrderPaidAmountMinor: 0,
        linkedOrderPaymentStatus: "unpaid", responsePayload: JSON.stringify({ receiptToken: "chk_existing_secret" }),
      });
      for (const request of [identity, changed]) {
        try {
          await resolveExistingCheckoutAttempt(createResolverDb(row), request, undefined, Promise.resolve(customerId));
          expect.fail("A different account must not recover the checkout");
        } catch (error) {
          expect(error).toMatchObject({ status: 403, code: "FORBIDDEN", details: undefined });
          expect(JSON.stringify(error)).not.toMatch(/order_existing|chk_existing_secret|customer_owner/);
        }
      }
    }
  });

  it("replays an account-owned checkout only to its current owner", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const response = { orderId: "order_existing", receiptToken: "chk_existing_secret" };
    const row = createAttemptRow(identity, {
      status: "committed", linkedOrderId: "order_existing", linkedOrderAccountOwnerCustomerId: "customer_owner",
      responsePayload: JSON.stringify(response),
    });
    await expect(resolveExistingCheckoutAttempt(createResolverDb(row), identity, undefined, Promise.resolve("customer_owner")))
      .resolves.toEqual({ status: "replay", response });
  });

  it("does not resolve a customer session for a new or guest attempt", async () => {
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    const customerId = { then() { throw new Error("Guest replay must not add a session read"); } } as PromiseLike<string | null>;
    const response = { orderId: "order_existing", receiptToken: "chk_existing_secret" };
    const row = createAttemptRow(identity, {
      status: "committed", linkedOrderId: "order_existing", responsePayload: JSON.stringify(response),
    });
    await expect(resolveExistingCheckoutAttempt(createResolverDb(undefined), identity, undefined, customerId)).resolves.toBeNull();
    await expect(resolveExistingCheckoutAttempt(createResolverDb(row), identity, undefined, customerId))
      .resolves.toEqual({ status: "replay", response });
  });

  it("requires every terminal order fact before allowing an expired checkout recovery", () => {
    for (const id of [null, "order_existing"]) {
      for (const status of [null, "incomplete", "pending", "cancelled", "refunded"]) {
        for (const deletedAt of [null, 1_700_000_000]) {
          for (const paymentStatus of [null, "unpaid", "failed", "refunded", "paid", "partial", "partially_refunded"]) {
            for (const paidAmountMinor of [null, 0, 100]) {
              const order = { id, status, deletedAt, paymentStatus, paidAmountMinor };
              const ended = id === "order_existing" && status === "cancelled" && deletedAt !== null
                && paidAmountMinor === 0 && ["unpaid", "failed", "refunded"].includes(paymentStatus ?? "");
              expect(isEndedCheckoutOrder(order), JSON.stringify(order)).toBe(ended);
            }
          }
        }
      }
    }
  });

  it.each(["unpaid", "failed", "refunded"])("reads %s ended orders in the attempt statement and refuses both exact and changed replays", async (paymentStatus) => {
    const { sqlite, db } = createSqliteD1Database();
    try {
      const identity = await buildCheckoutAttemptIdentity(buildInput());
      const changed = await buildCheckoutAttemptIdentity(buildInput({ paymentMethod: "scalius.bangladesh:bkash" }));
      const attempt = {
        id: "attempt_existing", orderId: "order_existing", checkoutToken: "chk_existing_secret",
        requestKey: identity.requestKey, requestHash: identity.requestHash,
        status: "committed",
        responsePayload: JSON.stringify({ orderId: "order_existing", receiptToken: "chk_existing_secret" }),
      };
      await db.insert(schema.checkoutAttempts).values(attempt);
      await db.insert(schema.orders).values({
        id: attempt.orderId, customerName: "Buyer", customerPhone: "+8801712345678",
        shippingAddress: "Address", city: "city_1", zone: "zone_1", totalAmountMinor: 12_500,
        status: "cancelled", deletedAt: new Date(1_700_000_000_000),
        paymentStatus, paidAmountMinor: 0, paymentMethod: "scalius.bangladesh:bkash",
      });
      const row = await selectCheckoutAttemptByKey(db, identity.requestKey).get();
      expect(row).toMatchObject({
        status: "committed", linkedOrderId: attempt.orderId, linkedOrderStatus: "cancelled",
        linkedOrderDeletedAt: 1_700_000_000, linkedOrderPaymentStatus: paymentStatus,
        linkedOrderPaidAmountMinor: 0, linkedOrderPaymentMethod: "scalius.bangladesh:bkash",
      });
      const [batched] = await db.batch([selectCheckoutAttemptByKey(db, identity.requestKey)]);
      expect(batched).toEqual([row]);
      for (const request of [identity, changed]) {
        await expect(resolveExistingCheckoutAttempt(db, request)).rejects.toMatchObject({
          status: 409, code: "CHECKOUT_ATTEMPT_EXPIRED", details: undefined,
        });
      }
      expect(sqlite.prepare("SELECT count(*) AS count FROM orders").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT count(*) AS count FROM checkout_attempts").get()).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("enforces the joined account owner and legacy contact in direct and batched database recovery", async () => {
    const { sqlite, db } = createSqliteD1Database();
    try {
      const identity = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: "+8801812345678" }));
      const response = { orderId: "order_existing", receiptToken: "chk_existing_secret" };
      await db.insert(schema.customers).values({ id: "customer_owner", name: "Buyer", phone: "+8801712345678" });
      await db.insert(schema.orders).values({
        id: response.orderId, customerName: "Buyer", customerPhone: "+8801712345678",
        shippingAddress: "Address", city: "city_1", zone: "zone_1", totalAmountMinor: 12_500,
        accountOwnerCustomerId: "customer_owner",
        customerWhatsapp: identity.customerWhatsapp,
      });
      await db.insert(schema.checkoutAttempts).values({
        id: "attempt_existing", orderId: response.orderId, checkoutToken: response.receiptToken,
        requestKey: identity.requestKey, requestHash: identity.requestHash, status: "committed",
        responsePayload: JSON.stringify(response),
      });
      await expect(resolveExistingCheckoutAttempt(db, identity)).rejects.toMatchObject({ status: 403 });
      await expect(resolveExistingCheckoutAttempt(db, identity, undefined, "customer_other")).rejects.toMatchObject({ status: 403 });
      await expect(resolveExistingCheckoutAttempt(db, identity, undefined, "customer_owner"))
        .resolves.toEqual({ status: "replay", response });
      const [rows] = await db.batch([selectCheckoutAttemptByKey(db, identity.requestKey)]);
      expect(rows[0]?.linkedOrderAccountOwnerCustomerId).toBe("customer_owner");
      expect(() => resolveCheckoutAttemptRow(rows[0], identity, undefined, "customer_other")).toThrow("Sign in to the account");
      expect(resolveCheckoutAttemptRow(rows[0], identity, undefined, "customer_owner")).toEqual({ status: "replay", response });
      const changed = await buildCheckoutAttemptIdentity(buildInput({ customerWhatsapp: "+8801912345678" }));
      await expect(resolveExistingCheckoutAttempt(db, changed, undefined, "customer_owner"))
        .rejects.toMatchObject({ code: "CHECKOUT_ATTEMPT_CONFLICT" });
    } finally {
      sqlite.close();
    }
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
    linkedOrderId: null,
    linkedOrderStatus: null,
    linkedOrderDeletedAt: null,
    linkedOrderPaymentStatus: null,
    linkedOrderPaidAmountMinor: null,
    linkedOrderPaymentMethod: null,
    linkedOrderAccountOwnerCustomerId: null,
    ...overrides,
  };
}

function createResolverDb(row: AttemptRow | undefined): Database {
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: () => ({ get: async () => row }) }),
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
    notes: null,
    items: [{
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
      productName: "Product 1",
      variantLabel: null,
    }],
    discountCodes: [],
    shippingCharge: 20,
    shippingMethodId: "ship_1",
    paymentMethod: "cod",
    inventoryPool: "regular",
    ...overrides,
  };
}
