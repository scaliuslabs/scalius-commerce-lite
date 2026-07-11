export interface NormalizedCollectionConfig {
    categoryIds: string[];
    productIds: string[];
    featuredProductId?: string;
    maxProducts: number;
    title: string;
    subtitle: string;
}

// Leave room below D1's 100-bound-parameter ceiling for surrounding predicates.
export const COLLECTION_CONFIG_ID_LIMIT = 90;

export const DEFAULT_COLLECTION_CONFIG: NormalizedCollectionConfig = {
    categoryIds: [],
    productIds: [],
    maxProducts: 8,
    title: "",
    subtitle: "",
};

function parseConfigInput(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
    }

    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function uniqueStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    return Array.from(
        new Set(
            value
                .map((item) => typeof item === "string" ? item.trim() : "")
                .filter(Boolean),
        ),
    ).slice(0, COLLECTION_CONFIG_ID_LIMIT);
}

function productIdFromUnknown(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";

    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") return record.id.trim();
    if (typeof record.productId === "string") return record.productId.trim();
    return "";
}

function uniqueProductIdList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    return Array.from(
        new Set(value.map(productIdFromUnknown).filter(Boolean)),
    ).slice(0, COLLECTION_CONFIG_ID_LIMIT);
}

function optionalString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

function textValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function normalizeMaxProducts(value: unknown): number {
    const numericValue = typeof value === "number"
        ? value
        : typeof value === "string"
            ? Number(value)
            : DEFAULT_COLLECTION_CONFIG.maxProducts;
    if (!Number.isFinite(numericValue)) return DEFAULT_COLLECTION_CONFIG.maxProducts;
    return Math.min(Math.max(Math.trunc(numericValue), 1), 24);
}

export function normalizeCollectionConfig(value: unknown): NormalizedCollectionConfig {
    const config = parseConfigInput(value);
    const productIds = uniqueProductIdList(config.productIds);
    const legacySpecificProductIds = uniqueProductIdList(config.specificProductIds);
    const legacyProducts = uniqueProductIdList(config.products);

    return {
        categoryIds: uniqueStringList(config.categoryIds),
        productIds: productIds.length > 0
            ? productIds
            : legacySpecificProductIds.length > 0
                ? legacySpecificProductIds
                : legacyProducts,
        featuredProductId: optionalString(config.featuredProductId),
        maxProducts: normalizeMaxProducts(config.maxProducts),
        title: textValue(config.title),
        subtitle: textValue(config.subtitle),
    };
}

export function stringifyCollectionConfig(value: unknown): string {
    return JSON.stringify(normalizeCollectionConfig(value));
}

export function collectionProductIdsForLookup(value: unknown): string[] {
    const config = normalizeCollectionConfig(value);
    return Array.from(
        new Set([
            ...config.productIds,
            ...(config.featuredProductId ? [config.featuredProductId] : []),
        ]),
    );
}
