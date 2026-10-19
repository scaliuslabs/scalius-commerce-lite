// @vitest-environment node
// Acceptance (a): every document this storefront publishes or answers with
// validates against the vendored, published UCP 2026-08-25 schemas.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getLayoutData: vi.fn(),
}));

vi.mock("@/lib/api/products", () => ({ getFeedProducts: mocks.getFeedProducts }));
vi.mock("@/lib/api/storefront", () => ({ getLayoutData: mocks.getLayoutData }));

import { buildUcpProfile, getCatalogProduct, lookupCatalog, searchCatalog, UCP_VERSION } from "./catalog";
import { UCP_SCHEMA_SOURCE, ucpSchemaErrors } from "./ucp-schema.testing";
import { ucpFeedPage, ucpFeedProduct, ucpTestContext, UCP_TEST_BASE_URL } from "./ucp-fixtures.testing";
import { buildUcpPolicies, buildUcpSeller } from "./merchant";

const policies = buildUcpPolicies(
  { enabled: true, category: "finite", returnWindowDays: 14, returnFees: "free", policyUrl: "/pages/returns" },
  UCP_TEST_BASE_URL,
  "BD",
);
const richContext = ucpTestContext({
  policies,
  seller: buildUcpSeller({ companyName: "Khaki House" }, policies),
  messages: [{ type: "warning", code: "currency_unavailable", content: "Prices are in BDT." }],
});

function ratedProduct() {
  return ucpFeedProduct({ rating: { average: 4.25, count: 12 } });
}

describe("UCP 2026-08-25 schema conformance", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
  });

  it("vendors the published 2026-08-25 schemas with their source", () => {
    expect(UCP_SCHEMA_SOURCE.version).toBe(UCP_VERSION);
    expect(UCP_SCHEMA_SOURCE.source).toBe(`https://ucp.dev/${UCP_VERSION}/schemas/`);
    expect(UCP_SCHEMA_SOURCE.files).toContain("profile.json");
  });

  it("publishes a business profile that validates", () => {
    expect(ucpSchemaErrors("profile.json#/$defs/business_schema", buildUcpProfile(UCP_TEST_BASE_URL))).toEqual([]);
  });

  it("rejects a profile without the payment handler registry (the 2026-04-08 shape)", () => {
    const profile = buildUcpProfile(UCP_TEST_BASE_URL) as { ucp: Record<string, unknown> };
    delete profile.ucp.payment_handlers;
    expect(ucpSchemaErrors("profile.json#/$defs/business_schema", profile)).not.toEqual([]);
  });

  it("answers search with a valid search response, rating, seller and policy included", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce(ucpFeedPage([ratedProduct()]));
    const result = await searchCatalog({ query: "khaki" }, richContext);

    expect(result.body.products[0]?.rating).toEqual({ value: 4.25, scale_min: 1, scale_max: 5, count: 12 });
    expect(result.body.products[0]?.variants[0]?.seller).toEqual({
      name: "Khaki House",
      links: [{ type: "refund_policy", url: `${UCP_TEST_BASE_URL}/pages/returns` }],
    });
    expect(result.body.policies).toHaveLength(1);
    expect(ucpSchemaErrors("shopping/catalog_search.json#/$defs/search_response", result.body)).toEqual([]);
  });

  it("answers batch lookup with a valid lookup response, not_found messages included", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce(ucpFeedPage([ratedProduct()]));
    const result = await lookupCatalog({ ids: ["SKU-RED", "missing-sku"] }, richContext);

    expect(result.body.messages?.[0]).toEqual({ type: "info", code: "not_found", content: "missing-sku" });
    expect(ucpSchemaErrors("shopping/catalog_lookup.json#/$defs/lookup_response", result.body)).toEqual([]);
  });

  it("answers get_product with a valid detail response", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce(ucpFeedPage([ratedProduct()]));
    const result = await getCatalogProduct({ id: "khaki-shoes", selected: [{ name: "Style", label: "Blue" }] }, richContext);

    expect(ucpSchemaErrors("shopping/catalog_lookup.json#/$defs/get_product_response", result.body)).toEqual([]);
  });

  it("answers an unresolvable get_product with a valid error response", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce(ucpFeedPage([]));
    const result = await getCatalogProduct({ id: "missing" }, richContext);

    expect(result.status).toBe(200);
    expect(ucpSchemaErrors("common/types/error_response.json", result.body)).toEqual([]);
  });

  it("answers invalid search input with a valid search response carrying the error", async () => {
    const result = await searchCatalog({}, richContext);

    expect(result.status).toBe(400);
    expect(ucpSchemaErrors("shopping/catalog_search.json#/$defs/search_response", result.body)).toEqual([]);
  });
});
