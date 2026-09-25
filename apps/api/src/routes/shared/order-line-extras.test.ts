import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { composeOrderLineExtras, withOrderLineExtras } from "./order-line-extras";

// B3 filled the digital reader; it is stubbed here so the remaining domains are
// still proven to read nothing and leave every order item byte-identical.
const digital = vi.hoisted(() => ({ deliveries: new Map<string, unknown>() }));
vi.mock("@scalius/core/modules/digital", () => ({
  listLineDeliveries: vi.fn(async () => digital.deliveries),
}));

beforeEach(() => {
  digital.deliveries = new Map();
});
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

  it("presents a line's downloads with ISO expiry and keys by last 4", async () => {
    digital.deliveries = new Map([["oi_2", {
      downloads: [{ entitlementId: "dge_1", displayName: "Guide", downloadCount: 1, downloadLimit: 5, expiresAt: 1_900_000_000, revoked: false }],
      licenceKeys: [{ keyId: "dlk_1", last4: "7K2Q" }],
    }]]);
    const extras = await composeOrderLineExtras(noDatabase, {
      orderId: "ord_1",
      orderItemIds: ["oi_1", "oi_2"],
      audience: "buyer",
      currencyDecimalPlaces: 0,
    });
    expect([...extras.keys()]).toEqual(["oi_2"]);
    expect(extras.get("oi_2")).toEqual({
      downloads: [{ entitlementId: "dge_1", displayName: "Guide", downloadCount: 1, downloadLimit: 5, expiresAt: "2030-03-17T17:46:40.000Z", revoked: false }],
      licenceKeys: [{ keyId: "dlk_1", last4: "7K2Q" }],
    });
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
