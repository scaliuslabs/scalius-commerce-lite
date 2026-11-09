// Payout reversals (0206): money an app takes back from one of its `paid`
// payouts through the payout's provider, such as a marketplace clawing back
// a seller's share after the buyer was refunded. A reversal is committed
// `pending` before its provider call, one row per (app, Idempotency-Key) with
// the request's hash: a repeat finds the row, a different request under the
// key is refused. Partial reversals are allowed; together the reversals that
// have not failed never take back more than the payout (the insert triggers
// hold it under any race). Only a provider-authenticated fact moves a
// reversal, forward only: pending → processing → reversed | failed, each move
// a compare-and-set on `version`.
import { and, eq, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import {
    payoutReversals,
    payouts,
    PAYOUT_REVERSALS_MAX,
    type PayoutReversal,
    type PayoutReversalStatus,
} from "@scalius/database/schema";
import { sha256Hex } from "@scalius/shared/hash";
import { AppError, NotFoundError } from "../../errors";
import { payoutFailureCode, payoutFailureMessage } from "./payouts";

export type { PayoutReversal, PayoutReversalStatus };
export { PAYOUT_REVERSALS_MAX };

export const PAYOUT_REVERSAL_REQUEST_MISMATCH_CODE = "payout_reversal_request_mismatch";
export const PAYOUT_NOT_REVERSIBLE_CODE = "payout_not_reversible";
export const PAYOUT_REVERSAL_EXCEEDS_PAYOUT_CODE = "payout_reversal_exceeds_payout";
export const PAYOUT_REVERSAL_CURRENCY_MISMATCH_CODE = "payout_reversal_currency_mismatch";

/** What an app asks to take back from one of its payouts. Money is integer minor units of `currency`. */
export interface PayoutReversalRequest {
    appId: string;
    payoutId: string;
    amountMinor: number;
    currency: string;
    reason: string | null;
    idempotencyKey: string;
}

/** A provider's fact about one reversal: its answer to `reversePayout`/`reversalStatus`, or a verified callback. */
export interface PayoutReversalAnswer {
    status: "processing" | "reversed" | "failed";
    providerRef?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
}

export function newPayoutReversalId(): string {
    return `pyr_${Date.now().toString(36).padStart(9, "0")}${nanoid(14)}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The fingerprint of what a key was first used for: everything but the key and the app. */
export function payoutReversalRequestDigest(request: PayoutReversalRequest): Promise<string> {
    return sha256Hex(JSON.stringify(["reversal", request.payoutId, request.amountMinor, request.currency, request.reason]));
}

/** The app's reversal under a key, or null; another request under the key is refused (409). */
export async function findPayoutReversalByKey(db: Database, request: PayoutReversalRequest): Promise<PayoutReversal | null> {
    const row = await db.select().from(payoutReversals)
        .where(and(eq(payoutReversals.appId, request.appId), eq(payoutReversals.idempotencyKey, request.idempotencyKey))).get();
    if (!row) return null;
    if (row.requestHash !== await payoutReversalRequestDigest(request)) {
        throw new AppError(409, PAYOUT_REVERSAL_REQUEST_MISMATCH_CODE,
            "This Idempotency-Key already reversed a different amount or payout. Use a new key for a new reversal.", { reversalId: row.id, payoutId: row.payoutId });
    }
    return row;
}

/** What a payout may still give back: its amount less its reversals that have not failed. */
export async function reversibleMinor(db: Database, payout: { id: string; amountMinor: number }): Promise<number> {
    const held = await db.select({ total: sql<number>`coalesce(sum(${payoutReversals.amountMinor}), 0)` })
        .from(payoutReversals)
        .where(and(eq(payoutReversals.payoutId, payout.id), ne(payoutReversals.status, "failed"))).get();
    return payout.amountMinor - Number(held?.total ?? 0);
}

function errorText(error: unknown): string {
    return error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
}

function exceeds(payoutId: string, reversible: number): AppError {
    return new AppError(409, PAYOUT_REVERSAL_EXCEEDS_PAYOUT_CODE,
        "The reversal takes back more than the payout has left to give back (details.reversibleMinor).",
        { payoutId, reversibleMinor: Math.max(0, reversible) });
}

function notReversible(payoutId: string, status: string): AppError {
    return new AppError(409, PAYOUT_NOT_REVERSIBLE_CODE, "Only a paid payout can be reversed.", { payoutId, status });
}

/**
 * Commits the reversal `pending` (before any provider call), or finds the one
 * the key already made: `created` says which. Refuses another app's payout
 * (404), a payout that is not `paid`, another currency, more than the payout
 * has left to give back, and a 21st reversal; the triggers refuse the same
 * under a race, and a concurrent request under the same key reads the winner.
 */
export async function recordPayoutReversal(db: Database, request: PayoutReversalRequest): Promise<{ reversal: PayoutReversal; created: boolean }> {
    const existing = await findPayoutReversalByKey(db, request);
    if (existing) return { reversal: existing, created: false };
    const payout = await db.select().from(payouts)
        .where(and(eq(payouts.id, request.payoutId), eq(payouts.appId, request.appId))).get();
    if (!payout) throw new NotFoundError("Payout not found");
    if (payout.currency !== request.currency) {
        throw new AppError(422, PAYOUT_REVERSAL_CURRENCY_MISMATCH_CODE,
            `A reversal is in the payout's currency (${payout.currency}).`, { payoutId: payout.id, currency: payout.currency });
    }
    if (payout.status !== "paid") throw notReversible(payout.id, payout.status);
    const count = await db.select({ n: sql<number>`count(*)` }).from(payoutReversals).where(eq(payoutReversals.payoutId, payout.id)).get();
    if (Number(count?.n ?? 0) >= PAYOUT_REVERSALS_MAX) {
        throw new AppError(409, PAYOUT_REVERSAL_EXCEEDS_PAYOUT_CODE,
            `A payout takes at most ${PAYOUT_REVERSALS_MAX} reversals.`, { payoutId: payout.id, reversibleMinor: Math.max(0, await reversibleMinor(db, payout)) });
    }
    const reversible = await reversibleMinor(db, payout);
    if (request.amountMinor > reversible) throw exceeds(payout.id, reversible);

    try {
        const inserted = await db.insert(payoutReversals).values({
            id: newPayoutReversalId(),
            payoutId: payout.id,
            appId: request.appId,
            providerId: payout.providerId,
            amountMinor: request.amountMinor,
            currency: request.currency,
            reason: request.reason,
            status: "pending",
            idempotencyKey: request.idempotencyKey,
            requestHash: await payoutReversalRequestDigest(request),
        }).onConflictDoNothing({ target: [payoutReversals.appId, payoutReversals.idempotencyKey] }).returning();
        if (inserted[0]) return { reversal: inserted[0], created: true };
    } catch (error) {
        // A concurrent request: the same key may have won (its row answers), else the triggers' refusal stands.
        const raced = await findPayoutReversalByKey(db, request);
        if (raced) return { reversal: raced, created: false };
        const text = errorText(error);
        if (text.includes("PAYOUT_REVERSAL_EXCEEDS_PAYOUT")) throw exceeds(payout.id, await reversibleMinor(db, payout));
        if (text.includes("PAYOUT_REVERSAL_NOT_PAID")) throw notReversible(payout.id, payout.status);
        throw error;
    }
    const winner = await findPayoutReversalByKey(db, request);
    if (!winner) throw new Error("A reversal under this key was neither inserted nor found.");
    return { reversal: winner, created: false };
}

