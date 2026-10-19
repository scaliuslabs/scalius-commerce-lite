// Digital stock rules (Wave B §3.2): a digital SKU's stock is its licence keys.
// Keys move it (import +n, revoke -n, both in `digital/licence-keys.ts`), and
// so do orders (reservation, release, delivery deduction). No manual path
// (editor quantity, option matrix, inventory adjust or count, scanner, CSV
// import, purchase orders, transfers) may change it, and physical units never
// silently become "keys": a SKU turns digital only with no stock (or exactly
// its unused keys, when it was digital before), and keys never silently
// become physical units: a SKU stops being digital only once it has no unused
// keys (revoking them moves its stock through the ledger). Files are unlimited.
//
// Each manual path checks the rule up front for a clear, field-level error,
// and the batches that could race a concurrent kind or stock change end with
// one of the guards below, so a stale read never commits.
import { digitalAssets, digitalLicenceKeys, productVariants } from "@scalius/database/schema";
import { buildBatchGuard, type Database, D1_ID_CHUNK_SIZE } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";

/** `details.reason` of every error these rules raise (the dashboard keys off it). */
export const DIGITAL_STOCK_IS_KEYS_REASON = "digital_stock_is_keys";

export const DIGITAL_STOCK_IS_KEYS_MESSAGE =
    "Digital variants don't take a quantity: their stock is their licence keys. Import keys or add a file in the Digital delivery card.";

export const DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE =
    "Set this variant's quantity to 0 before making it digital: a digital variant's stock is its licence keys.";

export const DIGITAL_KEY_POOL_NEEDS_TRACKING_MESSAGE =
    "Keep quantity tracking on for this variant: its licence keys are its stock. Archive the key pool first to stop tracking.";

export const DIGITAL_KEYS_KEEP_KIND_MESSAGE =
    "This variant still has unused licence keys, which are its stock. Revoke them in the Digital delivery card before it stops being digital.";

export const DIGITAL_STOCK_CANT_SPLIT_MESSAGE =
    "A digital variant's stock is its licence keys, so it can't be shared out across options. Revoke its unused keys in the Digital delivery card, then add options.";

/** Batch guard markers (one per rule, so a failed batch says which). */
export const DIGITAL_STOCK_IS_KEYS_MARKER = "DIGITAL_STOCK_IS_KEYS";
const DIGITAL_KIND_NEEDS_ZERO_STOCK_MARKER = "DIGITAL_KIND_NEEDS_ZERO_STOCK";
const DIGITAL_KEY_POOL_NEEDS_TRACKING_MARKER = "DIGITAL_KEY_POOL_NEEDS_TRACKING";
const DIGITAL_KEYS_KEEP_KIND_MARKER = "DIGITAL_KEYS_KEEP_KIND";

export interface DigitalStockErrorDetails {
    reason: typeof DIGITAL_STOCK_IS_KEYS_REASON;
    /** The request field the editor marks, e.g. `variants.2.stock`. */
    field?: string;
    sku?: string;
    variantId?: string;
}

/** The validation error every digital stock rule raises (400, `details.reason`). */
export function digitalStockError(
    context: { field?: string; sku?: string; variantId?: string } = {},
    message: string = DIGITAL_STOCK_IS_KEYS_MESSAGE,
): ValidationError {
    const details: DigitalStockErrorDetails = {
        reason: DIGITAL_STOCK_IS_KEYS_REASON,
        ...(context.field ? { field: context.field } : {}),
        ...(context.sku ? { sku: context.sku } : {}),
        ...(context.variantId ? { variantId: context.variantId } : {}),
    };
    return new ValidationError(message, details);
}

export function isDigitalKind(kind: string | null | undefined): boolean {
    return kind === "digital";
}

/** One SKU before and after a manual write (`after.kind` already resolved: omitted keeps). */
export interface DigitalSkuTransition {
    /** Null for a SKU this write creates. */
    before: { kind: string; stock: number; trackInventory: boolean } | null;
    after: { kind: string; stock: number; trackInventory: boolean };
}

/**
 * What a manual write asks of the rules: `manualQuantity` when it gives a
 * digital SKU a quantity (a new digital SKU with stock, or a digital SKU's
 * stock changed); `becomesDigital` when a SKU turns digital (it must end with
 * no stock, or exactly its unused keys); `dropsTracking` when a digital SKU
 * stops tracking quantity (refused while it has a ready key pool);
 * `leavesDigital` when a digital SKU turns physical or a service (refused
 * while it has unused keys: they are its stock, which would become typed-in
 * units while the keys sit undelivered).
 */
