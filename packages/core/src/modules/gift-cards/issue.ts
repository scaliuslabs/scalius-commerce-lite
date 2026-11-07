// Issuing gift cards (Wave B §4.2): sold as a product (one card per unit of a
// gift-card line, by the auto fulfiller), issued by staff, or refunded as
// store credit. A card is inserted with a zero balance and funded by its
// `issue` transaction in the same batch; the ledger is the only thing that
// ever moves the balance. Recipient details are a delivery target only and
// never touch `customers`.
import { isEmailAddress } from "@scalius/shared/text-scan";
import type { BatchItem } from "drizzle-orm/batch";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { giftCards, giftCardTransactions } from "@scalius/database/schema";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { ValidationError } from "../../errors";
import { GIFT_CARD_LIMITS, type GiftCardSource } from "./browser";
import {
    decryptGiftCardCode,
    deriveGiftCardKeys,
    giftCardIdFromRequestKey,
    sealNewGiftCardCode,
    type GiftCardKeys,
} from "./crypto";
import { buildGiftCardTransactionInsert } from "./ledger";

type Statement = BatchItem<"sqlite">;

/** Largest single card value (minor units): well beyond any real card, far inside safe integers. */
export const GIFT_CARD_MAX_AMOUNT_MINOR = 10_000_000_000;

export interface GiftCardRecipient {
    name: string | null;
    email: string | null;
    phone: string | null;
}

export interface GiftCardIssueInput {
    id: string;
    source: GiftCardSource;
    amountMinor: number;
    currencyCode: string;
    expiresAt: number | null;
    customerId: string | null;
    recipient: GiftCardRecipient | null;
    message: string | null;
    note: string | null;
    issuedByUserId: string | null;
    sourceOrderId?: string | null;
    sourceOrderItemId?: string | null;
    sourceUnitIndex?: number | null;
    sourceRefundAttemptId?: string | null;
    /** The `issue` transaction key: `issue:<kind>:<identity>`. */
    idempotencyKey: string;
    actor: { type: "system" | "admin"; id: string | null };
}

function cleanText(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const text = value.normalize("NFC").trim();
    if (!text) return null;
    return [...text].slice(0, max).join("");
}

/**
 * A recipient from untrusted input (line properties, staff form): one contact
 * at most (email wins), each validated; anything malformed is dropped rather
 * than stored. Returns null when nothing usable remains.
 */
export function normalizeGiftCardRecipient(input: {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
} | null | undefined): GiftCardRecipient | null {
    if (!input) return null;
    const name = cleanText(input.name, 120);
    const rawEmail = cleanText(input.email, 254)?.toLowerCase() ?? null;
    const email = rawEmail && isEmailAddress(rawEmail) ? rawEmail : null;
    let phone: string | null = null;
    const rawPhone = cleanText(input.phone, 40);
    if (!email && rawPhone) {
        try {
            phone = validateAndFormatPhone(rawPhone);
        } catch {
            phone = null;
        }
    }
    if (!name && !email && !phone) return null;
    return { name, email, phone };
}

/**
 * A recipient typed by staff: every field that is given must be valid, and
 * at most one contact. Unlike `normalizeGiftCardRecipient` (frozen line
 * properties, already validated at checkout), nothing is dropped silently:
 * a bad value is a field error.
 */
export function parseGiftCardRecipientStrict(input: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
} | null | undefined): GiftCardRecipient | null {
    if (!input) return null;
    const name = cleanText(input.name, 120);
    const rawEmail = cleanText(input.email, 254)?.toLowerCase() ?? null;
    const rawPhone = cleanText(input.phone, 40);
    if (rawEmail && rawPhone) {
        throw new ValidationError("Send the gift card to an email or a phone number, not both.", { field: "recipient.phone" });
    }
    if (rawEmail && !isEmailAddress(rawEmail)) {
        throw new ValidationError("Enter a valid recipient email.", { field: "recipient.email" });
    }
    let phone: string | null = null;
    if (rawPhone) {
        try {
            phone = validateAndFormatPhone(rawPhone);
        } catch (error) {
            throw new ValidationError(
                error instanceof Error && error.message ? error.message : "Enter a valid recipient phone number.",
                { field: "recipient.phone" },
            );
        }
    }
    if (!name && !rawEmail && !phone) return null;
    return { name, email: rawEmail, phone };
}

