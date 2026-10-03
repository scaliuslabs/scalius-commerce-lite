// Custom fields (COMMERCE-HOOKS H4) for the dashboard, agents and plugins:
// revision-guarded definition writes, the values of one owner or many, and
// one guarded batch that sets and clears an owner's values.
//
// Namespace guard: a writer creates, edits and deletes definitions, and
// writes values, only in its own namespace (`custom` for the merchant, its
// plugin id for a plugin). Callers pass the writer; the admin API passes the
// merchant, the plugin bridge will pass `{ kind: "plugin", pluginId }`.
// Reordering is presentation and stays the merchant's across namespaces.

import {
    brands,
    categories,
    collections,
    customFieldDefinitions,
    customFieldValues,
    customers,
    media,
    orders,
    pages,
    productVariants,
    products,
} from "@scalius/database/schema";
import {
    buildBatchGuard,
    chunkForD1,
    chunkRowsForD1,
    type Database,
    isBatchGuardError,
    safeBatch,
} from "@scalius/database/client";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import {
    CUSTOM_FIELD_DEFINITIONS_PER_OWNER_MAX,
    CUSTOM_FIELD_ID_PREFIX,
    CUSTOM_FIELD_MERCHANT_NAMESPACE,
    canWriteCustomFieldNamespace,
    customFieldOwnerIsStorefront,
    customFieldReferenceIds,
    customFieldReferenceTarget,
    customFieldValidationsToWire,
    customFieldWireValue,
    customFieldWriterNamespace,
    isCustomFieldKey,
    isCustomFieldNamespace,
    normalizeCustomFieldKey,
    parseCustomFieldValidations,
    parseCustomFieldValue,
    readCustomFieldValidations,
    serializeCustomFieldValidations,
    type CustomFieldCodecContext,
    type CustomFieldOwnerType,
    type CustomFieldReferenceTarget,
    type CustomFieldType,
    type CustomFieldWireValidations,
    type CustomFieldWriter,
} from "@scalius/shared/custom-fields";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { readStoreCurrency } from "../settings";
import type {
    CreateCustomFieldDefinitionInput,
    ReorderCustomFieldDefinitionsInput,
    SetCustomFieldValuesInput,
    UpdateCustomFieldDefinitionInput,
} from "./custom-fields.validation";

type SQLiteBatchItem = BatchItem<"sqlite">;

export const CUSTOM_FIELD_REVISION_CONFLICT = "CUSTOM_FIELD_REVISION_CONFLICT";
export const CUSTOM_FIELD_KEY_TAKEN = "CUSTOM_FIELD_KEY_TAKEN";
export const CUSTOM_FIELD_NAMESPACE_FORBIDDEN = "CUSTOM_FIELD_NAMESPACE_FORBIDDEN";
const GUARD_FAILED = "CUSTOM_FIELD_GUARD_FAILED";

export class CustomFieldRevisionConflictError extends AppError {
    constructor(definitionId: string, expectedRevision: number, currentRevision: number | null) {
        super(
            409,
            CUSTOM_FIELD_REVISION_CONFLICT,
            "This custom field changed while you were editing. Reload it and try again.",
            { definitionId, expectedRevision, currentRevision },
        );
        this.name = "CustomFieldRevisionConflictError";
    }
}

export class CustomFieldNamespaceError extends AppError {
    constructor(namespace: string) {
        super(
            403,
            CUSTOM_FIELD_NAMESPACE_FORBIDDEN,
            namespace === CUSTOM_FIELD_MERCHANT_NAMESPACE
                ? "Custom fields in the `custom` namespace belong to the merchant."
                : `Custom fields in the \`${namespace}\` namespace belong to the plugin that owns it.`,
            { namespace },
        );
        this.name = "CustomFieldNamespaceError";
    }
}

// ─────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────

export interface CustomFieldDefinitionView {
    id: string;
    ownerType: CustomFieldOwnerType;
    namespace: string;
    key: string;
    name: string;
    description: string | null;
    type: CustomFieldType;
    validations: CustomFieldWireValidations;
    storefrontVisible: boolean;
    position: number;
    revision: number;
    createdAt: string;
    updatedAt: string;
}

