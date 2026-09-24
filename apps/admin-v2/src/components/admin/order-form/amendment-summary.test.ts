import { describe, expect, it } from "vitest";
import { describeAmendment } from "./amendment-summary";
import { orderFormSchema } from "./types";
import { orderFormMessages } from "~/i18n/order-form";

const money = (amount: number) => `৳${amount.toLocaleString("en-IN")}`;
const line = (variantId: string, quantity: number, name: string) =>
  ({ productId: `p_${variantId}`, variantId, quantity, price: 100, name });
const before = {
  customerName: "Karim",
  customerPhone: "+8801712345678",
  customerEmail: null,
  shippingAddress: "Road 2, Mirpur 10",
  city: "c1",
  zone: "z1",
  area: null,
  notes: null,
  discountAmount: null,
  shippingCharge: 60,
  items: [line("v1", 2, "Panjabi"), line("v2", 1, "Attar")],
};

describe("amendment review", () => {
  it("lists what changes in short plain words", () => {
    const changes = describeAmendment(before, {
      ...before,
      shippingAddress: "Road 3, Mirpur 11",
      shippingCharge: 120,
      items: [line("v1", 3, "Panjabi"), line("v3", 1, "Cap")],
    }, (item) => item.name ?? "", money);
    expect(changes).toEqual([
      "Added 1 × Panjabi",
      "Removed 1 × Attar",
      "Added 1 × Cap",
      "Delivery charge ৳60 → ৳120",
      "Delivery address updated",
    ]);
  });

  it("reports no change when a note is only cleared from empty", () => {
    expect(describeAmendment(before, { ...before, notes: "" }, () => "", money)).toEqual([]);
  });
});

describe("order form validation", () => {
  const valid = { ...before, customerPhone: "01712-345678", items: [line("v1", 1, "Panjabi")] };

  it("saves a typed Bangladesh mobile as +880", async () => {
    const result = await orderFormSchema.safeParseAsync(valid);
    expect(result.success && result.data.customerPhone).toBe("+8801712345678");
  });

  it("explains a missing phone, a negative delivery charge and an empty order", async () => {
    const result = await orderFormSchema.safeParseAsync({
      ...valid,
      customerPhone: "",
      shippingCharge: -20,
      items: [],
    });
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      orderFormMessages.en.phoneRequired,
      orderFormMessages.en.deliveryChargeNegative,
      orderFormMessages.en.itemsRequired,
    ]));
  });
});
