// @vitest-environment node
// Acceptance (e): the `pnpm release:check` UCP smoke itself, run against this
// storefront's own UCP routes (profile, llms.txt, REST and MCP), passes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getLayoutData: vi.fn(),
}));

vi.mock("@/lib/api/products", () => ({ getFeedProducts: mocks.getFeedProducts }));
vi.mock("@/lib/api/storefront", () => ({ getLayoutData: mocks.getLayoutData }));
vi.mock("@/lib/sitemap-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sitemap-utils")>("@/lib/sitemap-utils");
  return { ...actual, getBaseUrl: () => "https://storefront.example.test" };
});

import { checkUcpDiscovery, evaluateUcpProfile } from "../../../../../scripts/release-check.mjs";
import { GET as getProfile } from "../../pages/.well-known/ucp";
import { GET as getLlmsTxt } from "../../pages/llms.txt";
import { POST as restLookup } from "../../pages/ucp/catalog/lookup";
import { POST as restProduct } from "../../pages/ucp/catalog/product";
import { POST as restSearch } from "../../pages/ucp/catalog/search";
import { POST as mcpPost } from "../../pages/ucp/mcp";
import { buildUcpProfile } from "./catalog";
import { ucpFeedPage, ucpFeedProduct } from "./ucp-fixtures.testing";

const ORIGIN = "https://storefront.example.test";
type Handler = (context: { request: Request }) => Response | Promise<Response>;

const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
  "/.well-known/ucp": { GET: getProfile as unknown as Handler },
  "/llms.txt": { GET: getLlmsTxt as unknown as Handler },
  "/ucp/catalog/search": { POST: restSearch as unknown as Handler },
  "/ucp/catalog/lookup": { POST: restLookup as unknown as Handler },
  "/ucp/catalog/product": { POST: restProduct as unknown as Handler },
  "/ucp/mcp": { POST: mcpPost as unknown as Handler },
};

/** Serves the release check's requests from the storefront's own route handlers. */
async function storefrontFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const request = new Request(url, init);
  const handler = ROUTES[new URL(request.url).pathname]?.[request.method as "GET" | "POST"];
  if (!handler) throw new Error(`No storefront route for ${request.method} ${request.url}`);
  return handler({ request });
}

describe("release check UCP smoke against the storefront routes", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getLayoutData.mockResolvedValue({ currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 } });
    mocks.getFeedProducts.mockImplementation(async () => ucpFeedPage([ucpFeedProduct()]));
  });

  it("accepts the published profile", () => {
    expect(evaluateUcpProfile(buildUcpProfile(ORIGIN), { storefrontOrigin: ORIGIN })).toMatchObject({
      ok: true,
      errors: [],
      endpoint: `${ORIGIN}/ucp`,
      mcpEndpoint: `${ORIGIN}/ucp/mcp`,
    });
  });

  it("passes discovery, REST search/lookup/product and MCP tools and search parity", async () => {
    const result = await checkUcpDiscovery({ storefrontUrl: ORIGIN, timeoutMs: 5_000 }, {
      fetchImpl: storefrontFetch,
      productUrl: `${ORIGIN}/products/khaki-shoes`,
      logger: null,
    });

    expect(result.profile).toMatchObject({ version: "2026-08-25", mcpEndpoint: `${ORIGIN}/ucp/mcp` });
    expect(result.mcp).toMatchObject({
      tools: ["search_catalog", "lookup_catalog", "get_product"],
      search: { matchesRest: true, productCount: 1 },
    });
    expect(result.catalog).toMatchObject({
      search: { productCount: 1 },
      lookup: { inputId: "gid://scalius/product-variant/var_1", productCount: 1 },
      product: { firstVariantId: "gid://scalius/product-variant/var_1" },
    });
  });
});
