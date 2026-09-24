// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-static.xml";

describe("static sitemap route", () => {
  beforeEach(() => {
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("emits the homepage as the only static URL", async () => {
    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("https://storefront.example.test/");
    // Internal search results are never advertised for indexing.
    expect(body).not.toContain("/search");
    expect(body).not.toContain("/cart");
  });
});
