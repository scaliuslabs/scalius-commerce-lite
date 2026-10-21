// Subscriptions as an app, end to end through the host (bundled loader,
// migrated schema): the first order's provider payment keeps the buyer's
// card for their account; the app's order.created handler records a contract
// for the subscribed line; its renewal cron places the renewal invoice
// (`orders.create`) and charges the saved card off-session
// (`payments.charge`), through the app's own payment provider. A decline
// marks the contract past due and the next day's retry pays the same order;
// a lost provider answer is repeated under the same key and charges once.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, type PluginInstallation } from "@scalius/core/modules/plugins";
import { getObjectRecord } from "@scalius/core/modules/objects";
import { paymentMethodsDocument } from "@scalius/core/modules/settings";
import { LINE_PURCHASE_OPTION_PROPERTY_KEY } from "@scalius/shared/line-properties";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginHost } from "./host";
import { callPluginOperation } from "./api-call";
import { pluginTestCtx, pluginTestEnv, settleBackground } from "./testing/fixtures";
import { claimAndApplyPaymentEventNow } from "../routes/payment/payment-events";
import { CARD_PROVIDER, CARD_WEBHOOK_SIGNATURE, SUBSCRIBE_OPTION, manifest as subscriptionsManifest, type Contract } from "./testing/apps/subscriptions/src/index";

const DAY_MS = 86_400_000;
const PLACED_AT = "2026-10-01T09:00:00.000Z";

