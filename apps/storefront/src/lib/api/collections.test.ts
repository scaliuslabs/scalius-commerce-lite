import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiV1Collections: vi.fn(),
  getApiV1CollectionsById: vi.fn(),
  getConfiguredSdkClient: vi.fn(() => ({ baseUrl: "https://api.example.test" })),
}));

vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1Collections: mocks.getApiV1Collections,
  getApiV1CollectionsById: mocks.getApiV1CollectionsById,
}));

vi.mock("./client", () => ({
  getConfiguredSdkClient: mocks.getConfiguredSdkClient,
}));

vi.mock("@/lib/edge-cache", () => ({
  CACHE_TTL: { LONG: 86400 },
  withEdgeCache: async <T>(
    _key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => fetcher(),
}));

import { getCollectionByIdResult } from "./collections";

function collectionPayload() {
  return {
    collection: {
      id: "col_1",
      name: "Summer",
    },
    categories: [],
    products: [],
    featuredProduct: null,
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    priceRange: { min: 0, max: 0 },
    facets: [],
  };
}

describe("storefront collection API helpers", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("distinguishes an authoritative collection 404 from a successful read", async () => {
    mocks.getApiV1CollectionsById
      .mockResolvedValueOnce({
        error: { message: "not found" },
        response: { status: 404 },
      })
      .mockResolvedValueOnce({
        data: { success: true, data: collectionPayload() },
        response: { status: 200 },
      });

    await expect(getCollectionByIdResult("missing")).resolves.toEqual({
      state: "not_found",
    });
    await expect(getCollectionByIdResult("col_1")).resolves.toEqual({
      state: "found",
      data: {
        ...collectionPayload().collection,
        categories: [],
        products: [],
        featuredProduct: null,
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        priceRange: { min: 0, max: 0 },
        facets: [],
      },
    });
    expect(mocks.getApiV1CollectionsById).toHaveBeenLastCalledWith({
      client: { baseUrl: "https://api.example.test" },
      path: { id: "col_1" },
      query: {},
    });
  });

  it("treats collection API failures and malformed envelopes as unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getApiV1CollectionsById
      .mockResolvedValueOnce({
        error: { message: "backend unavailable" },
        response: { status: 500 },
      })
      .mockResolvedValueOnce({
        data: { success: true, data: { products: [] } },
        response: { status: 200 },
      })
      .mockRejectedValueOnce(new Error("timeout"));

    await expect(getCollectionByIdResult("backend-error")).resolves.toEqual({
      state: "unavailable",
    });
    await expect(getCollectionByIdResult("bad-envelope")).resolves.toEqual({
      state: "unavailable",
    });
    await expect(getCollectionByIdResult("timeout")).resolves.toEqual({
      state: "unavailable",
    });
  });
});
