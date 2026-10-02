// The known-answer store the metric tests share (amounts in paisa). Every
// expected figure in metrics.d1.test.ts is derived by hand in its comment.
import type { AnalyticsFixture } from "./reports.fixture";

export function seedKnownAnswerStore(f: AnalyticsFixture): void {
  f.category("cat_shirts", "Shirts");
  f.brand("brd_aarong", "Aarong");
  f.product("prod_a", "Panjabi", { categoryId: "cat_shirts", brandId: "brd_aarong" });
  f.product("prod_b", "Saree");
  f.product("prod_c", "Tee", { categoryId: "cat_shirts" });
  f.product("prod_d", "Perfume");
  f.product("prod_e", "Wallet");
  f.product("prod_gc", "Gift card");
  f.variant("var_a", "prod_a", "PNJ-1", { priceMinor: 50_000, stock: 10 });
  f.variant("var_b", "prod_b", "SAR-1", { priceMinor: 30_000, stock: 0 });
  f.variant("var_c", "prod_c", "TEE-1", { priceMinor: 20_000, stock: 4, lowStockThreshold: 5 });
  f.variant("var_d", "prod_d", "PRF-1", { priceMinor: 11_500, stock: 2 });
  f.variant("var_e", "prod_e", "WAL-1", { priceMinor: 20_000, stock: 1 });

  // O1: delivered COD, first order of c1. gross 100000, disc 10000, ship 6000 → total 96000.
  f.order({
    id: "o1", createdAt: "2026-08-05T10:00:00+06:00", status: "delivered", paymentMethod: "cod",
    customerId: "c1", customerPhone: "+8801711000001", shippingMinor: 6_000, paidMinor: 96_000,
    shippingMethodId: null,
    lines: [{ id: "o1_a", productId: "prod_a", variantId: "var_a", quantity: 2, unitMinor: 50_000, discountMinor: 10_000 }],
  });
  f.cod({ orderId: "o1", status: "collected", collectedMinor: 96_000, collectedAt: "2026-08-07T12:00:00+06:00" });
  f.shipment({ id: "s1", orderId: "o1", status: "delivered", courier: "Pathao", providerType: "pathao", createdAt: "2026-08-06T10:00:00+06:00" });

  // O2: COD returned to sender, first order of c2. Reversed: gross 30000 = returns, total 0.
  f.order({
    id: "o2", createdAt: "2026-08-06T09:00:00+06:00", status: "returned", paymentMethod: "cod",
    customerId: "c2", customerPhone: "+8801711000002", shippingMinor: 6_000, cityName: "Chattogram",
    lines: [{ id: "o2_b", productId: "prod_b", variantId: "var_b", quantity: 1, unitMinor: 30_000 }],
  });
  f.cod({ orderId: "o2", status: "returned" });
  f.shipment({ id: "s2", orderId: "o2", status: "returned", courier: "Pathao", providerType: "pathao", createdAt: "2026-08-07T09:00:00+06:00" });

  // O3: prepaid, tax-exclusive, c1's second order, one Tee returned, ৳200 refunded.
  // Lines: A 1×50000 tax 5000; C 3×20000 disc 6000 tax 5400. Shipping 6000 with a
  // 2000 discount and 600 tax: order discount 8000, order tax 11000.
  // gross 110000, disc 6000, returns (60000−6000)×1/3 = 18000, net 86000;
  // shipping 6000 − 2000 = 4000; taxes 5000 + (5400 − 1800) + 600 = 9200; total 99200.
  f.order({
    id: "o3", createdAt: "2026-08-10T15:00:00+06:00", status: "delivered", paymentMethod: "sslcommerz",
    customerId: "c1", customerPhone: "+8801711000001", shippingMinor: 6_000, discountMinor: 8_000, taxMinor: 11_000,
    paidMinor: 119_000,
    lines: [
      { id: "o3_a", productId: "prod_a", variantId: "var_a", quantity: 1, unitMinor: 50_000, taxMinor: 5_000 },
      { id: "o3_c", productId: "prod_c", variantId: "var_c", quantity: 3, unitMinor: 20_000, discountMinor: 6_000, taxMinor: 5_400 },
    ],
  });
  f.returnCase({ id: "ret_o3", orderId: "o3", status: "completed", lines: [{ itemId: "o3_c", variantId: "var_c", approved: 1 }] });
  f.payment({ id: "pay_o3", orderId: "o3", amountMinor: 119_000, method: "sslcommerz", status: "confirmed" });
  f.payment({ id: "ref_o3", orderId: "o3", amountMinor: 20_000, method: "sslcommerz", type: "refund", status: "refunded" });
  f.payment({ id: "ref_o3_pending", orderId: "o3", amountMinor: 5_000, method: "sslcommerz", type: "refund", status: "pending" });

  // O4 cancelled (counted only by the cancellation rate), O5 incomplete and
  // O6 deleted (never counted), O7 in another currency (counted, never summed).
  f.order({
    id: "o4", createdAt: "2026-08-12T10:00:00+06:00", status: "cancelled", customerId: "c3",
    customerPhone: "+8801711000003", lines: [{ id: "o4_a", productId: "prod_a", quantity: 1, unitMinor: 50_000 }],
  });
  f.order({
    id: "o5", createdAt: "2026-08-12T11:00:00+06:00", status: "incomplete", paymentMethod: "stripe",
    lines: [{ id: "o5_a", productId: "prod_a", quantity: 1, unitMinor: 50_000 }],
  });
  f.order({
    id: "o6", createdAt: "2026-08-12T12:00:00+06:00", status: "pending", deletedAt: 1_786_000_000,
    lines: [{ id: "o6_a", productId: "prod_a", quantity: 1, unitMinor: 50_000 }],
  });
  f.order({
    id: "o7", createdAt: "2026-08-15T12:00:00+06:00", status: "delivered", currencyCode: "USD", paymentMethod: "stripe",
    lines: [{ id: "o7_a", productId: "prod_a", quantity: 1, unitMinor: 9_999 }],
  });

  // O8: prices include tax, guest P1 who ordered in July (O9). gross 11500 − 1500 = 10000, taxes 1500, total 11500.
  f.order({
    id: "o8", createdAt: "2026-08-20T23:30:00+06:00", status: "delivered", paymentMethod: "stripe",
    customerPhone: "+8801799999999", pricesIncludeTax: true, paidMinor: 11_500, requiresShipping: false,
    lines: [{ id: "o8_d", productId: "prod_d", variantId: "var_d", quantity: 1, unitMinor: 11_500, taxMinor: 1_500, fulfillmentType: "pickup", fulfilledQuantity: 1 }],
  });
  // O9: the last second of July in Dhaka (17:59:59 UTC): previous period only.
  f.order({
    id: "o9", createdAt: "2026-07-31T23:59:59+06:00", status: "delivered", paymentMethod: "stripe",
    customerPhone: "+8801799999999", pricesIncludeTax: true, paidMinor: 23_000, requiresShipping: false,
    lines: [{ id: "o9_d", productId: "prod_d", variantId: "var_d", quantity: 2, unitMinor: 11_500, taxMinor: 3_000, fulfillmentType: "pickup", fulfilledQuantity: 2 }],
  });

  // O10: the last second of August in Dhaka; a dashboard order from Facebook with a
  // gift card line (a liability, not a sale): gross 20000, total sales 20000.
  f.order({
    id: "o10", createdAt: "2026-08-31T23:59:59+06:00", status: "pending", paymentMethod: "cod", channel: "admin",
    channelSource: "facebook", customerId: "c4", customerPhone: "+8801711000004",
    lines: [
      { id: "o10_e", productId: "prod_e", variantId: "var_e", quantity: 1, unitMinor: 20_000, fulfilledQuantity: 0 },
      { id: "o10_gc", productId: "prod_gc", quantity: 1, unitMinor: 100_000, fulfillmentType: "gift_card" },
    ],
  });
  // O11: the first second of September in Dhaka (18:00 UTC on 31 August): outside August.
  f.order({
    id: "o11", createdAt: "2026-09-01T00:00:00+06:00", status: "pending", customerId: "c5", customerPhone: "+8801711000005",
    lines: [{ id: "o11_a", productId: "prod_a", quantity: 1, unitMinor: 50_000 }],
  });
  // O12: the first second of August in Dhaka (18:00 UTC on 31 July): inside August. Shipped COD.
  f.order({
    id: "o12", createdAt: "2026-08-01T00:00:00+06:00", status: "shipped", paymentMethod: "cod", customerId: "c5",
    customerPhone: "+8801711000005", fulfillmentStatus: "complete",
    lines: [{ id: "o12_a", productId: "prod_a", variantId: "var_a", quantity: 1, unitMinor: 50_000 }],
  });
  f.cod({ orderId: "o12", status: "pending" });
  f.shipment({ id: "s12", orderId: "o12", status: "in_transit", courier: "Steadfast", providerType: "steadfast", createdAt: "2026-08-02T10:00:00+06:00" });
}

