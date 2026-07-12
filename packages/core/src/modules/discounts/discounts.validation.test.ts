import { describe, expect, it } from "vitest";

import { DiscountType, DiscountValueType } from "@scalius/database/schema";
import { createDiscountSchema } from "./discounts.validation";

describe("discount validation", () => {
  it("creates discounts as inactive drafts by default", () => {
    const parsed = createDiscountSchema.parse({
      code: "WELCOME10",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 10,
      startDate: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.isActive).toBe(false);
  });
});
