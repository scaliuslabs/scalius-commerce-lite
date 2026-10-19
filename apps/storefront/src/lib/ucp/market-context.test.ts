// @vitest-environment node
// Acceptance (b): a buyer context of a non-root market is answered in that
// market's minor-unit prices, equal to its presence page; (d) policies[]
// appears only while the return policy is enabled.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ presence: null as string | null }));
const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getLayoutData: vi.fn(),
}));

vi.mock("@/lib/api/products", () => ({ getFeedProducts: mocks.getFeedProducts }));
vi.mock("@/lib/api/storefront", () => ({ getLayoutData: mocks.getLayoutData }));
vi.mock("@/lib/api/runtime", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/runtime")>("@/lib/api/runtime");
  return {
    ...actual,
    getRuntimePresence: () => state.presence,
    renderForPresence: (presence: string) => {
      state.presence = presence;
    },
    setRuntimeImageCdnPolicy: () => undefined,
  };
});
vi.mock("@/lib/sitemap-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sitemap-utils")>("@/lib/sitemap-utils");
  return { ...actual, getBaseUrl: () => "https://storefront.example.test" };
});

import { getVariantDiscountedPrice } from "@/components/product/lib/pricing-engine";
import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { withMarketPresence } from "@scalius/shared/public-api-cache-routes";
import type { LayoutData } from "@/lib/api/storefront";
import type { Product } from "@/lib/api/types";
import { runUcpCatalogOperation } from "./catalog";
import { UCP_TEST_MARKETS, ucpFeedPage, ucpFeedProduct } from "./ucp-fixtures.testing";

/** The API's answer per presence: the root's BDT prices, India's market prices in USD. */
const FEED_BY_PRESENCE: Record<string, Product> = {
  "": ucpFeedProduct(),
  "en-in": ucpFeedProduct({
    price: 17.99,
    discountedPrice: 17.99,
    variants: ucpFeedProduct().variants!.map((variant) => ({
      ...variant,
      price: variant.id === "var_1" ? 14.49 : 19.99,
      discountAmount: variant.id === "var_1" ? 1.25 : null,
    })),
  }),
};

function layoutFor(presence: string, overrides: Partial<LayoutData> = {}): LayoutData {
  return {
    analytics: [],
    navigation: [],
    markets: UCP_TEST_MARKETS,
    currency: presence === "en-in"
      ? { code: "USD", symbol: "$", decimalPlaces: 2, priceIncrementMinor: 1, shopCode: "BDT" }
      : { code: "BDT", symbol: "৳", decimalPlaces: 2, priceIncrementMinor: 100 },
    business: { companyName: "Khaki House", country: "BD" },
    ...overrides,
  } as LayoutData;
}

/** The product page's price of a SKU (pages/products/[slug].astro), from its presence's layout and feed row. */
function presencePagePriceMinor(presence: string, variantId: string): { amount: number; currency: string } {
  const layout = layoutFor(presence);
  const product = FEED_BY_PRESENCE[presence]!;
  const variant = product.variants!.find((each) => each.id === variantId)!;
  const code = layout.currency!.code;
  const places = layout.currency!.decimalPlaces;
  const major = getVariantDiscountedPrice(
    variant.price,
    product.price,
    variant.discountType,
    variant.discountPercentage,
    variant.discountAmount,
    product.discountType,
    product.discountPercentage,
    product.discountAmount,
    places,
    code,
    resolvePriceIncrementMinor(code, layout.currency!.priceIncrementMinor),
  );
  return { amount: Math.round(major * 10 ** places), currency: code };
}

const feedPresences: Array<string | null> = [];

