export interface NormalizedCollectionConfig {
    source: CollectionContentSource;
    categoryIds: string[];
    productIds: string[];
    featuredProductId?: string;
    maxProducts: number;
    title: string;
    subtitle: string;
}

export type CollectionContentSource = "manual" | "dynamic";

// Leave room below D1's 100-bound-parameter ceiling for surrounding predicates.
export const COLLECTION_CONFIG_ID_LIMIT = 90;

export const DEFAULT_COLLECTION_CONFIG: NormalizedCollectionConfig = {
    source: "manual",
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

function textValue(value: unknown, maxLength: number): string {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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
    const categoryIds = uniqueStringList(config.categoryIds);
    const source: CollectionContentSource = config.source === "dynamic"
        ? "dynamic"
        : "manual";

    return {
        source,
        categoryIds,
        productIds,
        featuredProductId: optionalString(config.featuredProductId),
        maxProducts: normalizeMaxProducts(config.maxProducts),
        title: textValue(config.title, 120),
        subtitle: textValue(config.subtitle, 240),
    };
}

export function collectionMembershipForConfig(value: unknown): {
    source: CollectionContentSource;
    productIds: string[];
    categoryIds: string[];
} {
    const config = normalizeCollectionConfig(value);
    return {
        source: config.source,
        productIds: config.source === "manual" ? config.productIds : [],
        categoryIds: config.source === "dynamic" ? config.categoryIds : [],
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
