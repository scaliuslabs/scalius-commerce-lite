import { describe, expect, it } from "vitest";
import {
  withOptimizedCollectionProductImages,
  withOptimizedProductPageImages,
  withOptimizedSocialIcons,
} from "../../../apps/storefront/src/lib/serialized-media";
import type {
  CollectionWithProducts,
  Product,
  ProductPageData,
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

  it("normalizes stale pre-optimized product page image URLs per surface", () => {
    const staleOptimizedImage =
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=1200,height=1200,quality=85,format=auto,fit=contain,sharpen=1/products/fish.webp";
    const productData: ProductPageData = {
      product: product({ imageUrl: staleOptimizedImage }),
      category: undefined,
      media: [
        {
          id: "product_media_1",
          mediaId: "media_1",
          kind: "image",
          url: staleOptimizedImage,
          posterMediaId: null,
          posterUrl: null,
          altText: "Fish",
          caption: null,
          width: 1_200,
          height: 1_200,
          durationMs: null,
          isPrimary: true,
          sortOrder: 0,
          status: "ready",
        },
        {
          id: "product_media_2",
          mediaId: "media_2",
          kind: "video",
          url: "https://cloud.scalius.com/products/fish.mp4",
          posterMediaId: "media_1",
          posterUrl: staleOptimizedImage,
          altText: "Fish demonstration",
          caption: null,
          width: 1_920,
          height: 1_080,
          durationMs: 15_000,
          isPrimary: false,
          sortOrder: 1,
          status: "ready",
        },
      ],
      variants: [],
      relatedProducts: [
        product({ id: "prod_2", imageUrl: staleOptimizedImage }),
      ],
    };

    const optimized = withOptimizedProductPageImages(productData);

    expect(optimized.product.imageUrl).toContain("width=400");
    expect(optimized.media[0]?.url).toContain("width=600");
    expect(optimized.media[1]?.url).toBe(
      "https://cloud.scalius.com/products/fish.mp4",
    );
    expect(optimized.media[1]?.posterUrl).toContain("width=600");
    expect(optimized.relatedProducts[0]?.imageUrl).toContain("width=400");
    expect(JSON.stringify(optimized)).not.toContain("width=1200");
    expect(optimized.media[0]?.url.match(/\/cdn-cgi\/image\//g)).toHaveLength(
      1,
    );
  });
});