describe("UCP catalog in the buyer's market", () => {
  beforeEach(() => {
    state.presence = null;
    feedPresences.length = 0;
    mocks.getLayoutData.mockReset();
    mocks.getFeedProducts.mockReset();
    mocks.getLayoutData.mockImplementation(async () => layoutFor(state.presence ?? ""));
    mocks.getFeedProducts.mockImplementation(async () => {
      feedPresences.push(state.presence);
      return ucpFeedPage([FEED_BY_PRESENCE[state.presence ?? ""]!]);
    });
  });

  it("reads the feed under the market's presence, a market-keyed public read", () => {
    const feed = new URL("https://api.example.test/api/v1/products/feed?limit=10&channel=sc_agents");
    expect(withMarketPresence(feed, "en-in").searchParams.get("presence")).toBe("en-in");
  });

  it("prices a search in India's market exactly as its presence page does", async () => {
    const result = await runUcpCatalogOperation("search", {
      query: "khaki",
      context: { address_country: "IN", currency: "USD" },
    });

    expect(result.status).toBe(200);
    expect(feedPresences).toEqual(["en-in"]);
    const product = result.body.products![0]!;
    expect(product.variants.map((variant) => variant.price)).toEqual([
      presencePagePriceMinor("en-in", "var_1"),
      presencePagePriceMinor("en-in", "var_2"),
    ]);
    expect(product.variants[0]!.price).toEqual({ amount: 1324, currency: "USD" });
    expect(product.variants[0]!.list_price).toEqual({ amount: 1449, currency: "USD" });
    expect(product.price_range).toEqual({
      min: { amount: 1324, currency: "USD" },
      max: { amount: 1999, currency: "USD" },
    });
    // The buyer lands on the same market's page.
    expect(product.url).toBe("https://storefront.example.test/en-in/products/khaki-shoes");
    expect(result.body.messages).toBeUndefined();
  });

  it("selects the same market from a currency alone", async () => {
    const result = await runUcpCatalogOperation("lookup", { ids: ["SKU-RED"], context: { currency: "USD" } });

    expect(feedPresences).toEqual(["en-in"]);
    expect(result.body.products![0]!.variants[0]!.price).toEqual(presencePagePriceMinor("en-in", "var_1"));
  });

  it("answers a request without context at the root with the reads it always made", async () => {
    const result = await runUcpCatalogOperation("search", { query: "khaki" });

    expect(mocks.getLayoutData).toHaveBeenCalledTimes(1);
    expect(mocks.getFeedProducts).toHaveBeenCalledTimes(1);
    expect(feedPresences).toEqual([null]);
    expect(result.body.products![0]!.variants[0]!.price).toEqual(presencePagePriceMinor("", "var_1"));
    expect(result.body.products![0]!.url).toBe("https://storefront.example.test/products/khaki-shoes");
  });

  it("answers an unsupported market at the root with a warning", async () => {
    const result = await runUcpCatalogOperation("search", { query: "khaki", context: { address_country: "FR", currency: "EUR" } });

    expect(feedPresences).toEqual([null]);
    expect(result.body.products![0]!.variants[0]!.price.currency).toBe("BDT");
    expect(result.body.messages?.map((message) => message.code)).toEqual(["market_unavailable", "currency_unavailable"]);
  });

  it("carries policies[] only while the merchant's return policy is enabled", async () => {
    const enabled = { enabled: true, category: "finite", returnWindowDays: 7, returnFees: "free", policyUrl: "/pages/returns" };
    mocks.getLayoutData.mockImplementation(async () => layoutFor(state.presence ?? "", { seo: { returnPolicy: enabled } } as Partial<LayoutData>));
    const withPolicy = await runUcpCatalogOperation("search", { query: "khaki" });
    expect(withPolicy.body.policies).toEqual([{
      type: "dev.ucp.shopping.policy.return",
      description: { plain: "Returns are accepted within 7 days of delivery. Return shipping is free." },
      url: "https://storefront.example.test/pages/returns",
    }]);
    expect(withPolicy.body.products![0]!.variants[0]!.seller).toEqual({
      name: "Khaki House",
      links: [{ type: "refund_policy", url: "https://storefront.example.test/pages/returns" }],
    });

    mocks.getLayoutData.mockImplementation(async () => layoutFor(state.presence ?? "", { seo: { returnPolicy: { ...enabled, enabled: false } } } as Partial<LayoutData>));
    const disabled = await runUcpCatalogOperation("search", { query: "khaki" });
    expect(disabled.body).not.toHaveProperty("policies");
    expect(disabled.body.products![0]!.variants[0]!.seller).toEqual({ name: "Khaki House" });

    mocks.getLayoutData.mockImplementation(async () => layoutFor(state.presence ?? ""));
    const unset = await runUcpCatalogOperation("product", { id: "khaki-shoes" });
    expect(unset.body).not.toHaveProperty("policies");
  });

  it("names no seller without a Business settings name", async () => {
    mocks.getLayoutData.mockImplementation(async () => layoutFor(state.presence ?? "", { business: {} }));
    const result = await runUcpCatalogOperation("search", { query: "khaki" });
    expect(result.body.products![0]!.variants[0]).not.toHaveProperty("seller");
  });

  it("refuses an oversized batch before reading anything", async () => {
    const ids = Array.from({ length: 26 }, (_, index) => `SKU-${index}`);
    const result = await runUcpCatalogOperation("lookup", { ids });

    expect(result.status).toBe(400);
    expect(mocks.getLayoutData).not.toHaveBeenCalled();
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });
});