export function normalizeGiftCardMessage(value: unknown): string | null {
    return cleanText(value, GIFT_CARD_LIMITS.maxMessageLength);
}

function assertIssueAmount(amountMinor: number): void {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > GIFT_CARD_MAX_AMOUNT_MINOR) {
        throw new ValidationError("A gift card needs a positive amount.");
    }
}

/**
 * The card row and its funding `issue` transaction, for one batch. The
 * sealed code comes from `sealNewGiftCardCode`; the caller keeps the plain
 * code only when it must show it once (manual issue).
 */
export async function buildGiftCardIssueStatements(
    db: Database,
    keys: GiftCardKeys,
    input: GiftCardIssueInput,
): Promise<{ statements: Statement[]; code: string; last4: string }> {
    assertIssueAmount(input.amountMinor);
    const sealed = await sealNewGiftCardCode(keys);
    const recipient = input.recipient;
    const insert = db.insert(giftCards).values({
        id: input.id,
        codeHash: sealed.codeHash,
        codeCiphertext: sealed.codeCiphertext,
        codeLast4: sealed.codeLast4,
        currencyCode: input.currencyCode,
        initialAmountMinor: input.amountMinor,
        status: "active",
        expiresAt: input.expiresAt,
        source: input.source,
        sourceOrderId: input.sourceOrderId ?? null,
        sourceOrderItemId: input.sourceOrderItemId ?? null,
        sourceUnitIndex: input.sourceUnitIndex ?? null,
        sourceRefundAttemptId: input.sourceRefundAttemptId ?? null,
        customerId: input.customerId,
        recipientName: recipient?.name ?? null,
        recipientEmail: recipient?.email ?? null,
        recipientPhone: recipient?.email ? null : recipient?.phone ?? null,
        message: input.message,
        note: input.note,
        issuedByUserId: input.issuedByUserId,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }) as unknown as Statement;
    return {
        statements: [
            insert,
            buildGiftCardTransactionInsert(db, {
                giftCardId: input.id,
                kind: "issue",
                amountMinor: input.amountMinor,
                idempotencyKey: input.idempotencyKey,
                actor: input.actor,
                orderId: input.sourceOrderId ?? null,
                refundAttemptId: input.sourceRefundAttemptId ?? null,
            }),
        ],
        code: sealed.code,
        last4: sealed.codeLast4,
    };
}

/** `now + months` in epoch seconds (calendar months, UTC), or null for "never". */
export function giftCardExpiryFromMonths(months: number | null | undefined, nowSeconds = Math.floor(Date.now() / 1000)): number | null {
    if (months === null || months === undefined) return null;
    if (!Number.isInteger(months) || months < 1) return null;
    const date = new Date(nowSeconds * 1000);
    date.setUTCMonth(date.getUTCMonth() + months);
    return Math.floor(date.getTime() / 1000);
}

// ─────────────────────────────────────────
// Manual issue (staff)
// ─────────────────────────────────────────

export interface ManualGiftCardInput {
    /** Idempotency: the card id is derived from it, so a retry never issues twice. */
    requestKey: string;
    amountMinor: number;
    currencyCode: string;
    expiresAt: number | null;
    customerId: string | null;
    recipient: GiftCardRecipient | null;
    message: string | null;
    note: string | null;
    /** The staff member who acts; null when an app does (`appId`). */
    actorUserId: string | null;
    /** The app that acts: recorded as itself (`app:<id>`), never as the admin who approved it. */
    appId?: string | null;
}

/** Who a manual issue or adjustment records: an app as itself, staff by their account. */
export function giftCardWriteActor(input: { actorUserId: string | null; appId?: string | null }): { type: "system" | "admin"; id: string | null } {
    return input.appId ? { type: "system", id: `app:${input.appId}` } : { type: "admin", id: input.actorUserId };
}

export interface ManualGiftCardResult {
    giftCardId: string;
    /** The canonical code, returned once to the staff member who issued it. */
    code: string;
    created: boolean;
}

/**
 * Issues one card for staff (`GIFT_CARDS_MANAGE`). A retried request key
 * returns the same card (and its code, to the same staff flow) instead of a
 * second card. `extraStatements` (the notification outbox row) commit in the
 * same batch.
 */
