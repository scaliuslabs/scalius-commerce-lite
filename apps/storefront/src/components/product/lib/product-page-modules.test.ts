import { describe, expect, it } from "vitest";
import { STOREFRONT_BUY_BOX_LOOKS } from "@scalius/shared/storefront-theme";
import type { Product } from "@/lib/api";
import {
  descriptionInInfoColumn,
  featuresPlacement,
  groupSpecificationRows,
  productPageModules,
} from "./product-page-modules";

const spec = (name: string, group: string | null, keySpec = false) => ({
  name, slug: name.toLowerCase(), value: "1", group, unit: null, keySpec,
});

function product(overrides: Partial<Product> = {}): Product {
  return {
    description: "<p>Soft cotton.</p>",
    features: ["Soft"],
    attributes: [spec("Weight", "Body", true)],
    reviews: null,
    warranty: null,
    contentBlocks: [],
    ...overrides,
  } as Product;
}

describe("product page modules", () => {
  it("keeps classic's order and leaves the description in the buy box", () => {
    const modules = productPageModules(["description", "reviews", "related"], product({ reviews: {} as Product["reviews"] }), {
      look: null,
      hasRelated: true,
    });
    expect(modules).toEqual(["reviews", "related"]);
    expect(descriptionInInfoColumn(null)).toBe(true);
  });

  it("follows the template list and drops modules this product has no data for", () => {
    const below = ["about-bullets", "key-attributes", "spec-table", "description", "warranty", "reviews", "questions", "related"] as const;
    const look = STOREFRONT_BUY_BOX_LOOKS["marketplace-3col"];
    expect(productPageModules(below, product(), { look, hasRelated: false })).toEqual([
      "about-bullets", "key-attributes", "spec-table", "description",
    ]);
    const withWarranty = product({ warranty: { name: "1 year", provider: "brand", duration: { value: 1, unit: "years" }, replacementDays: null, terms: null } });
    expect(productPageModules(below, withWarranty, { look, hasRelated: true })).toContain("warranty");
    expect(featuresPlacement(["about-bullets"], look)).toBe("about");
  });

  it("shows key features once: in a buy box that lists them, never again below", () => {
    const look = STOREFRONT_BUY_BOX_LOOKS.retail;
    const modules = productPageModules(["about-bullets", "description"], product(), { look, hasRelated: false });
    expect(modules).toEqual(["description"]);
    expect(featuresPlacement(modules, look)).toBe("buy-box");
    expect(featuresPlacement(["description"], null)).toBe("description");
  });

  it("groups specification rows in the order they arrive", () => {
    expect(groupSpecificationRows([spec("A", "Body"), spec("B", "Body"), spec("C", null), spec("D", "Body")]).map((group) => [group.group, group.rows.length]))
      .toEqual([["Body", 2], [null, 1], ["Body", 1]]);
  });
});
