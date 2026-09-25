// src/modules/attributes/attributes.service.ts
// Attribute definitions (typed: value type, group, unit, order, key spec,
// highlight, filter widget) and the string-keyed value routes the dashboard
// already uses. The value vocabulary lives in attribute_values
// (./attribute-values.ts); the JSON `options` column is no longer read or
// written.

import {
    attributeValues,
    productAttributes,
    productAttributeValues,
    productFacetValues,
    products,
} from "@scalius/database/schema";
import { sql, eq, and, or, like, asc, desc, count, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import {
    defaultAttributeFacetDisplay,
    isAttributeFacetDisplayAllowed,
} from "@scalius/shared/catalog-attributes";
import type { BatchItem } from "drizzle-orm/batch";

import { insertWithDerivedHandle } from "../../utils/derived-handle";
import {
    isReservedAttributeSlug,
    type CreateAttributeInput,
    type UpdateAttributeInput,
} from "./attributes.validation";
import { encodeAttributeValue } from "./attribute-value-codec";
import { attributeValueInsertStatement, readLiveAttributeDefinition } from "./attribute-definition";
import { assertLiveAttributeGroup } from "./attribute-groups";
import {
    createAttributeValueRow,
    newAttributeValueId,
    planAttributeValuePresets,
    readAttributePresetTexts,
    refreshProductsReferencingValues,
} from "./attribute-values";
import {
    forEachAttributeProductChunk,
    jsonIdSet,
    productRevisionBumpStatement,
    type CatalogProjectionRefresh,
} from "./projection-refresh";

type SQLiteBatchItem = BatchItem<"sqlite">;
const MAX_ATTRIBUTE_BULK_IDS = 90;
const MAX_ATTRIBUTE_PAGE_SIZE = 500;
const MAX_ATTRIBUTE_AGENT_PAGE_SIZE = 50;
const MAX_ATTRIBUTE_VALUE_LENGTH = 100;
/** Preset values the legacy list returns per attribute as `options`. */
const MAX_LISTED_OPTIONS = 500;

/** The typed definition columns every attribute response carries. */
const typedDefinitionColumns = {
    groupId: productAttributes.groupId,
    valueType: productAttributes.valueType,
    unit: productAttributes.unit,
    sortOrder: productAttributes.sortOrder,
    keySpec: productAttributes.keySpec,
    highlight: productAttributes.highlight,
    facetDisplay: productAttributes.facetDisplay,
};

const attributeMutationColumns = {
    id: productAttributes.id,
    name: productAttributes.name,
    slug: productAttributes.slug,
    filterable: productAttributes.filterable,
    ...typedDefinitionColumns,
};

function attributeIdentityKey(value: string): string {
    return value.trim().toLowerCase();
}

async function findAttributeIdentityConflict(
    db: Database,
    identity: { name?: string; slug?: string; excludeId?: string },
) {
    const conditions: SQL[] = [];
    if (identity.name) {
        conditions.push(
            sql`lower(trim(${productAttributes.name})) = ${attributeIdentityKey(identity.name)}`,
        );
    }
    if (identity.slug) {
        conditions.push(
            sql`lower(trim(${productAttributes.slug})) = ${attributeIdentityKey(identity.slug)}`,
        );
    }
    if (conditions.length === 0) return undefined;

    const rows = await db
        .select({ id: productAttributes.id, deletedAt: productAttributes.deletedAt })
        .from(productAttributes)
        .where(and(
            or(...conditions),
            identity.excludeId
                ? sql`${productAttributes.id} != ${identity.excludeId}`
                : undefined,
        ))
        .limit(2);

    return rows.find((row) => row.deletedAt === null) ?? rows[0];
}

/** Live preset values per attribute (first 500 each, in order), for the legacy `options` field. */
async function presetOptionsByAttribute(db: Database, attributeIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (attributeIds.length === 0) return map;
    const ranked = db
        .select({
            attributeId: attributeValues.attributeId,
            value: attributeValues.value,
            rank: sql<number>`ROW_NUMBER() OVER (
                PARTITION BY ${attributeValues.attributeId}
                ORDER BY ${attributeValues.sortOrder}, ${attributeValues.normalizedValue}, ${attributeValues.id}
            )`.as("option_rank"),
        })
        .from(attributeValues)
        .where(and(
            isNull(attributeValues.deletedAt),
            sql`${attributeValues.attributeId} IN ${jsonIdSet(attributeIds)}`,
        ))
        .as("ranked_attribute_options");
    const rows = await db
        .select({ attributeId: ranked.attributeId, value: ranked.value })
        .from(ranked)
        .where(sql`${ranked.rank} <= ${MAX_LISTED_OPTIONS}`)
        .orderBy(ranked.attributeId, sql`${ranked.rank}`)
        .all();
    for (const row of rows) {
        const list = map.get(row.attributeId) ?? [];
        list.push(row.value);
        map.set(row.attributeId, list);
    }
    return map;
}

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listAttributes(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        sort?: string;
        order?: "asc" | "desc";
        showTrashed?: boolean;
        ids?: string[];
    } = {},
) {
    const {
        page: rawPage = 1,
        limit: rawLimit = 10,
        search = "",
        sort = "name",
        order = "asc",
        showTrashed = false,
        ids: rawIds,
    } = options;

    const page = Math.max(1, Math.floor(rawPage));
    const limit = Math.min(MAX_ATTRIBUTE_PAGE_SIZE, Math.max(1, Math.floor(rawLimit)));

    const offset = (page - 1) * limit;

    const whereConditions = [];
    if (showTrashed) {
        whereConditions.push(sql`${productAttributes.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${productAttributes.deletedAt} IS NULL`);
    }

    if (search) {
        whereConditions.push(
            or(
                like(productAttributes.name, `%${search}%`),
                like(productAttributes.slug, `%${search}%`),
            ),
        );
    }

    if (rawIds !== undefined) {
        const ids = normalizeAttributeIds(rawIds);
        whereConditions.push(ids.length > 0
            ? sql`${productAttributes.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)})
            )`
            : sql`0 = 1`);
    }

    const combinedWhereClause =
        whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const totalResult = await db
        .select({ count: count(productAttributes.id) })
        .from(productAttributes)
        .where(combinedWhereClause)
        .get();

    const total = totalResult?.count ?? 0;

    const ALLOWED_SORT_FIELDS = ["name", "slug", "filterable", "createdAt", "updatedAt", "sortOrder"] as const;
    type SortField = typeof ALLOWED_SORT_FIELDS[number];
    const safeSortField: SortField = ALLOWED_SORT_FIELDS.includes(sort as SortField) ? sort as SortField : "name";
    const sortColumn = productAttributes[safeSortField];
    const attributes = await db
        .select({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            filterable: productAttributes.filterable,
            createdAt: productAttributes.createdAt,
            updatedAt: productAttributes.updatedAt,
            deletedAt: productAttributes.deletedAt,
            ...typedDefinitionColumns,
        })
        .from(productAttributes)
        .where(combinedWhereClause)
        .orderBy(
            order === "asc"
                ? asc(sortColumn)
                : desc(sortColumn),
        )
        .limit(limit)
        .offset(offset);

    const attributeIds = attributes.map((attr) => attr.id);
    const attributeIdsJson = JSON.stringify(attributeIds);
    const valueCounts =
        attributeIds.length > 0
            ? await db
                .select({
                    attributeId: productAttributeValues.attributeId,
                    valueCount: count(sql`DISTINCT ${productAttributeValues.value}`)
                })
                .from(productAttributeValues)
                .where(sql`${productAttributeValues.attributeId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${attributeIdsJson})
                )`)
                .groupBy(productAttributeValues.attributeId)
                .all()
            : [];

    const valueCountMap = new Map(
        valueCounts.map((item) => [item.attributeId, item.valueCount]),
    );

    const presetOptions = await presetOptionsByAttribute(db, attributeIds);
    const enrichedAttributes = attributes.map((attr) => ({
        ...attr,
        options: presetOptions.get(attr.id) ?? [],
        valueCount: valueCountMap.get(attr.id) || 0
    }));

    return {
        attributes: enrichedAttributes,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

/**
 * Compact attribute discovery for agent clients. The dashboard list retains
 * preset options for its editor, but those options can legitimately contain
 * 500 x 100-character values per row and therefore cannot be advertised as a
 * bounded structured agent response.
 */
export async function listAttributeAgentSummaries(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        sort?: string;
        order?: "asc" | "desc";
        showTrashed?: boolean;
        ids?: string[];
    } = {},
) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const limit = Math.min(
        MAX_ATTRIBUTE_AGENT_PAGE_SIZE,
        Math.max(1, Math.floor(options.limit ?? 20)),
    );
    const conditions: SQL[] = [
        options.showTrashed
            ? sql`${productAttributes.deletedAt} IS NOT NULL`
            : sql`${productAttributes.deletedAt} IS NULL`,
    ];
    const search = options.search?.trim();
    if (search) {
        conditions.push(or(
            like(productAttributes.name, `%${search}%`),
            like(productAttributes.slug, `%${search}%`),
        )!);
    }
    if (options.ids !== undefined) {
        const ids = normalizeAttributeIds(options.ids);
        conditions.push(ids.length > 0
            ? sql`${productAttributes.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)})
            )`
            : sql`0 = 1`);
    }
    const where = and(...conditions);
    const allowedSortFields = ["name", "slug", "filterable", "createdAt", "updatedAt", "sortOrder"] as const;
    type SortField = typeof allowedSortFields[number];
    const sort = allowedSortFields.includes(options.sort as SortField)
        ? options.sort as SortField
        : "name";
    const sortColumn = productAttributes[sort];
    const countRows = await db.select({ count: count(productAttributes.id) })
        .from(productAttributes)
        .where(where);
    const attributes = await db
        .select({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            filterable: productAttributes.filterable,
            deletedAt: productAttributes.deletedAt,
            ...typedDefinitionColumns,
        })
        .from(productAttributes)
        .where(where)
        .orderBy(options.order === "desc" ? desc(sortColumn) : asc(sortColumn))
        .limit(limit)
        .offset((page - 1) * limit);
    const total = Number(countRows[0]?.count ?? 0);
    return {
        attributes,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createAttribute(
    db: Database,
    data: CreateAttributeInput,
) {
    const { name, slug } = data;
    const filterable = data.filterable ?? true;
    const valueType = data.valueType ?? "text";
    const options = data.options ?? [];
    if (slug && isReservedAttributeSlug(slug)) {
        throw new ValidationError("That slug is a storefront listing query key. Choose another.", { field: "slug" });
    }
    const facetDisplay = data.facetDisplay ?? defaultAttributeFacetDisplay(valueType);
    if (!isAttributeFacetDisplayAllowed(valueType, facetDisplay)) {
        throw new ValidationError(`A ${facetDisplay} filter does not suit ${valueType} values.`, { field: "facetDisplay" });
    }
    if (data.unit && valueType !== "number") {
        throw new ValidationError("Only number attributes have a unit.", { field: "unit" });
    }
    if ((valueType === "number" || valueType === "boolean") && options.length > 0) {
        throw new ValidationError("Number and yes/no attributes have no preset values.", { field: "options" });
    }
    await assertLiveAttributeGroup(db, data.groupId);

    const existingAttribute = await findAttributeIdentityConflict(db, { name, slug });

    if (existingAttribute) {
        if (existingAttribute.deletedAt) {
            throw new ConflictError(
                "A deleted attribute with that name or slug exists. Restore it from the trash or permanently delete it first."
            );
        }
        throw new ConflictError("An attribute with that name or slug already exists.");
    }

    const newAttributeId = "attr_" + nanoid();
    const presetRows = options.map((value, index) => ({ id: newAttributeValueId(), value, sortOrder: index }));
    const insertWithSlug = async (handle: string) => {
        const results = await safeBatch(db, [
            db
                .insert(productAttributes)
                .values({
                    id: newAttributeId,
                    name,
                    slug: handle,
                    filterable,
                    valueType,
                    groupId: data.groupId ?? null,
                    unit: valueType === "number" ? data.unit ?? null : null,
                    sortOrder: data.sortOrder ?? 0,
                    keySpec: data.keySpec ?? false,
                    highlight: data.highlight ?? false,
                    facetDisplay,
                    createdAt: sql`(cast(strftime('%s','now') as int))`,
                    updatedAt: sql`(cast(strftime('%s','now') as int))`
                })
                .returning(attributeMutationColumns),
            ...(presetRows.length > 0 ? [attributeValueInsertStatement(db, newAttributeId, presetRows)] : []),
        ] as never) as unknown[];
        return results[0] as Array<Record<keyof typeof attributeMutationColumns, unknown>>;
    };
    const [insertedAttribute] = slug
        ? await insertWithSlug(slug)
        : await insertWithDerivedHandle(
            {
                db,
                table: productAttributes,
                column: productAttributes.slug,
                isReserved: isReservedAttributeSlug,
                isHandleConflict: (error) => /product_attributes(?:_slug_unique|\.slug)/i.test(
                    error instanceof Error ? error.message : String(error),
                ),
            },
            name,
            "attribute",
            insertWithSlug,
        );
    if (!insertedAttribute) throw new Error("Attribute insert did not return a row");

    return { attribute: insertedAttribute as AttributeMutationResult };
}

export type AttributeMutationResult = {
    id: string;
    name: string;
    slug: string;
    filterable: boolean;
    groupId: string | null;
    valueType: "text" | "number" | "boolean" | "enum";
    unit: string | null;
    sortOrder: number;
    keySpec: boolean;
    highlight: boolean;
    facetDisplay: "checkbox" | "range" | "swatch" | "search_list";
};

/**
 * Updates the definition. `valueType` is not editable here (see
 * `convertAttributeValueType`); unit and filter widget are checked against the
 * stored type. `options` replaces the value vocabulary (attribute_values):
 * enum values that products use cannot be removed, and renaming or reordering
 * an enum value rewrites its products in bounded batches with their refresh.
 */
export async function updateAttribute(
    db: Database,
    id: string,
    data: UpdateAttributeInput,
    refresh: CatalogProjectionRefresh,
) {
    const current = await readLiveAttributeDefinition(db, id);

    if (data.slug && data.slug !== current.slug && isReservedAttributeSlug(data.slug)) {
        throw new ValidationError("That slug is a storefront listing query key. Choose another.", { field: "slug" });
    }
    if (data.name || data.slug) {
        const existingAttribute = await findAttributeIdentityConflict(db, {
            name: data.name,
            slug: data.slug,
            excludeId: id,
        });

        if (existingAttribute) {
            throw new ConflictError("An attribute with that name or slug already exists.");
        }
    }
    if (data.facetDisplay && !isAttributeFacetDisplayAllowed(current.valueType, data.facetDisplay)) {
        throw new ValidationError(
            `A ${data.facetDisplay} filter does not suit ${current.valueType} values.`,
            { field: "facetDisplay" },
        );
    }
    if (data.unit && current.valueType !== "number") {
        throw new ValidationError("Only number attributes have a unit.", { field: "unit" });
    }
    if (data.groupId !== undefined) await assertLiveAttributeGroup(db, data.groupId);

    const { options, ...definition } = data;
    const plan = options !== undefined
        ? await planAttributeValuePresets(db, current, options ?? [])
        : undefined;

    let results: unknown[];
    try {
        results = await safeBatch(db, [
            db
                .update(productAttributes)
                .set({
                    ...definition,
                    updatedAt: sql`(cast(strftime('%s','now') as int))`
                })
                .where(and(eq(productAttributes.id, id), isNull(productAttributes.deletedAt)))
                .returning(attributeMutationColumns),
            ...(plan?.statements ?? []),
        ] as never) as unknown[];
    } catch (error) {
        if (isBatchGuardError(error, "ATTRIBUTE_VALUE_IN_USE")) {
            throw new ConflictError("Products started using a removed value meanwhile. Refresh and try again.");
        }
        throw error;
    }
    const [updatedAttribute] = results[0] as AttributeMutationResult[];
    if (!updatedAttribute) throw new NotFoundError("Attribute not found");

    if (plan && plan.changedEnumValueIds.length > 0) {
        await refreshProductsReferencingValues(db, plan.changedEnumValueIds, refresh, {
            rewriteDisplay: plan.renamedEnumValueIds.length > 0,
        });
    }

    return { attribute: updatedAttribute };
}

function normalizeAttributeIds(ids: string[]): string[] {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    if (uniqueIds.length > MAX_ATTRIBUTE_BULK_IDS) {
        throw new ValidationError(`Select at most ${MAX_ATTRIBUTE_BULK_IDS} attributes at a time.`);
    }
    return uniqueIds;
}

async function assertAttributesDeletable(
    db: Database,
    ids: string[],
    permanent: boolean,
): Promise<void> {
    const existing = await db
        .select({ id: productAttributes.id, deletedAt: productAttributes.deletedAt })
        .from(productAttributes)
        .where(inArray(productAttributes.id, ids));

    if (existing.length !== ids.length) {
        throw new NotFoundError("One or more attributes no longer exist. Refresh and try again.");
    }
    if (permanent && existing.some((attribute) => attribute.deletedAt === null)) {
        throw new ConflictError("Move attributes to trash before permanently deleting them.");
    }
    if (!permanent && existing.some((attribute) => attribute.deletedAt !== null)) {
        throw new ConflictError("One or more attributes are already in trash. Refresh and try again.");
    }

    const usage = await db
        .select({
            productName: products.name,
            productId: products.id
        })
        .from(productAttributeValues)
        .leftJoin(products, eq(productAttributeValues.productId, products.id))
        .where(inArray(productAttributeValues.attributeId, ids))
        .limit(5);

    if (usage.length > 0) {
        const productNames = usage
            .map((item) => item.productName)
            .filter((name): name is string => Boolean(name))
            .join(", ");
        const action = permanent ? "permanently delete" : "trash";
        throw new ConflictError(
            `Cannot ${action} ${ids.length === 1 ? "this attribute" : "these attributes"} while product values still use ${ids.length === 1 ? "it" : "them"}.${productNames ? ` Referenced products include: ${productNames}.` : ""}`,
        );
    }
}

function attributeDeleteGuard(
    db: Database,
    ids: string[],
    permanent: boolean,
): SQLiteBatchItem {
    const idSet = JSON.stringify(ids);
    const lifecycleCondition = permanent
        ? sql`${productAttributes.deletedAt} IS NOT NULL`
        : sql`${productAttributes.deletedAt} IS NULL`;

    return buildBatchGuard(db, sql`
            (SELECT count(*) FROM ${productAttributes}
             WHERE ${productAttributes.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
             ) AND ${lifecycleCondition}) = ${ids.length}
            AND NOT EXISTS (
                SELECT 1 FROM ${productAttributeValues}
                WHERE ${productAttributeValues.attributeId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${idSet})
                )
            )
    `, "ATTRIBUTE_DELETE_CONFLICT");
}

async function deleteAttributes(
    db: Database,
    rawIds: string[],
    permanent: boolean,
): Promise<void> {
    const ids = normalizeAttributeIds(rawIds);
    if (ids.length === 0) return;

    await assertAttributesDeletable(db, ids, permanent);

    // A permanent delete removes the product values, then the value
    // vocabulary (product values name it ON DELETE RESTRICT), then the
    // definition, and the attribute's facet rows: what a refresh would leave.
    const writes: SQLiteBatchItem[] = permanent
        ? [
            db.delete(productFacetValues).where(and(
                sql`${productFacetValues.facetKind} = 'attribute'`,
                sql`${productFacetValues.facetKey} IN ${jsonIdSet(ids)}`,
            )),
            db.delete(productAttributeValues).where(sql`${productAttributeValues.attributeId} IN ${jsonIdSet(ids)}`),
            db.delete(attributeValues).where(sql`${attributeValues.attributeId} IN ${jsonIdSet(ids)}`),
            db.delete(productAttributes).where(sql`${productAttributes.id} IN ${jsonIdSet(ids)}`),
        ]
        : [
            db
                .update(productAttributes)
                .set({ deletedAt: sql`unixepoch()` })
                .where(inArray(productAttributes.id, ids)),
        ];

    try {
        await safeBatch(db, [attributeDeleteGuard(db, ids, permanent), ...writes] as never);
    } catch (error) {
        if (isBatchGuardError(error, "ATTRIBUTE_DELETE_CONFLICT")) {
            throw new ConflictError(
                "Attributes changed while the delete was being processed. Refresh and try again.",
            );
        }
        throw error;
    }
}

export async function deleteAttribute(db: Database, id: string) {
    await deleteAttributes(db, [id], false);
}

export async function permanentlyDeleteAttribute(db: Database, id: string) {
    await permanentlyDeleteAttributes(db, [id]);
}

async function permanentlyDeleteAttributes(db: Database, ids: string[]): Promise<void> {
    await deleteAttributes(db, ids, true);
}

export async function restoreAttribute(db: Database, id: string) {
    await restoreAttributes(db, [id]);
}

export async function bulkDeleteAttributes(db: Database, ids: string[], permanent = false) {
    await deleteAttributes(db, ids, permanent);
}

export async function bulkRestoreAttributes(db: Database, ids: string[]) {
    await restoreAttributes(db, ids);
}

function attributeRestoreGuard(db: Database, ids: string[]): SQLiteBatchItem {
    const idSet = JSON.stringify(ids);
    return buildBatchGuard(db, sql`
            (SELECT count(*) FROM ${productAttributes}
             WHERE ${productAttributes.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
             ) AND ${productAttributes.deletedAt} IS NOT NULL) = ${ids.length}
            AND NOT EXISTS (
                SELECT 1
                FROM ${productAttributes} AS selected
                JOIN ${productAttributes} AS active
                  ON active.deleted_at IS NULL
                 AND (
                    lower(trim(active.name)) = lower(trim(selected.name))
                    OR lower(trim(active.slug)) = lower(trim(selected.slug))
                 )
                WHERE selected.id IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${idSet})
                )
            )
    `, "ATTRIBUTE_RESTORE_CONFLICT");
}

async function restoreAttributes(db: Database, rawIds: string[]): Promise<void> {
    const ids = normalizeAttributeIds(rawIds);
    if (ids.length === 0) return;

    const attributes = await db
        .select({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            deletedAt: productAttributes.deletedAt,
        })
        .from(productAttributes)
        .where(inArray(productAttributes.id, ids));

    if (attributes.length !== ids.length) {
        throw new NotFoundError("One or more attributes no longer exist. Refresh and try again.");
    }
    if (attributes.some((attribute) => attribute.deletedAt === null)) {
        throw new ConflictError("Restore only attributes that are in trash. Refresh and try again.");
    }

    const selectedNames = new Set<string>();
    const selectedSlugs = new Set<string>();
    for (const attribute of attributes) {
        const nameKey = attributeIdentityKey(attribute.name);
        const slugKey = attributeIdentityKey(attribute.slug);
        if (selectedNames.has(nameKey) || selectedSlugs.has(slugKey)) {
            throw new ConflictError(
                "Cannot restore attributes with duplicate normalized names or slugs together.",
            );
        }
        selectedNames.add(nameKey);
        selectedSlugs.add(slugKey);
    }

    const idSet = JSON.stringify(ids);
    const activeConflict = await db
        .select({ id: productAttributes.id })
        .from(productAttributes)
        .where(and(
            isNull(productAttributes.deletedAt),
            sql`EXISTS (
                SELECT 1 FROM ${productAttributes} AS selected
                WHERE selected.id IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${idSet})
                ) AND (
                    lower(trim(selected.name)) = lower(trim(${productAttributes.name}))
                    OR lower(trim(selected.slug)) = lower(trim(${productAttributes.slug}))
                )
            )`,
        ))
        .limit(1);

    if (activeConflict.length > 0) {
        throw new ConflictError(
            "Cannot restore: an active attribute with the same normalized name or slug already exists.",
        );
    }

    const write = db
        .update(productAttributes)
        .set({ deletedAt: null, updatedAt: sql`unixepoch()` })
        .where(and(
            inArray(productAttributes.id, ids),
            sql`${productAttributes.deletedAt} IS NOT NULL`,
        ));

    try {
        await safeBatch(db, [attributeRestoreGuard(db, ids), write] as never);
    } catch (error) {
        if (isBatchGuardError(error, "ATTRIBUTE_RESTORE_CONFLICT")) {
            throw new ConflictError(
                "Attributes changed while the restore was being processed. Refresh and try again.",
            );
        }
        throw error;
    }
}

// ─────────────────────────────────────────
// Attribute Values
// ─────────────────────────────────────────

const ATTRIBUTE_VALUE_PAGE_LIMIT = 100;

function attributeValueKey(value: string): string {
    return value.trim().toLowerCase();
}

function dedupeAttributeOptions(options: string[]): string[] {
    const uniqueOptions: string[] = [];
    const seenKeys = new Set<string>();
    for (const option of options) {
        const normalizedOption = option.trim();
        const key = attributeValueKey(normalizedOption);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        uniqueOptions.push(normalizedOption);
    }
    return uniqueOptions;
}

function normalizeAttributeValue(value: string): string {
    const normalizedValue = value.trim();
    if (!normalizedValue) throw new ValidationError("Attribute value is required");
    if (normalizedValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
        throw new ValidationError(
            `Attribute value must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters long`,
        );
    }
    return normalizedValue;
}

function requireExistingAttributeValue(value: string): string {
    const trimmedValue = value.trim();
    if (!trimmedValue) throw new ValidationError("Attribute value is required");
    if (trimmedValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
        throw new ValidationError(
            `Attribute value must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters long`,
        );
    }
    return value;
}


export async function listAttributeValues(
    db: Database,
    attributeId: string,
    options: {
        search?: string;
        sort?: string;
        page?: number;
        limit?: number;
    } = {},
) {
    const search = options.search?.trim() || undefined;
    const sort = options.sort === "asc" ? "asc" : "desc";
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const limit = Math.min(
        ATTRIBUTE_VALUE_PAGE_LIMIT,
        Math.max(1, Math.floor(options.limit ?? 20)),
    );

    const attribute = await db
        .select({
            name: productAttributes.name,
            updatedAt: productAttributes.updatedAt,
        })
        .from(productAttributes)
        .where(
            and(
                eq(productAttributes.id, attributeId),
                isNull(productAttributes.deletedAt)
            )
        )
        .get();

    if (!attribute) throw new NotFoundError("Attribute not found");

    const offset = (page - 1) * limit;
    // Presets are the attribute's live attribute_values rows, in their order.
    const attrOptions = dedupeAttributeOptions(await readAttributePresetTexts(db, attributeId));
    const attrOptionKeys = new Set(attrOptions.map(attributeValueKey));

    // Build WHERE conditions for DB-level filtering
    const whereConditions = [
        eq(productAttributeValues.attributeId, attributeId),
        isNull(products.deletedAt),
    ];
    if (search) {
        whereConditions.push(like(productAttributeValues.value, `%${search}%`));
    }

    const combinedWhere = and(...whereConditions);

    // Get total count of distinct values at DB level
    const totalResult = await db
        .select({
            totalValues: count(sql`DISTINCT ${productAttributeValues.value}`),
            totalProducts: count(productAttributeValues.productId),
        })
        .from(productAttributeValues)
        .innerJoin(products, eq(productAttributeValues.productId, products.id))
        .where(combinedWhere)
        .get();

    // Get paginated distinct values with counts using GROUP BY
    const dbTotal = totalResult?.totalValues ?? 0;
    const dbItemsToFetch = offset < dbTotal
        ? Math.min(limit, dbTotal - offset)
        : 0;
    const dbValues = dbItemsToFetch > 0
        ? await db
            .select({
                value: productAttributeValues.value,
                productCount: count(productAttributeValues.productId),
                earliestCreatedAt: sql<number>`MIN(${productAttributeValues.createdAt})`,
            })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(combinedWhere)
            .groupBy(productAttributeValues.value)
            .orderBy(
                sort === "asc"
                    ? asc(sql`MIN(${productAttributeValues.createdAt})`)
                    : desc(sql`MIN(${productAttributeValues.createdAt})`)
            )
            .limit(dbItemsToFetch)
            .offset(offset)
            .all()
        : [];

    // Batch fetch sample product names for all values on this page
    const pageValues = dbValues.map((v) => v.value);
    const sampleProductMap = new Map<string, string[]>();
    if (pageValues.length > 0) {
        const rankedSamples = db
            .select({
                value: productAttributeValues.value,
                productName: products.name,
                sampleRank: sql<number>`ROW_NUMBER() OVER (
                    PARTITION BY ${productAttributeValues.value}
                    ORDER BY ${products.name}, ${products.id}
                )`.as("sample_rank"),
            })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    sql`${productAttributeValues.value} IN (
                        SELECT CAST(value AS TEXT)
                        FROM json_each(${JSON.stringify(pageValues)})
                    )`,
                    isNull(products.deletedAt),
                )
            )
            .as("ranked_attribute_value_samples");

        const allSamples = await db
            .select({
                value: rankedSamples.value,
                productName: rankedSamples.productName,
            })
            .from(rankedSamples)
            .where(lte(rankedSamples.sampleRank, 5))
            .all();

        // Group by value, keeping at most 5 sample names per value
        for (const row of allSamples) {
            const existing = sampleProductMap.get(row.value) || [];
            if (existing.length < 5) {
                existing.push(row.productName);
                sampleProductMap.set(row.value, existing);
            }
        }
    }

    const values = dbValues.map((row) => ({
        value: row.value,
        productCount: row.productCount,
        createdAt: row.earliestCreatedAt,
        isPreset: attrOptionKeys.has(attributeValueKey(row.value)),
        sampleProducts: sampleProductMap.get(row.value) || [],
    }));

    // Reconcile presets against every used value, not only the current page.
    // Bind the candidate set as one JSON value so a large preset list cannot
    // cross D1's 100-bound-parameter ceiling.
    const normalizedSearch = search ? attributeValueKey(search) : undefined;
    const matchingPresetOptions = normalizedSearch
        ? attrOptions.filter((option) => attributeValueKey(option).includes(normalizedSearch))
        : attrOptions;
    const matchingPresetKeys = matchingPresetOptions.map(attributeValueKey);
    const usedRows = matchingPresetOptions.length > 0
        ? await db
            .select({
                valueKey: sql<string>`lower(trim(${productAttributeValues.value}))`,
            })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    sql`lower(trim(${productAttributeValues.value})) IN (
                        SELECT CAST(value AS TEXT)
                        FROM json_each(${JSON.stringify(matchingPresetKeys)})
                    )`,
                    isNull(products.deletedAt),
                ),
            )
            .groupBy(sql`lower(trim(${productAttributeValues.value}))`)
            .all()
        : [];
    const usedPresetKeys = new Set(usedRows.map((row) => row.valueKey));

    const unusedPresets = matchingPresetOptions
        .filter((option) => !usedPresetKeys.has(attributeValueKey(option)))
        .map((opt) => ({
            value: opt,
            productCount: 0,
            createdAt: attribute.updatedAt instanceof Date
                ? Math.floor(attribute.updatedAt.getTime() / 1000)
                : (attribute.updatedAt as number),
            isPreset: true,
            sampleProducts: [] as string[],
        }));

    const totalValues = dbTotal + unusedPresets.length;

    // Used values keep their database order; unused presets follow in their
    // merchant-defined order and fill the remainder of the requested page.
    const presetOffset = Math.max(0, offset - dbTotal);
    const presetSlots = limit - values.length;
    const finalValues = presetSlots > 0
        ? [...values, ...unusedPresets.slice(presetOffset, presetOffset + presetSlots)]
        : values;

    return {
        attributeId,
        attributeName: attribute.name,
        values: finalValues,
        totalValues,
        totalProducts: totalResult?.totalProducts ?? 0,
        page,
        limit,
        totalPages: Math.ceil(totalValues / limit)
    };
}


