// Licence-key pools (Wave B §3.2): the pool is the variant's tracked stock.
// An import adds the keys and a ledger-v2 `+n` stock edge in one batch (the
// companion statements of `executeInventoryOperation`); revoking unused keys
// is the same with `-n`. Checkout then reserves stock as usual, so demand can
// never exceed the keys still unassigned. Staff see `last4` only.
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError } from "@scalius/database/client";
import {
    digitalAssets,
    digitalLicenceKeys,
    inventoryOperations,
    productVariants,
} from "@scalius/database/schema";
import {
    LICENCE_KEY_IMPORT_MAX_KEYS,
    licenceKeyLast4,
    normalizeLicenceKeyImport,
    type LicenceKeyImportReject,
    type LicenceKeyStatus,
} from "@scalius/shared/digital";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { executeInventoryOperation } from "../inventory/inventory-operations";
import { licenceKeyCrypto } from "./secrets";

const ID_CHUNK = 90;
/** id, asset_id, key_ciphertext, key_hash, key_last4, status, import_id, created_at (+ spare). */
const KEY_INSERT_PARAMS = 10;

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function chunks<T>(values: readonly T[], size = ID_CHUNK): T[][] {
    const result: T[][] = [];
    for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
    return result;
}

/** The pool and its variant, which must still be a live tracked SKU. */
async function requirePool(db: Database, assetId: string) {
    const pool = await db.select({
        id: digitalAssets.id,
        kind: digitalAssets.kind,
        status: digitalAssets.status,
        variantId: digitalAssets.variantId,
        trackInventory: productVariants.trackInventory,
        variantDeletedAt: productVariants.deletedAt,
    }).from(digitalAssets)
        .leftJoin(productVariants, eq(productVariants.id, digitalAssets.variantId))
        .where(eq(digitalAssets.id, assetId))
        .get();
    if (!pool) throw new NotFoundError("Licence-key pool not found");
    if (pool.kind !== "licence_keys" || !pool.variantId) throw new ValidationError("This item isn't a licence-key pool.");
    if (pool.variantDeletedAt) throw new ValidationError("This variant was removed.");
    if (!pool.trackInventory) throw new ValidationError("Turn on quantity tracking for this variant: its licence keys are its stock.");
    return { ...pool, variantId: pool.variantId };
}

export interface ImportLicenceKeysResult {
    importId: string;
    /** Keys added to the pool (and to the variant's stock). */
    imported: number;
    /** Keys already in this pool, skipped. */
    alreadyInPool: number;
    /** Lines refused (the keys themselves are never echoed back). */
    rejected: LicenceKeyImportReject[];
    /** The same request key already imported this batch. */
    replayed: boolean;
    variantId: string;
    previousStock: number;
    stock: number;
}

/**
 * Imports up to 500 keys into a pool (one per line, or the first CSV column).
 * Keys already in the pool are skipped by their hash; the rest are encrypted
 * and added together with a `+n` stock edge, atomically and idempotently per
 * `requestKey`.
 */
