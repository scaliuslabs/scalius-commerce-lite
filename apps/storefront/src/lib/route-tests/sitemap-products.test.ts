// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllProducts: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/products", () => ({
  getAllProducts: mocks.getAllProducts,
}));

vi.mock("@/lib/api", () => ({
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-products.xml";

function context(url = "https://storefront.example.test/sitemap-products.xml") {
  return { url: new URL(url) } as never;
}

describe("products sitemap route", () => {
  beforeEach(() => {
    mocks.getAllProducts.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when the first product page cannot be read", async () => {
    mocks.getAllProducts.mockResolvedValueOnce(null);

    const response = await GET(context());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("keeps legitimate empty catalogs as empty XML", async () => {
    mocks.getAllProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
  });

  it("returns empty XML without fetching products when product sitemap is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        sitemap: {
          enabled: true,
          products: false,
        },
      },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getAllProducts).not.toHaveBeenCalled();
    expect(body).toContain("<urlset");
    expect(body).not.toContain("/products/");
  });

  it("fails closed when a later sitemap product page cannot be read", async () => {
    mocks.getAllProducts
      .mockResolvedValueOnce({
        data: [
          {
            id: "prod_1",
            slug: "hilsa",
            updatedAt: "2026-06-23T00:00:00.000Z",
            isActive: true,
          },
        ],
        pagination: { page: 1, limit: 100, total: 101, totalPages: 2 },
      })
      .mockResolvedValueOnce(null);

    const response = await GET(context());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
