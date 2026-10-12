import { describe, expect, it } from "vitest";
import { readQuickCheckoutForm, withLineQuantity } from "./quick-checkout";

const line = JSON.stringify({ "p:v:none": { id: "p", variantId: "v", name: "Kurta", price: 1490, quantity: 1 } });

describe("an order form's quantity", () => {
  it("applies to its one line, within bounds", () => {
    expect(JSON.parse(withLineQuantity(line, "3"))["p:v:none"].quantity).toBe(3);
    expect(withLineQuantity(line, "0")).toBe(line);
    expect(withLineQuantity(line, "11")).toBe(line);
    expect(withLineQuantity(line, "2.5")).toBe(line);
    expect(withLineQuantity(line, null)).toBe(line);
  });

  it("never changes a cart of several lines", () => {
    const two = JSON.stringify({ a: { quantity: 1 }, b: { quantity: 1 } });
    expect(withLineQuantity(two, "4")).toBe(two);
  });

  it("is read with the rest of the quick checkout form", () => {
    const form = new FormData();
    form.set("cartItems", line);
    form.set("lineQuantity", "2");
    expect(JSON.parse(readQuickCheckoutForm(form).cartItems)["p:v:none"].quantity).toBe(2);
  });
});
