import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import type { PluginApiCallInput } from "@scalius/plugin-sdk";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { checkPluginHandlers, pluginHandlerInventory } from "@scalius/shared/plugins";
import { parsePluginPageOutput } from "@scalius/shared/plugins/storefront";
import { renderComponent, storefrontShown } from "@scalius/plugin-sdk/storefront/testing";
import plugin, { manifest } from "./index";
import { commissionOf } from "./model";
import { nextStatus } from "./splits";
import storefront from "./storefront";

/**
 * A proxied page answer as the store draws it: the app's page component
 * (a declared `page` target) from the answer's props, through the
 * storefront's output check ("" for a redirect or JSON).
 */
function pageHtml(value: unknown): string {
  const output = parsePluginPageOutput((value as { body: unknown }).body);
  if (!output || !("page" in output)) return "";
  const declared = manifest.storefront.components.find((component) => component.type === output.page.component);
  expect(declared?.targets).toContain("page");
  const html = renderComponent(storefront, output.page.component, "page", {}, { props: output.page.props });
  const shown = storefrontShown(html, manifest.id);
  expect(shown.dropped).toBe(0);
  return shown.html;
}

const ORDER = {
  id: "ord_1",
  orderNumber: 1001,
  currency: "BDT",
  status: "pending",
  lines: [
    { id: "li_1", productId: "p_earbuds", variantId: "v_1", title: "Earbuds", variantLabel: "Black", quantity: 2, subtotalMinor: 500_000, discountMinor: 0 },
    { id: "li_2", productId: "p_mixer", variantId: "v_2", title: "Mixer", variantLabel: null, quantity: 1, subtotalMinor: 1_900_000, discountMinor: 100_000 },
    { id: "li_3", productId: "p_house", variantId: "v_3", title: "House brand tea", variantLabel: null, quantity: 1, subtotalMinor: 30_000, discountMinor: 0 },
  ],
};

function store() {
  const calls: Array<{ op: string; input: PluginApiCallInput | undefined }> = [];
  const api = async (op: string, input: PluginApiCallInput | undefined) => {
    calls.push({ op, input });
    if (op === "dashboard.resources.orders.get") return { ok: true, status: 200, data: { success: true, data: ORDER }, error: null };
    if (op === "dashboard.resources.fulfillments.create") return { ok: true, status: 201, data: { success: true, data: {} }, error: null };
    if (op === "dashboard.resources.products.get") return { ok: true, status: 200, data: { success: true, data: { name: "Earbuds", slug: "earbuds", status: "active", priceMinor: 250_000, currency: "BDT", imageUrl: null, deletedAt: null } }, error: null };
    return { ok: false, status: 404, data: null, error: { code: "not_found", message: "" } };
  };
  return { calls, api };
}

async function marketplace() {
  const backend = store();
  const harness = createPluginTestHarness(plugin, { api: backend.api, settings: { default_commission_bps: 1000 }, staff: ["owner@store.test"] } as never);
  // Staff add two approved sellers (one with its own 15% rate) and give them products.
  for (const [name, commission] of [["Acme Audio", 1500], ["Kitchen Co", null]] as const) {
    const added = await harness.route("admin", "seller-add", { method: "POST", body: { values: { name, email: `${name.split(" ")[0]!.toLowerCase()}@sellers.test`, commission } } });
    expect(added.ok).toBe(true);
  }
  await harness.route("admin", "product-assign", { method: "POST", query: { id: "p_earbuds" }, body: { values: { seller: "sel_acme-audio" } } });
  await harness.route("admin", "product-assign", { method: "POST", query: { id: "p_mixer" }, body: { values: { seller: "sel_kitchen-co" } } });
  return { harness, backend };
}

describe("scalius.sellers manifest", () => {
  it("parses, and its module exports exactly the declared handlers", () => {
    const parsed = parsePluginManifest(manifest);
    if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
    expect(checkPluginHandlers(pluginHandlerInventory(parsed.manifest), plugin)).toEqual([]);
  });

  it("rounds commission half up in minor units", () => {
    expect(commissionOf(500_000, 1500)).toBe(75_000);
    expect(commissionOf(1_005, 1000)).toBe(101);
    expect(commissionOf(0, 1000)).toBe(0);
  });

  it("moves a split forward only, never out of cancelled or refunded", () => {
    expect(nextStatus("order.paid", "open")).toBe("paid");
    expect(nextStatus("order.paid", "fulfilled")).toBeNull();
    expect(nextStatus("order.fulfilled", "paid")).toBe("fulfilled");
    expect(nextStatus("order.cancelled", "fulfilled")).toBe("cancelled");
    expect(nextStatus("order.fulfilled", "cancelled")).toBeNull();
  });
});

