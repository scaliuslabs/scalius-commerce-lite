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
    expect(result.body.products[0].url).toBe("https://storefront.example.test/shop/khaki-shoes");
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
    });
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
  });
});
