import type { Database } from "@scalius/database/client";
import {
    deliveryLocations,
    productVariants,
    products,
    taxClasses,
    taxRates,
    taxSettings,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { and, asc, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { TaxJurisdictionType } from "./types";

const DEFAULT_SETTINGS = {
    id: "default" as const,
    enabled: false,
    pricesIncludeTax: false,
    taxShipping: false,
    defaultTaxClassId: null,
    shippingTaxClassId: null,
    displayLabel: "Tax",
    version: 0,
    createdAt: null,
    updatedAt: null,
};

export interface UpdateTaxSettingsInput {
    expectedVersion: number;
    enabled: boolean;
    pricesIncludeTax: boolean;
    taxShipping: boolean;
    defaultTaxClassId: string | null;
    shippingTaxClassId: string | null;
    displayLabel: string;
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
    name: string;
    rateBps: number;
    jurisdictionType: TaxJurisdictionType;
    jurisdictionId?: string | null;
    jurisdictionLabel?: string | null;
    priority?: number;
    isCompound?: boolean;
    isActive?: boolean;
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

function isTaxClassNameConstraint(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /tax_classes_active_name_ci_unique|unique constraint.*tax_classes/i.test(message);
}

async function resolveJurisdiction(
    db: Database,
    input: Pick<CreateTaxRateInput, "jurisdictionType" | "jurisdictionId" | "jurisdictionLabel">,
) {
    if (input.jurisdictionType === "all") {
        return { jurisdictionId: null, jurisdictionLabel: null };
    }
    const jurisdictionId = input.jurisdictionId?.trim() || "";
    if (!jurisdictionId || jurisdictionId.length > 180) {
        throw new ValidationError("A valid destination identifier is required for scoped tax rates.");
    }
    const location = await db.select({
        id: deliveryLocations.id,
        name: deliveryLocations.name,
    }).from(deliveryLocations).where(and(
        eq(deliveryLocations.id, jurisdictionId),
        eq(deliveryLocations.type, input.jurisdictionType),
        eq(deliveryLocations.isActive, true),
        isNull(deliveryLocations.deletedAt),
    )).get();
    if (!location) {
        throw new ValidationError(`Choose an active ${input.jurisdictionType} from the configured delivery locations.`);
    }
    return { jurisdictionId: location.id, jurisdictionLabel: location.name };
}

async function assertActiveTaxClass(db: Database, id: string | null, label: string): Promise<void> {
    if (!id) return;
    const row = await db.select({ id: taxClasses.id })
        .from(taxClasses)
        .where(and(eq(taxClasses.id, id), isNull(taxClasses.deletedAt)))
        .get();
    if (!row) throw new ValidationError(`${label} is not an active tax class.`);
}

export async function getTaxConfiguration(db: Database) {
    const [settings, classes, rates, jurisdictions] = await db.batch([
        db.select().from(taxSettings).where(eq(taxSettings.id, "default")),
        db.select().from(taxClasses).where(isNull(taxClasses.deletedAt)).orderBy(asc(taxClasses.name)),
        db.select().from(taxRates).where(isNull(taxRates.deletedAt)).orderBy(
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
        rates,
        jurisdictions,
    };
}

export async function updateTaxSettings(db: Database, input: UpdateTaxSettingsInput) {
    const displayLabel = normalizeName(input.displayLabel, "Tax label", 80);
    await Promise.all([
        assertActiveTaxClass(db, input.defaultTaxClassId, "Default tax class"),
        assertActiveTaxClass(db, input.shippingTaxClassId, "Shipping tax class"),
    ]);
    if (input.enabled && !input.defaultTaxClassId) {
        throw new ValidationError("Choose a default tax class before enabling tax.");
    }
    if (input.taxShipping && !input.shippingTaxClassId && !input.defaultTaxClassId) {
        throw new ValidationError("Choose a shipping or default tax class before taxing shipping.");
    }

    if (input.expectedVersion === 0) {
        const inserted = await db.insert(taxSettings).values({
            id: "default",
            enabled: input.enabled,
            pricesIncludeTax: input.pricesIncludeTax,
            taxShipping: input.taxShipping,
            defaultTaxClassId: input.defaultTaxClassId,
            shippingTaxClassId: input.shippingTaxClassId,
            displayLabel,
            version: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).onConflictDoNothing().returning();
        if (inserted[0]) return inserted[0];
        throw new ConflictError("Tax settings were created by another request. Reload and try again.");
    }

    const updated = await db.update(taxSettings).set({
        enabled: input.enabled,
        pricesIncludeTax: input.pricesIncludeTax,
        taxShipping: input.taxShipping,
        defaultTaxClassId: input.defaultTaxClassId,
        shippingTaxClassId: input.shippingTaxClassId,
        displayLabel,
        version: sql`${taxSettings.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(taxSettings.id, "default"),
        eq(taxSettings.version, input.expectedVersion),
    )).returning();
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
    let rows: typeof current[];
    try {
        rows = await db.update(taxClasses).set({
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
        sql`NOT EXISTS (SELECT 1 FROM ${taxRates} WHERE ${taxRates.taxClassId} = ${id} AND ${taxRates.deletedAt} IS NULL)`,
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

export async function createTaxRate(db: Database, input: CreateTaxRateInput) {
    await assertActiveTaxClass(db, input.taxClassId, "Tax class");
    const scope = await resolveJurisdiction(db, input);
    const rows = await db.insert(taxRates).values({
        id: `taxr_${nanoid()}`,
        taxClassId: input.taxClassId,
        name: normalizeName(input.name, "Rate name"),
        rateBps: input.rateBps,
        jurisdictionType: input.jurisdictionType,
        ...scope,
        priority: input.priority ?? 0,
        isCompound: input.isCompound ?? false,
        isActive: input.isActive ?? true,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }).returning();
    return rows[0]!;
}

export async function updateTaxRate(db: Database, id: string, input: UpdateTaxRateInput) {
    const current = await db.select().from(taxRates).where(and(eq(taxRates.id, id), isNull(taxRates.deletedAt))).get();
    if (!current) throw new NotFoundError("Tax rate not found.");
    if (current.version !== input.expectedVersion) throw new ConflictError("Tax rate changed. Reload and try again.");
    const taxClassId = input.taxClassId ?? current.taxClassId;
    await assertActiveTaxClass(db, taxClassId, "Tax class");
    const jurisdictionType = input.jurisdictionType ?? current.jurisdictionType;
    const scope = await resolveJurisdiction(db, {
        jurisdictionType,
        jurisdictionId: input.jurisdictionId === undefined ? current.jurisdictionId : input.jurisdictionId,
        jurisdictionLabel: input.jurisdictionLabel === undefined ? current.jurisdictionLabel : input.jurisdictionLabel,
    });
    const rows = await db.update(taxRates).set({
        taxClassId,
        name: input.name === undefined ? current.name : normalizeName(input.name, "Rate name"),
        rateBps: input.rateBps ?? current.rateBps,
        jurisdictionType,
        ...scope,
        priority: input.priority ?? current.priority,
        isCompound: input.isCompound ?? current.isCompound,
        isActive: input.isActive ?? current.isActive,
        version: sql`${taxRates.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(taxRates.id, id), eq(taxRates.version, input.expectedVersion), isNull(taxRates.deletedAt))).returning();
    if (!rows[0]) throw new ConflictError("Tax rate changed. Reload and try again.");
    return rows[0];
}

export async function deleteTaxRate(db: Database, id: string, expectedVersion: number) {
    const rows = await db.update(taxRates).set({
        deletedAt: sql`unixepoch()`,
        isActive: false,
        version: sql`${taxRates.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(taxRates.id, id),
        eq(taxRates.version, expectedVersion),
        isNull(taxRates.deletedAt),
    )).returning();
    if (rows[0]) return rows[0];
    const exists = await db.select({ id: taxRates.id }).from(taxRates).where(eq(taxRates.id, id)).get();
    if (!exists) throw new NotFoundError("Tax rate not found.");
    throw new ConflictError("Tax rate changed. Reload and try again.");
}

export type TaxClassificationKind = "product" | "variant";

export async function listTaxClassifications(db: Database, input: {
    kind: TaxClassificationKind;
    page: number;
    limit: number;
    search?: string;
}) {
    const offset = (input.page - 1) * input.limit;
    const search = input.search?.trim();
    if (input.kind === "product") {
        const where = and(
            isNull(products.deletedAt),
            search ? or(like(products.name, `%${search}%`), like(products.slug, `%${search}%`)) : undefined,
        );
        const [rows, totalRow] = await Promise.all([
            db.select({
                id: products.id,
                productId: products.id,
                productName: products.name,
                label: products.name,
                sku: sql<string | null>`NULL`,
                taxClassId: products.taxClassId,
                taxClassName: taxClasses.name,
                version: products.taxClassificationVersion,
            }).from(products).leftJoin(taxClasses, eq(products.taxClassId, taxClasses.id))
                .where(where).orderBy(desc(products.updatedAt), asc(products.id)).limit(input.limit).offset(offset),
            db.select({ count: sql<number>`count(*)` }).from(products).where(where).get(),
        ]);
        return { items: rows.map((row) => ({ ...row, kind: "product" as const })), total: totalRow?.count ?? 0 };
    }

    const where = and(
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        search ? or(
            like(products.name, `%${search}%`),
            like(productVariants.sku, `%${search}%`),
            like(productVariants.size, `%${search}%`),
            like(productVariants.color, `%${search}%`),
        ) : undefined,
    );
    const [rows, totalRow] = await Promise.all([
        db.select({
            id: productVariants.id,
            productId: products.id,
            productName: products.name,
            label: sql<string>`trim(${products.name} || ' · ' || coalesce(${productVariants.size}, '') || CASE WHEN ${productVariants.color} IS NOT NULL THEN ' / ' || ${productVariants.color} ELSE '' END)`,
            sku: productVariants.sku,
            taxClassId: productVariants.taxClassId,
            taxClassName: taxClasses.name,
            version: productVariants.taxClassificationVersion,
        }).from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
            .leftJoin(taxClasses, eq(productVariants.taxClassId, taxClasses.id))
            .where(where).orderBy(desc(productVariants.updatedAt), asc(productVariants.id)).limit(input.limit).offset(offset),
        db.select({ count: sql<number>`count(*)` }).from(productVariants)
            .innerJoin(products, eq(productVariants.productId, products.id)).where(where).get(),
    ]);
    return { items: rows.map((row) => ({ ...row, kind: "variant" as const })), total: totalRow?.count ?? 0 };
}

export async function updateTaxClassification(db: Database, input: {
    kind: TaxClassificationKind;
    id: string;
    taxClassId: string | null;
    expectedVersion: number;
}) {
    await assertActiveTaxClass(db, input.taxClassId, "Tax class");
    if (input.kind === "product") {
        const rows = await db.update(products).set({
            taxClassId: input.taxClassId,
            taxClassificationVersion: sql`${products.taxClassificationVersion} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(products.id, input.id),
            eq(products.taxClassificationVersion, input.expectedVersion),
            isNull(products.deletedAt),
        )).returning({ id: products.id, taxClassId: products.taxClassId, version: products.taxClassificationVersion });
        if (rows[0]) return { ...rows[0], kind: input.kind };
    } else {
        const rows = await db.update(productVariants).set({
            taxClassId: input.taxClassId,
            taxClassificationVersion: sql`${productVariants.taxClassificationVersion} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(productVariants.id, input.id),
            eq(productVariants.taxClassificationVersion, input.expectedVersion),
            isNull(productVariants.deletedAt),
        )).returning({ id: productVariants.id, taxClassId: productVariants.taxClassId, version: productVariants.taxClassificationVersion });
        if (rows[0]) return { ...rows[0], kind: input.kind };
    }
    throw new ConflictError("Tax classification changed or the catalog item is unavailable. Reload and try again.");
}
