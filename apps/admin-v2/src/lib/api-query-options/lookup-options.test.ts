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
  getCollections: mocks.getCollections,
  getCollectionsByIds: mocks.getCollectionsByIds,
}));

import { productsByIdsQueryOptions } from "./products";
import {
  collectionCategoryOptionsQueryOptions,
  collectionFormOptionsQueryOptions,
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
      collections: [{ id: "col_1", name: "Featured", type: "manual" }],
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
});
