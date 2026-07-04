import { describe, expect, it } from "vitest";
import {
  buildCartValidationPayload,
  buildCheckoutPayload,
  buildFixtureSql,
  getPostsaleConfig,
} from "./dev-postsale.mjs";

describe("local post-sale smoke CLI", () => {
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

  it("seeds checkout, auth policy, delivery, and one untracked default SKU", () => {
    const sql = buildFixtureSql();

    expect(sql).toContain("INSERT INTO site_settings");
    expect(sql).toContain("'payment_methods'");
    expect(sql).toContain("'customer_auth'");
    expect(sql).toContain("'allowed_countries'");
    expect(sql).toContain("'ops006_shipping_standard'");
    expect(sql).toContain("'ops006_product'");
    expect(sql).toContain("'ops006_variant_default'");
    expect(sql).toContain("is_default = 1");
    expect(sql).toContain("track_inventory = 0");
  });
});
