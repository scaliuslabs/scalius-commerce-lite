// Behaviour tests for the payment gateway port. The kernel parts run on the
// migrated SQLite schema against a test-only adapter registered with one
// registry line (./testing.ts): if these pass, a new gateway needs nothing else
// from payment application, refunds, or reconciliation.
import type { DatabaseSync } from "node:sqlite";

import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { orders, OrderStatus, PaymentRecordStatus, PaymentStatus, webhookEvents } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ProviderError } from "@scalius/shared/plugins/providers/kinds";

import { processPaymentConfirmed } from "../process-payment";
import { processRefund } from "../refund-service";
import {
  reconcileDueRefundAttempts,
  reconcileExternalRefundWebhooks,
  reconcileRefundAttemptForOrder,
  REFUND_OBSERVED_EVENT_TYPE,
} from "../refund-reconciliation";
import { buildPaymentCorrelationId, parsePaymentCorrelationId, PAYMENT_CORRELATION_ID_MAX_LENGTH } from "./correlation";
import { BUILT_IN_PAYMENT_GATEWAY_IDS } from "./identity";
import type { GatewayRequest } from "./port";
import { BUILT_IN_PAYMENT_PROVIDERS, paymentProvidersFor, type PaymentProviders } from "./registry";
import { isOnlinePaymentMethod } from "./identity";
import { stripeGateway } from "./stripe";
import { createFakeGateway, FAKE_GATEWAY_ID, type FakeGatewayState } from "./testing";

function request(init: Partial<GatewayRequest> & { rawBody?: string }): GatewayRequest {
  return { method: "POST", rawBody: "", headers: {}, query: {}, ...init };
}

const call = <S,>(settings: S) => ({ settings, signal: new AbortController().signal });
const {
  filterForCurrency: filterPaymentMethodsForCurrency,
  currencyIssue: getPaymentMethodCurrencyIssue,
  precommitIssue: getCheckoutGatewayPrecommitIssue,
} = BUILT_IN_PAYMENT_PROVIDERS;
const isPaymentMethodCurrencyEligible = (id: string, currency: string) => getPaymentMethodCurrencyIssue(id, currency) === null;

describe("built-in gateway registry", () => {
  it("lists the built-in adapters under the ids identity checks know", () => {
    expect(BUILT_IN_PAYMENT_PROVIDERS.gateways.map((gateway) => gateway.id)).toEqual([...BUILT_IN_PAYMENT_GATEWAY_IDS]);
    expect(BUILT_IN_PAYMENT_PROVIDERS.methodIds()).toEqual(["stripe", "cod", "net_terms"]);
  });
});

describe("an app gateway (SSLCommerz, the Bangladesh pack's)", () => {
  const PACK_SSLCOMMERZ = "scalius.bangladesh:sslcommerz";

  it("is an online method that resolves by its qualified id only", () => {
    expect(isOnlinePaymentMethod(PACK_SSLCOMMERZ)).toBe(true);
    expect(isOnlinePaymentMethod("sslcommerz")).toBe(false);
    const { gateway, providers } = createFakeGateway(PACK_SSLCOMMERZ);
    expect(providers.get(PACK_SSLCOMMERZ)).toBe(gateway);
    expect(providers.get("sslcommerz")).toBeUndefined();
    expect(providers.methodIds()).toContain(PACK_SSLCOMMERZ);
  });

  it("reads the app providers for an app id, and only then", async () => {
    let loads = 0;
    const app = createFakeGateway(PACK_SSLCOMMERZ);
    const source = async () => {
      loads += 1;
      return app.providers;
    };
    expect(await paymentProvidersFor(source, "stripe")).toBe(BUILT_IN_PAYMENT_PROVIDERS);
    expect(loads).toBe(0);
    expect((await paymentProvidersFor(source, PACK_SSLCOMMERZ)).get(PACK_SSLCOMMERZ)).toBe(app.gateway);
    expect(loads).toBe(1);
  });
});