describe("scalius.sellers catalogue", () => {
  it("writes the product's seller record and its public fields together", async () => {
    const { harness } = await marketplace();
    expect(harness.records.get("product_sellers")?.get("p_earbuds")).toMatchObject({ seller_id: "sel_acme-audio", seller_name: "Acme Audio", seller_status: "approved" });
    expect(harness.customFields.get("product:p_earbuds") ?? [...harness.customFields.entries()].find(([key]) => key.includes("p_earbuds"))?.[1])
      .toMatchObject({ seller_name: "Acme Audio", seller_handle: "acme-audio" });
  });

  it("blocks checkout of a suspended seller's products, from the declared read", async () => {
    const cart = fixtures.cart({ lines: [fixtures.cartLine({ lineId: "l1", productId: "p_earbuds", title: "Earbuds" }), fixtures.cartLine({ lineId: "l2", productId: "p_house", title: "Tea" })] });
    const result = await createPluginTestHarness(plugin).fn("cart.validate", {
      cart,
      reads: { owners: { p_earbuds: { revision: 2, data: { seller_id: "sel_acme-audio", seller_name: "Acme Audio", seller_status: "suspended", assigned_at: 1 } } } },
    });
    expect(result.value).toEqual({ errors: [{ code: "seller_unavailable", lineId: "l1", message: "Earbuds is not available from its seller right now." }] });
    const open = await createPluginTestHarness(plugin).fn("cart.validate", { cart, reads: { owners: {} } });
    expect(open.value).toEqual({ errors: [] });
  });
});

describe("scalius.sellers orders", () => {
  it("splits a placed order per seller once, with commission and net, and notes it", async () => {
    const { harness } = await marketplace();
    const event = { id: "evt_1", occurredAt: "2026-10-01T10:00:00.000Z" };
    expect((await harness.event("order.created", { type: "order", id: "ord_1" }, {}, event)).ok).toBe(true);
    expect((await harness.event("order.created", { type: "order", id: "ord_1" }, {}, event)).ok).toBe(true);
    const all = harness.records.get("order_splits");
    expect(all?.size).toBe(2);
    expect(all?.get("ord_1~sel_acme-audio")).toMatchObject({ subtotal_minor: 500_000, commission_minor: 75_000, net_minor: 425_000, item_count: 2, status: "open" });
    expect(all?.get("ord_1~sel_kitchen-co")).toMatchObject({ subtotal_minor: 1_800_000, commission_minor: 180_000, net_minor: 1_620_000 });
    // The store's own product stays out of every split; each seller is mailed once.
    expect(JSON.stringify([...all!.values()])).not.toContain("p_house");
    expect((harness.sent.emails as Array<{ subject: string }>).filter((message) => message.subject.startsWith("New order"))).toHaveLength(2);
    expect(harness.sent.timeline).toHaveLength(1);
  });

  it("moves splits with the order and settles fulfilled ones into payouts once", async () => {
    const { harness } = await marketplace();
    await harness.event("order.created", { type: "order", id: "ord_1" }, {}, { id: "evt_1", occurredAt: "2026-10-01T10:00:00.000Z" });
    await harness.event("order.fulfilled", { type: "order", id: "ord_1" }, {}, { id: "evt_2" });
    expect(harness.records.get("order_splits")?.get("ord_1~sel_acme-audio")).toMatchObject({ status: "fulfilled" });
    const draft = await harness.route("admin", "payouts-draft", { method: "POST" });
    expect(draft.ok ? null : draft).toBeNull();
    const drafted = [...(harness.records.get("payouts")?.values() ?? [])] as Array<Record<string, unknown>>;
    expect(drafted).toHaveLength(2);
    expect(drafted.find((payout) => payout.seller_id === "sel_acme-audio")).toMatchObject({ net_minor: 425_000, commission_minor: 75_000, split_count: 1, status: "draft" });
    // A second run finds nothing left to settle.
    await harness.route("admin", "payouts-draft", { method: "POST" });
    expect(harness.records.get("payouts")?.size).toBe(2);
    // A cancelled order after a payout leaves the settled split alone.
    await harness.event("order.cancelled", { type: "order", id: "ord_1" }, {}, { id: "evt_3" });
    expect(harness.records.get("order_splits")?.get("ord_1~sel_acme-audio")).toMatchObject({ status: "fulfilled" });
  });

  it("answers its pages and cards with valid UI documents", async () => {
    const { harness } = await marketplace();
    await harness.event("order.created", { type: "order", id: "ord_1" }, {}, { id: "evt_1" });
    for (const [route, query] of [["applications", {}], ["sellers", {}], ["payouts", {}], ["commissions", {}], ["product-card", { resource: "product", id: "p_earbuds" }], ["order-card", { resource: "order", id: "ord_1" }]] as const) {
      const answer = await harness.route("admin", route, { query });
      const document = parsePluginUiDocument((answer.value as { body: unknown }).body);
      expect(document.ok ? null : { route, document }).toBeNull();
    }
  });
});

