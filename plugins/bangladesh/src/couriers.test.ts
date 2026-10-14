// Pathao and Steadfast over the SDK harness (the platform's runtime, inputs
// and answers validated against the courier port). Courier HTTP is scripted.
import { describe, expect, it } from "vitest";
import type { CourierShipmentInput } from "@scalius/plugin-sdk";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import pack, { manifest } from "./index";
import { mapPathaoStatus, mapSteadfastStatus, steadfastPushEventId } from "./couriers";

interface Call { url: string; method: string; headers: Record<string, string>; body: string | undefined }
type Reply = { status: number; body: string } | Error;

function harness(settings: Record<string, string | number>, reply: (call: Call) => Reply) {
  const calls: Call[] = [];
  const instance = createPluginTestHarness(pack, {
    settings,
    fetch: (url, init) => {
      const request = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
      const call = { url, method: request.method ?? "GET", headers: request.headers ?? {}, body: request.body };
      calls.push(call);
      const answer = reply(call);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { instance, calls };
}

const json = (body: unknown, status = 200): Reply => ({ status, body: JSON.stringify(body) });

const PATHAO = {
  pathao_client_id: "pathao-client-4821",
  pathao_client_secret: "pathao-secret-9417",
  pathao_username: "merchant@shop.test",
  pathao_password: "merchant-password-7813",
  pathao_store_id: "924",
  pathao_webhook_secret: "hook-secret-5521",
};
const STEADFAST = { steadfast_api_key: "sf-key-3391", steadfast_secret_key: "sf-secret-8812" };

const booking = (codAmountMinor: number, overrides: Partial<CourierShipmentInput["recipient"]> = {}): CourierShipmentInput => ({
  idempotencyKey: "shp_1",
  orderId: "ORD-1",
  recipient: {
    name: "Customer",
    phone: "+8801712345678",
    address: "House 1, Road 2",
    cityId: "city_1",
    zoneId: "zone_1",
    areaId: null,
    cityName: "Dhaka",
    zoneName: "Gulshan",
    areaName: null,
    postalCode: null,
    country: "BD",
    locationIds: { city: "1", zone: "52", area: null },
    ...overrides,
  },
  codAmountMinor,
  currency: "BDT",
  decimalPlaces: 2,
  note: null,
  itemCount: 2,
  itemDescription: "Panjabi x2",
  options: { deliveryType: null, itemType: null, itemWeightKg: null },
});

const push = (body: unknown, headers: Record<string, string>) => ({ method: "POST", rawBody: JSON.stringify(body), headers, query: {} });

describe("the Bangladesh pack's courier declarations", () => {
  it("declares Pathao and Steadfast for Bangladesh, with their own marks, tracking pages and Pathao's place ids", () => {
    expect(manifest.providers.courier).toEqual([
      expect.objectContaining({
        id: "pathao", countries: ["BD"], icon: "assets/pathao.svg",
        trackingUrl: "https://merchant.pathao.com/tracking?consignment_id={trackingId}",
        locations: { key: "pathao", required: ["city", "zone"], numeric: true },
      }),
      expect.objectContaining({ id: "steadfast", countries: ["BD"], icon: "assets/steadfast.svg", trackingUrl: "https://steadfast.com.bd/t/{trackingId}" }),
    ]);
    expect(manifest.permissions).toEqual(["settings.delivery_locations.import"]);
    expect(manifest.allowedHosts).toEqual(expect.arrayContaining(["api-hermes.pathao.com", "courier-api-sandbox.pathao.com", "portal.packzy.com"]));
  });
});

describe("status mapping (unchanged from core)", () => {
  it("maps Pathao's webhook events and order statuses", () => {
    expect(mapPathaoStatus("order.delivered")).toBe("delivered");
    expect(mapPathaoStatus("order.pickup-cancelled")).toBe("cancelled");
    expect(mapPathaoStatus("Pickup Cancel")).toBe("cancelled");
    expect(mapPathaoStatus("Pickup_Cancelled")).toBe("cancelled");
    expect(mapPathaoStatus("Assigned for Delivery")).toBe("out_for_delivery");
    expect(mapPathaoStatus("Payment Invoice")).toBe("delivered");
    expect(mapPathaoStatus("something new")).toBe("unknown");
  });

  it("maps Steadfast's statuses in any case", () => {
    expect(mapSteadfastStatus("Delivered")).toBe("delivered");
    expect(mapSteadfastStatus("cancelled_approval_pending")).toBe("on_hold");
    expect(mapSteadfastStatus("in_review")).toBe("pending");
    expect(mapSteadfastStatus("lost")).toBe("unknown");
  });
});

describe("Pathao", () => {
  const answers = (call: Call): Reply => {
    if (call.url.endsWith("/issue-token")) return json({ access_token: "token", expires_in: 7200 });
    if (call.url.endsWith("/aladdin/api/v1/orders")) return json({ code: 200, data: { consignment_id: "DL1001", order_status: "Pending", delivery_fee: 60, merchant_order_id: "ORD-1" } });
    return json({}, 404);
  };

  it("refuses fractional taka before any request", async () => {
    const { instance, calls } = harness(PATHAO, answers);
    const result = await instance.provider("pathao", "createShipment", booking(557_080));
    expect(result).toMatchObject({ ok: false, error: { category: "declined", uncertain: false, message: "Pathao requires a whole-taka COD amount. Use another courier for this balance." } });
    expect(calls).toHaveLength(0);
  });

  it.each([0, 50])("books whole-taka COD %s with the store's Pathao place ids, weight in kg and the merchant's defaults", async (taka) => {
    const { instance, calls } = harness(PATHAO, answers);
    const result = await instance.provider("pathao", "createShipment", booking(taka * 100));
    expect(result).toMatchObject({ ok: true, value: { externalId: "DL1001", trackingId: "DL1001", status: "pending", rawStatus: "Pending", chargeMinor: 6_000 } });
    expect(calls.map((call) => call.url)).toEqual(["https://api-hermes.pathao.com/aladdin/api/v1/issue-token", "https://api-hermes.pathao.com/aladdin/api/v1/orders"]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      store_id: 924,
      merchant_order_id: "ORD-1",
      recipient_name: "Customer",
      recipient_phone: "01712345678",
      recipient_address: "House 1, Road 2",
      recipient_city: 1,
      recipient_zone: 52,
      recipient_area: null,
      delivery_type: 48,
      item_type: 2,
      item_quantity: 2,
      item_weight: 0.5,
      item_description: "Panjabi x2",
      amount_to_collect: taka,
    });
    expect(calls[1]!.headers.Authorization).toBe("Bearer token");
  });

  it("takes the staff's choices on the booking form over the defaults", async () => {
    const { instance, calls } = harness({ ...PATHAO, pathao_item_weight: 2 }, answers);
    const input = booking(10_000);
    await instance.provider("pathao", "createShipment", { ...input, options: { deliveryType: 12, itemType: 1, itemWeightKg: 1.5 } });
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ delivery_type: 12, item_type: 1, item_weight: 1.5 });
  });

  it("refuses a booking without Pathao's city and zone ids before any request", async () => {
    const { instance, calls } = harness(PATHAO, answers);
    const result = await instance.provider("pathao", "createShipment", booking(10_000, { locationIds: { city: "1", zone: null, area: null } }));
    expect(result).toMatchObject({ ok: false, error: { category: "declined" } });
    expect(calls).toHaveLength(0);
  });

  it("fails certainly when nothing was sent, uncertainly when the answer was lost, and declines an explicit rejection", async () => {
    const noToken = harness(PATHAO, (call) => (call.url.endsWith("/issue-token") ? json({ message: "bad" }, 401) : json({})));
    expect(await noToken.instance.provider("pathao", "createShipment", booking(10_000))).toMatchObject({ ok: false, error: { category: "retryable", uncertain: false, code: "pathao.prepare_failed" } });
    expect(noToken.calls).toHaveLength(1);

    const lost = harness(PATHAO, (call) => (call.url.endsWith("/issue-token") ? json({ access_token: "t" }) : Object.assign(new Error("[http.timeout] timed out"), { code: "http.timeout" })));
    expect(await lost.instance.provider("pathao", "createShipment", booking(10_000))).toMatchObject({ ok: false, error: { category: "retryable", uncertain: true, code: "pathao.outcome_unknown" } });

    const refused = harness(PATHAO, (call) => (call.url.endsWith("/issue-token") ? json({ access_token: "t" }) : json({ code: 422, message: "Invalid", errors: { recipient_phone: ["bad"] } }, 422)));
    const result = await refused.instance.provider("pathao", "createShipment", booking(10_000));
    expect(result).toMatchObject({ ok: false, error: { category: "declined", code: "pathao.rejected" } });
    expect(JSON.stringify(result)).not.toContain("recipient_phone");

    const odd = harness(PATHAO, (call) => (call.url.endsWith("/issue-token") ? json({ access_token: "t" }) : json({ code: 500 }, 500)));
    expect(await odd.instance.provider("pathao", "createShipment", booking(10_000))).toMatchObject({ ok: false, error: { uncertain: true } });
  });

  it("tracks a consignment, and names an HTML failure by its title", async () => {
    const tracked = harness(PATHAO, (call) => (call.url.endsWith("/issue-token")
      ? json({ access_token: "t" })
      : json({ code: 200, data: { consignment_id: "DL1001", order_status: "Delivered", order_status_slug: "delivered", updated_at: "2026-10-01", invoice_id: null } })));
    const result = await tracked.instance.provider("pathao", "trackShipment", { externalId: "DL1001" });
    expect(result).toMatchObject({ ok: true, value: { status: "delivered", rawStatus: "Delivered", details: { order_status_slug: "delivered" } } });
    expect(tracked.calls[1]!.url).toBe("https://api-hermes.pathao.com/aladdin/api/v1/orders/DL1001/info");

    const html = harness(PATHAO, (call) => (call.url.endsWith("/issue-token") ? json({ access_token: "t" }) : { status: 502, body: "<!DOCTYPE html><html><title>Bad Gateway</title></html>" }));
    expect(await html.instance.provider("pathao", "trackShipment", { externalId: "DL1001" })).toMatchObject({ ok: false, error: { category: "retryable", message: "Pathao server error: Bad Gateway" } });
  });

  describe("connection test", () => {
    const stores = (pages: Record<number, Array<{ store_id: number | string; is_active: number }>>, lastPage = Object.keys(pages).length) => (call: Call): Reply => {
      if (call.url.endsWith("/issue-token")) return json({ access_token: "t" });
      const page = Number(new URL(call.url).searchParams.get("page") ?? 1);
      return json({ data: { current_page: page, last_page: lastPage, data: pages[page] ?? [] } });
    };

    it("is ready for an active store on a later page", async () => {
      const { instance, calls } = harness(PATHAO, stores({ 1: [{ store_id: 1, is_active: 1 }], 2: [{ store_id: 924, is_active: 1 }] }));
      expect(await instance.provider("pathao", "testConnection", {})).toMatchObject({ ok: true, value: { ok: true, message: "Connection successful" } });
      expect(calls.map((call) => call.url)).toContain("https://api-hermes.pathao.com/aladdin/api/v1/stores?page=2");
    });

    it("names an inactive store", async () => {
      const { instance } = harness(PATHAO, stores({ 1: [{ store_id: "924", is_active: 0 }] }));
      expect((await instance.provider("pathao", "testConnection", {})).value).toEqual({ ok: false, message: "Selected Pathao store is inactive. Choose an active store and test again." });
    });

    it("stops after ten pages and never repeats Pathao's authentication answer", async () => {
      const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, [{ store_id: index + 1000, is_active: 1 }]]));
      const { instance, calls } = harness(PATHAO, stores(many, 12));
      expect((await instance.provider("pathao", "testConnection", {})).value).toEqual({ ok: false, message: "Connection failed" });
      expect(calls).toHaveLength(11);
      const denied = harness(PATHAO, () => json({ message: "Invalid client secret pathao-secret-9417" }, 401));
      expect((await denied.instance.provider("pathao", "testConnection", {})).value).toEqual({ ok: false, message: "Connection failed" });
    });
  });

  describe("tracking pushes", () => {
    const signed = { "x-pathao-signature": PATHAO.pathao_webhook_secret, "content-type": "application/json" };

    it("accepts nothing without a secret, and refuses a missing or wrong signature", async () => {
      const { pathao_webhook_secret: _omit, ...withoutSecret } = PATHAO;
      expect(await harness(withoutSecret, answers).instance.provider("pathao", "verifyWebhook", push({ event: "order.delivered" }, signed)))
        .toMatchObject({ ok: false, error: { category: "misconfigured" } });
      const { instance } = harness(PATHAO, answers);
      expect((await instance.provider("pathao", "verifyWebhook", push({ event: "order.delivered" }, {}))).value).toMatchObject({ status: "invalid" });
      expect((await instance.provider("pathao", "verifyWebhook", push({ event: "order.delivered" }, { "x-pathao-signature": "hook-secret-5520" }))).value).toMatchObject({ status: "invalid" });
      expect((await instance.provider("pathao", "verifyWebhook", push({ event: "order.delivered" }, { "x-pathao-signature": "hook-secret-55210" }))).value).toMatchObject({ status: "invalid" });
    });

    it("passes Pathao's integration check with 202 and the merchant's own secret header", async () => {
      const { instance } = harness(PATHAO, answers);
      const result = await instance.provider("pathao", "verifyWebhook", push({ event: "webhook_integration" }, signed));
      expect(result.value).toEqual({
        status: "ignored",
        reason: "Pathao integration check.",
        reply: { status: 202, headers: { "x-pathao-merchant-webhook-integration-secret": "hook-secret-5521" }, body: { success: true, message: "Webhook integration verified" } },
      });
      expect((await instance.provider("pathao", "verifyWebhook", push({ event: "store.updated" }, signed))).value).toMatchObject({ status: "ignored", reply: { status: 202 } });
    });

    it("reads a status push with Pathao's event as its id and COD facts as details", async () => {
      const { instance } = harness(PATHAO, answers);
      const result = await instance.provider("pathao", "verifyWebhook", push({
        consignment_id: "DL1001", merchant_order_id: "ORD-1", event: "order.delivered", collected_amount: 1500, delivery_fee: 60, reason: "",
        recipient_phone: "01712345678",
      }, signed));
      expect(result.value).toMatchObject({
        status: "update",
        eventId: "order.delivered",
        externalId: "DL1001",
        tracking: { status: "delivered", rawStatus: "order.delivered", details: { collectedAmount: 1500, deliveryFee: 60 } },
        reply: { status: 202, headers: { "x-pathao-merchant-webhook-integration-secret": "hook-secret-5521" }, body: { success: true, status: "delivered" } },
      });
      expect(JSON.stringify(result.value)).not.toContain("01712345678");
    });

    it("answers a malformed authentic push 400", async () => {
      const { instance } = harness(PATHAO, answers);
      expect((await instance.provider("pathao", "verifyWebhook", push({ consignment_id: "DL1" }, signed))).value).toEqual({ status: "invalid", reason: "Missing event field", rejectStatus: 400 });
      expect((await instance.provider("pathao", "verifyWebhook", push({ event: "order.picked" }, signed))).value).toEqual({ status: "invalid", reason: "Missing consignment_id", rejectStatus: 400 });
    });
  });
});

