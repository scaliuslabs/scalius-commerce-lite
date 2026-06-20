import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProductBySlug: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getProductBySlug: mocks.getProductBySlug,
}));

vi.mock("@/lib/api/storefront", () => ({
  getLayoutData: vi.fn(),
}));

vi.mock("@/lib/api/runtime-env", () => ({
  setRuntimeImageCdnPolicy: vi.fn(),
}));

vi.mock("@/lib/product-media", () => ({
  getProductImageUrl: (url: string) => url,
  hasProductImage: (url: string | null | undefined) => Boolean(url),
}));

vi.mock("@/lib/safe-json", () => ({
  serializeJsonForInlineScript: (value: unknown) => JSON.stringify(value),
}));

import { GET } from "./[slug]";

describe("/buy/[slug]", () => {
  it("does not create quick-buy cart data for products without real variants", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: false,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "default", productId: "prod_1", price: 150 }],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=product_unavailable");
  });
});
