// Buyer reads of custom fields: the storefront-visible values of an owner as
// one statement a public reader adds to the batch it already runs (no extra
// round trip), and their wire form. The statement declares
// `cf:<owner type>` (and, through the store currency it carries for money,
// the currency document); the reader declares the owner's own key, which a
// value write advances (cache-deps registry, custom_field_values).

import { collections, customFieldDefinitions, customFieldValues, media, objectRecords, objectTypes, productBuyerState, productChannelPublications, products, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import {
    customFieldWireValue,
    type CustomFieldCodecContext,
    type CustomFieldType,
} from "@scalius/shared/custom-fields";
import { OBJECT_FIELDS_MAX, objectDataWire, objectFieldSchema } from "@scalius/shared/plugins/objects";
import { deps } from "../../cache-deps";
import { getCurrentMediaUrl } from "../../integrations/storage";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { ONLINE_STORE_CHANNEL_ID } from "@scalius/shared/sales-channels";
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
    /** Qualified object type for object-reference values. */
    to?: string;
    /** One published referenced record, with only its declared public fields. */
    object?: { handle: string | null; fields: Array<{ key: string; name: string; type: CustomFieldType; value: unknown }> };
    /** A public scalar reference, resolved in the same read; the saved value remains its id. */
    reference?: { id: string; url: string; alt?: string; width?: number; height?: number };
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
    cfReference?: string | null;
    cfObjectTarget?: string | null;
}

/** Conditional primary-key lookups stay inside the owner's existing statement. */
function referenceColumn() {
    // Unused CASE branches read no target rows. Their possible membership is
    // covered by the owner's field values/definitions; real ids are declared below.
    deps.keys(["p:~", "col:~", "m:~", "obj:~"]);
    return sql<string | null>`CASE ${customFieldDefinitions.type}
        WHEN 'product_reference' THEN (
            SELECT json_object('slug', ${products.slug}, 'canonicalPath', ${products.canonicalPath})
            FROM ${products} JOIN ${productBuyerState} ON ${productBuyerState.productId} = ${products.id}
            WHERE ${products.id} = ${customFieldValues.value}
              AND ${products.isActive} = 1 AND ${products.deletedAt} IS NULL AND ${productBuyerState.isPublic} = 1
              AND EXISTS (SELECT 1 FROM ${productChannelPublications}
                  WHERE ${productChannelPublications.productId} = ${products.id}
                    AND ${productChannelPublications.channelId} = ${ONLINE_STORE_CHANNEL_ID}
                    AND ${productChannelPublications.unpublishedAt} IS NULL)
        )
        WHEN 'collection_reference' THEN (
            SELECT json_object('canonicalPath', ${collections.canonicalPath}) FROM ${collections}
            WHERE ${collections.id} = ${customFieldValues.value} AND ${collections.isActive} = 1 AND ${collections.deletedAt} IS NULL
        )
        WHEN 'media_reference' THEN (
            SELECT json_object('objectKey', ${media.objectKey}, 'variantWidth', ${media.variantWidth},
                'alt', ${media.altText}, 'width', ${media.width}, 'height', ${media.height}) FROM ${media}
            WHERE ${media.id} = ${customFieldValues.value} AND ${media.kind} = 'image' AND ${media.status} = 'ready'
        )
        WHEN 'object_reference' THEN ${publicObjectReference()}
        WHEN 'list.object_reference' THEN ${publicObjectReferenceIds()}
        END`.as("cf_reference");
}

function publicObjectReference() {
    return sql<string | null>`(SELECT json_object('id', ${objectRecords.id}, 'handle', ${objectRecords.handle},
        'fields', ${objectTypes.fieldsJson}, 'data', ${objectRecords.dataJson},
        'references', (SELECT coalesce(json_group_array(json_object('type', target.namespace || '.' || target.type, 'id', live.id)), '[]')
            FROM json_each(${objectTypes.fieldsJson}) AS field
            JOIN json_each(CASE WHEN json_type(${objectRecords.dataJson}, '$.' || json_extract(field.value, '$.key')) = 'array'
                THEN json_extract(${objectRecords.dataJson}, '$.' || json_extract(field.value, '$.key'))
                ELSE json_array(json_extract(${objectRecords.dataJson}, '$.' || json_extract(field.value, '$.key'))) END) AS reference
            JOIN object_types AS target ON target.id = 'oty_' || json_extract(field.value, '$.to') AND target.storefront = 1
            JOIN object_records AS live ON live.type_id = target.id AND live.id = CAST(reference.value AS TEXT) AND live.pub = 1 AND live.status = 'published'
            WHERE json_extract(field.value, '$.type') IN ('object_reference', 'list.object_reference')))
        FROM ${objectTypes} JOIN ${objectRecords} ON ${objectRecords.typeId} = ${objectTypes.id}
        WHERE ${objectTypes.id} = 'oty_' || json_extract(${customFieldDefinitions.validations}, '$.to')
            AND ${objectTypes.storefront} = 1 AND ${objectRecords.id} = ${customFieldValues.value}
            AND ${objectRecords.pub} = 1 AND ${objectRecords.status} = 'published')`;
}

