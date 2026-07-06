// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSitemapProducts: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/products", () => ({
  getSitemapProducts: mocks.getSitemapProducts,
}));

vi.mock("@/lib/api", () => ({
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-products.xml";

function context(url = "https://storefront.example.test/sitemap-products.xml") {
  return { url: new URL(url) } as never;
}

describe("products sitemap route", () => {
  beforeEach(() => {
    mocks.getSitemapProducts.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when the first product page cannot be read", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce(null);

    const response = await GET(context());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("keeps legitimate empty catalogs as empty XML", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
  });

  it("returns empty XML without fetching products when product sitemap is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        sitemap: {
          enabled: true,
          products: false,
        },
      },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getSitemapProducts).not.toHaveBeenCalled();
    expect(body).toContain("<urlset");
    expect(body).not.toContain("/products/");
  });

  it("rejects malformed page query parameters", async () => {
    const badSuffix = await GET(
      context("https://storefront.example.test/sitemap-products.xml?page=2abc"),
    );
    const leadingZero = await GET(
      context("https://storefront.example.test/sitemap-products.xml?page=05"),
    );

    expect(badSuffix.status).toBe(400);
    await expect(badSuffix.text()).resolves.toContain("Invalid page parameter");
    expect(leadingZero.status).toBe(400);
    await expect(leadingZero.text()).resolves.toContain(
      "Invalid page parameter",
    );
    expect(mocks.getSitemapProducts).not.toHaveBeenCalled();
  });

  it("emits product loc and lastmod without ignored priority or changefreq tags", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [
        {
          slug: "hilsa",
          canonicalPath: "/fish/hilsa",
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<loc>https://storefront.example.test/fish/hilsa</loc>");
    expect(body).not.toContain("<loc>https://storefront.example.test/products/hilsa</loc>");
    expect(body).toContain("<lastmod>2026-06-23T00:00:00.000Z</lastmod>");
    expect(body).not.toContain("<priority>");
    expect(body).not.toContain("<changefreq>");
  });

  it("fails closed when a later sitemap product page cannot be read", async () => {
    mocks.getSitemapProducts
      .mockResolvedValueOnce({
        data: [
          {
            slug: "hilsa",
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        ],
        pagination: { page: 1, limit: 100, total: 101, totalPages: 2 },
      })
      .mockResolvedValueOnce(null);

    const response = await GET(context());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
