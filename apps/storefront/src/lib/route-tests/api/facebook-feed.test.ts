// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllProducts: vi.fn(),
  getLayoutData: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
  setRuntimeImageCdnPolicy: vi.fn(),
  getOptimizedImageUrl: vi.fn((url: string) => url),
}));

vi.mock("@/lib/api/products", () => ({
  getAllProducts: mocks.getAllProducts,
}));

vi.mock("@/lib/api", () => ({
  getLayoutData: mocks.getLayoutData,
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
  setRuntimeImageCdnPolicy: mocks.setRuntimeImageCdnPolicy,
}));

vi.mock("@/lib/image-optimizer", () => ({
  getOptimizedImageUrl: mocks.getOptimizedImageUrl,
}));

import { GET } from "../../../pages/api/facebook-feed.xml";

function context(url = "https://storefront.example.test/api/facebook-feed.xml") {
  return { url: new URL(url) } as never;
}

describe("Facebook product feed route", () => {
  beforeEach(() => {
    mocks.getAllProducts.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
    mocks.getLayoutData.mockResolvedValue({
      currency: { code: "BDT" },
      media: undefined,
    });
  });

  it("returns non-cacheable 503 when the first product page cannot be read", async () => {
    mocks.getAllProducts.mockResolvedValueOnce(null);

    const response = await GET(context());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("fails closed when the storefront base URL is not absolute", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("/relative-store");

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Facebook product feed is temporarily unavailable");
    expect(mocks.getAllProducts).not.toHaveBeenCalled();
  });

  it("keeps legitimate empty catalogs as empty XML", async () => {
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<rss");
  });

  it("uses buyer availability from the product list instead of product active status alone", async () => {
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_available",
          slug: "always-available",
          name: "Always Available",
          description: "Simple untracked SKU",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/available.jpg",
        },
        {
          id: "prod_sold_out",
          slug: "sold-out",
          name: "Sold Out",
          description: "Tracked SKU with no stock",
          price: 1400,
          discountedPrice: 1400,
          isActive: true,
          availableForSale: false,
          imageUrl: "https://cdn.example.test/products/sold-out.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<g:id>prod_available</g:id>");
    expect(body).toContain("<g:availability>in stock</g:availability>");
    expect(body).toContain("<g:id>prod_sold_out</g:id>");
    expect(body).toContain("<g:availability>out of stock</g:availability>");
  });

  it("skips image-less products and keeps required image and availability fields on valid items", async () => {
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_no_image",
          slug: "no-image",
          name: "No Image",
          description: "Missing primary image",
          price: 900,
          discountedPrice: 900,
          isActive: true,
          availableForSale: true,
          imageUrl: null,
        },
        {
          id: "prod_blank_image",
          slug: "blank-image",
          name: "Blank Image",
          description: "Blank primary image",
          price: 950,
          discountedPrice: 950,
          isActive: true,
          availableForSale: true,
          imageUrl: "   ",
        },
        {
          id: "prod_valid",
          slug: "valid-image",
          name: "Valid Image",
          description: "Has primary image",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: false,
          imageUrl: "https://cdn.example.test/products/valid.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 3, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<g:id>prod_no_image</g:id>");
    expect(body).not.toContain("<g:id>prod_blank_image</g:id>");
    expect(body).toContain("<g:id>prod_valid</g:id>");
    expect(body).toContain(
      "<g:image_link>https://cdn.example.test/products/valid.jpg</g:image_link>",
    );
    expect(body).toContain("<g:availability>out of stock</g:availability>");
    expect(body.match(/<item>/g)).toHaveLength(1);
  });

  it("emits absolute image links when the image optimizer returns a relative URL", async () => {
    mocks.getOptimizedImageUrl.mockReturnValueOnce(
      "/cdn-cgi/image/width=1200/products/valid.jpg",
    );
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_valid",
          slug: "valid-image",
          name: "Valid Image",
          description: "Has primary image",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "/products/valid.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<g:image_link>https://storefront.example.test/cdn-cgi/image/width=1200/products/valid.jpg</g:image_link>",
    );
  });

  it("skips products whose optimized image URL is not an http URL", async () => {
    mocks.getOptimizedImageUrl.mockReturnValueOnce(
      "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    );
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_data_image",
          slug: "data-image",
          name: "Data Image",
          description: "Invalid catalog image",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<item>");
    expect(body).not.toContain("<g:image_link>");
  });

  it("keeps page one as valid empty XML when every product is image-ineligible", async () => {
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_no_image",
          slug: "no-image",
          name: "No Image",
          description: "Missing primary image",
          price: 900,
          discountedPrice: 900,
          isActive: true,
          availableForSale: true,
          imageUrl: null,
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<rss");
    expect(body).not.toContain("<item>");
    expect(body).not.toContain("<g:image_link>");
  });

  it("returns a no-store 404 without fetching products when catalog feed is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        feeds: {
          productCatalogEnabled: false,
        },
      },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Product catalog feed is disabled");
    expect(mocks.getAllProducts).not.toHaveBeenCalled();
  });

  it("fails closed when a later feed product page cannot be read", async () => {
    mocks.getAllProducts
      .mockResolvedValueOnce({
        data: [
          {
            id: "prod_1",
            slug: "hilsa",
            name: "Hilsa",
            description: "Fresh hilsa",
            price: 1200,
            discountedPrice: 1200,
            isActive: true,
          },
        ],
        pagination: { page: 1, limit: 100, total: 101, totalPages: 2 },
      })
      .mockResolvedValueOnce(null);

    const response = await GET(
      context("https://storefront.example.test/api/facebook-feed.xml?limit=200"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns a non-cacheable 503 when feed generation throws unexpectedly", async () => {
    mocks.getLayoutData.mockRejectedValueOnce(new Error("layout unavailable"));

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Facebook product feed is temporarily unavailable");
  });
});
