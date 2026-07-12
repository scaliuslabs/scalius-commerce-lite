// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getLayoutData: vi.fn(),
  getSeoSettings: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
  setRuntimeImageCdnPolicy: vi.fn(),
  getOptimizedImageUrl: vi.fn((url: string) => url),
}));

vi.mock("@/lib/api/products", () => ({
  getFeedProducts: mocks.getFeedProducts,
}));

vi.mock("@/lib/api", () => ({
  getLayoutData: mocks.getLayoutData,
  getSeoSettings: mocks.getSeoSettings,
}));

vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
  setRuntimeImageCdnPolicy: mocks.setRuntimeImageCdnPolicy,
}));

vi.mock("@/lib/image-optimizer", () => ({
  getOptimizedImageUrl: mocks.getOptimizedImageUrl,
}));

import { GET } from "../../../pages/api/facebook-feed.xml";
import { GET as GOOGLE_FEED_GET } from "../../../pages/api/product-feed.xml";

function context(url = "https://storefront.example.test/api/facebook-feed.xml") {
  return { url: new URL(url) } as never;
}

type FeedOptionFixture = {
  name: string;
  value: string;
  standardMapping: "size" | "color" | "material" | "pattern" | "none";
};

function optionedVariant<T extends Record<string, unknown>>(
  variant: T & { options: FeedOptionFixture[] },
) {
  const { options, ...rest } = variant;
  const selectedOptions = options.map((option, position) => {
    const optionKey = option.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const valueKey = option.value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      optionDefinitionId: `opt_${optionKey}`,
      optionValueId: `val_${optionKey}_${valueKey}`,
      name: option.name,
      value: option.value,
      position,
      valuePosition: position,
      standardMapping: option.standardMapping,
    };
  });

  return {
    ...rest,
    optionCombinationKey: selectedOptions
      .map((option) => option.optionValueId)
      .join("|"),
    imageId: null,
    selectedOptions,
  };
}

function feedItemById(body: string, id: string): string {
  const item = (body.match(/<item>[\s\S]*?<\/item>/g) ?? []).find((candidate) =>
    candidate.includes(`<g:id>${id}</g:id>`)
  );
  expect(item, `Expected feed item ${id}`).toBeDefined();
  return item!;
}

function expectFeedPriceInvariant(body: string): void {
  const items = body.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  expect(items.length).toBeGreaterThan(0);

  for (const item of items) {
    const itemWithoutShipping = item.replace(
      /<g:shipping\b[\s\S]*?<\/g:shipping>/gi,
      "",
    );
    const price = itemWithoutShipping.match(
      /<g:price>(\d+(?:\.\d+)?) ([A-Z]{3})<\/g:price>/,
    );
    const salePrice = itemWithoutShipping.match(
      /<g:sale_price>(\d+(?:\.\d+)?) ([A-Z]{3})<\/g:sale_price>/,
    );
    expect(price, "Every feed item must have one base price").not.toBeNull();
    expect(itemWithoutShipping.match(/<g:price>/g)).toHaveLength(1);
    expect(
      itemWithoutShipping.match(/<g:sale_price>/g)?.length ?? 0,
    ).toBeLessThanOrEqual(1);
    expect(Number(price![1])).toBeGreaterThan(0);
    if (salePrice) {
      expect(salePrice[2]).toBe(price![2]);
      expect(Number(salePrice[1])).toBeGreaterThan(0);
      expect(Number(salePrice[1])).toBeLessThan(Number(price![1]));
    }
  }
}

