// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/robots.txt";

function sitemapLines(body: string): string[] {
  return body.split(/\r?\n/).filter((line) => /^sitemap\s*:/i.test(line));
}

describe("robots.txt route", () => {
  beforeEach(() => {
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("allows crawling and advertises exactly one canonical sitemap for a valid Store URL", async () => {
    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(body.startsWith("User-agent: *\n")).toBe(true);
    expect(body).toContain("\nAllow: /\n");
    expect(sitemapLines(body)).toEqual([
      "Sitemap: https://storefront.example.test/sitemap.xml",
    ]);
  });

  it.each([
    ["missing", ""],
    ["not an origin", "https://storefront.example.test/base?x=1"],
    ["relative", "/store"],
  ])("omits the Sitemap line when the Store URL is %s", async (_label, storefrontUrl) => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce(storefrontUrl);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.endsWith("Allow: /")).toBe(true);
    expect(sitemapLines(body)).toEqual([]);
  });

  it("keeps crawlers off private pages, internal search and sort/filter variants only", async () => {
    const disallowed = (await (await GET({} as never)).text())
      .split("\n")
      .filter((line) => line.startsWith("Disallow: "))
      .map((line) => line.slice("Disallow: ".length));

    expect(disallowed).toEqual(expect.arrayContaining([
      "/cart$", "/checkout$", "/checkout/", "/account$", "/account/",
      "/order-success", "/search", "/*?*sortBy=", "/*?*minPrice=",
    ]));
    // Catalog, content, paginated listings and the feeds stay crawlable.
    for (const path of disallowed) {
      expect(["/products/", "/categories/", "/collections/", "/blog", "/api/product-feed.xml", "/*?*page="])
        .not.toContain(path);
    }
  });
});
