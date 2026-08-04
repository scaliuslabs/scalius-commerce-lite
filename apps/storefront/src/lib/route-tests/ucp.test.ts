// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getProductBySlug: vi.fn(),
  getLayoutData: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
  getRuntimeCdnDomain: vi.fn(() => ""),
  getRuntimeImageCdnAllowedHosts: vi.fn(() => []),
  getRuntimeImageCdnBaseUrl: vi.fn(() => ""),
  getRuntimeImageCdnCanonicalHostAliases: vi.fn(() => []),
  getRuntimeImageOptimizationEnabled: vi.fn(() => false),
  setRuntimeImageCdnPolicy: vi.fn(),
}));

vi.mock("@/lib/api/products", () => ({
  getFeedProducts: mocks.getFeedProducts,
  getProductBySlug: mocks.getProductBySlug,
}));

vi.mock("@/lib/api/storefront", () => ({
  getLayoutData: mocks.getLayoutData,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
  getRuntimeCdnDomain: mocks.getRuntimeCdnDomain,
  getRuntimeImageCdnAllowedHosts: mocks.getRuntimeImageCdnAllowedHosts,
  getRuntimeImageCdnBaseUrl: mocks.getRuntimeImageCdnBaseUrl,
  getRuntimeImageCdnCanonicalHostAliases: mocks.getRuntimeImageCdnCanonicalHostAliases,
  getRuntimeImageOptimizationEnabled: mocks.getRuntimeImageOptimizationEnabled,
  setRuntimeImageCdnPolicy: mocks.setRuntimeImageCdnPolicy,
}));

import { GET as getProfile } from "../../pages/.well-known/ucp";
import { GET as getLlmsTxt } from "../../pages/llms.txt";
import { POST as lookupCatalog } from "../../pages/ucp/catalog/lookup";
import { POST as getCatalogProduct } from "../../pages/ucp/catalog/product";
import { POST as searchCatalog } from "../../pages/ucp/catalog/search";
import type { Product } from "@/lib/api/types";

