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

import { GET } from "../../pages/sitemap.xml";

describe("sitemap index route", () => {
  beforeEach(() => {
    mocks.getSitemapProducts.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue(
      "https://storefront.example.test",
    );
  });

  it("returns non-cacheable 503 when product count cannot be read", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns non-cacheable 503 instead of relative locs when the storefront URL is missing", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Sitemap index is temporarily unavailable");
    expect(mocks.getSitemapProducts).not.toHaveBeenCalled();
  });

  it("returns non-cacheable 503 when the storefront URL includes a path", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce(
      "https://storefront.example.test/base?x=1",
    );

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Sitemap index is temporarily unavailable");
    expect(mocks.getSitemapProducts).not.toHaveBeenCalled();
  });

  it("includes sitemap documents and excludes product feeds", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [{ slug: "hilsa", updatedAt: "2026-06-23T00:00:00.000Z" }],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<sitemapindex");
    expect(body).toContain(
      "https://storefront.example.test/sitemap-static.xml",
    );
    expect(body).toContain(
      "https://storefront.example.test/sitemap-categories.xml",
    );
    expect(body).toContain(
      "https://storefront.example.test/sitemap-collections.xml",
    );
    expect(body).toContain("https://storefront.example.test/sitemap-pages.xml");
    expect(body).toContain(
      "https://storefront.example.test/sitemap-articles.xml",
    );
    expect(body).toContain(
      "https://storefront.example.test/sitemap-products.xml?page=1",
    );
    expect(body).not.toContain("/api/facebook-feed.xml");
  });

  it("does not stamp sitemap index entries with render-time lastmod values", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [{ slug: "hilsa", updatedAt: "2026-06-23T00:00:00.000Z" }],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<sitemapindex");
    expect(body).not.toContain("<lastmod>");
  });
});
