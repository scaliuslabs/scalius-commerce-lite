import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    deliveryLocations,
    productVariants,
    products,
    taxClasses,
    taxRates,
    taxRegions,
    taxSettings,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { matchAdminArea } from "@scalius/shared/address";
import { addressRulesFor } from "@scalius/shared/address-metadata";
import { DELIVERY_HIERARCHY_COUNTRY, normalizeMarketCountry } from "@scalius/shared/markets";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { and, asc, eq, isNull, like, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { isCountryTaxRegion, normalizeTaxPostalPrefix } from "./region-match";
import { SYSTEM_TAX_PROVIDER_ID, type TaxPlaceType } from "./types";

const DEFAULT_SETTINGS = {
    id: "default" as const,
    enabled: false,
    taxShipping: false,
    defaultTaxClassId: null,
    shippingTaxClassId: null,
    displayLabel: "Tax",
    providerId: SYSTEM_TAX_PROVIDER_ID,
    version: 0,
    createdAt: null,
    updatedAt: null,
};

/** Longest postal prefix a tax region may hold (as shipping zones). */
export const MAX_TAX_POSTAL_PREFIX_LENGTH = 10;

const TAX_CONFIGURATION_READINESS_CONFLICT = "TAX_CONFIGURATION_READINESS_CONFLICT";
const TAX_CONFIGURATION_READINESS_MESSAGE =
    "Tax is enabled. Keep an active rate on each taxable default or shipping class, or mark the class exempt, before saving this change.";

export interface UpdateTaxSettingsInput {
    expectedVersion: number;
    enabled: boolean;
    taxShipping: boolean;
    defaultTaxClassId: string | null;
    shippingTaxClassId: string | null;
    displayLabel: string;
    /** `system` or an app's `<plugin id>:<provider id>`; absent keeps the saved one. */
    providerId?: string;
}

export interface CreateTaxClassInput {
    name: string;
    description?: string | null;
    isExempt?: boolean;
}

export interface UpdateTaxClassInput extends CreateTaxClassInput {
    expectedVersion: number;
}

export interface CreateTaxRateInput {
    taxClassId: string;
    taxRegionId: string;
    name: string;
    rateBps: number;
    priority?: number;
    isCompound?: boolean;
    /** Applies with the broader regions' rates of its class (default: replaces them). */
    combinable?: boolean;
    isActive?: boolean;
}

export interface CreateTaxRegionInput {
    countryCode: string;
    /** An admin area of the country's address rules (not Bangladesh). */
    adminArea?: string | null;
    /** Postal codes that start with it (not Bangladesh). */
    postalPrefix?: string | null;
    /** A Bangladesh delivery location (City, Thana or Area). */
    placeId?: string | null;
    /** A country region's provider; null or absent: the store-wide one. */
    providerId?: string | null;
}

export interface UpdateTaxRegionInput {
    expectedVersion: number;
    providerId: string | null;
}

export interface UpdateTaxRateInput extends Partial<CreateTaxRateInput> {
    expectedVersion: number;
}

function normalizeName(value: string, label: string, maxLength = 120): string {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized) throw new ValidationError(`${label} is required.`);
    if (normalized.length > maxLength) throw new ValidationError(`${label} is too long.`);
    return normalized;
}

function normalizeDescription(value: string | null | undefined): string | null {
    const normalized = value?.trim() || null;
    if (normalized && normalized.length > 500) throw new ValidationError("Description is too long.");
    return normalized;
}

/** An error's message with its causes' (a driver error wraps the constraint's words). */
function errorMessages(error: unknown): string {
    const messages: string[] = [];
    for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
        messages.push(current instanceof Error ? current.message : String(current));
        current = current instanceof Error ? current.cause : null;
    }
    return messages.join(" | ");
}

function isTaxClassNameConstraint(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /tax_classes_active_name_ci_unique|unique constraint.*tax_classes/i.test(message);
}

/** A provider id as tax settings and regions store it: `system` or an app's qualified id. */
export function normalizeTaxProviderId(value: string | null | undefined, label = "Tax provider"): string {
    const id = value?.trim() ?? "";
    if (id === SYSTEM_TAX_PROVIDER_ID || isQualifiedProviderId(id)) return id;
    throw new ValidationError(`${label} is not a known tax provider.`);
}

type ActiveTaxClass = Pick<typeof taxClasses.$inferSelect, "id" | "name" | "isExempt">;