export async function importLicenceKeys(
    db: Database,
    input: {
        assetId: string;
        keys: readonly string[];
        requestKey: string;
        credentialKey: string | undefined;
        adminUserId?: string;
    },
): Promise<ImportLicenceKeysResult> {
    const pool = await requirePool(db, input.assetId);
    if (pool.status === "archived") throw new ConflictError("Restore this pool before importing keys.");
    if (input.keys.length > LICENCE_KEY_IMPORT_MAX_KEYS) {
        throw new ValidationError(`Import at most ${LICENCE_KEY_IMPORT_MAX_KEYS} keys at a time.`);
    }
    const parsed = normalizeLicenceKeyImport(input.keys.join("\n"));
    if (parsed.exceedsLimit) throw new ValidationError(`Import at most ${LICENCE_KEY_IMPORT_MAX_KEYS} keys at a time.`);

    const importId = `lki_${(await sha256Hex(`${input.assetId}\0${input.requestKey}`)).slice(0, 32)}`;
    const operationKey = `licence-import:${importId}`;
    const replay = async (): Promise<ImportLicenceKeysResult | null> => {
        const operation = await db.select({ key: inventoryOperations.operationKey }).from(inventoryOperations)
            .where(eq(inventoryOperations.operationKey, operationKey)).get();
        if (!operation) return null;
        const [row] = await db.select({ count: sql<number>`count(*)` }).from(digitalLicenceKeys)
            .where(and(eq(digitalLicenceKeys.assetId, input.assetId), eq(digitalLicenceKeys.importId, importId))).all();
        const variant = await db.select({ stock: productVariants.stock }).from(productVariants).where(eq(productVariants.id, pool.variantId)).get();
        const imported = Number(row?.count ?? 0);
        return {
            importId,
            imported,
            alreadyInPool: Math.max(0, parsed.keys.length - imported),
            rejected: parsed.rejects,
            replayed: true,
            variantId: pool.variantId,
            previousStock: variant?.stock ?? 0,
            stock: variant?.stock ?? 0,
        };
    };
    const replayed = await replay();
    if (replayed) return replayed;

    const cipher = await licenceKeyCrypto(input.credentialKey);
    const hashed = await Promise.all(parsed.keys.map(async (key) => ({ key, hash: await cipher.hash(key) })));
    const existing = new Set<string>();
    for (const part of chunks(hashed.map((entry) => entry.hash))) {
        const rows = await db.select({ hash: digitalLicenceKeys.keyHash }).from(digitalLicenceKeys)
            .where(and(eq(digitalLicenceKeys.assetId, input.assetId), inArray(digitalLicenceKeys.keyHash, part))).all();
        for (const row of rows) existing.add(row.hash);
    }
    const fresh = hashed.filter((entry) => !existing.has(entry.hash));
    if (fresh.length === 0) {
        const variant = await db.select({ stock: productVariants.stock }).from(productVariants).where(eq(productVariants.id, pool.variantId)).get();
        const stock = variant?.stock ?? 0;
        return { importId, imported: 0, alreadyInPool: hashed.length, rejected: parsed.rejects, replayed: false, variantId: pool.variantId, previousStock: stock, stock };
    }

    const now = Math.floor(Date.now() / 1000);
    const stamp = now.toString(36);
    const rows = await Promise.all(fresh.map(async (entry, index) => ({
        // Sortable within the import: keys go out in the order they were pasted.
        id: `dlk_${stamp}${index.toString().padStart(3, "0")}${nanoid(10)}`,
        assetId: input.assetId,
        keyCiphertext: await cipher.encrypt(entry.key, input.assetId),
        keyHash: entry.hash,
        keyLast4: licenceKeyLast4(entry.key) || "••",
        status: "available" as const,
        importId,
        createdAt: now,
    })));
    const companions: BatchItem<"sqlite">[] = chunkRowsForD1(rows, KEY_INSERT_PARAMS).map((chunk) =>
        db.insert(digitalLicenceKeys).values(chunk) as BatchItem<"sqlite">);

    try {
        const result = await executeInventoryOperation(db, {
            operationKey,
            operationType: "licence_keys",
            variantId: pool.variantId,
            pool: "stock",
            mode: "relative",
            delta: rows.length,
            reason: "Imported",
            notes: `${rows.length} key${rows.length === 1 ? "" : "s"} into ${input.assetId}`,
        }, input.adminUserId, { companionStatements: companions });
        return {
            importId,
            imported: rows.length,
            alreadyInPool: hashed.length - rows.length,
            rejected: parsed.rejects,
            replayed: false,
            variantId: pool.variantId,
            previousStock: result.previousStock,
            stock: result.newStock,
        };
    } catch (error) {
        const again = await replay();
        if (again) return again;
        const message = error instanceof Error ? error.message : "";
        if (message.includes("digital_licence_keys")) {
            throw new ConflictError("Some of these keys were imported at the same moment. Try again.");
        }
        throw error;
    }
}

/**
 * Retires unused keys: they leave the pool and the variant's stock together
 * (`-n`). Assigned keys can't be revoked (assignment is final), and keys held
 * by checkouts in progress can't either (stock never drops below reserved).
 */
