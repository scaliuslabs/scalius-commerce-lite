// Unit tests for the reference plugin with the SDK's test harness: the same
// runtime as the platform over an in-memory bridge.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import hello from "./index";

const cart = (subtotalMinor: number) => ({
  currency: "BDT",
  decimalPlaces: 2,
  channel: "online_store",
  lines: [],
  subtotalMinor,
  customer: null,
  destination: null,
  discountCodes: [],
});

describe("scalius.hello", () => {
  it("greets a paid order once and counts it", async () => {
    const harness = createPluginTestHarness(hello, {
      settings: { greeting: "Salam" },
      api: async () => ({ ok: true, status: 200, data: { status: "confirmed" }, error: null }),
    });
    expect(await harness.event("order.paid", { type: "order", id: "o1" })).toMatchObject({ ok: true });
    expect(harness.records.get("greetings")?.get("o1")).toMatchObject({ orderId: "o1", greeting: "Salam", orderStatus: "confirmed" });
    expect(harness.kv.get("paid_count")).toBe(1);
    expect(harness.logs).toEqual([{ level: "info", message: "Greeted a paid order", fields: { orderId: "o1", apiStatus: 200 } }]);
  });

  it("offers the welcome discount from the minimum subtotal", async () => {
    const harness = createPluginTestHarness(hello);
    expect((await harness.fn("checkout.discounts", { cart: cart(150_000) })).value).toEqual({
      discounts: [{ title: "Hello discount", target: { kind: "order" }, value: { type: "percentage", percent: 10 } }],
    });
    expect((await harness.fn("checkout.discounts", { cart: cart(99_999) })).value).toEqual({ discounts: [] });
  });

  it("answers the public greet route and counts visits", async () => {
    const harness = createPluginTestHarness(hello);
    expect((await harness.route("public", "greet", { query: { name: "Karim" } })).value).toEqual({ body: { message: "Hello, Karim!", visits: 1 } });
    expect((await harness.route("public", "greet")).value).toEqual({ body: { message: "Hello, friend!", visits: 2 } });
  });
});
