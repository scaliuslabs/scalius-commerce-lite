// The payout record (0202): money an app sends to a payee through a payout
// provider. A payout is committed `pending` before its provider call, one row
// per (app, Idempotency-Key): a repeat finds the row, a different request
// under the key is refused. Only a provider-authenticated fact moves it (the
// answer to the platform's own call, a verified callback), forward only:
// pending → processing → paid | failed, each move a compare-and-set on
// `version`. The triggers refuse anything else.
import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { payoutReversals, payouts, type Payout, type PayoutReversal, type PayoutStatus } from "@scalius/database/schema";
import { buildEventRepresentation, type EventRepresentation } from "@scalius/shared/events";
import { sha256Hex } from "@scalius/shared/hash";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import { replaceEmailAddresses } from "@scalius/shared/text-scan";
import { AppError } from "../../errors";

export const PAYOUT_REQUEST_MISMATCH_CODE = "payout_request_mismatch";
/** The most payouts one list page reads. */
export const PAYOUT_LIST_MAX = 50;

export type { Payout, PayoutStatus };

/** What an app asks to send. Money is integer minor units of `currency`. */
export interface PayoutRequest {
    appId: string;
    providerId: string;
    payeeRef: string;
    payeeAccountRef: string | null;
    amountMinor: number;
    currency: string;
    description: string | null;
    idempotencyKey: string;
}

/** A provider's fact about one payout: its answer to `createPayout`/`payoutStatus`, or a verified callback. */
export interface PayoutAnswer {
    status: "processing" | "paid" | "failed";
    providerRef?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
}

