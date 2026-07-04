import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { orderReceipts } from "@scalius/database/schema";
import { ConflictError } from "@scalius/core/errors";
import {
  buildCheckoutAttemptIdentity,
  claimCheckoutAttempt,
  markCheckoutAttemptCommitted,
  markCheckoutAttemptFailed,
  resolveExistingCheckoutAttempt,
} from "./checkout-attempts";
import { hashOrderReceiptToken } from "./order-receipts";
import type { CreateStorefrontOrderInput } from "./orders.types";

type AttemptRow = {
  id: string;
  requestKey: string;
  requestHash: string;
  checkoutToken: string;
  orderId: string;
  status: string;
  paymentMethod: string | null;
  totalAmount: number | null;
  responsePayload: string | null;
  attempts: number;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

type ReceiptRow = {
  tokenHash: string;
  orderId: string;
  source: string;
  status: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

describe("checkout attempts", () => {
  it("replays a committed checkout submit without creating another claim", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());

    const first = await claimCheckoutAttempt<{ orderId: string }>(fake.db, identity);
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected first claim");

    await markCheckoutAttemptCommitted(fake.db, first.attempt, {
      paymentMethod: "cod",
      totalAmount: 120,
      response: { orderId: first.attempt.orderId },
    });

    const second = await claimCheckoutAttempt<{ orderId: string }>(fake.db, identity);

    expect(second).toEqual({
      status: "replay",
      response: { orderId: first.attempt.orderId },
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("records a hash-backed order receipt proof when a checkout attempt commits", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());

    const claim = await claimCheckoutAttempt<{ orderId: string }>(fake.db, identity);
    if (claim.status !== "claimed") throw new Error("expected claim");

    await markCheckoutAttemptCommitted(fake.db, claim.attempt, {
      paymentMethod: "sslcommerz",
      totalAmount: 120,
      response: { orderId: claim.attempt.orderId },
    });

    expect(fake.receipts).toHaveLength(1);
    expect(fake.receipts[0]).toMatchObject({
      tokenHash: await hashOrderReceiptToken(claim.attempt.checkoutToken),
      orderId: claim.attempt.orderId,
      source: "checkout_attempt",
      status: "active",
    });
    expect(JSON.stringify(fake.receipts[0])).not.toContain(claim.attempt.checkoutToken);
  });

  it("resolves a committed checkout submit through the read-only precheck", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());

    const first = await claimCheckoutAttempt<{ orderId: string }>(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");

    await markCheckoutAttemptCommitted(fake.db, first.attempt, {
      paymentMethod: "cod",
      totalAmount: 120,
      response: { orderId: first.attempt.orderId },
    });

    await expect(resolveExistingCheckoutAttempt<{ orderId: string }>(fake.db, identity)).resolves.toEqual({
      status: "replay",
      response: { orderId: first.attempt.orderId },
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("returns the existing processing attempt while the first claim is active", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());

    const first = await claimCheckoutAttempt(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");

    fake.stats.selects = 0;
    fake.stats.updates = 0;
    const second = await claimCheckoutAttempt(fake.db, identity);

    expect(second).toEqual({
      status: "processing",
      orderId: first.attempt.orderId,
      checkoutToken: first.attempt.checkoutToken,
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attempts).toBe(1);
    expect(fake.stats.selects).toBe(1);
    expect(fake.stats.updates).toBe(0);
  });

  it("resolves an active processing checkout submit through the read-only precheck", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());

    const first = await claimCheckoutAttempt(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");

    await expect(resolveExistingCheckoutAttempt(fake.db, identity)).resolves.toEqual({
      status: "processing",
      orderId: first.attempt.orderId,
      checkoutToken: first.attempt.checkoutToken,
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("does not resolve failed or stale processing attempts through the read-only precheck", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());

    const first = await claimCheckoutAttempt(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");

    await markCheckoutAttemptFailed(fake.db, first.attempt, new Error("commit failed"));
    await expect(resolveExistingCheckoutAttempt(fake.db, identity)).resolves.toBeNull();

    fake.rows[0]!.status = "processing";
    fake.rows[0]!.claimId = "coac_stale";
    fake.rows[0]!.claimExpiresAt = Math.floor(Date.now() / 1000) - 1;

    await expect(resolveExistingCheckoutAttempt(fake.db, identity)).resolves.toBeNull();
  });

  it("reclaims a failed checkout submit while keeping the original order id and receipt token", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());

    const first = await claimCheckoutAttempt(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");
    const originalOrderId = first.attempt.orderId;
    const originalCheckoutToken = first.attempt.checkoutToken;

    await markCheckoutAttemptFailed(fake.db, first.attempt, new Error("commit failed"));

    const second = await claimCheckoutAttempt(fake.db, identity);

    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") throw new Error("expected second claim");
    expect(second.attempt.orderId).toBe(originalOrderId);
    expect(second.attempt.checkoutToken).toBe(originalCheckoutToken);
    expect(fake.rows[0]?.attempts).toBe(2);
    expect(fake.rows[0]?.lastError).toBeNull();
  });

  it("does not reuse a checkout request id for different checkout details", async () => {
    const fake = createFakeCheckoutAttemptDb();
    const identity = await buildCheckoutAttemptIdentity(buildInput());
    await claimCheckoutAttempt(fake.db, identity);

    const changedIdentity = await buildCheckoutAttemptIdentity(buildInput({ shippingCharge: 60 }));

    await expect(claimCheckoutAttempt(fake.db, changedIdentity)).rejects.toBeInstanceOf(ConflictError);
    await expect(resolveExistingCheckoutAttempt(fake.db, changedIdentity)).rejects.toBeInstanceOf(ConflictError);
    expect(fake.rows).toHaveLength(1);
  });
});

function buildInput(overrides: Partial<CreateStorefrontOrderInput> = {}): CreateStorefrontOrderInput {
  return {
    checkoutRequestId: "chkreq_test_1234567890",
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
    items: [
      {
        productId: "product_1",
        variantId: "variant_1",
        quantity: 1,
        price: 100,
        productName: "Product 1",
        variantLabel: null,
      },
    ],
    discountAmount: null,
    discountCode: null,
    shippingCharge: 20,
    shippingMethodId: "ship_1",
    paymentMethod: "cod",
    inventoryPool: "regular",
    ...overrides,
  };
}

function createFakeCheckoutAttemptDb(): {
  db: Database;
  rows: AttemptRow[];
  receipts: ReceiptRow[];
  stats: { selects: number; updates: number };
} {
  const rows: AttemptRow[] = [];
  const receipts: ReceiptRow[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  const stats = { selects: 0, updates: 0 };

  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          if (table !== orderReceipts) return;
          const current = now();
          const row: ReceiptRow = {
            tokenHash: String(values.tokenHash),
            orderId: String(values.orderId),
            source: String(values.source),
            status: String(values.status),
            expiresAt: Number(values.expiresAt),
            createdAt: current,
            updatedAt: current,
          };
          const index = receipts.findIndex((receipt) => receipt.tokenHash === row.tokenHash);
          if (index >= 0) {
            receipts[index] = { ...receipts[index]!, ...row, createdAt: receipts[index]!.createdAt };
          } else {
            receipts.push(row);
          }
        },
        onConflictDoNothing: () => ({
          returning: async () => {
            if (rows.some((row) => row.requestKey === values.requestKey)) return [];
            const createdAt = now();
            const row: AttemptRow = {
              id: String(values.id),
              requestKey: String(values.requestKey),
              requestHash: String(values.requestHash),
              checkoutToken: String(values.checkoutToken),
              orderId: String(values.orderId),
              status: String(values.status),
              paymentMethod: (values.paymentMethod as string | null | undefined) ?? null,
              totalAmount: (values.totalAmount as number | null | undefined) ?? null,
              responsePayload: (values.responsePayload as string | null | undefined) ?? null,
              attempts: Number(values.attempts ?? 0),
              claimId: (values.claimId as string | null | undefined) ?? null,
              claimExpiresAt: createdAt + 300,
              lastError: (values.lastError as string | null | undefined) ?? null,
              createdAt,
              updatedAt: createdAt,
            };
            rows.push(row);
            return [{
              id: row.id,
              requestKey: row.requestKey,
              requestHash: row.requestHash,
              orderId: row.orderId,
              checkoutToken: row.checkoutToken,
            }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => {
            stats.selects += 1;
            return rows[0];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const applyUpdate = () => {
            stats.updates += 1;
            const row = rows[0];
            if (!row) return [];
            if (values.status === "processing" && row.status === "processing" && (row.claimExpiresAt ?? 0) > now()) {
              return [];
            }
            Object.assign(row, materializeUpdate(values, row));
            return [{
              id: row.id,
              requestKey: row.requestKey,
              requestHash: row.requestHash,
              orderId: row.orderId,
              checkoutToken: row.checkoutToken,
            }];
          };
          return {
            returning: async () => applyUpdate(),
            then: (resolve: (value: unknown) => void) => resolve(applyUpdate()),
          };
        },
      }),
    }),
  } as unknown as Database;

  return { db, rows, receipts, stats };
}

function materializeUpdate(values: Record<string, unknown>, row: AttemptRow): Partial<AttemptRow> {
  const next: Partial<AttemptRow> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === "attempts") {
      next.attempts = row.attempts + 1;
    } else if (key === "claimExpiresAt") {
      next.claimExpiresAt = value === null ? null : Math.floor(Date.now() / 1000) + 300;
    } else if (key === "updatedAt") {
      next.updatedAt = Math.floor(Date.now() / 1000);
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}