/** Discounts, a gift card and abandoned checkouts on top of the known-answer store. */
export function seedKnownAnswerExtras(fixture: AnalyticsFixture): void {
  const { sqlite, epoch } = fixture;
  // A code discount on O1's line (the whole of O1's discount); O3's discount has no promotion.
  sqlite.prepare(`INSERT INTO promotions (id, name, method, status) VALUES ('promo_1', 'Eid sale', 'code', 'active')`).run();
  sqlite.prepare(`
    INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position)
    VALUES ('eff_1', 'promo_1', 'percentage_off', 'line', 'across', '{"basisPoints":1000}', 0)
  `).run();
  sqlite.prepare(`INSERT INTO promotion_codes (id, promotion_id, code, normalized_code) VALUES ('code_1', 'promo_1', 'EID10', 'EID10')`).run();
  sqlite.prepare(`
    INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
      evaluator_version, method, promotion_name, promotion_code, effect_kind, target, currency_code,
      base_amount_minor, discount_amount_minor, quantity)
    VALUES ('alloc_1', 'o1', 'o1_a', 'promo_1', 'eff_1', 1, 1, 'code', 'Eid sale', 'EID10', 'percentage_off', 'line', 'BDT', 100000, 10000, 2)
  `).run();
  // A staff-issued ৳500 card, ৳200 of it redeemed on O3.
  sqlite.prepare(`
    INSERT INTO gift_cards (id, code_hash, code_ciphertext, code_last4, currency_code, initial_amount_minor, status, source, created_at)
    VALUES ('gc_testcard01', 'hash', 'cipher', 'ABCD', 'BDT', 50000, 'active', 'manual', ?)
  `).run(epoch("2026-08-03T10:00:00+06:00"));
  sqlite.prepare(`
    INSERT INTO gift_card_transactions (id, gift_card_id, kind, amount_minor, balance_after_minor, idempotency_key, actor_type, created_at)
    VALUES ('gct_issue0001', 'gc_testcard01', 'issue', 50000, 50000, 'issue-1', 'admin', ?)
  `).run(epoch("2026-08-03T10:00:00+06:00"));
  sqlite.prepare(`
    INSERT INTO gift_card_transactions (id, gift_card_id, kind, amount_minor, balance_after_minor, order_id, idempotency_key, actor_type, created_at)
    VALUES ('gct_redeem001', 'gc_testcard01', 'redeem', -20000, 30000, 'o3', 'redeem-1', 'customer', ?)
  `).run(epoch("2026-08-10T15:00:00+06:00"));
  // Abandoned checkouts: one recovered by O10 the next day, one too long before O10, one without a phone.
  const abandoned = sqlite.prepare(`
    INSERT INTO abandoned_checkouts (id, checkout_id, customer_phone, checkout_data, created_at, updated_at)
    VALUES (?, ?, ?, '{}', ?, ?)
  `);
  abandoned.run("ab_1", "chk_1", "+8801711000004", epoch("2026-08-03T10:00:00+06:00"), epoch("2026-08-03T10:05:00+06:00"));
  abandoned.run("ab_2", "chk_2", "+8801711000004", epoch("2026-08-30T10:00:00+06:00"), epoch("2026-08-30T10:05:00+06:00"));
  abandoned.run("ab_3", "chk_3", null, epoch("2026-08-15T10:00:00+06:00"), epoch("2026-08-15T10:05:00+06:00"));
}

export const AUGUST = { from: "2026-08-01", to: "2026-08-31" } as const;
