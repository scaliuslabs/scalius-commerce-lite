// G9: the hosted remainder of an order gift cards partly paid is a plan-less
// `balance` that charges exactly `balance_due`, whatever type the storefront
// asks for (it keeps asking for "full"); a deposit is never offered for it.
// Real plans and plan-less orders with other money keep today's refusals.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { resolvePaymentSessionPolicy, type PaymentSessionOrder } from "./payment-session-policy";

const TOTAL = 36_000;
const DEPOSIT_SETTINGS = { partialPaymentEnabled: true, partialPaymentAmount: 100 };
const BDT = async () => "BDT";

describe("payment session policy: gift-card remainder (G9)", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status,
        payment_method, payment_status, total_amount_minor, paid_amount_minor, balance_due_minor, currency_code)
      VALUES ('order_gc', 'Buyer', '+8801712345678', 'House 1, Road 2', 'city_1', 'zone_1', 'incomplete',
        'sslcommerz', 'partial', ${TOTAL}, 10000, 26000, 'BDT');
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref)
      VALUES ('pay_gc', 'order_gc', 10000, 'BDT', 'gift_card', 'full', 'succeeded', 'gct_test_redeem_1');
    `);
  });
  afterEach(() => sqlite.close());

  const order = (overrides: Partial<PaymentSessionOrder> = {}): PaymentSessionOrder => ({
    id: "order_gc",
    totalAmountMinor: TOTAL,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
    status: "incomplete",
    paymentStatus: "partial",
    paidAmountMinor: 10_000,
    balanceDueMinor: 26_000,
    deletedAt: null,
    ...overrides,
  });

  const balance = { paymentType: "balance", chargeAmount: 260, chargeAmountMinor: 26_000 };

  it("charges the balance due, plan-less, for no type, `full` and `balance`, even in a deposit store", async () => {
    for (const paymentType of [undefined, "full", "balance"] as const) {
      await expect(resolvePaymentSessionPolicy(db, order(), { paymentType }, DEPOSIT_SETTINGS, undefined, BDT))
        .resolves.toEqual(balance);
      await expect(resolvePaymentSessionPolicy(db, order(), { paymentType }, { partialPaymentEnabled: false, partialPaymentAmount: 0 }))
        .resolves.toEqual(balance);
    }
  });

  it("never offers a deposit on a gift-card remainder", async () => {
    await expect(resolvePaymentSessionPolicy(db, order(), { paymentType: "deposit" }, DEPOSIT_SETTINGS, undefined, BDT))
      .rejects.toThrow("Gift cards paid part of this order; pay the amount left in full.");
    await expect(resolvePaymentSessionPolicy(db, order(), { depositAmount: 100 }, DEPOSIT_SETTINGS, undefined, BDT))
      .rejects.toThrow("Gift cards paid part of this order; pay the amount left in full.");
  });

  it("refuses a remainder whose balance does not match its payments", async () => {
    await expect(resolvePaymentSessionPolicy(db, order({ balanceDueMinor: 25_000 }), {}, null))
      .rejects.toThrow("The order balance does not match its payments");
  });

  it("keeps today's refusal when any succeeded payment is not a gift card", async () => {
    sqlite.exec(`
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref)
      VALUES ('pay_gw', 'order_gc', 5000, 'BDT', 'sslcommerz', 'full', 'succeeded', 'val_1');
    `);
    await expect(resolvePaymentSessionPolicy(db, order({ paidAmountMinor: 15_000, balanceDueMinor: 21_000 }), { paymentType: "full" }, null))
      .rejects.toThrow("Order has an outstanding balance; use a balance payment");
    await expect(resolvePaymentSessionPolicy(db, order({ paidAmountMinor: 15_000, balanceDueMinor: 21_000 }), { paymentType: "balance" }, null))
      .rejects.toThrow("No partial payment has been recorded for this order");
  });

  it("keeps real plans on their own path", async () => {
    sqlite.exec(`
      INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, status)
      VALUES ('plan_1', 'order_gc', ${TOTAL}, 10000, 26000, 'deposit_paid');
      UPDATE order_payments SET payment_method = 'sslcommerz', provider_ref = 'val_deposit' WHERE id = 'pay_gc';
    `);
    await expect(resolvePaymentSessionPolicy(db, order(), {}, null)).resolves.toEqual(balance);
    await expect(resolvePaymentSessionPolicy(db, order(), { paymentType: "full" }, null))
      .rejects.toThrow("Order has an outstanding balance; use a balance payment");
  });

  it("an unpaid order without gift cards is unchanged: full, or a deposit in a deposit store", async () => {
    const unpaid = order({ paymentStatus: "unpaid", paidAmountMinor: 0, balanceDueMinor: TOTAL });
    sqlite.exec(`DELETE FROM order_payments`);
    await expect(resolvePaymentSessionPolicy(db, unpaid, {}, { partialPaymentEnabled: false, partialPaymentAmount: 0 }))
      .resolves.toEqual({ paymentType: "full", chargeAmount: 360, chargeAmountMinor: TOTAL });
    await expect(resolvePaymentSessionPolicy(db, unpaid, {}, DEPOSIT_SETTINGS, undefined, BDT))
      .resolves.toMatchObject({ paymentType: "deposit", chargeAmountMinor: 10_000 });
  });
});
