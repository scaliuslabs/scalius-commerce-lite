import { describe, expect, it } from "vitest";
import {
  buildAbandonedCheckoutListPresentation,
  formatAbandonedCheckoutId,
  formatAbandonedCheckoutItemCount,
  formatAbandonedCheckoutRecordCount,
  parseAbandonedCheckoutDisplay,
} from "./abandoned-checkout-display";

describe("abandoned checkout identifiers", () => {
  it("keeps short identifiers and makes long checkout sessions distinguishable", () => {
    expect(formatAbandonedCheckoutId("chk_1234")).toBe("chk_1234");
    expect(formatAbandonedCheckoutId("chk_session_S5I82lT0gFft-9f0IUpbW")).toBe("S5I82lT…IUpbW");
    expect(formatAbandonedCheckoutId("chk_session_S5I82lT0gFft-9f0IUpcX")).toBe("S5I82lT…IUpcX");
    expect(formatAbandonedCheckoutId("  ")).toBe("Unknown");
  });
});

describe("abandoned checkout count copy", () => {
  it("uses natural singular and plural labels", () => {
    expect(formatAbandonedCheckoutItemCount(0)).toBe("0 items");
    expect(formatAbandonedCheckoutItemCount(1)).toBe("1 item");
    expect(formatAbandonedCheckoutItemCount(4)).toBe("4 items");
    expect(formatAbandonedCheckoutRecordCount(1)).toBe("1 checkout record");
    expect(formatAbandonedCheckoutRecordCount(2)).toBe("2 checkout records");
  });
});

describe("abandoned checkout display parsing", () => {
  it("keeps active cart-shaped checkout rows as cart sessions", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_1",
      checkoutId: "chk_1",
      customerPhone: "+8801712345678",
      checkoutData: JSON.stringify({
        customerName: "Buyer",
        shippingAddress: "Dhaka",
        cityName: "Dhaka",
        zoneName: "Banani",
        areaName: "Road 11",
        cart: {
          totalAmount: 1200,
          items: [
            {
              id: "item_1",
              variantId: "variant_sand",
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
        location: "Road 11, Banani, Dhaka",
      },
    });
    expect(display.items).toHaveLength(1);
    expect(display.items[0]?.variantId).toBe("variant_sand");
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

  it("treats partial and invalid legacy phones as unavailable", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_invalid_phone",
      checkoutId: "chk_1",
      customerPhone: "+880",
      checkoutData: JSON.stringify({
        customerPhone: "01700",
        cart: {
          totalAmount: 500,
          items: [{ id: "item_1", name: "Shoe", quantity: 1, price: 500 }],
        },
      }),
    });

    expect(display.customerInfo.phone).toBeNull();
    expect(display.stage).toBe("Cart Started");
    expect(display.paymentMethod).toBeNull();
    expect(display.paymentStatus).toBeNull();
  });

  it("canonicalizes valid legacy phone formatting for display", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_valid_phone",
      checkoutId: "chk_1",
      customerPhone: "+880 1712-345678",
      checkoutData: JSON.stringify({ cart: { items: [] } }),
    });

    expect(display.customerInfo.phone).toBe("+8801712345678");
    expect(display.stage).toBe("Info Captured");
  });

  it("labels cart values and hosted-payment order totals without conflating them", () => {
    const cartPresentation = buildAbandonedCheckoutListPresentation({
      kind: "cart",
      stage: "Cart Started",
      variant: "secondary",
      items: [{ id: "item_1", name: "Shoe", quantity: 1, price: 500 }],
      customerInfo: {},
      total: 500,
      orderId: null,
      paymentMethod: null,
      paymentStatus: null,
      paidAmount: null,
      balanceDue: null,
    });
    const hostedPresentation = buildAbandonedCheckoutListPresentation({
      kind: "stale_hosted_payment_order",
      stage: "Archived hosted payment",
      variant: "outline",
      items: [],
      customerInfo: {},
      total: 3499,
      orderId: "order_1",
      paymentMethod: "sslcommerz",
      paymentStatus: "failed",
      paidAmount: 0,
      balanceDue: 3499,
    });

    expect(cartPresentation).toEqual({
      checkoutType: "Cart session",
      cartContents: "1 item",
      amountLabel: "Cart value",
      amount: 500,
      paymentProvider: null,
      paymentStatus: null,
    });
    expect(hostedPresentation).toEqual({
      checkoutType: "Hosted payment recovery",
      cartContents: "Not retained",
      amountLabel: "Order total",
      amount: 3499,
      paymentProvider: "SSLCOMMERZ",
      paymentStatus: "Failed",
    });
  });

  it("does not expose an invalid stored phone when checkout data is unreadable", () => {
    const display = parseAbandonedCheckoutDisplay({
      id: "ab_bad_phone",
      checkoutId: "chk_1",
      customerPhone: "+880",
      checkoutData: "{not-json",
    });

    expect(display.kind).toBe("unknown");
    expect(display.customerInfo.phone).toBeNull();
  });
});
