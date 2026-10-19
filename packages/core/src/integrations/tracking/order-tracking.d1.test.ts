// Audit spec S4 acceptance (b), (c), (d), (g) on the real checkout commit:
// the consent snapshot commits in the order's batch; Meta's Purchase CAPI
// carries fbp, fbc, IP and UA with event_time = commit time and is skipped
// when marketing is denied; GA4 sends one purchase per transaction_id and a
// refund once the refund is confirmed; TikTok shares Meta's event id; the
// snapshot is purged after 8 days.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database, type SqliteD1Statement } from "@scalius/database/testing/sqlite-d1";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "../../modules/checkout/attempts";
import { loadStorefrontCheckoutAuthority } from "../../modules/checkout/authority";
import { commitStorefrontOrderPayload } from "../../modules/checkout/commit";
import { createStorefrontOrder, createTrustedStorefrontCheckoutPolicySnapshot } from "../../modules/checkout/prepare";
import type { CreateStorefrontOrderInput } from "../../modules/orders/types";
import { metaConversionsDocument } from "../../modules/settings";
import { processExistingMetaPurchaseOutboxForOrder } from "../meta/purchase-outbox";
import { flushTrackingDeliveries, processTrackingDeliveriesForOrder, runTrackingSweep } from "./deliveries";
import { getTrackingHealth } from "../../modules/analytics/tracking-health";
import { ga4MeasurementDocument, tiktokEventsDocument } from "./settings";
import {
  purgeExpiredTrackingSignals,
  resolveOrderTrackingSnapshot,
  TRACKING_SIGNALS_RETENTION_SECONDS,
  type CheckoutTrackingRequest,
} from "./signals";

const KEY = btoa("0123456789abcdef0123456789abcdef");
const STORE = "https://shop.example.com";
const BROWSER: CheckoutTrackingRequest = {
  consent: { analytics: true, marketing: true, saleOfData: true },
  gpc: false,
  signals: {
    fbp: "fb.1.1790000000000.1234567890",
    fbc: "fb.1.1790000000000.IwAR0abcdefgh",
    ttp: "ttp_abcdefgh123",
    ttclid: "E.C.P.abcdefgh12345",
    gaClientId: "1234567890.1790000000",
    gaSessionId: "1790000123",
    gclid: "Cj0KCQabcdefgh",
  },
  clientIp: "203.0.113.7",
  userAgent: "Mozilla/5.0 (test)",
};

type Captured = { url: string; body: Record<string, unknown> };

