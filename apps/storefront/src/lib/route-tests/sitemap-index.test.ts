// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllProducts: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/products", () => ({
  getAllProducts: mocks.getAllProducts,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap.xml";

describe("sitemap index route", () => {
  beforeEach(() => {
    mocks.getAllProducts.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when product count cannot be read", async () => {
    mocks.getAllProducts.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
