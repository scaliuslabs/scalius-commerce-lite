import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getSeo: vi.fn(),
  getCurrency: vi.fn(),
  getMedia: vi.fn(),
}));

vi.mock("@scalius/core/modules/products", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@scalius/core/modules/products")
  >()),
  executeProductFeedRowPreview: mocks.execute,
}));

vi.mock(
  "@scalius/core/modules/settings/site-settings.service",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@scalius/core/modules/settings/site-settings.service")
    >()),
    getSeoSettings: mocks.getSeo,
    getCurrencySettings: mocks.getCurrency,
    getMediaOptimizationSettings: mocks.getMedia,
  }),
);

import { feedRowPreviewRoutes } from "./feed-row-preview";

const feedsPolicy = {
  productCatalogEnabled: true,
  includeUnavailableProducts: true,
  variantStrategy: "variants" as const,
  title: "",
  description: "",
};

function responseData() {
  return {
    productId: "prod_1",
    requestedSku: null,
    policy: {
      productCatalogEnabled: true,
      includeUnavailableProducts: true,
      variantStrategy: "variants" as const,
    },
    entries: [
      {
        status: "omitted" as const,
        productId: "prod_1",
        variantId: null,
        sku: null,
        reason: "missing_image" as const,
      },
    ],
    pagination: {
      limit: 10,
      returned: 1,
      totalOutcomes: 1,
      hasNextPage: false,
      nextCursor: null,
      responseTruncated: false,
    },
    semantics: {
      basis: "current_saved_state" as const,
      emittedRowsAreExact: true as const,
      entryFieldsTruncated: false as const,
      cachedFeedPropagationVerified: false as const,
      providerAcceptanceVerified: false as const,
      pagesMayRaceWithWrites: true as const,
      responseBudgetBytes: 46 * 1024 as 47104,
    },
  };
}

function app() {
  const result = new OpenAPIHono<{ Bindings: Env }>();
  result.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  result.route("/settings", feedRowPreviewRoutes);
  return result;
}

describe("dashboard feed row preview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSeo.mockResolvedValue({ discovery: { feeds: feedsPolicy } });
    mocks.getCurrency.mockResolvedValue({ currencyCode: "BDT" });
    mocks.getMedia.mockResolvedValue({
      enabled: true,
      canonicalCdnUrl: "cdn.example.com",
      allowedImageHosts: ["images.example.com"],
      canonicalHostAliases: ["old-cdn.example.com"],
    });
    mocks.execute.mockResolvedValue(responseData());
  });

  it("passes exact bounded inputs and request-scoped image authority with no-store", async () => {
    const order: string[] = [];
    mocks.getSeo.mockImplementation(async () => {
      order.push("seo");
      return { discovery: { feeds: feedsPolicy } };
    });
    mocks.getCurrency.mockImplementation(async () => {
      order.push("currency");
      return { currencyCode: "BDT" };
    });
    mocks.getMedia.mockImplementation(async () => {
      order.push("media");
      return {
        enabled: true,
        canonicalCdnUrl: "cdn.example.com",
        allowedImageHosts: ["images.example.com"],
        canonicalHostAliases: ["old-cdn.example.com"],
      };
    });
    mocks.execute.mockImplementation(async () => {
      order.push("preview");
      return responseData();
    });

    const response = await app().request(
      "/settings/seo/feed-row-preview/prod_1?sku=SKU-1&limit=3",
      undefined,
      {
        STOREFRONT_URL: "https://shop.example.com",
        CDN_DOMAIN_URL: "fallback-cdn.example.com",
      } as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(order).toEqual(["seo", "currency", "media", "preview"]);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "prod_1",
        sku: "SKU-1",
        limit: 3,
        storefrontBaseUrl: "https://shop.example.com",
        currencyCode: "BDT",
        feedsPolicy,
        mediaPolicy: {
          enabled: true,
          canonicalCdnUrl: "cdn.example.com",
          allowedImageHosts: ["images.example.com"],
          canonicalHostAliases: ["old-cdn.example.com"],
        },
        environmentCdnUrl: "fallback-cdn.example.com",
      }),
    );
    expect(await response.json()).toEqual({
      success: true,
      data: responseData(),
    });
  });

  it("does not read currency or media settings when the feed is disabled", async () => {
    mocks.getSeo.mockResolvedValue({
      discovery: {
        feeds: { ...feedsPolicy, productCatalogEnabled: false },
      },
    });
    const response = await app().request(
      "/settings/seo/feed-row-preview/prod_1",
      undefined,
      {} as Env,
    );
    expect(response.status).toBe(200);
    expect(mocks.getCurrency).not.toHaveBeenCalled();
    expect(mocks.getMedia).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        currencyCode: "BDT",
        feedsPolicy: expect.objectContaining({
          productCatalogEnabled: false,
        }),
      }),
    );
  });

  it.each([
    ["limit above ten", "/settings/seo/feed-row-preview/prod_1?limit=11"],
    [
      "oversized SKU",
      `/settings/seo/feed-row-preview/prod_1?sku=${"s".repeat(129)}`,
    ],
    [
      "oversized product ID",
      `/settings/seo/feed-row-preview/${"p".repeat(129)}`,
    ],
  ])("rejects %s before the executor", async (_label, path) => {
    const response = await app().request(path);
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["bad prefix", "not-a-preview-cursor"],
    ["valid base64 with invalid JSON", "feed-preview-v1.bm90LWpzb24"],
    ["valid JSON with an invalid payload", "feed-preview-v1.e30"],
  ])("rejects %s before settings or product work", async (_label, cursor) => {
    const response = await app().request(
      `/settings/seo/feed-row-preview/prod_1?cursor=${cursor}`,
    );
    expect(response.status).not.toBe(200);
    expect(mocks.getSeo).not.toHaveBeenCalled();
    expect(mocks.getCurrency).not.toHaveBeenCalled();
    expect(mocks.getMedia).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("publishes a complete bounded row schema without PII fields", () => {
    const document = app().getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Feed preview test", version: "test" },
    });
    const operation = document.paths?.[
      "/settings/seo/feed-row-preview/{productId}"
    ]?.get;
    const schema = JSON.stringify(operation?.responses?.["200"]);

    for (const field of [
      "identifierExists",
      "salePrice",
      "itemGroupId",
      "itemGroupTitle",
      "variantOptions",
      "googleProductCategory",
      "facebookProductCategory",
      "productType",
      "standardAttributes",
      "shipping",
      "preview_entry_too_large",
      "requiredBytes",
    ]) {
      expect(schema).toContain(field);
    }
    for (const piiField of [
      "customerName",
      "email",
      "phone",
      "address",
      "requestId",
    ]) {
      expect(schema).not.toContain(piiField);
    }
  });
});