export function digitalSkuChecks(transition: DigitalSkuTransition): {
    manualQuantity: boolean;
    becomesDigital: boolean;
    dropsTracking: boolean;
    leavesDigital: boolean;
} {
    const { before, after } = transition;
    const wasDigital = before !== null && isDigitalKind(before.kind);
    if (!isDigitalKind(after.kind)) {
        return { manualQuantity: false, becomesDigital: false, dropsTracking: false, leavesDigital: wasDigital };
    }
    if (!before) return { manualQuantity: after.stock !== 0, becomesDigital: false, dropsTracking: false, leavesDigital: false };
    return {
        manualQuantity: wasDigital && after.stock !== before.stock,
        becomesDigital: !wasDigital,
        dropsTracking: before.trackInventory && !after.trackInventory,
        leavesDigital: false,
    };
}

type DigitalSkuInput = { stock?: number; fulfillmentKind?: string };

/**
 * Field-level issues for product create input: a digital SKU (its own kind or
 * the product's) is created without a quantity. Gift cards are left to their
 * own rules (untracked, no stock).
 */
export function digitalStockInputIssues(value: {
    isGiftCard?: boolean;
    fulfillmentKind?: string;
    defaultSku?: DigitalSkuInput;
    optionMatrix?: { variants: readonly DigitalSkuInput[] };
}): Array<{ path: Array<string | number>; message: string }> {
    if (value.isGiftCard === true) return [];
    const issues: Array<{ path: Array<string | number>; message: string }> = [];
    const check = (sku: DigitalSkuInput, path: Array<string | number>) => {
        const kind = sku.fulfillmentKind ?? value.fulfillmentKind;
        if (isDigitalKind(kind) && (sku.stock ?? 0) !== 0) {
            issues.push({ path: [...path, "stock"], message: DIGITAL_STOCK_IS_KEYS_MESSAGE });
        }
    };
    if (value.defaultSku) check(value.defaultSku, ["defaultSku"]);
    value.optionMatrix?.variants.forEach((variant, index) => check(variant, ["optionMatrix", "variants", index]));
    return issues;
}

/** Throws the first create-input issue as a field-level error. */
export function assertDigitalStockInput(value: Parameters<typeof digitalStockInputIssues>[0]): void {
    const issue = digitalStockInputIssues(value)[0];
    if (issue) throw digitalStockError({ field: issue.path.join(".") });
}

/** Unused keys in each SKU's licence-key pools (any pool status): what its stock may be when it turns digital. */
export async function readUnusedLicenceKeyCounts(db: Database, variantIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const unique = [...new Set(variantIds)];
    for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
        const rows = await db.select({
            variantId: digitalAssets.variantId,
            keys: sql<number>`count(${digitalLicenceKeys.id})`,
        })
            .from(digitalAssets)
            .innerJoin(digitalLicenceKeys, eq(digitalLicenceKeys.assetId, digitalAssets.id))
            .where(and(
                inArray(digitalAssets.variantId, unique.slice(index, index + D1_ID_CHUNK_SIZE)),
                eq(digitalAssets.kind, "licence_keys"),
                eq(digitalLicenceKeys.status, "available"),
            ))
            .groupBy(digitalAssets.variantId)
            .all();
        for (const row of rows) if (row.variantId) counts.set(row.variantId, Number(row.keys));
    }
    return counts;
}

/** SKUs (of these ids) that have a ready licence-key pool. */
export async function readVariantsWithReadyKeyPool(db: Database, variantIds: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const unique = [...new Set(variantIds)];
    for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
        const rows = await db.select({ variantId: digitalAssets.variantId })
            .from(digitalAssets)
            .where(and(
                inArray(digitalAssets.variantId, unique.slice(index, index + D1_ID_CHUNK_SIZE)),
                eq(digitalAssets.kind, "licence_keys"),
                eq(digitalAssets.status, "ready"),
            ))
            .all();
        for (const row of rows) if (row.variantId) found.add(row.variantId);
    }
    return found;
}

export type PlannedDigitalSkuWrite = DigitalSkuTransition & {
    variantId: string;
    sku?: string;
    /** Field prefix the editor marks (e.g. `variants.2`); omit for a single-SKU form. */
    fieldPrefix?: string;
};

