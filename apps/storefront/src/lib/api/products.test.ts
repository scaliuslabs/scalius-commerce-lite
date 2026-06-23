import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiV1Products: vi.fn(),
  getApiV1ProductsBySlug: vi.fn(),
  getApiV1CategoriesBySlugProducts: vi.fn(),
  getApiV1Search: vi.fn(),
  getConfiguredSdkClient: vi.fn(() => ({ baseUrl: "https://api.example.test" })),
}));

vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1Products: mocks.getApiV1Products,
  getApiV1ProductsBySlug: mocks.getApiV1ProductsBySlug,
  getApiV1CategoriesBySlugProducts: mocks.getApiV1CategoriesBySlugProducts,
  getApiV1Search: mocks.getApiV1Search,
}));

vi.mock("./client", () => ({
  getConfiguredSdkClient: mocks.getConfiguredSdkClient,
}));

vi.mock("@/lib/edge-cache", () => ({
  CACHE_TTL: { LONG: 86400, MEDIUM: 3600, SHORT: 300 },
  withEdgeCache: async <T>(
    _key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => fetcher(),
}));

import { getAllProducts } from "./products";

describe("storefront product API helpers", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
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
    });
  });
});
