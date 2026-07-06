import { describe, expect, it } from "vitest";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import {
    buildProductFeedDiagnosticsFromScan,
    type ProductFeedDiagnosticReason,
    type ProductFeedDiagnosticScanProduct,
    type ProductFeedDiagnosticScanVariant,
} from "./products.feed-diagnostics";

const baseFeedsPolicy: SeoDiscoverySettings["feeds"] = {
    productCatalogEnabled: true,
    includeUnavailableProducts: false,
    variantStrategy: "variants",
    title: "",
    description: "",
};

function product(
    id: string,
    overrides: Partial<ProductFeedDiagnosticScanProduct> = {},
): ProductFeedDiagnosticScanProduct {
    return {
        id,
        name: `Product ${id}`,
        slug: `product-${id}`,
        isActive: true,
        deletedAt: null,
        ...overrides,
    };
}

function variant(
    id: string,
    productId: string,
    overrides: Partial<ProductFeedDiagnosticScanVariant> = {},
): ProductFeedDiagnosticScanVariant {
    return {
        id,
        productId,
        size: null,
        color: null,
        stock: 0,
        reservedStock: 0,
        isDefault: false,
        trackInventory: false,
        ...overrides,
    };
}

function reasonCount(
    report: ReturnType<typeof buildProductFeedDiagnosticsFromScan>,
    reason: ProductFeedDiagnosticReason,
) {
    return report.reasons.find((entry) => entry.reason === reason)!;
}

describe("product feed diagnostics", () => {
    it("emits product and variant rows according to feed policy", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("simple"), product("optioned")],
            primaryImageUrls: new Map([
                ["simple", "/simple.jpg"],
                ["optioned", "https://cdn.example.test/optioned.jpg"],
            ]),
            variants: new Map([
                [
                    "simple",
                    [
                        variant("var_simple", "simple", {
                            isDefault: true,
                            trackInventory: false,
                        }),
                    ],
                ],
                [
                    "optioned",
                    [
                        variant("var_red", "optioned", {
                            color: "Red",
                            trackInventory: true,
                            stock: 3,
                        }),
                        variant("var_blue", "optioned", {
                            color: "Blue",
                            trackInventory: true,
                            stock: 1,
                            reservedStock: 1,
                        }),
                    ],
                ],
            ]),
            feedsPolicy: baseFeedsPolicy,
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 5,
            storefrontBaseUrl: "https://store.example.test",
        });

        expect(report.totals).toMatchObject({
            emittedRows: 2,
            emittedProductRows: 1,
            emittedVariantRows: 1,
            skippedRows: 1,
        });
        expect(reasonCount(report, "unavailable_excluded")).toMatchObject({
            products: 1,
            rows: 1,
        });
    });

    it("counts product-level feed blockers with safe samples", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [
                product("inactive", { isActive: false }),
                product("sku_less"),
                product("image_less"),
            ],
            primaryImageUrls: new Map([["image_less", null]]),
            variants: new Map([
                [
                    "image_less",
                    [
                        variant("var_image_less", "image_less", {
                            isDefault: true,
                            trackInventory: false,
                        }),
                    ],
                ],
            ]),
            feedsPolicy: baseFeedsPolicy,
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 1,
            storefrontBaseUrl: "https://store.example.test",
        });

        expect(reasonCount(report, "inactive_deleted_unpublished")).toMatchObject({
            products: 1,
        });
        expect(reasonCount(report, "no_buyer_sku")).toMatchObject({
            products: 1,
        });
        expect(reasonCount(report, "missing_image")).toMatchObject({
            products: 1,
            rows: 1,
            samples: [
                {
                    id: "image_less",
                    name: "Product image_less",
                    slug: "product-image_less",
                    reason: "missing_image",
                },
            ],
        });
        expect(report.totals.productsWithIssues).toBe(3);
    });

    it("marks scanned products as feed disabled without reading row availability", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("one"), product("two")],
            primaryImageUrls: new Map(),
            variants: new Map(),
            feedsPolicy: { ...baseFeedsPolicy, productCatalogEnabled: false },
            scanLimit: 10,
            truncated: true,
            sampleLimitPerReason: 5,
        });

        expect(report.scan).toMatchObject({
            limit: 10,
            scannedProducts: 2,
            truncated: true,
        });
        expect(report.totals).toMatchObject({
            emittedRows: 0,
            productsWithIssues: 2,
        });
        expect(reasonCount(report, "feed_disabled")).toMatchObject({
            products: 2,
            rows: 0,
        });
    });
});
