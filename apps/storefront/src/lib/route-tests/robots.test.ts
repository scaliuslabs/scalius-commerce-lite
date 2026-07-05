// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSeoSettings: vi.fn(),
  cfEnv: { STOREFRONT_URL: "https://storefront.example.test" },
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

vi.mock("@/lib/api", () => ({
  getSeoSettings: mocks.getSeoSettings,
}));

import { GET } from "../../pages/robots.txt";

describe("robots.txt route", () => {
  beforeEach(() => {
    mocks.getSeoSettings.mockReset();
    mocks.cfEnv.STOREFRONT_URL = "https://storefront.example.test";
  });

  it("returns non-cacheable 503 when SEO settings cannot be read", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("appends the sitemap URL to the configured robots policy", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt: "User-agent: *\nAllow: /",
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Sitemap: https://storefront.example.test/sitemap.xml");
  });

  it("replaces placeholder sitemap directives with the real sitemap URL", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt: "User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]",
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Sitemap: https://storefront.example.test/sitemap.xml");
    expect(body).not.toContain("[your-sitemap-url]");
  });
});
