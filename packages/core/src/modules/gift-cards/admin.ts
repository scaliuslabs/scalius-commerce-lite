// Staff gift-card reads and writes (Wave B §4.2, §7.2). Reads need
// GIFT_CARDS_VIEW, writes GIFT_CARDS_MANAGE (checked by the route map). Staff
// see `last4` only; the code is shown once, at manual issue.
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { customers, giftCards, giftCardTransactions, orders, user } from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import type { GiftCardSource, GiftCardStatus, GiftCardTransactionKind } from "./browser";
import { GIFT_CARD_MAX_AMOUNT_MINOR } from "./issue";
import { giftCardIdFromRequestKey, giftCardBase64Url } from "./crypto";
import { buildGiftCardTransactionInsert, isGiftCardIdempotencyConflict, isGiftCardLedgerError } from "./ledger";
import { maskGiftCardRecipient } from "./mask";

type Statement = BatchItem<"sqlite">;

export const GIFT_CARD_LIST_FILTERS = ["active", "disabled", "expired", "empty"] as const;
export type GiftCardListFilter = (typeof GIFT_CARD_LIST_FILTERS)[number];

export interface StaffGiftCardSummary {
    id: string;
    last4: string;
    currencyCode: string;
    initialAmountMinor: number;
    balanceMinor: number;
    status: GiftCardStatus;
    expiresAt: number | null;
    expired: boolean;
    source: GiftCardSource;
    customer: { id: string; name: string } | null;
    recipientName: string | null;
    recipientContactMasked: string | null;
    createdAt: number;
    version: number;
}

export interface StaffGiftCardDetail extends StaffGiftCardSummary {
    note: string | null;
    message: string | null;
    recipientEmail: string | null;
    recipientPhone: string | null;
    sourceOrder: { id: string; orderNumber: number | null } | null;
    issuedBy: { id: string; name: string } | null;
}

export interface StaffGiftCardTransaction {
    id: string;
    kind: GiftCardTransactionKind;
    amountMinor: number;
    balanceAfterMinor: number;
    orderId: string | null;
    orderNumber: number | null;
    actorType: "system" | "admin" | "customer";
    actorName: string | null;
    reason: string | null;
    createdAt: number;
}

const summaryColumns = {
    id: giftCards.id,
    last4: giftCards.codeLast4,
    currencyCode: giftCards.currencyCode,
    initialAmountMinor: giftCards.initialAmountMinor,
    balanceMinor: giftCards.balanceMinor,
    status: giftCards.status,
    expiresAt: giftCards.expiresAt,
    source: giftCards.source,
    customerId: giftCards.customerId,
    customerName: customers.name,
    recipientName: giftCards.recipientName,
    recipientEmail: giftCards.recipientEmail,
    recipientPhone: giftCards.recipientPhone,
    createdAt: giftCards.createdAt,
    version: giftCards.version,
};

