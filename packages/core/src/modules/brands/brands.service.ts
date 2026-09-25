// Brand records for the dashboard and agents: list, read and revision-guarded
// writes (create, edit, status, trash, restore, permanent delete). Every write
// is buyer-visible; the API route bumps the cache generation after it commits.

import { brands, media, products } from "@scalius/database/schema";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { HANDLE_MAX_LENGTH, nextFreeHandle, toHandle } from "@scalius/shared/handle";
import { BRAND_ID_PREFIX } from "@scalius/shared/catalog-brand";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import {
    BRAND_BATCH_LIMIT,
    type BrandRevisionClaim,
    type BrandStatus,
    type CreateBrandInput,
    type UpdateBrandInput,
    type UpdateBrandStatusInput,
} from "./brands.validation";
import { brandLogoColumns, brandLogoJoinCondition, presentBrandLogo } from "./brands.storefront";

type SQLiteBatchItem = BatchItem<"sqlite">;

export const BRAND_REVISION_CONFLICT = "BRAND_REVISION_CONFLICT";
const BRAND_LOGO_UNAVAILABLE = "BRAND_LOGO_UNAVAILABLE";
export const BRAND_OPTIONS_LIMIT = 50;
const SLUG_LOOKUP_LIMIT = 1000;
const INSERT_ATTEMPTS = 3;

export class BrandRevisionConflictError extends AppError {
    constructor(brandId: string, expectedRevision: number, currentRevision: number | null) {
        super(
            409,
            BRAND_REVISION_CONFLICT,
            "This brand changed while you were editing. Reload the latest brand and try again.",
            { brandId, expectedRevision, currentRevision },
        );
        this.name = "BrandRevisionConflictError";
    }
}

export class BrandStateConflictError extends AppError {
    constructor(brandId: string, requiredState: "active" | "trashed") {
        super(
            409,
            "BRAND_STATE_CONFLICT",
            requiredState === "active"
                ? "This brand is in trash. Restore it before changing it."
                : "This brand is not in trash. Return to brands and reload.",
            { brandId, requiredState },
        );
        this.name = "BrandStateConflictError";
    }
}

const LOGO_UNAVAILABLE_MESSAGE = "Choose a logo image from Files that is ready (not uploading, in trash or being deleted).";

function isBrandSlugConstraintError(error: unknown): boolean {
    for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
        const message = current instanceof Error ? current.message : String(current);
        if (/brands_slug_unique|UNIQUE constraint failed: brands\.slug/i.test(message)) return true;
        current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
    }
    return false;
}

