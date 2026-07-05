// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllPages: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/pages", () => ({
  getAllPages: mocks.getAllPages,
}));

vi.mock("@/lib/api", () => ({
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-pages.xml";

describe("pages sitemap route", () => {
  beforeEach(() => {
    mocks.getAllPages.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when the first CMS page batch cannot be read", async () => {
    mocks.getAllPages.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("keeps legitimate empty CMS page lists as empty XML", async () => {
    mocks.getAllPages.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
  });

  it("returns empty XML without fetching pages when page sitemap is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        sitemap: {
          enabled: true,
          pages: false,
        },
      },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getAllPages).not.toHaveBeenCalled();
    expect(body).toContain("<urlset");
  });

  it("formats CMS page Unix-second timestamps as real lastmod dates", async () => {
    mocks.getAllPages.mockResolvedValueOnce({
      data: [
        {
          id: "page_1",
          slug: "about-us",
          title: "About us",
          isPublished: true,
          updatedAt: 1782691200,
          publishedAt: null,
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<lastmod>2026-06-29T00:00:00.000Z</lastmod>");
    expect(body).not.toContain("1970");
  });

  it("returns non-cacheable 503 instead of relative page locs when the storefront URL is missing", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Pages sitemap is temporarily unavailable");
    expect(mocks.getAllPages).not.toHaveBeenCalled();
  });

  it("fails closed when a later CMS page batch cannot be read", async () => {
    mocks.getAllPages
      .mockResolvedValueOnce({
        data: [
          {
            id: "page_1",
            slug: "about-us",
            title: "About us",
            isPublished: true,
            updatedAt: "2026-06-23T00:00:00.000Z",
            publishedAt: null,
          },
        ],
        pagination: { page: 1, limit: 100, total: 101, totalPages: 2 },
      })
      .mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