/** The active tax class `id` names (null for none); throws when it is missing or deleted. */
export async function assertActiveTaxClass(
    db: Database,
    id: string | null,
    label: string,
): Promise<ActiveTaxClass | null> {
    if (!id) return null;
    const row = await db.select({
        id: taxClasses.id,
        name: taxClasses.name,
        isExempt: taxClasses.isExempt,
    })
        .from(taxClasses)
        .where(and(eq(taxClasses.id, id), isNull(taxClasses.deletedAt)))
        .get();
    if (!row) throw new ValidationError(`${label} is not an active tax class.`);
    return row;
}

async function assertClassCanCalculateTax(
    db: Database,
    taxClass: ActiveTaxClass,
    role: "product" | "shipping",
): Promise<void> {
    if (taxClass.isExempt) return;
    const activeRate = await db.select({ id: taxRates.id })
        .from(taxRates)
        .where(and(
            eq(taxRates.taxClassId, taxClass.id),
            eq(taxRates.isActive, true),
        ))
        .get();
    if (!activeRate) {
        const scope = role === "shipping" ? "shipping class" : "default product class";
        throw new ValidationError(
            `Add an active rate to ${scope} “${taxClass.name}” before enabling tax.`,
        );
    }
}

function buildTaxConfigurationReadinessGuard(db: Database) {
    // This expression is projected as a SELECT field by buildBatchGuard().
    // Drizzle intentionally renders schema columns in a projection without
    // their table prefix, which is unsafe for these nested correlated
    // subqueries (`tax_rates.id` would otherwise shadow `tax_classes.id`).
    // These are static schema identifiers, never user-controlled SQL.
    const settings = {
        id: sql.raw('"tax_settings"."id"'),
        enabled: sql.raw('"tax_settings"."enabled"'),
        providerId: sql.raw('"tax_settings"."provider_id"'),
        taxShipping: sql.raw('"tax_settings"."tax_shipping"'),
        defaultTaxClassId: sql.raw('"tax_settings"."default_tax_class_id"'),
        shippingTaxClassId: sql.raw('"tax_settings"."shipping_tax_class_id"'),
    };
    const taxClass = {
        id: sql.raw('"tax_classes"."id"'),
        isExempt: sql.raw('"tax_classes"."is_exempt"'),
        deletedAt: sql.raw('"tax_classes"."deleted_at"'),
    };
    const rate = {
        taxClassId: sql.raw('"tax_rates"."tax_class_id"'),
        isActive: sql.raw('"tax_rates"."is_active"'),
    };
    return buildBatchGuard(db, sql`
            NOT EXISTS (
                SELECT 1 FROM ${taxSettings}
                WHERE ${settings.id} = 'default'
                  AND ${settings.enabled} = 1
                  AND ${settings.providerId} = 'system'
            ) OR EXISTS (
                SELECT 1 FROM ${taxSettings}
                WHERE ${settings.id} = 'default'
                  AND ${settings.enabled} = 1
                  AND EXISTS (
                      SELECT 1 FROM ${taxClasses}
                      WHERE ${taxClass.id} = ${settings.defaultTaxClassId}
                        AND ${taxClass.deletedAt} IS NULL
                        AND (
                            ${taxClass.isExempt} = 1
                            OR EXISTS (
                                SELECT 1 FROM ${taxRates}
                                WHERE ${rate.taxClassId} = ${taxClass.id}
                                  AND ${rate.isActive} = 1
                            )
                        )
                  )
                  AND (
                      ${settings.taxShipping} = 0
                      OR EXISTS (
                          SELECT 1 FROM ${taxClasses}
                          WHERE ${taxClass.id} = COALESCE(
                              ${settings.shippingTaxClassId},
                              ${settings.defaultTaxClassId}
                          )
                            AND ${taxClass.deletedAt} IS NULL
                            AND (
                                ${taxClass.isExempt} = 1
                                OR EXISTS (
                                    SELECT 1 FROM ${taxRates}
                                    WHERE ${rate.taxClassId} = ${taxClass.id}
                                      AND ${rate.isActive} = 1
                                )
                            )
                      )
                  )
            )
    `, TAX_CONFIGURATION_READINESS_CONFLICT);
}

function isTaxConfigurationReadinessConflict(error: unknown): boolean {
    return isBatchGuardError(error, TAX_CONFIGURATION_READINESS_CONFLICT);
}