/** Adds a preset (text) or a value (enum) to the attribute's vocabulary. */
export async function addAttributeValue(
    db: Database,
    attributeId: string,
    value: string,
) {
    await createAttributeValueRow(db, attributeId, { value: normalizeAttributeValue(value) });
}

/** A live vocabulary row of the attribute with this normalised text. */
async function findPresetRow(db: Database, attributeId: string, value: string) {
    return db
        .select({ id: attributeValues.id, value: attributeValues.value })
        .from(attributeValues)
        .where(and(
            eq(attributeValues.attributeId, attributeId),
            isNull(attributeValues.deletedAt),
            sql`${attributeValues.normalizedValue} = lower(trim(${value}))`,
        ))
        .get();
}

/** Product value rows of the attribute whose text matches `value` (normalised). */
function productValueTextMatch(attributeId: string, value: string): SQL {
    return and(
        eq(productAttributeValues.attributeId, attributeId),
        sql`lower(trim(${productAttributeValues.value})) = lower(trim(${value}))`,
    )!;
}

async function productValueTextUsed(db: Database, attributeId: string, value: string): Promise<boolean> {
    const row = await db
        .select({ id: productAttributeValues.id })
        .from(productAttributeValues)
        .where(productValueTextMatch(attributeId, value))
        .limit(1)
        .get();
    return row !== undefined;
}

