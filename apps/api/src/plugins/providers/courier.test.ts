// The courier port end to end: the contract run against an app courier (a
// fixture plugin through the bundled loader, the Workers Free path), booked,
// tracked and recovered through core delivery code on the migrated schema,
// and its tracking pushes through POST /webhooks/couriers/{id}. The
// Bangladesh pack's Pathao and Steadfast run the same way in
// ../bangladesh-couriers.*.test.ts.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  checkShipmentStatus,
  type Courier,
  type CourierCall,
  type CourierProviders,
} from "@scalius/core/modules/delivery";
import { bulkShipOrders, lookupUnknownOrderShipment } from "@scalius/core/modules/fulfilment";
import { activatePlugin, installPlugin, listPluginLogs, writePluginSettings } from "@scalius/core/modules/plugins";
import { PROVIDER_PORTS, ProviderError, type CourierShipmentInput } from "@scalius/shared/plugins/providers";
import { errorResponseFromError } from "../../utils/api-response";
import { pluginTestCtx, pluginTestEnv } from "../testing/fixtures";
import {
  PARCEL_COURIER_ID,
  PARCEL_FIXTURE_CODE,
  PARCEL_FIXTURE_ID,
  PARCEL_FIXTURE_MANIFEST,
  PARCEL_FIXTURE_SECRET,
} from "../testing/provider-fixture";

const sha256 = createHash("sha256").update(PARCEL_FIXTURE_CODE).digest("hex");
const fixture = vi.hoisted(() => ({ module: null as unknown }));

// The request's provider runtime, with the fixture compiled in as a bundled plugin.
vi.mock("./runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime")>();
  return {
    ...actual,
    requestProviderRuntime: (c: Parameters<typeof actual.requestProviderRuntime>[0]) => {
      const db = c.get("db");
      const ctx = pluginTestCtx();
      return {
        env: c.env,
        db,
        canRun: () => true,
        host: async () => {
          const [{ PluginHost }, { BundledLoader }] = await Promise.all([import("../host"), import("../loaders/bundled")]);
          const loader = new BundledLoader(
            { env: c.env, ctx, db: () => db, composedEnv: async () => c.env },
            { [PARCEL_FIXTURE_ID]: { version: "1.0.0", sha256, load: async () => fixture.module } },
          );
          return new PluginHost({ env: c.env, ctx, db, loaderFor: () => loader });
        },
      };
    },
  };
});

import { loadCourierProviders } from "./courier";
import { requestProviderRuntime } from "./runtime";
import { courierWebhookRoutes } from "../../routes/webhooks/couriers";
import { deliveryProvidersRoutes } from "../../routes/admin/settings/delivery-providers";

let workdir: string;
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "scalius-courier-fixture-"));
  const file = join(workdir, "parcel.mjs");
  writeFileSync(file, PARCEL_FIXTURE_CODE);
  fixture.module = await import(pathToFileURL(file).href);
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

/** The store's credential key: delivery rows and app settings are encrypted with it. */
const CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
let sqlite: DatabaseSync;
let db: Database;
let env: Env;

/** The couriers one request sees, reading the active courier apps as the API does. */
function requestCouriers(): Promise<CourierProviders> {
  return loadCourierProviders(requestProviderRuntime({ env, req: { raw: new Request("https://api.shop.test/") }, get: () => db }));
}

beforeEach(async () => {
  let binding: D1Database;
  ({ sqlite, db, binding } = createSqliteD1Database({ foreignKeys: true }));
  env = pluginTestEnv(binding, { CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY });
  sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  const installed = await installPlugin(db, { manifest: PARCEL_FIXTURE_MANIFEST, source: "upload", bundleSha256: sha256, actorUserId: "owner" });
  const configured = await writePluginSettings(db, PARCEL_FIXTURE_ID, { secret: PARCEL_FIXTURE_SECRET }, {
    expectedRevision: installed.revision,
    credentialEncryptionKey: CREDENTIAL_KEY,
  });
  await activatePlugin(db, PARCEL_FIXTURE_ID, { actorUserId: "owner", expectedRevision: configured.revision });
});
afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

