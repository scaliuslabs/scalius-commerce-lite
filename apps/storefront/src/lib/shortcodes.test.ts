import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductPageData } from "./api/products";

const mocks = vi.hoisted(() => ({
  getProductBySlug: vi.fn(),
  getWidgetById: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getProductBySlug: mocks.getProductBySlug,
  getWidgetById: mocks.getWidgetById,
}));

import { processShortcodes } from "./shortcodes";

function productFixture(slug: string): ProductPageData {
  return {
    product: {
      id: `product_${slug}`,
      name: `Product ${slug}`,
      slug,
      description: null,
      price: 100,
      discountType: null,
      discountPercentage: null,
      discountAmount: null,
      discountedPrice: 100,
      freeDelivery: false,
      isActive: true,
      metaTitle: null,
      metaDescription: null,
      categoryId: "category_1",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
      deletedAt: null,
      imageUrl: null,
      imageAlt: null,
      hasVariants: false,
    },
    category: undefined,
    images: [],
    variants: [],
    relatedProducts: [],
  };
}

describe("processShortcodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProductBySlug.mockImplementation(async (slug: string) =>
      productFixture(slug),
    );
  });

  it("dedupes repeated product shortcodes while preserving every placeholder", async () => {
    const content = [
      '<p>[product slug="fish"]</p>',
      '<p>[product slug="fish"]</p>',
      '<p>[product slug="rice"]</p>',
    ].join("");

    const html = await processShortcodes(content);

    expect(mocks.getProductBySlug).toHaveBeenCalledTimes(2);
    expect(mocks.getProductBySlug.mock.calls.map(([slug]) => slug)).toEqual([
      "fish",
      "rice",
    ]);
    expect(html.match(/product-shortcode-container/g)).toHaveLength(3);
    expect(html).not.toContain("[product");
  });

  it("parses sanitized CMS quote entities in shortcode attributes", async () => {
    const content = [
      "<p>[product slug=&quot;monster-energy-drink&quot;]</p>",
      "<p>[product slug=&#34;monster-energy-drink&#34;]</p>",
      "<p>[product slug=&apos;rice&apos;]</p>",
    ].join("");

    const html = await processShortcodes(content);

    expect(mocks.getProductBySlug).toHaveBeenCalledTimes(2);
    expect(mocks.getProductBySlug.mock.calls.map(([slug]) => slug)).toEqual([
      "monster-energy-drink",
      "rice",
    ]);
    expect(html.match(/product-shortcode-container/g)).toHaveLength(3);
    expect(html).not.toContain("[product");
  });
});
