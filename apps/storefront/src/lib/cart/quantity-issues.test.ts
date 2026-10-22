import { describe, expect, it } from "vitest";
import { isFollowedQuantityIssue, quantitiesByVariant } from "./quantity-issues";

// Buyer QA m2: 12 asked for, 3 left, the line capped to 3; the drawer and the
// cart page still said "Only 3 left, update quantity to 3" and held checkout.
const onlyThree = { code: "quantity_unavailable", action: "reduce_quantity", availableQuantity: 3, variantId: "sku_ocean" } as const;

describe("an 'only N left' the cart already follows", () => {
  it("is followed once the variant's lines ask for no more than is left", () => {
    expect(isFollowedQuantityIssue(onlyThree, 12)).toBe(false);
    expect(isFollowedQuantityIssue(onlyThree, 3)).toBe(true);
    expect(isFollowedQuantityIssue(onlyThree, 2)).toBe(true);
  });

  it("counts every line of the variant, and never hides a sold-out or other issue", () => {
    const items = { a: { variantId: "sku_ocean", quantity: 2 }, b: { variantId: "sku_ocean", quantity: 2 } };
    expect(isFollowedQuantityIssue(onlyThree, 2, quantitiesByVariant(items).get("sku_ocean"))).toBe(false);
    expect(isFollowedQuantityIssue({ ...onlyThree, action: "remove", availableQuantity: 0 }, 1)).toBe(false);
    expect(isFollowedQuantityIssue({ ...onlyThree, code: "price_changed", action: "refresh_item" } as never, 1)).toBe(false);
  });
});