describe("registry currency and limit policy", () => {
  const app = createFakeGateway();
  const providers = app.providers;

  it("keeps every method for BDT and drops a BDT-only gateway elsewhere without touching the saved order", () => {
    expect(providers.filterForCurrency(["stripe", FAKE_GATEWAY_ID, "cod"], "BDT")).toEqual(["stripe", FAKE_GATEWAY_ID, "cod"]);
    expect(providers.filterForCurrency([FAKE_GATEWAY_ID, "cod", "stripe", "unknown"], "usd")).toEqual(["cod", "stripe"]);
    expect(providers.currencyIssue(FAKE_GATEWAY_ID, "USD"))
      .toBe("FakePay checkout requires the store currency to be BDT. Current currency: USD.");
  });

  it("fails closed for unknown methods and unsupported currencies", () => {
    expect(isPaymentMethodCurrencyEligible("unknown", "BDT")).toBe(false);
    expect(isPaymentMethodCurrencyEligible("stripe", "XYZ")).toBe(false);
    expect(filterPaymentMethodsForCurrency(["stripe", "cod"], "XYZ")).toEqual([]);
  });

  it("checks the first online charge against provider limits before an order commits", () => {
    const input = { paymentMethod: FAKE_GATEWAY_ID, currencyCode: "BDT", partialPaymentEnabled: false, partialPaymentAmount: 0 };
    expect(providers.precommitIssue({ ...input, totalAmountMinor: 1_000 })).toBeNull();
    expect(providers.precommitIssue({ ...input, totalAmountMinor: 999 }))
      .toBe("FakePay payment amount must be between 10.00 BDT and 100000.00 BDT.");
    // A configured advance below the total is the first charge.
    expect(providers.precommitIssue({ ...input, totalAmountMinor: 60_000_000, partialPaymentEnabled: true, partialPaymentAmount: 500 }))
      .toBeNull();
    expect(getCheckoutGatewayPrecommitIssue({ ...input, paymentMethod: "cod", totalAmountMinor: 100 })).toBeNull();
  });

  it("encodes every payment path through one amount codec and refuses what a wire form cannot carry", () => {
    const { amountIssue, encodeAmount } = BUILT_IN_PAYMENT_PROVIDERS;
    // Cash on delivery collects whole taka; other currencies collect what is owed.
    expect(encodeAmount("cod", 12_550, "BDT")).toMatchObject({ chargedMinor: 12_500, roundingMinor: 50 });
    expect(amountIssue("cod", 12_550, "BDT"))
      .toBe("Cash on delivery collects whole taka, so 125.50 BDT can't be paid on delivery. Choose an online payment method.");
    expect(amountIssue("cod", 12_500, "BDT")).toBeNull();
    expect(amountIssue("cod", 1_999, "USD")).toBeNull();
    // Stripe's wire forms: two-decimal ISK, three-decimal currencies in tens.
    expect(encodeAmount("stripe", 1_500, "ISK")).toMatchObject({ roundingMinor: 0, wire: { minor: 150_000, decimal: "1500.00" } });
    expect(amountIssue("stripe", 12_345, "KWD"))
      .toBe("Stripe cannot charge 12.345 KWD exactly (it would drop 0.005). Set prices in steps the provider accepts.");
    expect(amountIssue("stripe", 12_340, "KWD")).toBeNull();
    expect(getCheckoutGatewayPrecommitIssue({
      paymentMethod: "stripe", currencyCode: "KWD", totalAmountMinor: 12_345, partialPaymentEnabled: false, partialPaymentAmount: 0,
    })).toMatch(/^Stripe cannot charge 12\.345 KWD exactly/);
    // A gateway without codecs takes ISO minor units as they are (SSLCommerz).
    expect(providers.encodeAmount(FAKE_GATEWAY_ID, 12_550, "BDT")).toMatchObject({ chargedMinor: 12_550, roundingMinor: 0 });
    expect(createFakeGateway("scalius.bangladesh:sslcommerz").providers.encodeAmount("scalius.bangladesh:sslcommerz", 12_550, "BDT"))
      .toMatchObject({ chargedMinor: 12_550, roundingMinor: 0 });
  });
});

