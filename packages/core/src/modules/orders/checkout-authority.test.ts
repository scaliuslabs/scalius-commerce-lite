import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";

import {
  createStorefrontCheckoutAuthorityBatchReadPlan,
  createStorefrontCheckoutAuthorityReadPlan,
  loadStorefrontCheckoutAuthority,
} from "./checkout-authority";
import { isTrustedStorefrontCartValidationResult } from "./cart-validation";
import { isTrustedStorefrontDeliveryPreflightResult } from "./orders.storefront";
import { isTrustedStorefrontTaxAuthority } from "../tax";

interface MockD1Result {
  results: Record<string, unknown>[];
  success: true;
  meta: Record<string, never>;
}

interface MockD1Statement {
  query: string;
  values: unknown[];
  bind(...values: unknown[]): MockD1Statement;
  all(): Promise<MockD1Result>;
  run(): Promise<MockD1Result>;
  raw(): Promise<unknown[][]>;
  first(): Promise<unknown>;
}

function createStatement(query: string, values: unknown[] = []): MockD1Statement {
  const empty = async (): Promise<MockD1Result> => ({ results: [], success: true, meta: {} });
  return {
    query,
    values,
    bind: (...nextValues) => createStatement(query, nextValues),
    all: empty,
    run: empty,
    raw: async () => [],
    first: async () => null,
  };
}

function settingsDocument(category: string, value: Record<string, unknown>) {
  return { category, value: JSON.stringify(value), revision: 1 };
}

