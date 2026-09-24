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

import { processPaymentConfirmed } from "../process-payment";
import { processRefund } from "../refund-service";
import {
  reconcileDueRefundAttempts,
  reconcileExternalRefundWebhooks,
  reconcileRefundAttemptForOrder,
  REFUND_OBSERVED_EVENT_TYPE,
} from "../refund-reconciliation";
import { buildPaymentCorrelationId, parsePaymentCorrelationId, PAYMENT_CORRELATION_ID_MAX_LENGTH } from "./correlation";
import type { GatewayRequest } from "./port";
import {
  filterPaymentMethodsForCurrency,
  getCheckoutGatewayPrecommitIssue,
  getPaymentMethodCurrencyIssue,
  isPaymentMethodCurrencyEligible,
} from "./registry";
import { sslcommerzGateway } from "./sslcommerz";
import { stripeGateway } from "./stripe";
import { registerFakeGateway, type FakeGatewayState } from "./testing";

function request(init: Partial<GatewayRequest> & { rawBody?: string }): GatewayRequest {
  return { method: "POST", rawBody: "", headers: new Headers(), query: {}, ...init };
}

describe("registry currency and limit policy", () => {
  it("keeps every method for BDT and drops SSLCommerz elsewhere without touching the saved order", () => {
    expect(filterPaymentMethodsForCurrency(["stripe", "sslcommerz", "cod"], "BDT")).toEqual(["stripe", "sslcommerz", "cod"]);
    expect(filterPaymentMethodsForCurrency(["sslcommerz", "cod", "stripe", "unknown"], "usd")).toEqual(["cod", "stripe"]);
    expect(getPaymentMethodCurrencyIssue("sslcommerz", "USD"))
      .toBe("SSLCommerz checkout requires the store currency to be BDT. Current currency: USD.");
  });

  it("fails closed for unknown methods and unsupported currencies", () => {
    expect(isPaymentMethodCurrencyEligible("unknown", "BDT")).toBe(false);
    expect(isPaymentMethodCurrencyEligible("stripe", "XYZ")).toBe(false);
    expect(filterPaymentMethodsForCurrency(["stripe", "cod"], "XYZ")).toEqual([]);
  });

  it("checks the first online charge against provider limits before an order commits", () => {
    const input = { paymentMethod: "sslcommerz", currencyCode: "BDT", partialPaymentEnabled: false, partialPaymentAmount: 0 };
    expect(getCheckoutGatewayPrecommitIssue({ ...input, totalAmountMinor: 1_000 })).toBeNull();
    expect(getCheckoutGatewayPrecommitIssue({ ...input, totalAmountMinor: 999 }))
      .toBe("SSLCommerz payment amount must be between 10.00 BDT and 500000.00 BDT.");
    // A configured advance below the total is the first charge.
    expect(getCheckoutGatewayPrecommitIssue({ ...input, totalAmountMinor: 60_000_000, partialPaymentEnabled: true, partialPaymentAmount: 500 }))
      .toBeNull();
    expect(getCheckoutGatewayPrecommitIssue({ ...input, paymentMethod: "cod", totalAmountMinor: 100 })).toBeNull();
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
    return request({ rawBody, headers: new Headers({ "stripe-signature": signature }) });
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
    await expect(stripeGateway.verifyWebhook(settings, authentic)).resolves.toEqual({
      status: "event",
      event: {
        kind: "confirmed", eventType: "payment_intent.succeeded", eventId: "evt_1", orderId: "order_1",
        providerRef: "pi_1", secondaryRef: "ch_1", amountMinor: 12_550, currency: "BDT", paymentType: "deposit",
      },
    });
    await expect(stripeGateway.verifyWebhook(settings, { ...authentic, rawBody: `${authentic.rawBody} ` }))
      .resolves.toMatchObject({ status: "invalid" });
  });

  it("ignores authentic events the kernel does not act on", async () => {
    const other = await signed({ id: "evt_2", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } });
    await expect(stripeGateway.verifyWebhook(settings, other)).resolves.toMatchObject({ status: "ignored" });
  });
});