const RANK: Record<PayoutReversalStatus, number> = { pending: 0, processing: 1, reversed: 2, failed: 2 };
const FINAL: ReadonlySet<PayoutReversalStatus> = new Set(["reversed", "failed"]);

type Skip = "stale" | "provider_ref_mismatch";

function skipReason(row: PayoutReversal, answer: PayoutReversalAnswer): Skip | null {
    if (row.providerRef && answer.providerRef && answer.providerRef !== row.providerRef) return "provider_ref_mismatch";
    if (FINAL.has(row.status)) return "stale";
    if (RANK[answer.status] < RANK[row.status]) return "stale";
    if (answer.status === row.status && (row.providerRef || !answer.providerRef)) return "stale";
    return null;
}

/**
 * Applies a provider's fact to a reversal, forward only, as a compare-and-set
 * on `version`. A fact about a final or further-on reversal, or naming
 * another provider reversal, changes nothing. `scope` keeps a caller to its
 * own reversals (the app, the provider).
 */
export async function applyPayoutReversalAnswer(
    db: Database,
    reversalId: string,
    answer: PayoutReversalAnswer,
    scope: { appId?: string; providerId?: string } = {},
): Promise<{ reversal: PayoutReversal; changed: boolean; skipped: Skip | null } | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const where = [eq(payoutReversals.id, reversalId)];
        if (scope.appId) where.push(eq(payoutReversals.appId, scope.appId));
        if (scope.providerId) where.push(eq(payoutReversals.providerId, scope.providerId));
        const row = await db.select().from(payoutReversals).where(and(...where)).get();
        if (!row) return null;
        const skipped = skipReason(row, answer);
        if (skipped) return { reversal: row, changed: false, skipped };
        const now = nowSeconds();
        const failed = answer.status === "failed";
        const updated = await db.update(payoutReversals).set({
            status: answer.status,
            providerRef: row.providerRef ?? answer.providerRef ?? null,
            failureCode: failed ? payoutFailureCode(answer.failureCode) : null,
            failureMessage: failed ? payoutFailureMessage(answer.failureMessage) : null,
            version: row.version + 1,
            updatedAt: now,
            settledAt: FINAL.has(answer.status) ? now : null,
        }).where(and(eq(payoutReversals.id, row.id), eq(payoutReversals.version, row.version))).returning();
        if (updated[0]) return { reversal: updated[0], changed: true, skipped: null };
    }
    throw new AppError(409, "conflict", "The reversal changed while it was being updated. Try again.");
}

/** A verified callback's update of a reversal, by the platform's reversal id or the provider's own reference. */
export interface PayoutReversalCallbackUpdate extends PayoutReversalAnswer {
    reversalId?: string;
    providerRef: string;
}

/** Applies one verified callback update of `providerId`: only that provider's reversals are reachable. */
export async function applyPayoutReversalCallback(
    db: Database,
    providerId: string,
    update: PayoutReversalCallbackUpdate,
): Promise<"applied" | "unchanged" | "unknown"> {
    let reversalId = update.reversalId ?? null;
    if (!reversalId) {
        const row = await db.select({ id: payoutReversals.id }).from(payoutReversals)
            .where(and(eq(payoutReversals.providerId, providerId), eq(payoutReversals.providerRef, update.providerRef))).get();
        reversalId = row?.id ?? null;
    }
    if (!reversalId) return "unknown";
    const applied = await applyPayoutReversalAnswer(db, reversalId, update, { providerId });
    if (!applied || applied.skipped === "provider_ref_mismatch") return "unknown";
    return applied.changed ? "applied" : "unchanged";
}
