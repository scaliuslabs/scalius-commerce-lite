// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSitemapCollections: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/collections", () => ({
  getSitemapCollections: mocks.getSitemapCollections,
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-collections.xml";

describe("collections sitemap route", () => {
  beforeEach(() => {
    mocks.getSitemapCollections.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when collections cannot be read", async () => {
    mocks.getSitemapCollections.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("emits the API's collection URLs with their own lastmod", async () => {
    // The API leaves out noIndex and sitemap-excluded collections.
    mocks.getSitemapCollections.mockResolvedValueOnce([
      { id: "collection one", canonicalPath: "/featured/summer", updatedAt: "2026-06-20T00:00:00.000Z" },
      { id: "col_two", canonicalPath: null, updatedAt: null },
    ]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
    expect(body).toContain("https://storefront.example.test/collections/collection%20one");
    expect(body).not.toContain("https://storefront.example.test/featured/summer");
    expect(body).toContain("<lastmod>2026-06-20T00:00:00.000Z</lastmod>");
    expect(body).toContain("https://storefront.example.test/collections/col_two");
  });
});
