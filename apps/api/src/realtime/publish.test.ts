// Hub notices: outbox events become ids, states and revisions (never other
// facts), one RPC per publish, and the hub's own frame rules.
import { describe, expect, it, vi } from "vitest";
import { changesForEvent, dedupeChanges, publishRealtime, tableChanges } from "./publish";
import { framesFor, parseIdentity } from "./hub";

describe("changesForEvent", () => {
  it("maps order events to orders (and paid/refunded to payments too)", () => {
    expect(changesForEvent({ topic: "order.created", resourceId: "ord_1", facts: { orderId: "ord_1", status: "pending", paymentStatus: "unpaid", channel: "online" } as never }))
      .toEqual([{ topic: "orders", kind: "order.created", id: "ord_1", status: "pending" }]);
    expect(changesForEvent({ topic: "order.paid", resourceId: "ord_1", facts: { orderId: "ord_1", previousPaymentStatus: "unpaid", paymentStatus: "paid" } as never }))
      .toEqual([
        { topic: "orders", kind: "order.paid", id: "ord_1" },
        { topic: "payments", kind: "order.paid", id: "ord_1" },
      ]);
  });

  it("carries a product's revision and an inventory change's product", () => {
    expect(changesForEvent({ topic: "product.updated", resourceId: "prd_1", facts: { productId: "prd_1", revision: 7 } as never }))
      .toEqual([{ topic: "products", kind: "product.updated", id: "prd_1", rev: 7 }]);
    expect(changesForEvent({
      topic: "variant.inventory_changed",
      resourceId: "var_1",
      facts: { variantId: "var_1", productId: "prd_1", locationId: null, quantityDelta: -2, movementId: "mov_1", movementType: "sale" } as never,
    })).toEqual([{ topic: "inventory", kind: "variant.inventory_changed", id: "prd_1" }]);
  });

  it("never copies other facts (no quantities, consents or channels)", () => {
    const [change] = changesForEvent({
      topic: "customer.consent_changed",
      resourceId: "cus_1",
      facts: { customerId: "cus_1", channel: "email", previousState: null, state: "subscribed", source: "checkout" } as never,
    });
    expect(change).toEqual({ topic: "customers", kind: "customer.consent_changed", id: "cus_1" });
  });
});

describe("publishRealtime", () => {
  it("sends one deduplicated RPC, and nothing without changes or a binding", async () => {
    const publish = vi.fn(async () => ({ sockets: 1 }));
    const env = { REALTIME_HUB: { idFromName: () => ({}), get: () => ({ publish }) } } as unknown as Env;
    await publishRealtime(env, [
      ...tableChanges(["inbox", "inbox"]),
      { topic: "inventory", kind: "variant.inventory_changed", id: "prd_1" },
      { topic: "inventory", kind: "variant.inventory_changed", id: "prd_1" },
    ]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith([
      { topic: "inbox", kind: "changed" },
      { topic: "inventory", kind: "variant.inventory_changed", id: "prd_1" },
    ]);
    await publishRealtime(env, []);
    await publishRealtime({} as Env, tableChanges(["inbox"]));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("swallows a hub failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { REALTIME_HUB: { idFromName: () => ({}), get: () => ({ publish: async () => { throw new Error("down"); } }) } } as unknown as Env;
    await expect(publishRealtime(env, tableChanges(["reviews"]))).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("dedupes exact repeats only", () => {
    expect(dedupeChanges([
      { topic: "orders", kind: "order.updated", id: "a", status: "confirmed" },
      { topic: "orders", kind: "order.updated", id: "a", status: "shipped" },
      { topic: "orders", kind: "order.updated", id: "a", status: "confirmed" },
    ])).toHaveLength(2);
  });
});

describe("hub frames and identity", () => {
  it("sends a socket only its topics and collapses a burst to one notice per topic", () => {
    const topics = new Set(["orders"]);
    expect(framesFor(topics, [{ topic: "orders", kind: "order.created", id: "o" }, { topic: "inbox", kind: "changed" }]))
      .toEqual([{ topic: "orders", kind: "order.created", id: "o" }]);
    const burst = Array.from({ length: 60 }, (_, index) => ({ topic: "orders" as const, kind: "order.updated", id: `o${index}` }));
    expect(framesFor(topics, burst)).toEqual([{ topic: "orders", kind: "changed" }]);
  });

  it("reads only a well-formed identity and drops unknown topics", () => {
    expect(parseIdentity(null)).toBeNull();
    expect(parseIdentity("{")).toBeNull();
    expect(parseIdentity(JSON.stringify({ userId: "", topics: [] }))).toBeNull();
    expect(parseIdentity(JSON.stringify({ userId: "usr_1", name: "Rahim", topics: ["orders", "secrets"] })))
      .toEqual({ userId: "usr_1", name: "Rahim", topics: ["orders"], edit: 0 });
  });

  it.each([undefined, null, -1, 1.5, "3", 2 ** 40])("defaults malformed edit grants to viewing only: %s", (edit) => {
    expect(parseIdentity(JSON.stringify({ userId: "usr_1", topics: ["products", "products"], edit })))
      .toMatchObject({ edit: 0, topics: ["products"] });
  });
});