describe("Facebook product feed route", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getSeoSettings.mockReset();
    mocks.setRuntimeImageCdnPolicy.mockReset();
    mocks.getSeoSettings.mockResolvedValue({ discovery: undefined });
    mocks.getRuntimeStorefrontUrl.mockReturnValue("https://storefront.example.test");
    mocks.getLayoutData.mockResolvedValue({
      currency: { code: "BDT" },
      media: undefined,
    });
  });

  it("returns non-cacheable 503 when the first product page cannot be read", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce(null);

    const response = await GET(context());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("fails closed when the storefront base URL is not absolute", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("/relative-store");

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Facebook product feed is temporarily unavailable");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("fails closed when storefront layout data cannot be read", async () => {
    mocks.getLayoutData.mockResolvedValueOnce(null);

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Facebook product feed is temporarily unavailable");
    expect(mocks.setRuntimeImageCdnPolicy).not.toHaveBeenCalled();
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("keeps legitimate empty catalogs as empty XML", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
    expect(body).toContain("<rss");
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({ page: 1, limit: 100 });
  });

  it("emits product condition only from a saved product fact", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_used",
          slug: "used-camera",
          name: "Used Camera",
          description: "Second-hand camera",
          price: 7500,
          discountedPrice: 7500,
          availableForSale: true,
          productCondition: "used",
          imageUrl: "https://cdn.example.test/products/used-camera.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<g:condition>used</g:condition>");
    expect(body).not.toContain("<g:condition>new</g:condition>");
  });

  it("does not fabricate a feed condition for products without a saved condition", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_unknown_condition",
          slug: "unknown-condition",
          name: "Condition Not Saved",
          description: "Product without explicit condition",
          price: 1200,
          discountedPrice: 1200,
          availableForSale: true,
          productCondition: null,
          imageUrl: "https://cdn.example.test/products/condition-not-saved.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<g:condition>");
  });

  it("does not fabricate taxonomy categories for unmapped merchant categories", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_unmapped_category",
          slug: "linen-panjabi",
          name: "Linen Panjabi",
          description: "Custom apparel category",
          price: 2800,
          discountedPrice: 2800,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/linen-panjabi.jpg",
          category: {
            id: "cat_custom_apparel",
            slug: "eid-collection",
            name: "Eid Collection",
          },
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<g:google_product_category>");
    expect(body).not.toContain("<g:fb_product_category>");
    expect(body).not.toContain("Health &amp; Beauty");
    expect(body).toContain("<g:product_type>Eid Collection</g:product_type>");
  });

  it("emits taxonomy categories only for explicit mappings", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_electronics",
          slug: "smart-watch",
          name: "Smart Watch",
          description: "Mapped electronics product",
          price: 4200,
          discountedPrice: 4200,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/smart-watch.jpg",
          category: {
            id: "cat_electronics",
            slug: "electronics",
            name: "Electronics",
          },
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<g:google_product_category>Electronics</g:google_product_category>",
    );
    expect(body).toContain(
      "<g:fb_product_category>Electronics &amp; Accessories</g:fb_product_category>",
    );
    expect(body).toContain("<g:product_type>Electronics</g:product_type>");
  });

  it("rejects malformed page and limit query parameters", async () => {
    const badPage = await GET(
      context("https://storefront.example.test/api/facebook-feed.xml?page=2abc"),
    );
    const badLimit = await GET(
      context("https://storefront.example.test/api/facebook-feed.xml?limit=05"),
    );

    expect(badPage.status).toBe(400);
    await expect(badPage.text()).resolves.toContain("Invalid page parameter");
    expect(badLimit.status).toBe(400);
    await expect(badLimit.text()).resolves.toContain("Invalid limit parameter");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("uses buyer availability from the product list instead of product active status alone", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_available",
          slug: "always-available",
          name: "Always Available",
          description: "Simple untracked SKU",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/available.jpg",
        },
        {
          id: "prod_sold_out",
          slug: "sold-out",
          name: "Sold Out",
          description: "Tracked SKU with no stock",
          price: 1400,
          discountedPrice: 1400,
          isActive: true,
          availableForSale: false,
          imageUrl: "https://cdn.example.test/products/sold-out.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<g:id>prod_available</g:id>");
    expect(body).toContain("<g:availability>in stock</g:availability>");
    expect(body).toContain("<g:id>prod_sold_out</g:id>");
    expect(body).toContain("<g:availability>out of stock</g:availability>");
  });

  it("emits one SKU-aware feed item per buyer-resolvable variant by default", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_shirt",
          slug: "linen-shirt",
          name: "Linen Shirt",
          description: "<p>Soft &amp; breezy</p>",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/shirt.jpg",
          attributes: [
            { name: "Brand", slug: "brand", value: "Acme" },
            { name: "Color", slug: "color", value: "Catalog color" },
            { name: "Size", slug: "size", value: "Catalog size" },
            { name: "Material", slug: "material", value: "Cotton" },
          ],
          variants: [
            optionedVariant({
              id: "var_red_m",
              productId: "prod_shirt",
              options: [
                { name: "Size", value: "M", standardMapping: "size" },
                { name: "Color", value: "Red", standardMapping: "color" },
              ],
              sku: "SKU-RED-M",
              barcode: "012345678905",
              barcodeType: "upc",
              price: 1000,
              stock: 4,
              reservedStock: 1,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: "flat",
              discountAmount: 100,
              discountPercentage: null,
            }),
            optionedVariant({
              id: "var_blue_l",
              productId: "prod_shirt",
              options: [
                { name: "Size", value: "L", standardMapping: "size" },
                { name: "Color", value: "Blue", standardMapping: "color" },
              ],
              sku: "SKU-BLUE-L",
              price: 1100,
              stock: 0,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: null,
              discountAmount: null,
              discountPercentage: null,
            }),
            optionedVariant({
              id: "var_free_xl",
              productId: "prod_shirt",
              options: [
                { name: "Size", value: "XL", standardMapping: "size" },
                { name: "Color", value: "Green", standardMapping: "color" },
              ],
              sku: "SKU-FREE-XL",
              price: 100,
              stock: 2,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: "flat",
              discountAmount: 100,
              discountPercentage: null,
            }),
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.match(/<item>/g)).toHaveLength(2);
    expect(body).toContain("<g:id>SKU-RED-M</g:id>");
    expect(body).toContain("<g:id>SKU-BLUE-L</g:id>");
    expect(body).not.toContain("<g:id>SKU-FREE-XL</g:id>");
    expect(body).not.toContain("<g:id>prod_shirt</g:id>");
    expect(body).toContain("<g:item_group_id>prod_shirt</g:item_group_id>");
    expect(body).toContain(
      "<g:title>Linen Shirt - Size: M / Color: Red</g:title>",
    );
    expect(body).toContain(
      "<g:link>https://storefront.example.test/products/linen-shirt?variant=var_red_m</g:link>",
    );
    const discountedVariant = feedItemById(body, "SKU-RED-M");
    expect(discountedVariant).toContain("<g:price>1000.00 BDT</g:price>");
    expect(discountedVariant).toContain(
      "<g:sale_price>900.00 BDT</g:sale_price>",
    );
    const undiscountedVariant = feedItemById(body, "SKU-BLUE-L");
    expect(undiscountedVariant).toContain("<g:price>1100.00 BDT</g:price>");
    expect(undiscountedVariant).not.toContain("<g:sale_price>");
    expectFeedPriceInvariant(body);
    expect(body).toContain("<g:gtin>012345678905</g:gtin>");
    expect(body).toContain("<g:availability>in stock</g:availability>");
    expect(body).toContain("<g:availability>out of stock</g:availability>");
    expect(body).toContain("<g:color>Red</g:color>");
    expect(body).toContain("<g:size>M</g:size>");
    expect(body).toContain("<g:material>Cotton</g:material>");
    expect(body).not.toContain("Catalog color");
    expect(body).not.toContain("Catalog size");
  });

  it("uses merchant option mapping for variant feed labels and schema fields", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_pack",
          slug: "premium-pack",
          name: "Premium Pack",
          description: "Bundle options",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/pack.jpg",
          variants: [
            optionedVariant({
              id: "var_pack_premium",
              productId: "prod_pack",
              options: [
                { name: "Weight", value: "2KG", standardMapping: "none" },
                { name: "Style", value: "Premium", standardMapping: "pattern" },
                { name: "Packaging", value: "Gift box", standardMapping: "none" },
              ],
              sku: "PACK-2KG-PREMIUM",
              price: 1200,
              stock: 4,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: null,
              discountAmount: null,
              discountPercentage: null,
            }),
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<g:title>Premium Pack - Weight: 2KG / Style: Premium / Packaging: Gift box</g:title>",
    );
    expect(body).toContain("<g:item_group_title>Premium Pack</g:item_group_title>");
    expect(body).toContain("<g:name>Weight</g:name>");
    expect(body).toContain("<g:value>2KG</g:value>");
    expect(body).toContain("<g:name>Style</g:name>");
    expect(body).toContain("<g:value>Premium</g:value>");
    expect(body).toContain("<g:name>Packaging</g:name>");
    expect(body).toContain("<g:value>Gift box</g:value>");
    expect(body).toContain("<g:pattern>Premium</g:pattern>");
    expect(body).not.toContain("<g:size>2KG</g:size>");
    expect(body).not.toContain("<g:color>Premium</g:color>");
    expect(body).not.toContain("<g:material>2KG</g:material>");
  });

  it("uses Google feed vocabulary and canonical product paths on the canonical product feed", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_shirt",
          slug: "linen-shirt",
          canonicalPath: "/products/linen-shirt-canonical",
          name: "Linen Shirt",
          description: "Soft shirt",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/shirt.jpg",
          variants: [
            optionedVariant({
              id: "var_red_m",
              productId: "prod_shirt",
              options: [
                { name: "Size", value: "M", standardMapping: "size" },
                { name: "Color", value: "Red", standardMapping: "color" },
              ],
              sku: "SKU-RED-M",
              barcode: null,
              barcodeType: null,
              price: 1000,
              stock: 4,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: null,
              discountAmount: null,
              discountPercentage: null,
            }),
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<g:link>https://storefront.example.test/products/linen-shirt-canonical?variant=var_red_m</g:link>",
    );
    expect(body).not.toContain("https://storefront.example.test/shop/linen-shirt");
    expect(body).toContain("<g:item_group_title>Linen Shirt</g:item_group_title>");
    expect(body).toContain("<g:variant_option>");
    expect(body).toContain("<g:name>Size</g:name>");
    expect(body).toContain("<g:value>M</g:value>");
    expect(body).toContain("<g:name>Color</g:name>");
    expect(body).toContain("<g:value>Red</g:value>");
    expect(body).toContain("<g:availability>in_stock</g:availability>");
    expect(body).not.toContain("<g:availability>in stock</g:availability>");
    expect(body).toContain("<g:identifier_exists>no</g:identifier_exists>");
    expect(body).not.toContain("<g:brand>Generic</g:brand>");
  });

  it("paginates the flattened feed rows so expanded variants are not dropped", async () => {
    mocks.getFeedProducts.mockResolvedValue({
      data: [
        {
          id: "prod_bundle",
          slug: "variant-bundle",
          name: "Variant Bundle",
          description: "Three buyer variants",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/bundle.jpg",
          variants: [
            optionedVariant({
              id: "var_a",
              productId: "prod_bundle",
              options: [
                { name: "Tier", value: "A", standardMapping: "none" },
                { name: "Finish", value: "Red", standardMapping: "color" },
              ],
              sku: "SKU-A",
              price: 1000,
              stock: 4,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: null,
              discountAmount: null,
              discountPercentage: null,
            }),
            optionedVariant({
              id: "var_b",
              productId: "prod_bundle",
              options: [
                { name: "Tier", value: "B", standardMapping: "none" },
                { name: "Finish", value: "Blue", standardMapping: "color" },
              ],
              sku: "SKU-B",
              price: 1100,
              stock: 4,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: null,
              discountAmount: null,
              discountPercentage: null,
            }),
            optionedVariant({
              id: "var_c",
              productId: "prod_bundle",
              options: [
                { name: "Tier", value: "C", standardMapping: "none" },
                { name: "Finish", value: "Green", standardMapping: "color" },
              ],
              sku: "SKU-C",
              price: 1200,
              stock: 4,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: null,
              discountAmount: null,
              discountPercentage: null,
            }),
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const firstPage = await GET(
      context("https://storefront.example.test/api/facebook-feed.xml?limit=2"),
    );
    const firstBody = await firstPage.text();
    const secondPage = await GET(
      context("https://storefront.example.test/api/facebook-feed.xml?page=2&limit=2"),
    );
    const secondBody = await secondPage.text();

    expect(firstPage.status).toBe(200);
    expect(firstBody.match(/<item>/g)).toHaveLength(2);
    expect(firstBody).toContain("<g:id>SKU-A</g:id>");
    expect(firstBody).toContain("<g:id>SKU-B</g:id>");
    expect(firstBody).not.toContain("<g:id>SKU-C</g:id>");
    expect(secondPage.status).toBe(200);
    expect(secondBody.match(/<item>/g)).toHaveLength(1);
    expect(secondBody).not.toContain("<g:id>SKU-A</g:id>");
    expect(secondBody).not.toContain("<g:id>SKU-B</g:id>");
    expect(secondBody).toContain("<g:id>SKU-C</g:id>");
    expect(mocks.getFeedProducts).toHaveBeenCalledWith({ page: 1, limit: 100 });
  });

  it("keeps product-level rows when the feed variant strategy is products", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: true,
          variantMode: "products",
        },
      },
    });
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_shirt",
          slug: "linen-shirt",
          name: "Linen Shirt",
          description: "Soft shirt",
          price: 1200,
          discountedPrice: 1100,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 100,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/shirt.jpg",
          variants: [
            optionedVariant({
              id: "var_red_m",
              productId: "prod_shirt",
              options: [
                { name: "Size", value: "M", standardMapping: "size" },
                { name: "Color", value: "Red", standardMapping: "color" },
              ],
              sku: "SKU-RED-M",
              price: 1000,
              stock: 4,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
            }),
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.match(/<item>/g)).toHaveLength(1);
    expect(body).toContain("<g:id>prod_shirt</g:id>");
    expect(body).toContain("<g:item_group_id>prod_shirt</g:item_group_id>");
    expect(body).toContain("<g:price>1200.00 BDT</g:price>");
    expect(body).toContain("<g:sale_price>1100.00 BDT</g:sale_price>");
    expectFeedPriceInvariant(body);
    expect(body).not.toContain("SKU-RED-M");
  });

  it("emits a real GTIN for simple product rows when the default SKU has one", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_simple",
          slug: "simple-shirt",
          canonicalPath: null,
          name: "Simple Shirt",
          description: "One sellable SKU",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          hasVariants: false,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/simple.jpg",
          variants: [
            {
              id: "var_simple",
              productId: "prod_simple",
              optionCombinationKey: null,
              imageId: null,
              selectedOptions: [],
              sku: "SIMPLE-SHIRT",
              barcode: "8801234567890",
              barcodeType: "ean13",
              price: 1200,
              stock: 0,
              reservedStock: 0,
              trackInventory: false,
              isDefault: true,
              deletedAt: null,
              discountType: null,
              discountAmount: null,
              discountPercentage: null,
            },
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.match(/<item>/g)).toHaveLength(1);
    expect(body).toContain("<g:id>prod_simple</g:id>");
    expect(body).toContain("<g:gtin>8801234567890</g:gtin>");
    expect(body).not.toContain("<g:identifier_exists>no</g:identifier_exists>");
  });

  it("skips unavailable variant rows when sold-out catalog items are disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: false,
        },
      },
    });
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_shirt",
          slug: "linen-shirt",
          name: "Linen Shirt",
          description: "Soft shirt",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/shirt.jpg",
          variants: [
            optionedVariant({
              id: "var_red_m",
              productId: "prod_shirt",
              options: [
                { name: "Size", value: "M", standardMapping: "size" },
                { name: "Color", value: "Red", standardMapping: "color" },
              ],
              sku: "SKU-RED-M",
              price: 1000,
              stock: 3,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
            }),
            optionedVariant({
              id: "var_blue_l",
              productId: "prod_shirt",
              options: [
                { name: "Size", value: "L", standardMapping: "size" },
                { name: "Color", value: "Blue", standardMapping: "color" },
              ],
              sku: "SKU-BLUE-L",
              price: 1100,
              stock: 0,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
            }),
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.match(/<item>/g)).toHaveLength(1);
    expect(body).toContain("<g:id>SKU-RED-M</g:id>");
    expect(body).not.toContain("<g:id>SKU-BLUE-L</g:id>");
  });

  it("uses merchant feed title/description and can skip unavailable products", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: false,
          title: "  Summer catalog  ",
          description: "  Fresh seasonal products  ",
        },
      },
    });
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_available",
          slug: "always-available",
          name: "Always Available",
          description: "Simple untracked SKU",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/available.jpg",
        },
        {
          id: "prod_sold_out",
          slug: "sold-out",
          name: "Sold Out",
          description: "Tracked SKU with no stock",
          price: 1400,
          discountedPrice: 1400,
          isActive: true,
          availableForSale: false,
          imageUrl: "https://cdn.example.test/products/sold-out.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<title>Summer catalog</title>");
    expect(body).toContain("<description>Fresh seasonal products</description>");
    expect(body).toContain("<g:id>prod_available</g:id>");
    expect(body).not.toContain("<g:id>prod_sold_out</g:id>");
  });

  it("keeps free-shipping cost separate from the direct item price", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_free_delivery",
          slug: "free-delivery-product",
          name: "Free Delivery Product",
          description: "Catalog item with free shipping",
          price: 1200,
          discountedPrice: 1000,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 200,
          isActive: true,
          availableForSale: true,
          freeDelivery: true,
          imageUrl: "https://cdn.example.test/products/free-delivery.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();
    const item = feedItemById(body, "prod_free_delivery");

    expect(response.status).toBe(200);
    expect(item).toContain("<g:price>1200.00 BDT</g:price>");
    expect(item).toContain("<g:sale_price>1000.00 BDT</g:sale_price>");
    expect(item).toContain("<g:shipping>");
    expect(item).toContain("<g:price>0.00 BDT</g:price>");
    expect(item.match(/<g:price>/g)).toHaveLength(2);
    expectFeedPriceInvariant(body);
  });

  it("omits zero-current-price products from both catalog feeds", async () => {
    mocks.getFeedProducts.mockResolvedValue({
      data: [
        {
          id: "prod_free",
          slug: "free-sample",
          name: "Free Sample",
          description: "Fully discounted item",
          price: 1200,
          discountedPrice: 0,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/free.jpg",
        },
        {
          id: "prod_rounded_free",
          slug: "rounded-free-sample",
          name: "Rounded Free Sample",
          description: "Positive raw price that rounds to zero in the feed",
          price: 1,
          discountedPrice: 0.004,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 0.996,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/rounded-free.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });

    const metaResponse = await GET(context());
    const googleResponse = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const bodies = [await metaResponse.text(), await googleResponse.text()];

    expect(metaResponse.status).toBe(200);
    expect(googleResponse.status).toBe(200);
    for (const body of bodies) {
      expect(body).toContain("<rss");
      expect(body).not.toContain("<item>");
      expect(body).not.toContain("prod_free");
      expect(body).not.toContain("prod_rounded_free");
      expect(body).not.toContain("<g:price>");
      expect(body).not.toContain("<g:sale_price>");
    }
  });

  it("keeps base/sale pricing invariant across Google and Meta feeds", async () => {
    mocks.getFeedProducts.mockResolvedValue({
      data: [
        {
          id: "prod_discounted",
          slug: "discounted-product",
          name: "Discounted Product",
          description: "Catalog sale item",
          price: 1500,
          discountedPrice: 1250,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 250,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/discounted.jpg",
        },
        {
          id: "prod_regular",
          slug: "regular-product",
          name: "Regular Product",
          description: "Catalog regular-price item",
          price: 800,
          discountedPrice: 800,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/regular.jpg",
        },
        {
          id: "prod_rounded_equal",
          slug: "rounded-equal-product",
          name: "Rounded Equal Product",
          description: "Discount below feed currency precision",
          price: 1.004,
          discountedPrice: 1.003,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 0.001,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/rounded-equal.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 3, totalPages: 1 },
    });

    const metaResponse = await GET(context());
    const googleResponse = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const metaBody = await metaResponse.text();
    const googleBody = await googleResponse.text();

    expect(metaResponse.status).toBe(200);
    expect(googleResponse.status).toBe(200);
    for (const body of [metaBody, googleBody]) {
      const discounted = feedItemById(body, "prod_discounted");
      expect(discounted).toContain("<g:price>1500.00 BDT</g:price>");
      expect(discounted).toContain(
        "<g:sale_price>1250.00 BDT</g:sale_price>",
      );
      const regular = feedItemById(body, "prod_regular");
      expect(regular).toContain("<g:price>800.00 BDT</g:price>");
      expect(regular).not.toContain("<g:sale_price>");
      const roundedEqual = feedItemById(body, "prod_rounded_equal");
      expect(roundedEqual).toContain("<g:price>1.00 BDT</g:price>");
      expect(roundedEqual).not.toContain("<g:sale_price>");
      expectFeedPriceInvariant(body);
    }
    expect(metaBody).toContain("<g:availability>in stock</g:availability>");
    expect(googleBody).toContain("<g:availability>in_stock</g:availability>");
  });

  it("caps catalog money at two decimals for three-decimal currencies", async () => {
    mocks.getLayoutData.mockResolvedValue({
      currency: { code: "KWD" },
      media: undefined,
    });
    mocks.getFeedProducts.mockResolvedValue({
      data: [
        {
          id: "prod_kwd_sale",
          slug: "kwd-sale",
          name: "KWD Sale",
          description: "Discount remains visible after feed rounding",
          price: 1.236,
          discountedPrice: 1.224,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 0.012,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/kwd-sale.jpg",
        },
        {
          id: "prod_kwd_rounded_equal",
          slug: "kwd-rounded-equal",
          name: "KWD Rounded Equal",
          description: "Discount disappears at feed precision",
          price: 1.234,
          discountedPrice: 1.233,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 0.001,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/kwd-rounded-equal.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
    });

    const metaResponse = await GET(context());
    const googleResponse = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );
    const bodies = [await metaResponse.text(), await googleResponse.text()];

    expect(metaResponse.status).toBe(200);
    expect(googleResponse.status).toBe(200);
    for (const body of bodies) {
      const sale = feedItemById(body, "prod_kwd_sale");
      expect(sale).toContain("<g:price>1.24 KWD</g:price>");
      expect(sale).toContain("<g:sale_price>1.22 KWD</g:sale_price>");
      const roundedEqual = feedItemById(body, "prod_kwd_rounded_equal");
      expect(roundedEqual).toContain("<g:price>1.23 KWD</g:price>");
      expect(roundedEqual).not.toContain("<g:sale_price>");
      expect(body).not.toMatch(/<g:(?:sale_)?price>\d+\.\d{3}/);
      expectFeedPriceInvariant(body);
    }
  });

  it("rounds the exact 1.005 boundary identically in Google and Meta feeds", async () => {
    mocks.getFeedProducts.mockResolvedValue({
      data: [
        {
          id: "prod_rounding_boundary",
          slug: "rounding-boundary",
          name: "Rounding Boundary",
          description: "Currency.js boundary regression",
          price: 1.005,
          discountedPrice: 0.9,
          discountType: "percentage",
          discountPercentage: 10,
          discountAmount: null,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/rounding-boundary.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const metaResponse = await GET(context());
    const googleResponse = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );

    for (const response of [metaResponse, googleResponse]) {
      expect(response.status).toBe(200);
      const body = await response.text();
      const item = feedItemById(body, "prod_rounding_boundary");
      expect(item).toContain("<g:price>1.01 BDT</g:price>");
      expect(item).toContain("<g:sale_price>0.90 BDT</g:sale_price>");
      expectFeedPriceInvariant(body);
    }
  });

  it("omits exponent-form legacy prices from Google and Meta feeds", async () => {
    mocks.getFeedProducts.mockResolvedValue({
      data: [
        {
          id: "prod_exponent_price",
          slug: "exponent-price",
          name: "Exponent Price",
          description: "Legacy out-of-range price",
          price: 1e21,
          discountedPrice: 1e21,
          discountType: null,
          discountPercentage: null,
          discountAmount: null,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/exponent-price.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const metaResponse = await GET(context());
    const googleResponse = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );

    for (const response of [metaResponse, googleResponse]) {
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain("<item>");
      expect(body).not.toContain("prod_exponent_price");
      expect(body).not.toMatch(/<g:(?:sale_)?price>[^<]*e\+/i);
    }
  });

  it("preserves fractional variant discounts at the feed precision", async () => {
    mocks.getFeedProducts.mockResolvedValue({
      data: [
        {
          id: "prod_fractional",
          slug: "fractional-variant",
          name: "Fractional Variant",
          description: "Fractional BDT discount",
          price: 10.4,
          discountedPrice: 0.4,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 10,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/fractional.jpg",
          variants: [
            optionedVariant({
              id: "var_fractional",
              productId: "prod_fractional",
              options: [
                { name: "Size", value: "M", standardMapping: "size" },
              ],
              sku: "SKU-FRACTIONAL",
              price: 10.4,
              stock: 3,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
              discountType: null,
              discountPercentage: null,
              discountAmount: null,
            }),
          ],
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const metaResponse = await GET(context());
    const googleResponse = await GOOGLE_FEED_GET(
      context("https://storefront.example.test/api/product-feed.xml"),
    );

    for (const response of [metaResponse, googleResponse]) {
      expect(response.status).toBe(200);
      const body = await response.text();
      const item = feedItemById(body, "SKU-FRACTIONAL");
      expect(item).toContain("<g:price>10.40 BDT</g:price>");
      expect(item).toContain("<g:sale_price>0.40 BDT</g:sale_price>");
      expectFeedPriceInvariant(body);
    }
  });

  it("flattens rich-text product descriptions into safe catalog text", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_rich",
          slug: "rich-description",
          name: "Rich Description",
          description:
            "<h1>Premium &amp; Fresh</h1><p>Ships <strong>today</strong>.</p><script>alert('x')</script><!-- hidden -->",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/rich.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<g:description>Premium &amp; Fresh Ships today.</g:description>",
    );
    expect(body).not.toContain("<strong>");
    expect(body).not.toContain("alert");
    expect(body).not.toContain("hidden");
    expect(body).not.toContain("&amp;amp;");
  });

  it("skips image-less products and keeps required image and availability fields on valid items", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_no_image",
          slug: "no-image",
          name: "No Image",
          description: "Missing primary image",
          price: 900,
          discountedPrice: 900,
          isActive: true,
          availableForSale: true,
          imageUrl: null,
        },
        {
          id: "prod_blank_image",
          slug: "blank-image",
          name: "Blank Image",
          description: "Blank primary image",
          price: 950,
          discountedPrice: 950,
          isActive: true,
          availableForSale: true,
          imageUrl: "   ",
        },
        {
          id: "prod_valid",
          slug: "valid-image",
          name: "Valid Image",
          description: "Has primary image",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: false,
          imageUrl: "https://cdn.example.test/products/valid.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 3, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<g:id>prod_no_image</g:id>");
    expect(body).not.toContain("<g:id>prod_blank_image</g:id>");
    expect(body).toContain("<g:id>prod_valid</g:id>");
    expect(body).toContain(
      "<g:image_link>https://cdn.example.test/products/valid.jpg</g:image_link>",
    );
    expect(body).toContain("<g:availability>out of stock</g:availability>");
    expect(body.match(/<item>/g)).toHaveLength(1);
  });

  it("emits absolute image links when the image optimizer returns a relative URL", async () => {
    mocks.getOptimizedImageUrl.mockReturnValueOnce(
      "/cdn-cgi/image/width=1200/products/valid.jpg",
    );
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_valid",
          slug: "valid-image",
          name: "Valid Image",
          description: "Has primary image",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "/products/valid.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<g:image_link>https://storefront.example.test/cdn-cgi/image/width=1200/products/valid.jpg</g:image_link>",
    );
  });

  it("skips products whose optimized image URL is not an http URL", async () => {
    mocks.getOptimizedImageUrl.mockReturnValueOnce(
      "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    );
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_data_image",
          slug: "data-image",
          name: "Data Image",
          description: "Invalid catalog image",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          availableForSale: true,
          imageUrl: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<item>");
    expect(body).not.toContain("<g:image_link>");
  });

  it("keeps page one as valid empty XML when every product is image-ineligible", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_no_image",
          slug: "no-image",
          name: "No Image",
          description: "Missing primary image",
          price: 900,
          discountedPrice: 900,
          isActive: true,
          availableForSale: true,
          imageUrl: null,
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(body).toContain("<rss");
    expect(body).not.toContain("<item>");
    expect(body).not.toContain("<g:image_link>");
  });

  it("returns a no-store 404 without fetching products when catalog feed is disabled", async () => {
    mocks.getSeoSettings.mockResolvedValueOnce({
      discovery: {
        feeds: {
          productCatalogEnabled: false,
        },
      },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Product catalog feed is disabled");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("fails closed when a later feed product page cannot be read", async () => {
    mocks.getFeedProducts
      .mockResolvedValueOnce({
        data: [
          {
            id: "prod_1",
            slug: "hilsa",
            name: "Hilsa",
            description: "Fresh hilsa",
            price: 1200,
            discountedPrice: 1200,
            isActive: true,
          },
        ],
        pagination: { page: 1, limit: 100, total: 101, totalPages: 2 },
      })
      .mockResolvedValueOnce(null);

    const response = await GET(
      context("https://storefront.example.test/api/facebook-feed.xml?limit=200"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns a non-cacheable 503 when feed generation throws unexpectedly", async () => {
    mocks.getLayoutData.mockRejectedValueOnce(new Error("layout unavailable"));

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toContain("Facebook product feed is temporarily unavailable");
  });
});
