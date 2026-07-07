// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api", () => ({
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/robots.txt";

describe("robots.txt route", () => {
  beforeEach(() => {
    mocks.getSeoSettings.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when SEO settings cannot be read", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("returns non-cacheable 503 instead of a relative sitemap when the storefront URL is missing", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt: "User-agent: *\nAllow: /",
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Robots policy is temporarily unavailable");
  });

  it("returns non-cacheable 503 when the storefront URL is not an origin", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("https://storefront.example.test/base?x=1");
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt: "User-agent: *\nAllow: /",
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Robots policy is temporarily unavailable");
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

  it("replaces invalid custom sitemap directives with the canonical sitemap", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt:
        "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\nSitemap: javascript:alert(1)",
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Sitemap: https://storefront.example.test/sitemap.xml");
    expect(body).not.toContain("Sitemap: /sitemap.xml");
    expect(body).not.toContain("javascript:");
  });

  it("does not advertise sitemap when the discovery policy disables it", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt: "User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]",
      discovery: {
        sitemap: { enabled: true },
        robots: { advertiseSitemap: false },
      },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("User-agent: *");
    expect(body).not.toContain("Sitemap:");
    expect(body).not.toContain("[your-sitemap-url]");
  });

  it("strips sitemap directives when sitemap advertising is off", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt:
        "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\nSitemap: https://old.example.com/sitemap.xml",
      discovery: {
        sitemap: { enabled: true },
        robots: { advertiseSitemap: false },
      },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("Sitemap: /sitemap.xml");
    expect(body).not.toContain("Sitemap:");
  });

  it("replaces off-origin sitemap directives with the canonical storefront sitemap", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt:
        "User-agent: *\nAllow: /\nSitemap: https://old.example.com/sitemap.xml",
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Sitemap: https://storefront.example.test/sitemap.xml");
    expect(body).not.toContain("https://old.example.com/sitemap.xml");
  });

  it("replaces same-origin non-canonical sitemap directives with the canonical storefront sitemap", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt:
        "User-agent: *\nAllow: /\nSitemap: https://storefront.example.test/old-sitemap.xml",
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Sitemap: https://storefront.example.test/sitemap.xml");
    expect(body).not.toContain("old-sitemap.xml");
  });

  it("normalizes canonical-equivalent sitemap directives to one exact canonical line", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      siteTitle: "Store",
      homepageTitle: "Home",
      homepageMetaDescription: "Description",
      robotsTxt:
        "User-agent: *\nAllow: /\nSitemap: https://storefront.example.test:443/sitemap.xml",
    });

    const response = await GET({} as never);
    const body = await response.text();
    const sitemapLines = body
      .split(/\r?\n/)
      .filter((line) => /^Sitemap:/i.test(line));

    expect(response.status).toBe(200);
    expect(sitemapLines).toEqual([
      "Sitemap: https://storefront.example.test/sitemap.xml",
    ]);
  });
});
