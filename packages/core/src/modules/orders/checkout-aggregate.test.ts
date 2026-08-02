import { describe, expect, it } from "vitest";

import type { AtomicCheckoutAttempt } from "./checkout-attempts";
import {
  getCoordinatedCheckoutEligibility,
  prepareCheckoutCommitCommand,
} from "./checkout-aggregate";
import type { StorefrontOrderCommitPayload } from "./orders.types";

function payload(overrides: Partial<StorefrontOrderCommitPayload["orderData"]> = {}): StorefrontOrderCommitPayload {
  return {
    checkoutToken: "chk_test_proof",
    checkoutAuthorityRevision: 7,
    existingCustomer: null,
    orderData: {
      id: "order_aggregate_1",
      customerName: "Buyer",
      customerPhone: "+8801700000000",
      customerEmail: null,
      shippingAddress: "Dhaka",
      city: "city_1",
      zone: "zone_1",
      area: null,
      cityName: "Dhaka",
      zoneName: "Dhanmondi",
      areaName: null,
      notes: null,
      totalAmount: 210,
      shippingCharge: 10,
      discountAmount: 0,
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
      subtotalAmountMinor: 20_000,
      shippingAmountMinor: 1_000,
      discountAmountMinor: 0,
      taxAmountMinor: 0,
      totalAmountMinor: 21_000,
      taxLabel: "Tax",
      pricesIncludeTax: false,
      status: "pending",
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      paidAmount: 0,
      balanceDue: 210,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
      ...overrides,
    },
    items: [{
      id: "item_1",
      taxAllocationLineId: "line_1",
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
      productName: "Product",
      variantLabel: null,
      inventoryTracked: true,
      productImageMediaId: null,
      unitPriceMinor: 10_000,
      lineSubtotalMinor: 10_000,
      discountAmountMinor: 0,
      taxableAmountMinor: 10_000,
      taxAmountMinor: 0,
    }, {
      id: "item_2",
      taxAllocationLineId: "line_2",
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
      productName: "Product",
      variantLabel: null,
      inventoryTracked: true,
      productImageMediaId: null,
      unitPriceMinor: 10_000,
      lineSubtotalMinor: 10_000,
      discountAmountMinor: 0,
      taxableAmountMinor: 10_000,
      taxAmountMinor: 0,
    }],
    discountUsage: null,
    promotion: null,
    requestUrl: "https://api.example.test/orders",
    taxQuote: {
      schemaVersion: 1,
      calculationVersion: "tax-v1",
      enabled: false,
      currencyCode: "BDT",
      decimalPlaces: 2,
      displayLabel: "Tax",
      pricesIncludeTax: false,
      shippingTaxed: false,
      subtotalMinor: 20_000,
      shippingMinor: 1_000,
      discountMinor: 0,
      taxableMinor: 20_000,
      taxMinor: 0,
      totalMinor: 21_000,
      settingsVersion: 1,
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [],
      shipping: {
        taxClassId: null,
        taxClassName: null,
        grossAmountMinor: 1_000,
        discountMinor: 0,
        taxableAmountMinor: 1_000,
        taxMinor: 0,
        totalMinor: 1_000,
        components: [],
      },
    },
  };
}

function attempt(): AtomicCheckoutAttempt {
  return {
    commitMode: "atomic",
    origin: "new",
    id: "attempt_1",
    requestKey: "checkout_submit:v1:key_1",
    requestHash: "hash_1",
    orderId: "order_aggregate_1",
    checkoutToken: "chk_test_proof",
    statusToken: "cst_status_1",
  };
}

describe("checkout aggregate command", () => {
  it("prepares one immutable command and consolidates duplicate SKU lines", async () => {
    const response = {
      orderId: "order_aggregate_1",
      receiptToken: "chk_test_proof",
      message: "Order created",
    };
    const command = await prepareCheckoutCommitCommand(payload(), attempt(), response);

    expect(command.reservations).toEqual([{
      variantId: "variant_1",
      pool: "regular",
      quantity: 2,
    }]);
    expect(command.order).toMatchObject({
      id: "order_aggregate_1",
      customerId: null,
      accountOwnerCustomerId: null,
      inventoryAction: "reserved",
    });
    expect(command.aggregate.checkout).toMatchObject({
      requestKey: attempt().requestKey,
      requestHash: attempt().requestHash,
      authorityRevision: 7,
      response,
    });
    expect(command.receiptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps authenticated ownership authoritative in the hot order row", async () => {
    const input = payload();
    input.existingCustomer = { id: "customer_1" };
    const command = await prepareCheckoutCommitCommand(input, attempt(), {
      orderId: "order_aggregate_1",
      receiptToken: "chk_test_proof",
    });
    expect(command.order.customerId).toBe("customer_1");
    expect(command.order.accountOwnerCustomerId).toBe("customer_1");
  });

  it("omits undeliverable optional side-effect identities from the aggregate", async () => {
    const input = payload();
    input.checkoutSideEffects = {
      orderCreatedNotification: false,
      metaPurchase: false,
    };

    const command = await prepareCheckoutCommitCommand(input, attempt(), {
      orderId: "order_aggregate_1",
      receiptToken: "chk_test_proof",
    });

    expect(command.aggregate.projection).toMatchObject({
      notificationOutboxId: null,
      metaPurchaseOutboxId: null,
    });
  });

  it("fails closed to the legacy commit for unproven checkout classes", () => {
    expect(getCoordinatedCheckoutEligibility(payload({ inventoryPool: "preorder" })))
      .toEqual({ eligible: false, reason: "non_regular_inventory_pool" });
    expect(getCoordinatedCheckoutEligibility(payload({ paymentMethod: "stripe" })))
      .toEqual({ eligible: false, reason: "non_cod_payment" });
  });

  it("rejects an attempt or response bound to a different order", async () => {
    await expect(prepareCheckoutCommitCommand(payload(), {
      ...attempt(),
      orderId: "other_order",
    }, {
      orderId: "order_aggregate_1",
      receiptToken: "chk_test_proof",
    })).rejects.toThrow(/attempt identity/i);

    await expect(prepareCheckoutCommitCommand(payload(), attempt(), {
      orderId: "other_order",
      receiptToken: "chk_test_proof",
    })).rejects.toThrow(/response identity/i);
  });
});
