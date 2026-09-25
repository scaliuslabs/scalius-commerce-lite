// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSitemapBrands: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/brands", () => ({
  getSitemapBrands: mocks.getSitemapBrands,
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-brands.xml";

describe("brands sitemap route", () => {
  beforeEach(() => {
    mocks.getSitemapBrands.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when brands cannot be read", async () => {
    mocks.getSitemapBrands.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns non-cacheable 503 instead of relative locs when the storefront URL is missing", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");
    mocks.getSitemapBrands.mockResolvedValueOnce([{ slug: "walton", canonicalPath: null, updatedAt: null }]);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("<loc>/brands/walton</loc>");
  });

  it("keeps an empty brand list as empty XML", async () => {
    mocks.getSitemapBrands.mockResolvedValueOnce([]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
    expect(body).not.toContain("<loc>");
  });

  it("emits absolute brand locs, honours a valid canonical path and ignores an invalid one", async () => {
    mocks.getSitemapBrands.mockResolvedValueOnce([
      { slug: "walton", canonicalPath: "/brands/walton-bd", updatedAt: "2026-09-01T00:00:00.000Z" },
      { slug: "hp", canonicalPath: "/shop/hp", updatedAt: null },
    ]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<loc>https://storefront.example.test/brands/walton-bd</loc>");
    expect(body).toContain("<lastmod>2026-09-01");
    expect(body).toContain("<loc>https://storefront.example.test/brands/hp</loc>");
    expect(body).not.toContain("/shop/hp");
    expect(body).not.toContain("<priority>");
    expect(body).not.toContain("<changefreq>");
  });
});