describe("SSLCommerz adapter", () => {
  const settings = { storeId: "store_1", storePassword: "secret", sandbox: true, enabled: true };
  const validation = {
    status: "VALID", tran_id: "order_1_full_ABC12345", val_id: "val_1", amount: "150.00",
    currency_type: "BDT", bank_tran_id: "bank_1", value_a: "full", value_b: "order_1", card_type: "BKASH-BKash",
  };
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trusts an IPN only after server-to-server validation of its val_id", async () => {
    fetchMock.mockImplementation(async () => Response.json(validation));
    await expect(sslcommerzGateway.verifyWebhook(settings, request({ rawBody: "val_id=val_1&amount=999999" })))
      .resolves.toEqual({
        status: "event",
        event: {
          kind: "confirmed", eventType: "ipn", eventId: "order_1_full_ABC12345:val_1", orderId: "order_1",
          providerRef: "val_1", secondaryRef: "bank_1", amountMinor: 15_000, currency: "BDT", paymentType: "full",
          details: { tranId: "order_1_full_ABC12345", validationStatus: "VALID", cardType: "BKASH-BKash", cardBrand: null },
        },
      });
    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.pathname).toBe("/validator/api/validationserverAPI.php");
    expect(calledUrl.searchParams.get("val_id")).toBe("val_1");
  });

  it("asks the provider to retry when validation is unreachable and ignores unfinished or inconsistent results", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(sslcommerzGateway.verifyWebhook(settings, request({ rawBody: "val_id=val_1" })))
      .resolves.toMatchObject({ status: "retry" });

    fetchMock.mockResolvedValueOnce(Response.json({ ...validation, status: "PENDING" }));
    await expect(sslcommerzGateway.verifyWebhook(settings, request({ rawBody: "val_id=val_1" })))
      .resolves.toMatchObject({ status: "ignored" });

    fetchMock.mockResolvedValueOnce(Response.json({ ...validation, value_b: "order_2" }));
    await expect(sslcommerzGateway.verifyWebhook(settings, request({ rawBody: "val_id=val_1" })))
      .resolves.toMatchObject({ status: "ignored" });

    fetchMock.mockResolvedValueOnce(Response.json({ ...validation, status: "FAILED" }));
    await expect(sslcommerzGateway.verifyWebhook(settings, request({ rawBody: "val_id=val_1" })))
      .resolves.toMatchObject({ status: "event", event: { kind: "failed", providerRef: "val_1" } });
  });

  it("produces the same claim identity for a buyer return as for the IPN, and rejects a return whose context disagrees", async () => {
    fetchMock.mockImplementation(async () => Response.json(validation));
    const buyerReturn = request({
      rawBody: "tran_id=order_1_full_ABC12345&val_id=val_1",
      query: { order_id: "order_1", payment_type: "full" },
    });
    const ipn = await sslcommerzGateway.verifyWebhook(settings, request({ rawBody: "val_id=val_1" }));
    const returned = await sslcommerzGateway.verifyReturn!(settings, buyerReturn, new AbortController().signal);
    expect(returned).toEqual(ipn);

    await expect(sslcommerzGateway.verifyReturn!(
      settings,
      { ...buyerReturn, query: { order_id: "order_1", payment_type: "deposit" } },
      new AbortController().signal,
    )).resolves.toMatchObject({ status: "ignored" });
  });
});