describe("payment correlation ids", () => {
  it("keeps short order ids readable and round-trips long ones within 30 characters", () => {
    const readable = buildPaymentCorrelationId("A39K02", "deposit", "abc12345");
    expect(readable).toBe("A39K02_deposit_ABC12345");
    expect(parsePaymentCorrelationId(readable)).toEqual({ orderId: "A39K02", paymentType: "deposit" });

    const compact = buildPaymentCorrelationId("01K2V8X7M4P3N6QT", "deposit", "abc12345");
    expect(compact).toBe("01K2V8X7M4P3N6QT_DABC12345");
    expect(compact.length).toBeLessThanOrEqual(PAYMENT_CORRELATION_ID_MAX_LENGTH);
    expect(parsePaymentCorrelationId(compact)).toEqual({ orderId: "01K2V8X7M4P3N6QT", paymentType: "deposit" });
  });
});

describe("Stripe adapter", () => {
  const settings = { secretKey: "sk_test_x", publishableKey: "pk_test_x", webhookSecret: "whsec_test", enabled: true };

  async function signed(event: Record<string, unknown>) {
    const rawBody = JSON.stringify({ object: "event", api_version: "2024-06-20", created: 1, ...event });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload: rawBody, secret: settings.webhookSecret });
    return request({ rawBody, headers: { "stripe-signature": signature } });
  }

  it("normalizes an authentic succeeded event to integer minor units and rejects a tampered body", async () => {
    const authentic = await signed({
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: { object: {
        id: "pi_1", object: "payment_intent", amount_received: 12_550, currency: "bdt",
        latest_charge: "ch_1", metadata: { orderId: "order_1", paymentType: "deposit" },
      } },
    });
    await expect(stripeGateway.verifyWebhook(authentic, call(settings))).resolves.toEqual({
      status: "event",
      event: {
        kind: "confirmed", eventType: "payment_intent.succeeded", eventId: "evt_1", orderId: "order_1",
        providerRef: "pi_1", secondaryRef: "ch_1", amountMinor: 12_550, currency: "BDT", paymentType: "deposit",
      },
    });
    await expect(stripeGateway.verifyWebhook({ ...authentic, rawBody: `${authentic.rawBody} ` }, call(settings)))
      .resolves.toMatchObject({ status: "invalid" });
  });

  it("reports Stripe's wire amounts back in ISO minor units, never a value its codec could not have sent", async () => {
    const succeeded = (id: string, amount: number) => signed({
      id, type: "payment_intent.succeeded",
      data: { object: {
        id: `pi_${id}`, object: "payment_intent", amount_received: amount, currency: "isk",
        latest_charge: `ch_${id}`, metadata: { orderId: "order_isk" },
      } },
    });
    // ISK is sent to Stripe as a two-decimal value: 150000 is 1500 krónur.
    await expect(stripeGateway.verifyWebhook(await succeeded("evt_isk", 150_000), call(settings)))
      .resolves.toMatchObject({ status: "event", event: { amountMinor: 1_500, currency: "ISK" } });
    // A fraction of a króna is not an amount: the kernel refuses NaN.
    await expect(stripeGateway.verifyWebhook(await succeeded("evt_odd", 150_050), call(settings)))
      .resolves.toMatchObject({ status: "event", event: { amountMinor: Number.NaN } });
  });

  it("ignores authentic events the kernel does not act on", async () => {
    const other = await signed({ id: "evt_2", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } });
    await expect(stripeGateway.verifyWebhook(other, call(settings))).resolves.toMatchObject({ status: "ignored" });
  });
});

