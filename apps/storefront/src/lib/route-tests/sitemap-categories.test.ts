// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllCategories: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/categories", () => ({
  getAllCategories: mocks.getAllCategories,
}));

vi.mock("@/lib/api", () => ({
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-categories.xml";

describe("categories sitemap route", () => {
  beforeEach(() => {
    mocks.getAllCategories.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when categories cannot be read", async () => {
    mocks.getAllCategories.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("keeps legitimate empty category lists as empty XML", async () => {
    mocks.getAllCategories.mockResolvedValueOnce([]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
  });

  it("returns empty XML without fetching categories when category sitemap is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        sitemap: {
          enabled: true,
          categories: false,
        },
      },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getAllCategories).not.toHaveBeenCalled();
    expect(body).toContain("<urlset");
    expect(body).not.toContain("/categories/");
  });

  it("omits noindexed and sitemap-excluded categories", async () => {
    mocks.getAllCategories.mockResolvedValueOnce([
      {
        id: "cat_1",
        name: "Visible",
        slug: "visible",
        description: null,
        imageUrl: null,
        metaTitle: null,
        metaDescription: null,
        noIndex: false,
        excludeFromSitemap: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
      },
      {
        id: "cat_2",
        name: "Noindex",
        slug: "noindex",
        description: null,
        imageUrl: null,
        metaTitle: null,
        metaDescription: null,
        noIndex: true,
        excludeFromSitemap: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
      },
      {
        id: "cat_3",
        name: "Excluded",
        slug: "excluded",
        description: null,
        imageUrl: null,
        metaTitle: null,
        metaDescription: null,
        noIndex: false,
        excludeFromSitemap: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
      },
    ]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("/categories/visible");
    expect(body).not.toContain("/categories/noindex");
    expect(body).not.toContain("/categories/excluded");
  });
});
