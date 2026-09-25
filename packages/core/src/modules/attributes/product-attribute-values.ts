// src/modules/attributes/product-attribute-values.ts
// Typed product attribute value rows for the product editor's batch.
//
// One read resolves the assigned attributes' definitions and the live enum
// values their text names; each assignment then becomes the row its type
// needs (the type-guard triggers accept exactly these shapes):
// - text: trimmed display, at most 200 characters;
// - enum: `value_id` of the live value with that normalised text (an unknown
//   value is created in the same batch, before the product rows, with ON
//   CONFLICT DO NOTHING) and that value's display text;
// - number: `value_number` plus canonical display (optional trailing unit);
// - boolean: 0/1 plus "Yes"/"No".
// Two statements, each with at most three bound parameters.
import { attributeValues, productAttributes, productAttributeValues } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ValidationError } from "@scalius/core/errors";
import { normalizeAttributeValue } from "@scalius/shared/catalog-attributes";

import { encodeAttributeValue } from "./attribute-value-codec";
import { attributeValueInsertStatement, type NewAttributeValueRow } from "./attribute-definition";
import { newAttributeValueId } from "./attribute-values";
import type { AttributeBatchItem } from "./projection-refresh";

/** Attributes one product may carry (one statement's worth of rows). */
export const MAX_PRODUCT_ATTRIBUTE_ASSIGNMENTS = 90;

export interface ProductAttributeAssignment {
    attributeId: string;
    value: string;
}

type AssignmentDefinition = {
    attributeId: string;
    valueType: "text" | "number" | "boolean" | "enum";
    unit: string | null;
    deletedAt: unknown;
    enumValueId: string | null;
    enumValue: string | null;
};

/**
 * Validates a product's attribute assignments and returns the statements that
 * insert its typed value rows (append them to the product's batch after the
 * product row and after any delete of its old rows). Blank values are
 * skipped, as the editor always did.
 */