describe("order tracking signals and server purchases (audit spec S4)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let batches: Array<readonly SqliteD1Statement[]>;
  let sent: Captured[];
  let fetcher: typeof fetch;

  beforeEach(async () => {
    batches = [];
    ({ sqlite, db } = createSqliteD1Database({
      beforeBatch(_sqlite, statements) {
        batches.push(statements);
      },
    }));
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tee', 'Tee', 'tee', 50000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tee', 'p_tee', 'TEE-1', 50000, 0, 0, 0, 1, 0, 'physical');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address, pickup_hours)
      VALUES ('m_pickup', 'Store pickup', 0, 'pickup', 'Shop 4, Gulshan 1', '10am-8pm');
    `);
    await metaConversionsDocument.write(db, { pixelId: "1234567890123", accessToken: "EAAB-live-token-value", isEnabled: true }, { encryptionKey: KEY });
    await ga4MeasurementDocument.write(db, { isEnabled: true, measurementId: "G-TEST1234", apiSecret: "mp-secret-value-01", debugMode: false }, { encryptionKey: KEY });
    await tiktokEventsDocument.write(db, { isEnabled: true, pixelCode: "C4ABCDEF0123456789", accessToken: "tiktok-live-token-01", testEventCode: "TEST12345" }, { encryptionKey: KEY });
    sent = [];
    fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url.includes("graph.facebook.com")) return Response.json({ events_received: 1, fbtrace_id: "trace" });
      if (url.includes("business-api.tiktok.com")) return Response.json({ code: 0, message: "OK" });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetcher);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  async function checkout(request: CheckoutTrackingRequest | null, options: { country?: string; staleAuthority?: boolean; noSnapshot?: boolean } = {}) {
    const data: CreateStorefrontOrderInput = {
      checkoutRequestId: `request_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
      customerName: "Tracking Buyer",
      customerPhone: "+8801712345678",
      customerEmail: "buyer@example.com",
      shippingAddress: null,
      city: null,
      zone: null,
      area: null,
      notes: null,
      discountCodes: [],
      shippingCharge: 0,
      shippingMethodId: "m_pickup",
      paymentMethod: "cod",
      inventoryPool: "regular",
      items: [{ productId: "p_tee", variantId: "v_tee", quantity: 2, price: 500 }],
    };
    const authority = await loadStorefrontCheckoutAuthority(db, {
      items: data.items,
      inventoryPool: data.inventoryPool,
      shippingMethodId: data.shippingMethodId,
      customerPhone: data.customerPhone,
    }, KEY);
    expect(authority.sideEffects).toMatchObject({ metaPurchase: true, tracking: { ga4: true, tiktok: true } });
    const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
    const result = await createStorefrontOrder(
      db,
      data,
      `${STORE}/api/v1/orders`,
      { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
      authority.cartValidation,
      authority.deliveryPreflight,
      undefined,
      { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: false,
        authorityRevision: authority.authorityRevision,
        orderCreatedNotificationEnabled: false,
        metaPurchaseEnabled: authority.sideEffects.metaPurchase,
      }),
      authority.taxAuthority,
    );
    result.commitPayload.trackingSnapshot = resolveOrderTrackingSnapshot({
      request,
      orderCountry: options.country ?? "BD",
      consentSettings: authority.sideEffects.tracking.consent,
      destinations: { meta: authority.sideEffects.metaPurchase, ga4: authority.sideEffects.tracking.ga4, tiktok: authority.sideEffects.tracking.tiktok },
    });
    if (options.noSnapshot) result.commitPayload.trackingSnapshot = null;
    if (options.staleAuthority) sqlite.exec("UPDATE checkout_authority SET revision = revision + 1 WHERE id = 'default'");
    batches = [];
    await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
    return result.orderId;
  }

  const signalsRow = (orderId: string) => sqlite.prepare("SELECT * FROM order_tracking_signals WHERE order_id = ?").get(orderId) as Record<string, unknown> | undefined;
  const deliveries = (orderId: string) => sqlite.prepare("SELECT destination, event_name, status, last_error, match_signals FROM tracking_deliveries WHERE order_id = ? ORDER BY destination, event_name").all(orderId);
  const runtime = { storefrontUrl: STORE, encryptionKey: KEY };

  it("(b) commits the snapshot in the order's one batch and sends Meta's Purchase with fbp, fbc, IP, UA at commit time", async () => {
    const orderId = await checkout(BROWSER);
    expect(batches).toHaveLength(1);
    const tables = batches[0]!.map((statement) => /insert\s+(?:or\s+\w+\s+)?into\s+[`"]?([a-z_]+)/i.exec(statement.query)?.[1]).filter(Boolean);
    expect(tables).toEqual(expect.arrayContaining(["orders", "meta_capi_purchase_outbox", "order_tracking_signals", "tracking_deliveries"]));
    for (const statement of batches[0]!) expect(statement.values.length).toBeLessThanOrEqual(100);
    const row = signalsRow(orderId)!;
    expect(row).toMatchObject({ consent_marketing: 1, consent_source: "banner", fbp: BROWSER.signals.fbp, client_ip: "203.0.113.7" });

    await processExistingMetaPurchaseOutboxForOrder({ db, orderId, source: "storefront-order", storefrontUrl: STORE, encryptionKey: KEY });
    const meta = sent.find((call) => call.url.includes("graph.facebook.com"))!;
    const event = (meta.body.data as Array<Record<string, any>>)[0]!;
    expect(event.event_id).toBe(`Purchase:${orderId}`);
    expect(event.event_time).toBe(row.created_at);
    expect(event.user_data).toMatchObject({
      fbp: BROWSER.signals.fbp,
      fbc: BROWSER.signals.fbc,
      client_ip_address: "203.0.113.7",
      client_user_agent: "Mozilla/5.0 (test)",
    });
    expect(event.user_data.em).toHaveLength(1);
    expect(event.data_processing_options).toBeUndefined();
  });

  it("(b) skips Meta's Purchase when the snapshot denies marketing (EEA, no choice) and keeps no ad ids", async () => {
    const orderId = await checkout({ ...BROWSER, consent: null }, { country: "DE" });
    expect(signalsRow(orderId)).toMatchObject({ consent_marketing: 0, consent_analytics: 0, consent_source: "default", fbp: null, client_ip: null, user_agent: null, ga_client_id: null });
    // Nothing is owed to GA4 or TikTok without consent.
    expect(deliveries(orderId)).toEqual([]);
    const outcome = await processExistingMetaPurchaseOutboxForOrder({ db, orderId, source: "storefront-order", storefrontUrl: STORE, encryptionKey: KEY });
    expect(outcome.status).toBe("skipped");
    expect(sent.filter((call) => call.url.includes("graph.facebook.com"))).toEqual([]);
    expect(sqlite.prepare("SELECT status, last_error FROM meta_capi_purchase_outbox WHERE order_id = ?").get(orderId))
      .toMatchObject({ status: "skipped", last_error: expect.stringMatching(/^consent_denied/) });
  });

  it("GPC denies marketing and sale of data; a US buyer's sale-of-data refusal sends Meta Limited Data Use", async () => {
    const gpc = await checkout({ ...BROWSER, gpc: true });
    expect(signalsRow(gpc)).toMatchObject({ consent_marketing: 0, consent_sale_of_data: 0, consent_analytics: 1, consent_source: "gpc" });
    const ldu = await checkout({ ...BROWSER, consent: { analytics: true, marketing: true, saleOfData: false } }, { country: "US" });
    await processExistingMetaPurchaseOutboxForOrder({ db, orderId: ldu, source: "storefront-order", storefrontUrl: STORE, encryptionKey: KEY });
    const event = (sent.find((call) => call.url.includes("graph.facebook.com"))!.body.data as Array<Record<string, unknown>>)[0]!;
    expect(event).toMatchObject({ data_processing_options: ["LDU"], data_processing_options_country: 0, data_processing_options_state: 0 });
  });

  it("costs the commit batch at most two statements and three rows (the snapshot and the GA4/TikTok purchases)", async () => {
    const changes = () => Number((sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    // The same buyer each time (the first order creates the customer).
    await checkout(BROWSER, { noSnapshot: true });
    let before = changes();
    await checkout(BROWSER, { noSnapshot: true });
    const plain = { statements: batches[0]!.length, rows: changes() - before };
    before = changes();
    await checkout(BROWSER);
    const tracked = { statements: batches[0]!.length, rows: changes() - before };
    expect(tracked.statements - plain.statements).toBe(2);
    expect(tracked.rows - plain.rows).toBe(3);
    // Marketing and analytics denied: the snapshot alone (no delivery is owed).
    before = changes();
    await checkout({ ...BROWSER, consent: { analytics: false, marketing: false, saleOfData: false } });
    expect({ statements: batches[0]!.length - plain.statements, rows: changes() - before - plain.rows }).toEqual({ statements: 1, rows: 1 });
  });

  it("writes nothing when the commit batch fails (the snapshot is atomic with the order)", async () => {
    await expect(checkout(BROWSER, { staleAuthority: true })).rejects.toThrow();
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_tracking_signals").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM tracking_deliveries").get()).toEqual({ n: 0 });
  });

  it("(c) sends the GA4 purchase once per transaction_id and a refund once it is confirmed", async () => {
    const orderId = await checkout(BROWSER);
    await processTrackingDeliveriesForOrder(db, orderId, runtime);
    await processTrackingDeliveriesForOrder(db, orderId, runtime);
    await flushTrackingDeliveries(db, { ...runtime, limit: 25 });
    const ga4 = () => sent.filter((call) => call.url.startsWith("https://www.google-analytics.com/mp/collect"));
    expect(ga4()).toHaveLength(1);
    const purchase = ga4()[0]!;
    expect(new URL(purchase.url).searchParams.get("measurement_id")).toBe("G-TEST1234");
    expect(purchase.body).toMatchObject({
      client_id: "1234567890.1790000000",
      consent: { ad_user_data: "GRANTED", ad_personalization: "GRANTED" },
      events: [{ name: "purchase", params: { transaction_id: orderId, currency: "BDT", value: 1000, session_id: "1790000123" } }],
    });
    expect(deliveries(orderId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination: "ga4", event_name: "purchase", status: "sent", match_signals: "client_id,session_id,user_id" }),
    ]));

    // A pending refund queues nothing; its confirmation queues one GA4 refund.
    sqlite.prepare("INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status) VALUES ('pay_refund_1', ?, 40000, 'BDT', 'cod', 'refund', 'pending')").run(orderId);
    expect(deliveries(orderId).filter((row: any) => row.event_name === "refund")).toEqual([]);
    sqlite.exec("UPDATE order_payments SET status = 'refunded' WHERE id = 'pay_refund_1'");
    sqlite.exec("UPDATE order_payments SET updated_at = updated_at + 1 WHERE id = 'pay_refund_1'");
    await flushTrackingDeliveries(db, { ...runtime, limit: 25 });
    await flushTrackingDeliveries(db, { ...runtime, limit: 25 });
    const refunds = ga4().filter((call) => (call.body.events as Array<{ name: string }>)[0]!.name === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.body).toMatchObject({ events: [{ name: "refund", params: { transaction_id: orderId, value: 400 } }] });
  });

  it("queues no GA4 refund for an order whose GA4 purchase was never sent", async () => {
    const orderId = await checkout({ ...BROWSER, consent: { analytics: false, marketing: true, saleOfData: true } });
    sqlite.prepare("INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status) VALUES ('pay_refund_2', ?, 1000, 'BDT', 'cod', 'refund', 'refunded')").run(orderId);
    expect(deliveries(orderId).map((row: any) => `${row.destination}:${row.event_name}`)).toEqual(["tiktok:purchase"]);
  });

  it("(d) TikTok's Events API Purchase shares Meta's event id and carries hashed contact plus ttp, ttclid, IP and UA", async () => {
    const orderId = await checkout(BROWSER);
    await processExistingMetaPurchaseOutboxForOrder({ db, orderId, source: "storefront-order", storefrontUrl: STORE, encryptionKey: KEY });
    await processTrackingDeliveriesForOrder(db, orderId, runtime);
    const metaEvent = (sent.find((call) => call.url.includes("graph.facebook.com"))!.body.data as Array<{ event_id: string }>)[0]!;
    const tiktok = sent.find((call) => call.url.includes("business-api.tiktok.com"))!;
    const tiktokEvent = (tiktok.body.data as Array<Record<string, any>>)[0]!;
    expect(tiktokEvent.event).toBe("Purchase");
    expect(tiktokEvent.event_id).toBe(metaEvent.event_id);
    expect(tiktok.body).toMatchObject({ event_source: "web", event_source_id: "C4ABCDEF0123456789", test_event_code: "TEST12345" });
    expect(tiktokEvent.user).toMatchObject({ ttp: BROWSER.signals.ttp, ttclid: BROWSER.signals.ttclid, ip: "203.0.113.7", user_agent: "Mozilla/5.0 (test)" });
    expect(tiktokEvent.user.email[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(tiktok.body)).not.toContain("buyer@example.com");
    expect(tiktokEvent.event_time).toBe(signalsRow(orderId)!.created_at);
  });

  it("(e) tracking_health reports consent outcomes, match-signal coverage and delivery status per destination, with no identifier", async () => {
    const granted = await checkout(BROWSER);
    await checkout({ ...BROWSER, consent: null }, { country: "DE" });
    await processExistingMetaPurchaseOutboxForOrder({ db, orderId: granted, source: "storefront-order", storefrontUrl: STORE, encryptionKey: KEY });
    await processTrackingDeliveriesForOrder(db, granted, runtime);
    const health = await getTrackingHealth(db, { encryptionKey: KEY });
    expect(health.consent).toMatchObject({ orders: 2, marketingGranted: 1, analyticsGranted: 1, bySource: { banner: 1, default: 1, gpc: 0 } });
    expect(health.matchSignalCoverage).toEqual({
      orders: 2,
      percent: expect.objectContaining({ em: 100, ph: 100, fbp: 50, fbc: 50, ip: 50, ua: 50, ttp: 50, gaClientId: 50 }),
    });
    const byDestination = Object.fromEntries(health.destinations.map((destination) => [destination.destination, destination]));
    expect(byDestination.meta).toMatchObject({ configured: true, testMode: false, skippedByConsent: 0 });
    expect(byDestination.meta!.events.find((event) => event.event === "Purchase")).toMatchObject({ sent: 1, pending: 1 });
    expect(byDestination.ga4).toMatchObject({ configured: true, testMode: false, skippedByConsent: 1, matchSignals: { client_id: 1, session_id: 1, user_id: 1 } });
    expect(byDestination.ga4!.events).toEqual([{ event: "purchase", sent: 1, failed: 0, skipped: 0, pending: 0 }]);
    expect(byDestination.tiktok).toMatchObject({ configured: true, testMode: true, skippedByConsent: 1, matchSignals: expect.objectContaining({ email: 1, ttp: 1, ip: 1 }) });
    const text = JSON.stringify(health);
    for (const secret of ["buyer@example.com", "203.0.113.7", BROWSER.signals.fbp!, "+8801712345678", granted]) expect(text).not.toContain(secret);
  });

  it("(g) purges a snapshot after 8 days, not before", async () => {
    const orderId = await checkout(BROWSER);
    const createdAt = Number(signalsRow(orderId)!.created_at);
    expect(await purgeExpiredTrackingSignals(db, { limit: 100, nowSeconds: createdAt + 7 * 86_400 })).toBe(0);
    expect(signalsRow(orderId)).toBeDefined();
    expect(await purgeExpiredTrackingSignals(db, { limit: 100, nowSeconds: createdAt + TRACKING_SIGNALS_RETENTION_SECONDS + 1 })).toBe(1);
    expect(signalsRow(orderId)).toBeUndefined();

    // The cron's sweep (one batch with Meta's due rows) purges the same way.
    const later = await checkout(BROWSER);
    const laterAt = Number(signalsRow(later)!.created_at);
    const swept = await runTrackingSweep(db, { ...runtime, limit: 5, purgeLimit: 50, purgeAt: laterAt + TRACKING_SIGNALS_RETENTION_SECONDS + 1 });

    expect(swept).toMatchObject({ signalsPurged: 1, scanned: 4, sent: 4 });
    expect(signalsRow(later)).toBeUndefined();
  });
});
