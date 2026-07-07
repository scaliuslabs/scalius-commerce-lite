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

describe("Facebook product feed route", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getSeoSettings.mockReset();
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
            {
              id: "var_red_m",
              productId: "prod_shirt",
              size: "M",
              color: "Red",
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
            },
            {
              id: "var_blue_l",
              productId: "prod_shirt",
              size: "L",
              color: "Blue",
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
            },
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
    expect(body).not.toContain("<g:id>prod_shirt</g:id>");
    expect(body).toContain("<g:item_group_id>prod_shirt</g:item_group_id>");
    expect(body).toContain(
      "<g:title>Linen Shirt - Size: M / Color: Red</g:title>",
    );
    expect(body).toContain(
      "<g:link>https://storefront.example.test/products/linen-shirt?size=M&amp;color=Red</g:link>",
    );
    expect(body).toContain("<g:price>900.00 BDT</g:price>");
    expect(body).toContain("<g:sale_price>900.00 BDT</g:sale_price>");
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
          variantOption1Label: "Weight",
          variantOption2Label: "Style",
          variantOption1Schema: "none",
          variantOption2Schema: "pattern",
          variants: [
            {
              id: "var_pack_premium",
              productId: "prod_pack",
              size: "2KG",
              color: "Premium",
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
    expect(body).toContain(
      "<g:title>Premium Pack - Weight: 2KG / Style: Premium</g:title>",
    );
    expect(body).toContain("<g:item_group_title>Premium Pack</g:item_group_title>");
    expect(body).toContain("<g:name>Weight</g:name>");
    expect(body).toContain("<g:value>2KG</g:value>");
    expect(body).toContain("<g:name>Style</g:name>");
    expect(body).toContain("<g:value>Premium</g:value>");
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
          canonicalPath: "/shop/linen-shirt",
          name: "Linen Shirt",
          description: "Soft shirt",
          price: 1200,
          discountedPrice: 1200,
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/shirt.jpg",
          variants: [
            {
              id: "var_red_m",
              productId: "prod_shirt",
              size: "M",
              color: "Red",
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
    expect(body).toContain(
      "<g:link>https://storefront.example.test/shop/linen-shirt?size=M&amp;color=Red</g:link>",
    );
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
            {
              id: "var_a",
              productId: "prod_bundle",
              size: "A",
              color: "Red",
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
            },
            {
              id: "var_b",
              productId: "prod_bundle",
              size: "B",
              color: "Blue",
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
            },
            {
              id: "var_c",
              productId: "prod_bundle",
              size: "C",
              color: "Green",
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
            },
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
          isActive: true,
          hasVariants: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/shirt.jpg",
          variants: [
            {
              id: "var_red_m",
              productId: "prod_shirt",
              size: "M",
              color: "Red",
              sku: "SKU-RED-M",
              price: 1000,
              stock: 4,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
            },
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
    expect(body).toContain("<g:price>1100.00 BDT</g:price>");
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
              size: null,
              color: null,
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
            {
              id: "var_red_m",
              productId: "prod_shirt",
              size: "M",
              color: "Red",
              sku: "SKU-RED-M",
              price: 1000,
              stock: 3,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
            },
            {
              id: "var_blue_l",
              productId: "prod_shirt",
              size: "L",
              color: "Blue",
              sku: "SKU-BLUE-L",
              price: 1100,
              stock: 0,
              reservedStock: 0,
              trackInventory: true,
              isDefault: false,
              deletedAt: null,
            },
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

  it("emits zero discounted prices without falling back to the original price", async () => {
    mocks.getFeedProducts.mockResolvedValueOnce({
      data: [
        {
          id: "prod_free",
          slug: "free-sample",
          name: "Free Sample",
          description: "Fully discounted item",
          price: 1200,
          discountedPrice: 0,
          isActive: true,
          availableForSale: true,
          imageUrl: "https://cdn.example.test/products/free.jpg",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<g:price>0.00 BDT</g:price>");
    expect(body).toContain("<g:sale_price>0.00 BDT</g:sale_price>");
    expect(body).not.toContain("<g:price>1200.00 BDT</g:price>");
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