export async function issueManualGiftCard(
    db: Database,
    credentialEncryptionKey: string | null | undefined,
    input: ManualGiftCardInput,
    extraStatements: (giftCardId: string) => Statement[] = () => [],
): Promise<ManualGiftCardResult> {
    const keys = await deriveGiftCardKeys(credentialEncryptionKey);
    const requestKey = input.requestKey.trim();
    if (requestKey.length < 8 || requestKey.length > 128) {
        throw new ValidationError("A request key is required.");
    }
    const giftCardId = await giftCardIdFromRequestKey("manual", requestKey);
    const actor = giftCardWriteActor(input);
    // The key belongs to who issued under it: an app (system/app:<id>) or a staff member, never a shared null.
    if (!actor.id) throw new ValidationError("Sign in again to manage gift cards.");
    const issueKey = `issue:manual:${giftCardId}`;
    const readIssued = () => db.select({ codeCiphertext: giftCards.codeCiphertext, actorType: giftCardTransactions.actorType, actorId: giftCardTransactions.actorId })
        .from(giftCards)
        .leftJoin(giftCardTransactions, eq(giftCardTransactions.idempotencyKey, issueKey))
        .where(eq(giftCards.id, giftCardId)).get();
    const issuedHere = (row: { actorType: string | null; actorId: string | null }) => row.actorType === actor.type && row.actorId === actor.id;
    const existing = await readIssued();
    const issuedByUserId = input.appId ? null : input.actorUserId;
    if (existing) {
        if (!issuedHere(existing)) {
            throw new ValidationError("This request was already used. Start a new gift card.");
        }
        return { giftCardId, code: await decryptGiftCardCode(keys, existing.codeCiphertext), created: false };
    }
    const built = await buildGiftCardIssueStatements(db, keys, {
        id: giftCardId,
        source: "manual",
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        expiresAt: input.expiresAt,
        customerId: input.customerId,
        recipient: input.recipient,
        message: input.message,
        note: input.note,
        issuedByUserId,
        idempotencyKey: issueKey,
        actor,
    });
    try {
        await safeBatch(db, [...built.statements, ...extraStatements(giftCardId)] as never);
    } catch (error) {
        // A concurrent retry of the same request won the insert.
        const winner = await readIssued();
        if (winner && issuedHere(winner)) {
            return { giftCardId, code: await decryptGiftCardCode(keys, winner.codeCiphertext), created: false };
        }
        throw error;
    }
    return { giftCardId, code: built.code, created: true };
}

// ─────────────────────────────────────────
// Store credit (refund as a new card)
// ─────────────────────────────────────────

/**
 * One new card (`source='refund'`) for a refund attempt's total, unique per
 * attempt (`gift_cards_refund_attempt_unique`), funded in the same batch. The
 * card id is derived from the attempt id, so a replay builds the same row and
 * the unique index turns a second issue into a failed batch the caller treats
 * as already done.
 */
export async function buildStoreCreditGiftCardStatements(
    db: Database,
    keys: GiftCardKeys,
    input: {
        refundAttemptId: string;
        amountMinor: number;
        currencyCode: string;
        orderId: string;
        customerId: string | null;
        recipient: GiftCardRecipient | null;
        expiresAt: number | null;
        actor: { type: "system" | "admin"; id: string | null };
    },
): Promise<{ giftCardId: string; statements: Statement[] }> {
    const giftCardId = await giftCardIdFromRequestKey("refund", input.refundAttemptId);
    const built = await buildGiftCardIssueStatements(db, keys, {
        id: giftCardId,
        source: "refund",
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        expiresAt: input.expiresAt,
        customerId: input.customerId,
        recipient: input.recipient,
        message: null,
        note: null,
        issuedByUserId: input.actor.type === "admin" ? input.actor.id : null,
        sourceOrderId: input.orderId,
        sourceRefundAttemptId: input.refundAttemptId,
        idempotencyKey: `issue:refund:${input.refundAttemptId}`,
        actor: input.actor,
    });
    return { giftCardId, statements: built.statements };
}

/** The store-credit card id a refund attempt issues (deterministic). */
export function storeCreditGiftCardId(refundAttemptId: string): Promise<string> {
    return giftCardIdFromRequestKey("refund", refundAttemptId);
}