function fieldOf(prefix: string | undefined, field: string): string {
    return prefix ? `${prefix}.${field}` : field;
}

/**
 * Checks a save's SKU writes against the rules (one read for key counts and
 * one for pools, only when a candidate needs it) and returns the batch guards
 * that keep them true at commit: SKUs turning digital still hold no stock (or
 * exactly their unused keys), and SKUs losing tracking still have no ready key
 * pool. Throws the first violation as a field-level error.
 */
export async function planDigitalSkuWrites(
    db: Database,
    writes: readonly PlannedDigitalSkuWrite[],
): Promise<BatchItem<"sqlite">[]> {
    const becomingDigital: PlannedDigitalSkuWrite[] = [];
    const losingTracking: PlannedDigitalSkuWrite[] = [];
    const leavingDigital: PlannedDigitalSkuWrite[] = [];
    for (const write of writes) {
        const checks = digitalSkuChecks(write);
        if (checks.manualQuantity) {
            throw digitalStockError({ field: fieldOf(write.fieldPrefix, "stock"), sku: write.sku, variantId: write.variantId });
        }
        if (checks.becomesDigital) becomingDigital.push(write);
        if (checks.dropsTracking) losingTracking.push(write);
        if (checks.leavesDigital) leavingDigital.push(write);
    }
    if (leavingDigital.length > 0) {
        const ids = leavingDigital.map((write) => write.variantId);
        const keys = await readUnusedLicenceKeyCounts(db, ids);
        const refused = leavingDigital.find((write) => (keys.get(write.variantId) ?? 0) > 0);
        if (refused) {
            throw digitalStockError(
                { field: fieldOf(refused.fieldPrefix, "fulfillmentKind"), sku: refused.sku, variantId: refused.variantId },
                DIGITAL_KEYS_KEEP_KIND_MESSAGE,
            );
        }
    }
    const stocked = becomingDigital.filter((write) => write.after.stock !== 0);
    if (stocked.length > 0) {
        const keys = await readUnusedLicenceKeyCounts(db, stocked.map((write) => write.variantId));
        const refused = stocked.find((write) => write.after.stock !== (keys.get(write.variantId) ?? 0));
        if (refused) {
            throw digitalStockError(
                { field: fieldOf(refused.fieldPrefix, "fulfillmentKind"), sku: refused.sku, variantId: refused.variantId },
                DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE,
            );
        }
    }
    if (losingTracking.length > 0) {
        const pooled = await readVariantsWithReadyKeyPool(db, losingTracking.map((write) => write.variantId));
        const refused = losingTracking.find((write) => pooled.has(write.variantId));
        if (refused) {
            throw digitalStockError(
                { field: fieldOf(refused.fieldPrefix, "trackInventory"), sku: refused.sku, variantId: refused.variantId },
                DIGITAL_KEY_POOL_NEEDS_TRACKING_MESSAGE,
            );
        }
    }
    return [
        ...buildDigitalKindChangeGuards(db, becomingDigital.map((write) => write.variantId)),
        ...buildDigitalTrackingGuards(db, losingTracking.map((write) => write.variantId)),
        ...buildDigitalKeysKeepKindGuards(db, leavingDigital.map((write) => write.variantId)),
    ];
}

function idsJson(ids: readonly string[]): string {
    return JSON.stringify([...new Set(ids)]);
}

/** Unused keys of the outer `product_variants` row named `alias`. */
function unusedKeysOf(alias: string): SQL {
    return sql`(
        SELECT count(*) FROM ${digitalLicenceKeys} AS dsk
        JOIN ${digitalAssets} AS dsa ON dsa.id = dsk.asset_id
        WHERE dsa.variant_id = ${sql.raw(`${alias}.id`)}
          AND dsa.kind = 'licence_keys'
          AND dsk.status = 'available'
    )`;
}

/**
 * After the batch's writes: every SKU of `variantIds` that is digital holds no
 * stock, or exactly its unused keys. Place it after the kind update.
 */
