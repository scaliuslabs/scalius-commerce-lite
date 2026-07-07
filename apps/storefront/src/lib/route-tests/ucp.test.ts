// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getProductBySlug: vi.fn(),
  getLayoutData: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
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
}));

import { GET as getProfile } from "../../pages/.well-known/ucp";
import { POST as searchCatalog } from "../../pages/ucp/catalog/search";

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("https://storefront.example.test/ucp/catalog/search", {
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
});
