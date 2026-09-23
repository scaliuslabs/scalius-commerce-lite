import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { adminOrderCreateAttempts } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CreateOrderInput } from "./orders.validation";
import {
  ADMIN_ORDER_CREATE_REQUEST_MISMATCH,
  buildAdminOrderCreateAttemptCommit,
  buildAdminOrderCreateAttemptGuard,
  buildAdminOrderCreateAttemptIdentity,
  claimAdminOrderCreateAttempt,
  resolveAdminOrderCreateAttempt,
} from "./admin-order-create-attempts";

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
    ({ sqlite, db } = createSqliteD1Database());
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