function request(body: unknown, headers: HeadersInit = {}, path = "/ucp/catalog/search") {
  return new Request(`https://storefront.example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

type CatalogProductOverrides = Partial<Product> & {
  excludeFromProductFeed?: boolean;
};

function catalogProduct(overrides: CatalogProductOverrides = {}): Product {
  return {
    id: "prod_1",
    name: "Khaki Shoes",
    slug: "khaki-shoes",
    canonicalPath: null,
    description: "<p>Comfortable shoes</p>",
    price: 1500,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    discountedPrice: 1500,
    freeDelivery: false,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    options: [
      { id: "weight", name: "Weight", position: 0, standardMapping: "none", values: [{ id: "2kg", value: "2KG", position: 0 }] },
      { id: "style", name: "Style", position: 1, standardMapping: "none", values: [{ id: "red", value: "Red", position: 0 }] },
    ],
    categoryId: "cat_1",
    category: { id: "cat_1", name: "Shoes", slug: "shoes" },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    imageUrl: "/images/shoe.jpg",
    imageAlt: "Khaki shoe",
    hasVariants: true,
    availableForSale: true,
    attributes: [],
    variants: [
      {
        id: "var_1",
        productId: "prod_1",
        optionCombinationKey: "2kg|red",
        imageId: null,
        selectedOptions: [
          { optionDefinitionId: "weight", optionValueId: "2kg", name: "Weight", value: "2KG", position: 0, valuePosition: 0, standardMapping: "none" },
          { optionDefinitionId: "style", optionValueId: "red", name: "Style", value: "Red", position: 1, valuePosition: 0, standardMapping: "none" },
        ],
        weight: null,
        sku: "SKU-RED",
        price: 1200,
        stock: 3,
        reservedStock: 0,
        isDefault: false,
        trackInventory: true,
        barcode: null,
        barcodeType: null,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    ...overrides,
  };
}

describe("UCP storefront routes", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
    mocks.getProductBySlug.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
    mocks.setRuntimeImageCdnPolicy.mockReset();
    mocks.getLayoutData.mockResolvedValue({
      currency: { code: "BDT", decimalPlaces: 2 },
    });
  });

  it("publishes a cacheable read-only catalog profile", async () => {
    const response = await getProfile({} as never);
    const body = await response.json();
    const serializedProfile = JSON.stringify(body).toLowerCase();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("max-age=300");
    expect(body.ucp.services["dev.ucp.shopping"][0].endpoint).toBe(
      "https://storefront.example.test/ucp",
    );
    expect(Object.keys(body.ucp.capabilities)).toEqual([
      "dev.ucp.shopping.catalog.search",
      "dev.ucp.shopping.catalog.lookup",
    ]);
    expect(body.payment_handlers).toBeUndefined();
    expect(body.ucp.payment_handlers).toBeUndefined();
    for (const unsafeCapability of [
      "checkout",
      "cart",
      "order",
      "payment",
      "fulfillment",
      "recovery",
      "customer",
    ]) {
      expect(serializedProfile).not.toContain(unsafeCapability);
    }
  });

  it("publishes an accurate llms.txt guide to the read-only UCP catalog", async () => {
    const response = await getLlmsTxt({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(body).toContain("https://storefront.example.test/.well-known/ucp");
    expect(body).toContain("dev.ucp.shopping.catalog.search");
    expect(body).toContain("dev.ucp.shopping.catalog.lookup");
    expect(body).toContain('UCP-Agent: profile="https://your-agent.example/.well-known/ucp"');
    expect(body).toContain("Cart, checkout, order, fulfillment, payment, and recovery capabilities are not advertised");
  });

  it("fails llms.txt closed when the canonical HTTPS storefront URL is unavailable", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");

    const response = await getLlmsTxt({} as never);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails closed when the storefront URL cannot form an HTTPS profile origin", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");

    const response = await getProfile({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("UCP profile is temporarily unavailable");
  });

  it("fails closed instead of publishing a non-HTTPS UCP profile", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("http://storefront.example.test");

    const response = await getProfile({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("requires UCP-Agent on catalog operations", async () => {
    const response = await searchCatalog({
      request: request({ query: "shoe" }),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.messages[0].code).toBe("invalid_profile_url");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("rejects malformed UCP-Agent headers before catalog work", async () => {
    const response = await searchCatalog({
      request: request(
        { query: "shoe" },
        { "UCP-Agent": 'profile="http://agent.example.test/.well-known/ucp"' },
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.messages[0].code).toBe("invalid_profile_url");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("rejects unsupported UCP versions before catalog work", async () => {
    const response = await searchCatalog({
      request: request(
        { ucp: { version: "2026-07" }, query: "shoe" },
        { "UCP-Agent": 'profile="https://agent.example.test/.well-known/ucp"' },
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.messages[0].code).toBe("version_unsupported");
    expect(body.messages[0].path).toBe("$.ucp.version");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("serves search from feed-ready buyer catalog rows only", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        catalogProduct(),
        catalogProduct({
          id: "prod_hidden",
          slug: "hidden-shoes",
          excludeFromProductFeed: true,
        }),
        catalogProduct({
          id: "prod_inactive",
          slug: "inactive-shoes",
          isActive: false,
        }),
        catalogProduct({
          id: "prod_no_media",
          slug: "no-media-shoes",
          imageUrl: null,
        }),
      ],
      pagination: { page: 1, limit: 10, total: 4, totalPages: 1 },
    });

    const response = await searchCatalog({
      request: request(
        { ucp: { version: "2026-04-08" }, query: "khaki" },
        { "UCP-Agent": 'profile="https://agent.example.test/.well-known/ucp"' },
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({
      limit: 10,
      search: "khaki",
    });
    expect(mocks.getProductBySlug).not.toHaveBeenCalled();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({
      id: "gid://scalius/product/prod_1",
      metadata: { available_for_sale: true },
      variants: [
        {
          id: "gid://scalius/product-variant/var_1",
          availability: { available: true, status: "in_stock" },
        },
      ],
    });
  });

  it("omits legacy products whose active SKUs mix option-axis shapes", async () => {
    const mixedProduct = catalogProduct({
      variants: [
        {
          ...catalogProduct().variants![0]!,
          id: "var_size_42",
          sku: "SKU-42",
          optionCombinationKey: "42",
          selectedOptions: [{ optionDefinitionId: "weight", optionValueId: "2kg", name: "Weight", value: "42", position: 0, valuePosition: 0, standardMapping: "none" }],
        },
        {
          ...catalogProduct().variants![0]!,
          id: "var_size_41_green",
          sku: "SKU-41-GREEN",
          optionCombinationKey: null,
          selectedOptions: [],
        },
      ],
    });
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [mixedProduct],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    const response = await searchCatalog({
      request: request(
        { ucp: { version: "2026-04-08" }, query: "khaki" },
        { "UCP-Agent": 'profile="https://agent.example.test/.well-known/ucp"' },
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.products).toEqual([]);
  });

  it("serves lookup from the feed projection without product-detail fallback", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: catalogProduct({ excludeFromProductFeed: true }),
      category: null,
      media: [],
      variants: [],
      relatedProducts: [],
    });

    const response = await lookupCatalog({
      request: request(
        { ucp: { version: "2026-04-08" }, ids: ["khaki-shoes"] },
        { "UCP-Agent": 'profile="https://agent.example.test/.well-known/ucp"' },
        "/ucp/catalog/lookup",
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({
      limit: 10,
      ids: "khaki-shoes",
    });
    expect(mocks.getProductBySlug).not.toHaveBeenCalled();
    expect(body.products).toEqual([]);
    expect(body.messages[0]).toMatchObject({
      type: "info",
      code: "partial_lookup",
    });
  });

  it("returns product not_found as a non-cacheable UCP application error", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });

    const response = await getCatalogProduct({
      request: request(
        { id: "missing-product" },
        { "UCP-Agent": 'profile="https://agent.example.test/.well-known/ucp"' },
        "/ucp/catalog/product",
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toMatchObject({
      ucp: { status: "error" },
      messages: [{ type: "error", code: "not_found" }],
    });
  });
});
