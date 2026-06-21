import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProductBySlug: vi.fn(),
  validateCartItems: vi.fn(),
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

vi.mock("@/lib/api/orders", () => ({
  validateCartItems: mocks.validateCartItems,
}));

vi.mock("@/lib/product-media", () => ({
  getProductImageUrl: (url: string) => url,
  hasProductImage: (url: string | null | undefined) => Boolean(url),
}));

vi.mock("@/lib/safe-json", () => ({
  serializeJsonForInlineScript: (value: unknown) => JSON.stringify(value),
}));

vi.mock("@/lib/product-sellable-variants", async () => (
  await import("../../lib/product-sellable-variants")
));

import { GET } from "./[slug]";

function validCartValidation(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      valid: true,
      issues: [],
      items: [
        {
          index: 0,
          cartKey: "quick_buy:prod_1:var_default_prod_1",
          productId: "prod_1",
          variantId: "var_default_prod_1",
          quantity: 1,
          unitPrice: 150,
          productName: "Cotton Panjabi",
          variantLabel: null,
          freeDelivery: false,
          availableQuantity: null,
          ...overrides,
        },
      ],
      subtotal: 150,
      hasFreeDeliveryProduct: false,
    },
  };
}

describe("/buy/[slug]", () => {
  beforeEach(() => {
    mocks.getProductBySlug.mockReset();
    mocks.validateCartItems.mockReset();
    mocks.validateCartItems.mockResolvedValue(validCartValidation());
  });

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
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("creates quick-buy cart data for simple products with a hidden default SKU", async () => {
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
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "var_default_prod_1", productId: "prod_1", price: 150, size: null, color: null }],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("var_default_prod_1");
    expect(mocks.validateCartItems).toHaveBeenCalledWith([
      expect.objectContaining({
        cartKey: "quick_buy:prod_1:var_default_prod_1",
        productId: "prod_1",
        variantId: "var_default_prod_1",
        quantity: 1,
        price: 150,
        productName: "Cotton Panjabi",
        variantLabel: null,
      }),
    ]);
  });

  it("requires an explicit variant for optioned products", async () => {
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
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "var_m", productId: "prod_1", price: 150, size: "M", color: null }],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=variant_required");
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("does not accept a hidden default SKU after customer options exist", async () => {
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
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [
        { id: "var_default_prod_1", productId: "prod_1", price: 150, size: null, color: null, isDefault: true },
        { id: "var_m", productId: "prod_1", price: 150, size: "M", color: null, isDefault: false },
      ],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi?variant=var_default_prod_1"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=variant_not_found");
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("does not create quick-buy cart data when validation reports out of stock", async () => {
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
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "var_default_prod_1", productId: "prod_1", price: 150, size: null, color: null }],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: false,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_default_prod_1",
          code: "QUANTITY_UNAVAILABLE",
          action: "remove",
          message: "Cotton Panjabi is out of stock.",
          productName: "Cotton Panjabi",
          variantLabel: null,
          requestedQuantity: 1,
          availableQuantity: 0,
        }],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=out_of_stock");
  });

  it("rejects invalid quick-buy quantities before cart validation", async () => {
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
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "var_default_prod_1", productId: "prod_1", price: 150, size: null, color: null }],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi?qty=1000"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=invalid_quantity");
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("does not create quick-buy cart data when validation reports a price change", async () => {
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
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "var_default_prod_1", productId: "prod_1", price: 150, size: null, color: null }],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: false,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_default_prod_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "Cotton Panjabi price changed.",
          productName: "Cotton Panjabi",
          variantLabel: null,
          requestedQuantity: 1,
          submittedPrice: 150,
          currentPrice: 175,
        }],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=price_changed");
  });

  it("fails closed when quick-buy validation is temporarily unavailable", async () => {
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
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "var_default_prod_1", productId: "prod_1", price: 150, size: null, color: null }],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce({
      success: false,
      status: 503,
      error: "Cart validation failed",
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=validation_unavailable");
  });
});
