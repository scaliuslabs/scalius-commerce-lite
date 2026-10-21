import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import riskGuard from "./index";

describe("acme.risk-guard", () => {
  it("advises on every new order and holds one whose buyer cancelled or returned enough, once", async () => {
    const harness = createPluginTestHarness(riskGuard, { riskHistory: (orderId) => (orderId === "o_risky" ? { orders: 4, cancelled: 1, returnedToSender: 1 } : { orders: 1, cancelled: 0, returnedToSender: 0 }) });
    const risky = fixtures.event("order.created", { id: "evt_1", resource: { type: "order", id: "o_risky" } });
    expect(await harness.deliver(risky)).toMatchObject({ ok: true });
    expect(await harness.deliver(risky)).toMatchObject({ ok: true });
    expect(await harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "o_fine" } }))).toMatchObject({ ok: true });
    expect(harness.sent.risks).toEqual([
      { orderId: "o_risky", level: "high", reasons: ["2 of 4 earlier orders were cancelled or returned."] },
      { orderId: "o_fine", level: "low", reasons: [] },
    ]);
    expect(harness.sent.holds).toEqual([{ orderId: "o_risky", reason: "2 of 4 earlier orders were cancelled or returned." }]);
  });

  it("is refused without the order scopes, as on the platform", async () => {
    const readOnly = { ...riskGuard, manifest: { ...riskGuard.manifest, scopes: ["read_orders" as const] } };
    const harness = createPluginTestHarness(readOnly);
    expect(await harness.deliver(fixtures.event("order.created"))).toMatchObject({ ok: false, error: { code: "orders_not_allowed" } });
  });
});
