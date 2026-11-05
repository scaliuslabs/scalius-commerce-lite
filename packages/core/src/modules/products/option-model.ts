import { chunkForD1, type Database } from "@scalius/database/client";
import {
    media,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
    productVariants,
} from "@scalius/database/schema";
import { getCurrentMediaUrl } from "../../integrations/storage";
import { publishedMediaObjectKey } from "../media-references";
import { and, asc, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { qualifiedReference } from "../../utils/qualified-column";
import {
    MAX_PRODUCT_OPTION_AXES,
    MAX_PRODUCT_OPTION_COMBINATIONS,
    normalizeProductOptionIdentity,
    type ProductOptionStandardMapping,
} from "@scalius/shared/product-options";

export { MAX_PRODUCT_OPTION_AXES, MAX_PRODUCT_OPTION_COMBINATIONS };
export type { ProductOptionStandardMapping };

/**
 * An option value's swatch (0196): its colour (`#rrggbb`) and/or its image
 * from Files. `imageUrl` is the file's published URL while it is a ready (or
 * trashed) image, else null, so a file being deleted never shows; `mediaId`
 * stays the stored reference for the editor.
 */
export interface ProductOptionValueSwatch {
    color: string | null;
    mediaId: string | null;
    imageUrl: string | null;
}

export interface ProductOptionValueRecord {
    id: string;
    value: string;
    position: number;
    /** Null without a colour or image. */
    swatch: ProductOptionValueSwatch | null;
}

/**
 * The columns `optionValueSwatch` reads, for a select over
 * `product_option_values` left-joined to `media` on `swatch_media_id`.
 */
export function optionValueSwatchColumns() {
    return {
        swatchColor: productOptionValues.swatchColor,
        swatchMediaId: productOptionValues.swatchMediaId,
        // The swatch image's published key, while it is an image Files still shows.
        swatchObjectKey: publishedMediaObjectKey(),
        swatchVariantWidth: media.variantWidth,
        swatchUsable: sql<number>`CASE WHEN ${media.kind} = 'image' AND ${media.status} IN ('ready', 'trashed') THEN 1 ELSE 0 END`,
    };
}

/** The swatch a value row carries, as the editor and the storefront read it. */
export function optionValueSwatch(row: {
    swatchColor: string | null;
    swatchMediaId: string | null;
    swatchObjectKey: string | null;
    swatchVariantWidth: number | null;
    swatchUsable: number | boolean | null;
}): ProductOptionValueSwatch | null {
    if (!row.swatchColor && !row.swatchMediaId) return null;
    const imageUrl = row.swatchMediaId && row.swatchObjectKey && Boolean(Number(row.swatchUsable))
        ? getCurrentMediaUrl(row.swatchObjectKey, row.swatchVariantWidth)
        : null;
    return { color: row.swatchColor, mediaId: row.swatchMediaId, imageUrl };
}

export interface ProductOptionDefinitionRecord {
    id: string;
    name: string;
    position: number;
    standardMapping: ProductOptionStandardMapping;
    values: ProductOptionValueRecord[];
}

export interface SelectedProductOption {
    optionDefinitionId: string;
    optionValueId: string;
    name: string;
    value: string;
    position: number;
    valuePosition: number;
    standardMapping: ProductOptionStandardMapping;
}

export function normalizeOptionIdentity(value: string): string {
    return normalizeProductOptionIdentity(value);
}

export function buildOptionCombinationKey(valueIds: readonly string[]): string {
    return valueIds.join("|");
}

export async function resolveSelectedOptionValueIds(
    db: Database,
    productId: string,
    requestedValueIds: readonly string[],
): Promise<{
    valueIds: string[];
    combinationKey: string;
    assignments: Array<{ optionDefinitionId: string; optionValueId: string }>;
}> {
    const uniqueValueIds = [...new Set(requestedValueIds.map((id) => id.trim()).filter(Boolean))];
    const options = (await loadProductOptions(db, [productId])).get(productId) ?? [];
    if (options.length === 0) {
        throw new ValidationError("Add at least one product option before creating option SKUs.");
    }
    if (uniqueValueIds.length !== options.length) {
        throw new ValidationError("Select exactly one value for every active product option.");
    }

    const requested = new Set(uniqueValueIds);
    const assignments = options.map((option) => {
        const matches = option.values.filter((value) => requested.has(value.id));
        if (matches.length !== 1) {
            throw new ValidationError(`Select exactly one ${option.name} value.`);
        }
        return { optionDefinitionId: option.id, optionValueId: matches[0]!.id };
    });
    const orderedValueIds = assignments.map((assignment) => assignment.optionValueId);
    if (orderedValueIds.some((id) => !requested.has(id))) {
        throw new ValidationError("An option value does not belong to this product.");
    }
    return {
        valueIds: orderedValueIds,
        combinationKey: buildOptionCombinationKey(orderedValueIds),
        assignments,
    };
}

export async function loadProductOptions(
    db: Database,
    productIds: readonly string[],
    includeRetired = false,
): Promise<Map<string, ProductOptionDefinitionRecord[]>> {
    const result = new Map<string, ProductOptionDefinitionRecord[]>();
    const uniqueProductIds = [...new Set(productIds)];
    for (const productId of uniqueProductIds) result.set(productId, []);

    for (const productIdChunk of chunkForD1(uniqueProductIds)) {
        const rows = await db
            .select({
                productId: productOptionDefinitions.productId,
                definitionId: productOptionDefinitions.id,
                name: productOptionDefinitions.name,
                position: productOptionDefinitions.position,
                standardMapping: productOptionDefinitions.standardMapping,
                valueId: productOptionValues.id,
                value: productOptionValues.value,
                valuePosition: productOptionValues.position,
                definitionDeletedAt: productOptionDefinitions.deletedAt,
                valueDeletedAt: productOptionValues.deletedAt,
                ...optionValueSwatchColumns(),
            })
            .from(productOptionDefinitions)
            .leftJoin(
                productOptionValues,
                and(
                    eq(productOptionValues.optionDefinitionId, productOptionDefinitions.id),
                    ...(includeRetired ? [] : [isNull(productOptionValues.deletedAt)]),
                ),
            )
            .leftJoin(media, eq(media.id, productOptionValues.swatchMediaId))
            .where(and(
                inArray(productOptionDefinitions.productId, productIdChunk),
                ...(includeRetired ? [] : [isNull(productOptionDefinitions.deletedAt)]),
            ))
            .orderBy(
                asc(productOptionDefinitions.productId),
                asc(productOptionDefinitions.position),
                asc(productOptionValues.position),
            );

        const definitionById = new Map<string, ProductOptionDefinitionRecord>();
        for (const row of rows) {
            if (!includeRetired && (row.definitionDeletedAt || row.valueDeletedAt)) continue;
            let definition = definitionById.get(row.definitionId);
            if (!definition) {
                definition = {
                    id: row.definitionId,
                    name: row.name,
                    position: row.position,
                    standardMapping: row.standardMapping,
                    values: [],
                };
                definitionById.set(row.definitionId, definition);
                result.get(row.productId)?.push(definition);
            }
            if (row.valueId && row.value != null && row.valuePosition != null) {
                definition.values.push({
                    id: row.valueId,
                    value: row.value,
                    position: row.valuePosition,
                    swatch: optionValueSwatch(row),
                });
            }
        }
    }

    return result;
}

export async function loadVariantSelectedOptions(
    db: Database,
    variantIds: readonly string[],
): Promise<Map<string, SelectedProductOption[]>> {
    const result = new Map<string, SelectedProductOption[]>();
    const uniqueVariantIds = [...new Set(variantIds)];
    for (const variantId of uniqueVariantIds) result.set(variantId, []);

    for (const variantIdChunk of chunkForD1(uniqueVariantIds)) {
        const rows = await db
            .select({
                variantId: productVariantOptionValues.variantId,
                optionDefinitionId: productOptionDefinitions.id,
                optionValueId: productOptionValues.id,
                name: productOptionDefinitions.name,
                value: productOptionValues.value,
                position: productOptionDefinitions.position,
                valuePosition: productOptionValues.position,
                standardMapping: productOptionDefinitions.standardMapping,
            })
            .from(productVariantOptionValues)
            .innerJoin(
                productVariants,
                eq(productVariants.id, productVariantOptionValues.variantId),
            )
            .innerJoin(
                productOptionDefinitions,
                eq(productOptionDefinitions.id, productVariantOptionValues.optionDefinitionId),
            )
            .innerJoin(
                productOptionValues,
                eq(productOptionValues.id, productVariantOptionValues.optionValueId),
            )
            .where(inArray(productVariantOptionValues.variantId, variantIdChunk))
            .orderBy(
                asc(productVariantOptionValues.variantId),
                asc(productOptionDefinitions.position),
            );

        for (const row of rows) {
            result.get(row.variantId)?.push({
                optionDefinitionId: row.optionDefinitionId,
                optionValueId: row.optionValueId,
                name: row.name,
                value: row.value,
                position: row.position,
                valuePosition: row.valuePosition,
                standardMapping: row.standardMapping,
            });
        }
    }

    return result;
}

/**
 * The option values of every active variant of one product, in one query keyed
 * by the product: the editor reads them alongside the variants instead of
 * after them (and a product with 150 variants needs no id chunking).
 */
export async function loadProductVariantSelectedOptions(
    db: Database,
    productId: string,
): Promise<Map<string, SelectedProductOption[]>> {
    const rows = await db
        .select({
            variantId: productVariantOptionValues.variantId,
            optionDefinitionId: productOptionDefinitions.id,
            optionValueId: productOptionValues.id,
            name: productOptionDefinitions.name,
            value: productOptionValues.value,
            position: productOptionDefinitions.position,
            valuePosition: productOptionValues.position,
            standardMapping: productOptionDefinitions.standardMapping,
        })
        .from(productVariantOptionValues)
        .innerJoin(productVariants, eq(productVariants.id, productVariantOptionValues.variantId))
        .innerJoin(productOptionDefinitions, eq(productOptionDefinitions.id, productVariantOptionValues.optionDefinitionId))
        .innerJoin(productOptionValues, eq(productOptionValues.id, productVariantOptionValues.optionValueId))
        .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
        .orderBy(asc(productVariantOptionValues.variantId), asc(productOptionDefinitions.position));

    const result = new Map<string, SelectedProductOption[]>();
    for (const row of rows) {
        const list = result.get(row.variantId) ?? [];
        list.push({
            optionDefinitionId: row.optionDefinitionId,
            optionValueId: row.optionValueId,
            name: row.name,
            value: row.value,
            position: row.position,
            valuePosition: row.valuePosition,
            standardMapping: row.standardMapping,
        });
        result.set(row.variantId, list);
    }
    return result;
}

/** Compact buyer/admin label for projections that do not need structured axes. */
export function variantOptionLabelSql(column: SQLWrapper): SQL<string | null> {
    // Qualified: in a single-table select a bare column would bind inside the subquery.
    const variantId = qualifiedReference(column);
    return sql<string | null>`(
        SELECT group_concat(option_label.value, ' / ')
        FROM (
            SELECT pov.value AS value
            FROM product_variant_option_values pvov
            JOIN product_option_definitions pod ON pod.id = pvov.option_definition_id
            JOIN product_option_values pov ON pov.id = pvov.option_value_id
            WHERE pvov.variant_id = ${variantId}
            ORDER BY pod.position
        ) AS option_label
    )`;
}
