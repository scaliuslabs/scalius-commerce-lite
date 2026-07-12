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
        excludeFromProductFeed: false,
        deletedAt: null,
        price: 1200,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
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
        optionCombinationKey: null,
        stock: 0,
        reservedStock: 0,
        isDefault: false,
        trackInventory: false,
        price: 1200,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
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
                            optionCombinationKey: "red",
                            trackInventory: true,
                            stock: 3,
                        }),
                        variant("var_blue", "optioned", {
                            optionCombinationKey: "blue",
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

    it("reports product-level feed exclusions before other product blockers", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [
                product("excluded", {
                    excludeFromProductFeed: true,
                    isActive: false,
                }),
            ],
            primaryImageUrls: new Map(),
            variants: new Map(),
            feedsPolicy: baseFeedsPolicy,
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 5,
            storefrontBaseUrl: "https://store.example.test",
        });

        expect(reasonCount(report, "product_feed_excluded")).toMatchObject({
            products: 1,
            rows: 0,
            samples: [
                {
                    id: "excluded",
                    name: "Product excluded",
                    slug: "product-excluded",
                    reason: "product_feed_excluded",
                },
            ],
        });
        expect(reasonCount(report, "inactive_deleted_unpublished")).toMatchObject({
            products: 0,
        });
        expect(report.totals.productsWithIssues).toBe(1);
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

    it.each([
        ["variants", 1],
        ["products", 1],
    ] as const)(
        "reports mixed option-axis topology before %s feed rows are emitted",
        (variantStrategy, expectedRows) => {
            const report = buildProductFeedDiagnosticsFromScan({
                products: [product("mixed_axes")],
                primaryImageUrls: new Map([
                    ["mixed_axes", "/mixed.jpg"],
                ]),
                variants: new Map([
                    [
                        "mixed_axes",
                        [
                            variant("var_size_42", "mixed_axes", {
                                optionCombinationKey: "42",
                                stock: 4,
                                trackInventory: true,
                            }),
                            variant("var_size_41_green", "mixed_axes", {
                                optionCombinationKey: null,
                                stock: 4,
                                trackInventory: true,
                            }),
                        ],
                    ],
                ]),
                feedsPolicy: { ...baseFeedsPolicy, variantStrategy },
                scanLimit: 500,
                truncated: false,
                sampleLimitPerReason: 5,
                storefrontBaseUrl: "https://store.example.test",
            });

            expect(report.totals).toMatchObject({
                emittedRows: 0,
                productsWithIssues: 1,
                skippedRows: expectedRows,
            });
            expect(reasonCount(report, "inconsistent_option_axes")).toMatchObject({
                products: 1,
                rows: expectedRows,
                samples: [
                    expect.objectContaining({
                        id: "mixed_axes",
                        reason: "inconsistent_option_axes",
                    }),
                ],
            });
            expect(reasonCount(report, "no_buyer_sku")).toMatchObject({
                products: 0,
                rows: 0,
            });
        },
    );

    it("reports a non-positive product-row price", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("free_product", { price: 0 })],
            primaryImageUrls: new Map([
                ["free_product", "/free.jpg"],
            ]),
            variants: new Map([
                [
                    "free_product",
                    [
                        variant("var_free", "free_product", {
                            isDefault: true,
                            price: 0,
                        }),
                    ],
                ],
            ]),
            feedsPolicy: { ...baseFeedsPolicy, variantStrategy: "products" },
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 5,
            storefrontBaseUrl: "https://store.example.test",
        });

        expect(report.totals).toMatchObject({
            emittedRows: 0,
            productsWithIssues: 1,
            skippedRows: 1,
        });
        expect(reasonCount(report, "non_positive_price")).toMatchObject({
            products: 1,
            rows: 1,
        });
    });

    it.each([
        ["BDT", 0.004],
        ["JPY", 0.4],
    ])("reports a %s product price that quantizes to zero", (currencyCode, price) => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("rounded_free_product", { price })],
            primaryImageUrls: new Map([
                ["rounded_free_product", "/rounded-free.jpg"],
            ]),
            variants: new Map([
                [
                    "rounded_free_product",
                    [
                        variant("var_rounded_free", "rounded_free_product", {
                            isDefault: true,
                            price,
                        }),
                    ],
                ],
            ]),
            feedsPolicy: { ...baseFeedsPolicy, variantStrategy: "products" },
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 5,
            storefrontBaseUrl: "https://store.example.test",
            currencyCode,
        });

        expect(report.totals).toMatchObject({
            emittedRows: 0,
            productsWithIssues: 1,
            skippedRows: 1,
        });
        expect(reasonCount(report, "non_positive_price")).toMatchObject({
            products: 1,
            rows: 1,
        });
    });

    it("uses checkout discount order at the exact 1.005 catalog boundary", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("rounding_boundary", {
                price: 1.005,
                discountType: "percentage",
                discountPercentage: 10,
            })],
            primaryImageUrls: new Map([
                ["rounding_boundary", "/rounding-boundary.jpg"],
            ]),
            variants: new Map([
                [
                    "rounding_boundary",
                    [
                        variant("var_rounding_boundary", "rounding_boundary", {
                            isDefault: true,
                            price: 1.005,
                        }),
                    ],
                ],
            ]),
            feedsPolicy: { ...baseFeedsPolicy, variantStrategy: "products" },
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 5,
            storefrontBaseUrl: "https://store.example.test",
            currencyCode: "BDT",
        });

        expect(report.totals).toMatchObject({
            emittedRows: 1,
            productsWithIssues: 0,
            skippedRows: 0,
        });
        expect(reasonCount(report, "non_positive_price")).toMatchObject({
            products: 0,
            rows: 0,
        });
    });

    it("reports exponent-form legacy prices as non-positive feed money", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("exponent_price", { price: 1e21 })],
            primaryImageUrls: new Map([
                ["exponent_price", "/exponent-price.jpg"],
            ]),
            variants: new Map([
                [
                    "exponent_price",
                    [
                        variant("var_exponent_price", "exponent_price", {
                            isDefault: true,
                            price: 1e21,
                        }),
                    ],
                ],
            ]),
            feedsPolicy: { ...baseFeedsPolicy, variantStrategy: "products" },
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 5,
            storefrontBaseUrl: "https://store.example.test",
            currencyCode: "BDT",
        });

        expect(report.totals).toMatchObject({
            emittedRows: 0,
            productsWithIssues: 1,
            skippedRows: 1,
        });
        expect(reasonCount(report, "non_positive_price")).toMatchObject({
            products: 1,
            rows: 1,
        });
    });

    it("counts only non-positive effective variant rows as skipped", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("variant_prices", { price: 100 })],
            primaryImageUrls: new Map([
                ["variant_prices", "/variants.jpg"],
            ]),
            variants: new Map([
                [
                    "variant_prices",
                    [
                        variant("var_free", "variant_prices", {
                            optionCombinationKey: "small",
                            price: 100,
                            discountType: "flat",
                            discountAmount: 100,
                        }),
                        variant("var_paid", "variant_prices", {
                            optionCombinationKey: "medium",
                            price: 100,
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
            emittedRows: 1,
            emittedVariantRows: 1,
            productsWithIssues: 1,
            skippedRows: 1,
        });
        expect(reasonCount(report, "non_positive_price")).toMatchObject({
            products: 1,
            rows: 1,
        });
    });

    it.each([
        ["missing", null],
        ["relative", "/shop"],
        ["non-http", "ftp://store.example.test"],
    ])("blocks otherwise ready rows when the storefront URL is %s", (_label, storefrontBaseUrl) => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("simple"), product("absolute_image")],
            primaryImageUrls: new Map([
                ["simple", "/simple.jpg"],
                ["absolute_image", "https://cdn.example.test/absolute.jpg"],
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
                    "absolute_image",
                    [
                        variant("var_absolute", "absolute_image", {
                            isDefault: true,
                            trackInventory: false,
                        }),
                    ],
                ],
            ]),
            feedsPolicy: baseFeedsPolicy,
            scanLimit: 500,
            truncated: false,
            sampleLimitPerReason: 5,
            storefrontBaseUrl,
        });

        expect(report.totals).toMatchObject({
            emittedRows: 0,
            skippedRows: 2,
            productsWithIssues: 2,
        });
        expect(reasonCount(report, "storefront_url_unavailable")).toMatchObject({
            products: 2,
            rows: 2,
            samples: [
                {
                    id: "simple",
                    name: "Product simple",
                    slug: "product-simple",
                    reason: "storefront_url_unavailable",
                },
                {
                    id: "absolute_image",
                    name: "Product absolute_image",
                    slug: "product-absolute_image",
                    reason: "storefront_url_unavailable",
                },
            ],
        });
        expect(reasonCount(report, "missing_image")).toMatchObject({
            products: 0,
            rows: 0,
        });
    });

    it("counts unavailable rows before storefront URL blockers", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [product("sold_out")],
            primaryImageUrls: new Map([["sold_out", "/sold-out.jpg"]]),
            variants: new Map([
                [
                    "sold_out",
                    [
                        variant("var_sold_out", "sold_out", {
                            isDefault: true,
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
            storefrontBaseUrl: null,
        });

        expect(report.totals).toMatchObject({
            emittedRows: 0,
            skippedRows: 1,
            productsWithIssues: 1,
        });
        expect(reasonCount(report, "unavailable_excluded")).toMatchObject({
            products: 1,
            rows: 1,
        });
        expect(reasonCount(report, "storefront_url_unavailable")).toMatchObject({
            products: 0,
            rows: 0,
        });
    });

    it("uses the catalog discovery image contract for missing-image diagnostics", () => {
        const report = buildProductFeedDiagnosticsFromScan({
            products: [
                product("protocol_relative"),
                product("unsafe_path"),
                product("valid_relative"),
            ],
            primaryImageUrls: new Map([
                ["protocol_relative", "//cdn.example.test/product.jpg"],
                ["unsafe_path", "products\\main.jpg"],
                ["valid_relative", "/products/main.jpg"],
            ]),
            variants: new Map([
                [
                    "protocol_relative",
                    [
                        variant("var_protocol", "protocol_relative", {
                            isDefault: true,
                            trackInventory: false,
                        }),
                    ],
                ],
                [
                    "unsafe_path",
                    [
                        variant("var_unsafe", "unsafe_path", {
                            isDefault: true,
                            trackInventory: false,
                        }),
                    ],
                ],
                [
                    "valid_relative",
                    [
                        variant("var_valid", "valid_relative", {
                            isDefault: true,
                            trackInventory: false,
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
            emittedRows: 1,
            skippedRows: 2,
            productsWithIssues: 2,
        });
        expect(reasonCount(report, "missing_image")).toMatchObject({
            products: 2,
            rows: 2,
        });
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
