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
});
