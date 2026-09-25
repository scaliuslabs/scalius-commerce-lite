import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { composeOrderLineExtras, withOrderLineExtras } from "./order-line-extras";

// The feature domains are empty stubs until B1/B3/B4/B5: composing extras must
// read nothing and leave every order item byte-identical.
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
