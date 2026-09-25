// P3 (Wave A §3.5): a buyer-input schema change between the quote and the
// commit fails the checkout-authority fence, and an unrelated product edit
// does not.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "../../errors";
import { createAtomicCheckoutAttempt } from "./attempts";
import { commitStorefrontOrderPayload } from "./commit";
import type { StorefrontOrderCommitPayload } from "../orders/types";
import { updateProduct } from "../products/admin/write";
import { updateProductSchema } from "../products/validation";

const SCHEMA = JSON.stringify({
  version: 1,
  fields: [{ key: "engraving", label: "Engraving", type: "text", required: false, help: null, maxLength: 30, priceMinor: 2_000 }],
});
const PROPERTIES = JSON.stringify([
  { key: "engraving", type: "text", label: "Engraving", value: "Anika", displayValue: "Anika", priceMinor: 2_000 },
]);

function payloadFor(checkoutAuthorityRevision: number, orderId: string, checkoutToken: string): StorefrontOrderCommitPayload {
  return {
    checkoutToken,
    checkoutAuthorityRevision,
    existingCustomer: null,
    orderData: {
      id: orderId,
      customerName: "Engraving Buyer",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "123 Engraving Road",
      city: "city_1",
      zone: "zone_1",
      area: null,
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: null,
      notes: null,
      shippingMethodId: "shipping_standard",
      shippingMethodName: "Standard delivery",
      shippingMethodDescription: null,
      shippingMethodBaseAmountMinor: 6_000,
      shippingFeeWaived: false,
      requiresShipping: true,
      shippingMethodKind: "delivery",
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
      subtotalAmountMinor: 12_000,
      shippingAmountMinor: 6_000,
      discountAmountMinor: 0,
      taxAmountMinor: 0,
      totalAmountMinor: 18_000,
      taxLabel: "Tax",
      pricesIncludeTax: false,
      status: "incomplete",
      paymentMethod: "stripe",
      paymentStatus: "unpaid",
      paidAmountMinor: 0,
      balanceDueMinor: 18_000,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
    },
    items: [{
      id: "item_1",
      taxAllocationLineId: "cart:0:variant_1",
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "variant_1",
      quantity: 1,
      productName: "Engraved pen",
      variantLabel: null,
      productImageMediaId: null,
      inventoryTracked: true,
      fulfillmentType: "ship",
      properties: PROPERTIES,
      propertiesPriceMinor: 2_000,
      baseUnitPriceMinor: 10_000,
      unitPriceMinor: 12_000,
      lineSubtotalMinor: 12_000,
      discountAmountMinor: 0,
      taxableAmountMinor: 0,
      taxAmountMinor: 0,
    }],
    requestUrl: "https://shop.example.com/api/v1/orders",
    taxQuote: {
      schemaVersion: 1,
      calculationVersion: "tax-v1",
      enabled: false,
      currencyCode: "BDT",
      decimalPlaces: 2,
      displayLabel: "Tax",
      pricesIncludeTax: false,
      shippingTaxed: false,
      settingsVersion: 0,
      subtotalMinor: 12_000,
      shippingMinor: 6_000,
      discountMinor: 0,
      taxableMinor: 0,
      taxMinor: 0,
      totalMinor: 18_000,
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [{
        lineId: "cart:0:variant_1",
        productId: "prod_1",
        variantId: "variant_1",
        taxClassId: null,
        taxClassName: null,
        unitPriceMinor: 12_000,
        quantity: 1,
        grossAmountMinor: 12_000,
        discountMinor: 0,
        taxableAmountMinor: 0,
        taxMinor: 0,
        totalMinor: 12_000,
        components: [],
      }],
      shipping: {
        taxClassId: null,
        taxClassName: null,
        grossAmountMinor: 6_000,
        discountMinor: 0,
        taxableAmountMinor: 0,
        taxMinor: 0,
        totalMinor: 6_000,
        components: [],
      },
    },
  };
}

