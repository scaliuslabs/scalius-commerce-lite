import { describe, expect, it } from "vitest";
import { STOREFRONT_BLOCK_REGISTRY, STOREFRONT_MARKETPLACE_BUY_BOX_LOOK } from "@scalius/shared/storefront-theme";
import type { Product } from "@/lib/api";
import {
  buyBoxFeatures,
  compareSimilarProducts,
  descriptionInInfoColumn,
  featuresPlacement,
  groupSpecificationRows,
  productPageModules,
  publicSpecificationRows,
} from "./product-page-modules";

// A classic buy box with these settings (the one box; its arrangement is all that differs).
const classic = (settings: Record<string, unknown> = {}) =>
  STOREFRONT_BLOCK_REGISTRY.buyBox.classic.renders({ ...STOREFRONT_BLOCK_REGISTRY.buyBox.classic.defaults, ...settings } as never).look;

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

const card = (id: string, categoryId: string | null = "cat-phones") => ({ id, slug: id, name: id, categoryId } as Product);

describe("modules from data the page already has", () => {
  it("compares with recommended products of the same category, three at most", () => {
    const list = { reason: "similar" as const, products: [card("p1"), card("a"), card("x", "cat-cases"), card("b"), card("c"), card("d")] };
    expect(compareSimilarProducts({ id: "p1", categoryId: "cat-phones" }, list).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(compareSimilarProducts({ id: "p1", categoryId: null }, list)).toEqual([]);
  });

  it("renders each new module only with its data; recently viewed always (the browser fills it)", () => {
    const below = ["compare-similar", "policies", "recently-viewed"] as const;
    expect(productPageModules(below, product(), { look: classic(), hasRelated: false })).toEqual(["recently-viewed"]);
    expect(productPageModules(below, product(), { look: classic(), hasRelated: false, similar: 2, policies: 3 }))
      .toEqual(["compare-similar", "policies", "recently-viewed"]);
  });
});

describe("product page modules", () => {
  it("keeps classic's order and leaves the description in the buy box", () => {
    const modules = productPageModules(["description", "reviews", "related"], product({ reviews: {} as Product["reviews"] }), {
      look: classic(),
      hasRelated: true,
    });
    expect(modules).toEqual(["reviews", "related"]);
    expect(descriptionInInfoColumn(classic())).toBe(true);
  });

  it("keeps the description beside the gallery without a duplicate below", () => {
    const look = classic({ cta: "stack" });
    expect(descriptionInInfoColumn(look)).toBe(true);
    expect(productPageModules(["description", "related"], product(), { look, hasRelated: true })).toEqual(["related"]);
  });

  it("follows the template list and drops modules this product has no data for", () => {
    const below = ["about-bullets", "key-attributes", "spec-table", "description", "warranty", "reviews", "related"] as const;
    const look = STOREFRONT_MARKETPLACE_BUY_BOX_LOOK;
    // The facts column already lists the key specs: highlights would repeat them.
    expect(productPageModules(below, product(), { look, hasRelated: false })).toEqual([
      "about-bullets", "spec-table", "description",
    ]);
    // Highlights show above a longer table in a box that does not list them.
    const longer = product({ attributes: [spec("Weight", "Body", true), spec("Colour", "Body")] });
    expect(productPageModules(below, longer, { look: classic(), hasRelated: false })).toEqual([
      "about-bullets", "key-attributes", "spec-table",
    ]);
    expect(productPageModules(below, product(), { look: classic(), hasRelated: false })).not.toContain("key-attributes");
    const withWarranty = product({ warranty: { name: "1 year", provider: "brand", duration: { value: 1, unit: "years" }, replacementDays: null, terms: null } });
    expect(productPageModules(below, withWarranty, { look, hasRelated: true })).toContain("warranty");
    expect(featuresPlacement(["about-bullets"], look)).toBe("about");
  });

  it("shows key features once: in a buy box that lists them, never again below", () => {
    const look = classic({ cta: "stack", features: true, details: "below" });
    const modules = productPageModules(["about-bullets", "description"], product(), { look, hasRelated: false });
    expect(modules).toEqual(["description"]);
    expect(featuresPlacement(modules, look)).toBe("buy-box");
    expect(featuresPlacement(["description"], classic())).toBe("description");
  });

  it("puts department-mall's saved highlights in the buy box", () => {
    const look = classic({ features: true, details: "below" });
    expect(look.features).toBe("list");
    const modules = productPageModules(["description", "reviews", "related"], product(), { look, hasRelated: false });
    expect(featuresPlacement(modules, look)).toBe("buy-box");
    expect(buyBoxFeatures(product())).toEqual(["Soft"]);
    expect(buyBoxFeatures(product({ features: [] }), true)).toEqual([]);
  });

  it("groups specification rows in the order they arrive", () => {
    expect(groupSpecificationRows([spec("A", "Body"), spec("B", "Body"), spec("C", null), spec("D", "Body")]).map((group) => [group.group, group.rows.length]))
      .toEqual([["Body", 2], [null, 1], ["Body", 1]]);
  });

  it("keeps legacy Brand and blank rows out of technical specification sections", () => {
    const rows = [
      { ...spec("Brand", null, true), value: "Old brand" },
      { ...spec("Model", "Details", true), value: " " },
      { ...spec("Memory", "Details", true), value: "16 GB" },
    ];
    expect(publicSpecificationRows(rows).map((row) => row.name)).toEqual(["Memory"]);
    expect(productPageModules(["key-attributes", "spec-table"], product({ attributes: rows.slice(0, 2) }), {
      look: classic({ features: true, details: "below" }),
      hasRelated: false,
    })).toEqual([]);
  });

  it("uses saved highlights, then truthful key specs when highlights are empty", () => {
    expect(buyBoxFeatures(product())).toEqual(["Soft"]);
    expect(buyBoxFeatures(product({
      features: [],
      attributes: [spec("Brand", null, true), { ...spec("Weight", "Body", true), value: "2", unit: "kg" }, spec("Colour", null)],
    }))).toEqual(["Weight: 2 kg"]);
  });
});