describe("Steadfast", () => {
  const booked = (call: Call): Reply => {
    if (call.url.endsWith("/create_order")) {
      return json({ status: 200, consignment: { consignment_id: 924, invoice: "ORD-1", tracking_code: "SF924", recipient_name: "Customer", recipient_phone: "01712345678", recipient_address: "House 1", cod_amount: 1600.5, status: "in_review", note: null } });
    }
    return json({}, 404);
  };

  it("books with the full-text address and cash in taka, keeping no contact data", async () => {
    const { instance, calls } = harness(STEADFAST, booked);
    const result = await instance.provider("steadfast", "createShipment", { ...booking(160_050), note: "Call first" });
    expect(result).toMatchObject({ ok: true, value: { externalId: "924", trackingId: "SF924", status: "pending", rawStatus: "in_review", chargeMinor: null } });
    expect(calls[0]!.url).toBe("https://portal.packzy.com/api/v1/create_order");
    expect(calls[0]!.headers).toMatchObject({ "Api-Key": "sf-key-3391", "Secret-Key": "sf-secret-8812" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      invoice: "ORD-1",
      recipient_name: "Customer",
      recipient_phone: "01712345678",
      recipient_address: "House 1, Road 2, Gulshan, Dhaka",
      cod_amount: 1600.5,
      note: "Call first",
    });
    expect(JSON.stringify(result.value)).not.toMatch(/01712345678|recipient/);
  });

  it("declines an explicit rejection and keeps a lost answer for reconciliation", async () => {
    const refused = harness(STEADFAST, () => json({ status: 422, message: "Invalid" }, 422));
    expect(await refused.instance.provider("steadfast", "createShipment", booking(100))).toMatchObject({ ok: false, error: { category: "declined", code: "steadfast.rejected" } });
    const lost = harness(STEADFAST, () => new Error("[http.failed] network"));
    expect(await lost.instance.provider("steadfast", "createShipment", booking(100))).toMatchObject({ ok: false, error: { category: "retryable", uncertain: true } });
  });

  it("finds a booking by invoice only when Steadfast confirms it", async () => {
    const found = harness(STEADFAST, () => json({ status: 200, delivery_status: "delivered" }));
    expect((await found.instance.provider("steadfast", "findShipment", { orderId: "ORD 1" })).value).toMatchObject({ found: true, externalId: null, tracking: { status: "delivered" } });
    expect(found.calls[0]!.url).toBe("https://portal.packzy.com/api/v1/status_by_invoice/ORD%201");
    for (const reply of [json({}, 404), json({ status: 404 }), () => { throw new Error("x"); }]) {
      const missing = harness(STEADFAST, () => (typeof reply === "function" ? reply() : reply));
      expect((await missing.instance.provider("steadfast", "findShipment", { orderId: "ORD-1" })).value).toMatchObject({ found: false });
    }
  });

  it("tests the connection with the balance call", async () => {
    const { instance } = harness(STEADFAST, () => json({ status: 200, current_balance: 0 }));
    expect((await instance.provider("steadfast", "testConnection", {})).value).toEqual({ ok: true, message: "Connection successful" });
  });

  describe("tracking pushes", () => {
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    it("authenticates the bearer token with the webhook token, else the secret key", async () => {
      const own = harness({ ...STEADFAST, steadfast_webhook_secret: "callback-token-77" }, booked);
      const body = { notification_type: "delivery_status", consignment_id: 924, invoice: "ORD-1", status: "delivered" };
      expect((await own.instance.provider("steadfast", "verifyWebhook", push(body, bearer("callback-token-77")))).value).toMatchObject({ status: "update" });
      expect((await own.instance.provider("steadfast", "verifyWebhook", push(body, bearer("sf-secret-8812")))).value).toMatchObject({ status: "invalid" });
      const fallback = harness(STEADFAST, booked);
      expect((await fallback.instance.provider("steadfast", "verifyWebhook", push(body, { authorization: "bearer sf-secret-8812" }))).value).toMatchObject({ status: "update" });
      expect((await fallback.instance.provider("steadfast", "verifyWebhook", push(body, {}))).value).toMatchObject({ status: "invalid" });
    });

    it("reads a status push with its invoice, dedup identity and Steadfast's expected answer", async () => {
      const { instance } = harness(STEADFAST, booked);
      const result = await instance.provider("steadfast", "verifyWebhook", push({
        notification_type: "delivery_status", consignment_id: 924, invoice: "ORD-1", cod_amount: 1600, status: "Delivered", delivery_charge: 60, tracking_message: "Delivered to customer",
      }, bearer("sf-secret-8812")));
      expect(result.value).toEqual({
        status: "update",
        eventId: "delivery_status:delivered",
        externalId: "924",
        orderId: "ORD-1",
        tracking: { status: "delivered", rawStatus: "Delivered", updatedAt: expect.any(String), details: { codAmount: 1600, deliveryCharge: 60, lastTrackingMessage: "Delivered to customer" } },
        reply: { status: 200, body: { status: "success", message: "Webhook received successfully." } },
      });
    });

    it("keeps a tracking message as a note, and never collapses later messages or statuses", async () => {
      const { instance } = harness(STEADFAST, booked);
      const result = await instance.provider("steadfast", "verifyWebhook", push({
        notification_type: "tracking_update", consignment_id: 924, invoice: "ORD-1", tracking_message: "Reached hub", updated_at: "2026-10-01 10:00:00",
      }, bearer("sf-secret-8812")));
      expect(result.value).toMatchObject({ status: "note", externalId: "924", orderId: "ORD-1", details: { lastTrackingMessage: "Reached hub", lastTrackingUpdate: "2026-10-01 10:00:00" } });
      const first = steadfastPushEventId({ notification_type: "tracking_update", updated_at: "2026-10-01 10:00:00" });
      const second = steadfastPushEventId({ notification_type: "tracking_update", updated_at: "2026-10-01 11:00:00" });
      expect(first).not.toBe(second);
      expect(steadfastPushEventId({ notification_type: "delivery_status", status: "pending" })).not.toBe(steadfastPushEventId({ notification_type: "delivery_status", status: "delivered" }));
    });

    it("answers a malformed authentic push 400 and acknowledges one about no consignment", async () => {
      const { instance } = harness(STEADFAST, booked);
      expect((await instance.provider("steadfast", "verifyWebhook", push({ notification_type: "refund" }, bearer("sf-secret-8812")))).value).toMatchObject({ status: "invalid", rejectStatus: 400 });
      expect((await instance.provider("steadfast", "verifyWebhook", push({ notification_type: "delivery_status", consignment_id: 924 }, bearer("sf-secret-8812")))).value).toMatchObject({ status: "invalid", rejectStatus: 400 });
      expect((await instance.provider("steadfast", "verifyWebhook", push({ notification_type: "delivery_status", invoice: "ORD-1", status: "pending" }, bearer("sf-secret-8812")))).value).toMatchObject({ status: "ignored", reply: { status: 200 } });
    });
  });
});