describe("gateway kernel with a newly registered adapter", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let state: FakeGatewayState;
  let unregister: () => void;

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ({ sqlite, db } = createSqliteD1Database());
    ({ state, unregister } = registerFakeGateway());
    await db.insert(orders).values({
      id: "order_1",
      customerName: "Buyer",
      customerPhone: "+8801711111111",
      shippingAddress: "Dhaka",
      city: "dhaka",
      zone: "zone_1",
      totalAmountMinor: 10_000,
      balanceDueMinor: 10_000,
      paymentMethod: "fakepay",
      status: OrderStatus.INCOMPLETE,
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
    });
  });

  afterEach(() => {
    unregister();
    sqlite.close();
  });

  async function capture(providerRef: string, amountMinor: number, paymentType: "full" | "deposit" | "balance" = "full") {
    const result = await processPaymentConfirmed(db, {
      orderId: "order_1", provider: "fakepay", amountMinor, currency: "BDT", paymentType, providerRef, secondaryRef: `txn_${providerRef}`,
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

    const refund = await processRefund(db, { orderId: "order_1", amount: 40.5, reason: "damaged" });
    expect(refund).toMatchObject({ success: true, gateway: "fakepay", amount: 40.5, isFullRefund: false, refundId: "fr_1" });
    expect(state.refunds).toEqual([expect.objectContaining({ amountMinor: 4_050, currency: "BDT", secondaryRef: "txn_pay_1" })]);
    expect(orderState()).toMatchObject({ status: OrderStatus.DELIVERED, payment_status: PaymentStatus.PARTIALLY_REFUNDED, paid_amount_minor: 5_950 });

    await expect(processRefund(db, { orderId: "order_1", amount: 60, reason: "again" })).rejects.toThrow(/exceeds paid amount/);
    await processRefund(db, { orderId: "order_1", reason: "rest" });
    expect(state.refunds.map((entry) => entry.amountMinor)).toEqual([4_050, 5_950]);
    expect(orderState()).toMatchObject({ status: OrderStatus.REFUNDED, payment_status: PaymentStatus.REFUNDED, paid_amount_minor: 0 });
    await expect(processRefund(db, { orderId: "order_1", reason: "third" })).rejects.toThrow();
    expect(state.refunds).toHaveLength(2);
    // Refund rows never take a provider reference: UNIQUE(provider, provider_ref) belongs to captures.
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE payment_type = 'refund' AND provider_ref IS NOT NULL").get())
      .toEqual({ n: 0 });
  });

  it("allocates across deposit and balance captures with distinct idempotency keys", async () => {
    sqlite.prepare(`INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, status)
      VALUES ('plan_1', 'order_1', 10000, 2500, 7500, 'pending')`).run();
    await processPaymentConfirmed(db, { orderId: "order_1", provider: "fakepay", amountMinor: 2_500, currency: "BDT", paymentType: "deposit", providerRef: "dep", secondaryRef: "txn_dep" });
    await capture("bal", 7_500, "balance");

    await processRefund(db, { orderId: "order_1", reason: "cancelled" });

    expect(state.refunds.map((entry) => [entry.secondaryRef, entry.amountMinor]).sort()).toEqual([["txn_bal", 7_500], ["txn_dep", 2_500]]);
    expect(new Set(state.refunds.map((entry) => entry.idempotencyKey)).size).toBe(2);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.REFUNDED });
  });

  it("keeps an unknown provider outcome pending, blocks a duplicate refund, and settles it by reconciliation", async () => {
    await capture("pay_1", 10_000);
    state.refundError = new Error("socket hang up");

    await expect(processRefund(db, { orderId: "order_1", reason: "retry me" })).rejects.toThrow(/unknown/i);
    expect(attemptStatuses()).toEqual(["provider_unknown"]);
    await expect(processRefund(db, { orderId: "order_1", reason: "retry me" })).rejects.toThrow(/in progress|pending/i);
    expect(state.refunds).toHaveLength(1);

    state.refundStatus = { outcome: "processing", providerStatus: "pending" };
    const attemptId = (sqlite.prepare("SELECT id FROM refund_attempts").get() as { id: string }).id;
    const processing = await reconcileRefundAttemptForOrder(db, "order_1", attemptId);
    expect(processing).toMatchObject({ found: true, status: "deferred" });
    expect(processing.refundNotifications).toEqual([expect.objectContaining({ notificationType: "refund_processing" })]);

    state.refundStatus = { outcome: "accepted", providerStatus: "refunded", providerRefundId: "fr_late" };
    sqlite.prepare("UPDATE refund_attempts SET next_probe_at = 0").run();
    const settled = await reconcileDueRefundAttempts(db, { nowSeconds: Math.floor(Date.now() / 1000) + 60 });
    expect(settled).toMatchObject({ finalized: 1 });
    expect(attemptStatuses()).toEqual(["refunded"]);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.REFUNDED, paid_amount_minor: 0 });
    expect(state.refunds).toHaveLength(1);
  });

  it("fails a refund before dispatch when the gateway settings are not readable", async () => {
    await capture("pay_1", 10_000);
    state.settings = { enabled: true, apiKey: "live_key", credentialErrors: ["cannot decrypt"] };

    await expect(processRefund(db, { orderId: "order_1", reason: "x" })).rejects.toThrow(/not readable/);
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
      id: "fakepay:refund:evt_1",
      provider: "fakepay",
      eventType: REFUND_OBSERVED_EVENT_TYPE,
      orderId: "order_1",
      status: "manual_reconciliation",
      result: JSON.stringify({ providerRef: "pay_1", secondaryRef: "txn_pay_1" }),
    });

    const first = await reconcileExternalRefundWebhooks(db);
    expect(first).toMatchObject({ imported: 1, finalized: 1, deferred: 0 });
    expect(orderState()).toMatchObject({ status: OrderStatus.DELIVERED, payment_status: PaymentStatus.PARTIALLY_REFUNDED, paid_amount_minor: 7_000 });
    expect(sqlite.prepare("SELECT status FROM webhook_events").get()).toEqual({ status: "processed" });

    sqlite.prepare("UPDATE webhook_events SET status = 'manual_reconciliation'").run();
    await expect(reconcileExternalRefundWebhooks(db)).resolves.toMatchObject({ imported: 0, skipped: 1 });
    expect(orderState()).toMatchObject({ paid_amount_minor: 7_000 });
    expect(state.refunds).toEqual([]);
  });

  it("records a COD refund only as a confirmed manual settlement", async () => {
    sqlite.prepare("UPDATE orders SET payment_method = 'cod', status = ?, payment_status = 'paid', paid_amount_minor = 10000, balance_due_minor = 0 WHERE id = 'order_1'")
      .run(OrderStatus.DELIVERED);
    sqlite.prepare(`INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES ('cod_1', 'order_1', 10000, 'BDT', 'cod', 'full', 'succeeded')`).run();

    await expect(processRefund(db, { orderId: "order_1", reason: "x" })).rejects.toThrow(/manual COD refund/);
    await expect(processRefund(db, { orderId: "order_1", reason: "x", manualSettlementConfirmed: true }))
      .resolves.toMatchObject({ success: true, manualSettlementRecorded: true });
    expect(state.refunds).toEqual([]);
    expect(orderState()).toMatchObject({ payment_status: PaymentStatus.REFUNDED });
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE status = ?").get(PaymentRecordStatus.REFUNDED))
      .toEqual({ n: 1 });
  });
});
