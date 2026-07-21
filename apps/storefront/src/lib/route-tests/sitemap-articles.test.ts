// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArticles: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/articles", () => ({ getArticles: mocks.getArticles }));
vi.mock("@/lib/api", () => ({ getSeoSettings: mocks.getSeoSettings }));
vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-articles.xml";

describe("articles sitemap route", () => {
  beforeEach(() => {
    mocks.getArticles.mockReset();
    mocks.getSeoSettings
      .mockReset()
      .mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue(
      "https://storefront.example.test",
    );
  });

  it("emits canonical article URLs and truthful lastmod values", async () => {
    mocks.getArticles.mockResolvedValueOnce({
      data: [
        {
          slug: "shoe-fit-guide",
          canonicalPath: "/blog/running-shoe-fit",
          noIndex: false,
          excludeFromSitemap: false,
          updatedAt: 1782691200,
          publishedAt: 1782604800,
        },
      ],
      pagination: { page: 1, limit: 24, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<loc>https://storefront.example.test/blog/running-shoe-fit</loc>",
    );
    expect(body).toContain("<lastmod>2026-06-29T00:00:00.000Z</lastmod>");
  });

  it("omits noindexed and explicitly excluded articles", async () => {
    mocks.getArticles.mockResolvedValueOnce({
      data: [
        {
          slug: "noindex",
          noIndex: true,
          excludeFromSitemap: false,
          updatedAt: 1782691200,
        },
        {
          slug: "excluded",
          noIndex: false,
          excludeFromSitemap: true,
          updatedAt: 1782691200,
        },
      ],
      pagination: { page: 1, limit: 24, total: 2, totalPages: 1 },
    });

    const body = await (await GET({} as never)).text();
    expect(body).not.toContain("/blog/noindex");
    expect(body).not.toContain("/blog/excluded");
  });

  it("fails closed when a page of article data is unavailable", async () => {
    mocks.getArticles.mockResolvedValueOnce(null);
    const response = await GET({} as never);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("does not fetch article data when article discovery is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: { sitemap: { enabled: true, articles: false } },
    });
    const response = await GET({} as never);
    expect(response.status).toBe(200);
    expect(mocks.getArticles).not.toHaveBeenCalled();
  });
});