describe("subscriptions renewing through the host", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;
  let host: PluginHost;
  let installation: PluginInstallation;
  let env: Env;

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    const properties = JSON.stringify([{ key: LINE_PURCHASE_OPTION_PROPERTY_KEY, type: "text", label: "Purchase option", value: SUBSCRIBE_OPTION, displayValue: "Subscribe and save", priceMinor: 0 }]);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO customers (id, name, email, phone, account_claimed_at, email_verified_at)
      VALUES ('cust_1', 'Rahima', 'rahima@example.test', '+8801712345678', unixepoch(), unixepoch());
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_coffee', 'Coffee club', 'coffee-club', 120000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_coffee', 'p_coffee', 'COFFEE-1', 120000, 0, 0, 0, 1, 0, 'service');
      INSERT INTO orders (
        id, order_number, customer_id, account_owner_customer_id, customer_name, customer_phone, requires_shipping,
        currency_code, currency_decimal_places, subtotal_amount_minor, total_amount_minor, status, payment_method,
        payment_status, paid_amount_minor, balance_due_minor, version
      ) VALUES ('ord_first', 9001, 'cust_1', 'cust_1', 'Rahima', '+8801712345678', 0, 'BDT', 2, 120000, 120000,
        'pending', '${CARD_PROVIDER}', 'unpaid', 0, 120000, 1);
    `);
    sqlite.prepare(`
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
        unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor, properties)
      VALUES ('item_first', 'ord_first', 'p_coffee', 'v_coffee', 1, 'Coffee club', 0, 120000, 120000, 0, 0, 0, ?)
    `).run(properties);
    // Renewals are invoices the app charges at once: the store offers invoices.
    await paymentMethodsDocument.write(db, {
      enabledMethods: ["cod", "net_terms", CARD_PROVIDER],
      defaultMethod: "cod",
      netTerms: { dueInDays: 30, customerTags: [], segmentIds: [], appsDecide: false },
    });
    const installed = await installPlugin(db, {
      manifest: subscriptionsManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.subscriptions"]!.sha256, actorUserId: "owner",
    });
    installation = await activatePlugin(db, "acme.subscriptions", { actorUserId: "owner", expectedRevision: installed.revision });
    host = new PluginHost({ env, ctx: pluginTestCtx(), db });
  });
  afterEach(() => sqlite.close());

  const contractId = "ord_first:item_first";
  const contract = async () => await getObjectRecord(db, "acme.subscriptions", "contracts", contractId) as Contract | null;
  const renew = async (at: number) => {
    const outcome = await host.invokeCron(installation, "renew", new Date(at).toISOString());
    expect(outcome).toMatchObject({ ok: true });
    await settleBackground();
    return outcome;
  };
  const paymentsOf = (orderId: string) => sqlite.prepare(
    "SELECT status, payment_method, amount_minor FROM order_payments WHERE order_id = ? ORDER BY created_at, rowid",
  ).all(orderId);
  const orderOf = (orderId: string) => sqlite.prepare(
    "SELECT payment_method, payment_status, paid_amount_minor, balance_due_minor, account_owner_customer_id FROM orders WHERE id = ?",
  ).get(orderId);
  const setCard = (ref: string) => sqlite.prepare("UPDATE customer_payment_methods SET provider_method_ref = ?").run(ref);

  /** The first checkout's card payment, as the provider's signed webhook reports it, keeping the card. */
  async function payFirstOrder() {
    const verified = await host.invokeProvider(installation, "payment", "card", "verifyWebhook", {
      method: "POST",
      headers: { "x-acme-card-signature": CARD_WEBHOOK_SIGNATURE },
      query: {},
      rawBody: JSON.stringify({
        kind: "confirmed", eventType: "card.confirmed", eventId: "evt_first", orderId: "ord_first", providerRef: "ch_first",
        amountMinor: 120000, currency: "BDT", paymentType: "full",
        savedPaymentMethod: { ref: "pm_card_ok", brand: "visa", last4: "4242", expiryMonth: 12, expiryYear: 2030 },
      }),
    }) as { status: string; event: never };
    expect(verified.status).toBe("event");
    expect(await claimAndApplyPaymentEventNow({ db, env, ctx: pluginTestCtx(), provider: CARD_PROVIDER, event: verified.event, source: "webhook" }))
      .toBe("processed");
  }

  async function subscribe() {
    await payFirstOrder();
    expect(await host.invokeEvent(installation, {
      id: "evt_created_first",
      topic: "order.created",
      apiVersion: "2026-10",
      occurredAt: PLACED_AT,
      resource: { type: "order", id: "ord_first" },
      facts: { orderId: "ord_first", status: "pending", paymentStatus: "paid", channel: "online_store" },
    } as never)).toMatchObject({ ok: true });
  }

  it("keeps the card with the first payment, records the contract, and renews by charging the card", async () => {
    await subscribe();
    expect(sqlite.prepare("SELECT customer_id, provider_id, brand, last4, status, source_order_id FROM customer_payment_methods").all())
      .toEqual([{ customer_id: "cust_1", provider_id: CARD_PROVIDER, brand: "visa", last4: "4242", status: "active", source_order_id: "ord_first" }]);
    expect(await contract()).toMatchObject({
      customer_id: "cust_1", variant_id: "v_coffee", quantity: 1, unit_price_minor: 120000, status: "active", cycle: 0,
      next_run_at: Date.parse(PLACED_AT) + 30 * DAY_MS,
    });

    // Not due yet: nothing happens.
    expect(await renew(Date.parse(PLACED_AT) + 29 * DAY_MS)).toMatchObject({ ok: true });
    expect((await contract())!.cycle).toBe(0);

    expect(await renew(Date.parse(PLACED_AT) + 30 * DAY_MS)).toMatchObject({ ok: true });
    const renewed = (await contract())!;
    expect(renewed.pending_order_id ?? null).toBeNull();
    expect(renewed).toMatchObject({ status: "active", cycle: 1, declines: 0, next_run_at: Date.parse(PLACED_AT) + 60 * DAY_MS });
    const renewal = renewed.last_order_id!;
    // The invoice was paid by the saved card: switched to the provider, one payment.
    expect(orderOf(renewal)).toEqual({ payment_method: CARD_PROVIDER, payment_status: "paid", paid_amount_minor: 120000, balance_due_minor: 0, account_owner_customer_id: "cust_1" });
    expect(paymentsOf(renewal)).toEqual([{ status: "succeeded", payment_method: CARD_PROVIDER, amount_minor: 120000 }]);

    // The same slot again repeats nothing.
    await renew(Date.parse(PLACED_AT) + 30 * DAY_MS);
    expect((await contract())!.cycle).toBe(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 2 });
  });

  it("marks a declined renewal past due and pays the same invoice on the next day's retry", async () => {
    await subscribe();
    setCard("pm_decline_1");
    const due = Date.parse(PLACED_AT) + 30 * DAY_MS;
    await renew(due);
    const declined = (await contract())!;
    expect(declined).toMatchObject({ status: "past_due", declines: 1, cycle: 0, next_run_at: due + DAY_MS });
    const invoice = declined.pending_order_id!;
    expect(orderOf(invoice)).toMatchObject({ payment_method: "net_terms", payment_status: "unpaid", paid_amount_minor: 0 });
    expect(paymentsOf(invoice)).toEqual([]);

    setCard("pm_card_ok_2");
    await renew(due + DAY_MS);
    expect(await contract()).toMatchObject({ status: "active", declines: 0, cycle: 1, last_order_id: invoice });
    expect(orderOf(invoice)).toMatchObject({ payment_status: "paid" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 2 });
  });

  it("lists saved methods without the provider reference, and keeps charging to the app that kept them", async () => {
    await subscribe();
    const call = (pluginId: string, operation: string, input: unknown, version = "1.0.0") =>
      callPluginOperation({ pluginId, version, operationId: operation, input, db, env, ctx: pluginTestCtx() });
    const listed = await call("acme.subscriptions", "payment_methods.list", { query: { customerId: "cust_1" } });
    expect(listed).toMatchObject({ ok: true, data: { paymentMethods: [{
      customerId: "cust_1", providerId: CARD_PROVIDER, brand: "visa", last4: "4242",
      ownerAppId: "acme.subscriptions", purchaseOptionId: SUBSCRIBE_OPTION,
    }] } });
    expect(JSON.stringify(listed)).not.toContain("pm_card_ok");
    const methodId = (listed.data as { paymentMethods: Array<{ id: string }> }).paymentMethods[0]!.id;

    // Security audit N3: another app that writes orders and records payments
    // (write_payments) cannot charge a card; with the charge scope it still
    // cannot see or charge a card another app's purchase option kept.
    const tagger = BUNDLED_PLUGINS["acme.order-tagger"]!;
    const { manifest: taggerManifest } = await import("./testing/apps/order-tagger/src/index");
    const recordOnly = { ...taggerManifest, scopes: [...taggerManifest.scopes, "write_payments"] } as typeof taggerManifest;
    const installedTagger = await installPlugin(db, { manifest: recordOnly, source: "bundled", bundleSha256: tagger.sha256, actorUserId: "owner" });
    await activatePlugin(db, "acme.order-tagger", { actorUserId: "owner", expectedRevision: installedTagger.revision });
    expect(await call("acme.order-tagger", "payments.charge", { path: { id: "ord_first" }, body: { paymentMethodId: methodId }, idempotencyKey: "tagger-charge-1" }, taggerManifest.version))
      .toMatchObject({ ok: false, status: 403 });

    const guard = BUNDLED_PLUGINS["acme.risk-guard"]!;
    const { manifest: guardManifest } = await import("./testing/apps/risk-guard/src/index");
    const charger = { ...guardManifest, scopes: [...guardManifest.scopes, "write_payments", "write_payment_methods"] } as typeof guardManifest;
    const installedGuard = await installPlugin(db, { manifest: charger, source: "bundled", bundleSha256: guard.sha256, actorUserId: "owner" });
    await activatePlugin(db, "acme.risk-guard", { actorUserId: "owner", expectedRevision: installedGuard.revision });
    expect(await call("acme.risk-guard", "payment_methods.list", { query: { customerId: "cust_1" } }, guardManifest.version))
      .toMatchObject({ ok: true, data: { paymentMethods: [] } });
    expect(await call("acme.risk-guard", "payments.charge", { path: { id: "ord_first" }, body: { paymentMethodId: methodId }, idempotencyKey: "guard-charge-1" }, guardManifest.version))
      .toMatchObject({ ok: false, status: 404 });
    expect(await call("acme.risk-guard", "payment_methods.delete", { path: { id: methodId }, idempotencyKey: "guard-delete-1" }, guardManifest.version))
      .toMatchObject({ ok: false, status: 404 });
    // Charging needs the key.
    expect(await call("acme.subscriptions", "payments.charge", { path: { id: "ord_first" }, body: { paymentMethodId: methodId } }))
      .toMatchObject({ ok: false, status: 400, error: { code: "idempotency_key_required" } });
  });

  it("repeats a charge whose answer was lost under the same key, charging once", async () => {
    await subscribe();
    setCard("pm_lost_1");
    const due = Date.parse(PLACED_AT) + 30 * DAY_MS;
    await renew(due);
    const open = (await contract())!;
    expect(open).toMatchObject({ status: "active", cycle: 0, declines: 0 });
    const invoice = open.pending_order_id!;
    expect(orderOf(invoice)).toMatchObject({ payment_status: "unpaid" });

    await renew(due);
    expect(await contract()).toMatchObject({ cycle: 1, last_order_id: invoice });
    expect(paymentsOf(invoice)).toEqual([{ status: "succeeded", payment_method: CARD_PROVIDER, amount_minor: 120000 }]);
  });
});
