// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllProducts: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/products", () => ({
  getAllProducts: mocks.getAllProducts,
}));

vi.mock("@/lib/api", () => ({
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap.xml";

describe("sitemap index route", () => {
  beforeEach(() => {
    mocks.getAllProducts.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({
      discovery: undefined,
    });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when product count cannot be read", async () => {
    mocks.getAllProducts.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("includes sitemap documents and excludes product feeds", async () => {
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [{ id: "prod_1" }],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<sitemapindex");
    expect(body).toContain("https://storefront.example.test/sitemap-static.xml");
    expect(body).toContain("https://storefront.example.test/sitemap-categories.xml");
    expect(body).toContain("https://storefront.example.test/sitemap-collections.xml");
    expect(body).toContain("https://storefront.example.test/sitemap-pages.xml");
    expect(body).toContain("https://storefront.example.test/sitemap-products.xml?page=1");
    expect(body).not.toContain("/api/facebook-feed.xml");
  });

  it("omits disabled sitemap sections without reading product counts", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        sitemap: {
          enabled: true,
          products: false,
          categories: false,
          collections: true,
          pages: false,
        },
      },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getAllProducts).not.toHaveBeenCalled();
    expect(body).toContain("https://storefront.example.test/sitemap-static.xml");
    expect(body).toContain("https://storefront.example.test/sitemap-collections.xml");
    expect(body).not.toContain("sitemap-products.xml");
    expect(body).not.toContain("sitemap-categories.xml");
    expect(body).not.toContain("sitemap-pages.xml");
  });
});