async function executeTaxConfigurationGuardedMutation<TMutation extends BatchItem<"sqlite">>(
    db: Database,
    mutation: TMutation,
): Promise<TMutation["_"]["result"]> {
    try {
        const [result] = await safeBatch(db, [
            mutation,
            buildTaxConfigurationReadinessGuard(db),
        ] as const);
        return result;
    } catch (error) {
        if (isTaxConfigurationReadinessConflict(error)) {
            throw new ConflictError(TAX_CONFIGURATION_READINESS_MESSAGE);
        }
        throw error;
    }
}

export async function getTaxConfiguration(db: Database) {
    const [settings, classes, regions, rates, jurisdictions] = await db.batch([
        db.select().from(taxSettings).where(eq(taxSettings.id, "default")),
        db.select().from(taxClasses).where(isNull(taxClasses.deletedAt)).orderBy(asc(taxClasses.name)),
        selectTaxRegions(db),
        db.select().from(taxRates).orderBy(
            asc(taxRates.taxClassId),
            asc(taxRates.priority),
            asc(taxRates.id),
        ),
        db.select({
            id: deliveryLocations.id,
            name: deliveryLocations.name,
            type: deliveryLocations.type,
            parentId: deliveryLocations.parentId,
        }).from(deliveryLocations).where(and(
            eq(deliveryLocations.isActive, true),
            isNull(deliveryLocations.deletedAt),
        )).orderBy(asc(deliveryLocations.type), asc(deliveryLocations.sortOrder), asc(deliveryLocations.name)),
    ]);
    return {
        settings: settings[0] ?? DEFAULT_SETTINGS,
        classes,
        regions: sortTaxRegions(regions.map(toTaxRegionRecord)),
        rates,
        jurisdictions,
    };
}

export async function getTaxSettingsDocument(db: Database) {
    const row = await db.select().from(taxSettings)
        .where(eq(taxSettings.id, "default"))
        .get();
    return row ?? DEFAULT_SETTINGS;
}

export async function listTaxClasses(db: Database, input: {
    page: number;
    limit: number;
    search?: string;
}) {
    const search = input.search?.trim();
    const where = and(
        isNull(taxClasses.deletedAt),
        search ? or(
            like(taxClasses.name, `%${search}%`),
            like(taxClasses.description, `%${search}%`),
        ) : undefined,
    );
    const [items, totalRow] = await Promise.all([
        db.select().from(taxClasses).where(where)
            .orderBy(asc(taxClasses.name), asc(taxClasses.id))
            .limit(input.limit)
            .offset((input.page - 1) * input.limit),
        db.select({ count: sql<number>`count(*)` }).from(taxClasses).where(where).get(),
    ]);
    return { items, total: totalRow?.count ?? 0 };
}

export async function listTaxRates(db: Database, input: {
    page: number;
    limit: number;
    search?: string;
    taxClassId?: string;
    taxRegionId?: string;
}) {
    const search = input.search?.trim();
    const where = and(
        input.taxClassId ? eq(taxRates.taxClassId, input.taxClassId) : undefined,
        input.taxRegionId ? eq(taxRates.taxRegionId, input.taxRegionId) : undefined,
        search ? like(taxRates.name, `%${search}%`) : undefined,
    );
    const [items, totalRow] = await Promise.all([
        db.select().from(taxRates).where(where).orderBy(
            asc(taxRates.taxClassId),
            asc(taxRates.priority),
            asc(taxRates.id),
        ).limit(input.limit).offset((input.page - 1) * input.limit),
        db.select({ count: sql<number>`count(*)` }).from(taxRates).where(where).get(),
    ]);
    return { items, total: totalRow?.count ?? 0 };
}

export async function listTaxJurisdictions(db: Database, input: {
    page: number;
    limit: number;
    search?: string;
    type?: "city" | "zone" | "area";
    parentId?: string;
}) {
    const search = input.search?.trim();
    const where = and(
        eq(deliveryLocations.isActive, true),
        isNull(deliveryLocations.deletedAt),
        input.type ? eq(deliveryLocations.type, input.type) : undefined,
        input.parentId ? eq(deliveryLocations.parentId, input.parentId) : undefined,
        search ? like(deliveryLocations.name, `%${search}%`) : undefined,
    );
    const projection = {
        id: deliveryLocations.id,
        name: deliveryLocations.name,
        type: deliveryLocations.type,
        parentId: deliveryLocations.parentId,
    };
    const [items, totalRow] = await Promise.all([
        db.select(projection).from(deliveryLocations).where(where).orderBy(
            asc(deliveryLocations.type),
            asc(deliveryLocations.sortOrder),
            asc(deliveryLocations.name),
            asc(deliveryLocations.id),
        ).limit(input.limit).offset((input.page - 1) * input.limit),
        db.select({ count: sql<number>`count(*)` }).from(deliveryLocations).where(where).get(),
    ]);
    return { items, total: totalRow?.count ?? 0 };
}