export async function prepareProductAttributeValueRows(
    db: Database,
    productId: string,
    assignments: ReadonlyArray<ProductAttributeAssignment>,
): Promise<{ statements: AttributeBatchItem[] }> {
    const entries = assignments
        .map((assignment, index) => ({ index, attributeId: assignment.attributeId.trim(), raw: assignment.value }))
        .filter((entry) => entry.attributeId && entry.raw.trim());
    if (entries.length === 0) return { statements: [] };
    const uniqueIds = new Set(entries.map((entry) => entry.attributeId));
    if (uniqueIds.size > MAX_PRODUCT_ATTRIBUTE_ASSIGNMENTS || entries.length > MAX_PRODUCT_ATTRIBUTE_ASSIGNMENTS) {
        throw new ValidationError(`Assign at most ${MAX_PRODUCT_ATTRIBUTE_ASSIGNMENTS} attributes to a product.`);
    }
    if (uniqueIds.size !== entries.length) {
        throw new ValidationError("Each attribute can be assigned only once.", { field: "attributes" });
    }

    const lookup = JSON.stringify(entries.map((entry) => ({ a: entry.attributeId, v: entry.raw.trim() })));
    const definitions: AssignmentDefinition[] = await db
        .select({
            attributeId: productAttributes.id,
            valueType: productAttributes.valueType,
            unit: productAttributes.unit,
            deletedAt: productAttributes.deletedAt,
            enumValueId: attributeValues.id,
            enumValue: attributeValues.value,
        })
        .from(sql`json_each(${lookup}) AS assignment`)
        .innerJoin(productAttributes, sql`${productAttributes.id} = CAST(json_extract(assignment.value, '$.a') AS TEXT)`)
        .leftJoin(attributeValues, sql`${attributeValues.attributeId} = ${productAttributes.id}
            AND ${productAttributes.valueType} = 'enum'
            AND ${attributeValues.deletedAt} IS NULL
            AND ${attributeValues.normalizedValue} = lower(trim(CAST(json_extract(assignment.value, '$.v') AS TEXT)))`)
        .all();
    const byAttribute = new Map(definitions.map((definition) => [definition.attributeId, definition]));
    if (entries.some((entry) => {
        const definition = byAttribute.get(entry.attributeId);
        return !definition || definition.deletedAt !== null;
    })) {
        throw new ValidationError(
            "One or more assigned attributes are unavailable or in trash. Remove them and try again.",
        );
    }

    const newEnumValues = new Map<string, NewAttributeValueRow & { attributeId: string }>();
    // `k` is the row's kind as text: json_extract() yields text on PostgreSQL.
    const rows: Array<{ id: string; a: string; v: string; n: number | null; k: "enum" | "plain" }> = [];
    for (const entry of entries) {
        const definition = byAttribute.get(entry.attributeId)!;
        const encoded = encodeAttributeValue(definition.valueType, entry.raw, definition.unit);
        if (encoded === null) {
            const field = `attributes.${entry.index}.value`;
            if (definition.valueType === "number") {
                throw new ValidationError(
                    `"${entry.raw.trim()}" is not a number${definition.unit ? ` (in ${definition.unit})` : ""}.`,
                    { field },
                );
            }
            if (definition.valueType === "boolean") {
                throw new ValidationError(`"${entry.raw.trim()}" is not yes or no.`, { field });
            }
            throw new ValidationError("Attribute values must be at most 200 characters long.", { field });
        }
        if (definition.valueType === "enum") {
            if (definition.enumValueId === null) {
                const key = `${entry.attributeId}\u0000${normalizeAttributeValue(encoded.value)}`;
                if (!newEnumValues.has(key)) {
                    newEnumValues.set(key, { attributeId: entry.attributeId, id: newAttributeValueId(), value: encoded.value, sortOrder: null });
                }
            }
            rows.push({ id: `val_${nanoid()}`, a: entry.attributeId, v: encoded.value, n: null, k: "enum" });
        } else {
            rows.push({ id: `val_${nanoid()}`, a: entry.attributeId, v: encoded.value, n: encoded.valueNumber, k: "plain" });
        }
    }

    const statements: AttributeBatchItem[] = [];
    const newByAttribute = new Map<string, NewAttributeValueRow[]>();
    for (const value of newEnumValues.values()) {
        const list = newByAttribute.get(value.attributeId) ?? [];
        list.push({ id: value.id, value: value.value, sortOrder: null });
        newByAttribute.set(value.attributeId, list);
    }
    for (const [attributeId, values] of newByAttribute) {
        statements.push(attributeValueInsertStatement(db, attributeId, values));
    }

    // Enum rows name their value by (attribute, normalised text) at write
    // time, so a value created above or renamed meanwhile still resolves.
    // Numbers cast AS NUMERIC: REAL is single precision on PostgreSQL.
    const payload = JSON.stringify(rows);
    const enumValue = (column: "id" | "value") => sql`(
        SELECT enum_value.${sql.raw(column)} FROM ${attributeValues} AS enum_value
        WHERE enum_value.attribute_id = CAST(json_extract(entry.value, '$.a') AS TEXT)
          AND enum_value.deleted_at IS NULL
          AND enum_value.normalized_value = lower(trim(CAST(json_extract(entry.value, '$.v') AS TEXT)))
    )`;
    statements.push(db.insert(productAttributeValues).select(sql`
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT),
               ${productId},
               CAST(json_extract(entry.value, '$.a') AS TEXT),
               CASE WHEN CAST(json_extract(entry.value, '$.k') AS TEXT) = 'enum'
                    THEN COALESCE(${enumValue("value")}, CAST(json_extract(entry.value, '$.v') AS TEXT))
                    ELSE CAST(json_extract(entry.value, '$.v') AS TEXT) END,
               unixepoch(),
               CASE WHEN CAST(json_extract(entry.value, '$.k') AS TEXT) = 'enum' THEN ${enumValue("id")} ELSE NULL END,
               CAST(json_extract(entry.value, '$.n') AS NUMERIC)
        FROM json_each(${payload}) AS entry
        WHERE 1 = 1
    `));
    return { statements };
}