export interface CustomFieldDefinitionListItem extends CustomFieldDefinitionView {
    /** Owners holding a value: what deleting the definition removes. */
    valueCount: number;
}

export interface CustomFieldEntry {
    definition: CustomFieldDefinitionView;
    /** The wire value (`CustomFieldWireValue`, opaque JSON at the HTTP edge), or null when the owner has none. */
    value: unknown;
    updatedAt: string | null;
}

export interface CustomFieldOwnerValues {
    ownerType: CustomFieldOwnerType;
    ownerId: string;
    fields: CustomFieldEntry[];
}

export interface CustomFieldWriteOptions {
    writer: CustomFieldWriter;
}

const iso = (seconds: number | null | undefined) =>
    seconds === null || seconds === undefined ? null : new Date(Number(seconds) * 1000).toISOString();

export async function readCustomFieldCodecContext(db: Database): Promise<CustomFieldCodecContext> {
    const currency = await readStoreCurrency(db);
    return { decimalPlaces: currency.decimalPlaces, currencyCode: currency.code, priceIncrementMinor: currency.priceIncrementMinor };
}

const definitionColumns = {
    id: customFieldDefinitions.id,
    ownerType: customFieldDefinitions.ownerType,
    namespace: customFieldDefinitions.namespace,
    key: customFieldDefinitions.key,
    name: customFieldDefinitions.name,
    description: customFieldDefinitions.description,
    type: customFieldDefinitions.type,
    validations: customFieldDefinitions.validations,
    storefrontVisible: customFieldDefinitions.storefrontVisible,
    position: customFieldDefinitions.position,
    revision: customFieldDefinitions.revision,
    createdAt: customFieldDefinitions.createdAt,
    updatedAt: customFieldDefinitions.updatedAt,
};

type DefinitionRow = {
    id: string;
    ownerType: CustomFieldOwnerType;
    namespace: string;
    key: string;
    name: string;
    description: string | null;
    type: CustomFieldType;
    validations: string;
    storefrontVisible: boolean | number;
    position: number;
    revision: number;
    createdAt: number;
    updatedAt: number;
};

function presentDefinition(row: DefinitionRow, context: CustomFieldCodecContext): CustomFieldDefinitionView {
    return {
        id: row.id,
        ownerType: row.ownerType,
        namespace: row.namespace,
        key: row.key,
        name: row.name,
        description: row.description,
        type: row.type,
        validations: customFieldValidationsToWire(row.type, readCustomFieldValidations(row.validations), context),
        storefrontVisible: Boolean(row.storefrontVisible),
        position: Number(row.position),
        revision: Number(row.revision),
        createdAt: iso(row.createdAt)!,
        updatedAt: iso(row.updatedAt)!,
    };
}

function assertNamespace(writer: CustomFieldWriter, namespace: string): void {
    if (!canWriteCustomFieldNamespace(writer, namespace)) throw new CustomFieldNamespaceError(namespace);
}

function isKeyTakenError(error: unknown): boolean {
    for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
        const message = current instanceof Error ? current.message : String(current);
        if (/custom_field_definitions_owner_key_unique|UNIQUE constraint failed: custom_field_definitions\.owner_type/i.test(message)) return true;
        current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
    }
    return false;
}

function codecIssueDetails(path: Array<string | number>, issue: { code: string; message: string; index?: number; limit?: string | number }) {
    return {
        path: issue.index === undefined ? path : [...path, issue.index],
        code: issue.code,
        message: issue.message,
        ...(issue.limit !== undefined ? { limit: issue.limit } : {}),
    };
}

// ─────────────────────────────────────────
// Definitions
// ─────────────────────────────────────────

