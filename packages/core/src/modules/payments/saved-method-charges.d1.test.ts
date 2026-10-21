// Payments without the buyer on real D1 storage: a saved method charged
// off-session (confirmed, declined, an unknown outcome then a repeat), an
// authorization captured or voided, idempotent replays that never call the
// provider twice for one key, and the saved method written in the batch
// that applies its payment.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ProviderError, type PaymentCharge, type PaymentChargeInput } from "@scalius/shared/plugins/providers";
import { createFakeGateway } from "./gateways/testing";
import { createPaymentProviders } from "./gateways/registry";
import type { PaymentEvent, PaymentGateway } from "./gateways/port";
import { processPaymentAuthorized, processPaymentConfirmed, processPaymentFailed } from "./process-payment";
import {
  captureAuthorizedPayment,
  chargeSavedPaymentMethod,
  voidAuthorizedPayment,
  type ApplyProviderPaymentEvent,
} from "./saved-method-charges";
import { listCustomerPaymentMethods, removeCustomerPaymentMethod } from "./saved-payment-methods";

const PROVIDER = "acme.fake:pay";

function vaultGateway() {
  const fake = createFakeGateway(PROVIDER);
  const calls = { charge: [] as PaymentChargeInput[], capture: 0, void: 0, delete: 0 };
  /** The next charge answers this (or throws it); default: captured. */
  let next: PaymentCharge | Error | null = null;
  const event = (input: PaymentChargeInput, kind: "confirmed" | "authorized"): PaymentEvent => ({
    kind,
    eventType: `charge.${kind}`,
    eventId: `ch_${input.attemptKey}`,
    orderId: input.orderId,
    providerRef: `pi_${input.attemptKey}`,
    secondaryRef: `ch_${input.attemptKey}`,
    amountMinor: input.amountMinor,
    currency: input.currency,
    paymentType: input.paymentType,
  });
  const gateway: PaymentGateway = {
    ...fake.gateway,
    capabilities: ["vault", "manualCapture"],
    async chargeSavedMethod(input) {
      calls.charge.push(input);
      const answer = next;
      next = null;
      if (answer instanceof Error) throw answer;
      // The provider's idempotency: the same key answers the same charge.
      return answer ?? { status: "event", event: event(input, input.capture === "manual" ? "authorized" : "confirmed") };
    },
    async capture(input) {
      calls.capture += 1;
      return {
        status: "event",
        event: {
          kind: "confirmed", eventType: "charge.captured", eventId: `cap_${input.providerRef}`, orderId: input.orderId,
          providerRef: input.providerRef, secondaryRef: `ch_${input.providerRef}`, amountMinor: input.amountMinor, currency: input.currency,
        },
      };
    },
    async void() {
      calls.void += 1;
      return { status: "voided" };
    },
    async deleteSavedMethod() {
      calls.delete += 1;
      return { status: "deleted" };
    },
  };
  return {
    gateway,
    calls,
    providers: createPaymentProviders([gateway]),
    answerNext(answer: PaymentCharge | Error) {
      next = answer;
    },
  };
}

