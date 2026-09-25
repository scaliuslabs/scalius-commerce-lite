// src/modules/attributes/attribute-types.ts
// Changing an attribute's value type rewrites every product value of it.
//
// Order matters: the type-guard triggers check a written row against the
// attribute's CURRENT `value_type`, so the definition switches first (after
// every value was validated to convert), then the rows follow in keyset
// chunks of at most 90 products, one batch per chunk with the row UPDATEs,
// the products' revision bump and their projection refresh. The chunk
// selection is "rows whose shape does not match the current type", so a run
// that stopped halfway continues where it left off when repeated.
import { attributeValues, productAttributes, productAttributeValues, productFacetValues } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { and, asc, count, eq, isNull, sql, type SQL } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import {
    defaultAttributeFacetDisplay,
    isAttributeFacetDisplayAllowed,
    normalizeAttributeValue,
    type AttributeFacetDisplay,
    type AttributeValueType,
} from "@scalius/shared/catalog-attributes";

import { encodeAttributeValue } from "./attribute-value-codec";
import {
    attributeValueInsertStatement,
    readLiveAttributeDefinition,
    type NewAttributeValueRow,
} from "./attribute-definition";
import { newAttributeValueId } from "./attribute-values";
import {
    ATTRIBUTE_WRITE_PRODUCTS_PER_BATCH,
    jsonIdSet,
    productRevisionBumpStatement,
    type AttributeBatchItem,
    type CatalogProjectionRefresh,
} from "./projection-refresh";

/** Distinct values an enum conversion may create. */
export const MAX_ENUM_CONVERSION_VALUES = 2_000;
/** Distinct values any conversion validates before it switches the type. */
export const MAX_CONVERSION_DISTINCT_VALUES = 50_000;
const DISTINCT_VALUE_PAGE = 1_000;
const VALUE_INSERT_CHUNK = 500;
const SAMPLE_LIMIT = 10;

export interface ConvertAttributeValueTypeInput {
    attributeId: string;
    valueType: AttributeValueType;
    facetDisplay?: AttributeFacetDisplay;
    unit?: string | null;
    dryRun?: boolean;
}

export interface AttributeTypeConversionResult {
    attributeId: string;
    fromType: AttributeValueType;
    valueType: AttributeValueType;
    facetDisplay: AttributeFacetDisplay;
    unit: string | null;
    dryRun: boolean;
    /** Product values not yet in the target shape (before the run). */
    rows: number;
    distinctValues: number;
    /** Enum values that did not exist yet (created unless dryRun). */
    newValues: number;
    unconvertibleCount: number;
    unconvertibleSamples: string[];
    /** Product values rewritten by this run. */
    converted: number;
    /** Rows written after validation in a shape that does not convert; left as they were. */
    skipped: number;
    skippedSamples: string[];
    /** Anything was written (the caller bumps the cache generation). */
    changed: boolean;
}

/**
 * Canonical number text in SQL, the twin of `canonicalAttributeNumber` (the
 * same expression the facet projection uses): six decimals, no trailing zeros.
 */
function canonicalNumberSql(value: SQL): SQL<string> {
    const scaled = sql`CAST(round(${value} * 1000000) AS INTEGER)`;
    const magnitude = sql`abs(${scaled})`;
    const fraction = sql`(${magnitude} % 1000000)`;
    return sql<string>`(CASE WHEN ${scaled} < 0 THEN '-' ELSE '' END
        || CAST(${magnitude} / 1000000 AS TEXT)
        || CASE WHEN ${fraction} = 0 THEN ''
            ELSE '.' || rtrim(substr(CAST(1000000 + ${fraction} AS TEXT), 2), '0') END)`;
}

/**
 * Rows of the attribute whose stored shape does not match `type` (the trigger
 * rules plus the display text the writer produces for numbers and yes/no),
 * so a unit change or a yes/no row reinterpreted as a number is rewritten too.
 */
