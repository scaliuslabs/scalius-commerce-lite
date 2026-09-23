// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllCollections: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/collections", () => ({
  getAllCollections: mocks.getAllCollections,
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-collections.xml";

describe("collections sitemap route", () => {
  beforeEach(() => {
    mocks.getAllCollections.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when collections cannot be read", async () => {
    mocks.getAllCollections.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("emits active collection URLs", async () => {
    mocks.getAllCollections.mockResolvedValueOnce([
      {
        id: "collection one",
        name: "Summer",
        presentation: "grid",
        config: {},
        sortOrder: 1,
        isActive: true,
        canonicalPath: "/featured/summer",
        noIndex: false,
        excludeFromSitemap: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        deletedAt: null,
      },
    ]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
    expect(body).toContain("https://storefront.example.test/collections/collection%20one");
    expect(body).not.toContain("https://storefront.example.test/featured/summer");
    expect(body).toContain("<lastmod>2026-06-20T00:00:00.000Z</lastmod>");
  });

  it("omits noindexed and sitemap-excluded collections", async () => {
    mocks.getAllCollections.mockResolvedValueOnce([
      {
        id: "visible",
        name: "Visible",
        presentation: "grid",
        config: {},
        sortOrder: 1,
        isActive: true,
        noIndex: false,
        excludeFromSitemap: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
        deletedAt: null,
      },
      {
        id: "noindex",
        name: "Noindex",
        presentation: "grid",
        config: {},
        sortOrder: 2,
        isActive: true,
        noIndex: true,
        excludeFromSitemap: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
        deletedAt: null,
      },
      {
        id: "excluded",
        name: "Excluded",
        presentation: "grid",
        config: {},
        sortOrder: 3,
        isActive: true,
        noIndex: false,
        excludeFromSitemap: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
        deletedAt: null,
      },
    ]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("/collections/visible");
    expect(body).not.toContain("/collections/noindex");
    expect(body).not.toContain("/collections/excluded");
  });
});
