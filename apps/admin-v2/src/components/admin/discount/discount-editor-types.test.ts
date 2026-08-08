import { describe, expect, it } from "vitest";

import {
  discountEditorTypes,
  type DiscountEditorType,
} from "./discount-editor-types";
import {
  discountEditorTypes as legacyDiscountEditorTypes,
  type DiscountEditorType as LegacyDiscountEditorType,
} from "./discount-editor-model";
import { validateDiscountCreateSearch } from "../../../routes/admin/discounts/new";

describe("discount editor type discriminator", () => {
  it("preserves the three validated route values and the model export", () => {
    const routeValues: DiscountEditorType[] = [...discountEditorTypes];
    const legacyRouteValues: LegacyDiscountEditorType[] = routeValues;

    expect(routeValues).toEqual([
      "amount_off_products",
      "amount_off_order",
      "free_shipping",
    ]);
    expect(legacyRouteValues).toEqual(routeValues);
    expect(legacyDiscountEditorTypes).toBe(discountEditorTypes);
  });

  it("keeps valid route values and rejects every other search value", () => {
    const validateType = (type: unknown) =>
      validateDiscountCreateSearch({ type } as never);

    expect(validateType("amount_off_order")).toEqual({
      type: "amount_off_order",
    });
    expect(validateType("free_shipping")).toEqual({
      type: "free_shipping",
    });
    expect(validateType("unknown")).toEqual({
      type: undefined,
    });
    expect(validateType(["amount_off_order"])).toEqual({ type: undefined });
  });
});
