// Unit tests for Order tagger with the SDK's test harness (the platform's
// runtime over an in-memory bridge; ctx.api answers from the callback).
import { describe, expect, it } from "vitest";
import { createPluginTestHarness, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import type { PluginApiCallInput } from "@scalius/plugin-sdk";
import tagger from "./index";

function api(totalAmount = 1500) {
  const calls: Array<{ operationId: string; input: PluginApiCallInput | undefined }> = [];
  return {
    calls,
    answer: async (operationId: string, input: PluginApiCallInput | undefined) => {
      calls.push({ operationId, input });
      if (operationId === "dashboard.orders.get") return { ok: true, status: 200, data: { id: input?.path?.id, totalAmount }, error: null };
      return { ok: false, status: 404, data: null, error: { code: "api.unknown_operation", message: operationId } };
    },
  };
}

describe("acme.order-tagger", () => {
  it("tags a paid order once: reads it, adds a typed timeline line keyed by the event, sets its tag field", async () => {
    const calls = api();
    const harness = createPluginTestHarness(tagger, { api: calls.answer, settings: { tag: "vip" } });
    expect(await harness.event("order.paid", { type: "order", id: "ord_1" })).toMatchObject({ ok: true });
    expect(harness.sent.timeline).toEqual([{
      orderId: "ord_1",
      kind: "tagged",
      message: "#vip · Payment received. Ready to pack.",
      fields: { tag: "vip" },
      idempotencyKey: expect.stringMatching(/^evt_test_[0-9a-f]+$/),
    }]);
    expect(harness.customFields.get("order:ord_1")).toEqual({ tag: "vip" });
    expect(harness.records.get("tagged")?.get("ord_1")).toMatchObject({ orderId: "ord_1", tag: "vip" });

    // A redelivered event changes nothing and calls nothing.
    const before = calls.calls.length;
    expect(await harness.event("order.paid", { type: "order", id: "ord_1" })).toMatchObject({ ok: true });
    expect(calls.calls.length).toBe(before);
  });

  it("leaves orders below the minimum untagged, and fails (for a retry) when the order cannot be read", async () => {
    const small = api(100);
    const harness = createPluginTestHarness(tagger, { api: small.answer, settings: { min_total: 500 } });
    expect(await harness.event("order.paid", { type: "order", id: "ord_2" })).toMatchObject({ ok: true });
    expect(small.calls.map((call) => call.operationId)).toEqual(["dashboard.orders.get"]);
    expect(harness.records.get("tagged")?.get("ord_2")).toMatchObject({ tag: null });

    const broken = createPluginTestHarness(tagger, {
      api: async () => ({ ok: false, status: 503, data: null, error: { code: "unavailable", message: "down" } }),
    });
    const outcome = await broken.event("order.paid", { type: "order", id: "ord_3" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toMatch(/could not be read \(unavailable\)/);
    expect(broken.records.get("tagged")?.size).toBe(0);
  });

  it("summarizes what it handled on its admin page, as a UI document the dashboard draws", async () => {
    const calls = api();
    const harness = createPluginTestHarness(tagger, { api: calls.answer });
    await harness.event("order.paid", { type: "order", id: "ord_a" }, {}, { occurredAt: "2026-10-03T08:00:00.000Z" });
    const page = parsePluginUiDocument(((await harness.route("admin", "summary")).value as { body: unknown }).body);
    expect(page).toMatchObject({
      ok: true,
      document: {
        version: 1,
        root: {
          type: "page",
          title: "Order tagger",
          children: [
            { type: "stat", label: "Orders handled", value: 1 },
            { type: "card", children: [{ type: "table", rows: [{ id: "ord_a", to: { kind: "resource", resource: "order", id: "ord_a" }, cells: { tag: { badge: "#paid" }, at: { date: "2026-10-03T08:00:00.000Z" } } }] }] },
          ],
        },
      },
    });
  });
});
