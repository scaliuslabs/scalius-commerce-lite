import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const recorder = () => Object.assign(vi.fn(), { result: undefined as unknown });
  return {
    getProductsByIds: recorder(),
    getCollectionProductOptions: recorder(),
    getCollections: recorder(),
    getCollectionsByIds: recorder(),
  };
});

const ok = (data: unknown) => Promise.resolve({ data: { success: true, data } });
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminProductsByIds: (options: unknown) => { mocks.getProductsByIds(options); return ok(mocks.getProductsByIds.result); },
  getApiV1AdminCollectionsByIds: (options: unknown) => { mocks.getCollectionsByIds(options); return ok(mocks.getCollectionsByIds.result); },
  getApiV1AdminCollections: (options: unknown) => { mocks.getCollections(options); return ok(mocks.getCollections.result); },
  getApiV1AdminCollectionsProductOptions: (options: unknown) => {
    mocks.getCollectionProductOptions(options);
    return ok(mocks.getCollectionProductOptions.result);
  },
}));

import { productsByIdsQueryOptions } from "./products";
import {
  collectionPickerOptionsQueryOptions,
  collectionProductOptionsQueryOptions,
  collectionsByIdsQueryOptions,
} from "./collections";

function requireQueryFn<T>(options: { queryFn?: unknown }) {
  if (typeof options.queryFn !== "function") {
    throw new Error("Expected lookup queryFn to be configured");
  }
  return options.queryFn as (context: never) => Promise<T>;
}

describe("lookup query options", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mocks)) mock.result = undefined;
  });

  it("keeps product lookups shaped while ids are empty or still loading", async () => {
    const options = productsByIdsQueryOptions([]);

    expect(options.placeholderData).toEqual({ products: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual({
      products: [],
    });
    expect(mocks.getProductsByIds).not.toHaveBeenCalled();
  });

  it("normalizes product lookup ids without removing the empty placeholder", async () => {
    const payload = {
      products: [{ id: "prod_1", name: "One", price: 100, categoryId: null }],
    };
    mocks.getProductsByIds.result = payload;

    const options = productsByIdsQueryOptions([" prod_1 ", "prod_1", ""]);

    expect(options.placeholderData).toEqual({ products: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual(payload);
    expect(mocks.getProductsByIds).toHaveBeenCalledWith({
      query: { ids: "prod_1" },
    });
  });

  it("keeps collection lookups shaped while ids are empty or still loading", async () => {
    const options = collectionsByIdsQueryOptions([]);

    expect(options.placeholderData).toEqual({ collections: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual({
      collections: [],
    });
    expect(mocks.getCollectionsByIds).not.toHaveBeenCalled();
  });

  it("normalizes collection lookup ids without removing the empty placeholder", async () => {
    const payload = {
      collections: [{ id: "col_1", name: "Featured", presentation: "grid" }],
    };
    mocks.getCollectionsByIds.result = payload;

    const options = collectionsByIdsQueryOptions(["col_1", " col_1 ", ""]);

    expect(options.placeholderData).toEqual({ collections: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual(payload);
    expect(mocks.getCollectionsByIds).toHaveBeenCalledWith({
      query: { ids: "col_1" },
    });
  });

  it("keys and advances the discount collection picker by server pagination", async () => {
    const payload = {
      collections: [{
        id: "col_11",
        name: "Spring",
        presentation: "grid" as const,
        config: "{}",
        sortOrder: 0,
        isActive: true,
        version: 1,
        canonicalPath: null,
        noIndex: false,
        excludeFromSitemap: false,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
      }],
      pagination: { page: 2, limit: 10, total: 11, totalPages: 2 },
    };
    mocks.getCollections.result = payload;

    const options = collectionPickerOptionsQueryOptions({
      search: " spring ",
      limit: 10,
    });

    expect(options.queryKey).toEqual([
      "collections",
      "list",
      { scope: "discount-picker", search: "spring", limit: 10 },
    ]);
    await expect(
      requireQueryFn(options)({ pageParam: 2 } as never),
    ).resolves.toEqual(payload);
    expect(mocks.getCollections).toHaveBeenCalledWith({
      query: { page: 2, limit: 10, search: "spring" },
    });
    expect(options.getNextPageParam?.(payload, [payload], 2, [1, 2])).toBeUndefined();
  });

  it("keys and pages collection product options by normalized server filters", async () => {
    const payload = {
      products: [{
        id: "prod_1",
        name: "Blue shirt",
        price: 1200,
        categoryId: "cat_2",
        categoryName: "Shirts",
        isActive: true,
        primaryImage: "/products/blue-shirt.webp",
        variantCount: 3,
        available: 12,
      }],
      pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
    };
    mocks.getCollectionProductOptions.result = payload;

    const options = collectionProductOptionsQueryOptions({
      categoryIds: [" cat_2 ", "cat_1", "cat_2", ""],
      selectedProductIds: ["prod_2", " prod_1 ", "prod_2"],
      search: " blue ",
      limit: 10,
    });

    expect(options.queryKey).toEqual([
      "products",
      "collection-options",
      {
        categoryIds: ["cat_2", "cat_1"],
        selectedProductIds: ["prod_1", "prod_2"],
        search: "blue",
        limit: 10,
      },
    ]);
    await expect(
      requireQueryFn(options)({ pageParam: 2 } as never),
    ).resolves.toEqual(payload);
    expect(mocks.getCollectionProductOptions).toHaveBeenCalledWith({
      query: {
        page: 2,
        limit: 10,
        search: "blue",
        categoryIds: "cat_2,cat_1",
        selectedProductIds: "prod_1,prod_2",
      },
    });
    expect(options.getNextPageParam?.(payload, [payload], 2, [1, 2])).toBe(3);
  });
});