function authorityRows(): Record<string, unknown>[][] {
  return [
    [
      settingsDocument("currency", { currencyCode: "BDT", currencySymbol: "৳", usdExchangeRate: "1" }),
      settingsDocument("customer_countries", { allowedCountries: ["BD"], allowedCountriesMode: "include" }),
      settingsDocument("payment_methods", { enabledMethods: ["cod"], defaultMethod: "cod" }),
    ],
    [settingsDocument("checkout", {
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
    })],
    [{
      id: "product_1",
      name: "Product 1",
      isActive: 1,
      priceMinor: 10_000,
      discountBps: 0,
      discountType: null,
      discountAmountMinor: 0,
      freeDelivery: 0,
      taxClassId: null,
    }],
    [{
      id: "variant_1",
      productId: "product_1",
      optionCombinationKey: null,
      optionLabel: null,
      stock: 10,
      reservedStock: 0,
      preorderStock: 0,
      isDefault: 1,
      trackInventory: 1,
      allowPreorder: 0,
      allowBackorder: 0,
      backorderLimit: 0,
      priceMinor: 10_000,
      discountBps: 0,
      discountType: null,
      discountAmountMinor: 0,
      taxClassId: null,
      imageId: null,
    }],
    [],
    [
      { id: "city_1", name: "Dhaka", type: "city", parentId: null, isActive: 1, deletedAt: null },
      { id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1", isActive: 1, deletedAt: null },
    ],
    [{
      id: "shipping_1",
      name: "Standard delivery",
      description: "Delivered within 2–3 business days",
      feeMinor: 6_000,
      isActive: 1,
      deletedAt: null,
    }],
    [{
      revision: 1,
      hasActiveAdminPushTarget: 0,
    }],
    [],
    [],
    [],
  ];
}

function createMockDatabase(rows = authorityRows()) {
  const batches: MockD1Statement[][] = [];
  const binding = {
    prepare: (query: string) => createStatement(query),
    batch: vi.fn(async (statements: MockD1Statement[]) => {
      batches.push(statements);
      return rows.map((results) => ({ results, success: true as const, meta: {} }));
    }),
  };
  return {
    db: drizzle(binding as unknown as D1Database, { schema }) as unknown as Database,
    batches,
    batch: binding.batch,
  };
}

const input = {
  items: [{
    productId: "product_1",
    variantId: "variant_1",
    quantity: 1,
    price: 100,
    productName: "Product 1",
    variantLabel: null,
  }],
  inventoryPool: "regular",
  city: "city_1",
  zone: "zone_1",
  area: null,
  shippingMethodId: "shipping_1",
  customerEmail: null,
  customerPhone: "+8801700000000",
};

describe("storefront checkout authority read", () => {
  it("resolves every normal checkout authority from one consistent D1 batch", async () => {
    const fixture = createMockDatabase();

    const snapshot = await loadStorefrontCheckoutAuthority(fixture.db, input);

    expect(fixture.batch).toHaveBeenCalledOnce();
    expect(fixture.batches[0]).toHaveLength(11);
    expect(snapshot).toMatchObject({
      currency: { currencyCode: "BDT", currencySymbol: "৳" },
      checkoutSettings: {
        guestCheckoutEnabled: true,
        checkoutMode: "all",
        partialPaymentEnabled: false,
      },
      allowedCountries: { allowedCountries: ["BD"], allowedCountriesMode: "include" },
      activePaymentMethods: { enabledMethods: ["cod"], defaultMethod: "cod" },
      cartValidation: { valid: true, subtotalMinor: 10_000 },
      deliveryPreflight: {
        shippingMinor: 6_000,
        shippingMethod: {
          id: "shipping_1",
          name: "Standard delivery",
          description: "Delivered within 2–3 business days",
          baseAmountMinor: 6_000,
          feeWaived: false,
        },
        cityName: "Dhaka",
        zoneName: "Mirpur",
      },
      sideEffects: { orderCreatedNotification: false, metaPurchase: false },
    });
    expect(isTrustedStorefrontCartValidationResult(snapshot.cartValidation)).toBe(true);
    expect(isTrustedStorefrontDeliveryPreflightResult(snapshot.deliveryPreflight)).toBe(true);
    expect(isTrustedStorefrontTaxAuthority(snapshot.taxAuthority)).toBe(true);
  });

  it("keeps a 99-line checkout below D1's 100-parameter statement limit", async () => {
    const fixture = createMockDatabase();
    const manyItems = Array.from({ length: 99 }, (_, index) => ({
      ...input.items[0]!,
      productId: `product_${index}`,
      variantId: `variant_${index}`,
    }));
    const plan = createStorefrontCheckoutAuthorityReadPlan(fixture.db, {
      ...input,
      items: manyItems,
    });

    await fixture.db.batch(plan.statements as never);

    const statements = fixture.batches[0]!;
    expect(statements).toHaveLength(11);
    expect(Math.max(...statements.map((statement) => statement.values.length))).toBeLessThan(100);
    expect(statements[2]?.query).toContain("json_each(?)");
    expect(statements[3]?.query).toContain("json_each(?)");
    expect(statements[4]?.query).toContain("json_each(?)");
  });

  it("resolves many checkouts from one shared authority batch", async () => {
    const fixture = createMockDatabase();
    const plan = createStorefrontCheckoutAuthorityBatchReadPlan(
      fixture.db,
      Array.from({ length: 200 }, () => input),
    );

    const results = await fixture.db.batch(plan.statements as never);
    const snapshots = await plan.resolve(results as unknown[]);

    expect(plan.statements).toHaveLength(11);
    expect(snapshots).toHaveLength(200);
    expect(snapshots.every((snapshot) =>
      snapshot.cartValidation.valid
      && snapshot.cartValidation.subtotalMinor === 10_000
      && snapshot.deliveryPreflight.shippingMinor === 6_000
    )).toBe(true);
    expect(isTrustedStorefrontTaxAuthority(snapshots[199]?.taxAuthority)).toBe(true);
  });

  it("requests checkout side effects only when a real target or enabled Meta integration exists", async () => {
    const rows = authorityRows();
    rows[0]!.push(
      settingsDocument("notifications", {
        orderChannels: { order_created: ["email"] },
        adminChannels: { order_created: ["push"] },
      }),
      // A stored token counts even when this request cannot decrypt it.
      settingsDocument("meta_conversions", {
        isEnabled: true,
        pixelId: "123456789012345",
        accessToken: "enc:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBB",
      }),
    );
    rows[7] = [{ revision: 1, hasActiveAdminPushTarget: 1 }];
    const fixture = createMockDatabase(rows);
    const plan = createStorefrontCheckoutAuthorityReadPlan(fixture.db, {
      ...input,
      customerEmail: "buyer@example.com",
    });

    const results = await fixture.db.batch(plan.statements as never);
    const snapshot = await plan.resolve(results as unknown[]);

    expect(snapshot.sideEffects).toEqual({
      orderCreatedNotification: true,
      metaPurchase: true,
    });
  });
});