const booking = (orderId: string): CourierShipmentInput => ({
  idempotencyKey: `shp_${orderId}`,
  orderId,
  recipient: {
    name: "Buyer", phone: "+8801712345678", address: "House 1, Road 2", cityId: "city_local", zoneId: "zone_local", areaId: null,
    cityName: "Dhaka", zoneName: "Gulshan", areaName: null, postalCode: null, country: "BD",
  },
  codAmountMinor: 16_000,
  currency: "BDT",
  decimalPlaces: 2,
  note: null,
  itemCount: 1,
  itemDescription: "Panjabi x1",
  options: { deliveryType: null, itemType: null, itemWeightKg: null },
});

interface Harness {
  courier: Courier;
  call: CourierCall;
}

async function appHarness(): Promise<Harness> {
  const courier = (await requestCouriers()).require(PARCEL_COURIER_ID);
  const setup = await courier.setup({
    id: "provider_parcel", type: PARCEL_COURIER_ID, isActive: true, credentials: "{}", config: "{}",
    lastTestAttemptAt: null, lastTestSuccessAt: null, lastTestFailureAt: null, lastTestSuccessFingerprint: null,
  }, CREDENTIAL_KEY);
  expect(setup.readiness).toMatchObject({ configured: true, tested: true });
  return { courier, call: { settings: setup.settings, signal: new AbortController().signal, db } };
}

describe("an app courier (bundled loader) implements the courier port", () => {
  const harness = appHarness;
  const port = PROVIDER_PORTS.courier;

  it("books a parcel and answers within the port", async () => {
    const { courier, call } = await harness();
    const booked = await courier.createShipment(booking("ORD-1"), call);
    expect(port.createShipment.output.safeParse(booked).success).toBe(true);
    const tracking = await courier.trackShipment({ externalId: booked.externalId }, call);
    expect(port.trackShipment.output.safeParse(tracking).success).toBe(true);
    expect(await courier.testConnection!({}, call)).toMatchObject({ ok: true });
  });

  it("finds a booking only when the courier confirms it", async () => {
    const { courier, call } = await harness();
    await courier.createShipment(booking("ORD-1"), call);
    const found = await courier.findShipment!({ orderId: "ORD-1" }, call);
    expect(port.findShipment.output.safeParse(found).success).toBe(true);
    expect(found).toMatchObject({ found: true, tracking: { status: expect.any(String) } });
    expect(await courier.findShipment!({ orderId: "ORD-NEVER" }, call)).toMatchObject({ found: false });
  });

  it("refuses certainly, or reports an answer it may have lost as uncertain", async () => {
    const { courier, call } = await harness();
    const declined = await courier.createShipment(booking("ORD-DECLINE"), call).then(() => null, (error: unknown) => error);
    expect(declined).toBeInstanceOf(ProviderError);
    expect(declined).toMatchObject({ category: "declined", uncertain: false });
    const lost = await courier.createShipment(booking("ORD-TIMEOUT"), call).then(() => null, (error: unknown) => error);
    expect(lost).toBeInstanceOf(ProviderError);
    expect(lost).toMatchObject({ category: "retryable", uncertain: true });
    // A booking whose answer was lost is found again, never booked blind.
    expect(await courier.findShipment!({ orderId: "ORD-TIMEOUT" }, call)).toMatchObject({ found: true });
  });

  it("never sends a recipient to a courier whose app is not approved for buyers' contact details", async () => {
    // A stored grant from before the protected customer data scopes.
    sqlite.prepare("UPDATE plugin_installations SET grant_json = json_set(grant_json, '$.scopes', json('[]')) WHERE plugin_id = ?").run(PARCEL_FIXTURE_ID);
    const courier = (await requestCouriers()).require(PARCEL_COURIER_ID);
    const setup = await courier.setup({
      id: "provider_parcel", type: PARCEL_COURIER_ID, isActive: true, credentials: "{}", config: "{}",
      lastTestAttemptAt: null, lastTestSuccessAt: null, lastTestFailureAt: null, lastTestSuccessFingerprint: null,
    }, CREDENTIAL_KEY);
    const call = { settings: setup.settings, signal: new AbortController().signal, db };
    await expect(courier.createShipment(booking("ORD-UNAPPROVED"), call)).rejects.toMatchObject({
      category: "misconfigured", code: "provider.customer_data_not_approved",
    });
    // Nothing reached the app: its log has no booking attempt.
    expect(sqlite.prepare("SELECT count(*) AS count FROM plugin_log_entries WHERE plugin_id = ? AND source = 'provider:parcel.createShipment'").get(PARCEL_FIXTURE_ID))
      .toEqual({ count: 0 });
  });
});