type SummaryRow = {
    id: string;
    last4: string;
    currencyCode: string;
    initialAmountMinor: number;
    balanceMinor: number;
    status: string;
    expiresAt: number | null;
    source: string;
    customerId: string | null;
    customerName: string | null;
    recipientName: string | null;
    recipientEmail: string | null;
    recipientPhone: string | null;
    createdAt: number;
    version: number;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function toSummary(row: SummaryRow, now = nowSeconds()): StaffGiftCardSummary {
    return {
        id: row.id,
        last4: row.last4,
        currencyCode: row.currencyCode,
        initialAmountMinor: row.initialAmountMinor,
        balanceMinor: row.balanceMinor,
        status: row.status as GiftCardStatus,
        expiresAt: row.expiresAt,
        expired: row.expiresAt !== null && row.expiresAt <= now,
        source: row.source as GiftCardSource,
        customer: row.customerId ? { id: row.customerId, name: row.customerName ?? "" } : null,
        recipientName: row.recipientName,
        recipientContactMasked: maskGiftCardRecipient({ email: row.recipientEmail, phone: row.recipientPhone }),
        createdAt: row.createdAt,
        version: row.version,
    };
}

function encodeCursor(createdAt: number, id: string): string {
    return giftCardBase64Url.encode(new TextEncoder().encode(`${createdAt}:${id}`));
}

function decodeCursor(cursor: string | null | undefined): { createdAt: number; id: string } | null {
    if (!cursor) return null;
    try {
        const [createdAt, id] = new TextDecoder().decode(giftCardBase64Url.decode(cursor)).split(":");
        const at = Number(createdAt);
        if (!Number.isSafeInteger(at) || !id?.startsWith("gc_")) return null;
        return { createdAt: at, id };
    } catch {
        return null;
    }
}

const LAST4_QUERY = /^[0-9A-HJKMNP-TV-Z]{4}$/;

/** Keyset list, newest first. `q` is a last-4 match or a customer name/phone/email search. */
export async function listGiftCardsForStaff(
    db: Database,
    input: { q?: string | null; status?: GiftCardListFilter | null; limit?: number; cursor?: string | null },
): Promise<{ items: StaffGiftCardSummary[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
    const now = nowSeconds();
    const conditions: SQL[] = [];
    const q = input.q?.trim() ?? "";
    if (q) {
        const upper = q.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
        if (LAST4_QUERY.test(upper)) {
            conditions.push(eq(giftCards.codeLast4, upper));
        } else {
            const like = `%${q.replace(/[%_\\]/g, (character) => `\\${character}`)}%`;
            conditions.push(sql`${giftCards.customerId} IN (
                SELECT ${customers.id} FROM ${customers}
                WHERE ${customers.name} LIKE ${like} ESCAPE '\\'
                   OR ${customers.phone} LIKE ${like} ESCAPE '\\'
                   OR ${customers.email} LIKE ${like} ESCAPE '\\'
                LIMIT 200
            )`);
        }
    }
    switch (input.status) {
        case "active":
            conditions.push(eq(giftCards.status, "active"));
            conditions.push(sql`(${giftCards.expiresAt} IS NULL OR ${giftCards.expiresAt} > ${now})`);
            break;
        case "disabled":
            conditions.push(eq(giftCards.status, "disabled"));
            break;
        case "expired":
            conditions.push(eq(giftCards.status, "active"));
            conditions.push(sql`${giftCards.expiresAt} IS NOT NULL AND ${giftCards.expiresAt} <= ${now}`);
            break;
        case "empty":
            conditions.push(eq(giftCards.balanceMinor, 0));
            break;
        default:
            break;
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
        conditions.push(or(
            lt(giftCards.createdAt, cursor.createdAt),
            and(eq(giftCards.createdAt, cursor.createdAt), lt(giftCards.id, cursor.id)),
        )!);
    }
    const rows = await db.select(summaryColumns)
        .from(giftCards)
        .leftJoin(customers, eq(customers.id, giftCards.customerId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(giftCards.createdAt), desc(giftCards.id))
        .limit(limit + 1)
        .all();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
        items: page.map((row) => toSummary(row, now)),
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
}

/** Outstanding liability per currency: Σ balance of active, unexpired cards. */
export async function giftCardLiabilitySummary(
    db: Database,
): Promise<Array<{ currencyCode: string; balanceMinor: number; cards: number }>> {
    const now = nowSeconds();
    const rows = await db.select({
        currencyCode: giftCards.currencyCode,
        balanceMinor: sql<number>`coalesce(sum(${giftCards.balanceMinor}), 0)`,
        cards: sql<number>`count(*)`,
    })
        .from(giftCards)
        .where(and(
            eq(giftCards.status, "active"),
            sql`${giftCards.balanceMinor} > 0`,
            sql`(${giftCards.expiresAt} IS NULL OR ${giftCards.expiresAt} > ${now})`,
        ))
        .groupBy(giftCards.currencyCode)
        .all();
    return rows.map((row) => ({
        currencyCode: row.currencyCode,
        balanceMinor: Number(row.balanceMinor),
        cards: Number(row.cards),
    }));
}

const TRANSACTION_PAGE = 200;

export async function getGiftCardForStaff(
    db: Database,
    giftCardId: string,
): Promise<{ giftCard: StaffGiftCardDetail; transactions: StaffGiftCardTransaction[] }> {
    const issuer = alias(user, "issuer");
    const row = await db.select({
        ...summaryColumns,
        note: giftCards.note,
        message: giftCards.message,
        sourceOrderId: giftCards.sourceOrderId,
        sourceOrderNumber: orders.orderNumber,
        issuedByUserId: giftCards.issuedByUserId,
        issuedByName: issuer.name,
    })
        .from(giftCards)
        .leftJoin(customers, eq(customers.id, giftCards.customerId))
        .leftJoin(orders, eq(orders.id, giftCards.sourceOrderId))
        .leftJoin(issuer, eq(issuer.id, giftCards.issuedByUserId))
        .where(eq(giftCards.id, giftCardId))
        .get();
    if (!row) throw new NotFoundError("Gift card not found.");

    const actor = alias(user, "actor");
    const transactions = await db.select({
        id: giftCardTransactions.id,
        kind: giftCardTransactions.kind,
        amountMinor: giftCardTransactions.amountMinor,
        balanceAfterMinor: giftCardTransactions.balanceAfterMinor,
        orderId: giftCardTransactions.orderId,
        orderNumber: orders.orderNumber,
        actorType: giftCardTransactions.actorType,
        actorId: giftCardTransactions.actorId,
        actorName: actor.name,
        reason: giftCardTransactions.reason,
        createdAt: giftCardTransactions.createdAt,
    })
        .from(giftCardTransactions)
        .leftJoin(orders, eq(orders.id, giftCardTransactions.orderId))
        .leftJoin(actor, and(eq(giftCardTransactions.actorType, "admin"), eq(actor.id, giftCardTransactions.actorId)))
        .where(eq(giftCardTransactions.giftCardId, giftCardId))
        .orderBy(desc(giftCardTransactions.createdAt), desc(giftCardTransactions.id))
        .limit(TRANSACTION_PAGE)
        .all();

    return {
        giftCard: {
            ...toSummary(row),
            note: row.note,
            message: row.message,
            recipientEmail: row.recipientEmail,
            recipientPhone: row.recipientPhone,
            sourceOrder: row.sourceOrderId ? { id: row.sourceOrderId, orderNumber: row.sourceOrderNumber ?? null } : null,
            issuedBy: row.issuedByUserId ? { id: row.issuedByUserId, name: row.issuedByName ?? "" } : null,
        },
        transactions: transactions.map((transaction) => ({
            id: transaction.id,
            kind: transaction.kind as GiftCardTransactionKind,
            amountMinor: transaction.amountMinor,
            balanceAfterMinor: transaction.balanceAfterMinor,
            orderId: transaction.orderId,
            orderNumber: transaction.orderNumber ?? null,
            actorType: transaction.actorType as StaffGiftCardTransaction["actorType"],
            actorName: transaction.actorType === "admin" ? transaction.actorName ?? null : null,
            reason: transaction.reason,
            createdAt: transaction.createdAt,
        })),
    };
}

export async function getStaffGiftCardSummary(db: Database, giftCardId: string): Promise<StaffGiftCardSummary> {
    const row = await db.select(summaryColumns)
        .from(giftCards)
        .leftJoin(customers, eq(customers.id, giftCards.customerId))
        .where(eq(giftCards.id, giftCardId))
        .get();
    if (!row) throw new NotFoundError("Gift card not found.");
    return toSummary(row);
}

/**
 * Staff balance adjustment: one `adjust` transaction with a required reason,
 * idempotent by request key (a retry adds nothing). The ledger guard refuses
 * an adjustment below zero.
 */
export async function adjustGiftCardBalance(
    db: Database,
    input: { giftCardId: string; amountMinor: number; reason: string; requestKey: string; actorUserId: string },
): Promise<StaffGiftCardSummary> {
    const reason = input.reason.normalize("NFC").trim();
    if (!reason || [...reason].length > 500) throw new ValidationError("Give a reason for the adjustment (up to 500 characters).");
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor === 0 || Math.abs(input.amountMinor) > GIFT_CARD_MAX_AMOUNT_MINOR) {
        throw new ValidationError("Enter an amount to add or remove.");
    }
    const requestKey = input.requestKey.trim();
    if (requestKey.length < 8 || requestKey.length > 128) throw new ValidationError("A request key is required.");
    const card = await db.select({ id: giftCards.id, balanceMinor: giftCards.balanceMinor })
        .from(giftCards).where(eq(giftCards.id, input.giftCardId)).get();
    if (!card) throw new NotFoundError("Gift card not found.");
    if (card.balanceMinor + input.amountMinor < 0) {
        throw new ValidationError("A gift card balance can't go below zero.");
    }
    const idempotencyKey = `adjust:${(await giftCardIdFromRequestKey("adjust", requestKey)).slice(3)}`;
    try {
        await safeBatch(db, [buildGiftCardTransactionInsert(db, {
            giftCardId: card.id,
            kind: "adjust",
            amountMinor: input.amountMinor,
            idempotencyKey,
            actor: { type: "admin", id: input.actorUserId },
            reason,
        })] as never);
    } catch (error) {
        if (isGiftCardIdempotencyConflict(error)) return getStaffGiftCardSummary(db, card.id);
        if (isGiftCardLedgerError(error)) throw new ConflictError("The balance changed. Reload the gift card and try again.");
        throw error;
    }
    return getStaffGiftCardSummary(db, card.id);
}

/**
 * Status, expiry, owner and note, under optimistic concurrency (`version`;
 * every ledger row also bumps it). Never touches the balance or the code.
 */
export async function updateGiftCardForStaff(
    db: Database,
    input: {
        giftCardId: string;
        version: number;
        status?: GiftCardStatus;
        expiresAt?: number | null;
        customerId?: string | null;
        note?: string | null;
    },
): Promise<StaffGiftCardSummary> {
    const changes: Partial<typeof giftCards.$inferInsert> = {};
    if (input.status !== undefined) changes.status = input.status;
    if (input.expiresAt !== undefined) changes.expiresAt = input.expiresAt;
    if (input.note !== undefined) {
        const note = input.note?.normalize("NFC").trim() || null;
        if (note && [...note].length > 500) throw new ValidationError("Notes can be up to 500 characters.");
        changes.note = note;
    }
    if (input.customerId !== undefined) {
        if (input.customerId) {
            const customer = await db.select({ id: customers.id }).from(customers)
                .where(and(eq(customers.id, input.customerId), sql`${customers.deletedAt} IS NULL`)).get();
            if (!customer) throw new ValidationError("That customer doesn't exist.");
        }
        changes.customerId = input.customerId;
    }
    if (Object.keys(changes).length === 0) return getStaffGiftCardSummary(db, input.giftCardId);
    const updated = await db.update(giftCards)
        .set({ ...changes, version: sql`${giftCards.version} + 1`, updatedAt: sql`unixepoch()` })
        .where(and(eq(giftCards.id, input.giftCardId), eq(giftCards.version, input.version)))
        .returning({ id: giftCards.id });
    if (updated.length === 0) {
        const exists = await db.select({ id: giftCards.id }).from(giftCards).where(eq(giftCards.id, input.giftCardId)).get();
        if (!exists) throw new NotFoundError("Gift card not found.");
        throw new ConflictError("This gift card changed since you opened it. Reload it and try again.");
    }
    return getStaffGiftCardSummary(db, input.giftCardId);
}

/** Cards by id (for batched presentation, e.g. tender rows); ≤ 90 per query. */
export async function listGiftCardLast4(db: Database, giftCardIds: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let index = 0; index < giftCardIds.length; index += 90) {
        const chunk = giftCardIds.slice(index, index + 90);
        const rows = await db.select({ id: giftCards.id, last4: giftCards.codeLast4 })
            .from(giftCards).where(inArray(giftCards.id, chunk)).all();
        for (const row of rows) map.set(row.id, row.last4);
    }
    return map;
}

export type { Statement as GiftCardStatement };