export async function listCustomFieldDefinitions(
    db: Database,
    options: { ownerType?: CustomFieldOwnerType } = {},
): Promise<{ definitions: CustomFieldDefinitionListItem[] }> {
    const [context, rows] = await Promise.all([
        readCustomFieldCodecContext(db),
        db.select({
            ...definitionColumns,
            valueCount: sql<number>`(SELECT count(*) FROM ${customFieldValues} WHERE ${customFieldValues.definitionId} = ${customFieldDefinitions.id})`,
        })
            .from(customFieldDefinitions)
            .where(options.ownerType ? eq(customFieldDefinitions.ownerType, options.ownerType) : undefined)
            .orderBy(asc(customFieldDefinitions.ownerType), asc(customFieldDefinitions.position), asc(customFieldDefinitions.id))
            .all(),
    ]);
    return {
        definitions: rows.map(({ valueCount, ...row }) => ({
            ...presentDefinition(row as DefinitionRow, context),
            valueCount: Number(valueCount ?? 0),
        })),
    };
}

export async function getCustomFieldDefinition(db: Database, id: string): Promise<CustomFieldDefinitionView | null> {
    const [context, row] = await Promise.all([
        readCustomFieldCodecContext(db),
        db.select(definitionColumns).from(customFieldDefinitions).where(eq(customFieldDefinitions.id, id)).get(),
    ]);
    return row ? presentDefinition(row as DefinitionRow, context) : null;
}

function parseValidationsOrThrow(type: CustomFieldType, input: unknown, context: CustomFieldCodecContext): string {
    const parsed = parseCustomFieldValidations(type, input, context);
    if (!parsed.ok) {
        throw new ValidationError(parsed.issue.message, { issues: [codecIssueDetails(["validations"], parsed.issue)] });
    }
    return serializeCustomFieldValidations(parsed.value);
}

function assertStorefrontOwner(ownerType: CustomFieldOwnerType, visible: boolean | undefined): void {
    if (visible && !customFieldOwnerIsStorefront(ownerType)) {
        throw new ValidationError("Customer and order fields are never shown on the storefront.", {
            issues: [{ path: ["storefrontVisible"], code: "invalid", message: "Customer and order fields are never shown on the storefront." }],
        });
    }
}

/**
 * Creates a definition at the end of its owner type's order. The key is the
 * normalised name when omitted; namespace, key, owner type and type are fixed
 * from here on.
 */
export async function createCustomFieldDefinition(
    db: Database,
    input: CreateCustomFieldDefinitionInput,
    options: CustomFieldWriteOptions,
): Promise<CustomFieldDefinitionView> {
    const namespace = input.namespace ?? customFieldWriterNamespace(options.writer);
    if (!isCustomFieldNamespace(namespace)) {
        throw new ValidationError("The namespace is `custom` or a plugin id (vendor.name).", {
            issues: [{ path: ["namespace"], code: "invalid", message: "The namespace is `custom` or a plugin id (vendor.name)." }],
        });
    }
    assertNamespace(options.writer, namespace);
    const key = input.key ?? normalizeCustomFieldKey(input.name);
    if (!key || !isCustomFieldKey(key)) {
        const message = input.key === undefined
            ? "Enter a key: the name has no letters or digits to make one from."
            : "The key is lowercase letters, digits and single underscores, starting with a letter.";
        throw new ValidationError(message, { issues: [{ path: ["key"], code: "invalid", message }] });
    }
    assertStorefrontOwner(input.ownerType, input.storefrontVisible);
    const context = await readCustomFieldCodecContext(db);
    const validations = parseValidationsOrThrow(input.type, input.validations, context);
    const id = `${CUSTOM_FIELD_ID_PREFIX}${nanoid()}`;
    const ownerCount = sql`(SELECT count(*) FROM ${customFieldDefinitions} WHERE ${customFieldDefinitions.ownerType} = ${input.ownerType})`;
    try {
        await safeBatch(db, [
            buildBatchGuard(db, sql`${ownerCount} < ${CUSTOM_FIELD_DEFINITIONS_PER_OWNER_MAX}`, GUARD_FAILED),
            db.insert(customFieldDefinitions).values({
                id,
                ownerType: input.ownerType,
                namespace,
                key,
                name: input.name,
                description: input.description?.trim() || null,
                type: input.type,
                validations,
                storefrontVisible: input.storefrontVisible ?? false,
                position: sql`(SELECT coalesce(max(${customFieldDefinitions.position}), -1) + 1 FROM ${customFieldDefinitions} WHERE ${customFieldDefinitions.ownerType} = ${input.ownerType})`,
                revision: 1,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }),
        ] as never);
    } catch (error) {
        if (isKeyTakenError(error)) {
            throw new AppError(409, CUSTOM_FIELD_KEY_TAKEN, `A ${input.ownerType} field with the key ${namespace}.${key} already exists.`, {
                issues: [{ path: ["key"], code: "taken", message: "This key is already used by another field." }],
            });
        }
        if (isBatchGuardError(error, GUARD_FAILED)) {
            throw new ValidationError(`A ${input.ownerType} can have at most ${CUSTOM_FIELD_DEFINITIONS_PER_OWNER_MAX} custom fields.`);
        }
        throw error;
    }
    const created = await getCustomFieldDefinition(db, id);
    if (!created) throw new ConflictError("The custom field could not be created. Reload and try again.");
    return created;
}

