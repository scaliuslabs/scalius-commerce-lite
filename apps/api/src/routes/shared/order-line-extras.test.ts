import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

// Gift cards (B4) read their issued cards; an order that issued none adds no
// key. The domains still empty must read nothing.
const giftCardMocks = vi.hoisted(() => ({ listLineIssuedCards: vi.fn(async () => new Map()) }));
vi.mock("@scalius/core/modules/gift-cards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/gift-cards")>()),
  listLineIssuedCards: giftCardMocks.listLineIssuedCards,
}));

import { composeOrderLineExtras, withOrderLineExtras } from "./order-line-extras";

// Composing extras for lines without facts leaves every order item byte-identical.
const noDatabase = new Proxy({}, {
  get() {
    throw new Error("order-line extras must not read the database while the domains are empty");
  },
}) as unknown as Database;

describe("composeOrderLineExtras", () => {
  it("adds no extras key and does no I/O while the domains are empty", async () => {
    const extras = await composeOrderLineExtras(noDatabase, {
      orderId: "ord_1",
      orderItemIds: ["oi_1", "oi_2"],
      audience: "buyer",
      currencyDecimalPlaces: 0,
    });
    expect(extras.size).toBe(0);
    expect(giftCardMocks.listLineIssuedCards).toHaveBeenCalledTimes(1);
    const item = { id: "oi_1", quantity: 1 };
    const presented = withOrderLineExtras(item, extras);
    expect(presented).toBe(item);
    expect(JSON.stringify(presented)).toBe(JSON.stringify(item));
  });

  it("skips every reader for an order without items", async () => {
    const extras = await composeOrderLineExtras(noDatabase, {
      orderId: "ord_1",
      orderItemIds: [],
      audience: "staff",
      currencyDecimalPlaces: 2,
    });
    expect(extras.size).toBe(0);
  });

  it("attaches a line's extras only to that line", () => {
    const extras = new Map([["oi_2", { licenceKeys: [{ keyId: "k_1", last4: "7K2Q" }] }]]);
    expect(withOrderLineExtras({ id: "oi_1" }, extras)).toEqual({ id: "oi_1" });
    expect(withOrderLineExtras({ id: "oi_2" }, extras)).toEqual({
      id: "oi_2",
      extras: { licenceKeys: [{ keyId: "k_1", last4: "7K2Q" }] },
    });
  });
});