function wrongShape(type: AttributeValueType, unit: string | null): SQL {
    const v = productAttributeValues;
    switch (type) {
        case "text":
            return sql`(${v.valueId} IS NOT NULL OR ${v.valueNumber} IS NOT NULL)`;
        case "enum":
            return sql`(${v.valueId} IS NULL OR ${v.valueNumber} IS NOT NULL)`;
        case "number": {
            const display = unit
                ? sql`${canonicalNumberSql(sql`${v.valueNumber}`)} || ' ' || ${unit}`
                : canonicalNumberSql(sql`${v.valueNumber}`);
            return sql`(${v.valueId} IS NOT NULL OR ${v.valueNumber} IS NULL OR ${v.value} <> ${display})`;
        }
        case "boolean":
            return sql`(${v.valueId} IS NOT NULL OR ${v.valueNumber} IS NULL OR ${v.valueNumber} NOT IN (0, 1) OR ${v.value} NOT IN ('Yes', 'No'))`;
    }
}

function naturalOrder(left: string, right: string): number {
    return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }) || (left < right ? -1 : left > right ? 1 : 0);
}

/**
 * Converts the attribute to `valueType` (see the file comment). Refuses the
 * whole conversion with a ValidationError (count and up to 10 samples) when
 * any current value does not convert; `dryRun` returns that preview without
 * writing.
 */