describe("saved-method charges and authorizations", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let vault: ReturnType<typeof vaultGateway>;
  let applied: PaymentEvent[];

  /** The kernel the API wires through webhook_events: confirmed and authorized events applied now. */
  const applyEvent: ApplyProviderPaymentEvent = async ({ provider, event }) => {
    applied.push(event);
    const params = {
      orderId: event.orderId, provider, amountMinor: event.amountMinor ?? 0, currency: event.currency ?? "",
      paymentType: event.paymentType, providerRef: event.providerRef, secondaryRef: event.secondaryRef,
      savedPaymentMethod: event.savedPaymentMethod ?? null,
    };
    const result = event.kind === "authorized" ? await processPaymentAuthorized(db, params) : await processPaymentConfirmed(db, params);
    if (!result.success) return result.retryable === false ? "manual_reconciliation" : "retrying";
    return "processed";
  };

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    vault = vaultGateway();
    applied = [];
    sqlite.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Rahima', '+8801712345678'), ('cust_2', 'Karim', '+8801712345679');
      INSERT INTO orders (
        id, order_number, customer_id, account_owner_customer_id, customer_name, customer_phone, shipping_address, city, zone,
        currency_code, currency_decimal_places, subtotal_amount_minor, total_amount_minor, status, payment_method,
        payment_status, paid_amount_minor, balance_due_minor, payment_terms_days, payment_due_at, version
      ) VALUES
        ('ord_1', 7001, 'cust_1', 'cust_1', 'Rahima', '+8801712345678', 'House 1', 'city_1', 'zone_1',
         'BDT', 2, 150000, 150000, 'confirmed', 'net_terms', 'unpaid', 0, 150000, 30, unixepoch() + 2592000, 1),
        ('ord_guest', 7002, NULL, NULL, 'Guest', '+8801712345670', 'House 2', 'city_1', 'zone_1',
         'BDT', 2, 50000, 50000, 'confirmed', '${PROVIDER}', 'unpaid', 0, 50000, NULL, NULL, 1);
      INSERT INTO customer_payment_methods (id, customer_id, provider_id, provider_method_ref, brand, last4, expiry_month, expiry_year, created_at)
      VALUES ('cpm_1', 'cust_1', '${PROVIDER}', 'pm_card_1', 'visa', '4242', 12, 2030, 1),
             ('cpm_2', 'cust_2', '${PROVIDER}', 'pm_card_2', 'visa', '1881', 1, 2031, 1);
    `);
  });
  afterEach(() => sqlite.close());

  const order = (id = "ord_1") => sqlite.prepare(
    "SELECT status, payment_method, payment_status, paid_amount_minor, balance_due_minor FROM orders WHERE id = ?",
  ).get(id);
  const payments = (id = "ord_1") => sqlite.prepare(
    "SELECT status, payment_method, amount_minor, provider_ref FROM order_payments WHERE order_id = ? ORDER BY created_at, rowid",
  ).all(id);
  const charge = (requestKey: string, overrides: Partial<Parameters<typeof chargeSavedPaymentMethod>[1]> = {}) =>
    chargeSavedPaymentMethod(db, {
      orderId: "ord_1", paymentMethodId: "cpm_1", requestKey,
      providers: vault.providers, encryptionKey: undefined, applyEvent, ...overrides,
    });

  it("charges a saved method for an invoice, switching it to the provider, and replays the key without charging again", async () => {
    const first = await charge("renewal-2026-11");
    expect(first).toMatchObject({ outcome: "succeeded", orderId: "ord_1", providerId: PROVIDER, amountMinor: 150000, currency: "BDT", replayed: false });
    expect(vault.calls.charge).toHaveLength(1);
    expect(vault.calls.charge[0]).toMatchObject({ methodRef: "pm_card_1", amountMinor: 150000, paymentType: "full", capture: "automatic" });
    expect(order()).toEqual({ status: "confirmed", payment_method: PROVIDER, payment_status: "paid", paid_amount_minor: 150000, balance_due_minor: 0 });
    expect(payments()).toEqual([{ status: "succeeded", payment_method: PROVIDER, amount_minor: 150000, provider_ref: expect.stringMatching(/^pi_pcharge_/) }]);

    const again = await charge("renewal-2026-11");
    expect(again).toMatchObject({ outcome: "succeeded", paymentId: first.paymentId, replayed: true });
    expect(vault.calls.charge).toHaveLength(1);
    // Another key on a paid order is refused before any provider call.
    await expect(charge("renewal-2026-11-b")).rejects.toThrow(/fully paid/);
    expect(vault.calls.charge).toHaveLength(1);
  });

  it("records a decline, leaves the invoice as it was, and replays the decline", async () => {
    vault.answerNext({ status: "declined", reason: "Insufficient funds", code: "insufficient_funds" });
    expect(await charge("renewal-decline")).toMatchObject({ outcome: "declined", declineReason: "Insufficient funds", declineCode: "insufficient_funds", replayed: false });
    expect(order()).toMatchObject({ payment_method: "net_terms", payment_status: "unpaid", paid_amount_minor: 0 });
    expect(payments()).toEqual([]);
    expect(await charge("renewal-decline")).toMatchObject({ outcome: "declined", replayed: true });
    expect(vault.calls.charge).toHaveLength(1);
    // A new key is a new attempt (the dunning retry).
    expect(await charge("renewal-decline-retry")).toMatchObject({ outcome: "succeeded" });
    expect(vault.calls.charge).toHaveLength(2);
  });

  it("keeps an unanswered charge open, refuses another charge meanwhile, and resolves it by repeating the same key", async () => {
    vault.answerNext(new ProviderError("retryable", "Timed out after sending.", { uncertain: true, code: "fake_timeout" }));
    await expect(charge("renewal-lost")).rejects.toMatchObject({ code: "payment_outcome_unknown", status: 503 });
    expect(order()).toMatchObject({ payment_status: "unpaid" });
    // No second charge while the first one's outcome is unknown.
    await expect(charge("renewal-other")).rejects.toMatchObject({ code: "payment_not_possible" });
    expect(vault.calls.charge).toHaveLength(1);

    const resolved = await charge("renewal-lost");
    expect(resolved).toMatchObject({ outcome: "succeeded", replayed: false });
    // Asked again under the same provider idempotency key: one charge at the provider, one payment here.
    expect(vault.calls.charge).toHaveLength(2);
    expect(vault.calls.charge[1]!.attemptKey).toBe(vault.calls.charge[0]!.attemptKey);
    expect(payments()).toHaveLength(1);
    expect(order()).toMatchObject({ payment_status: "paid" });
  });

  it("refuses a different charge under a key already used", async () => {
    vault.answerNext({ status: "declined", reason: "Do not honour" });
    await charge("renewal-key");
    await expect(charge("renewal-key", { capture: "manual" })).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });

  it("never sends two charges for one key, even racing", async () => {
    const [a, b] = await Promise.allSettled([charge("renewal-race"), charge("renewal-race")]);
    expect(vault.calls.charge).toHaveLength(1);
    const outcomes = [a, b].map((result) => result.status === "fulfilled" ? result.value.outcome : (result.reason as { code?: string }).code);
    expect(outcomes).toContain("succeeded");
    expect(payments()).toHaveLength(1);
  });

  it("authorizes, holds nothing as paid, then captures once", async () => {
    const held = await charge("renewal-auth", { capture: "manual" });
    expect(held).toMatchObject({ outcome: "authorized" });
    expect(order()).toMatchObject({ payment_method: PROVIDER, payment_status: "unpaid", paid_amount_minor: 0, balance_due_minor: 150000 });
    expect(payments()).toEqual([expect.objectContaining({ status: "authorized", amount_minor: 150000 })]);
    // Money in flight: no other charge.
    await expect(charge("renewal-auth-2")).rejects.toMatchObject({ code: "payment_not_possible" });

    const captured = await captureAuthorizedPayment(db, { paymentId: held.paymentId!, providers: vault.providers, encryptionKey: undefined, applyEvent });
    expect(captured).toMatchObject({ outcome: "succeeded", paymentId: held.paymentId, replayed: false });
    expect(order()).toMatchObject({ payment_status: "paid", paid_amount_minor: 150000 });
    expect(payments()).toEqual([expect.objectContaining({ status: "succeeded", amount_minor: 150000 })]);
    expect(await captureAuthorizedPayment(db, { paymentId: held.paymentId!, providers: vault.providers, encryptionKey: undefined, applyEvent }))
      .toMatchObject({ outcome: "succeeded", replayed: true });
    expect(vault.calls.capture).toBe(1);
    await expect(voidAuthorizedPayment(db, { paymentId: held.paymentId!, providers: vault.providers, encryptionKey: undefined, applyEvent }))
      .rejects.toThrow(/refund a captured one/);
  });

  it("authorizes then voids: the hold is released and the order stays unpaid", async () => {
    const held = await charge("renewal-void", { capture: "manual" });
    const voided = await voidAuthorizedPayment(db, { paymentId: held.paymentId!, providers: vault.providers, encryptionKey: undefined, applyEvent });
    expect(voided).toMatchObject({ outcome: "voided", replayed: false });
    expect(payments()).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(order()).toMatchObject({ payment_status: "unpaid", paid_amount_minor: 0 });
    expect(await voidAuthorizedPayment(db, { paymentId: held.paymentId!, providers: vault.providers, encryptionKey: undefined, applyEvent }))
      .toMatchObject({ outcome: "voided", replayed: true });
    expect(vault.calls.void).toBe(1);
    await expect(captureAuthorizedPayment(db, { paymentId: held.paymentId!, providers: vault.providers, encryptionKey: undefined, applyEvent }))
      .rejects.toThrow(/Only an authorized payment/);
    // The released order takes a new charge.
    expect(await charge("renewal-void-then-pay")).toMatchObject({ outcome: "succeeded" });
  });

  it("releases an authorization the provider expires (a cancelled event naming its reference)", async () => {
    const held = await charge("renewal-expire", { capture: "manual" });
    const ref = (payments()[0] as { provider_ref: string }).provider_ref;
    expect(await processPaymentFailed(db, { orderId: "ord_1", provider: PROVIDER, providerRef: ref })).toEqual({ applied: true });
    expect(payments()).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(held.outcome).toBe("authorized");
  });

  it("refuses a method of another customer before the provider is called", async () => {
    await expect(charge("renewal-wrong", { paymentMethodId: "cpm_2" })).rejects.toMatchObject({ code: "payment_method_customer_mismatch" });
    await expect(charge("renewal-gone", { paymentMethodId: "cpm_none" })).rejects.toThrow(/not found/);
    expect(vault.calls.charge).toHaveLength(0);
  });

  it("charges only an amount the order takes", async () => {
    await expect(charge("renewal-part", { amountMinor: 100 })).rejects.toThrow(/amount the order takes/);
    expect(vault.calls.charge).toHaveLength(0);
  });

  it("saves a kept method for the account customer in the payment's batch, never for a guest or another customer", async () => {
    const kept = { ref: "pm_new", brand: "mastercard", last4: "5555", expiryMonth: 4, expiryYear: 2029 };
    sqlite.exec("UPDATE orders SET payment_method = 'acme.fake:pay' WHERE id = 'ord_1'");
    expect((await processPaymentConfirmed(db, {
      orderId: "ord_1", provider: PROVIDER, amountMinor: 150000, currency: "BDT", paymentType: "full", providerRef: "pi_hosted_1", savedPaymentMethod: kept,
    })).success).toBe(true);
    expect((await listCustomerPaymentMethods(db, "cust_1")).map((method) => ({ brand: method.brand, last4: method.last4, sourceOrderId: method.sourceOrderId })))
      .toEqual([{ brand: "visa", last4: "4242", sourceOrderId: null }, { brand: "mastercard", last4: "5555", sourceOrderId: "ord_1" }]);
    // The method list never carries the provider reference.
    expect(JSON.stringify(await listCustomerPaymentMethods(db, "cust_1"))).not.toContain("pm_new");

    // A guest's payment keeps nothing; another customer's reference is never moved.
    expect((await processPaymentConfirmed(db, {
      orderId: "ord_guest", provider: PROVIDER, amountMinor: 50000, currency: "BDT", paymentType: "full", providerRef: "pi_hosted_2",
      savedPaymentMethod: { ref: "pm_card_2", last4: "0000" },
    })).success).toBe(true);
    expect(sqlite.prepare("SELECT customer_id, last4 FROM customer_payment_methods WHERE provider_method_ref = 'pm_card_2'").get())
      .toEqual({ customer_id: "cust_2", last4: "1881" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM customer_payment_methods").get()).toEqual({ n: 3 });
  });

  it("removes a saved method after the provider detaches it, and the removed method is never charged", async () => {
    const removed = await removeCustomerPaymentMethod(db, { methodId: "cpm_1", providers: vault.providers, encryptionKey: undefined });
    expect(removed).toMatchObject({ id: "cpm_1", status: "removed" });
    expect(vault.calls.delete).toBe(1);
    expect(await removeCustomerPaymentMethod(db, { methodId: "cpm_1", providers: vault.providers, encryptionKey: undefined })).toMatchObject({ status: "removed" });
    expect(vault.calls.delete).toBe(1);
    expect(await listCustomerPaymentMethods(db, "cust_1")).toEqual([]);
    await expect(charge("renewal-removed")).rejects.toThrow(/not found/);
  });
});
