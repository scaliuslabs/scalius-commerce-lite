import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import type { StorefrontFeedProduct } from "./products.types";
import {
  PRODUCT_FEED_ROW_PREVIEW_HARD_RESPONSE_BYTES,
  PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT,
  PRODUCT_FEED_ROW_PREVIEW_MAX_OUTCOMES,
  executeProductFeedRowPreview,
  readProductFeedRowPreviewSource,
  type ProductFeedRowPreviewSourceReaders,
} from "./products.feed-row-preview";

const db = {} as Database;

function product(
  overrides: Partial<StorefrontFeedProduct> = {},
): StorefrontFeedProduct {
  return {
    id: "prod_feed_1",
    name: "Cotton Shirt",
    slug: "cotton-shirt",
    canonicalPath: "/products/canonical-shirt",
    options: [
      {
        id: "opt_size",
        name: "Size",
        position: 0,
        standardMapping: "size",
      },
    ],
    description: "<p>Soft cotton.</p>",
    price: 1_000,
    discountType: "flat",
    discountPercentage: null,
    discountAmount: 100,
    discountedPrice: 900,
    freeDelivery: true,
    categoryId: "cat_electronics",
    excludeFromProductFeed: false,
    productCondition: "new",
    hasVariants: true,
    availableForSale: true,
    imageUrl: "products/cotton-shirt/main.jpg",
    imageMediaId: "media_primary",
    imageAlt: "Cotton shirt",
    category: {
      id: "cat_electronics",
      name: "Electronics",
      slug: "electronics",
    },
    attributes: [
      { name: "Brand", slug: "brand", value: "Scalius" },
      { name: "Material", slug: "material", value: "Cotton" },
    ],
    variants: [
      {
        id: "var_small",
        productId: "prod_feed_1",
        optionCombinationKey: "oval_small",
        imageId: "pmed_variant",
        imageMediaId: "media_variant",
        imageUrl: "products/cotton-shirt/small.jpg",
        selectedOptions: [
          {
            optionDefinitionId: "opt_size",
            optionValueId: "oval_small",
            name: "Size",
            value: "Small",
            position: 0,
            valuePosition: 0,
            standardMapping: "size",
          },
        ],
        weight: null,
        sku: "SHIRT-S",
        price: 1_000,
        stock: 10,
        reservedStock: 0,
        lowStockThreshold: 2,
        availabilityBand: "in_stock",
        isDefault: false,
        trackInventory: true,
        barcode: "1234567890123",
        barcodeType: "ean13",
        discountType: "flat",
        discountPercentage: null,
        discountAmount: 100,
        deletedAt: null,
      },
    ],
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function readers(
  eligible: StorefrontFeedProduct | null,
  diagnostic: Awaited<
    ReturnType<ProductFeedRowPreviewSourceReaders["readDiagnostic"]>
  > = null,
): ProductFeedRowPreviewSourceReaders {
  return {
    readEligible: vi.fn(async () => eligible),
    readDiagnostic: vi.fn(async () => diagnostic),
  };
}

function previewInput(
  overrides: Partial<
    Parameters<typeof executeProductFeedRowPreview>[0]
  > = {},
) {
  return {
    db,
    productId: "prod_feed_1",
    currencyCode: "BDT",
    storefrontBaseUrl: "https://shop.example.com",
    feedsPolicy: {
      productCatalogEnabled: true,
      includeUnavailableProducts: true,
      variantStrategy: "variants" as const,
      title: "",
      description: "",
    },
    mediaPolicy: {
      enabled: true,
      canonicalCdnUrl: "cdn.example.com",
      allowedImageHosts: ["legacy.example.com"],
      canonicalHostAliases: ["old-cdn.example.com"],
    },
    readers: readers(product()),
    ...overrides,
  };
}

describe("product feed row preview", () => {
  it("uses eligible authority first and runs fallback only after absence", async () => {
    const calls: string[] = [];
    const sourceReaders: ProductFeedRowPreviewSourceReaders = {
      readEligible: vi.fn(async () => {
        calls.push("eligible");
        return null;
      }),
      readDiagnostic: vi.fn(async () => {
        calls.push("diagnostic");
        return {
          productId: "prod_feed_1",
          isActive: true,
          isDeleted: false,
          excludeFromProductFeed: true,
          hasBuyerResolvableSku: true,
          hasPrimaryDiscoveryImage: true,
          matchingSkuCount: 0,
        };
      }),
    };

    const result = await readProductFeedRowPreviewSource(
      db,
      "prod_feed_1",
      "",
      sourceReaders,
    );
    expect(calls).toEqual(["eligible", "diagnostic"]);
    expect(result.kind).toBe("diagnostic");

    calls.length = 0;
    sourceReaders.readEligible = vi.fn(async () => {
      calls.push("eligible");
      return product();
    });
    await readProductFeedRowPreviewSource(
      db,
      "prod_feed_1",
      "",
      sourceReaders,
    );
    expect(calls).toEqual(["eligible"]);
  });

  it("returns the complete shared row with canonical, variant-image, taxonomy, option, price, and shipping parity", async () => {
    const result = await executeProductFeedRowPreview(previewInput());
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.status).toBe("emitted");
    if (entry.status !== "emitted") return;

    expect(entry.row).toMatchObject({
      kind: "variant",
      productId: "prod_feed_1",
      variantId: "var_small",
      id: "SHIRT-S",
      title: "Cotton Shirt - Size: Small",
      description: "Soft cotton.",
      link: "https://shop.example.com/products/canonical-shirt?variant=var_small",
      availability: {
        canonical: "in_stock",
        google: "in_stock",
        meta: "in stock",
      },
      condition: "new",
      pricing: {
        currencyCode: "BDT",
        originalAmount: 1_000,
        currentAmount: 900,
        price: "1000.00 BDT",
        salePrice: "900.00 BDT",
        currentPrice: "900.00 BDT",
      },
      brand: "Scalius",
      gtin: "1234567890123",
      identifierExists: null,
      itemGroupId: "prod_feed_1",
      itemGroupTitle: "Cotton Shirt",
      variantOptions: [{ name: "Size", value: "Small" }],
      googleProductCategory: "Electronics",
      facebookProductCategory: "Electronics & Accessories",
      productType: "Electronics",
      shipping: {
        country: "BD",
        service: "Standard",
        price: "0.00 BDT",
      },
    });
    expect(entry.row.standardAttributes).toEqual([
      { name: "size", value: "Small" },
      { name: "material", value: "Cotton" },
    ]);
    expect(entry.row.imageLink).toMatch(
      /^https:\/\/cdn\.example\.com\/cdn-cgi\/image\/[^/]*width=1200[^/]*quality=90[^/]*format=auto[^/]*fit=scale-down[^/]*\/products\/cotton-shirt\/small\.jpg$/u,
    );
    expect(result.semantics).toEqual({
      basis: "current_saved_state",
      emittedRowsAreExact: true,
      entryFieldsTruncated: false,
      cachedFeedPropagationVerified: false,
      providerAcceptanceVerified: false,
      pagesMayRaceWithWrites: true,
      responseBudgetBytes: 46 * 1024,
    });
  });

  it.each([
    [
      "excluded_from_product_feed",
      {
        isActive: true,
        isDeleted: false,
        excludeFromProductFeed: true,
        hasBuyerResolvableSku: true,
        hasPrimaryDiscoveryImage: true,
      },
    ],
    [
      "missing_image",
      {
        isActive: true,
        isDeleted: false,
        excludeFromProductFeed: false,
        hasBuyerResolvableSku: true,
        hasPrimaryDiscoveryImage: false,
      },
    ],
    [
      "unresolved_variant_shape",
      {
        isActive: true,
        isDeleted: false,
        excludeFromProductFeed: false,
        hasBuyerResolvableSku: false,
        hasPrimaryDiscoveryImage: true,
      },
    ],
  ])("uses diagnostic evidence for %s without projecting fallback rows", async (reason, diagnostic) => {
    const sourceReaders = readers(null, {
      productId: "prod_feed_1",
      matchingSkuCount: 0,
      ...diagnostic,
    });
    const result = await executeProductFeedRowPreview(
      previewInput({ readers: sourceReaders }),
    );
    expect(result.entries).toEqual([
      {
        status: "omitted",
        productId: "prod_feed_1",
        variantId: null,
        sku: null,
        reason,
      },
    ]);
  });

  it("reports non-positive and unavailable SKU outcomes from the shared projector", async () => {
    const variants = [
      {
        ...product().variants[0]!,
        price: 0,
      },
      {
        ...product().variants[0]!,
        id: "var_large",
        sku: "SHIRT-L",
        optionCombinationKey: "oval_large",
        selectedOptions: [
          {
            ...product().variants[0]!.selectedOptions[0]!,
            optionValueId: "oval_large",
            value: "Large",
            valuePosition: 1,
          },
        ],
        availabilityBand: "out_of_stock" as const,
        stock: 0,
      },
    ];
    const result = await executeProductFeedRowPreview(
      previewInput({
        readers: readers(product({ variants })),
        feedsPolicy: {
          ...previewInput().feedsPolicy,
          includeUnavailableProducts: false,
        },
      }),
    );
    expect(result.entries.map((entry) => [entry.sku, entry.status, "reason" in entry ? entry.reason : null])).toEqual([
      ["SHIRT-S", "omitted", "non_positive_price"],
      ["SHIRT-L", "omitted", "unavailable_variant"],
    ]);
  });

  it("normalizes an exact SKU and returns at most one outcome", async () => {
    const variants = [
      product().variants[0]!,
      {
        ...product().variants[0]!,
        id: "var_large",
        sku: "SHIRT-L",
        optionCombinationKey: "oval_large",
      },
    ];
    const result = await executeProductFeedRowPreview(
      previewInput({
        sku: " shirt-l ",
        readers: readers(product({ variants })),
      }),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      status: "emitted",
      variantId: "var_large",
      sku: "SHIRT-L",
    });
  });

  it("keeps product-strategy rows product-scoped after exact SKU validation", async () => {
    const result = await executeProductFeedRowPreview(
      previewInput({
        sku: "shirt-s",
        feedsPolicy: {
          ...previewInput().feedsPolicy,
          variantStrategy: "products",
        },
      }),
    );
    expect(result.requestedSku).toBe("shirt-s");
    expect(result.entries).toEqual([
      expect.objectContaining({
        status: "emitted",
        variantId: null,
        sku: null,
      }),
    ]);
  });

  it("lets disabled feed policy dominate without product or enrichment reads", async () => {
    const sourceReaders = readers(product());
    const result = await executeProductFeedRowPreview(
      previewInput({
        readers: sourceReaders,
        feedsPolicy: {
          ...previewInput().feedsPolicy,
          productCatalogEnabled: false,
        },
      }),
    );
    expect(result.entries).toEqual([
      expect.objectContaining({
        status: "omitted",
        reason: "feed_disabled",
      }),
    ]);
    expect(sourceReaders.readEligible).not.toHaveBeenCalled();
    expect(sourceReaders.readDiagnostic).not.toHaveBeenCalled();
  });

  it("lets an unavailable storefront URL dominate without product or enrichment reads", async () => {
    const sourceReaders = readers(product());
    const result = await executeProductFeedRowPreview(
      previewInput({
        readers: sourceReaders,
        storefrontBaseUrl: "not an absolute storefront URL",
      }),
    );
    expect(result.entries).toEqual([
      expect.objectContaining({
        status: "omitted",
        reason: "storefront_url_unavailable",
      }),
    ]);
    expect(sourceReaders.readEligible).not.toHaveBeenCalled();
    expect(sourceReaders.readDiagnostic).not.toHaveBeenCalled();
  });

  it("rejects malformed cursors before any D1 reader", async () => {
    const sourceReaders = readers(product());
    await expect(
      executeProductFeedRowPreview(
        previewInput({ readers: sourceReaders, cursor: "not-a-cursor" }),
      ),
    ).rejects.toThrow(/Invalid feed preview cursor/u);
    expect(sourceReaders.readEligible).not.toHaveBeenCalled();
    expect(sourceReaders.readDiagnostic).not.toHaveBeenCalled();
  });

  it("paginates the complete stable emitted-or-omitted outcome sequence and rejects stale context", async () => {
    const variants = [
      product().variants[0]!,
      {
        ...product().variants[0]!,
        id: "var_medium",
        sku: "SHIRT-M",
        optionCombinationKey: "oval_medium",
        availabilityBand: "out_of_stock" as const,
        stock: 0,
      },
      {
        ...product().variants[0]!,
        id: "var_large",
        sku: "SHIRT-L",
        optionCombinationKey: "oval_large",
        availabilityBand: "out_of_stock" as const,
        stock: 0,
      },
    ];
    const input = previewInput({
      limit: 1,
      readers: readers(product({ variants })),
      feedsPolicy: {
        ...previewInput().feedsPolicy,
        includeUnavailableProducts: false,
      },
    });
    const first = await executeProductFeedRowPreview(input);
    expect(first.entries.map((entry) => entry.sku)).toEqual(["SHIRT-S"]);
    expect(first.pagination).toMatchObject({
      returned: 1,
      totalOutcomes: 3,
      hasNextPage: true,
    });

    const second = await executeProductFeedRowPreview({
      ...input,
      cursor: first.pagination.nextCursor!,
    });
    expect(second.entries).toEqual([
      expect.objectContaining({
        status: "omitted",
        sku: "SHIRT-M",
        reason: "unavailable_variant",
      }),
    ]);

    await expect(
      executeProductFeedRowPreview({
        ...input,
        cursor: first.pagination.nextCursor!,
        feedsPolicy: {
          ...input.feedsPolicy,
          variantStrategy: "products",
        },
      }),
    ).rejects.toThrow(/stale|does not match/u);

    const [prefix, encodedPayload] = first.pagination.nextCursor!.split(".");
    const tamperedPayload = JSON.parse(
      Buffer.from(encodedPayload!, "base64url").toString("utf8"),
    ) as { position: number };
    tamperedPayload.position += 1;
    const tamperedCursor = `${prefix}.${Buffer.from(
      JSON.stringify(tamperedPayload),
    ).toString("base64url")}`;
    await expect(
      executeProductFeedRowPreview({ ...input, cursor: tamperedCursor }),
    ).rejects.toThrow(/stale|does not match/u);
  });

  it("replaces an exact oversized entry and keeps the final success envelope bounded", async () => {
    const result = await executeProductFeedRowPreview(
      previewInput({
        readers: readers(
          product({ description: "x".repeat(60 * 1024) }),
        ),
      }),
    );
    expect(result.entries).toEqual([
      expect.objectContaining({
        status: "preview_entry_too_large",
        productId: "prod_feed_1",
        variantId: "var_small",
        sku: "SHIRT-S",
        requiredBytes: expect.any(Number),
      }),
    ]);
    expect("row" in result.entries[0]!).toBe(false);
    expect(
      new TextEncoder().encode(
        JSON.stringify({ success: true, data: result }),
      ).byteLength,
    ).toBeLessThanOrEqual(PRODUCT_FEED_ROW_PREVIEW_HARD_RESPONSE_BYTES);
  });

  it("keeps large-row outcomes at ten per page and the 250-outcome contract within 25 calls", async () => {
    const variants = Array.from({ length: 26 }, (_, index) => ({
      ...product().variants[0]!,
      id: `var_${index}`,
      sku: `SHIRT-${index}`,
      optionCombinationKey: `oval_${index}`,
      selectedOptions: [
        {
          ...product().variants[0]!.selectedOptions[0]!,
          optionValueId: `oval_${index}`,
          value: `Size ${index}`,
          valuePosition: index,
        },
      ],
    }));
    const input = previewInput({
      limit: PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT,
      readers: readers(
        product({ description: "x".repeat(40 * 1024), variants }),
      ),
    });

    const first = await executeProductFeedRowPreview(input);
    const second = await executeProductFeedRowPreview({
      ...input,
      cursor: first.pagination.nextCursor!,
    });
    const third = await executeProductFeedRowPreview({
      ...input,
      cursor: second.pagination.nextCursor!,
    });

    expect([
      first.pagination.returned,
      second.pagination.returned,
      third.pagination.returned,
    ]).toEqual([10, 10, 6]);
    expect(third.pagination.nextCursor).toBeNull();
    for (const result of [first, second, third]) {
      expect(result.entries.every(
        (entry) => entry.status === "preview_entry_too_large",
      )).toBe(true);
      expect(result.pagination.responseTruncated).toBe(false);
    }
    expect(
      Math.ceil(
        PRODUCT_FEED_ROW_PREVIEW_MAX_OUTCOMES /
          PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT,
      ),
    ).toBe(25);
  });

  it("fails closed on malformed saved discount types instead of casting them", async () => {
    await expect(
      executeProductFeedRowPreview(
        previewInput({
          readers: readers(product({ discountType: "mystery" })),
        }),
      ),
    ).rejects.toThrow(/discount type is unreadable/u);
  });
});
