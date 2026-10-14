// Unit tests for the reference plugin with the SDK's test harness: the same
// runtime as the platform over an in-memory bridge.
import { describe, expect, it } from "vitest";
import {
  createPluginTestHarness,
  parsePluginUiActionResult,
  parsePluginUiDocument,
  pluginUiRouteActions,
} from "@scalius/plugin-sdk/testing";
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
  market: { id: "mkt_backup", country: null },
  attributes: {},
});

describe("acme.hello", () => {
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

  it("takes visits by POST (JSON or form) and caches the public count briefly", async () => {
    const harness = createPluginTestHarness(hello);
    expect((await harness.route("public", "visits", { method: "POST", body: { name: "Rina" } })).value)
      .toEqual({ status: 201, body: { message: "Welcome, Rina!", visits: 1 } });
    expect((await harness.route("public", "visits", { method: "POST", body: {} })).value).toMatchObject({ status: 422 });
    expect((await harness.route("public", "visits")).value).toEqual({ headers: { "cache-control": "public, max-age=60" }, body: { visits: 1 } });
  });

  it("counts each created order once, even when the event is redelivered", async () => {
    const harness = createPluginTestHarness(hello);
    expect((await harness.event("order.created", { type: "order", id: "o1" }, {}, { id: "evt_1" })).ok).toBe(true);
    expect((await harness.event("order.created", { type: "order", id: "o1" }, {}, { id: "evt_1" })).ok).toBe(true);
    expect(harness.kv.get("created_count")).toBe(1);
    expect((await harness.event("order.created", { type: "order", id: "o2" }, {}, { id: "evt_2" })).ok).toBe(true);
    expect(harness.kv.get("created_count")).toBe(2);
  });

  it("answers its page, order card and home widget with valid UI documents", async () => {
    const harness = createPluginTestHarness(hello, {
      api: async () => ({ ok: true, status: 200, data: { status: "paid" }, error: null }),
    });
    await harness.event("order.paid", { type: "order", id: "o1" }, {}, { occurredAt: "2026-10-01T10:00:00.000Z" });
    const page = parsePluginUiDocument(((await harness.route("admin", "dashboard")).value as { body: unknown }).body);
    expect(page).toMatchObject({ ok: true, document: { root: { type: "page", title: "Hello" } } });
    if (!page.ok) throw new Error("invalid page");
    expect(pluginUiRouteActions(page.document.root).map((action) => action.route)).toEqual(["reset"]);
    expect(JSON.stringify(page.document)).toContain('"resource":"order","id":"o1"');

    const card = parsePluginUiDocument(((await harness.route("admin", "order-card", { query: { resource: "order", id: "o1" } })).value as { body: unknown }).body);
    expect(card).toMatchObject({ ok: true });
    expect(JSON.stringify(card)).toContain("Greeted");
    const unknownCard = parsePluginUiDocument(((await harness.route("admin", "order-card", { query: { resource: "order", id: "o9" } })).value as { body: unknown }).body);
    expect(JSON.stringify(unknownCard)).toContain("Not greeted yet");

    expect(parsePluginUiDocument(((await harness.route("admin", "widget")).value as { body: unknown }).body)).toMatchObject({ ok: true });
  });

  it("waves at the products a bulk action selects and answers with a toast", async () => {
    const harness = createPluginTestHarness(hello);
    const result = (await harness.route("admin", "wave", { method: "POST", body: { resource: "product", ids: ["p1", "p2"], action: "wave" } })).value as { body: unknown };
    expect(parsePluginUiActionResult(result.body)).toEqual({ toast: { message: "Hello to 2 products!", tone: "success" } });
    expect(harness.kv.get("waves")).toBe(2);
    expect((await harness.route("admin", "wave", { method: "POST", body: { resource: "product", ids: [] } })).value).toMatchObject({ status: 422 });
  });

  it("draws its section and product block from settings alone, escaped", async () => {
    const harness = createPluginTestHarness(hello);
    const section = (await harness.render("section", "greeting", { settings: { heading: "Eid <sale>", text: "" } })).value as { body: { html: string; head: unknown } };
    expect(section.body.html).toContain("Eid &#60;sale&#62;");
    expect(section.body.head).toEqual({ meta: [{ name: "hello-greeting", content: "Eid <sale>" }] });
    const block = (await harness.render("product-block", "note", { product: { id: "p1", slug: "linen", categoryId: null, brandId: null } })).value as { body: { html: string } };
    expect(block.body.html).toContain("Packed with care.");
    expect((await harness.render("product-block", "note", { settings: { note: "" }, product: { id: "p1", slug: "linen", categoryId: null, brandId: null } })).value)
      .toEqual({ body: { html: "" } });
  });

  it("accepts a ping only with a valid HMAC of the raw body", async () => {
    const secret = "ping-secret-123";
    const rawBody = JSON.stringify({ hello: "world" });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const unset = createPluginTestHarness(hello);
    expect((await unset.route("webhooks", "ping", { method: "POST", rawBody })).value).toMatchObject({ status: 503 });
    const harness = createPluginTestHarness(hello, { settings: { webhook_secret: secret } });
    expect((await harness.route("webhooks", "ping", { method: "POST", rawBody, headers: { "x-hello-signature": "00" } })).value).toMatchObject({ status: 401 });
    expect((await harness.route("webhooks", "ping", { method: "POST", rawBody, body: { hello: "world" }, headers: { "x-hello-signature": signature } })).value)
      .toEqual({ body: { received: true } });
    expect(harness.kv.get("last_ping")).toEqual({ hello: "world" });
  });
});
