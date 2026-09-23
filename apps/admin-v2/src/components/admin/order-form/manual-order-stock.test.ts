import { describe, expect, it } from "vitest";

import type { OrderItem, Product } from "./types";
import { orderFormMessages } from "~/i18n/order-form";
import {
  exceededStockMessage,
  remainingStockForNewOrderLine,
  remainingStockMessage,
  stagedVariantQuantity,
  trackedAvailableStock,
} from "./manual-order-stock";

type ProductVariant = Product["variants"][number];

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: "variant_1",
    optionCombinationKey: null,
    selectedOptions: [],
    weight: null,
    sku: "SKU-1",
    price: 100,
    stock: 30,
    reservedStock: 5,
    trackInventory: true,
    ...overrides,
  };
}

const items: OrderItem[] = [
  { productId: "product_1", variantId: "variant_1", quantity: 12, price: 100 },
  { productId: "product_1", variantId: "variant_1", quantity: 3, price: 100 },
  { productId: "product_2", variantId: "variant_2", quantity: 9, price: 50 },
];

describe("manual-order stock guidance", () => {
  it("uses stock minus reservations as the tracked availability snapshot", () => {
    expect(trackedAvailableStock(variant())).toBe(25);
    expect(trackedAvailableStock(variant({ stock: 2, reservedStock: 8 }))).toBe(0);
    expect(trackedAvailableStock(variant({ trackInventory: false }))).toBeNull();
  });

  it("accounts for every other staged line of the same SKU", () => {
    expect(stagedVariantQuantity(items, "variant_1")).toBe(15);
    expect(remainingStockForNewOrderLine(variant(), items)).toBe(10);
    expect(remainingStockForNewOrderLine(variant(), items, 0)).toBe(22);
    expect(remainingStockForNewOrderLine(
      variant({ trackInventory: false }),
      items,
    )).toBeNull();
  });

  it("picks the matching guidance without changing the requested quantity", () => {
    const en = orderFormMessages.en;
    expect(remainingStockMessage(30)).toBe(en.available.replace("{count}", "30"));
    expect(remainingStockMessage(18, 12)).toBe(
      en.availableMore.replace("{count}", "18").replace("{staged}", "12"),
    );
    expect(remainingStockMessage(0)).toBe(en.outOfStock);
    expect(exceededStockMessage(0)).toBe(en.outOfStock);
    expect(exceededStockMessage(1)).toBe(en.onlyAvailable.replace("{count}", "1"));
  });
});
