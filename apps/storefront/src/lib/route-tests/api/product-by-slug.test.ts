import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProductBySlug: vi.fn(),
  loadPageWithLayout: vi.fn(),
  withOptimizedProductPageImages: vi.fn((product: unknown) => product),
}));

vi.mock("@/lib/api", () => ({
  getProductBySlug: mocks.getProductBySlug,
}));

vi.mock("@/lib/page-data", () => ({
  loadPageWithLayout: mocks.loadPageWithLayout,
}));

vi.mock("@/lib/serialized-media", () => ({
  withOptimizedProductPageImages: mocks.withOptimizedProductPageImages,
}));

import { GET } from "../../../pages/api/products/[slug]";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProductBySlug.mockResolvedValue({ id: "prod_1", slug: "fish" });
  mocks.loadPageWithLayout.mockImplementation(async (load: () => unknown) => ({
    pageData: await load(),
  }));
});

describe("product-by-slug storefront API", () => {
  it("requires browser revalidation for mutation-sensitive product JSON", async () => {
    const response = await GET({ params: { slug: "fish" } } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(response.headers.get("Cache-Control")).not.toContain(
      "stale-while-revalidate",
    );
    expect(response.headers.get("Cache-Control")).not.toContain(
      "stale-if-error",
    );
    expect(mocks.getProductBySlug).toHaveBeenCalledWith("fish", false);
  });
});
