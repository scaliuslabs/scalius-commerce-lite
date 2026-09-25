// Product comparison (`GET /products/compare?ids=`) and the grouped spec
// table it shares with the product page: up to four public products side by
// side, their typed attribute values grouped by attribute group (Star Tech /
// Apple Gadgets "compare", Target's table). One wave of three statements:
// the cards from the stored buyer state, the specs, and the card images.
//
// `loadProductSpecGroups` is the read-side contract for grouped spec tables:
// the product page (Phase 6) calls it with one product id and renders the
// same groups and rows.
import {
    attributeGroups,
    attributeValues,
    brands,
    productAttributes,
    productAttributeValues,
    products,
} from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import type { BuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import {
    presentBuyerPricing,
    storeCurrencyCodeSql,
    storeDecimalPlacesFromCode,
} from "../products/money";
import { loadProductMediaProjections, resolveProductCardImages } from "../products/media";
import {
    buyerState,
    buyerStateCardSku,
    buyerStatePricingSelection,
    publicBuyerStateCondition,
} from "./buyer-state";

/** Products one comparison shows (the compare tray's size). */
export const MAX_COMPARE_PRODUCTS = 4;

export interface ProductSpecRow {
    attributeId: string;
    name: string;
    slug: string;
    unit: string | null;
    /** Shown on spec cards and in the buy box. */
    keySpec: boolean;
    /** An "at a glance" chip near the price. */
    highlight: boolean;
    /** One display value per product, in the requested product order; null where a product has none. */
    values: Array<string | null>;
}

export interface ProductSpecGroup {
    /** null: attributes without a group, listed last. */
    id: string | null;
    name: string | null;
    rows: ProductSpecRow[];
}

type SpecValueRow = {
    productId: string;
    attributeId: string;
    name: string;
    slug: string;
    unit: string | null;
    keySpec: number | boolean;
    highlight: number | boolean;
    attributeSort: number;
    groupId: string | null;
    groupName: string | null;
    groupSort: number | null;
    value: string;
};

function specValuesQuery(db: Database, productIds: readonly string[]) {
    return db
        .select({
            productId: productAttributeValues.productId,
            attributeId: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            unit: productAttributes.unit,
            keySpec: productAttributes.keySpec,
            highlight: productAttributes.highlight,
            attributeSort: productAttributes.sortOrder,
            groupId: attributeGroups.id,
            groupName: attributeGroups.name,
            groupSort: attributeGroups.sortOrder,
            // An enum shows its value's current display text.
            value: sql<string>`COALESCE(${attributeValues.value}, ${productAttributeValues.value})`,
        })
        .from(productAttributeValues)
        .innerJoin(productAttributes, and(
            eq(productAttributes.id, productAttributeValues.attributeId),
            sql`${productAttributes.deletedAt} IS NULL`,
        ))
        .leftJoin(attributeGroups, and(
            eq(attributeGroups.id, productAttributes.groupId),
            sql`${attributeGroups.deletedAt} IS NULL`,
        ))
        .leftJoin(attributeValues, eq(attributeValues.id, productAttributeValues.valueId))
        .where(sql`${productAttributeValues.productId} IN (
            SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIds)})
        )`);
}

/**
 * Spec rows grouped by attribute group (group order, then name; ungrouped
 * last), rows by attribute order then name, one value column per product.
 */
export function groupProductSpecs(rows: readonly SpecValueRow[], productIds: readonly string[]): ProductSpecGroup[] {
    const column = new Map(productIds.map((id, index) => [id, index]));
    const groups = new Map<string, ProductSpecGroup & { sort: number }>();
    const specRows = new Map<string, ProductSpecRow & { sort: number }>();
    for (const row of rows) {
        const index = column.get(row.productId);
        if (index === undefined) continue;
        const groupKey = row.groupId ?? "";
        let group = groups.get(groupKey);
        if (!group) {
            group = {
                id: row.groupId,
                name: row.groupName,
                rows: [],
                sort: row.groupId === null ? Number.MAX_SAFE_INTEGER : Number(row.groupSort) || 0,
            };
            groups.set(groupKey, group);
        }
        let spec = specRows.get(row.attributeId);
        if (!spec) {
            spec = {
                attributeId: row.attributeId,
                name: row.name,
                slug: row.slug,
                unit: row.unit,
                keySpec: Boolean(row.keySpec),
                highlight: Boolean(row.highlight),
                values: productIds.map(() => null),
                sort: Number(row.attributeSort) || 0,
            };
            specRows.set(row.attributeId, spec);
            group.rows.push(spec);
        }
        spec.values[index] = row.value;
    }
    const byName = (left: string | null, right: string | null) => (left ?? "").localeCompare(right ?? "");
    return [...groups.values()]
        .sort((left, right) => left.sort - right.sort || byName(left.name, right.name))
        .map(({ sort: _sort, rows: groupRows, ...group }) => ({
            ...group,
            rows: (groupRows as Array<ProductSpecRow & { sort: number }>)
                .sort((left, right) => left.sort - right.sort || byName(left.name, right.name))
                .map(({ sort: _rowSort, ...row }) => row),
        }));
}

/** The grouped spec table of these products (one column each, in this order). */
export async function loadProductSpecGroups(db: Database, productIds: readonly string[]): Promise<ProductSpecGroup[]> {
    if (productIds.length === 0) return [];
    const rows = await specValuesQuery(db, productIds).all() as SpecValueRow[];
    return groupProductSpecs(rows, productIds);
}

export interface StorefrontCompareProduct {
    id: string;
    name: string;
    slug: string;
    price: number;
    discountedPrice: number;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    priceVaries: boolean;
    hasVariants: boolean;
    availableForSale: boolean;
    /** Band only, never a stock count. */
    availabilityBand: BuyerAvailabilityBand;
    brand: { id: string; name: string; slug: string } | null;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
}

export interface StorefrontProductComparison {
    products: StorefrontCompareProduct[];
    groups: ProductSpecGroup[];
}

/** Unique, trimmed ids in request order, at most MAX_COMPARE_PRODUCTS. */
export function normalizeCompareIds(raw: string | readonly string[]): string[] {
    const tokens = (typeof raw === "string" ? raw.split(",") : raw).map((id) => id.trim()).filter(Boolean);
    return [...new Set(tokens)];
}

/**
 * Public products side by side. Ids that are not public (draft, trashed,
 * unpriced, unknown) are left out; the rest keep the requested order.
 */
export async function getStorefrontProductComparison(
    db: Database,
    requestedIds: readonly string[],
): Promise<StorefrontProductComparison> {
    const ids = [...new Set(requestedIds)].slice(0, MAX_COMPARE_PRODUCTS);
    if (ids.length === 0) return { products: [], groups: [] };
    const cardSku = buyerStateCardSku();
    const idSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
    const [cards, specs, mediaMap] = await Promise.all([
        db
            .select({
                id: products.id,
                name: products.name,
                slug: products.slug,
                ...buyerStatePricingSelection(cardSku),
                hasCustomerOptions: buyerState.hasCustomerOptions,
                availableForSale: buyerState.availableForSale,
                availabilityBand: buyerState.availabilityBand,
                brandId: brands.id,
                brandName: brands.name,
                brandSlug: brands.slug,
                storeCurrencyCode: storeCurrencyCodeSql(),
            })
            .from(buyerState)
            .innerJoin(products, eq(products.id, buyerState.productId))
            .leftJoin(cardSku, eq(cardSku.id, buyerState.skuId))
            .leftJoin(brands, and(
                eq(brands.id, buyerState.brandId),
                sql`${brands.status} = 'published'`,
                sql`${brands.deletedAt} IS NULL`,
            ))
            .where(and(
                sql`${buyerState.productId} IN ${idSet}`,
                publicBuyerStateCondition({ drivenByIdSet: true }),
            ))
            .all(),
        specValuesQuery(db, ids).all() as Promise<SpecValueRow[]>,
        loadProductMediaProjections(db, ids),
    ]);
    const decimalPlaces = storeDecimalPlacesFromCode(cards[0]?.storeCurrencyCode);
    const byId = new Map(cards.map((card) => [card.id, card]));
    const shown = ids.filter((id) => byId.has(id));
    const comparedProducts = shown.map((id): StorefrontCompareProduct => {
        const {
            hasCustomerOptions,
            availableForSale,
            availabilityBand,
            brandId,
            brandName,
            brandSlug,
            storeCurrencyCode: _currency,
            ...card
        } = byId.get(id)!;
        const images = resolveProductCardImages(mediaMap.get(id) ?? []);
        return {
            ...presentBuyerPricing(card, decimalPlaces),
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            availabilityBand: availabilityBand as BuyerAvailabilityBand,
            brand: brandId && brandName && brandSlug ? { id: brandId, name: brandName, slug: brandSlug } : null,
            imageUrl: images.imageUrl,
            imageMediaId: images.imageMediaId,
            imageAlt: images.imageAlt,
        };
    });
    return { products: comparedProducts, groups: groupProductSpecs(specs, shown) };
}