/** A ready image in Files: the only logo a write may newly point at. */
function readyLogoCondition(mediaId: string): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${media}
        WHERE ${media.id} = ${mediaId} AND ${media.kind} = 'image' AND ${media.status} = 'ready'
    )`;
}

function normalizeClaims(claims: readonly BrandRevisionClaim[]): BrandRevisionClaim[] {
    if (claims.length === 0) throw new ValidationError("Select at least one brand.");
    if (claims.length > BRAND_BATCH_LIMIT) {
        throw new ValidationError(`Change at most ${BRAND_BATCH_LIMIT} brands at a time.`);
    }
    const normalized = claims.map((claim) => ({ id: claim.id.trim(), expectedRevision: claim.expectedRevision }));
    if (normalized.some((claim) => !claim.id || !Number.isInteger(claim.expectedRevision) || claim.expectedRevision < 1)) {
        throw new ValidationError("Every brand change requires an ID and positive expected revision.");
    }
    if (new Set(normalized.map((claim) => claim.id)).size !== normalized.length) {
        throw new ValidationError("Brand revision claims must use unique IDs.");
    }
    return normalized;
}

const claimIds = (claimsJson: string) => sql`(
    SELECT CAST(json_extract(value, '$.id') AS TEXT) FROM json_each(${claimsJson})
)`;

/** Every claim names a brand at its expected revision in the required lifecycle state. */
function claimsMatchCondition(claimsJson: string, count: number, state: "active" | "trashed"): SQL {
    return sql`(
        SELECT count(*)
        FROM json_each(${claimsJson}) AS claim
        INNER JOIN ${brands}
            ON ${brands.id} = CAST(json_extract(claim.value, '$.id') AS TEXT)
           AND ${brands.revision} = CAST(json_extract(claim.value, '$.expectedRevision') AS INTEGER)
        WHERE ${state === "active" ? sql`${brands.deletedAt} IS NULL` : sql`${brands.deletedAt} IS NOT NULL`}
    ) = ${count}`;
}

/** Explains why a claimed write matched nothing: a stale revision or the wrong lifecycle state. */
async function assertClaimsCurrent(
    db: Database,
    claims: readonly BrandRevisionClaim[],
    state: "active" | "trashed",
): Promise<void> {
    const rows = await db
        .select({ id: brands.id, revision: brands.revision, deletedAt: brands.deletedAt })
        .from(brands)
        .where(sql`${brands.id} IN ${claimIds(JSON.stringify(claims))}`)
        .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = claims.find((claim) => !byId.has(claim.id));
    if (missing) throw new NotFoundError("Brand not found");
    const stale = claims.find((claim) => byId.get(claim.id)!.revision !== claim.expectedRevision);
    if (stale) throw new BrandRevisionConflictError(stale.id, stale.expectedRevision, byId.get(stale.id)!.revision);
    const wrongState = rows.find((row) => (state === "active") !== (row.deletedAt === null));
    if (wrongState) throw new BrandStateConflictError(wrongState.id, state);
}

const productCountProjection = () => sql<number>`(
    SELECT count(*) FROM ${products}
    WHERE ${products.brandId} = ${brands.id} AND ${products.deletedAt} IS NULL
)`;

function toIso(value: number | null | undefined): string | null {
    return value ? new Date(Number(value) * 1000).toISOString() : null;
}

// ─────────────────────────────────────────
// Reads
// ─────────────────────────────────────────

export type BrandListSort = "name" | "sortOrder" | "createdAt" | "updatedAt";

export async function listBrands(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        status?: BrandStatus;
        showTrashed?: boolean;
        sort?: BrandListSort;
        order?: "asc" | "desc";
    } = {},
) {
    const page = Number.isSafeInteger(options.page) && Number(options.page) > 0 ? Number(options.page) : 1;
    const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(Number(options.limit), 1), 100) : 20;
    const conditions: SQL[] = [options.showTrashed ? isNotNull(brands.deletedAt) : isNull(brands.deletedAt)];
    const search = options.search?.trim().toLowerCase().slice(0, 100);
    if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
        conditions.push(sql`(lower(${brands.name}) LIKE ${pattern} ESCAPE '\\' OR ${brands.slug} LIKE ${pattern} ESCAPE '\\')`);
    }
    if (options.status) conditions.push(eq(brands.status, options.status));
    const where = and(...conditions);
    const sortColumn = options.sort === "name"
        ? brands.name
        : options.sort === "sortOrder"
            ? brands.sortOrder
            : options.sort === "createdAt" ? brands.createdAt : brands.updatedAt;
    const direction = (options.order ?? (options.sort === "name" || options.sort === "sortOrder" ? "asc" : "desc")) === "asc"
        ? asc
        : desc;
    const [counts, rows] = await db.batch([
        db.select({ count: sql<number>`count(*)` }).from(brands).where(where),
        db
            .select({
                id: brands.id,
                name: brands.name,
                slug: brands.slug,
                status: brands.status,
                sortOrder: brands.sortOrder,
                revision: brands.revision,
                noIndex: brands.noIndex,
                excludeFromSitemap: brands.excludeFromSitemap,
                productCount: productCountProjection(),
                createdAt: sql<number>`CAST(${brands.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${brands.updatedAt} AS INTEGER)`,
                deletedAt: sql<number | null>`CAST(${brands.deletedAt} AS INTEGER)`,
                ...brandLogoColumns,
            })
            .from(brands)
            .leftJoin(media, brandLogoJoinCondition())
            .where(where)
            .orderBy(direction(sortColumn), asc(brands.id))
            .limit(limit)
            .offset((page - 1) * limit),
    ]);
    const total = Number(counts[0]?.count ?? 0);
    return {
        brands: rows.map(({ logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight, ...row }) => ({
            ...row,
            productCount: Number(row.productCount ?? 0),
            logo: presentBrandLogo({ logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight }, row.name),
            createdAt: toIso(row.createdAt),
            updatedAt: toIso(row.updatedAt),
            deletedAt: toIso(row.deletedAt),
        })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
}

/** Live brands for a picker (the product form's brand field), name order, searchable. */
export async function listBrandOptions(db: Database, options: { search?: string; limit?: number } = {}) {
    const limit = Number.isSafeInteger(options.limit)
        ? Math.min(Math.max(Number(options.limit), 1), BRAND_OPTIONS_LIMIT)
        : BRAND_OPTIONS_LIMIT;
    const search = options.search?.trim().toLowerCase().slice(0, 100);
    const conditions: SQL[] = [isNull(brands.deletedAt)];
    if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
        conditions.push(sql`lower(${brands.name}) LIKE ${pattern} ESCAPE '\\'`);
    }
    return db
        .select({ id: brands.id, name: brands.name, status: brands.status })
        .from(brands)
        .where(and(...conditions))
        .orderBy(asc(brands.name), asc(brands.id))
        .limit(limit)
        .all();
}

export async function getBrandById(db: Database, id: string) {
    const row = await db
        .select({
            id: brands.id,
            name: brands.name,
            slug: brands.slug,
            description: brands.description,
            status: brands.status,
            sortOrder: brands.sortOrder,
            metaTitle: brands.metaTitle,
            metaDescription: brands.metaDescription,
            canonicalPath: brands.canonicalPath,
            noIndex: brands.noIndex,
            excludeFromSitemap: brands.excludeFromSitemap,
            listingTemplate: brands.listingTemplate,
            revision: brands.revision,
            productCount: productCountProjection(),
            createdAt: sql<number>`CAST(${brands.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${brands.updatedAt} AS INTEGER)`,
            deletedAt: sql<number | null>`CAST(${brands.deletedAt} AS INTEGER)`,
            storedLogoMediaId: brands.logoMediaId,
            ...brandLogoColumns,
        })
        .from(brands)
        .leftJoin(media, brandLogoJoinCondition())
        .where(eq(brands.id, id))
        .get();
    if (!row) return null;
    const { logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight, storedLogoMediaId, ...brand } = row;
    return {
        ...brand,
        logoMediaId: storedLogoMediaId,
        logo: presentBrandLogo({ logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight }, brand.name),
        productCount: Number(brand.productCount ?? 0),
        createdAt: toIso(brand.createdAt),
        updatedAt: toIso(brand.updatedAt),
        deletedAt: toIso(brand.deletedAt),
    };
}

// ─────────────────────────────────────────
// Writes
// ─────────────────────────────────────────

async function derivedBrandSlugCandidates(db: Database, name: string) {
    const base = toHandle(name).slice(0, HANDLE_MAX_LENGTH) || "brand";
    const rows = await db
        .select({ slug: brands.slug })
        .from(brands)
        .where(sql`${brands.slug} = ${base} OR ${brands.slug} LIKE ${`${base}-%`}`)
        .limit(SLUG_LOOKUP_LIMIT)
        .all();
    return { base, taken: new Set(rows.map((row) => row.slug)) };
}

/**
 * Creates a brand at revision 1 (draft unless another status is chosen). A
 * typed slug that is taken, including by a brand in trash, is refused; an
 * omitted one is derived from the name ("HP" → `hp`) and suffixed until free.
 */
export async function createBrand(
    db: Database,
    data: CreateBrandInput,
): Promise<{ id: string; slug: string; revision: number; status: BrandStatus }> {
    const id = `${BRAND_ID_PREFIX}${nanoid()}`;
    const insertWithSlug = async (slug: string) => {
        const insert = db.insert(brands).values({
            id,
            name: data.name,
            slug,
            description: data.description,
            logoMediaId: data.logoMediaId ?? null,
            status: data.status,
            sortOrder: data.sortOrder ?? 0,
            metaTitle: data.metaTitle,
            metaDescription: data.metaDescription,
            canonicalPath: data.canonicalPath ?? null,
            noIndex: data.noIndex ?? false,
            excludeFromSitemap: data.excludeFromSitemap ?? false,
            listingTemplate: data.listingTemplate ?? null,
            revision: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });
        if (data.logoMediaId) {
            await safeBatch(db, [
                buildBatchGuard(db, readyLogoCondition(data.logoMediaId), BRAND_LOGO_UNAVAILABLE),
                insert,
            ] as never);
        } else {
            await insert;
        }
        return slug;
    };

    try {
        if (data.slug) {
            const slug = await insertWithSlug(data.slug);
            return { id, slug, revision: 1, status: data.status };
        }
        const { base, taken } = await derivedBrandSlugCandidates(db, data.name);
        for (let attempt = 1; ; attempt += 1) {
            const candidate = nextFreeHandle(base, taken);
            try {
                const slug = await insertWithSlug(candidate);
                return { id, slug, revision: 1, status: data.status };
            } catch (error) {
                if (attempt >= INSERT_ATTEMPTS || !isBrandSlugConstraintError(error)) throw error;
                taken.add(candidate);
            }
        }
    } catch (error) {
        if (isBatchGuardError(error, BRAND_LOGO_UNAVAILABLE)) throw new ValidationError(LOGO_UNAVAILABLE_MESSAGE);
        if (isBrandSlugConstraintError(error)) {
            throw new ConflictError("A brand with this slug already exists, including in trash.");
        }
        throw error;
    }
}

/**
 * Edits a brand under its revision. `logoMediaId`, `sortOrder` and
 * `listingTemplate` keep their stored values when omitted; a newly chosen
 * logo must be a ready image.
 */
export async function updateBrand(
    db: Database,
    id: string,
    data: UpdateBrandInput,
): Promise<{ revision: number; status: BrandStatus }> {
    const existing = await db
        .select({ revision: brands.revision, deletedAt: brands.deletedAt, logoMediaId: brands.logoMediaId })
        .from(brands)
        .where(eq(brands.id, id))
        .get();
    if (!existing) throw new NotFoundError("Brand not found");
    const claims = [{ id, expectedRevision: data.expectedRevision }];
    if (existing.deletedAt || existing.revision !== data.expectedRevision) {
        await assertClaimsCurrent(db, claims, "active");
    }
    const logoChanges = data.logoMediaId !== undefined && data.logoMediaId !== existing.logoMediaId;
    const newLogo = logoChanges ? data.logoMediaId ?? null : null;

    try {
        const updated = await db
            .update(brands)
            .set({
                name: data.name,
                slug: data.slug,
                description: data.description,
                ...(logoChanges ? { logoMediaId: newLogo } : {}),
                status: data.status,
                ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
                metaTitle: data.metaTitle,
                metaDescription: data.metaDescription,
                canonicalPath: data.canonicalPath ?? null,
                noIndex: data.noIndex ?? false,
                excludeFromSitemap: data.excludeFromSitemap ?? false,
                ...(data.listingTemplate !== undefined ? { listingTemplate: data.listingTemplate } : {}),
                revision: sql`${brands.revision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(brands.id, id),
                eq(brands.revision, data.expectedRevision),
                isNull(brands.deletedAt),
                ...(newLogo ? [readyLogoCondition(newLogo)] : []),
            ))
            .returning({ revision: brands.revision })
            .get();
        if (!updated) {
            await assertClaimsCurrent(db, claims, "active");
            if (newLogo) throw new ValidationError(LOGO_UNAVAILABLE_MESSAGE);
            throw new ConflictError("Brand could not be updated. Reload and try again.");
        }
        return { revision: updated.revision, status: data.status };
    } catch (error) {
        if (isBrandSlugConstraintError(error)) {
            throw new ConflictError("A brand with this slug already exists, including in trash.");
        }
        throw error;
    }
}

