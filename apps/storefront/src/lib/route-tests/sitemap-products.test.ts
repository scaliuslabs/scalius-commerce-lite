// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSitemapProducts: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/products", () => ({
  getSitemapProducts: mocks.getSitemapProducts,
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-products.xml";

function context(url = "https://storefront.example.test/sitemap-products.xml") {
  return { url: new URL(url) } as never;
}

describe("products sitemap route", () => {
  beforeEach(() => {
    mocks.getSitemapProducts.mockReset();
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
    expect(body).toContain("<loc>https://storefront.example.test/products/hilsa</loc>");
    expect(body).not.toContain("<loc>https://storefront.example.test/fish/hilsa</loc>");
    expect(body).toContain("<lastmod>2026-06-23T00:00:00.000Z</lastmod>");
    expect(body).not.toContain("<priority>");
    expect(body).not.toContain("<changefreq>");
  });

  it("reads each 5000-URL chunk with one API read at the chunk's own page", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [{ slug: "hilsa", updatedAt: "2026-06-23T00:00:00.000Z" }],
      pagination: { page: 3, limit: 5000, total: 10_001, totalPages: 3 },
    });

    const response = await GET(context("https://storefront.example.test/sitemap-products.xml?page=3"));

    expect(response.status).toBe(200);
    expect(mocks.getSitemapProducts).toHaveBeenCalledTimes(1);
    expect(mocks.getSitemapProducts).toHaveBeenCalledWith({ page: 3, limit: 5000 });
  });

  it("answers 404 past the last chunk", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 9, limit: 5000, total: 10_001, totalPages: 3 },
    });

    const response = await GET(context("https://storefront.example.test/sitemap-products.xml?page=9"));

    expect(response.status).toBe(404);
  });
});
