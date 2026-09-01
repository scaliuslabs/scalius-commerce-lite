import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import {
  attachAuthoritativeQuote,
  buildCartValidationPayload,
  buildCheckoutPayload,
  buildFixtureSql,
  buildOtpFixtureSql,
  buildPaymentReadinessFixtureSql,
  buildReceiptLookupRequest,
  buildTaxQuotePayload,
  getPostsaleConfig,
} from "./dev-postsale.mjs";

describe("local post-sale smoke CLI", () => {
  it.each(["help", "--help", "-h"])("keeps %s read-only", (helpArg) => {
    const result = spawnSync(process.execPath, ["scripts/dev-postsale.mjs", helpArg], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOCAL_API_BASE_URL: "https://api.scalius.com",
        SCALIUS_PNPM_BIN: "/definitely/missing/pnpm",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Local post-sale smoke helper");
    expect(result.stderr).toBe("");
  });

  it("rejects non-local mutation targets", () => {
    expect(() => getPostsaleConfig(["seed", "--api", "https://api.scalius.com"], {})).toThrow(
      /known production/,
    );
    expect(() => getPostsaleConfig(["seed", "--api", "https://staging.example.com"], {})).toThrow(
      /non-local/,
    );
  });

  it("keeps staging mutation support disabled until an explicit policy exists", () => {
    expect(() => getPostsaleConfig(["seed", "--target", "staging"], {})).toThrow(
      /local-only/,
    );
  });

  it("accepts loopback local targets and parses load sizing", () => {
    const config = getPostsaleConfig([
      "load",
      "--api",
      "http://127.0.0.1:8787/",
      "--orders",
      "12",
      "--concurrency",
      "3",
      "--state",
      "tmp/post-sale-state",
    ], {});

    expect(config.command).toBe("load");
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:8787");
    expect(config.orders).toBe(12);
    expect(config.concurrency).toBe(3);
    expect(config.wranglerState).toMatch(/tmp\/post-sale-state$/);
  });

  it("rejects online payment modes for local mutation smokes", () => {
    expect(() => getPostsaleConfig(["checkout-smoke", "--payment", "stripe"], {})).toThrow(
      /COD only/,
    );
  });

  it("accepts the local payment readiness smoke command", () => {
    const config = getPostsaleConfig(["payment-readiness", "--api", "http://localhost:8787"], {});

    expect(config.command).toBe("payment-readiness");
    expect(config.paymentMethod).toBe("cod");
  });

  it("builds a SKU-first checkout payload and matching cart-validation payload", () => {
    const payload = buildCheckoutPayload({ sequence: 42, checkoutRequestId: "ops006_fixed_checkout" });
    const cartPayload = buildCartValidationPayload(payload);

    expect(payload.checkoutRequestId).toBe("ops006_fixed_checkout");
    expect(payload.paymentMethod).toBe("cod");
    expect(payload.customerPhone).toMatch(/^\+88017\d{8}$/);
    expect(payload.items).toEqual([
      expect.objectContaining({
        productId: "ops006_product",
        variantId: "ops006_variant_default",
        quantity: 1,
        price: 1200,
      }),
    ]);
    expect(cartPayload).toEqual({
      items: payload.items,
      inventoryPool: "regular",
      city: "ops006_city_dhaka",
      zone: "ops006_zone_mirpur",
      area: "ops006_area_section_10",
      shippingMethodId: "ops006_shipping_standard",
    });
  });

  it("submits the exact authoritative quote fingerprint reviewed by the smoke", () => {
    const payload = buildCheckoutPayload({ sequence: 7 });
    const quotePayload = buildTaxQuotePayload(payload);
    const quotedPayload = attachAuthoritativeQuote(payload, {
      success: true,
      data: { quoteFingerprint: "taxq_abcdefghijklmnopqrstuv" },
    });

    expect(quotePayload).toMatchObject({
      items: payload.items,
      shippingMethodId: payload.shippingMethodId,
      customerPhone: payload.customerPhone,
    });
    expect(quotedPayload.expectedQuoteFingerprint).toBe("taxq_abcdefghijklmnopqrstuv");
    expect(payload).not.toHaveProperty("expectedQuoteFingerprint");
    expect(() => attachAuthoritativeQuote(payload, { data: {} })).toThrow(/valid quote fingerprint/);
  });

  it("sends receipt proof through the header instead of the URL", () => {
    const request = buildReceiptLookupRequest("order 1", "chk_private");

    expect(request.path).toBe("/api/v1/orders/receipt/order%201");
    expect(request.path).not.toContain("chk_private");
    expect(request.path).not.toContain("token=");
    expect(request.headers).toEqual({ "X-Receipt-Token": "chk_private" });
  });

  it("seeds checkout, auth policy, delivery, and one untracked default SKU", () => {
    const sql = buildFixtureSql();

    expect(sql).toContain("INSERT INTO site_settings");
    expect(sql).toContain("'payment_methods'");
    expect(sql).toContain("'currency_code'");
    expect(sql).toContain("'BDT'");
    expect(sql).toContain("'usd_exchange_rate'");
    expect(sql).toContain("'customer_auth'");
    expect(sql).toContain("'allowed_countries'");
    expect(sql).toContain("'ops006_shipping_standard'");
    expect(sql).toContain("'ops006_product'");
    expect(sql).toContain("'ops006_variant_default'");
    expect(sql).toContain("option_combination_key");
    expect(sql).not.toMatch(/\b(?:size|color|size_sort_order|color_sort_order)\b/);
    expect(sql).toContain("is_default = 1");
    expect(sql).toContain("track_inventory = 0");
  });

  it("keeps OTP setup independent from catalog fixtures", () => {
    const sql = buildOtpFixtureSql();

    expect(sql).toContain("INSERT INTO site_settings");
    expect(sql).toContain("'customer_auth'");
    expect(sql).toContain("'email_sender'");
    expect(sql).not.toContain("INSERT INTO products");
    expect(sql).not.toContain("INSERT INTO product_variants");
  });

  it("seeds committed online orders while clearing gateway side-effect rows", () => {
    const sql = buildPaymentReadinessFixtureSql();

    expect(sql).toContain("DELETE FROM payment_session_attempts");
    expect(sql).toContain("DELETE FROM payment_plans");
    expect(sql).toContain("DELETE FROM settings WHERE category IN ('stripe', 'sslcommerz', 'polar')");
    expect(sql).toContain("partial_payment_enabled = 1");
    expect(sql).toContain("partial_payment_amount = 150");
    expect(sql).toContain("currency_code, currency_decimal_places");
    expect(sql).toContain("subtotal_amount_minor");
    expect(sql).toContain("total_amount_minor");
    expect(sql).toContain("'BDT', 2, 120000, 8000, 0, 0, 128000, 'pending'");
    expect(sql).toContain("'ops006_order_stripe'");
    expect(sql).toContain("'ops006_order_sslcommerz'");
    expect(sql).toContain("'ops006_order_polar'");
    expect(sql).toContain("'chk_ops006_stripe'");
    expect(sql).toContain("'committed'");
    expect(sql).toContain("'payment_methods'");
    expect(sql).toContain("stripe");
    expect(sql).toContain("sslcommerz");
    expect(sql).toContain("polar");
  });
});
