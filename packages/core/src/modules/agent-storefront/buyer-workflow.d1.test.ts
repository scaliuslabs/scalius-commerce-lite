import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { UnauthorizedError, ValidationError } from "../../errors";
import {
  submitAgentStorefrontCheckout,
  type AgentStorefrontCheckoutSubmitInput,
} from "./buyer-workflow";
import { AgentStorefrontCheckoutQuoteConflictError } from "./quote-fingerprint";
import { quoteAgentStorefrontCheckout } from "./service";

const GRANT = "agr_storefront0123456789";
const CONTEXT = "asc_context0123456789abc";
const ACCOUNT_PHONE = "+8801711111111";
const DELIVERY_PHONE = "+8801812345678";

describe("agent storefront checkout submission on D1 storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO settings (id, key, value, type, category) VALUES
        ('s_currency', 'document', '{"currencyCode":"BDT","currencySymbol":"৳","usdExchangeRate":"1"}', 'json', 'currency'),
        ('s_countries', 'document', '{"allowedCountries":["BD"],"allowedCountriesMode":"include"}', 'json', 'customer_countries'),
        ('s_methods', 'document', '{"enabledMethods":["cod"],"defaultMethod":"cod"}', 'json', 'payment_methods'),
        ('s_checkout', 'document', '{"guestCheckoutEnabled":true,"checkoutMode":"all","partialPaymentEnabled":false,"partialPaymentAmount":0}', 'json', 'checkout');
      INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1),
             ('zone_1', 'Dhanmondi', 'zone', 'city_1', '{}', '{}', 1);
      INSERT INTO shipping_methods (id, name, fee, is_active) VALUES ('ship_1', 'Standard', 60, 1);
      INSERT INTO products (id, name, slug, price, is_active) VALUES ('prod_1', 'Tea', 'tea', 100, 1);
      INSERT INTO product_variants (id, product_id, sku, price, stock, is_default, track_inventory)
      VALUES ('variant_1', 'prod_1', 'TEA-1', 100, 10, 1, 1);
      INSERT INTO user (id, name, email) VALUES ('owner_1', 'Owner', 'owner@example.com');
      INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, preset, permissions_json,
        risk_ceiling, status, expires_at)
      VALUES ('${GRANT}', 'pat', 'owner_1', 'storefront', 'Buyer agent', 'full', '[]', 'read', 'active', ${now + 172_800});
      INSERT INTO customers (id, name, phone, account_claimed_at)
      VALUES ('cust_account', 'Account Holder', '${ACCOUNT_PHONE}', ${now - 86_400});
      INSERT INTO customer_sessions (token_hash, customer_id, expires_at)
      VALUES ('${"s".repeat(64)}', 'cust_account', ${now + 3_600});
      INSERT INTO agent_storefront_contexts (id, grant_id, revision, cart_json,
        city_id, zone_id, shipping_method_id, expires_at)
      VALUES ('${CONTEXT}', '${GRANT}', 2, '[{"variantId":"variant_1","quantity":2}]',
        'city_1', 'zone_1', 'ship_1', ${now + 3_600});
    `);
  });

  afterEach(() => sqlite.close());

  function signIn(): void {
    sqlite.exec(`UPDATE agent_storefront_contexts SET customer_session_token_hash = '${"s".repeat(64)}'`);
  }

  async function submit(overrides: Partial<AgentStorefrontCheckoutSubmitInput> = {}) {
    const expectedQuoteFingerprint = overrides.expectedQuoteFingerprint
      ?? (await quoteAgentStorefrontCheckout(db, GRANT, CONTEXT)).quoteFingerprint;
    return submitAgentStorefrontCheckout(db, GRANT, CONTEXT, {
      expectedRevision: 2,
      expectedQuoteFingerprint,
      idempotencyKey: "agent-checkout-key-0001",
      customerName: "Delivery Buyer",
      customerPhone: DELIVERY_PHONE,
      customerEmail: null,
      shippingAddress: "House 12, Road 4, Dhanmondi",
      notes: null,
      paymentMethod: "cod",
      ...overrides,
    }, { requestUrl: "https://shop.example.com/api/v1/agent" });
  }

  function expectNothingCommitted(): void {
    for (const table of ["orders", "checkout_attempts", "inventory_movements", "agent_storefront_order_grants"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, table).toBe(0);
    }
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants").get()).toEqual({ reserved_stock: 0 });
    expect(sqlite.prepare("SELECT revision, cart_json FROM agent_storefront_contexts").get())
      .toEqual({ revision: 2, cart_json: '[{"variantId":"variant_1","quantity":2}]' });
  }

  it.each([
    ["a SKU price", "UPDATE product_variants SET price = 120"],
    ["a shipping fee", "UPDATE shipping_methods SET fee = 80"],
  ])("refuses a reviewed quote made stale by %s change, then commits the refreshed quote", async (_change, sqlText) => {
    const reviewed = await quoteAgentStorefrontCheckout(db, GRANT, CONTEXT);
    sqlite.exec(sqlText);

    await expect(submit({ expectedQuoteFingerprint: reviewed.quoteFingerprint }))
      .rejects.toBeInstanceOf(AgentStorefrontCheckoutQuoteConflictError);
    expectNothingCommitted();

    const refreshed = await quoteAgentStorefrontCheckout(db, GRANT, CONTEXT);
    const result = await submit({ expectedQuoteFingerprint: refreshed.quoteFingerprint });
    expect(result.response).toMatchObject({ status: "complete", contextRevision: 3, totalAmount: refreshed.totalAmount });
    expect(sqlite.prepare("SELECT total_amount FROM orders").get()).toEqual({ total_amount: refreshed.totalAmount });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants").get()).toEqual({ reserved_stock: 2 });
    expect(sqlite.prepare("SELECT revision, cart_json FROM agent_storefront_contexts").get())
      .toEqual({ revision: 3, cart_json: "[]" });
    expect(sqlite.prepare("SELECT order_id, authority_kind FROM agent_storefront_order_grants").get())
      .toEqual({ order_id: result.response.orderId, authority_kind: "created" });
  });

  it("assigns a signed-in buyer's order to the account while delivering to another phone", async () => {
    signIn();
    const { response } = await submit();

    expect(sqlite.prepare("SELECT customer_id, account_owner_customer_id, customer_phone FROM orders WHERE id = ?")
      .get(response.orderId)).toEqual({
      customer_id: "cust_account",
      account_owner_customer_id: "cust_account",
      customer_phone: DELIVERY_PHONE,
    });
    expect(sqlite.prepare("SELECT phone FROM customers WHERE id = 'cust_account'").get())
      .toEqual({ phone: ACCOUNT_PHONE });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM customers").get()).toEqual({ count: 1 });
  });

  it("never grants account ownership to a guest who enters an account holder's phone", async () => {
    const { response } = await submit({ customerPhone: ACCOUNT_PHONE });

    expect(sqlite.prepare("SELECT customer_id, account_owner_customer_id FROM orders WHERE id = ?")
      .get(response.orderId)).toEqual({ customer_id: "cust_account", account_owner_customer_id: null });
  });

  it.each([
    ["a revoked session when guest checkout is off", () => {
      signIn();
      sqlite.exec(`UPDATE customer_sessions SET revoked_at = unixepoch();
        UPDATE settings SET value = json_set(value, '$.guestCheckoutEnabled', json('false')) WHERE category = 'checkout';`);
    }, {}, UnauthorizedError, "Please sign in before checkout."],
    ["a signed-in account without a phone", () => {
      signIn();
      sqlite.exec("UPDATE customers SET phone = '' WHERE id = 'cust_account'");
    }, {}, ValidationError, "missing its required phone number"],
    ["a delivery phone from a disallowed country", () => {}, { customerPhone: "+919876543210" }, ValidationError,
      "Phone numbers from IN are not accepted"],
  ] as const)("refuses %s before any checkout write", async (_case, arrange, overrides, errorType, message) => {
    arrange();
    const refusal = submit(overrides);
    await expect(refusal).rejects.toBeInstanceOf(errorType);
    await expect(refusal).rejects.toThrow(message);
    expectNothingCommitted();
  });
});