async function currentRevision(db: Database, id: string): Promise<{ revision: number; namespace: string } | undefined> {
    return db.select({ revision: customFieldDefinitions.revision, namespace: customFieldDefinitions.namespace })
        .from(customFieldDefinitions).where(eq(customFieldDefinitions.id, id)).get();
}

/** Edits name, description, validations and storefront visibility under the definition's revision. */
export async function updateCustomFieldDefinition(
    db: Database,
    id: string,
    input: UpdateCustomFieldDefinitionInput,
    options: CustomFieldWriteOptions,
): Promise<CustomFieldDefinitionView> {
    const [context, existing] = await Promise.all([
        readCustomFieldCodecContext(db),
        db.select(definitionColumns).from(customFieldDefinitions).where(eq(customFieldDefinitions.id, id)).get(),
    ]);
    if (!existing) throw new NotFoundError("Custom field not found");
    assertNamespace(options.writer, existing.namespace);
    if (existing.revision !== input.expectedRevision) {
        throw new CustomFieldRevisionConflictError(id, input.expectedRevision, existing.revision);
    }
    assertStorefrontOwner(existing.ownerType as CustomFieldOwnerType, input.storefrontVisible);
    const validations = input.validations === undefined
        ? undefined
        : parseValidationsOrThrow(existing.type as CustomFieldType, input.validations, context);
    const updated = await db.update(customFieldDefinitions)
        .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
            ...(validations !== undefined ? { validations } : {}),
            ...(input.storefrontVisible !== undefined ? { storefrontVisible: input.storefrontVisible } : {}),
            revision: sql`${customFieldDefinitions.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.revision, input.expectedRevision)))
        .returning(definitionColumns)
        .get();
    if (!updated) {
        const current = await currentRevision(db, id);
        if (!current) throw new NotFoundError("Custom field not found");
        throw new CustomFieldRevisionConflictError(id, input.expectedRevision, current.revision);
    }
    return presentDefinition(updated as DefinitionRow, context);
}

/** Deletes a definition and every value of it, under its revision. */
export async function deleteCustomFieldDefinition(
    db: Database,
    id: string,
    input: { expectedRevision: number },
    options: CustomFieldWriteOptions,
): Promise<{ id: string; deletedValueCount: number }> {
    const existing = await currentRevision(db, id);
    if (!existing) throw new NotFoundError("Custom field not found");
    assertNamespace(options.writer, existing.namespace);
    const [counts, deleted] = await safeBatch(db, [
        db.select({ count: sql<number>`count(*)` }).from(customFieldValues).where(eq(customFieldValues.definitionId, id)),
        db.delete(customFieldDefinitions)
            .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.revision, input.expectedRevision)))
            .returning({ id: customFieldDefinitions.id }),
    ] as never) as unknown as [Array<{ count: number }>, Array<{ id: string }>];
    if (deleted.length !== 1) {
        const current = await currentRevision(db, id);
        if (!current) throw new NotFoundError("Custom field not found");
        throw new CustomFieldRevisionConflictError(id, input.expectedRevision, current.revision);
    }
    return { id, deletedValueCount: Number(counts[0]?.count ?? 0) };
}

/**
 * Sets the order of every definition of an owner type (all or none): each
 * claim names a definition at its expected revision, and together they are
 * the owner type's whole set.
 */
export async function reorderCustomFieldDefinitions(
    db: Database,
    input: ReorderCustomFieldDefinitionsInput,
): Promise<{ definitions: CustomFieldDefinitionListItem[] }> {
    const ids = input.definitions.map((claim) => claim.id);
    if (new Set(ids).size !== ids.length) throw new ValidationError("List every custom field once.");
    const claims = JSON.stringify(input.definitions.map((claim, position) => ({ ...claim, position })));
    const claimed = sql`(SELECT CAST(json_extract(value, '$.id') AS TEXT) FROM json_each(${claims}))`;
    const matching = sql`(
        SELECT count(*) FROM json_each(${claims}) AS claim
        INNER JOIN ${customFieldDefinitions}
            ON ${customFieldDefinitions.id} = CAST(json_extract(claim.value, '$.id') AS TEXT)
           AND ${customFieldDefinitions.revision} = CAST(json_extract(claim.value, '$.expectedRevision') AS INTEGER)
           AND ${customFieldDefinitions.ownerType} = ${input.ownerType}
    )`;
    const total = sql`(SELECT count(*) FROM ${customFieldDefinitions} WHERE ${customFieldDefinitions.ownerType} = ${input.ownerType})`;
    try {
        await safeBatch(db, [
            buildBatchGuard(db, sql`${matching} = ${ids.length} AND ${total} = ${ids.length}`, GUARD_FAILED),
            db.update(customFieldDefinitions)
                .set({
                    position: sql`(
                        SELECT CAST(json_extract(claim.value, '$.position') AS INTEGER) FROM json_each(${claims}) AS claim
                        WHERE CAST(json_extract(claim.value, '$.id') AS TEXT) = ${customFieldDefinitions.id}
                    )`,
                    revision: sql`${customFieldDefinitions.revision} + 1`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(eq(customFieldDefinitions.ownerType, input.ownerType), sql`${customFieldDefinitions.id} IN ${claimed}`)),
        ] as never);
    } catch (error) {
        if (!isBatchGuardError(error, GUARD_FAILED)) throw error;
        const rows = await db.select({ id: customFieldDefinitions.id, revision: customFieldDefinitions.revision })
            .from(customFieldDefinitions).where(eq(customFieldDefinitions.ownerType, input.ownerType)).all();
        const byId = new Map(rows.map((row) => [row.id, row.revision]));
        const stale = input.definitions.find((claim) => byId.get(claim.id) !== claim.expectedRevision);
        if (stale) throw new CustomFieldRevisionConflictError(stale.id, stale.expectedRevision, byId.get(stale.id) ?? null);
        throw new ConflictError("The list of custom fields changed. Reload and try again.");
    }
    return listCustomFieldDefinitions(db, { ownerType: input.ownerType });
}

// ─────────────────────────────────────────
// Owners and references
// ─────────────────────────────────────────

type OwnerTable = SQLiteTable & { id: SQLiteColumn; deletedAt: SQLiteColumn };

const OWNER_TABLES: Record<CustomFieldOwnerType, OwnerTable> = {
    product: products as unknown as OwnerTable,
    variant: productVariants as unknown as OwnerTable,
    customer: customers as unknown as OwnerTable,
    order: orders as unknown as OwnerTable,
    category: categories as unknown as OwnerTable,
    collection: collections as unknown as OwnerTable,
    brand: brands as unknown as OwnerTable,
    page: pages as unknown as OwnerTable,
};

/** A live (not trashed) owner row. */
function ownerExists(ownerType: CustomFieldOwnerType, ownerId: string): SQL {
    const table = OWNER_TABLES[ownerType];
    return sql`EXISTS (SELECT 1 FROM ${table} WHERE ${table.id} = ${ownerId} AND ${table.deletedAt} IS NULL)`;
}

/** Every id names a live record of the target. */
function referencesExist(target: CustomFieldReferenceTarget, ids: readonly string[]): SQL {
    const list = JSON.stringify(ids);
    const idSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${list}))`;
    switch (target) {
        case "product":
            return sql`(SELECT count(*) FROM ${products} WHERE ${products.id} IN ${idSet} AND ${products.deletedAt} IS NULL) = ${ids.length}`;
        case "variant":
            return sql`(SELECT count(*) FROM ${productVariants} WHERE ${productVariants.id} IN ${idSet} AND ${productVariants.deletedAt} IS NULL) = ${ids.length}`;
        case "collection":
            return sql`(SELECT count(*) FROM ${collections} WHERE ${collections.id} IN ${idSet} AND ${collections.deletedAt} IS NULL) = ${ids.length}`;
        case "media":
            return sql`(SELECT count(*) FROM ${media} WHERE ${media.id} IN ${idSet} AND ${media.status} = 'ready') = ${ids.length}`;
    }
}