/**
 * Renames a value across every product (and its preset). Enum values are
 * renamed on their attribute_values row and the products naming it follow;
 * text, number and yes/no values are rewritten by matching text. Products are
 * rewritten 90 per batch, each batch with their revision bump and projection
 * refresh.
 */
export async function renameAttributeValue(
    db: Database,
    attributeId: string,
    oldValue: string,
    newValue: string,
    refresh: CatalogProjectionRefresh,
) {
    const attribute = await readLiveAttributeDefinition(db, attributeId);
    const source = requireExistingAttributeValue(oldValue).trim();
    const target = normalizeAttributeValue(newValue);
    const preset = await findPresetRow(db, attributeId, source);
    const sourceUsed = await productValueTextUsed(db, attributeId, source);
    if (!preset && !sourceUsed) {
        throw new NotFoundError(`Attribute value "${oldValue.trim()}" no longer exists`);
    }
    if (attributeValueKey(source) !== attributeValueKey(target)) {
        const clash = await findPresetRow(db, attributeId, target) ?? (
            await productValueTextUsed(db, attributeId, target) ? { id: "" } : undefined
        );
        if (clash) throw new ConflictError(`Value "${target}" already exists for this attribute`);
    }

    if (attribute.valueType === "enum" && preset) {
        await db.update(attributeValues)
            .set({ value: target, normalizedValue: sql`lower(trim(${target}))`, updatedAt: sql`unixepoch()` })
            .where(and(eq(attributeValues.id, preset.id), isNull(attributeValues.deletedAt)))
            .run();
        await refreshProductsReferencingValues(db, [preset.id], refresh, { rewriteDisplay: true });
        return;
    }

    const encoded = encodeAttributeValue(attribute.valueType, target, attribute.unit);
    if (encoded === null) {
        throw new ValidationError(
            attribute.valueType === "number"
                ? `"${target}" is not a number.`
                : `"${target}" is not yes or no.`,
            { field: "newValue" },
        );
    }
    if (preset) {
        await db.update(attributeValues)
            .set({ value: target, normalizedValue: sql`lower(trim(${target}))`, updatedAt: sql`unixepoch()` })
            .where(and(eq(attributeValues.id, preset.id), isNull(attributeValues.deletedAt)))
            .run();
    }
    const match = productValueTextMatch(attributeId, source);
    await forEachAttributeProductChunk(db, match, (productIds) => [
        db.update(productAttributeValues)
            .set({ value: encoded.value, valueNumber: encoded.valueNumber })
            .where(and(match, sql`${productAttributeValues.productId} IN ${jsonIdSet(productIds)}`)),
        productRevisionBumpStatement(db, productIds),
        ...refresh(productIds),
    ]);
}

