import { describe, expect, it } from "vitest";
import { parseAbandonedCheckoutDisplay } from "~/lib/abandoned-checkout-display";
import { buildOrderPrefill, checkoutReference } from "./abandoned-checkout-prefill";

const checkoutData = JSON.stringify({
  customerName: "Rahima Akter",
  customerPhone: "+8801712345601",
  customerEmail: "rahima@example.com",
  shippingAddress: "House 12, Road 5",
  city: "city_dhaka",
  zone: "zone_mirpur",
  area: "",
  cityName: "Dhaka",
  zoneName: "Mirpur",
  shipping: { id: "rate_dhaka_standard", fee: 80, freeOver: null, name: "Standard delivery", kind: "delivery" },
  cart: {
    items: [
      { id: "prod_1", variantId: "var_1", name: "Cotton kurta", quantity: 2, price: 800, options: [{ name: "Size", value: "L" }, { name: "Color", value: "Black" }] },
      { id: "prod_2", name: "Attar", quantity: 1, price: 300 },
    ],
    totalAmount: 1900,
  },
});

describe("create order from an abandoned checkout", () => {
  it("carries the customer, the delivery area ids, the delivery method and charge, and every cart line", () => {
    const display = parseAbandonedCheckoutDisplay({ id: "1", checkoutId: "chk_session_abcdef123456", customerPhone: null, checkoutData });
    const prefill = buildOrderPrefill(checkoutData, display);
    expect(prefill).toMatchObject({
      customerName: "Rahima Akter",
      customerEmail: "rahima@example.com",
      shippingAddress: "House 12, Road 5",
      city: "city_dhaka",
      zone: "zone_mirpur",
      area: null,
      shippingMethodId: "rate_dhaka_standard",
      shippingCharge: 80,
    });
    expect(prefill.customerPhone).toBe("+8801712345601");
    expect(prefill.items).toEqual([
      { productId: "prod_1", variantId: "var_1", quantity: 2, productName: "Cotton kurta", variantLabel: "Size: L, Color: Black" },
      { productId: "prod_2", variantId: null, quantity: 1, productName: "Attar", variantLabel: null },
    ]);
  });

  it("falls back to empty fields when the checkout can't be read", () => {
    const display = parseAbandonedCheckoutDisplay({ id: "1", checkoutId: null, customerPhone: null, checkoutData: "{" });
    expect(buildOrderPrefill("{", display)).toEqual({
      customerName: "",
      customerPhone: "",
      customerEmail: null,
      shippingAddress: "",
      city: "",
      zone: "",
      area: null,
      shippingMethodId: null,
      shippingCharge: null,
      items: [],
    });
  });

  it("shows a short reference instead of the long checkout token", () => {
    expect(checkoutReference("chk_session_MjR6ZxQnNDBs")).toBe("QnNDBs");
    expect(checkoutReference(null)).toBe("—");
  });
});