async function missingReferences(db: Database, target: CustomFieldReferenceTarget, ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunkForD1(ids)) {
        const rows = target === "product"
            ? await db.select({ id: products.id }).from(products).where(and(inArray(products.id, chunk), sql`${products.deletedAt} IS NULL`)).all()
            : target === "variant"
                ? await db.select({ id: productVariants.id }).from(productVariants).where(and(inArray(productVariants.id, chunk), sql`${productVariants.deletedAt} IS NULL`)).all()
                : target === "collection"
                    ? await db.select({ id: collections.id }).from(collections).where(and(inArray(collections.id, chunk), sql`${collections.deletedAt} IS NULL`)).all()
                    : await db.select({ id: media.id }).from(media).where(and(inArray(media.id, chunk), eq(media.status, "ready"))).all();
        for (const row of rows) found.add(row.id);
    }
    return new Set(ids.filter((id) => !found.has(id)));
}

// ─────────────────────────────────────────
// Values
// ─────────────────────────────────────────

const valueEntryColumns = {
    ...definitionColumns,
    storedValue: customFieldValues.value,
    valueUpdatedAt: customFieldValues.updatedAt,
};

function ownerFieldsStatement(db: Database, ownerType: CustomFieldOwnerType, ownerId: string) {
    return db.select(valueEntryColumns)
        .from(customFieldDefinitions)
        .leftJoin(customFieldValues, and(
            eq(customFieldValues.definitionId, customFieldDefinitions.id),
            eq(customFieldValues.ownerId, ownerId),
        ))
        .where(eq(customFieldDefinitions.ownerType, ownerType))
        .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id));
}

