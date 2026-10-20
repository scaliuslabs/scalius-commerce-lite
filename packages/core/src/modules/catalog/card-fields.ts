// Optional card custom fields share the cards' existing batch wave.
import { customFieldDefinitions, customFieldValues, themeSettings } from "@scalius/database/schema";
import type { Database, safeBatch } from "@scalius/database/client";
import { and, eq, notInArray, sql, type SQLWrapper } from "drizzle-orm";
import { customFieldStorefrontValue, type CustomFieldWireValue } from "@scalius/shared/custom-fields";
import { parseStoredStorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { deps } from "../../cache-deps";
import { storeCurrencyCodeSql, storeCurrencyFromCode, storeDecimalPlacesFromCode } from "../settings";
import type { StorefrontCustomFieldRow } from "../custom-fields";

export type ProductCardFields = Record<string, CustomFieldWireValue>;
export type ProductCardFieldsById = ReadonlyMap<string, ProductCardFields>;
type BatchStatement = Parameters<typeof safeBatch>[1][number];

/** Fold the theme into a listing's existing summary statement. */
export function cardFieldsThemeSql() {
    deps.theme();
    return sql<string | null>`(SELECT ${themeSettings.colors} FROM ${themeSettings} WHERE ${themeSettings.id} = 'default' LIMIT 1)`;
}

export function cardFieldsOfTheme(value: string | null | undefined): string[] {
    return parseStoredStorefrontThemeDocument(value)?.blocks.card.fields ?? [];
}

export function selectProductCardFields(db: Database, productIds: readonly string[] | SQLWrapper, fields: readonly string[]) {
    deps.customFieldDefinitions("product");
    const ids = Array.isArray(productIds)
        ? sql`SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIds)})`
        : sql`SELECT * FROM ${productIds as SQLWrapper} AS card_field_ids`;
    return db.select({
        cfOwnerId: customFieldValues.ownerId,
        cfNamespace: customFieldDefinitions.namespace,
        cfKey: customFieldDefinitions.key,
        cfName: customFieldDefinitions.name,
        cfType: customFieldDefinitions.type,
        cfValue: customFieldValues.value,
        cfCurrencyCode: storeCurrencyCodeSql(),
    }).from(customFieldValues).innerJoin(customFieldDefinitions, and(
        eq(customFieldDefinitions.id, customFieldValues.definitionId),
        eq(customFieldDefinitions.ownerType, "product"),
        eq(customFieldDefinitions.storefrontVisible, true),
        // Object references need publication-aware resolution before they can be public.
        notInArray(customFieldDefinitions.type, ["object_reference", "list.object_reference"]),
    )).where(and(
        eq(customFieldValues.ownerType, "product"),
        sql`${customFieldValues.ownerId} IN (${ids})`,
        sql`${customFieldDefinitions.namespace} || '.' || ${customFieldDefinitions.key} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(fields)}))`,
    ));
}

export function resolveProductCardFields(rows: readonly StorefrontCustomFieldRow[]): Map<string, ProductCardFields> {
    const result = new Map<string, ProductCardFields>();
    for (const row of rows) {
        const value = customFieldStorefrontValue(row.cfType, row.cfValue, {
            decimalPlaces: storeDecimalPlacesFromCode(row.cfCurrencyCode),
            currencyCode: storeCurrencyFromCode(row.cfCurrencyCode),
        });
        if (value === null) continue;
        const fields = result.get(row.cfOwnerId) ?? {};
        fields[`${row.cfNamespace}.${row.cfKey}`] = value;
        result.set(row.cfOwnerId, fields);
    }
    return result;
}

/** At most one statement across all card lists in this batch; none without fields. */
export function planProductCardFields(db: Database, productIds: readonly SQLWrapper[], fields: readonly string[]) {
    const statements: BatchStatement[] = fields.length === 0 || productIds.length === 0 ? [] : [
        selectProductCardFields(db, sql`(${sql.join(productIds.map((ids) => sql`SELECT * FROM ${ids} AS card_field_source`), sql` UNION `)})`, fields),
    ];
    return {
        statements,
        resolve(results: readonly unknown[], offset: number): ProductCardFieldsById {
            return resolveProductCardFields(statements.length ? results[offset] as StorefrontCustomFieldRow[] : []);
        },
    };
}