export async function updateTaxSettings(db: Database, input: UpdateTaxSettingsInput) {
    const displayLabel = normalizeName(input.displayLabel, "Tax label", 80);
    // Absent: the saved provider stays (the readiness guard reads it).
    const providerId = input.providerId === undefined ? undefined : normalizeTaxProviderId(input.providerId);
    const [defaultTaxClass, shippingTaxClass] = await Promise.all([
        assertActiveTaxClass(db, input.defaultTaxClassId, "Default tax class"),
        assertActiveTaxClass(db, input.shippingTaxClassId, "Shipping tax class"),
    ]);
    if (input.enabled && !input.defaultTaxClassId) {
        throw new ValidationError("Choose a default tax class before enabling tax.");
    }
    if (input.taxShipping && !input.shippingTaxClassId && !input.defaultTaxClassId) {
        throw new ValidationError("Choose a shipping or default tax class before taxing shipping.");
    }
    // An app provider calculates without local rates; the system provider needs them.
    // (An omitted provider keeps the saved one: the readiness guard below checks it.)
    if (input.enabled && defaultTaxClass && providerId === SYSTEM_TAX_PROVIDER_ID) {
        await assertClassCanCalculateTax(db, defaultTaxClass, "product");
        const effectiveShippingClass = input.taxShipping
            ? shippingTaxClass ?? defaultTaxClass
            : null;
        if (effectiveShippingClass && effectiveShippingClass.id !== defaultTaxClass.id) {
            await assertClassCanCalculateTax(db, effectiveShippingClass, "shipping");
        }
    }

    if (input.expectedVersion === 0) {
        const insert = db.insert(taxSettings).values({
            id: "default",
            enabled: input.enabled,
            taxShipping: input.taxShipping,
            defaultTaxClassId: input.defaultTaxClassId,
            shippingTaxClassId: input.shippingTaxClassId,
            displayLabel,
            providerId: providerId ?? SYSTEM_TAX_PROVIDER_ID,
            version: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).onConflictDoNothing().returning();
        const inserted = input.enabled
            ? await executeTaxConfigurationGuardedMutation(db, insert)
            : await insert;
        if (inserted[0]) return inserted[0];
        throw new ConflictError("Tax settings were created by another request. Reload and try again.");
    }

    const update = db.update(taxSettings).set({
        enabled: input.enabled,
        taxShipping: input.taxShipping,
        defaultTaxClassId: input.defaultTaxClassId,
        shippingTaxClassId: input.shippingTaxClassId,
        displayLabel,
        ...(providerId === undefined ? {} : { providerId }),
        version: sql`${taxSettings.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(taxSettings.id, "default"),
        eq(taxSettings.version, input.expectedVersion),
    )).returning();
    const updated = input.enabled
        ? await executeTaxConfigurationGuardedMutation(db, update)
        : await update;
    if (!updated[0]) throw new ConflictError("Tax settings changed. Reload and try again.");
    return updated[0];
}

export async function createTaxClass(db: Database, input: CreateTaxClassInput) {
    const name = normalizeName(input.name, "Tax class name");
    const existing = await db.select({ id: taxClasses.id }).from(taxClasses)
        .where(and(
            sql`lower(${taxClasses.name}) = lower(${name})`,
            isNull(taxClasses.deletedAt),
        )).get();
    if (existing) throw new ConflictError("A tax class with this name already exists.");
    try {
        const rows = await db.insert(taxClasses).values({
            id: `taxc_${nanoid()}`,
            name,
            description: normalizeDescription(input.description),
            isExempt: input.isExempt ?? false,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).returning();
        return rows[0]!;
    } catch (error) {
        if (isTaxClassNameConstraint(error)) {
            throw new ConflictError("A tax class with this name already exists.");
        }
        throw error;
    }
}

export async function updateTaxClass(db: Database, id: string, input: UpdateTaxClassInput) {
    const current = await db.select().from(taxClasses).where(and(
        eq(taxClasses.id, id),
        isNull(taxClasses.deletedAt),
    )).get();
    if (!current) throw new NotFoundError("Tax class not found.");
    if (current.version !== input.expectedVersion) {
        throw new ConflictError("Tax class changed. Reload and try again.");
    }
    const name = normalizeName(input.name, "Tax class name");
    const conflict = await db.select({ id: taxClasses.id }).from(taxClasses)
        .where(and(
            sql`lower(${taxClasses.name}) = lower(${name})`,
            sql`${taxClasses.id} <> ${id}`,
            isNull(taxClasses.deletedAt),
        )).get();
    if (conflict) throw new ConflictError("A tax class with this name already exists.");
    const makesExemptClassTaxable = current.isExempt && input.isExempt === false;
    let rows: typeof current[];
    try {
        const update = db.update(taxClasses).set({
            name,
            description: input.description === undefined
                ? current.description
                : normalizeDescription(input.description),
            isExempt: input.isExempt ?? current.isExempt,
            version: sql`${taxClasses.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(taxClasses.id, id),
            isNull(taxClasses.deletedAt),
            eq(taxClasses.version, input.expectedVersion),
        )).returning();
        rows = makesExemptClassTaxable
            ? await executeTaxConfigurationGuardedMutation(db, update)
            : await update;
    } catch (error) {
        if (isTaxClassNameConstraint(error)) {
            throw new ConflictError("A tax class with this name already exists.");
        }
        throw error;
    }
    if (rows[0]) return rows[0];
    throw new ConflictError("Tax class changed. Reload and try again.");
}

export async function deleteTaxClass(db: Database, id: string, expectedVersion: number) {
    const rows = await db.update(taxClasses).set({
        deletedAt: sql`unixepoch()`,
        version: sql`${taxClasses.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(taxClasses.id, id),
        isNull(taxClasses.deletedAt),
        eq(taxClasses.version, expectedVersion),
        sql`NOT EXISTS (SELECT 1 FROM ${taxRates} WHERE ${taxRates.taxClassId} = ${id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${products} WHERE ${products.taxClassId} = ${id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.taxClassId} = ${id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${taxSettings} WHERE ${taxSettings.defaultTaxClassId} = ${id} OR ${taxSettings.shippingTaxClassId} = ${id})`,
    )).returning();
    if (rows[0]) return rows[0];
    const existing = await db.select().from(taxClasses).where(eq(taxClasses.id, id)).get();
    if (!existing) throw new NotFoundError("Tax class not found.");
    if (existing.deletedAt) return existing;
    if (existing.version !== expectedVersion) throw new ConflictError("Tax class changed. Reload and try again.");
    throw new ConflictError("Remove this class from settings, products, SKUs, and active rates before deleting it.");
}

async function requireTaxRegion(db: Database, id: string) {
    const region = await db.select({ id: taxRegions.id }).from(taxRegions).where(eq(taxRegions.id, id)).get();
    if (!region) throw new ValidationError("Choose a tax region.");
    return region;
}

export async function createTaxRate(db: Database, input: CreateTaxRateInput) {
    await assertActiveTaxClass(db, input.taxClassId, "Tax class");
    await requireTaxRegion(db, input.taxRegionId);
    const rows = await db.insert(taxRates).values({
        id: `taxr_${nanoid()}`,
        taxClassId: input.taxClassId,
        taxRegionId: input.taxRegionId,
        name: normalizeName(input.name, "Rate name"),
        rateBps: input.rateBps,
        priority: input.priority ?? 0,
        isCompound: input.isCompound ?? false,
        combinable: input.combinable ?? false,
        isActive: input.isActive ?? true,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }).returning();
    return rows[0]!;
}

export async function updateTaxRate(db: Database, id: string, input: UpdateTaxRateInput) {
    const current = await db.select().from(taxRates).where(eq(taxRates.id, id)).get();
    if (!current) throw new NotFoundError("Tax rate not found.");
    if (current.version !== input.expectedVersion) throw new ConflictError("Tax rate changed. Reload and try again.");
    const taxClassId = input.taxClassId ?? current.taxClassId;
    await assertActiveTaxClass(db, taxClassId, "Tax class");
    const taxRegionId = input.taxRegionId ?? current.taxRegionId;
    if (taxRegionId !== current.taxRegionId) await requireTaxRegion(db, taxRegionId);
    const nextIsActive = input.isActive ?? current.isActive;
    const removesActiveCoverage = current.isActive && (
        !nextIsActive || taxClassId !== current.taxClassId
    );
    const update = db.update(taxRates).set({
        taxClassId,
        taxRegionId,
        name: input.name === undefined ? current.name : normalizeName(input.name, "Rate name"),
        rateBps: input.rateBps ?? current.rateBps,
        priority: input.priority ?? current.priority,
        isCompound: input.isCompound ?? current.isCompound,
        combinable: input.combinable ?? current.combinable,
        isActive: nextIsActive,
        version: sql`${taxRates.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(taxRates.id, id), eq(taxRates.version, input.expectedVersion))).returning();
    const rows = removesActiveCoverage
        ? await executeTaxConfigurationGuardedMutation(db, update)
        : await update;
    if (!rows[0]) throw new ConflictError("Tax rate changed. Reload and try again.");
    return rows[0];
}

/** Removes a rate (orders keep their own copy of it). */
export async function deleteTaxRate(db: Database, id: string, expectedVersion: number) {
    const current = await db.select().from(taxRates).where(eq(taxRates.id, id)).get();
    if (!current) throw new NotFoundError("Tax rate not found.");
    if (current.version !== expectedVersion) {
        throw new ConflictError("Tax rate changed. Reload and try again.");
    }
    const remove = db.delete(taxRates)
        .where(and(eq(taxRates.id, id), eq(taxRates.version, expectedVersion)))
        .returning();
    const rows = current.isActive
        ? await executeTaxConfigurationGuardedMutation(db, remove)
        : await remove;
    if (rows[0]) return rows[0];
    throw new ConflictError("Tax rate changed. Reload and try again.");
}

// ── Regions ─────────────────────────────────────────────────────────────

/** Every region with its rate count and, for a Bangladesh place, the place's name. */
function selectTaxRegions(db: Database) {
    return db.select({
        id: taxRegions.id,
        countryCode: taxRegions.countryCode,
        adminArea: taxRegions.adminArea,
        postalPrefix: taxRegions.postalPrefix,
        placeType: taxRegions.placeType,
        placeId: taxRegions.placeId,
        placeName: deliveryLocations.name,
        providerId: taxRegions.providerId,
        version: taxRegions.version,
        rateCount: sql<number>`(SELECT count(*) FROM ${taxRates} WHERE ${taxRates.taxRegionId} = ${taxRegions.id})`,
        createdAt: taxRegions.createdAt,
        updatedAt: taxRegions.updatedAt,
    })
        .from(taxRegions)
        .leftJoin(deliveryLocations, eq(deliveryLocations.id, taxRegions.placeId))
        .orderBy(asc(taxRegions.countryCode), asc(taxRegions.id));
}

const KIND_ORDER = { country: 0, admin_area: 1, postal_prefix: 2, place: 3 } as const;
const PLACE_ORDER = { city: 0, zone: 1, area: 2 } as const;

/** Each country, then its admin areas, postal prefixes and places (cities, thanas, areas), by name. */
function sortTaxRegions(regions: TaxRegionRecord[]): TaxRegionRecord[] {
    const label = (region: TaxRegionRecord) => region.adminArea ?? region.postalPrefix ?? region.placeName ?? region.placeId ?? "";
    return regions.sort((left, right) =>
        left.countryCode.localeCompare(right.countryCode)
        || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
        || (left.placeType && right.placeType ? PLACE_ORDER[left.placeType] - PLACE_ORDER[right.placeType] : 0)
        || label(left).localeCompare(label(right))
        || left.id.localeCompare(right.id));
}

type TaxRegionRow = Awaited<ReturnType<typeof selectTaxRegions>>[number];

/** A region as the dashboard and agents read it. */
export interface TaxRegionRecord {
    id: string;
    countryCode: string;
    /** `country`: the registration; the others are its sub-regions. */
    kind: "country" | "admin_area" | "postal_prefix" | "place";
    adminArea: string | null;
    postalPrefix: string | null;
    placeType: TaxPlaceType | null;
    placeId: string | null;
    placeName: string | null;
    /** A country's provider; null: the store-wide one. */
    providerId: string | null;
    rateCount: number;
    version: number;
    createdAt: unknown;
    updatedAt: unknown;
}

function toTaxRegionRecord(row: TaxRegionRow): TaxRegionRecord {
    const kind = row.placeId ? "place" : row.postalPrefix ? "postal_prefix" : row.adminArea ? "admin_area" : "country";
    return {
        id: row.id,
        countryCode: row.countryCode,
        kind,
        adminArea: row.adminArea || null,
        postalPrefix: row.postalPrefix || null,
        placeType: row.placeType ?? null,
        placeId: row.placeId ?? null,
        placeName: row.placeName ?? null,
        providerId: row.providerId ?? null,
        rateCount: Number(row.rateCount ?? 0),
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** Every region, countries first within their country; `countryCode` keeps one country's. */
export async function listTaxRegions(db: Database, input: { countryCode?: string } = {}): Promise<TaxRegionRecord[]> {
    const country = input.countryCode ? normalizeMarketCountry(input.countryCode) : null;
    const rows = await selectTaxRegions(db);
    return sortTaxRegions(rows.map(toTaxRegionRecord)).filter((region) => !country || region.countryCode === country);
}

/** A region with its rates and, for a country, its sub-regions and theirs. */
export async function getTaxRegion(db: Database, id: string) {
    const [regionRows, rates] = await db.batch([
        selectTaxRegions(db),
        db.select().from(taxRates).orderBy(asc(taxRates.priority), asc(taxRates.id)),
    ]);
    const regions = sortTaxRegions(regionRows.map(toTaxRegionRecord));
    const region = regions.find((candidate) => candidate.id === id);
    if (!region) throw new NotFoundError("Tax region not found.");
    const subRegions = region.kind === "country"
        ? regions.filter((candidate) => candidate.countryCode === region.countryCode && candidate.kind !== "country")
        : [];
    const ids = new Set([region.id, ...subRegions.map((candidate) => candidate.id)]);
    return { region, subRegions, rates: rates.filter((rate) => ids.has(rate.taxRegionId)) };
}

async function readTaxRegion(db: Database, id: string): Promise<TaxRegionRecord> {
    const region = (await listTaxRegions(db)).find((candidate) => candidate.id === id);
    if (!region) throw new NotFoundError("Tax region not found.");
    return region;
}

/**
 * Adds a region. A country region is the registration; a sub-region needs
 * it. Bangladesh's sub-regions are its delivery locations; another
 * country's are an admin area of its address rules or a postal prefix.
 */
export async function createTaxRegion(db: Database, input: CreateTaxRegionInput): Promise<TaxRegionRecord> {
    const countryCode = normalizeMarketCountry(input.countryCode);
    const rules = countryCode ? addressRulesFor(countryCode) : null;
    if (!countryCode || !rules) throw new ValidationError("Choose a country from the list.");
    const adminAreaText = input.adminArea?.trim() || "";
    const postalText = input.postalPrefix?.trim() || "";
    const placeId = input.placeId?.trim() || "";
    if ([adminAreaText, postalText, placeId].filter(Boolean).length > 1) {
        throw new ValidationError("Choose one region, postal code prefix or place.");
    }
    if (countryCode === DELIVERY_HIERARCHY_COUNTRY && (adminAreaText || postalText)) {
        throw new ValidationError("Choose Bangladesh cities, thanas or areas.");
    }
    if (countryCode !== DELIVERY_HIERARCHY_COUNTRY && placeId) {
        throw new ValidationError("Only Bangladesh regions are cities, thanas or areas.");
    }
    let adminArea = "";
    if (adminAreaText) {
        const match = matchAdminArea(rules, adminAreaText);
        if (!match) throw new ValidationError("Choose a region from the list.");
        adminArea = match.code;
    }
    const postalPrefix = normalizeTaxPostalPrefix(postalText);
    if (postalText && (!postalPrefix || postalPrefix.length > MAX_TAX_POSTAL_PREFIX_LENGTH)) {
        throw new ValidationError(`Enter 1 to ${MAX_TAX_POSTAL_PREFIX_LENGTH} letters or digits.`);
    }
    let placeType: TaxPlaceType | null = null;
    if (placeId) {
        const place = await db.select({ type: deliveryLocations.type }).from(deliveryLocations).where(and(
            eq(deliveryLocations.id, placeId),
            eq(deliveryLocations.isActive, true),
            isNull(deliveryLocations.deletedAt),
        )).get();
        if (!place) throw new ValidationError("Choose an active city, thana or area from the delivery locations.");
        placeType = place.type as TaxPlaceType;
    }
    const isCountry = !adminArea && !postalPrefix && !placeId;
    const providerId = input.providerId == null ? null : normalizeTaxProviderId(input.providerId);
    if (providerId !== null && !isCountry) {
        throw new ValidationError("Only a country chooses its tax provider; its regions use it.");
    }
    if (!isCountry) {
        const country = await db.select({ id: taxRegions.id }).from(taxRegions).where(and(
            eq(taxRegions.countryCode, countryCode),
            eq(taxRegions.adminArea, ""),
            eq(taxRegions.postalPrefix, ""),
            isNull(taxRegions.placeId),
        )).get();
        if (!country) throw new ValidationError("Add the country before its regions.");
    }
    const id = `txreg_${nanoid()}`;
    try {
        await db.insert(taxRegions).values({
            id,
            countryCode,
            adminArea,
            postalPrefix,
            placeType,
            placeId: placeId || null,
            providerId,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });
    } catch (error) {
        const message = errorMessages(error);
        if (/tax_regions_scope_unique|UNIQUE|duplicate key/i.test(message)) {
            throw new ConflictError("Tax is already set up for this region.");
        }
        if (/TAX_REGION_COUNTRY_REQUIRED/.test(message)) throw new ValidationError("Add the country before its regions.");
        throw error;
    }
    return readTaxRegion(db, id);
}

/** A country's tax provider (null: the store-wide one). */
export async function updateTaxRegion(db: Database, id: string, input: UpdateTaxRegionInput): Promise<TaxRegionRecord> {
    const current = await db.select().from(taxRegions).where(eq(taxRegions.id, id)).get();
    if (!current) throw new NotFoundError("Tax region not found.");
    const providerId = input.providerId === null ? null : normalizeTaxProviderId(input.providerId);
    if (providerId !== null && !isCountryTaxRegion({ adminArea: current.adminArea, postalPrefix: current.postalPrefix, placeId: current.placeId })) {
        throw new ValidationError("Only a country chooses its tax provider; its regions use it.");
    }
    const rows = await db.update(taxRegions).set({
        providerId,
        version: sql`${taxRegions.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(taxRegions.id, id), eq(taxRegions.version, input.expectedVersion))).returning({ id: taxRegions.id });
    if (!rows[0]) throw new ConflictError("Tax region changed. Reload and try again.");
    return readTaxRegion(db, id);
}

/**
 * Stops collecting tax in a region: its rates go with it, and a country
 * takes its regions along. Refused while tax is on and a taxed default or
 * shipping class would be left without an active rate.
 */
export async function deleteTaxRegion(db: Database, id: string, expectedVersion: number) {
    const current = await db.select().from(taxRegions).where(eq(taxRegions.id, id)).get();
    if (!current) throw new NotFoundError("Tax region not found.");
    if (current.version !== expectedVersion) throw new ConflictError("Tax region changed. Reload and try again.");
    const isCountry = isCountryTaxRegion({ adminArea: current.adminArea, postalPrefix: current.postalPrefix, placeId: current.placeId });
    const removeRegion = db.delete(taxRegions)
        .where(and(eq(taxRegions.id, id), eq(taxRegions.version, expectedVersion)))
        .returning({ id: taxRegions.id });
    // A country's regions go first: the database refuses a country with regions left.
    const statements: BatchItem<"sqlite">[] = [
        ...(isCountry ? [db.delete(taxRegions).where(and(
            eq(taxRegions.countryCode, current.countryCode),
            or(ne(taxRegions.adminArea, ""), ne(taxRegions.postalPrefix, ""), sql`${taxRegions.placeId} IS NOT NULL`),
        ))] : []),
        removeRegion,
        buildTaxConfigurationReadinessGuard(db),
    ];
    let results: unknown[];
    try {
        results = [...await safeBatch(db, statements as unknown as readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]])];
    } catch (error) {
        if (isTaxConfigurationReadinessConflict(error)) {
            throw new ConflictError(TAX_CONFIGURATION_READINESS_MESSAGE);
        }
        throw error;
    }
    const removed = results[isCountry ? 1 : 0] as Array<{ id: string }> | undefined;
    if (!removed?.[0]) throw new ConflictError("Tax region changed. Reload and try again.");
    return { id, countryCode: current.countryCode };
}
