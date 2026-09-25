// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSitemapCategories: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/categories", () => ({
  getSitemapCategories: mocks.getSitemapCategories,
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-categories.xml";

describe("categories sitemap route", () => {
  beforeEach(() => {
    mocks.getSitemapCategories.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when categories cannot be read", async () => {
    mocks.getSitemapCategories.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("keeps legitimate empty category lists as empty XML", async () => {
    mocks.getSitemapCategories.mockResolvedValueOnce([]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
  });

  it("lists the API's sitemap entries with route-shaped canonicals and their own lastmod", async () => {
    // The API leaves out noIndex and sitemap-excluded categories.
    mocks.getSitemapCategories.mockResolvedValueOnce([
      { slug: "visible", canonicalPath: "/shop/visible-category", updatedAt: "2026-06-02T00:00:00.000Z" },
      { slug: "renamed", canonicalPath: "/categories/new-name", updatedAt: null },
    ]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("https://storefront.example.test/categories/visible");
    expect(body).not.toContain("/shop/visible-category");
    expect(body).toContain("<lastmod>2026-06-02T00:00:00.000Z</lastmod>");
    expect(body).toContain("https://storefront.example.test/categories/new-name");
    expect(body).not.toContain("/categories/renamed");
  });
});
