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

import { GET } from "../../pages/sitemap-static.xml";

describe("static sitemap route", () => {
  beforeEach(() => {
    mocks.getSeoSettings.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("emits static crawlable URLs by default", async () => {
    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("https://storefront.example.test/");
    expect(body).toContain("https://storefront.example.test/search");
  });

  it("returns empty XML when sitemap generation is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        sitemap: {
          enabled: false,
        },
      },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<urlset");
    expect(body).not.toContain("https://storefront.example.test/search");
  });

  it("returns empty XML when the static sitemap section is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        sitemap: {
          enabled: true,
          staticPages: false,
        },
      },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<urlset");
    expect(body).not.toContain("<loc>https://storefront.example.test/</loc>");
    expect(body).not.toContain(
      "<loc>https://storefront.example.test/search</loc>",
    );
  });
});