export async function updateBrandStatus(
    db: Database,
    id: string,
    data: UpdateBrandStatusInput,
): Promise<{ revision: number; status: BrandStatus }> {
    const updated = await db
        .update(brands)
        .set({ status: data.status, revision: sql`${brands.revision} + 1`, updatedAt: sql`unixepoch()` })
        .where(and(eq(brands.id, id), eq(brands.revision, data.expectedRevision), isNull(brands.deletedAt)))
        .returning({ revision: brands.revision })
        .get();
    if (!updated) {
        await assertClaimsCurrent(db, [{ id, expectedRevision: data.expectedRevision }], "active");
        throw new ConflictError("Brand status could not be changed. Reload and try again.");
    }
    return { revision: updated.revision, status: data.status };
}

/**
 * Moves brands to trash (all or none) and returns them to draft. Their
 * products keep `brand_id` but show no brand while it is in trash.
 */
export async function trashBrands(db: Database, revisionClaims: readonly BrandRevisionClaim[]): Promise<void> {
    const claims = normalizeClaims(revisionClaims);
    const claimsJson = JSON.stringify(claims);
    const updated = await db
        .update(brands)
        .set({
            status: "draft",
            revision: sql`${brands.revision} + 1`,
            deletedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            sql`${brands.id} IN ${claimIds(claimsJson)}`,
            isNull(brands.deletedAt),
            claimsMatchCondition(claimsJson, claims.length, "active"),
        ))
        .returning({ id: brands.id })
        .all();
    if (updated.length !== claims.length) {
        await assertClaimsCurrent(db, claims, "active");
        throw new ConflictError("No brands were moved to trash. Reload the brand list and try again.");
    }
}

