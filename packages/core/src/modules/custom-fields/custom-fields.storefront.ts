// Buyer reads of custom fields: the storefront-visible values of an owner as
// one statement a public reader adds to the batch it already runs (no extra
// round trip), and their wire form. The statement declares
// `cf:<owner type>` (and, through the store currency it carries for money,
// the currency document); the reader declares the owner's own key, which a
// value write advances (cache-deps registry, custom_field_values).

import { customFieldDefinitions, customFieldValues, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import {
    customFieldWireValue,
    type CustomFieldType,
} from "@scalius/shared/custom-fields";
import { deps } from "../../cache-deps";
import { storeCurrencyCodeSql, storeCurrencyFromCode, storeDecimalPlacesFromCode } from "../settings";

/** Owner types whose values a buyer can see. */
export type StorefrontCustomFieldOwnerType = "product" | "variant" | "category" | "collection" | "brand" | "page";

export interface StorefrontCustomField {
    namespace: string;
    key: string;
    name: string;
    type: CustomFieldType;
    /**
     * The wire value (`CustomFieldWireValue`), opaque JSON at the HTTP edge:
     * the recursive JSON type would make every typed route response expand
     * without bound, and the shared codec owns its shape.
     */
    value: unknown;
}

/** Row columns, aliased so they never collide with a joined reader's columns in a D1 batch. */
export interface StorefrontCustomFieldRow {
    cfOwnerId: string;
    cfNamespace: string;
    cfKey: string;
    cfName: string;
    cfType: CustomFieldType;
    cfValue: string;
    /** The store currency code (money values are its minor units). */
    cfCurrencyCode: string | null;
}

/**
 * The storefront-visible values of the owners `ownerId` names (an id, or a
 * subquery such as a slug lookup), in definition order.
 */
export function selectStorefrontCustomFieldRows(
    db: Database,
    ownerType: StorefrontCustomFieldOwnerType,
    ownerId: string | SQL,
) {
    deps.customFieldDefinitions(ownerType);
    return db.select({
        cfOwnerId: customFieldValues.ownerId,
        cfNamespace: customFieldDefinitions.namespace,
        cfKey: customFieldDefinitions.key,
        cfName: customFieldDefinitions.name,
        cfType: customFieldDefinitions.type,
        cfValue: customFieldValues.value,
        cfCurrencyCode: storeCurrencyCodeSql(),
    })
        .from(customFieldValues)
        .innerJoin(customFieldDefinitions, and(
            eq(customFieldDefinitions.id, customFieldValues.definitionId),
            eq(customFieldDefinitions.storefrontVisible, true),
        ))
        .where(and(
            eq(customFieldValues.ownerType, ownerType),
            typeof ownerId === "string" ? eq(customFieldValues.ownerId, ownerId) : sql`${customFieldValues.ownerId} = ${ownerId}`,
        ))
        .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id));
}

/** The storefront-visible values of every SKU of a product (live or not; callers pick their SKUs). */
export function selectStorefrontVariantCustomFieldRows(db: Database, productId: string) {
    deps.customFieldDefinitions("variant");
    return db.select({
        cfOwnerId: customFieldValues.ownerId,
        cfNamespace: customFieldDefinitions.namespace,
        cfKey: customFieldDefinitions.key,
        cfName: customFieldDefinitions.name,
        cfType: customFieldDefinitions.type,
        cfValue: customFieldValues.value,
        cfCurrencyCode: storeCurrencyCodeSql(),
    })
        .from(customFieldValues)
        .innerJoin(customFieldDefinitions, and(
            eq(customFieldDefinitions.id, customFieldValues.definitionId),
            eq(customFieldDefinitions.storefrontVisible, true),
        ))
        .where(and(
            eq(customFieldValues.ownerType, "variant"),
            sql`${customFieldValues.ownerId} IN (SELECT ${productVariants.id} FROM ${productVariants} WHERE ${productVariants.productId} = ${productId})`,
        ))
        .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id));
}

/** Rows to the wire form, skipping any stored text that is not canonical for its type. */
export function presentStorefrontCustomFields(rows: readonly StorefrontCustomFieldRow[]): StorefrontCustomField[] {
    const fields: StorefrontCustomField[] = [];
    for (const row of rows) {
        const context = {
            decimalPlaces: storeDecimalPlacesFromCode(row.cfCurrencyCode),
            currencyCode: storeCurrencyFromCode(row.cfCurrencyCode),
        };
        const value = customFieldWireValue(row.cfType, row.cfValue, context);
        if (value === null) continue;
        fields.push({ namespace: row.cfNamespace, key: row.cfKey, name: row.cfName, type: row.cfType, value });
    }
    return fields;
}

/** Rows grouped by owner, each owner's fields in definition order. */
export function groupStorefrontCustomFields(rows: readonly StorefrontCustomFieldRow[]): Map<string, StorefrontCustomField[]> {
    const byOwner = new Map<string, StorefrontCustomFieldRow[]>();
    for (const row of rows) byOwner.set(row.cfOwnerId, [...(byOwner.get(row.cfOwnerId) ?? []), row]);
    return new Map([...byOwner].map(([ownerId, ownerRows]) => [ownerId, presentStorefrontCustomFields(ownerRows)]));
}
