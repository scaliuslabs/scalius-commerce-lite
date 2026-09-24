// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
  getArticles: vi.fn(),
}));

vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));
vi.mock("@/lib/api/articles", () => ({ getArticles: mocks.getArticles }));

import { GET } from "../../pages/sitemap-static.xml";

const page = (count: number) => ({ data: Array.from({ length: count }, () => ({})), pagination: { totalPages: count } });

describe("static sitemap route", () => {
  beforeEach(() => {
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
    mocks.getArticles.mockResolvedValue(page(0));
  });

  it("emits the homepage and never internal search results", async () => {
    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<loc>https://storefront.example.test/</loc>");
    expect(body).not.toContain("/search");
    expect(body).not.toContain("/cart");
    expect(body).not.toContain("/blog");
  });

  it("lists the blog index once there is a post", async () => {
    mocks.getArticles.mockResolvedValue(page(1));
    const body = await (await GET({} as never)).text();
    expect(body).toContain("<loc>https://storefront.example.test/blog</loc>");
  });

  it("fails closed when posts can't be read", async () => {
    mocks.getArticles.mockResolvedValue(null);
    expect((await GET({} as never)).status).toBe(503);
  });
});