describe("scalius.sellers portal", () => {
  it("takes an application from a signed-in customer and opens the portal", async () => {
    const harness = createPluginTestHarness(plugin, { api: store().api } as never);
    const guest = await harness.route("public", "apply", { headers: { accept: "text/html" } });
    expect(parsePluginPageOutput((guest.value as { body: unknown }).body)).toMatchObject({ page: { title: "Seller dashboard", component: "seller_portal" } });
    expect(pageHtml(guest.value)).toContain('href="/account"');
    const form = await harness.route("public", "apply", { customer: { id: "cus_9" } });
    expect(pageHtml(form.value)).toContain('action="/apps/scalius.sellers/apply"');
    // A refused application keeps what the buyer typed, as text.
    const bad = await harness.route("public", "apply", { method: "POST", customer: { id: "cus_9" }, body: { name: "<b>x</b>", email: "nope" } });
    expect((bad.value as { status?: number }).status).toBe(422);
    const refused = pageHtml(bad.value);
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('value="&lt;b&gt;x&lt;/b&gt;"');
    expect(refused).not.toContain("<b>");
    const applied = await harness.route("public", "apply", { method: "POST", customer: { id: "cus_9" }, body: { name: "Rina's Crafts", email: "rina@sellers.test" } });
    expect((applied.value as { body: unknown }).body).toEqual({ redirect: "/apps/scalius.sellers/portal" });
    expect(harness.records.get("sellers")?.get("sel_rina-s-crafts")).toMatchObject({ status: "pending", customer_id: "cus_9" });
    const portal = await harness.route("public", "portal", { customer: { id: "cus_9" } });
    expect(pageHtml(portal.value)).toContain("being reviewed");
  });

  it("lets a seller ship only their own split, as a fulfilment of exactly its lines", async () => {
    const { harness, backend } = await marketplace();
    // Link the Acme seller to a customer account.
    const acme = harness.records.get("sellers")!.get("sel_acme-audio") as Record<string, unknown>;
    harness.records.get("sellers")!.set("sel_acme-audio", { ...acme, customer_id: "cus_acme" });
    await harness.event("order.created", { type: "order", id: "ord_1" }, {}, { id: "evt_1" });
    const other = await harness.route("public", "portal", { method: "POST", subpath: "/ship", customer: { id: "cus_acme" }, body: { split: "ord_1~sel_kitchen-co" } });
    expect((other.value as { body: unknown }).body).toEqual({ redirect: "/apps/scalius.sellers/portal/orders" });
    expect(backend.calls.some((call) => call.op === "dashboard.resources.fulfillments.create")).toBe(false);
    await harness.route("public", "portal", { method: "POST", subpath: "/ship", customer: { id: "cus_acme" }, body: { split: "ord_1~sel_acme-audio", courier: "Pathao", tracking: "TRK1" } });
    const shipped = backend.calls.find((call) => call.op === "dashboard.resources.fulfillments.create")!;
    expect(shipped.input).toMatchObject({ path: { id: "ord_1" }, body: { kind: "ship", lines: [{ orderItemId: "li_1", quantity: 2 }], tracking: { courierName: "Pathao", trackingId: "TRK1" } } });
    expect(harness.records.get("order_splits")?.get("ord_1~sel_acme-audio")).toMatchObject({ status: "fulfilled" });
    // The orders page says so after the plain form post's redirect.
    const orders = pageHtml((await harness.route("public", "portal", { subpath: "/orders", query: { shipped: "1" }, customer: { id: "cus_acme" } })).value);
    expect(orders).toContain("Marked as shipped.");
    expect(orders).toContain("2 x Earbuds");
  });

  it("draws the portal from props: the split's net in the store's money, and a ship form posting to the app", async () => {
    const { harness } = await marketplace();
    const acme = harness.records.get("sellers")!.get("sel_acme-audio") as Record<string, unknown>;
    harness.records.get("sellers")!.set("sel_acme-audio", { ...acme, customer_id: "cus_acme" });
    await harness.event("order.created", { type: "order", id: "ord_1" }, {}, { id: "evt_1" });
    const home = await harness.route("public", "portal", { customer: { id: "cus_acme" } });
    expect((home.value as { headers?: Record<string, string> }).headers).toMatchObject({ "cache-control": "no-store" });
    const html = pageHtml(home.value);
    expect(html).toContain("Your shop is open.");
    expect(html).toContain('action="/apps/scalius.sellers/portal/ship"');
    expect(html).toContain('name="split" value="ord_1~sel_acme-audio"');
    expect(html).toContain("4,250");
    expect(html).toContain('href="/apps/scalius.sellers/store/acme-audio"');
  });

  it("shows a seller's public page only while approved", async () => {
    const { harness } = await marketplace();
    const open = await harness.route("public", "store", { subpath: "/acme-audio" });
    expect(pageHtml(open.value)).toContain("Earbuds");
    await harness.route("admin", "seller-status", { method: "POST", body: { sellerId: "sel_acme-audio", status: "suspended" } });
    const closed = await harness.route("public", "store", { subpath: "/acme-audio" });
    expect((closed.value as { status?: number }).status).toBe(404);
    expect(pageHtml(closed.value)).toContain("does not exist or is closed");
    expect(harness.records.get("product_sellers")?.get("p_earbuds")).toMatchObject({ seller_status: "suspended" });
  });
});