export async function convertAttributeValueType(
    db: Database,
    input: ConvertAttributeValueTypeInput,
    refresh: CatalogProjectionRefresh,
): Promise<AttributeTypeConversionResult> {
    const attribute = await readLiveAttributeDefinition(db, input.attributeId);
    const target = input.valueType;
    if (input.unit && target !== "number") {
        throw new ValidationError("Only number attributes have a unit.", { field: "unit" });
    }
    if (input.facetDisplay && !isAttributeFacetDisplayAllowed(target, input.facetDisplay)) {
        throw new ValidationError(`A ${input.facetDisplay} filter does not suit ${target} values.`, { field: "facetDisplay" });
    }
    const unit = target === "number"
        ? (input.unit !== undefined ? input.unit?.trim() || null : attribute.valueType === "number" ? attribute.unit : null)
        : null;
    const facetDisplay = input.facetDisplay
        ?? (isAttributeFacetDisplayAllowed(target, attribute.facetDisplay) ? attribute.facetDisplay : defaultAttributeFacetDisplay(target));
    const dryRun = input.dryRun === true;
    const wrong = and(eq(productAttributeValues.attributeId, attribute.id), wrongShape(target, unit))!;

    // 1. Validate every value that still has to move, before anything changes.
    const totalRow = await db.select({ rows: count() }).from(productAttributeValues).where(wrong).get();
    const rows = Number(totalRow?.rows ?? 0);
    let distinctValues = 0;
    let unconvertibleCount = 0;
    const unconvertibleSamples: string[] = [];
    const enumDisplays = new Map<string, string>();
    let after: string | null = null;
    for (;;) {
        const page: Array<{ value: string }> = await db
            .selectDistinct({ value: productAttributeValues.value })
            .from(productAttributeValues)
            .where(and(wrong, after === null ? undefined : sql`${productAttributeValues.value} > ${after}`))
            .orderBy(asc(productAttributeValues.value))
            .limit(DISTINCT_VALUE_PAGE)
            .all();
        for (const { value } of page) {
            distinctValues += 1;
            const encoded = encodeAttributeValue(target, value, unit);
            if (encoded === null) {
                unconvertibleCount += 1;
                if (unconvertibleSamples.length < SAMPLE_LIMIT) unconvertibleSamples.push(value);
            } else if (target === "enum") {
                const key = normalizeAttributeValue(encoded.value);
                if (!enumDisplays.has(key)) enumDisplays.set(key, encoded.value);
            }
        }
        if (distinctValues > MAX_CONVERSION_DISTINCT_VALUES) {
            throw new ValidationError(
                `This attribute has more than ${MAX_CONVERSION_DISTINCT_VALUES.toLocaleString("en")} different values; it cannot be converted in one run.`,
            );
        }
        if (page.length < DISTINCT_VALUE_PAGE) break;
        after = page[page.length - 1]!.value;
    }
    if (target === "enum" && enumDisplays.size > MAX_ENUM_CONVERSION_VALUES) {
        throw new ValidationError(
            `An enum attribute can have at most ${MAX_ENUM_CONVERSION_VALUES.toLocaleString("en")} values; these products use ${enumDisplays.size.toLocaleString("en")}. Keep it as text.`,
        );
    }

    // Enum values that do not exist yet, appended after the live ones in natural order.
    const newValueRows: NewAttributeValueRow[] = [];
    if (target === "enum" && enumDisplays.size > 0) {
        const live = await db
            .select({ value: attributeValues.value, sortOrder: attributeValues.sortOrder })
            .from(attributeValues)
            .where(and(eq(attributeValues.attributeId, attribute.id), isNull(attributeValues.deletedAt)))
            .limit(MAX_ENUM_CONVERSION_VALUES * 3)
            .all();
        const liveKeys = new Set(live.map((row) => normalizeAttributeValue(row.value)));
        const base = live.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
        const missing = [...enumDisplays].filter(([key]) => !liveKeys.has(key)).map(([, display]) => display).sort(naturalOrder);
        missing.forEach((value, index) => newValueRows.push({ id: newAttributeValueId(), value, sortOrder: base + index }));
    }

    const definitionChanges = target !== attribute.valueType
        || facetDisplay !== attribute.facetDisplay
        || unit !== attribute.unit;
    const result: AttributeTypeConversionResult = {
        attributeId: attribute.id,
        fromType: attribute.valueType,
        valueType: target,
        facetDisplay,
        unit,
        dryRun,
        rows,
        distinctValues,
        newValues: newValueRows.length,
        unconvertibleCount,
        unconvertibleSamples,
        converted: 0,
        skipped: 0,
        skippedSamples: [],
        changed: false,
    };
    if (dryRun) return result;
    if (unconvertibleCount > 0) {
        throw new ValidationError(
            `${unconvertibleCount} ${unconvertibleCount === 1 ? "value does" : "values do"} not convert to ${target}: ${unconvertibleSamples.map((value) => `"${value}"`).join(", ")}${unconvertibleCount > unconvertibleSamples.length ? ", …" : ""}. Fix them first.`,
            { field: "valueType", unconvertibleCount, unconvertibleSamples },
        );
    }

    // 2. Switch the definition (and create the enum's values) in one batch.
    if (definitionChanges || newValueRows.length > 0) {
        const statements: AttributeBatchItem[] = [];
        for (let index = 0; index < newValueRows.length; index += VALUE_INSERT_CHUNK) {
            statements.push(attributeValueInsertStatement(db, attribute.id, newValueRows.slice(index, index + VALUE_INSERT_CHUNK)));
        }
        statements.push(db.update(productAttributes)
            .set({ valueType: target, facetDisplay, unit, updatedAt: sql`unixepoch()` })
            .where(and(eq(productAttributes.id, attribute.id), isNull(productAttributes.deletedAt))));
        if (target !== attribute.valueType) {
            // Facet rows keyed by the old type would mix with the new keys
            // until every chunk is rewritten: drop them; each chunk's
            // refresh writes its products' rows back in the new shape.
            statements.push(db.delete(productFacetValues).where(and(
                sql`${productFacetValues.facetKind} = 'attribute'`,
                eq(productFacetValues.facetKey, attribute.id),
            )));
        }
        await safeBatch(db, statements as never);
        result.changed = true;
    }

    // 3. Rewrite the rows, 90 products per batch, in (value, product) keyset order.
    let cursor: { value: string; productId: string } | null = null;
    for (;;) {
        const chunk: Array<{ productId: string; value: string }> = await db
            .select({ productId: productAttributeValues.productId, value: productAttributeValues.value })
            .from(productAttributeValues)
            .where(and(
                wrong,
                cursor === null
                    ? undefined
                    : sql`(${productAttributeValues.value}, ${productAttributeValues.productId}) > (${cursor.value}, ${cursor.productId})`,
            ))
            .orderBy(asc(productAttributeValues.value), asc(productAttributeValues.productId))
            .limit(ATTRIBUTE_WRITE_PRODUCTS_PER_BATCH)
            .all();
        if (chunk.length === 0) break;
        const last = chunk[chunk.length - 1]!;
        cursor = { value: last.value, productId: last.productId };

        const convertible: Array<{ productId: string; value: string; valueNumber: number | null }> = [];
        for (const row of chunk) {
            const encoded = encodeAttributeValue(target, row.value, unit);
            if (encoded === null) {
                result.skipped += 1;
                if (result.skippedSamples.length < SAMPLE_LIMIT) result.skippedSamples.push(row.value);
            } else {
                convertible.push({ productId: row.productId, ...encoded });
            }
        }
        if (convertible.length > 0) {
            const productIds = convertible.map((row) => row.productId);
            const inChunk = and(wrong, sql`${productAttributeValues.productId} IN ${jsonIdSet(productIds)}`)!;
            const statements: AttributeBatchItem[] = [];
            if (target === "text") {
                statements.push(db.update(productAttributeValues).set({ valueId: null, valueNumber: null }).where(inChunk));
            } else if (target === "enum") {
                const seen = new Set<string>();
                const values = convertible.filter((row) => {
                    const key = normalizeAttributeValue(row.value);
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                // Values written after validation are created here (idempotent).
                statements.push(attributeValueInsertStatement(
                    db,
                    attribute.id,
                    values.map((row) => ({ id: newAttributeValueId(), value: row.value, sortOrder: null })),
                ));
                const match = sql`(SELECT enum_value.id FROM ${attributeValues} AS enum_value
                    WHERE enum_value.attribute_id = ${productAttributeValues.attributeId}
                      AND enum_value.deleted_at IS NULL
                      AND enum_value.normalized_value = lower(trim(${productAttributeValues.value})))`;
                const display = sql`(SELECT enum_value.value FROM ${attributeValues} AS enum_value
                    WHERE enum_value.attribute_id = ${productAttributeValues.attributeId}
                      AND enum_value.deleted_at IS NULL
                      AND enum_value.normalized_value = lower(trim(${productAttributeValues.value})))`;
                statements.push(db.update(productAttributeValues)
                    .set({ valueId: match, value: sql`COALESCE(${display}, ${productAttributeValues.value})`, valueNumber: null })
                    .where(and(inChunk, sql`${match} IS NOT NULL`)));
            } else {
                const payload = JSON.stringify(convertible.map((row) => ({ p: row.productId, v: row.value, n: row.valueNumber })));
                const pick = (field: "v" | "n") => sql`(SELECT json_extract(entry.value, ${`$.${field}`}) FROM json_each(${payload}) AS entry
                    WHERE CAST(json_extract(entry.value, '$.p') AS TEXT) = ${productAttributeValues.productId})`;
                statements.push(db.update(productAttributeValues)
                    .set({
                        valueId: null,
                        value: sql`CAST(${pick("v")} AS TEXT)`,
                        valueNumber: sql`CAST(${pick("n")} AS NUMERIC)`,
                    })
                    .where(inChunk));
            }
            statements.push(productRevisionBumpStatement(db, productIds), ...refresh(productIds));
            await safeBatch(db, statements as never);
            result.converted += convertible.length;
            result.changed = true;
        }
        if (chunk.length < ATTRIBUTE_WRITE_PRODUCTS_PER_BATCH) break;
    }

    // 4. Number and yes/no attributes keep no value vocabulary.
    if (target === "number" || target === "boolean") {
        const retired = await db.update(attributeValues)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(and(eq(attributeValues.attributeId, attribute.id), isNull(attributeValues.deletedAt)))
            .returning({ id: attributeValues.id });
        if (retired.length > 0) result.changed = true;
    }
    return result;
}
