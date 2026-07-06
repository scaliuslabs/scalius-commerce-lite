import { productImages, products, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

export const PRODUCT_FEED_DIAGNOSTIC_SCAN_LIMIT = 500;
export const PRODUCT_FEED_DIAGNOSTIC_MAX_SCAN_LIMIT = 500;
export const PRODUCT_FEED_DIAGNOSTIC_SAMPLE_LIMIT = 5;
export const PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT = 10;

export const PRODUCT_FEED_DIAGNOSTIC_REASONS = [
    "feed_disabled",
    "storefront_url_unavailable",
    "inactive_deleted_unpublished",
    "no_buyer_sku",
    "missing_image",
    "unavailable_excluded",
] as const;

export type ProductFeedDiagnosticReason = typeof PRODUCT_FEED_DIAGNOSTIC_REASONS[number];

export interface ProductFeedDiagnosticSample {
    id: string;
    name: string;
    slug: string;
    reason: ProductFeedDiagnosticReason;
}

export interface ProductFeedDiagnosticReasonSummary {
    reason: ProductFeedDiagnosticReason;
    products: number;
    rows: number;
    samples: ProductFeedDiagnosticSample[];
}

export interface ProductFeedDiagnosticsReport {
    policy: {
        productCatalogEnabled: boolean;
        includeUnavailableProducts: boolean;
        variantStrategy: SeoDiscoverySettings["feeds"]["variantStrategy"];
    };
    scan: {
        limit: number;
        scannedProducts: number;
        truncated: boolean;
        sampleLimitPerReason: number;
    };
    totals: {
        emittedRows: number;
        emittedProductRows: number;
        emittedVariantRows: number;
        productsWithIssues: number;
        skippedRows: number;
    };
    reasons: ProductFeedDiagnosticReasonSummary[];
}

export interface ProductFeedDiagnosticScanProduct {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    deletedAt: number | null;
}

export interface ProductFeedDiagnosticScanVariant {
    id: string;
    productId: string;
    size: string | null;
    color: string | null;
    stock: number;
    reservedStock: number;
    isDefault: boolean;
    trackInventory: boolean;
}

export interface ProductFeedDiagnosticScanInput {
    products: ProductFeedDiagnosticScanProduct[];
    primaryImageUrls: Map<string, string | null>;
    variants: Map<string, ProductFeedDiagnosticScanVariant[]>;
    feedsPolicy: SeoDiscoverySettings["feeds"];
    scanLimit: number;
    truncated: boolean;
    sampleLimitPerReason: number;
    storefrontBaseUrl?: string | null;
}

type MutableReasonSummary = Omit<ProductFeedDiagnosticReasonSummary, "samples"> & {
    productIds: Set<string>;
    samples: ProductFeedDiagnosticSample[];
};

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
    if (!Number.isFinite(value) || value === undefined) return fallback;
    return Math.min(Math.max(Math.trunc(value), 1), max);
}

function createReasonSummaries(): Record<ProductFeedDiagnosticReason, MutableReasonSummary> {
    const summaries = {} as Record<ProductFeedDiagnosticReason, MutableReasonSummary>;
    for (const reason of PRODUCT_FEED_DIAGNOSTIC_REASONS) {
        summaries[reason] = {
            reason,
            products: 0,
            rows: 0,
            productIds: new Set<string>(),
            samples: [],
        };
    }
    return summaries;
}

function addReason(
    summaries: Record<ProductFeedDiagnosticReason, MutableReasonSummary>,
    product: ProductFeedDiagnosticScanProduct,
    reason: ProductFeedDiagnosticReason,
    rows: number,
    sampleLimit: number,
) {
    const summary = summaries[reason];
    summary.rows += Math.max(0, rows);
    if (!summary.productIds.has(product.id)) {
        summary.productIds.add(product.id);
        summary.products += 1;
        if (summary.samples.length < sampleLimit) {
            summary.samples.push({
                id: product.id,
                name: product.name,
                slug: product.slug,
                reason,
            });
        }
    }
}

function hasCustomerOption(variant: ProductFeedDiagnosticScanVariant): boolean {
    return Boolean(variant.size?.trim() || variant.color?.trim());
}

function isBuyerOptionSku(variant: ProductFeedDiagnosticScanVariant): boolean {
    return variant.id !== "default" && !variant.isDefault && hasCustomerOption(variant);
}

