import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiV1Products: vi.fn(),
  getApiV1ProductsBySlug: vi.fn(),
  getApiV1CategoriesBySlugProducts: vi.fn(),
  getApiV1Search: vi.fn(),
  getApiV1ProductsSearch: vi.fn(),
  getConfiguredSdkClient: vi.fn(() => ({ baseUrl: "https://api.example.test" })),
  edgeCacheKeys: [] as string[],
}));

vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1Products: mocks.getApiV1Products,
  getApiV1ProductsBySlug: mocks.getApiV1ProductsBySlug,
  getApiV1CategoriesBySlugProducts: mocks.getApiV1CategoriesBySlugProducts,
  getApiV1Search: mocks.getApiV1Search,
  getApiV1ProductsSearch: mocks.getApiV1ProductsSearch,
}));

vi.mock("./client", () => ({
  getConfiguredSdkClient: mocks.getConfiguredSdkClient,
}));

vi.mock("@/lib/edge-cache", () => ({
  CACHE_TTL: { LONG: 86400, MEDIUM: 3600, SHORT: 300 },
  withEdgeCache: async <T>(
    key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => {
    mocks.edgeCacheKeys.push(key);
    return fetcher();
  },
}));

import {
  getAllProducts,
  getProductsByCategory,
  getProductBySlugResult,
  searchProductsForForm,
} from "./products";

function productPagePayload() {
  return {
    product: {
      id: "prod_1",
      slug: "fresh-hilsa",
      name: "Fresh Hilsa",
    },
    category: null,
    images: [],
    variants: [],
    variantImageMappings: [],
    relatedProducts: [],
  };
}

describe("storefront product API helpers", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mocks.edgeCacheKeys.length = 0;
  });

  it("does not convert API product-list errors into an empty catalog", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getApiV1Products.mockResolvedValue({
      error: { message: "backend unavailable" },
    });

    await expect(getAllProducts()).resolves.toBeNull();

    expect(errorSpy).toHaveBeenCalledWith("Error fetching all products:", {
      message: "backend unavailable",
    });
  });

  it("distinguishes an authoritative product 404 from a successful read", async () => {
    mocks.getApiV1ProductsBySlug
      .mockResolvedValueOnce({
        error: { message: "not found" },
        response: { status: 404 },
      })
      .mockResolvedValueOnce({
        data: { success: true, data: productPagePayload() },
        response: { status: 200 },
      });

    await expect(getProductBySlugResult("missing")).resolves.toEqual({
      state: "not_found",
    });
    await expect(getProductBySlugResult("fresh-hilsa")).resolves.toEqual({
      state: "found",
      data: productPagePayload(),
    });
  });

  it("treats product API failures and malformed envelopes as unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getApiV1ProductsBySlug
      .mockResolvedValueOnce({
        error: { message: "backend unavailable" },
        response: { status: 500 },
      })
      .mockResolvedValueOnce({
        data: { success: true, data: { product: productPagePayload().product } },
        response: { status: 200 },
      })
      .mockRejectedValueOnce(new Error("timeout"));

    await expect(getProductBySlugResult("backend-error")).resolves.toEqual({
      state: "unavailable",
    });
    await expect(getProductBySlugResult("bad-envelope")).resolves.toEqual({
      state: "unavailable",
    });
    await expect(getProductBySlugResult("timeout")).resolves.toEqual({
      state: "unavailable",
    });
  });

  it("does not convert malformed product-list envelopes into an empty catalog", async () => {
    mocks.getApiV1Products.mockResolvedValue({
      data: { success: true },
    });

    await expect(getAllProducts()).resolves.toBeNull();
  });

  it("preserves a legitimate empty product list from the API", async () => {
    const pagination = { page: 1, limit: 20, total: 0, totalPages: 0 };
    mocks.getApiV1Products.mockResolvedValue({
      data: {
        success: true,
        data: {
          products: [],
          pagination,
        },
      },
    });

    await expect(getAllProducts()).resolves.toEqual({
      data: [],
      pagination,
      facets: [],
      priceRange: undefined,
    });
  });

  it("uses the fresh category projection cache namespace", async () => {
    const pagination = { page: 1, limit: 20, total: 0, totalPages: 0 };
    mocks.getApiV1CategoriesBySlugProducts.mockResolvedValue({
      data: {
        success: true,
        data: {
          category: { id: "cat_1", name: "Shoes", slug: "shoes" },
          products: [],
          pagination,
          priceRange: { min: 1200, max: 5000 },
          facets: [],
        },
      },
    });

    await expect(getProductsByCategory("shoes")).resolves.toMatchObject({
      priceRange: { min: 1200, max: 5000 },
    });
    expect(mocks.edgeCacheKeys).toContain("category_products_v2_shoes_default");
    expect(mocks.edgeCacheKeys).not.toContain("category_products_shoes_default");
  });

  it("uses the product search endpoint for product form lookup", async () => {
    const pagination = { page: 2, limit: 5, total: 11, totalPages: 3 };
    const product = {
      id: "prod_1",
      name: "Fresh Hilsa",
      slug: "fresh-hilsa",
      price: 1200,
      imageUrl: null,
      variants: [],
    };
    mocks.getApiV1ProductsSearch.mockResolvedValue({
      data: {
        success: true,
        data: {
          data: [product],
          pagination,
        },
      },
    });

    await expect(searchProductsForForm("  Fresh   Hilsa  ", 2, 5)).resolves.toEqual({
      data: [product],
      pagination,
    });

    expect(mocks.getApiV1ProductsSearch).toHaveBeenCalledWith({
      client: { baseUrl: "https://api.example.test" },
      query: { search: "Fresh Hilsa", page: 2, limit: 5 },
    });
    expect(mocks.getApiV1Search).not.toHaveBeenCalled();
  });

  it("returns an empty product lookup result without fetching for blank searches", async () => {
    await expect(searchProductsForForm("   ", 3, 7)).resolves.toEqual({
      data: [],
      pagination: { page: 3, limit: 7, total: 0, totalPages: 0 },
    });

    expect(mocks.getApiV1ProductsSearch).not.toHaveBeenCalled();
    expect(mocks.getApiV1Search).not.toHaveBeenCalled();
  });
});