type EntryRow = DefinitionRow & { storedValue: string | null; valueUpdatedAt: number | null };

function presentEntries(rows: readonly EntryRow[], context: CustomFieldCodecContext): CustomFieldEntry[] {
    return rows.map(({ storedValue, valueUpdatedAt, ...definition }) => ({
        definition: presentDefinition(definition, context),
        value: storedValue === null ? null : customFieldWireValue(definition.type, storedValue, context),
        updatedAt: storedValue === null ? null : iso(valueUpdatedAt),
    }));
}

/** The owner (live for writes; in trash too for reads) and every field of its type with its value. */
async function readOwnerState(db: Database, ownerType: CustomFieldOwnerType, ownerId: string, options: { live: boolean }) {
    const table = OWNER_TABLES[ownerType];
    const [context, [owners, rows]] = await Promise.all([
        readCustomFieldCodecContext(db),
        db.batch([
            db.select({ id: table.id }).from(table)
                .where(and(eq(table.id, ownerId), ...(options.live ? [sql`${table.deletedAt} IS NULL`] : [])))
                .limit(1),
            ownerFieldsStatement(db, ownerType, ownerId),
        ] as never) as unknown as Promise<[Array<{ id: string }>, EntryRow[]]>,
    ]);
    return { context, ownerFound: owners.length > 0, rows };
}

/** Every definition of the owner type with this owner's value (null when unset); an owner in trash reads too. */
export async function readCustomFieldValues(
    db: Database,
    ownerType: CustomFieldOwnerType,
    ownerId: string,
): Promise<CustomFieldOwnerValues> {
    const { context, ownerFound, rows } = await readOwnerState(db, ownerType, ownerId, { live: false });
    if (!ownerFound) throw new NotFoundError(`The ${ownerType} was not found.`);
    return { ownerType, ownerId, fields: presentEntries(rows, context) };
}