export async function revokeLicenceKeys(
    db: Database,
    input: { assetId: string; keyIds: readonly string[]; requestKey: string; adminUserId?: string },
): Promise<{ revoked: number; variantId: string; previousStock: number; stock: number; replayed: boolean }> {
    const pool = await requirePool(db, input.assetId);
    const ids = [...new Set(input.keyIds)];
    if (ids.length === 0 || ids.length > ID_CHUNK) throw new ValidationError(`Choose 1 to ${ID_CHUNK} keys.`);
    const operationKey = `licence-revoke:${(await sha256Hex(`${input.assetId}\0${input.requestKey}`)).slice(0, 32)}`;
    const done = await db.select({ result: inventoryOperations.resultPayload }).from(inventoryOperations)
        .where(eq(inventoryOperations.operationKey, operationKey)).get();
    if (done) {
        const parsed = JSON.parse(done.result) as { delta?: number; newStock?: number };
        const stock = parsed.newStock ?? 0;
        return { revoked: Math.abs(parsed.delta ?? 0), variantId: pool.variantId, previousStock: stock, stock, replayed: true };
    }
    const available = await db.select({ id: digitalLicenceKeys.id }).from(digitalLicenceKeys)
        .where(and(eq(digitalLicenceKeys.assetId, input.assetId), inArray(digitalLicenceKeys.id, ids), eq(digitalLicenceKeys.status, "available")))
        .all();
    if (available.length === 0) throw new AppError(409, "LICENCE_KEYS_NOT_AVAILABLE", "None of these keys are unused.");
    const targets = available.map((row) => row.id);
    const result = await executeInventoryOperation(db, {
        operationKey,
        operationType: "licence_keys",
        variantId: pool.variantId,
        pool: "stock",
        mode: "relative",
        delta: -targets.length,
        reason: "Revoked",
        notes: `${targets.length} unused key${targets.length === 1 ? "" : "s"} from ${input.assetId}`,
    }, input.adminUserId, {
        companionStatements: [
            db.update(digitalLicenceKeys).set({ status: "revoked", revokedAt: sql`unixepoch()` })
                .where(and(inArray(digitalLicenceKeys.id, targets), eq(digitalLicenceKeys.status, "available"))) as BatchItem<"sqlite">,
            // Every targeted key left the pool here: a key assigned meanwhile aborts the batch.
            buildBatchGuard(db, sql`(SELECT count(*) FROM ${digitalLicenceKeys} WHERE ${inArray(digitalLicenceKeys.id, targets)} AND ${digitalLicenceKeys.status} = 'revoked') = ${targets.length}`, "LICENCE_KEYS_CHANGED"),
        ],
    }).catch((error: unknown) => {
        // A key assigned meanwhile fails the guard on every retry (a conflict in the end).
        if (error instanceof ConflictError || isBatchGuardError(error, "LICENCE_KEYS_CHANGED")) {
            throw new AppError(409, "LICENCE_KEYS_CHANGED", "Some of these keys were just sold. Reload and try again.");
        }
        throw error;
    });
    return { revoked: targets.length, variantId: pool.variantId, previousStock: result.previousStock, stock: result.newStock, replayed: false };
}

export interface LicenceKeyAdminView {
    id: string;
    last4: string;
    status: LicenceKeyStatus;
    orderItemId: string | null;
    assignedAt: number | null;
    revokedAt: number | null;
    createdAt: number;
}

/** One page of a pool's keys (masked), FIFO order, keyset on (created_at, id). */
export async function listLicenceKeys(
    db: Database,
    input: { assetId: string; status?: LicenceKeyStatus; cursor?: string | null; limit?: number },
): Promise<{ items: LicenceKeyAdminView[]; nextCursor: string | null }> {
    await requirePool(db, input.assetId).catch((error: unknown) => {
        // Listing an archived or untracked pool is still fine; a missing one is not.
        if (error instanceof NotFoundError) throw error;
    });
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    let after: { createdAt: number; id: string } | null = null;
    if (input.cursor) {
        const [createdAt, id] = input.cursor.split(":");
        if (createdAt && id && /^\d+$/.test(createdAt)) after = { createdAt: Number(createdAt), id };
    }
    const rows = await db.select({
        id: digitalLicenceKeys.id,
        last4: digitalLicenceKeys.keyLast4,
        status: digitalLicenceKeys.status,
        orderItemId: digitalLicenceKeys.orderItemId,
        assignedAt: digitalLicenceKeys.assignedAt,
        revokedAt: digitalLicenceKeys.revokedAt,
        createdAt: digitalLicenceKeys.createdAt,
    }).from(digitalLicenceKeys)
        .where(and(
            eq(digitalLicenceKeys.assetId, input.assetId),
            input.status ? eq(digitalLicenceKeys.status, input.status) : undefined,
            after ? or(gt(digitalLicenceKeys.createdAt, after.createdAt), and(eq(digitalLicenceKeys.createdAt, after.createdAt), gt(digitalLicenceKeys.id, after.id))) : undefined,
        ))
        .orderBy(asc(digitalLicenceKeys.createdAt), asc(digitalLicenceKeys.id))
        .limit(limit + 1)
        .all();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null };
}
