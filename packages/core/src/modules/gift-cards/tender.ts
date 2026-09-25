// Gift cards at checkout (Wave B §4.3): proving a code once (apply), the
// balance check, and turning the buyer's apply handles back into cards for
// the quote, cart validation and commit. The split itself is the shared pure
// `computeGiftCardTender`; this file only reads cards.
//
// Every failure a buyer can cause reads the same ("This gift card can't be
// used."): unknown, disabled, expired, empty and wrong-currency cards are
// indistinguishable to an enumerator.
import { eq, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { giftCards } from "@scalius/database/schema";
import { normalizeGiftCardCode } from "@scalius/shared/gift-card-code";
import {
    computeGiftCardTender,
    MAX_GIFT_CARDS_PER_ORDER,
    type GiftCardTender,
} from "@scalius/shared/gift-card-tender";
import { AppError } from "../../errors";
import { deriveGiftCardKeys, hashGiftCardCode, type GiftCardKeys } from "./crypto";
import { openGiftCardApplyHandle, sealGiftCardApplyHandle } from "./apply-handle";

export const GIFT_CARD_UNUSABLE_CODE = "GIFT_CARD_UNUSABLE";
export const GIFT_CARD_UNUSABLE_MESSAGE = "This gift card can't be used.";
export const GIFT_CARD_NOT_FOUND_CODE = "GIFT_CARD_NOT_FOUND";
export const GIFT_CARD_NOT_FOUND_MESSAGE = "We couldn't find a gift card with that code. Check it and try again.";
/** Cart issue / error code when a card changed between the quote and the order (§4.3). */
export const GIFT_CARD_CHANGED_CODE = "GIFT_CARD_CHANGED";
export const GIFT_CARD_CHANGED_MESSAGE = "Your gift card balance changed; review and place the order again.";

export class GiftCardUnusableError extends AppError {
    constructor() {
        super(400, GIFT_CARD_UNUSABLE_CODE, GIFT_CARD_UNUSABLE_MESSAGE);
        this.name = "GiftCardUnusableError";
    }
}

export class GiftCardNotFoundError extends AppError {
    constructor() {
        super(404, GIFT_CARD_NOT_FOUND_CODE, GIFT_CARD_NOT_FOUND_MESSAGE);
        this.name = "GiftCardNotFoundError";
    }
}

export class GiftCardChangedError extends AppError {
    constructor() {
        super(409, GIFT_CARD_CHANGED_CODE, GIFT_CARD_CHANGED_MESSAGE);
        this.name = "GiftCardChangedError";
    }
}

type GiftCardRow = typeof giftCards.$inferSelect;

export type GiftCardUsability = "usable" | "disabled" | "expired" | "empty" | "wrong_currency";

export function isGiftCardExpired(card: Pick<GiftCardRow, "expiresAt">, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    return card.expiresAt !== null && card.expiresAt <= nowSeconds;
}

/** Whether a card can pay right now (mirrors the redeem trigger guard, plus currency and balance). */
export function giftCardUsability(
    card: Pick<GiftCardRow, "status" | "expiresAt" | "balanceMinor" | "currencyCode">,
    currencyCode: string,
    nowSeconds = Math.floor(Date.now() / 1000),
): GiftCardUsability {
    if (card.status !== "active") return "disabled";
    if (isGiftCardExpired(card, nowSeconds)) return "expired";
    if (card.currencyCode !== currencyCode) return "wrong_currency";
    if (card.balanceMinor <= 0) return "empty";
    return "usable";
}

/** The card a typed code names (one indexed lookup by `code_hash`), or null. */
export async function findGiftCardByCode(db: Database, keys: GiftCardKeys, rawCode: unknown): Promise<GiftCardRow | null> {
    const code = normalizeGiftCardCode(rawCode);
    if (!code) return null;
    const codeHash = await hashGiftCardCode(keys, code);
    return await db.select().from(giftCards).where(eq(giftCards.codeHash, codeHash)).get() ?? null;
}

export interface AppliedGiftCard {
    handle: string;
    /** When the handle stops working (epoch seconds); not the card's own expiry. */
    handleExpiresAt: number;
    last4: string;
    balanceMinor: number;
    currencyCode: string;
    /** The card's own expiry (epoch seconds), or null. */
    expiresAt: number | null;
}

/**
 * `POST /checkout/gift-cards/apply`: proves the code and returns a sealed
 * handle. Any unusable card throws the one uniform `GiftCardUnusableError`.
 */
export async function applyGiftCardCode(
    db: Database,
    input: { code: unknown; currencyCode: string; credentialEncryptionKey: string | null | undefined; masterSecret: string },
): Promise<AppliedGiftCard> {
    const keys = await deriveGiftCardKeys(input.credentialEncryptionKey);
    const card = await findGiftCardByCode(db, keys, input.code);
    if (!card || giftCardUsability(card, input.currencyCode) !== "usable") throw new GiftCardUnusableError();
    const { handle, expiresAt } = await sealGiftCardApplyHandle(input.masterSecret, card.id);
    return {
        handle,
        handleExpiresAt: expiresAt,
        last4: card.codeLast4,
        balanceMinor: card.balanceMinor,
        currencyCode: card.currencyCode,
        expiresAt: card.expiresAt,
    };
}

export interface GiftCardBalance {
    last4: string;
    balanceMinor: number;
    currencyCode: string;
    expiresAt: number | null;
    status: "active" | "disabled" | "expired";
}

/** `POST /checkout/gift-cards/balance` and the balance page: facts of a known card, or `GiftCardNotFoundError`. */
export async function checkGiftCardBalance(
    db: Database,
    input: { code: unknown; credentialEncryptionKey: string | null | undefined },
): Promise<GiftCardBalance> {
    const keys = await deriveGiftCardKeys(input.credentialEncryptionKey);
    const card = await findGiftCardByCode(db, keys, input.code);
    if (!card) throw new GiftCardNotFoundError();
    return {
        last4: card.codeLast4,
        balanceMinor: card.balanceMinor,
        currencyCode: card.currencyCode,
        expiresAt: card.expiresAt,
        status: card.status !== "active" ? "disabled" : isGiftCardExpired(card) ? "expired" : "active",
    };
}

// ─────────────────────────────────────────
// Handles → cards (quote, cart validation, commit)
// ─────────────────────────────────────────

export interface GiftCardTenderInputCard {
    handle: string;
}

export interface ResolvedTenderCard {
    handle: string;
    giftCardId: string;
    last4: string;
    balanceMinor: number;
    expiresAt: number | null;
}

export interface GiftCardTenderResolution {
    /** Usable cards in the buyer's order. */
    cards: ResolvedTenderCard[];
    /** Handles that no longer name a usable card (expired handle, spent, disabled, expired card, currency). */
    unusableHandles: string[];
}

/**
 * Opens the buyer's handles (≤ 5, deduplicated by card) and reads the cards
 * in one query. Cards that cannot pay are reported, never applied.
 */
export async function resolveGiftCardTenderCards(
    db: Database,
    input: { handles: readonly string[]; masterSecret: string | null; currencyCode: string },
): Promise<GiftCardTenderResolution> {
    if (input.handles.length === 0) return { cards: [], unusableHandles: [] };
    if (!input.masterSecret) return { cards: [], unusableHandles: [...input.handles] };
    if (input.handles.length > MAX_GIFT_CARDS_PER_ORDER) {
        throw new AppError(400, "GIFT_CARD_LIMIT", `Use at most ${MAX_GIFT_CARDS_PER_ORDER} gift cards on one order.`);
    }
    const opened = await Promise.all(input.handles.map(async (handle) => ({
        handle,
        giftCardId: await openGiftCardApplyHandle(input.masterSecret!, handle),
    })));
    const ids = [...new Set(opened.map((entry) => entry.giftCardId).filter((id): id is string => id !== null))];
    const rows = ids.length > 0
        ? await db.select().from(giftCards).where(inArray(giftCards.id, ids)).all()
        : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const now = Math.floor(Date.now() / 1000);
    const cards: ResolvedTenderCard[] = [];
    const unusableHandles: string[] = [];
    const seen = new Set<string>();
    for (const entry of opened) {
        const card = entry.giftCardId ? byId.get(entry.giftCardId) : undefined;
        if (!card || giftCardUsability(card, input.currencyCode, now) !== "usable") {
            unusableHandles.push(entry.handle);
            continue;
        }
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        cards.push({
            handle: entry.handle,
            giftCardId: card.id,
            last4: card.codeLast4,
            balanceMinor: card.balanceMinor,
            expiresAt: card.expiresAt,
        });
    }
    return { cards, unusableHandles };
}

export interface GiftCardTenderQuote {
    tender: GiftCardTender;
    cards: ResolvedTenderCard[];
    unusableHandles: string[];
}

/**
 * The tender for an order total: resolves handles, then splits with the
 * shared pure rule (a gift card never pays for gift-card lines).
 */
export async function quoteGiftCardTender(
    db: Database,
    input: {
        handles: readonly string[];
        masterSecret: string | null;
        currencyCode: string;
        totalMinor: number;
        giftCardLineTotalMinor: number;
        depositPlan: boolean;
    },
): Promise<GiftCardTenderQuote> {
    const resolution = await resolveGiftCardTenderCards(db, input);
    const tender = computeGiftCardTender({
        totalMinor: input.totalMinor,
        giftCardLineTotalMinor: input.giftCardLineTotalMinor,
        cards: resolution.cards.map((card) => ({ id: card.giftCardId, balanceMinor: card.balanceMinor })),
        depositPlan: input.depositPlan,
    });
    return { tender, cards: resolution.cards, unusableHandles: resolution.unusableHandles };
}