describe("app courier as a merchant's delivery provider", () => {
  function settingsApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/delivery-providers", deliveryProvidersRoutes);
    return app;
  }
  const save = (body: Record<string, unknown>) => settingsApp().request("/delivery-providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);

  it("is added without credentials of its own and judged by the app's readiness", async () => {
    const response = await save({ name: "Acme Parcel", type: PARCEL_COURIER_ID, isActive: true });
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await response.json() as { data: unknown }).data).toMatchObject({
      type: PARCEL_COURIER_ID,
      courierName: "Acme Parcel",
      readiness: { status: "ready", configured: true, tested: true, active: true, canCreateShipment: true },
    });
    expect(sqlite.prepare("SELECT credentials, config FROM delivery_providers").get()).toEqual({ credentials: "{}", config: "{}" });

    expect((await save({ name: "Acme Parcel", type: PARCEL_COURIER_ID, credentials: { apiKey: "x" } })).status).toBe(400);
    expect((await save({ name: "Acme Parcel", type: "acme.parcel" })).status).toBe(400);
  });

  it("cannot be switched on while its app is not active", async () => {
    sqlite.exec("UPDATE plugin_installations SET status = 'disabled'");
    const response = await save({ name: "Acme Parcel", type: PARCEL_COURIER_ID, isActive: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Delivery provider cannot be activated until required setup is complete." },
    });
    expect(sqlite.prepare("SELECT count(*) AS n FROM delivery_providers").get()).toEqual({ n: 0 });
  });
});

