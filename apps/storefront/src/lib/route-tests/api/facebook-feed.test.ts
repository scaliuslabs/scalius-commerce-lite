// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllProducts: vi.fn(),
  getLayoutData: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
  setRuntimeImageCdnPolicy: vi.fn(),
  getOptimizedImageUrl: vi.fn((url: string) => url),
}));

vi.mock("@/lib/api/products", () => ({
  getAllProducts: mocks.getAllProducts,
}));

vi.mock("@/lib/api", () => ({
  getLayoutData: mocks.getLayoutData,
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
  setRuntimeImageCdnPolicy: mocks.setRuntimeImageCdnPolicy,
}));

vi.mock("@/lib/image-optimizer", () => ({
  getOptimizedImageUrl: mocks.getOptimizedImageUrl,
}));

import { GET } from "../../../pages/api/facebook-feed.xml";

function context(url = "https://storefront.example.test/api/facebook-feed.xml") {
  return { url: new URL(url) } as never;
}

describe("Facebook product feed route", () => {
  beforeEach(() => {
    mocks.getAllProducts.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
    mocks.getLayoutData.mockResolvedValue({
      currency: { code: "BDT" },
      media: undefined,
    });
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
    expect(body).toContain("<rss");
  });

  it("returns a no-store 404 without fetching products when catalog feed is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        feeds: {
          productCatalogEnabled: false,
        },
      },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Product catalog feed is disabled");
    expect(mocks.getAllProducts).not.toHaveBeenCalled();
  });

  it("fails closed when a later feed product page cannot be read", async () => {
    mocks.getAllProducts
      .mockResolvedValueOnce({
        data: [
          {
            id: "prod_1",
            slug: "hilsa",
            name: "Hilsa",
            description: "Fresh hilsa",
            price: 1200,
            discountedPrice: 1200,
            isActive: true,
          },
        ],
        pagination: { page: 1, limit: 100, total: 101, totalPages: 2 },
      })
      .mockResolvedValueOnce(null);

    const response = await GET(
      context("https://storefront.example.test/api/facebook-feed.xml?limit=200"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
