import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getProductBySlug: vi.fn(),
  getLayoutData: vi.fn(),
}));

vi.mock("@/lib/api/products", () => ({
  getFeedProducts: mocks.getFeedProducts,
  getProductBySlug: mocks.getProductBySlug,
}));

vi.mock("@/lib/api/storefront", () => ({
  getLayoutData: mocks.getLayoutData,
}));

vi.mock("@/lib/sitemap-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sitemap-utils")>(
    "@/lib/sitemap-utils",
  );
  return {
    ...actual,
    getBaseUrl: () => "https://storefront.example.test",
  };
});

import {
  buildUcpProfile,
  getCatalogProduct,
  lookupCatalog,
  searchCatalog,
} from "./catalog";
import type { Product } from "@/lib/api/types";

const context = {
  baseUrl: "https://storefront.example.test",
  currency: { code: "BDT", decimalPlaces: 2 },
};

function productFixture(): Product {
  return {
    id: "prod_1",
    name: "Khaki Shoes",
    slug: "khaki-shoes",
    canonicalPath: "/shop/khaki-shoes",
    description: "<p>Comfortable <strong>shoes</strong></p>",
    price: 1500,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    discountedPrice: 1500,
    freeDelivery: true,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    variantOption1Label: "Weight",
    variantOption2Label: "Style",
    variantOption1Schema: "none",
    variantOption2Schema: "none",
    categoryId: "cat_1",
    category: { id: "cat_1", name: "Shoes", slug: "shoes" },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    imageUrl: "/images/shoe.jpg",
    imageAlt: "Khaki shoe",
    hasVariants: true,
    availableForSale: true,
    attributes: [{ name: "Material", slug: "material", value: "Canvas" }],
    variants: [
      {
        id: "var_1",
        productId: "prod_1",
        size: "2KG",
        color: "Red",
        weight: null,
        sku: "SKU-RED",
        price: 1200,
        stock: 3,
        reservedStock: 1,
        isDefault: false,
        trackInventory: true,
        barcode: "1234567890123",
        barcodeType: "ean13",
        discountType: "flat",
        discountAmount: 100,
        discountPercentage: null,
        colorSortOrder: 1,
        sizeSortOrder: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        deletedAt: null,
      },
      {
        id: "var_2",
        productId: "prod_1",
        size: "3KG",
        color: "Blue",
        weight: null,
        sku: "SKU-BLUE",
        price: 1600,
        stock: 0,
        reservedStock: 0,
        isDefault: false,
        trackInventory: false,
        barcode: null,
        barcodeType: null,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        colorSortOrder: 2,
        sizeSortOrder: 2,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
  };
}

describe("UCP catalog mapping", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
    mocks.getProductBySlug.mockReset();
    mocks.getLayoutData.mockReset();
  });

  it("advertises only read-only catalog capabilities", () => {
    const profile = buildUcpProfile("https://storefront.example.test");

    expect(profile.ucp.services["dev.ucp.shopping"][0].endpoint).toBe(
      "https://storefront.example.test/ucp",
    );
    expect(profile.ucp.services["dev.ucp.shopping"][0]).toMatchObject({
      version: "2026-04-08",
      spec: "https://ucp.dev/2026-04-08/specification/overview",
      schema: "https://ucp.dev/2026-04-08/services/shopping/rest.openapi.json",
    });
    expect(profile.ucp.capabilities["dev.ucp.shopping.catalog.search"][0]).toMatchObject({
      spec: "https://ucp.dev/2026-04-08/specification/catalog/search",
      schema: "https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json",
    });
    expect(profile.ucp.capabilities["dev.ucp.shopping.catalog.lookup"][0]).toMatchObject({
      spec: "https://ucp.dev/2026-04-08/specification/catalog/lookup",
      schema: "https://ucp.dev/2026-04-08/schemas/shopping/catalog_lookup.json",
    });
    expect(Object.keys(profile.ucp.capabilities)).toEqual([
      "dev.ucp.shopping.catalog.search",
      "dev.ucp.shopping.catalog.lookup",
    ]);
    expect(JSON.stringify(profile)).not.toContain("checkout");
    expect(JSON.stringify(profile)).not.toContain("payment_handlers");
  });

  it("maps search results with minor-unit prices and merchant option labels", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [productFixture()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await searchCatalog(
      {
        query: "khaki",
        filters: { price: { min: 100000, max: 200000 }, categories: ["shoes"] },
        pagination: { limit: 10 },
      },
      context,
    );

    expect(result.status).toBe(200);
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      sort: "newest",
      search: "khaki",
      category: "shoes",
      minPrice: 1000,
      maxPrice: 2000,
    });
    expect(result.body.products[0].url).toBe("https://storefront.example.test/products/khaki-shoes");
    expect(result.body.products[0].variants[0]).toMatchObject({
      id: "gid://scalius/product-variant/var_1",
      price: { amount: 110000, currency: "BDT" },
      list_price: { amount: 120000, currency: "BDT" },
      options: [
        { name: "Weight", label: "2KG" },
        { name: "Style", label: "Red" },
      ],
      availability: { available: true, status: "in_stock" },
      barcodes: [{ type: "EAN", value: "1234567890123" }],
      media: [
        {
          type: "image",
          url: "https://storefront.example.test/images/shoe.jpg",
          alt_text: "Khaki shoe",
        },
      ],
    });
  });

  it("filters catalog products without a safe discovery image", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          ...productFixture(),
          id: "prod_bad_image",
          imageUrl: "//cdn.example.test/unsafe.jpg",
        },
      ],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await searchCatalog({ query: "khaki" }, context);

    expect(result.status).toBe(200);
    expect(result.body.products).toEqual([]);
  });

  it("correlates lookup inputs for variant IDs and SKUs", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [productFixture()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await lookupCatalog(
      { ids: ["gid://scalius/product-variant/var_1", "SKU-BLUE"] },
      context,
    );

    expect(result.status).toBe(200);
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      ids: "var_1,SKU-BLUE",
      sort: "newest",
    });
    expect(result.body.products[0].variants).toHaveLength(2);
    expect(result.body.products[0].variants[0].inputs).toEqual([
      { id: "gid://scalius/product-variant/var_1", match: "exact" },
    ]);
    expect(result.body.products[0].variants[1].inputs).toEqual([
      { id: "SKU-BLUE", match: "exact" },
    ]);
  });

  it("correlates product URL lookup inputs to the featured variant", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [productFixture()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const productUrl = "https://storefront.example.test/products/khaki-shoes";
    const result = await lookupCatalog({ ids: [productUrl] }, context);

    expect(result.status).toBe(200);
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      ids: "khaki-shoes",
      sort: "newest",
    });
    expect(result.body.products[0].variants[0].inputs).toEqual([
      { id: productUrl, match: "featured" },
    ]);
  });

  it("rejects lookup requests with too many unique identifiers", async () => {
    const ids = Array.from({ length: 26 }, (_, index) => `SKU-${index}`);

    const result = await lookupCatalog({ ids }, context);

    expect(result.status).toBe(400);
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({
      ucp: { status: "error" },
      products: [],
      messages: [
        {
          type: "error",
          code: "request_too_large",
          path: "$.ids",
          severity: "recoverable",
        },
      ],
    });
  });

  it("does not fall back to product detail for slug-like lookup misses", async () => {
    const product = productFixture();
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: { ...product, excludeFromProductFeed: true },
      category: product.category,
      images: [],
      variants: product.variants,
      relatedProducts: [],
    });

    const result = await lookupCatalog({ ids: ["khaki-shoes"] }, context);

    expect(result.status).toBe(200);
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      ids: "khaki-shoes",
      sort: "newest",
    });
    expect(mocks.getProductBySlug).not.toHaveBeenCalled();
    expect(result.body.products).toEqual([]);
    expect(result.body.messages?.[0]).toMatchObject({
      type: "info",
      code: "partial_lookup",
    });
  });

  it("returns lookup 503 when the feed projection cannot be read", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce(null);

    const result = await lookupCatalog({ ids: ["khaki-shoes"] }, context);

    expect(result.status).toBe(503);
    expect(mocks.getProductBySlug).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({
      ucp: { status: "error" },
      products: [],
      messages: [
        {
          type: "error",
          code: "temporarily_unavailable",
        },
      ],
    });
  });

  it("filters any feed-excluded row before mapping lookup products", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [{ ...productFixture(), excludeFromProductFeed: true } as Product],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await lookupCatalog({ ids: ["khaki-shoes"] }, context);

    expect(result.status).toBe(200);
    expect(result.body.products).toEqual([]);
  });

  it("returns full product detail while ordering the requested variant first", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [productFixture()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await getCatalogProduct({ id: "SKU-BLUE" }, context);
    const product = result.body.product;

    expect(result.status).toBe(200);
    expect(product).toBeDefined();
    if (!product) throw new Error("Expected UCP product detail");
    expect(product.variants).toHaveLength(2);
    expect(product.variants[0].sku).toBe("SKU-BLUE");
    expect(product.variants[1].sku).toBe("SKU-RED");
    expect(product.selected).toEqual([
      { name: "Weight", label: "3KG" },
      { name: "Style", label: "Blue" },
    ]);
    expect(product.options).toEqual([
      {
        name: "Weight",
        values: [
          { label: "2KG", exists: false, available: false },
          { label: "3KG", exists: true, available: true },
        ],
      },
      {
        name: "Style",
        values: [
          { label: "Red", exists: false, available: false },
          { label: "Blue", exists: true, available: true },
        ],
      },
    ]);
  });

  it("keeps the requested variant first when selected options conflict", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [productFixture()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await getCatalogProduct(
      {
        id: "SKU-BLUE",
        selected: [
          { name: "Weight", label: "2KG" },
          { name: "Style", label: "Red" },
        ],
      },
      context,
    );
    const product = result.body.product;

    expect(result.status).toBe(200);
    expect(product).toBeDefined();
    if (!product) throw new Error("Expected UCP product detail");
    expect(product.variants[0].sku).toBe("SKU-BLUE");
    expect(product.variants[1].sku).toBe("SKU-RED");
    expect(product.selected).toEqual([
      { name: "Weight", label: "3KG" },
      { name: "Style", label: "Blue" },
    ]);
  });

  it("rejects duplicate selected option names for product detail", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [productFixture()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await getCatalogProduct(
      {
        id: "khaki-shoes",
        selected: [
          { name: "Weight", label: "2KG" },
          { name: "Weight", label: "3KG" },
        ],
      },
      context,
    );

    expect(result.status).toBe(400);
    expect(result.body.messages?.[0]).toMatchObject({
      type: "error",
      code: "request_invalid",
      path: "$.selected",
      severity: "recoverable",
    });
  });

  it("does not fall back to product detail for slug-like product misses", async () => {
    const product = productFixture();
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: { ...product, excludeFromProductFeed: true },
      category: product.category,
      images: [],
      variants: product.variants,
      relatedProducts: [],
    });

    const result = await getCatalogProduct({ id: "khaki-shoes" }, context);

    expect(result.status).toBe(200);
    expect(mocks.getProductBySlug).not.toHaveBeenCalled();
    expect(result.body.messages?.[0]).toMatchObject({
      type: "error",
      code: "not_found",
      severity: "unrecoverable",
    });
  });

  it("filters any feed-excluded row before mapping product detail", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [{ ...productFixture(), excludeFromProductFeed: true } as Product],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const result = await getCatalogProduct({ id: "khaki-shoes" }, context);

    expect(result.status).toBe(200);
    expect(result.body.messages?.[0]).toMatchObject({
      type: "error",
      code: "not_found",
      severity: "unrecoverable",
    });
  });

  it("returns product 503 when the feed projection cannot be read", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce(null);

    const result = await getCatalogProduct({ id: "khaki-shoes" }, context);

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      ucp: { status: "error" },
      messages: [
        {
          type: "error",
          code: "temporarily_unavailable",
        },
      ],
    });
  });
});