describe("app courier through core delivery", () => {
  const orderState = (id: string) => sqlite.prepare("SELECT status, version, shipment_claim_id FROM orders WHERE id = ?").get(id) as Record<string, unknown>;
  const shipmentsOf = (id: string) => sqlite.prepare(
    "SELECT id, provider_type, status, raw_status, external_id, tracking_id, tracking_url, metadata FROM delivery_shipments WHERE order_id = ? ORDER BY created_at, id",
  ).all(id) as Array<Record<string, unknown>>;

  async function seedOrder(id: string) {
    await db.insert(schema.orders).values({
      id, customerName: "Synthetic buyer", customerPhone: "+8801712345678", shippingAddress: "Synthetic audit address",
      city: "city_local", zone: "zone_local", cityName: "Dhaka", zoneName: "Gulshan",
      totalAmountMinor: 16_000, subtotalAmountMinor: 10_000, shippingAmountMinor: 6_000, balanceDueMinor: 16_000,
      currencyCode: "BDT", currencyDecimalPlaces: 2, status: "confirmed", paymentMethod: "cod", paymentStatus: "unpaid",
    });
    await db.insert(schema.orderItems).values({
      id: `item_${id}`, orderId: id, productId: "product_local", variantId: "variant_local",
      quantity: 1, unitPriceMinor: 10_000, lineSubtotalMinor: 10_000, taxableAmountMinor: 10_000,
    });
  }

  beforeEach(async () => {
    await db.insert(schema.places).values([
      { id: "city_local", name: "Dhaka", countryCode: "BD", level: 1, externalIds: "{}", metadata: "{}" },
      { id: "zone_local", name: "Gulshan", countryCode: "BD", level: 2, parentId: "city_local", externalIds: "{}", metadata: "{}" },
    ]);
    await db.insert(schema.products).values({ id: "product_local", name: "Panjabi", slug: "panjabi", priceMinor: 10_000 });
    await db.insert(schema.productVariants).values({ id: "variant_local", productId: "product_local", sku: "PANJABI-1", priceMinor: 10_000, isDefault: true, trackInventory: false });
    // The merchant's row for the app courier: no credentials of its own.
    await db.insert(schema.deliveryProviders).values({
      id: "provider_parcel", name: "Acme Parcel", type: PARCEL_COURIER_ID, isActive: true, credentials: "{}", config: "{}",
    });
  });

  const ship = (orderId: string) => bulkShipOrders(db, [orderId], "provider_parcel", {}, CREDENTIAL_KEY, requestCouriers);

  it("books, records and tracks an order through the app, with order money and contents", async () => {
    await seedOrder("ORD-1");
    const [result] = await ship("ORD-1");
    expect(result).toMatchObject({ orderId: "ORD-1", success: true });
    expect(orderState("ORD-1")).toMatchObject({ status: "shipped", shipment_claim_id: null });
    const [shipment] = shipmentsOf("ORD-1");
    expect(shipment).toMatchObject({
      provider_type: PARCEL_COURIER_ID,
      status: "pending",
      raw_status: "Booked",
      external_id: "AP-ORD-1",
      tracking_id: "TRK-ORD-1",
      tracking_url: "https://parcel.acme.test/t/TRK-ORD-1",
    });
    expect(JSON.parse(String(shipment!.metadata))).toEqual({ zone: "Gulshan", codMinor: 16_000, items: 1 });

    await expect(checkShipmentStatus(db, String(shipment!.id), CREDENTIAL_KEY, requestCouriers)).resolves.toMatchObject({
      status: "in_transit",
      rawStatus: "On the way",
    });
    expect(JSON.parse(String(shipmentsOf("ORD-1")[0]!.metadata))).toMatchObject({ hub: "Dhaka" });
  });

  it("fails a refused booking so it can be booked again", async () => {
    await seedOrder("ORD-DECLINE");
    expect((await ship("ORD-DECLINE"))[0]).toMatchObject({ success: false, error: "Acme Parcel does not deliver to this area." });
    expect(shipmentsOf("ORD-DECLINE")).toEqual([expect.objectContaining({ status: "failed", raw_status: "provider_rejected" })]);
    expect(orderState("ORD-DECLINE")).toMatchObject({ status: "confirmed", shipment_claim_id: null });
  });

  it("keeps a lost answer for reconciliation and recovers it through the app's lookup", async () => {
    await seedOrder("ORD-TIMEOUT");
    const [first] = await ship("ORD-TIMEOUT");
    expect(first).toMatchObject({ success: false, reconciliationRequired: true });
    const [held] = shipmentsOf("ORD-TIMEOUT");
    expect(held).toMatchObject({ status: "reconcile_required", raw_status: "provider_outcome_unknown", external_id: null });
    expect(orderState("ORD-TIMEOUT")).toMatchObject({ status: "confirmed", shipment_claim_id: held!.id });
    // The app's own message is masked: its secret never reaches the merchant or the row.
    expect(JSON.stringify([first, shipmentsOf("ORD-TIMEOUT")])).not.toContain(PARCEL_FIXTURE_SECRET);
    expect(JSON.stringify(await listPluginLogs(db, PARCEL_FIXTURE_ID))).not.toContain(PARCEL_FIXTURE_SECRET);

    // Never booked blind: a second attempt is fenced by the held claim.
    expect((await ship("ORD-TIMEOUT"))[0]).toMatchObject({ success: false });
    expect(shipmentsOf("ORD-TIMEOUT")).toHaveLength(1);

    const result = await lookupUnknownOrderShipment(db, {
      orderId: "ORD-TIMEOUT",
      shipmentId: String(held!.id),
      expectedOrderVersion: Number(orderState("ORD-TIMEOUT").version),
      operationKey: "00000000-0000-4000-8000-000000000101",
      actorId: "owner",
      encryptionKey: CREDENTIAL_KEY,
      couriers: requestCouriers,
    });
    expect(result).toMatchObject({ status: "repaired", resolution: "provider_confirmed_existing" });
    expect(orderState("ORD-TIMEOUT")).toMatchObject({ status: "shipped", shipment_claim_id: null });
    expect(shipmentsOf("ORD-TIMEOUT")[0]).toMatchObject({ external_id: "AP-ORD-TIMEOUT" });
  });

  describe("tracking pushes", () => {
    function webhookApp() {
      const app = new OpenAPIHono<{ Bindings: Env }>();
      app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
      });
      app.use("*", async (c, next) => {
        c.set("db", db);
        await next();
      });
      app.route("/webhooks/couriers", courierWebhookRoutes);
      return app;
    }
    const push = (body: Record<string, unknown>, signature = PARCEL_FIXTURE_SECRET, id = PARCEL_COURIER_ID) =>
      webhookApp().request(`/webhooks/couriers/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-parcel-signature": signature },
        body: JSON.stringify(body),
      }, env);
    const delivered = { id: "evt-1", consignment: "AP-ORD-1", state: "delivered", text: "Delivered to buyer" };
    const claims = () => sqlite.prepare("SELECT provider, event_type, status FROM webhook_events").all();

    beforeEach(async () => {
      await seedOrder("ORD-1");
      expect((await ship("ORD-1"))[0]).toMatchObject({ success: true });
    });

    it("applies an authentic push once and ignores its duplicate", async () => {
      const response = await push(delivered);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ received: true, status: "delivered" });
      expect(shipmentsOf("ORD-1")[0]).toMatchObject({ status: "delivered", raw_status: "Delivered to buyer" });
      expect(orderState("ORD-1")).toMatchObject({ status: "delivered" });
      expect(claims()).toEqual([{ provider: PARCEL_COURIER_ID, event_type: "courier.delivered", status: "processed" }]);

      const version = orderState("ORD-1").version;
      const again = await push(delivered);
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ received: true, duplicate: true, status: "processed" });
      expect(orderState("ORD-1").version).toBe(version);
      expect(claims()).toHaveLength(1);
    });

    it("rejects a forged push before anything changes", async () => {
      const response = await push(delivered, "forged-signature");
      expect(response.status).toBe(401);
      expect(shipmentsOf("ORD-1")[0]).toMatchObject({ status: "pending" });
      expect(orderState("ORD-1")).toMatchObject({ status: "shipped" });
      expect(claims()).toEqual([]);
    });

    it("acknowledges what applies to nothing, and only serves app couriers that verify pushes", async () => {
      expect(await (await push({ ...delivered, state: "note" })).json()).toEqual({ received: true });
      expect(await (await push({ ...delivered, consignment: "AP-UNKNOWN" })).json()).toEqual({ received: true, ignored: true });
      expect(claims()).toEqual([]);
      expect((await push(delivered, PARCEL_FIXTURE_SECRET, "pathao")).status).toBe(404);
      expect((await push(delivered, PARCEL_FIXTURE_SECRET, "acme.other:parcel")).status).toBe(404);
      sqlite.exec("UPDATE delivery_providers SET is_active = 0");
      expect((await push(delivered)).status).toBe(401);
    });
  });
});
