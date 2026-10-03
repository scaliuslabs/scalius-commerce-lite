// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLayoutData: vi.fn(async () => null as unknown),
  getSitemapProducts: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

const runtimePresence = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("@/lib/api/products", () => ({
  getSitemapProducts: mocks.getSitemapProducts,
}));

vi.mock("@/lib/api/storefront", () => ({
  getLayoutData: mocks.getLayoutData,
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimePresence: () => runtimePresence.value,
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap.xml";

describe("sitemap index route", () => {
  beforeEach(() => {
    runtimePresence.value = null;
    mocks.getLayoutData.mockReset();
    mocks.getLayoutData.mockResolvedValue(null);
    mocks.getSitemapProducts.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue(
      "https://storefront.example.test",
    );
  });

  it("returns non-cacheable 503 when product count cannot be read", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns non-cacheable 503 instead of relative locs when the storefront URL is missing", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Sitemap index is temporarily unavailable");
    expect(mocks.getSitemapProducts).not.toHaveBeenCalled();
  });

  it("returns non-cacheable 503 when the storefront URL includes a path", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce(
      "https://storefront.example.test/base?x=1",
    );

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Sitemap index is temporarily unavailable");
    expect(mocks.getSitemapProducts).not.toHaveBeenCalled();
  });

  it("includes sitemap documents and excludes product feeds", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [{ slug: "hilsa", updatedAt: "2026-06-23T00:00:00.000Z" }],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<sitemapindex");
    expect(body).toContain(
      "https://storefront.example.test/sitemap-static.xml",
    );
    expect(body).toContain(
      "https://storefront.example.test/sitemap-categories.xml",
    );
    expect(body).toContain(
      "https://storefront.example.test/sitemap-brands.xml",
    );
    expect(body).toContain(
      "https://storefront.example.test/sitemap-collections.xml",
    );
    expect(body).toContain("https://storefront.example.test/sitemap-pages.xml");
    expect(body).toContain(
      "https://storefront.example.test/sitemap-articles.xml",
    );
    expect(body).toContain(
      "https://storefront.example.test/sitemap-products.xml?page=1",
    );
    expect(body).not.toContain("/api/facebook-feed.xml");
  });

  it("does not stamp sitemap index entries with render-time lastmod values", async () => {
    mocks.getSitemapProducts.mockResolvedValueOnce({
      data: [{ slug: "hilsa", updatedAt: "2026-06-23T00:00:00.000Z" }],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<sitemapindex");
    expect(body).not.toContain("<lastmod>");
  });

  const MATRIX = { markets: [
    { id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "bn" }] },
    { id: "mkt_in", handle: "india", name: "India", isBackup: false, countries: ["IN"], presences: [{ value: "en-in", locale: "en" }] },
  ] };
  const products = { data: [], pagination: { page: 1, limit: 1, total: 7_500, totalPages: 7_500 } };
  const locs = (body: string) => [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

  it("lists every active presence's own sitemaps at the root, absolute and prefixed", async () => {
    mocks.getLayoutData.mockResolvedValueOnce({ markets: MATRIX });
    mocks.getSitemapProducts.mockResolvedValueOnce(products);
    const body = await (await GET({} as never)).text();
    const all = locs(body);
    expect(all).toHaveLength(16);
    expect(all.slice(0, 8)).toEqual([
      "https://storefront.example.test/sitemap-static.xml",
      "https://storefront.example.test/sitemap-categories.xml",
      "https://storefront.example.test/sitemap-brands.xml",
      "https://storefront.example.test/sitemap-collections.xml",
      "https://storefront.example.test/sitemap-pages.xml",
      "https://storefront.example.test/sitemap-articles.xml",
      "https://storefront.example.test/sitemap-products.xml?page=1",
      "https://storefront.example.test/sitemap-products.xml?page=2",
    ]);
    expect(all.slice(8)).toEqual(all.slice(0, 8).map((loc) => loc!.replace("example.test/", "example.test/en-in/")));
  });

  it("lists only the root's sitemaps while the store has one presence", async () => {
    mocks.getLayoutData.mockResolvedValueOnce({ markets: { markets: [MATRIX.markets[0]] } });
    mocks.getSitemapProducts.mockResolvedValueOnce(products);
    const all = locs(await (await GET({} as never)).text());
    expect(all).toHaveLength(8);
    expect(all.every((loc) => !loc!.includes("/en-in/"))).toBe(true);
  });

  it("lists a presence's own sitemaps from its own index", async () => {
    runtimePresence.value = "en-in";
    mocks.getSitemapProducts.mockResolvedValueOnce(products);
    const all = locs(await (await GET({} as never)).text());
    expect(all).toHaveLength(8);
    expect(all.every((loc) => loc!.startsWith("https://storefront.example.test/en-in/sitemap-"))).toBe(true);
    expect(mocks.getLayoutData).not.toHaveBeenCalled();
  });
});