/**
 * Removes a value from every product that has it (the products lose that
 * attribute), then retires its preset/enum row. Bounded like the rename.
 */
export async function deleteAttributeValue(
    db: Database,
    attributeId: string,
    value: string,
    refresh: CatalogProjectionRefresh,
) {
    const attribute = await readLiveAttributeDefinition(db, attributeId);
    const source = requireExistingAttributeValue(value).trim();
    const preset = await findPresetRow(db, attributeId, source);
    const sourceUsed = await productValueTextUsed(db, attributeId, source);
    if (!preset && !sourceUsed) {
        throw new NotFoundError(`Attribute value "${value.trim()}" no longer exists`);
    }
    const textMatch = productValueTextMatch(attributeId, source);
    const match = attribute.valueType === "enum" && preset
        ? or(textMatch, eq(productAttributeValues.valueId, preset.id))!
        : textMatch;
    await forEachAttributeProductChunk(db, match, (productIds) => [
        productRevisionBumpStatement(db, productIds),
        db.delete(productAttributeValues)
            .where(and(match, sql`${productAttributeValues.productId} IN ${jsonIdSet(productIds)}`)),
        ...refresh(productIds),
    ]);
    if (preset) {
        try {
            await safeBatch(db, [
                buildBatchGuard(db, sql`NOT EXISTS (
                    SELECT 1 FROM ${productAttributeValues} WHERE ${productAttributeValues.valueId} = ${preset.id}
                )`, "ATTRIBUTE_VALUE_IN_USE"),
                db.update(attributeValues)
                    .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                    .where(and(eq(attributeValues.id, preset.id), isNull(attributeValues.deletedAt))),
            ] as never);
        } catch (error) {
            if (isBatchGuardError(error, "ATTRIBUTE_VALUE_IN_USE")) {
                throw new ConflictError("Products started using this value while it was being deleted. Try again.");
            }
            throw error;
        }
    }
}