export function newPayoutId(): string {
    return `pyt_${Date.now().toString(36).padStart(9, "0")}${nanoid(14)}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The fingerprint of what a key was first used for: everything but the key and the app. */
export function payoutRequestDigest(request: PayoutRequest): Promise<string> {
    return sha256Hex(JSON.stringify([
        request.providerId,
        request.payeeRef,
        request.payeeAccountRef,
        request.amountMinor,
        request.currency,
        request.description,
    ]));
}

function mismatch(payoutId: string): AppError {
    return new AppError(409, PAYOUT_REQUEST_MISMATCH_CODE,
        "This Idempotency-Key already sent a different payout. Use a new key for a new payout.", { payoutId });
}

/** The app's payout under a key, or null; another request under the key is refused (409 `payout_request_mismatch`). */
export async function findPayoutByKey(db: Database, request: PayoutRequest): Promise<Payout | null> {
    const row = await db.select().from(payouts)
        .where(and(eq(payouts.appId, request.appId), eq(payouts.idempotencyKey, request.idempotencyKey))).get();
    if (!row) return null;
    if (row.requestHash !== await payoutRequestDigest(request)) throw mismatch(row.id);
    return row;
}

/**
 * Commits the payout `pending` (before any provider call), or finds the one
 * the key already made: `created` says which. A concurrent request under the
 * same key inserts nothing (the unique (app, key) index) and reads the winner.
 */
export async function recordPayout(db: Database, request: PayoutRequest): Promise<{ payout: Payout; created: boolean }> {
    const requestHash = await payoutRequestDigest(request);
    const inserted = await db.insert(payouts).values({
        id: newPayoutId(),
        appId: request.appId,
        providerId: request.providerId,
        payeeRef: request.payeeRef,
        payeeAccountRef: request.payeeAccountRef,
        amountMinor: request.amountMinor,
        currency: request.currency,
        description: request.description,
        status: "pending",
        idempotencyKey: request.idempotencyKey,
        requestHash,
    }).onConflictDoNothing({ target: [payouts.appId, payouts.idempotencyKey] }).returning();
    if (inserted[0]) return { payout: inserted[0], created: true };
    const existing = await findPayoutByKey(db, request);
    if (!existing) throw new Error("A payout under this key was neither inserted nor found.");
    return { payout: existing, created: false };
}

const RANK: Record<PayoutStatus, number> = { pending: 0, processing: 1, paid: 2, failed: 2 };
const FINAL: ReadonlySet<PayoutStatus> = new Set(["paid", "failed"]);

/** A failure code the record keeps: lower_snake (dots and dashes allowed), 64 characters at most. */
export function payoutFailureCode(code: string | null | undefined): string {
    const cleaned = (code ?? "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 64);
    return cleaned || "payout_failed";
}

/** A provider's reason as the record keeps it: no e-mail address, phone number or credential, 300 characters at most. */
export function payoutFailureMessage(message: string | null | undefined): string | null {
    const cleaned = replaceEmailAddresses(message ?? "")
        .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
        .replace(/((?:bearer|token|api[_ -]?key|secret|password))\s*[:=]?\s*[^\s,;]+/gi, "$1 [redacted]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    return cleaned || null;
}

/** Why an answer moves nothing: the payout is final or further on, or the answer names another provider payout. */
type Skip = "stale" | "provider_ref_mismatch";

function skipReason(row: Payout, answer: PayoutAnswer): Skip | null {
    if (row.providerRef && answer.providerRef && answer.providerRef !== row.providerRef) return "provider_ref_mismatch";
    if (FINAL.has(row.status)) return "stale";
    if (RANK[answer.status] < RANK[row.status]) return "stale";
    if (answer.status === row.status && (row.providerRef || !answer.providerRef)) return "stale";
    return null;
}

/**
 * Applies a provider's fact to a payout, forward only, as a compare-and-set
 * on `version` (a lost race reads the row again). A fact about a final or
 * further-on payout, or naming another provider payout, changes nothing.
 * `scope` keeps a caller to its own payouts (the app, the provider).
 */
export async function applyPayoutAnswer(
    db: Database,
    payoutId: string,
    answer: PayoutAnswer,
    scope: { appId?: string; providerId?: string } = {},
): Promise<{ payout: Payout; changed: boolean; skipped: Skip | null } | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const where = [eq(payouts.id, payoutId)];
        if (scope.appId) where.push(eq(payouts.appId, scope.appId));
        if (scope.providerId) where.push(eq(payouts.providerId, scope.providerId));
        const row = await db.select().from(payouts).where(and(...where)).get();
        if (!row) return null;
        const skipped = skipReason(row, answer);
        if (skipped) return { payout: row, changed: false, skipped };
        const now = nowSeconds();
        const failed = answer.status === "failed";
        const updated = await db.update(payouts).set({
            status: answer.status,
            providerRef: row.providerRef ?? answer.providerRef ?? null,
            failureCode: failed ? payoutFailureCode(answer.failureCode) : null,
            failureMessage: failed ? payoutFailureMessage(answer.failureMessage) : null,
            version: row.version + 1,
            updatedAt: now,
            settledAt: FINAL.has(answer.status) ? now : null,
        }).where(and(eq(payouts.id, row.id), eq(payouts.version, row.version))).returning();
        if (updated[0]) return { payout: updated[0], changed: true, skipped: null };
    }
    throw new AppError(409, "conflict", "The payout changed while it was being updated. Try again.");
}

/** A verified callback's update, by the platform's payout id or the provider's own reference. */
export interface PayoutCallbackUpdate extends PayoutAnswer {
    payoutId?: string;
    providerRef: string;
}

/**
 * Applies one verified callback update of `providerId`: only that provider's
 * payouts are reachable. An unknown payout is ignored, a duplicate or stale
 * one changes nothing.
 */
export async function applyPayoutCallback(
    db: Database,
    providerId: string,
    update: PayoutCallbackUpdate,
): Promise<"applied" | "unchanged" | "unknown"> {
    let payoutId = update.payoutId ?? null;
    if (!payoutId) {
        const row = await db.select({ id: payouts.id }).from(payouts)
            .where(and(eq(payouts.providerId, providerId), eq(payouts.providerRef, update.providerRef))).get();
        payoutId = row?.id ?? null;
    }
    if (!payoutId) return "unknown";
    const applied = await applyPayoutAnswer(db, payoutId, update, { providerId });
    if (!applied || applied.skipped === "provider_ref_mismatch") return "unknown";
    return applied.changed ? "applied" : "unchanged";
}

/** One of the app's own payouts; another app's reads as missing. */
export function getAppPayout(db: Database, appId: string, payoutId: string): Promise<Payout | undefined> {
    return db.select().from(payouts).where(and(eq(payouts.id, payoutId), eq(payouts.appId, appId))).get();
}

/** The app's payouts in (updatedAt, id) order: `after` is the keyset past a cursor. */
export function listAppPayouts(db: Database, options: {
    appId: string;
    status?: PayoutStatus;
    updatedSinceSeconds?: number;
    after?: SQL;
    limit: number;
}): Promise<Payout[]> {
    const where: SQL[] = [eq(payouts.appId, options.appId)];
    if (options.status) where.push(eq(payouts.status, options.status));
    if (options.updatedSinceSeconds !== undefined) where.push(gte(payouts.updatedAt, options.updatedSinceSeconds));
    if (options.after) where.push(options.after);
    return db.select().from(payouts).where(and(...where))
        .orderBy(asc(payouts.updatedAt), asc(payouts.id))
        .limit(Math.min(Math.max(options.limit, 1), PAYOUT_LIST_MAX + 1)).all();
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The reversals of some payouts, oldest first, by payout (ids bound as one JSON value). */
export async function readPayoutReversals(db: Database, payoutIds: readonly string[]): Promise<Map<string, PayoutReversal[]>> {
    const byPayout = new Map<string, PayoutReversal[]>();
    if (payoutIds.length === 0) return byPayout;
    const rows = await db.select().from(payoutReversals)
        .where(sql`${payoutReversals.payoutId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...new Set(payoutIds)])}))`)
        .orderBy(asc(payoutReversals.payoutId), asc(payoutReversals.createdAt), asc(payoutReversals.id)).all();
    for (const row of rows) byPayout.set(row.payoutId, [...(byPayout.get(row.payoutId) ?? []), row]);
    return byPayout;
}

/**
 * The sealed `payout` representation (what `payouts.get` answers and a
 * webhook carries), with its reversals oldest first: `reversedMinor` is what
 * they took back (those `reversed`).
 */
export function payoutRepresentation(row: Payout, reversals: readonly PayoutReversal[] = []): EventRepresentation<"payout"> {
    return buildEventRepresentation("payout", {
        id: row.id,
        appId: row.appId,
        providerId: row.providerId,
        payeeRef: row.payeeRef,
        payeeAccountRef: row.payeeAccountRef,
        amountMinor: row.amountMinor,
        currency: row.currency,
        description: row.description,
        status: row.status,
        providerRef: row.providerRef,
        failureCode: row.failureCode,
        failureMessage: row.failureMessage,
        reversedMinor: reversals.reduce((total, reversal) => total + (reversal.status === "reversed" ? reversal.amountMinor : 0), 0),
        reversals: reversals.map((reversal) => ({
            id: reversal.id,
            amountMinor: reversal.amountMinor,
            currency: reversal.currency,
            reason: reversal.reason,
            status: reversal.status,
            providerRef: reversal.providerRef,
            failureCode: reversal.failureCode,
            failureMessage: reversal.failureMessage,
            createdAt: iso(reversal.createdAt),
            updatedAt: iso(reversal.updatedAt),
            settledAt: reversal.settledAt === null ? null : iso(reversal.settledAt),
        })),
        revision: row.version,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        settledAt: row.settledAt === null ? null : iso(row.settledAt),
    }, allProtectedData());
}

/** The representations of some payouts, in the order given: their reversals in one read. */
export async function payoutRepresentations(db: Database, rows: readonly Payout[]): Promise<Array<EventRepresentation<"payout">>> {
    const reversals = await readPayoutReversals(db, rows.map((row) => row.id));
    return rows.map((row) => payoutRepresentation(row, reversals.get(row.id) ?? []));
}

/** A payout's representation by id (any app's: the event drain routes each delivery to its own app). */
export async function readPayoutRepresentation(db: Database, payoutId: string): Promise<EventRepresentation<"payout"> | null> {
    const row = await db.select().from(payouts).where(eq(payouts.id, payoutId)).get();
    return row ? (await payoutRepresentations(db, [row]))[0]! : null;
}
