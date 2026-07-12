import { describe, expect, it } from "vitest";

import { generateSku, getSkuExample, validateSkuTemplate } from "./skuGenerator";

describe("SKU generator option tokens", () => {
  it("uses Option 1 and Option 2 tokens for new templates", () => {
    expect(
      generateSku("{SLUG}-{OPTION1}-{OPTION2}-{INDEX}", {
        slug: "premium-rice",
        size: "2kg",
        color: "gift box",
        index: 7,
      }),
    ).toBe("PREMIUM-RICE-2KG-GIFT-BOX-007");
  });

  it("rejects retired size and color aliases instead of preserving ambiguous templates", () => {
    expect(validateSkuTemplate("{SLUG}-{SIZE}-{COLOR}")).toEqual({
      valid: false,
      error: "Unknown SKU variable: SIZE",
    });
  });

  it("previews the new option token vocabulary", () => {
    expect(getSkuExample("{SLUG}-{OPTION1}-{OPTION2}", "demo")).toBe("DEMO-XL-RED");
  });

  it("rejects unknown template variables instead of emitting unresolved braces", () => {
    expect(validateSkuTemplate("{SLUG}-{OPTION3}")).toEqual({
      valid: false,
      error: "Unknown SKU variable: OPTION3",
    });
  });
});