/** Restores brands from trash as drafts (all or none). */
export async function restoreBrands(db: Database, revisionClaims: readonly BrandRevisionClaim[]): Promise<void> {
    const claims = normalizeClaims(revisionClaims);
    const claimsJson = JSON.stringify(claims);
    const updated = await db
        .update(brands)
        .set({
            status: "draft",
            revision: sql`${brands.revision} + 1`,
            deletedAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            sql`${brands.id} IN ${claimIds(claimsJson)}`,
            isNotNull(brands.deletedAt),
            claimsMatchCondition(claimsJson, claims.length, "trashed"),
        ))
        .returning({ id: brands.id })
        .all();
    if (updated.length !== claims.length) {
        await assertClaimsCurrent(db, claims, "trashed");
        throw new ConflictError("No brands were restored. Reload the brand list and try again.");
    }
}

/**
 * Deletes brands already in trash (all or none). Their products lose the
 * brand (`brand_id` ON DELETE SET NULL) and advance their editor revision in
 * the same batch, so an open product form cannot save the deleted brand back.
 */
export async function permanentlyDeleteBrands(
    db: Database,
    revisionClaims: readonly BrandRevisionClaim[],
): Promise<void> {
    const claims = normalizeClaims(revisionClaims);
    const claimsJson = JSON.stringify(claims);
    const guard = claimsMatchCondition(claimsJson, claims.length, "trashed");
    const statements: SQLiteBatchItem[] = [
        buildBatchGuard(db, guard, BRAND_REVISION_CONFLICT),
        db.update(products)
            .set({ aggregateRevision: sql`${products.aggregateRevision} + 1`, updatedAt: sql`unixepoch()` })
            .where(sql`${products.brandId} IN ${claimIds(claimsJson)}`),
        db.delete(brands)
            .where(and(sql`${brands.id} IN ${claimIds(claimsJson)}`, isNotNull(brands.deletedAt)))
            .returning({ id: brands.id }),
    ];
    try {
        const results = await safeBatch(db, statements as never) as unknown[][];
        if ((results.at(-1) ?? []).length !== claims.length) {
            throw new ConflictError("Only brands already in trash can be deleted permanently.");
        }
    } catch (error) {
        if (isBatchGuardError(error, BRAND_REVISION_CONFLICT)) {
            await assertClaimsCurrent(db, claims, "trashed");
        }
        throw error;
    }
}
