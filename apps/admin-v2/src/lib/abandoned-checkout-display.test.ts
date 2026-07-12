import { describe, expect, it } from "vitest";
import { parseAbandonedCheckoutDisplay } from "./abandoned-checkout-display";

describe("abandoned checkout display parsing", () => {
  it("keeps active cart-shaped checkout rows as cart sessions", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_1",
      checkoutId: "chk_1",
      customerPhone: "+8801712345678",
      checkoutData: JSON.stringify({
        customerName: "Buyer",
        shippingAddress: "Dhaka",
        cart: {
          totalAmount: 1200,
          items: [
            {
              id: "item_1",
              name: "Shoe",
              quantity: 2,
              price: 600,
              options: [{ name: "Color", value: "Sand" }],
            },
          ],
        },
      }),
    });

    expect(display).toMatchObject({
      kind: "cart",
      stage: "Info Captured",
      total: 1200,
      customerInfo: {
        name: "Buyer",
        phone: "+8801712345678",
        address: "Dhaka",
      },
    });
    expect(display.items).toHaveLength(1);
    expect(display.items[0]?.options).toEqual([{ name: "Color", value: "Sand" }]);
  });

  it("drops malformed or non-finite cart rows from the recovery snapshot", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_bad_rows",
      checkoutId: "chk_1",
      customerPhone: null,
      checkoutData: JSON.stringify({
        cart: {
          totalAmount: 500,
          items: [
            { id: "valid", name: "Valid", quantity: 1, price: 500 },
            { id: "negative", name: "Negative", quantity: 1, price: -1 },
            { id: "zero", name: "Zero quantity", quantity: 0, price: 20 },
          ],
        },
      }),
    });

    expect(display.items.map((item) => item.id)).toEqual(["valid"]);
  });

  it("normalizes stale hosted-payment order snapshots instead of rendering an empty cart", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_ch_sys_order_1",
      checkoutId: "order_1",
      customerPhone: "+8801712345678",
      checkoutData: JSON.stringify({
        id: "order_1",
        status: "incomplete",
        paymentMethod: "sslcommerz",
        paymentStatus: "failed",
        totalAmount: 3499,
        paidAmount: 0,
        balanceDue: 3499,
        customerName: "Hosted Buyer",
        customerPhone: "+8801712345678",
        shippingAddress: "Chattogram",
      }),
    });

    expect(display).toMatchObject({
      kind: "stale_hosted_payment_order",
      stage: "Archived hosted payment",
      orderId: "order_1",
      paymentMethod: "sslcommerz",
      paymentStatus: "failed",
      total: 3499,
      paidAmount: 0,
      balanceDue: 3499,
      customerInfo: {
        name: "Hosted Buyer",
        phone: "+8801712345678",
        address: "Chattogram",
      },
    });
    expect(display.items).toEqual([]);
  });

  it("fails closed for malformed checkout data", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_bad",
      checkoutId: null,
      customerPhone: "+8801711111111",
      checkoutData: "{not-json",
    });

    expect(display).toMatchObject({
      kind: "unknown",
      stage: "Unreadable",
      total: 0,
      customerInfo: {
        phone: "+8801711111111",
      },
    });
  });
});
