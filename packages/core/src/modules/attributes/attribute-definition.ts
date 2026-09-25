// src/modules/attributes/attribute-definition.ts
// Small shared reads and statement builders of the attributes domain.
import { attributeValues, productAttributes } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NotFoundError } from "@scalius/core/errors";

import type { AttributeBatchItem } from "./projection-refresh";

export type LiveAttributeDefinition = {
    id: string;
    name: string;
    slug: string;
    valueType: "text" | "number" | "boolean" | "enum";
    unit: string | null;
    facetDisplay: "checkbox" | "range" | "swatch" | "search_list";
};

/** The live (not trashed) attribute, or NotFoundError. */
export async function readLiveAttributeDefinition(
    db: Database,
    attributeId: string,
): Promise<LiveAttributeDefinition> {
    const row = await db
        .select({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            valueType: productAttributes.valueType,
            unit: productAttributes.unit,
            facetDisplay: productAttributes.facetDisplay,
        })
        .from(productAttributes)
        .where(and(eq(productAttributes.id, attributeId), isNull(productAttributes.deletedAt)))
        .get();
    if (!row) throw new NotFoundError("Attribute not found");
    return row;
}

/** The error text of a unique-index failure on these columns/index names. */
export function isUniqueViolation(error: unknown, pattern: RegExp): boolean {
    const collect = (value: unknown, depth: number): string => {
        if (depth > 4 || value === null || value === undefined) return "";
        if (typeof value !== "object") return String(value);
        const candidate = value as { message?: unknown; cause?: unknown };
        return `${typeof candidate.message === "string" ? candidate.message : ""} ${collect(candidate.cause, depth + 1)}`;
    };
    const text = collect(error, 0);
    return /unique|duplicate key/i.test(text) && pattern.test(text);
}

export const ATTRIBUTE_VALUE_UNIQUE_PATTERN = /attribute_values(?:_live_value_unique|\.attribute_id|\.normalized_value)/i;

/** A new value row to insert; `sortOrder` null appends after the current values. */
export type NewAttributeValueRow = { id: string; value: string; sortOrder: number | null };

/**
 * Inserts value rows of one attribute from one bound JSON parameter; a value
 * whose normalised text already exists live is skipped (ON CONFLICT DO
 * NOTHING), so the statement is idempotent. `normalized_value` is computed in
 * SQL so it always equals the column CHECK `lower(trim(value))`.
 */
export function attributeValueInsertStatement(
    db: Database,
    attributeId: string,
    rows: readonly NewAttributeValueRow[],
): AttributeBatchItem {
    const payload = JSON.stringify(rows.map((row) => ({ i: row.id, v: row.value, s: row.sortOrder })));
    return db.insert(attributeValues).select(sql`
        SELECT CAST(json_extract(entry.value, '$.i') AS TEXT),
               ${attributeId},
               CAST(json_extract(entry.value, '$.v') AS TEXT),
               lower(trim(CAST(json_extract(entry.value, '$.v') AS TEXT))),
               COALESCE(
                   CAST(json_extract(entry.value, '$.s') AS INTEGER),
                   (SELECT COALESCE(MAX(existing.sort_order) + 1, 0)
                    FROM ${attributeValues} AS existing
                    WHERE existing.attribute_id = ${attributeId} AND existing.deleted_at IS NULL)
                   + CAST(entry.key AS INTEGER)
               ),
               NULL,
               unixepoch(),
               unixepoch(),
               NULL
        FROM json_each(${payload}) AS entry
        WHERE 1 = 1
    `).onConflictDoNothing();
}