export interface CustomFieldStoredValue {
    definitionId: string;
    namespace: string;
    key: string;
    name: string;
    type: CustomFieldType;
    storefrontVisible: boolean;
    /** Canonical stored text (`customFieldWireValue` turns it into the wire form). */
    value: string;
}

/**
 * The values of many owners of one type, in definition order. Owners are read
 * 90 per statement, every statement in one round trip.
 */
export async function readCustomFieldValuesForOwners(
    db: Database,
    ownerType: CustomFieldOwnerType,
    ownerIds: readonly string[],
    options: { storefrontOnly?: boolean } = {},
): Promise<Map<string, CustomFieldStoredValue[]>> {
    const unique = [...new Set(ownerIds.filter(Boolean))];
    const result = new Map<string, CustomFieldStoredValue[]>();
    if (unique.length === 0) return result;
    const statements = chunkForD1(unique).map((chunk) => db.select({
            ownerId: customFieldValues.ownerId,
            definitionId: customFieldDefinitions.id,
            namespace: customFieldDefinitions.namespace,
            key: customFieldDefinitions.key,
            name: customFieldDefinitions.name,
            type: customFieldDefinitions.type,
            storefrontVisible: customFieldDefinitions.storefrontVisible,
            value: customFieldValues.value,
        })
            .from(customFieldValues)
            .innerJoin(customFieldDefinitions, eq(customFieldDefinitions.id, customFieldValues.definitionId))
            .where(and(
                eq(customFieldValues.ownerType, ownerType),
                inArray(customFieldValues.ownerId, chunk),
                ...(options.storefrontOnly ? [eq(customFieldDefinitions.storefrontVisible, true)] : []),
            ))
            .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id)));
    const results = await db.batch(statements as never) as unknown as Array<Array<CustomFieldStoredValue & { ownerId: string }>>;
    for (const rows of results) {
        for (const { ownerId, ...row } of rows) {
            const list = result.get(ownerId) ?? [];
            list.push({ ...row, storefrontVisible: Boolean(row.storefrontVisible) });
            result.set(ownerId, list);
        }
    }
    return result;
}

/**
 * Sets and clears an owner's values in one guarded batch: the owner is live,
 * every definition is still at the revision the values were validated
 * against, and every referenced record exists, or nothing is written. Values
 * equal to the stored ones are left untouched (no cache churn).
 */
