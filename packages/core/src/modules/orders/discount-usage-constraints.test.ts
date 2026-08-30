import { describe, expect, it } from "vitest";

import { getDiscountUsageConstraintError } from "./discount-usage-constraints";

describe("discount usage constraint errors", () => {
  it("maps a concurrent redemption-key collision to the one-use message", () => {
    const mapped = getDiscountUsageConstraintError(new Error(
      "UNIQUE constraint failed: discount_customer_redemptions.discount_id, "
      + "discount_customer_redemptions.customer_key",
    ));

    expect(mapped).toMatchObject({
      message: "Discount already used by this customer",
    });
  });
});
