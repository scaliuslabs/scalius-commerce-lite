// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getProductBySlug: vi.fn(),
  getLayoutData: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
  setRuntimeImageCdnPolicy: vi.fn(),
}));

vi.mock("@/lib/api/products", () => ({
  getFeedProducts: mocks.getFeedProducts,
  getProductBySlug: mocks.getProductBySlug,
}));

vi.mock("@/lib/api/storefront", () => ({
  getLayoutData: mocks.getLayoutData,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
  setRuntimeImageCdnPolicy: mocks.setRuntimeImageCdnPolicy,
}));

import { GET as getProfile } from "../../pages/.well-known/ucp";
import { POST as getCatalogProduct } from "../../pages/ucp/catalog/product";
import { POST as searchCatalog } from "../../pages/ucp/catalog/search";

function request(body: unknown, headers: HeadersInit = {}, path = "/ucp/catalog/search") {
  return new Request(`https://storefront.example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("UCP storefront routes", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
    mocks.getProductBySlug.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
    mocks.setRuntimeImageCdnPolicy.mockReset();
    mocks.getLayoutData.mockResolvedValue({
      currency: { code: "BDT", decimalPlaces: 2 },
    });
  });

  it("publishes a cacheable read-only catalog profile", async () => {
    const response = await getProfile({} as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("max-age=300");
    expect(body.ucp.services["dev.ucp.shopping"][0].endpoint).toBe(
      "https://storefront.example.test/ucp",
    );
    expect(Object.keys(body.ucp.capabilities)).toEqual([
      "dev.ucp.shopping.catalog.search",
      "dev.ucp.shopping.catalog.lookup",
    ]);
  });

  it("fails closed when the storefront URL cannot form an HTTPS profile origin", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");

    const response = await getProfile({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("UCP profile is temporarily unavailable");
  });

  it("fails closed instead of publishing a non-HTTPS UCP profile", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("http://storefront.example.test");

    const response = await getProfile({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("requires UCP-Agent on catalog operations", async () => {
    const response = await searchCatalog({
      request: request({ query: "shoe" }),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.messages[0].code).toBe("invalid_profile_url");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("rejects malformed UCP-Agent headers before catalog work", async () => {
    const response = await searchCatalog({
      request: request(
        { query: "shoe" },
        { "UCP-Agent": 'profile="http://agent.example.test/.well-known/ucp"' },
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.messages[0].code).toBe("invalid_profile_url");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("rejects unsupported UCP versions before catalog work", async () => {
    const response = await searchCatalog({
      request: request(
        { ucp: { version: "2026-07" }, query: "shoe" },
        { "UCP-Agent": 'profile="https://agent.example.test/.well-known/ucp"' },
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.messages[0].code).toBe("version_unsupported");
    expect(body.messages[0].path).toBe("$.ucp.version");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("returns product not_found as a non-cacheable UCP application error", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });

    const response = await getCatalogProduct({
      request: request(
        { id: "missing-product" },
        { "UCP-Agent": 'profile="https://agent.example.test/.well-known/ucp"' },
        "/ucp/catalog/product",
      ),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toMatchObject({
      ucp: { status: "error" },
      messages: [{ type: "error", code: "not_found" }],
    });
  });
});