describe("gateway kernel with an app provider's adapter", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let state: FakeGatewayState;
  let providers: PaymentProviders;

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ({ sqlite, db } = createSqliteD1Database());
    ({ state, providers } = createFakeGateway());
    await db.insert(orders).values({
      id: "order_1",
      customerName: "Buyer",
      customerPhone: "+8801711111111",
      shippingAddress: "Dhaka",
      city: "dhaka",
      zone: "zone_1",
      totalAmountMinor: 10_000,
      balanceDueMinor: 10_000,
      paymentMethod: FAKE_GATEWAY_ID,
      status: OrderStatus.INCOMPLETE,
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  async function capture(providerRef: string, amountMinor: number, paymentType: "full" | "deposit" | "balance" = "full") {
    const result = await processPaymentConfirmed(db, {
      orderId: "order_1", provider: FAKE_GATEWAY_ID, amountMinor, currency: "BDT", paymentType, providerRef, secondaryRef: `txn_${providerRef}`,
    });
    expect(result).toMatchObject({ success: true });
    sqlite.prepare("UPDATE orders SET status = ? WHERE id = 'order_1'").run(OrderStatus.DELIVERED);
  }

  function orderState() {
    return sqlite.prepare("SELECT status, payment_status, paid_amount_minor FROM orders WHERE id = 'order_1'").get();
  }

  function attemptStatuses() {
    return sqlite.prepare("SELECT status FROM refund_attempts ORDER BY allocation_index").all()
      .map((row) => (row as { status: string }).status);
  }

  it("refunds through the adapter in integer minor units, once, and never beyond the paid amount", async () => {
    await capture("pay_1", 10_000);

    const refund = await processRefund(db, { orderId: "order_1", amount: 40, reason: "damaged" }, undefined, providers);
    expect(refund).toMatchObject({ success: true, gateway: FAKE_GATEWAY_ID, amount: 40, isFullRefund: false, refundId: "fr_1" });
    expect(state.refunds).toEqual([expect.objectContaining({ amountMinor: 4_000, currency: "BDT", secondaryRef: "txn_pay_1" })]);
    expect(orderState()).toMatchObject({ status: OrderStatus.DELIVERED, payment_status: PaymentStatus.PARTIALLY_REFUNDED, paid_amount_minor: 6_000 });

    await expect(processRefund(db, { orderId: "order_1", amount: 61, reason: "again" }, undefined, providers)).rejects.toThrow(/exceeds paid amount/);
    await processRefund(db, { orderId: "order_1", reason: "rest" }, undefined, providers);
    expect(state.refunds.map((entry) => entry.amountMinor)).toEqual([4_000, 6_000]);
    expect(orderState()).toMatchObject({ status: OrderStatus.REFUNDED, payment_status: PaymentStatus.REFUNDED, paid_amount_minor: 0 });
    await expect(processRefund(db, { orderId: "order_1", reason: "third" }, undefined, providers)).rejects.toThrow();
    expect(state.refunds).toHaveLength(2);
    // Refund rows never take a provider reference: UNIQUE(provider, provider_ref) belongs to captures.
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE payment_type = 'refund' AND provider_ref IS NOT NULL").get())
      .toEqual({ n: 0 });
  });

  it("records what a provider reported reached the merchant, and a payment as presented otherwise (D2)", async () => {
    // An order presented in USD for a taka shop, its rate locked at 120.
    sqlite.prepare(`UPDATE orders SET currency_code = 'USD', shop_currency = 'BDT', fx_rate = '120', fx_source = 'test'
      WHERE id = 'order_1'`).run();
    sqlite.prepare(`INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, status)
      VALUES ('plan_1', 'order_1', 10000, 2500, 7500, 'pending')`).run();
    const pay = (providerRef: string, amountMinor: number, paymentType: "deposit" | "balance", settlement?: { currency: string; amountMinor: number; exchangeRate?: string }) =>
      processPaymentConfirmed(db, {
        orderId: "order_1", provider: FAKE_GATEWAY_ID, amountMinor, currency: "USD", paymentType, providerRef,
        secondaryRef: `txn_${providerRef}`, settlement,
      });

    await expect(pay("dep", 2_500, "deposit")).resolves.toMatchObject({ success: true });
    // $75 settled as ৳8,962.50 at 119.5: ৳37.50 less than the locked rate's ৳9,000.
    await expect(pay("bal", 7_500, "balance", { currency: "BDT", amountMinor: 896_250, exchangeRate: "119.5" }))
      .resolves.toMatchObject({ success: true });
    expect(sqlite.prepare(`SELECT provider_ref, amount_minor, currency, settlement_currency, settlement_amount_minor,
        settlement_rate, exchange_adjustment_minor
      FROM order_payments ORDER BY amount_minor`).all()).toEqual([
      { provider_ref: "dep", amount_minor: 2_500, currency: "USD", settlement_currency: "USD", settlement_amount_minor: 2_500, settlement_rate: "1", exchange_adjustment_minor: 0 },
      { provider_ref: "bal", amount_minor: 7_500, currency: "USD", settlement_currency: "BDT", settlement_amount_minor: 896_250, settlement_rate: "119.5", exchange_adjustment_minor: -3_750 },
    ]);

    // Refunds stay in the presentment currency, settled as presented.
    sqlite.prepare("UPDATE orders SET status = ? WHERE id = 'order_1'").run(OrderStatus.DELIVERED);
    await processRefund(db, { orderId: "order_1", amount: 10, reason: "damaged" }, undefined, providers);
    expect(sqlite.prepare(`SELECT currency, amount_minor, settlement_currency, settlement_amount_minor, settlement_rate, exchange_adjustment_minor
      FROM order_payments WHERE payment_type = 'refund'`).get())
      .toEqual({ currency: "USD", amount_minor: 1_000, settlement_currency: "USD", settlement_amount_minor: 1_000, settlement_rate: "1", exchange_adjustment_minor: 0 });
  });

  it("allocates across deposit and balance captures with distinct idempotency keys", async () => {
    sqlite.prepare(`INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, status)
      VALUES ('plan_1', 'order_1', 10000, 2500, 7500, 'pending')`).run();
    await processPaymentConfirmed(db, { orderId: "order_1", provider: FAKE_GATEWAY_ID, amountMinor: 2_500, currency: "BDT", paymentType: "deposit", providerRef: "dep", secondaryRef: "txn_dep" });
    await capture("bal", 7_500, "balance");

    await processRefund(db, { orderId: "order_1", reason: "cancelled" }, undefined, providers);

    expect(state.refunds.map((entry) => [entry.secondaryRef, entry.amountMinor]).sort()).toEqual([["txn_bal", 7_500], ["txn_dep", 2_500]]);
    expect(new Set(state.refunds.map((entry) => entry.idempotencyKey)).size).toBe(2);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.REFUNDED });
  });

  it("keeps an unknown provider outcome pending, blocks a duplicate refund, and settles it by reconciliation", async () => {
    await capture("pay_1", 10_000);
    state.refundError = new Error("socket hang up");

    await expect(processRefund(db, { orderId: "order_1", reason: "retry me" }, undefined, providers)).rejects.toThrow(/unknown/i);
    expect(attemptStatuses()).toEqual(["provider_unknown"]);
    await expect(processRefund(db, { orderId: "order_1", reason: "retry me" }, undefined, providers)).rejects.toThrow(/in progress|pending/i);
    expect(state.refunds).toHaveLength(1);

    state.refundStatus = { outcome: "processing", providerStatus: "pending" };
    const attemptId = (sqlite.prepare("SELECT id FROM refund_attempts").get() as { id: string }).id;
    const processing = await reconcileRefundAttemptForOrder(db, "order_1", attemptId, { providers });
    expect(processing).toMatchObject({ found: true, status: "deferred" });
    expect(processing.refundNotifications).toEqual([expect.objectContaining({ notificationType: "refund_processing" })]);

    state.refundStatus = { outcome: "accepted", providerStatus: "refunded", providerRefundId: "fr_late" };
    sqlite.prepare("UPDATE refund_attempts SET next_probe_at = 0").run();
    const settled = await reconcileDueRefundAttempts(db, { nowSeconds: Math.floor(Date.now() / 1000) + 60, providers });
    expect(settled).toMatchObject({ finalized: 1 });
    expect(attemptStatuses()).toEqual(["refunded"]);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.REFUNDED, paid_amount_minor: 0 });
    expect(state.refunds).toHaveLength(1);
  });

  it("ends a refund the port says never reached the provider, and keeps one that may have", async () => {
    await capture("pay_1", 10_000);
    state.refundError = new ProviderError("declined", "The refund window has closed.", { code: "fake.window_closed" });
    await expect(processRefund(db, { orderId: "order_1", reason: "late" }, undefined, providers)).rejects.toThrow("The refund window has closed.");
    expect(attemptStatuses()).toEqual(["failed"]);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.PAID, paid_amount_minor: 10_000 });

    state.refundError = new ProviderError("retryable", "Timed out after sending.", { uncertain: true });
    await expect(processRefund(db, { orderId: "order_1", reason: "again" }, undefined, providers)).rejects.toThrow(/unknown/i);
    expect(attemptStatuses().sort()).toEqual(["failed", "provider_unknown"]);
    expect(state.refunds).toHaveLength(2);
  });

  it("fails a refund before dispatch when the gateway settings are not readable", async () => {
    await capture("pay_1", 10_000);
    state.settings = { enabled: true, apiKey: "live_key", credentialErrors: ["cannot decrypt"] };

    await expect(processRefund(db, { orderId: "order_1", reason: "x" }, undefined, providers)).rejects.toThrow(/not readable/);
    expect(state.refunds).toEqual([]);
    expect(attemptStatuses()).toEqual(["failed"]);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.PAID });
  });

  it("imports a refund made in the provider dashboard exactly once", async () => {
    await capture("pay_1", 10_000);
    state.providerRefunds = [
      { id: "ext_1", succeeded: true, amountMinor: 3_000, currency: "BDT", sourceRef: "txn_pay_1", status: "succeeded" },
    ];
    await db.insert(webhookEvents).values({
      id: `${FAKE_GATEWAY_ID}:refund:evt_1`,
      provider: FAKE_GATEWAY_ID,
      eventType: REFUND_OBSERVED_EVENT_TYPE,
      orderId: "order_1",
      status: "manual_reconciliation",
      result: JSON.stringify({ providerRef: "pay_1", secondaryRef: "txn_pay_1" }),
    });

    const first = await reconcileExternalRefundWebhooks(db, { providers });
    expect(first).toMatchObject({ imported: 1, finalized: 1, deferred: 0 });
    expect(orderState()).toMatchObject({ status: OrderStatus.DELIVERED, payment_status: PaymentStatus.PARTIALLY_REFUNDED, paid_amount_minor: 7_000 });
    expect(sqlite.prepare("SELECT status FROM webhook_events").get()).toEqual({ status: "processed" });

    sqlite.prepare("UPDATE webhook_events SET status = 'manual_reconciliation'").run();
    await expect(reconcileExternalRefundWebhooks(db, { providers })).resolves.toMatchObject({ imported: 0, skipped: 1 });
    expect(orderState()).toMatchObject({ paid_amount_minor: 7_000 });
    expect(state.refunds).toEqual([]);
  });

  it("records a COD refund only as a confirmed manual settlement", async () => {
    sqlite.prepare("UPDATE orders SET payment_method = 'cod', status = ?, payment_status = 'paid', paid_amount_minor = 10000, balance_due_minor = 0 WHERE id = 'order_1'")
      .run(OrderStatus.DELIVERED);
    sqlite.prepare(`INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES ('cod_1', 'order_1', 10000, 'BDT', 'cod', 'full', 'succeeded')`).run();

    await expect(processRefund(db, { orderId: "order_1", reason: "x" }, undefined, providers)).rejects.toThrow(/received the refund by hand/);
    await expect(processRefund(db, { orderId: "order_1", reason: "x", manualSettlementConfirmed: true }, undefined, providers))
      .resolves.toMatchObject({ success: true, manualSettlementRecorded: true });
    expect(state.refunds).toEqual([]);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.REFUNDED });
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE status = ?").get(PaymentRecordStatus.REFUNDED))
      .toEqual({ n: 1 });
  });
});