describe("buyer-input schema changes fence in-flight checkouts", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let beforeWriteBatch: (() => void | Promise<void>) | undefined;

  beforeEach(() => {
    beforeWriteBatch = undefined;
    ({ sqlite, db } = createSqliteD1Database({
      async beforeBatch(_sqlite, statements) {
        if (!statements.some((statement) => statement.query.startsWith('insert into "orders"'))) return;
        const beforeWrite = beforeWriteBatch;
        beforeWriteBatch = undefined;
        await beforeWrite?.();
      },
    }));
    sqlite.prepare(`
      INSERT INTO products (id, name, slug, price_minor, is_active, customization_schema)
      VALUES ('prod_1', 'Engraved pen', 'engraved-pen', 10000, 1, ?)
    `).run(SCHEMA);
    sqlite.exec(`
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
      VALUES ('variant_1', 'prod_1', 'PEN-1', 10000, 10, 1, 1);
      INSERT INTO shipping_methods (id, name, fee_minor, is_active)
      VALUES ('shipping_standard', 'Standard delivery', 6000, 1);
    `);
  });

  afterEach(() => sqlite.close());

  const authorityRevision = () =>
    Number(sqlite.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get()?.revision);

  function preparedCheckout() {
    const attempt = createAtomicCheckoutAttempt({
      checkoutRequestId: "properties-authority-test",
      requestKey: `checkout_submit:v1:${"a".repeat(64)}`,
      requestHash: "b".repeat(64),
      statusToken: `cst_${"a".repeat(64)}`,
    });
    return {
      payload: payloadFor(authorityRevision(), attempt.orderId, attempt.checkoutToken),
      commit: { attempt, response: { orderId: attempt.orderId } },
    };
  }

  function editProduct(extra: Record<string, unknown>) {
    const revision = Number(sqlite.prepare("SELECT aggregate_revision FROM products WHERE id = 'prod_1'").get()?.aggregate_revision);
    return updateProduct(db, "prod_1", updateProductSchema.parse({
      id: "prod_1",
      expectedAggregateRevision: revision,
      name: "Engraved pen",
      description: null,
      price: 100,
      categoryId: null,
      isActive: true,
      discountType: "percentage",
      discountPercentage: 0,
      discountAmount: 0,
      freeDelivery: false,
      metaTitle: null,
      metaDescription: null,
      canonicalPath: null,
      productCondition: "new",
      slug: "engraved-pen",
      media: [],
      attributes: [],
      additionalInfo: [],
      ...extra,
    }));
  }

  it("rejects a checkout prepared before the surcharge changed and writes nothing", async () => {
    const { payload, commit } = preparedCheckout();
    beforeWriteBatch = async () => {
      await editProduct({
        customizationSchema: { fields: [{ key: "engraving", label: "Engraving", type: "text", maxLength: 30, price: 50 }] },
      });
    };

    const failure = commitStorefrontOrderPayload(db, payload, commit);
    await expect(failure).rejects.toBeInstanceOf(ValidationError);
    await expect(failure).rejects.toThrow("Checkout details changed while the order was being placed");
    expect(authorityRevision()).toBeGreaterThan(payload.checkoutAuthorityRevision!);
    for (const table of ["orders", "order_items", "checkout_attempts", "inventory_movements"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, table).toBe(0);
    }
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get()?.reserved_stock).toBe(0);
  });

  it("rejects a checkout prepared before the buyer inputs were removed", async () => {
    const { payload, commit } = preparedCheckout();
    beforeWriteBatch = async () => { await editProduct({ customizationSchema: null }); };
    await expect(commitStorefrontOrderPayload(db, payload, commit))
      .rejects.toThrow("Checkout details changed while the order was being placed");
  });

  it("commits the frozen properties when the edit leaves checkout facts alone", async () => {
    const { payload, commit } = preparedCheckout();
    const before = authorityRevision();
    beforeWriteBatch = async () => { await editProduct({ metaTitle: "Pens engraved while you wait" }); };

    await expect(commitStorefrontOrderPayload(db, payload, commit)).resolves.toMatchObject({ alreadyCommitted: false });
    expect(authorityRevision()).toBe(before);
    expect(sqlite.prepare("SELECT properties, properties_price_minor, base_unit_price_minor, unit_price_minor FROM order_items").get())
      .toEqual({ properties: PROPERTIES, properties_price_minor: 2_000, base_unit_price_minor: 10_000, unit_price_minor: 12_000 });
  });
});