export function buildDigitalKindChangeGuards(db: Database, variantIds: readonly string[]): BatchItem<"sqlite">[] {
    const guards: BatchItem<"sqlite">[] = [];
    const unique = [...new Set(variantIds)];
    for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
        guards.push(buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM ${productVariants} AS dsv
            WHERE dsv.id IN (SELECT CAST(value AS TEXT) FROM json_each(${idsJson(unique.slice(index, index + D1_ID_CHUNK_SIZE))}))
              AND dsv.fulfillment_kind = 'digital'
              AND dsv.stock <> 0
              AND dsv.stock <> ${unusedKeysOf("dsv")}
        )`, DIGITAL_KIND_NEEDS_ZERO_STOCK_MARKER));
    }
    return guards;
}

/** After the batch's writes: no live digital SKU of `variantIds` is untracked with a ready key pool. */
export function buildDigitalTrackingGuards(db: Database, variantIds: readonly string[]): BatchItem<"sqlite">[] {
    const guards: BatchItem<"sqlite">[] = [];
    const unique = [...new Set(variantIds)];
    for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
        guards.push(buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM ${productVariants} AS dsv
            JOIN ${digitalAssets} AS dsa ON dsa.variant_id = dsv.id
            WHERE dsv.id IN (SELECT CAST(value AS TEXT) FROM json_each(${idsJson(unique.slice(index, index + D1_ID_CHUNK_SIZE))}))
              AND dsv.fulfillment_kind = 'digital'
              AND dsv.track_inventory = 0
              AND dsv.deleted_at IS NULL
              AND dsa.kind = 'licence_keys'
              AND dsa.status = 'ready'
        )`, DIGITAL_KEY_POOL_NEEDS_TRACKING_MARKER));
    }
    return guards;
}

/**
 * After the batch's writes: no SKU of `variantIds` that stopped being digital
 * holds unused licence keys (an import racing the kind change aborts it).
 * Place it after the kind update.
 */
export function buildDigitalKeysKeepKindGuards(db: Database, variantIds: readonly string[]): BatchItem<"sqlite">[] {
    const guards: BatchItem<"sqlite">[] = [];
    const unique = [...new Set(variantIds)];
    for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
        guards.push(buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM ${productVariants} AS dsv
            WHERE dsv.id IN (SELECT CAST(value AS TEXT) FROM json_each(${idsJson(unique.slice(index, index + D1_ID_CHUNK_SIZE))}))
              AND dsv.fulfillment_kind <> 'digital'
              AND ${unusedKeysOf("dsv")} > 0
        )`, DIGITAL_KEYS_KEEP_KIND_MARKER));
    }
    return guards;
}

/**
 * A manual stock write's batch guard: the SKU is not digital at commit (a
 * kind change racing the write aborts it). Place it anywhere in the batch.
 */
export function buildNotDigitalSkuGuard(db: Database, variantId: string): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`NOT EXISTS (
        SELECT 1 FROM ${productVariants}
        WHERE ${productVariants.id} = ${variantId}
          AND ${productVariants.fulfillmentKind} = 'digital'
    )`, DIGITAL_STOCK_IS_KEYS_MARKER);
}

function errorText(error: unknown, depth = 0): string {
    if (depth > 5 || error === null || error === undefined) return "";
    if (typeof error !== "object") return String(error);
    const candidate = error as { message?: unknown; cause?: unknown };
    return `${typeof candidate.message === "string" ? candidate.message : ""} ${errorText(candidate.cause, depth + 1)}`;
}

/**
 * Rethrows a failed digital guard as the rule's validation error. Only an
 * error naming one of the markers is translated (a bare "malformed JSON"
 * could be any guard).
 */
export function rethrowDigitalStockRuleViolation(error: unknown): void {
    const text = errorText(error);
    if (text.includes(DIGITAL_KIND_NEEDS_ZERO_STOCK_MARKER)) {
        throw digitalStockError({ field: "fulfillmentKind" }, DIGITAL_KIND_NEEDS_ZERO_STOCK_MESSAGE);
    }
    if (text.includes(DIGITAL_KEY_POOL_NEEDS_TRACKING_MARKER)) {
        throw digitalStockError({ field: "trackInventory" }, DIGITAL_KEY_POOL_NEEDS_TRACKING_MESSAGE);
    }
    if (text.includes(DIGITAL_KEYS_KEEP_KIND_MARKER)) {
        throw digitalStockError({ field: "fulfillmentKind" }, DIGITAL_KEYS_KEEP_KIND_MESSAGE);
    }
    if (text.includes(DIGITAL_STOCK_IS_KEYS_MARKER)) throw digitalStockError();
}