function getBuyerTopology(variants: ProductFeedDiagnosticScanVariant[]) {
    const activeSkus = variants.filter((variant) => variant.id !== "default");
    const optionSkus = activeSkus.filter(isBuyerOptionSku);
    const simpleSku = activeSkus.length === 1 && activeSkus[0]?.isDefault ? activeSkus[0] : null;

    if (optionSkus.length > 0) {
        return { mode: "optioned" as const, variants: optionSkus };
    }
    if (simpleSku) {
        return { mode: "simple" as const, variant: simpleSku };
    }
    return { mode: "none" as const };
}

function isVariantAvailable(variant: ProductFeedDiagnosticScanVariant): boolean {
    return !variant.trackInventory || variant.stock - variant.reservedStock > 0;
}

function parseAbsoluteHttpBaseUrl(value: string | null | undefined): string | null {
    const source = value?.trim();
    if (!source) return null;

    try {
        const parsed = new URL(source);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function hasValidFeedImage(imageUrl: string | null | undefined, storefrontBaseUrl: string): boolean {
    const source = imageUrl?.trim();
    if (!source) return false;

    try {
        const parsed = new URL(source, storefrontBaseUrl);
        return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
        return false;
    }
}

function finalReasonSummaries(
    summaries: Record<ProductFeedDiagnosticReason, MutableReasonSummary>,
): ProductFeedDiagnosticReasonSummary[] {
    return PRODUCT_FEED_DIAGNOSTIC_REASONS.map((reason) => {
        const summary = summaries[reason];
        return {
            reason,
            products: summary.products,
            rows: summary.rows,
            samples: summary.samples,
        };
    });
}

export function buildProductFeedDiagnosticsFromScan({
    products: scannedProducts,
    primaryImageUrls,
    variants,
    feedsPolicy,
    scanLimit,
    truncated,
    sampleLimitPerReason,
    storefrontBaseUrl,
}: ProductFeedDiagnosticScanInput): ProductFeedDiagnosticsReport {
    const summaries = createReasonSummaries();
    const productsWithIssues = new Set<string>();
    let emittedProductRows = 0;
    let emittedVariantRows = 0;
    let skippedRows = 0;
    const absoluteStorefrontBaseUrl = parseAbsoluteHttpBaseUrl(storefrontBaseUrl);

    const recordIssue = (
        product: ProductFeedDiagnosticScanProduct,
        reason: ProductFeedDiagnosticReason,
        rows: number,
    ) => {
        addReason(summaries, product, reason, rows, sampleLimitPerReason);
        productsWithIssues.add(product.id);
        skippedRows += Math.max(0, rows);
    };

    for (const product of scannedProducts) {
        if (!feedsPolicy.productCatalogEnabled) {
            recordIssue(product, "feed_disabled", 0);
            continue;
        }

        if (!product.isActive || product.deletedAt !== null) {
            recordIssue(product, "inactive_deleted_unpublished", 0);
            continue;
        }

        const topology = getBuyerTopology(variants.get(product.id) ?? []);
        if (topology.mode === "none") {
            recordIssue(product, "no_buyer_sku", 0);
            continue;
        }

        const hasImage = absoluteStorefrontBaseUrl
            ? hasValidFeedImage(primaryImageUrls.get(product.id), absoluteStorefrontBaseUrl)
            : false;

        if (feedsPolicy.variantStrategy === "products" || topology.mode === "simple") {
            const available =
                topology.mode === "simple"
                    ? isVariantAvailable(topology.variant)
                    : topology.variants.some(isVariantAvailable);

            if (!feedsPolicy.includeUnavailableProducts && !available) {
                recordIssue(product, "unavailable_excluded", 1);
                continue;
            }
            if (!absoluteStorefrontBaseUrl) {
                recordIssue(product, "storefront_url_unavailable", 1);
                continue;
            }
            if (!hasImage) {
                recordIssue(product, "missing_image", 1);
                continue;
            }
            emittedProductRows += 1;
            continue;
        }

        for (const variant of topology.variants) {
            if (!feedsPolicy.includeUnavailableProducts && !isVariantAvailable(variant)) {
                recordIssue(product, "unavailable_excluded", 1);
                continue;
            }
            if (!absoluteStorefrontBaseUrl) {
                recordIssue(product, "storefront_url_unavailable", 1);
                continue;
            }
            if (!hasImage) {
                recordIssue(product, "missing_image", 1);
                continue;
            }
            emittedVariantRows += 1;
        }
    }

    return {
        policy: {
            productCatalogEnabled: feedsPolicy.productCatalogEnabled,
            includeUnavailableProducts: feedsPolicy.includeUnavailableProducts,
            variantStrategy: feedsPolicy.variantStrategy,
        },
        scan: {
            limit: scanLimit,
            scannedProducts: scannedProducts.length,
            truncated,
            sampleLimitPerReason,
        },
        totals: {
            emittedRows: emittedProductRows + emittedVariantRows,
            emittedProductRows,
            emittedVariantRows,
            productsWithIssues: productsWithIssues.size,
            skippedRows,
        },
        reasons: finalReasonSummaries(summaries),
    };
}

export async function getProductFeedDiagnostics(
    db: Database,
    feedsPolicy: SeoDiscoverySettings["feeds"],
    options: {
        scanLimit?: number;
        sampleLimitPerReason?: number;
        storefrontBaseUrl?: string | null;
    } = {},
): Promise<ProductFeedDiagnosticsReport> {
    const scanLimit = boundedInteger(
        options.scanLimit,
        PRODUCT_FEED_DIAGNOSTIC_SCAN_LIMIT,
        PRODUCT_FEED_DIAGNOSTIC_MAX_SCAN_LIMIT,
    );
    const sampleLimitPerReason = boundedInteger(
        options.sampleLimitPerReason,
        PRODUCT_FEED_DIAGNOSTIC_SAMPLE_LIMIT,
        PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT,
    );

    const rows = await db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            isActive: products.isActive,
            deletedAt: sql<number | null>`CAST(${products.deletedAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
        })
        .from(products)
        .orderBy(desc(sql<number>`CAST(${products.updatedAt} AS INTEGER)`), desc(sql<number>`CAST(${products.createdAt} AS INTEGER)`))
        .limit(scanLimit + 1)
        .all();

    const productRows = rows.slice(0, scanLimit).map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        isActive: Boolean(row.isActive),
        deletedAt: row.deletedAt ?? null,
    }));
    const productIds = productRows.map((product) => product.id);
    const truncated = rows.length > scanLimit;

    if (productIds.length === 0 || !feedsPolicy.productCatalogEnabled) {
        return buildProductFeedDiagnosticsFromScan({
            products: productRows,
            primaryImageUrls: new Map(),
            variants: new Map(),
            feedsPolicy,
            scanLimit,
            truncated,
            sampleLimitPerReason,
            storefrontBaseUrl: options.storefrontBaseUrl,
        });
    }

    const [imageRows, variantRows] = await Promise.all([
        db
            .select({
                productId: productImages.productId,
                url: productImages.url,
            })
            .from(productImages)
            .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)))
            .orderBy(productImages.productId)
            .all(),
        db
            .select({
                id: productVariants.id,
                productId: productVariants.productId,
                size: productVariants.size,
                color: productVariants.color,
                stock: productVariants.stock,
                reservedStock: productVariants.reservedStock,
                isDefault: productVariants.isDefault,
                trackInventory: productVariants.trackInventory,
            })
            .from(productVariants)
            .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
            .orderBy(productVariants.productId)
            .all(),
    ]);

    const primaryImageUrls = new Map<string, string | null>();
    for (const row of imageRows) {
        if (!primaryImageUrls.has(row.productId)) {
            primaryImageUrls.set(row.productId, row.url);
        }
    }

    const variantMap = new Map<string, ProductFeedDiagnosticScanVariant[]>();
    for (const row of variantRows) {
        const productVariantsForProduct = variantMap.get(row.productId) ?? [];
        productVariantsForProduct.push({
            id: row.id,
            productId: row.productId,
            size: row.size,
            color: row.color,
            stock: row.stock,
            reservedStock: row.reservedStock,
            isDefault: Boolean(row.isDefault),
            trackInventory: Boolean(row.trackInventory),
        });
        variantMap.set(row.productId, productVariantsForProduct);
    }

    return buildProductFeedDiagnosticsFromScan({
        products: productRows,
        primaryImageUrls,
        variants: variantMap,
        feedsPolicy,
        scanLimit,
        truncated,
        sampleLimitPerReason,
        storefrontBaseUrl: options.storefrontBaseUrl,
    });
}