function presentObjectReference(row: StorefrontCustomFieldRow, context: CustomFieldCodecContext): StorefrontCustomField["object"] {
    if (!row.cfReference) return undefined;
    try {
        const record = JSON.parse(row.cfReference) as { handle: string | null; fields: string; data: string; references: Array<{ type: string; id: string }> };
        const parsed = objectFieldSchema.array().max(OBJECT_FIELDS_MAX).safeParse(JSON.parse(record.fields));
        if (!parsed.success) return undefined;
        const fields = parsed.data.filter((field) => field.type !== "customer_reference" && field.type !== "order_reference");
        const data = objectDataWire({ fields }, JSON.parse(record.data), context);
        const live = new Set(record.references.map((reference) => `${reference.type}\0${reference.id}`));
        return { handle: record.handle, fields: fields.map((field) => {
            let value = data[field.key] ?? null;
            if (field.to) deps.objects([`oty_${field.to}`]);
            if (field.type === "object_reference") value = typeof value === "string" && live.has(`${field.to}\0${value}`) ? value : null;
            if (field.type === "list.object_reference") value = Array.isArray(value) ? value.map((id) => typeof id === "string" && live.has(`${field.to}\0${id}`) ? id : null) : null;
            return { key: field.key, name: field.name, type: field.type as CustomFieldType, value };
        }) };
    } catch {
        return undefined;
    }
}

function publicObjectReferenceIds() {
    return sql<string>`(SELECT coalesce(json_group_array(${objectRecords.id}), '[]')
        FROM json_each(CASE WHEN ${customFieldDefinitions.type} = 'list.object_reference' AND json_valid(${customFieldValues.value})
            THEN ${customFieldValues.value} ELSE json_array(${customFieldValues.value}) END) AS cf_object_ref
        JOIN ${objectTypes} ON ${objectTypes.id} = 'oty_' || json_extract(${customFieldDefinitions.validations}, '$.to')
            AND ${objectTypes.storefront} = 1
        JOIN ${objectRecords} ON ${objectRecords.typeId} = ${objectTypes.id}
            AND ${objectRecords.id} = CAST(cf_object_ref.value AS TEXT)
            AND ${objectRecords.pub} = 1 AND ${objectRecords.status} = 'published')`;
}

function presentReference(row: StorefrontCustomFieldRow, value: unknown): StorefrontCustomField["reference"] {
    if (typeof value !== "string") return undefined;
    if (row.cfType === "product_reference") deps.product(value);
    else if (row.cfType === "collection_reference") deps.collection(value);
    else if (row.cfType === "media_reference") deps.media(value);
    else return undefined;
    if (!row.cfReference) return undefined;
    const reference = JSON.parse(row.cfReference) as {
        slug?: string; canonicalPath?: string | null; objectKey?: string; variantWidth?: number | null;
        alt?: string | null; width?: number | null; height?: number | null;
    };
    if (row.cfType === "media_reference") {
        if (!reference.objectKey) return undefined;
        const url = normalizePublicMediaUrl(getCurrentMediaUrl(reference.objectKey, reference.variantWidth));
        if (!url) return undefined;
        return { id: value, url, alt: reference.alt ?? "", ...(reference.width ? { width: reference.width } : {}), ...(reference.height ? { height: reference.height } : {}) };
    }
    const kind = row.cfType === "product_reference" ? "product" : "collection";
    const url = normalizeResourceCanonicalPath(kind, reference.canonicalPath)
        ?? normalizeResourceCanonicalPath(kind, kind === "product" ? `/products/${reference.slug}` : `/collections/${value}`);
    return url ? { id: value, url } : undefined;
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
        cfReference: referenceColumn(),
        cfObjectTarget: sql<string | null>`json_extract(${customFieldDefinitions.validations}, '$.to')`.as("cf_object_target"),
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
        cfReference: referenceColumn(),
        cfObjectTarget: sql<string | null>`json_extract(${customFieldDefinitions.validations}, '$.to')`.as("cf_object_target"),
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
        let value = customFieldWireValue(row.cfType, row.cfValue, context);
        if (value === null) continue;
        const isObject = row.cfType === "object_reference" || row.cfType === "list.object_reference";
        const object = row.cfType === "object_reference" ? presentObjectReference(row, context) : undefined;
        if (isObject) {
            if (row.cfObjectTarget) deps.objects([`oty_${row.cfObjectTarget}`]);
            if (row.cfType === "object_reference") value = object ? value : null;
            else {
                const live = new Set<string>(JSON.parse(row.cfReference ?? "[]"));
                value = Array.isArray(value) ? value.map((id) => typeof id === "string" && live.has(id) ? id : null) : null;
            }
        }
        const reference = presentReference(row, value);
        fields.push({ namespace: row.cfNamespace, key: row.cfKey, name: row.cfName, type: row.cfType, value,
            ...(isObject && row.cfObjectTarget ? { to: row.cfObjectTarget } : {}), ...(object ? { object } : {}), ...(reference ? { reference } : {}) });
    }
    return fields;
}

/** Rows grouped by owner, each owner's fields in definition order. */
export function groupStorefrontCustomFields(rows: readonly StorefrontCustomFieldRow[]): Map<string, StorefrontCustomField[]> {
    const byOwner = new Map<string, StorefrontCustomFieldRow[]>();
    for (const row of rows) byOwner.set(row.cfOwnerId, [...(byOwner.get(row.cfOwnerId) ?? []), row]);
    return new Map([...byOwner].map(([ownerId, ownerRows]) => [ownerId, presentStorefrontCustomFields(ownerRows)]));
}