export async function setCustomFieldValues(
    db: Database,
    ownerType: CustomFieldOwnerType,
    ownerId: string,
    input: SetCustomFieldValuesInput,
    options: CustomFieldWriteOptions,
): Promise<CustomFieldOwnerValues> {
    const ids = input.values.map((entry) => entry.definitionId);
    if (new Set(ids).size !== ids.length) throw new ValidationError("Set each custom field once per request.");
    const { context, ownerFound, rows } = await readOwnerState(db, ownerType, ownerId, { live: true });
    if (!ownerFound) throw new NotFoundError(`The ${ownerType} was not found.`);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const issues: ReturnType<typeof codecIssueDetails>[] = [];
    const upserts: Array<{ definitionId: string; value: string }> = [];
    const clears: string[] = [];
    const references = new Map<CustomFieldReferenceTarget, Map<string, number[]>>();
    input.values.forEach((entry, index) => {
        const definition = byId.get(entry.definitionId);
        if (!definition) {
            issues.push({ path: ["values", index, "definitionId"], code: "invalid", message: `This is not a ${ownerType} custom field.` });
            return;
        }
        assertNamespace(options.writer, definition.namespace);
        const parsed = parseCustomFieldValue(
            { type: definition.type, validations: readCustomFieldValidations(definition.validations) },
            entry.value,
            context,
        );
        if (!parsed.ok) {
            issues.push(codecIssueDetails(["values", index, "value"], parsed.issue));
            return;
        }
        if (parsed.value === null) {
            if (definition.storedValue !== null) clears.push(definition.id);
            return;
        }
        if (parsed.value === definition.storedValue) return;
        upserts.push({ definitionId: definition.id, value: parsed.value });
        const target = customFieldReferenceTarget(definition.type);
        if (target) {
            const byTarget = references.get(target) ?? new Map<string, number[]>();
            for (const referenceId of customFieldReferenceIds(definition.type, parsed.value)) {
                byTarget.set(referenceId, [...(byTarget.get(referenceId) ?? []), index]);
            }
            references.set(target, byTarget);
        }
    });
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, { issues });

    const now = Math.floor(Date.now() / 1000);
    if (upserts.length > 0 || clears.length > 0) {
        const touched = [...upserts.map((upsert) => upsert.definitionId), ...clears];
        const claims = JSON.stringify(touched.map((id) => ({ id, revision: byId.get(id)!.revision })));
        const definitionsCurrent = sql`(
            SELECT count(*) FROM json_each(${claims}) AS claim
            INNER JOIN ${customFieldDefinitions}
                ON ${customFieldDefinitions.id} = CAST(json_extract(claim.value, '$.id') AS TEXT)
               AND ${customFieldDefinitions.revision} = CAST(json_extract(claim.value, '$.revision') AS INTEGER)
        ) = ${touched.length}`;
        const statements: SQLiteBatchItem[] = [
            buildBatchGuard(db, sql`${ownerExists(ownerType, ownerId)} AND ${definitionsCurrent}`, GUARD_FAILED),
            ...[...references].map(([target, referenced]) =>
                buildBatchGuard(db, referencesExist(target, [...referenced.keys()]), GUARD_FAILED)),
            ...chunkRowsForD1(upserts, 5).map((chunk) => db.insert(customFieldValues)
                .values(chunk.map((upsert) => ({ definitionId: upsert.definitionId, ownerType, ownerId, value: upsert.value, updatedAt: now })))
                .onConflictDoUpdate({
                    target: [customFieldValues.definitionId, customFieldValues.ownerId],
                    set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
                    setWhere: sql`${customFieldValues.value} <> excluded.value`,
                })),
            ...chunkForD1(clears).map((chunk) => db.delete(customFieldValues)
                .where(and(eq(customFieldValues.ownerId, ownerId), inArray(customFieldValues.definitionId, chunk)))),
        ];
        try {
            await safeBatch(db, statements as never);
        } catch (error) {
            if (!isBatchGuardError(error, GUARD_FAILED)) throw error;
            await explainFailedWrite(db, ownerType, ownerId, byId, references, touched);
        }
    }

    const written = new Map<string, string | null>([
        ...upserts.map((upsert): [string, string | null] => [upsert.definitionId, upsert.value]),
        ...clears.map((id): [string, string | null] => [id, null]),
    ]);
    return {
        ownerType,
        ownerId,
        fields: presentEntries(rows.map((row) => written.has(row.id)
            ? { ...row, storedValue: written.get(row.id)!, valueUpdatedAt: now }
            : row), context),
    };
}

/** Why the guarded batch refused: a removed owner, changed definitions or a missing reference. */
async function explainFailedWrite(
    db: Database,
    ownerType: CustomFieldOwnerType,
    ownerId: string,
    read: Map<string, { revision: number }>,
    references: Map<CustomFieldReferenceTarget, Map<string, number[]>>,
    touched: readonly string[],
): Promise<never> {
    const { ownerFound, rows } = await readOwnerState(db, ownerType, ownerId, { live: true });
    if (!ownerFound) throw new NotFoundError(`The ${ownerType} was not found.`);
    const current = new Map(rows.map((row) => [row.id, row.revision]));
    if (touched.some((id) => current.get(id) !== read.get(id)?.revision)) {
        throw new AppError(409, CUSTOM_FIELD_REVISION_CONFLICT, "Custom field settings changed while you were editing. Reload and try again.");
    }
    const issues: Array<{ path: Array<string | number>; code: string; message: string }> = [];
    for (const [target, referenced] of references) {
        const missing = await missingReferences(db, target, [...referenced.keys()]);
        for (const id of missing) {
            for (const index of referenced.get(id) ?? []) {
                issues.push({ path: ["values", index, "value"], code: "missing_reference", message: `The ${target} ${id} does not exist or is in trash.` });
            }
        }
    }
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, { issues });
    throw new ConflictError("The custom fields could not be saved. Reload and try again.");
}
