// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { ORDER_PREFILL_STORAGE_KEY, takeOrderPrefill } from "./order-prefill";

afterEach(() => window.sessionStorage.clear());

describe("create order prefill from an abandoned checkout", () => {
  it("reads the details once and removes them", () => {
    window.sessionStorage.setItem(ORDER_PREFILL_STORAGE_KEY, JSON.stringify({
      customerName: "Karim",
      customerPhone: "01712345678",
      customerEmail: "",
      shippingAddress: "Road 2, Mirpur 10",
      city: "city_1",
      zone: "zone_1",
      area: "",
      items: [
        { productId: "prod_1", variantId: "sku_1", quantity: 2, productName: "Panjabi", variantLabel: "Size: L" },
        { productId: "prod_2", variantId: null, quantity: 1 },
        { productId: "prod_3", variantId: "sku_3", quantity: 0 },
      ],
    }));

    expect(takeOrderPrefill()).toEqual({
      customerName: "Karim",
      customerPhone: "01712345678",
      customerEmail: null,
      shippingAddress: "Road 2, Mirpur 10",
      city: "city_1",
      zone: "zone_1",
      area: null,
      items: [{
        productId: "prod_1",
        variantId: "sku_1",
        quantity: 2,
        price: 0,
        name: "Panjabi",
        variantLabel: "Size: L",
      }],
    });
    expect(window.sessionStorage.getItem(ORDER_PREFILL_STORAGE_KEY)).toBeNull();
    expect(takeOrderPrefill()).toBeNull();
  });

  it("drops unreadable data without prefilling anything", () => {
    window.sessionStorage.setItem(ORDER_PREFILL_STORAGE_KEY, "{not json");
    expect(takeOrderPrefill()).toBeNull();
    expect(window.sessionStorage.getItem(ORDER_PREFILL_STORAGE_KEY)).toBeNull();
  });
});
