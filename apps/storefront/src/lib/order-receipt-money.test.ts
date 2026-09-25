import { describe, expect, it } from "vitest";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA as bn,
  ENGLISH_CHECKOUT_LANGUAGE_DATA as en,
} from "@scalius/shared/checkout-language";
import { orderDeliveryRow } from "./order-delivery-row";
import { orderShowsLineDiscounts, presentedLineTotalMinor } from "./order-line-discounts";
import { formatOrderSuccessPaymentMethod } from "./order-success-localization";

const money = (amount: number) => `৳${amount}`;

describe("placed order discounts", () => {
  it("shows an order-level promotion once, in the totals, and each line at full price", () => {
    const discounts = [{ kind: "order", amount: 100 }];
    expect(orderShowsLineDiscounts(discounts)).toBe(false);
    const line = { grossSubtotalMinor: 100_000, discountMinor: 10_000, taxMinor: 0 };
    expect(presentedLineTotalMinor(line, false, false)).toBe(100_000);
  });

  it("keeps item-level savings on their lines: product, buy-x-get-y, and line savings with no promotion", () => {
    expect(orderShowsLineDiscounts([{ kind: "product", amount: 200 }])).toBe(true);
    expect(orderShowsLineDiscounts([{ kind: "buy_x_get_y", amount: 500 }, { kind: "shipping", amount: 0 }])).toBe(true);
    expect(orderShowsLineDiscounts([])).toBe(true);
    expect(orderShowsLineDiscounts(undefined)).toBe(true);
    expect(presentedLineTotalMinor({ grossSubtotalMinor: 100_000, discountMinor: 20_000, taxMinor: 4_000 }, true, false)).toBe(84_000);
    expect(presentedLineTotalMinor({ grossSubtotalMinor: 100_000, discountMinor: 20_000, taxMinor: 4_000 }, true, true)).toBe(80_000);
  });
});

describe("placed order delivery row", () => {
  it("reads a free pickup as Pickup and its location, never Free or Shipping", () => {
    expect(orderDeliveryRow({ mode: "pickup", methodName: "STAB Pickup Gulshan", fee: 0, charged: 0, codes: "" }, en, money))
      .toEqual({ label: "Pickup", value: "STAB Pickup Gulshan", struck: null, codes: "" });
    expect(orderDeliveryRow({ mode: "pickup", methodName: null, fee: 0, charged: 0, codes: "" }, bn, money).label)
      .toBe(bn.orderPickupHeadingText);
  });

  it("keeps a pickup's fee when there is one", () => {
    expect(orderDeliveryRow({ mode: "pickup", methodName: "Gulshan", fee: 50, charged: 50, codes: "" }, en, money))
      .toEqual({ label: "Pickup · Gulshan", value: "৳50", struck: null, codes: "" });
  });

  it("shows a delivery discount with the fee struck through", () => {
    expect(orderDeliveryRow({ mode: "ship", methodName: "Inside Dhaka", fee: 80, charged: 0, codes: "FREESHIP" }, en, money))
      .toEqual({ label: "Delivery · Inside Dhaka", value: "Free", struck: "৳80", codes: "FREESHIP" });
  });
});

describe("placed order payment method", () => {
  it("names cash for where it is paid", () => {
    expect(formatOrderSuccessPaymentMethod("cod", en, { shippingMethodKind: "pickup", requiresShipping: false })).toBe("Pay at pickup");
    expect(formatOrderSuccessPaymentMethod("cod", en, { shippingMethodKind: null, requiresShipping: false })).toBe("Pay on service");
    expect(formatOrderSuccessPaymentMethod("cod", en, { shippingMethodKind: "delivery", requiresShipping: true })).toBe(en.cashOnDeliveryText);
    expect(formatOrderSuccessPaymentMethod("cod", en)).toBe(en.cashOnDeliveryText);
    expect(formatOrderSuccessPaymentMethod("cod", bn, { shippingMethodKind: "pickup" })).toBe(bn.orderReceiptPaymentMethodPayAtPickupText);
  });

  it("never renames an online payment", () => {
    expect(formatOrderSuccessPaymentMethod("stripe", en, { requiresShipping: false })).toBe(en.orderReceiptPaymentMethodCardText);
  });
});
