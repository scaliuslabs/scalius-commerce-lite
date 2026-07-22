import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getProducts: vi.fn(),
  getProductsByIds: vi.fn(),
  getProductStats: vi.fn(),
  getProductVariants: vi.fn(),
  getVariantSortOrder: vi.fn(),
  getCollection: vi.fn(),
  getCollectionCategoryOptions: vi.fn(),
  getCollectionFormOptions: vi.fn(),
  getCollectionProductOptions: vi.fn(),
  getCollections: vi.fn(),
  getCollectionsByIds: vi.fn(),
}));

vi.mock("../api-functions/products", () => ({
  getProduct: mocks.getProduct,
  getProducts: mocks.getProducts,
  getProductsByIds: mocks.getProductsByIds,
  getProductStats: mocks.getProductStats,
  getProductVariants: mocks.getProductVariants,
  getVariantSortOrder: mocks.getVariantSortOrder,
}));

vi.mock("../api-functions/collections", () => ({
  getCollection: mocks.getCollection,
  getCollectionCategoryOptions: mocks.getCollectionCategoryOptions,
  getCollectionFormOptions: mocks.getCollectionFormOptions,
  getCollectionProductOptions: mocks.getCollectionProductOptions,
  getCollections: mocks.getCollections,
  getCollectionsByIds: mocks.getCollectionsByIds,
}));

import { productsByIdsQueryOptions } from "./products";
import {
  collectionCategoryOptionsQueryOptions,
  collectionFormOptionsQueryOptions,
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
    mocks.getProductsByIds.mockResolvedValue(payload);

    const options = productsByIdsQueryOptions([" prod_1 ", "prod_1", ""]);

    expect(options.placeholderData).toEqual({ products: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual(payload);
    expect(mocks.getProductsByIds).toHaveBeenCalledWith({
      data: { ids: ["prod_1"] },
    });
  });

  it("coerces malformed product lookup payloads to an empty list", async () => {
    mocks.getProductsByIds.mockResolvedValue(undefined);

    const options = productsByIdsQueryOptions(["prod_1"]);

    await expect(requireQueryFn(options)({} as never)).resolves.toEqual({
      products: [],
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
    mocks.getCollectionsByIds.mockResolvedValue(payload);

    const options = collectionsByIdsQueryOptions(["col_1", " col_1 ", ""]);

    expect(options.placeholderData).toEqual({ collections: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual(payload);
    expect(mocks.getCollectionsByIds).toHaveBeenCalledWith({
      data: { ids: ["col_1"] },
    });
  });

  it("coerces malformed collection lookup payloads to an empty list", async () => {
    mocks.getCollectionsByIds.mockResolvedValue({ collections: undefined });

    const options = collectionsByIdsQueryOptions(["col_1"]);

    await expect(requireQueryFn(options)({} as never)).resolves.toEqual({
      collections: [],
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
    mocks.getCollections.mockResolvedValue(payload);

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
      data: { page: 2, limit: 10, search: "spring" },
    });
    expect(options.getNextPageParam?.(payload, [payload], 2, [1, 2])).toBeUndefined();
  });

  it("keeps collection form option payloads shaped", async () => {
    mocks.getCollectionFormOptions.mockResolvedValue({ categories: undefined });

    const options = collectionFormOptionsQueryOptions();

    expect(options.placeholderData).toEqual({ categories: [], products: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual({
      categories: [],
      products: [],
    });
  });

  it("keeps collection category option payloads shaped", async () => {
    mocks.getCollectionCategoryOptions.mockResolvedValue(undefined);

    const options = collectionCategoryOptionsQueryOptions();

    expect(options.placeholderData).toEqual({ categories: [] });
    await expect(requireQueryFn(options)({} as never)).resolves.toEqual({
      categories: [],
    });
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
      }],
      pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
    };
    mocks.getCollectionProductOptions.mockResolvedValue(payload);

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
      data: {
        page: 2,
        limit: 10,
        search: "blue",
        categoryIds: ["cat_2", "cat_1"],
        selectedProductIds: ["prod_1", "prod_2"],
      },
    });
    expect(options.getNextPageParam?.(payload, [payload], 2, [1, 2])).toBe(3);
  });

  it("fails closed when category rows reach the manual product picker", async () => {
    mocks.getCollectionProductOptions.mockResolvedValue({
      products: [{
        id: "cat_home",
        name: "Home & Living",
        status: "published",
        productCount: 4,
      }],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const options = collectionProductOptionsQueryOptions({ limit: 10 });

    await expect(
      requireQueryFn(options)({ pageParam: 1 } as never),
    ).resolves.toEqual({
      products: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });
  });
});
