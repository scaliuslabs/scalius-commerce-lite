import { describe, expect, it } from "vitest";
import {
  withOptimizedCollectionProductImages,
  withOptimizedSocialIcons,
} from "../../../apps/storefront/src/lib/serialized-media";
import type {
  CollectionWithProducts,
  Product,
} from "../../../apps/storefront/src/lib/api";

const rawImage = "https://cloud.scalius.com/products/fish.webp";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod_1",
    name: "Fish",
    slug: "fish",
    description: null,
    price: 720,
    discountType: "percentage",
    discountPercentage: 5,
    discountAmount: null,
    discountedPrice: 684,
    freeDelivery: false,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    categoryId: "cat_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    imageUrl: rawImage,
    imageAlt: "Fish",
    hasVariants: false,
    ...overrides,
  };
}

describe("serialized storefront media", () => {
  it("rewrites product image URLs before collection data is serialized into React island props", () => {
    const collection: CollectionWithProducts = {
      id: "col_1",
      name: "Featured",
      type: "dynamic",
      config: {},
      sortOrder: 0,
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      products: [product()],
      categories: [],
      featuredProduct: product({ id: "prod_2" }),
    };

    const optimized = withOptimizedCollectionProductImages(collection);

    expect(optimized.products?.[0]?.imageUrl).toContain(
      "https://cloud.scalius.com/cdn-cgi/image/",
    );
    expect(optimized.featuredProduct?.imageUrl).toContain(
      "https://cloud.scalius.com/cdn-cgi/image/",
    );
    expect(optimized.products?.[0]?.imageUrl).not.toBe(rawImage);
  });

  it("stores optimized social icon URLs without preserving duplicate raw raster URLs", () => {
    const [social] = withOptimizedSocialIcons([
      {
        id: "social_1",
        label: "Profile",
        url: "https://example.com",
        iconUrl: "https://cloud.scalius.com/icons/profile.png",
      },
    ]);

    expect(social?.iconUrl).toBe(social?.optimizedIconUrl);
    expect(social?.iconUrl).toContain(
      "https://cloud.scalius.com/cdn-cgi/image/",
    );
  });
});
