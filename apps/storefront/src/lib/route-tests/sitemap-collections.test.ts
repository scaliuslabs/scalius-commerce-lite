// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllCollections: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/collections", () => ({
  getAllCollections: mocks.getAllCollections,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/sitemap-collections.xml";

describe("collections sitemap route", () => {
  beforeEach(() => {
    mocks.getAllCollections.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
  });

  it("returns non-cacheable 503 when collections cannot be read", async () => {
    mocks.getAllCollections.mockResolvedValueOnce(null);

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("emits active collection URLs", async () => {
    mocks.getAllCollections.mockResolvedValueOnce([
      {
        id: "collection one",
        name: "Summer",
        type: "manual",
        config: {},
        sortOrder: 1,
        isActive: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        deletedAt: null,
      },
    ]);

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<urlset");
    expect(body).toContain("https://storefront.example.test/collections/collection%20one");
    expect(body).toContain("<lastmod>2026-06-20T00:00:00.000Z</lastmod>");
  });
});
