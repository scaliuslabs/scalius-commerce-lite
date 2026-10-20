// App tax-provider documents (MARKETS-DESIGN D8), as durable commands:
//
//   order commit ──▶ commit (trigger on the app-provider tax snapshot)
//   cancelled    ──▶ void   (trigger on the order's status)       pending ─claim─▶ processing ─▶ done
//   refunded     ──▶ refund (trigger on the refund payment)              │                 ├─▶ failed (backoff, retried)
//                                                                        │                 ├─▶ skipped (operation not offered)
//                                                                        └── a void/refund waits for its commit ──▶ dead (gave up)
//
// Each row is written in the transaction that owes it (migration 0168), so a
// lost response, an evicted Worker or a buyer's replay cannot lose it. The id
// is the provider's idempotency key, so a retry after an uncertain answer
// asks once. Drained right after the write's response
// (`processTaxDocumentCommandsForOrder`) and by the scheduled sweep
// (`drainTaxDocumentCommands`). Failures keep only a short code: never a
// provider body or buyer data.
import type { Database } from "@scalius/database/client";
import { taxDocumentCommands, type TaxDocumentCommand } from "@scalius/database/schema";
import { ProviderError } from "@scalius/shared/plugins/providers";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { resolveAppProvider, type AppProviders } from "../../integrations/provider-port";

export type TaxDocumentOutcome = "done" | "failed" | "skipped" | "dead" | "deferred" | "busy";

const LEASE_SECONDS = 5 * 60;
const MAX_DRAIN_LIMIT = 25;
/** A command that keeps failing gives up after this many attempts (about 8 hours of backoff). */
export const TAX_DOCUMENT_MAX_ATTEMPTS = 12;
/** A void or refund whose commit is still owed looks again after this long. */
const WAIT_FOR_COMMIT_SECONDS = 60;
/** One provider call in the background: longer than checkout's two seconds, still bounded. */
const PROVIDER_DEADLINE_MS = 10_000;

const due = or(
    and(inArray(taxDocumentCommands.status, ["pending", "failed"]), lte(taxDocumentCommands.nextAttemptAt, sql`unixepoch()`)),
    and(eq(taxDocumentCommands.status, "processing"), lte(taxDocumentCommands.claimExpiresAt, sql`unixepoch()`)),
);

export interface TaxDocumentDrainResult {
    scanned: number;
    done: number;
    failed: number;
    skipped: number;
    dead: number;
    deferred: number;
    busy: number;
}

/** The scheduled pass: due commands, oldest first, at most `limit`. */
export async function drainTaxDocumentCommands(
    db: Database,
    apps: AppProviders | undefined,
    options: { limit: number },
): Promise<TaxDocumentDrainResult> {
    const rows = await db.select({ id: taxDocumentCommands.id })
        .from(taxDocumentCommands)
        .where(due)
        .orderBy(asc(taxDocumentCommands.nextAttemptAt))
        .limit(Math.max(1, Math.min(options.limit, MAX_DRAIN_LIMIT)));
    const result: TaxDocumentDrainResult = { scanned: rows.length, done: 0, failed: 0, skipped: 0, dead: 0, deferred: 0, busy: 0 };
    for (const row of rows) result[await processTaxDocumentCommand(db, row.id, apps)] += 1;
    return result;
}

/**
 * Right after a write that owes documents (the checkout commit): the order's
 * due commands, the commit first. One read when there are none.
 */
export async function processTaxDocumentCommandsForOrder(
    db: Database,
    orderId: string,
    apps: AppProviders | undefined,
): Promise<TaxDocumentOutcome[]> {
    const rows = await db.select({ id: taxDocumentCommands.id, operation: taxDocumentCommands.operation })
        .from(taxDocumentCommands)
        .where(and(eq(taxDocumentCommands.orderId, orderId), due));
    const ordered = [...rows].sort((left, right) => Number(right.operation === "commit") - Number(left.operation === "commit"));
    const outcomes: TaxDocumentOutcome[] = [];
    for (const row of ordered) outcomes.push(await processTaxDocumentCommand(db, row.id, apps));
    return outcomes;
}

type Attempt =
    | { outcome: "done"; documentId: string }
    | { outcome: "skipped" | "dead" | "failed"; error: string }
    | { outcome: "deferred"; error: string };

/** Claims one due command and attempts it; `busy` when another worker holds it or it is not due. */
export async function processTaxDocumentCommand(
    db: Database,
    commandId: string,
    apps: AppProviders | undefined,
): Promise<TaxDocumentOutcome> {
    const claimId = `taxc_${crypto.randomUUID().replace(/-/g, "")}`;
    const claim = db.update(taxDocumentCommands).set({
        status: "processing",
        claimId,
        claimExpiresAt: sql`unixepoch() + ${LEASE_SECONDS}`,
        attempts: sql`${taxDocumentCommands.attempts} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(taxDocumentCommands.id, commandId), due)).returning();
    // The order's commit, read with the claim: a void or refund follows it.
    const commit = db.select({ id: taxDocumentCommands.id, status: taxDocumentCommands.status })
        .from(taxDocumentCommands)
        .where(and(
            eq(taxDocumentCommands.operation, "commit"),
            sql`${taxDocumentCommands.orderId} = (SELECT ${taxDocumentCommands.orderId} FROM ${taxDocumentCommands} WHERE ${taxDocumentCommands.id} = ${commandId})`,
        ))
        .limit(1);
    const [claimed, commitRows] = await db.batch([claim, commit]);
    const row = claimed[0];
    if (!row) return "busy";
    let attempt: Attempt;
    try {
        attempt = await attemptCommand(row, commitRows[0]?.status ?? null, apps);
    } catch (error) {
        attempt = failureOf(error);
    }
    await settle(db, row, claimId, attempt);
    if (attempt.outcome !== "done" && attempt.outcome !== "deferred") {
        console.warn("[tax] document command not done", {
            operation: row.operation,
            provider: row.providerId,
            order: row.orderId.slice(0, 12),
            outcome: attempt.outcome,
            code: attempt.error,
        });
    }
    return attempt.outcome;
}

async function attemptCommand(
    row: TaxDocumentCommand,
    commitStatus: TaxDocumentCommand["status"] | null,
    apps: AppProviders | undefined,
): Promise<Attempt> {
    if (row.operation !== "commit" && commitStatus !== null && commitStatus !== "done") {
        // Nothing to reverse until the provider holds the document.
        if (commitStatus === "skipped") return { outcome: "skipped", error: "commit_skipped" };
        if (commitStatus === "dead") return { outcome: "dead", error: "commit_not_done" };
        return { outcome: "deferred", error: "awaiting_commit" };
    }
    const choice = await resolveAppProvider(apps, "tax", row.providerId);
    if (!choice.provider) return { outcome: "failed", error: "provider_unavailable" };
    const provider = choice.provider;
    const base = { calculationId: row.calculationId, orderId: row.orderId, idempotencyKey: row.id };
    const document = await withDeadline(async (signal) => {
        if (row.operation === "commit") return provider.commit ? provider.commit(base, { signal }) : null;
        if (row.operation === "void") return provider.void ? provider.void(base, { signal }) : null;
        return provider.refund
            ? provider.refund({ ...base, refundId: row.refundId!, amountMinor: row.amountMinor!, taxMinor: row.taxMinor! }, { signal })
            : null;
    });
    if (!document) return { outcome: "skipped", error: "not_supported" };
    return { outcome: "done", documentId: document.documentId };
}

function failureOf(error: unknown): Attempt {
    if (error instanceof ProviderError) {
        // Final for this input: asking again cannot change the answer.
        if (error.category === "declined") return { outcome: "dead", error: error.code };
        return { outcome: "failed", error: error.code };
    }
    return { outcome: "failed", error: error instanceof Error && error.name === "TaxDocumentDeadline" ? "provider.timeout" : "provider.error" };
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            run(controller.signal),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    const error = new Error("Tax provider deadline exceeded.");
                    error.name = "TaxDocumentDeadline";
                    reject(error);
                }, PROVIDER_DEADLINE_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function settle(db: Database, row: TaxDocumentCommand, claimId: string, attempt: Attempt): Promise<void> {
    const owned = and(eq(taxDocumentCommands.id, row.id), eq(taxDocumentCommands.claimId, claimId));
    const base = { claimId: null, claimExpiresAt: null, updatedAt: sql`unixepoch()` };
    if (attempt.outcome === "done") {
        await db.update(taxDocumentCommands)
            .set({ ...base, status: "done", documentId: attempt.documentId, lastError: null })
            .where(owned);
    } else if (attempt.outcome === "deferred") {
        // Waiting is not a failed attempt.
        await db.update(taxDocumentCommands).set({
            ...base, status: "pending", attempts: sql`${taxDocumentCommands.attempts} - 1`, lastError: attempt.error,
            nextAttemptAt: sql`unixepoch() + ${WAIT_FOR_COMMIT_SECONDS}`,
        }).where(owned);
    } else if (attempt.outcome === "skipped" || attempt.outcome === "dead") {
        await db.update(taxDocumentCommands).set({ ...base, status: attempt.outcome, lastError: attempt.error }).where(owned);
    } else if (row.attempts >= TAX_DOCUMENT_MAX_ATTEMPTS) {
        await db.update(taxDocumentCommands)
            .set({ ...base, status: "dead", lastError: `attempt_limit:${attempt.error}` })
            .where(owned);
    } else {
        await db.update(taxDocumentCommands).set({
            ...base, status: "failed", lastError: attempt.error,
            nextAttemptAt: sql`unixepoch() + ${retryDelaySeconds(row.attempts)}`,
        }).where(owned);
    }
}

function retryDelaySeconds(attempts: number): number {
    return Math.min(60 * 60, 60 * 2 ** (Math.max(1, Math.min(attempts, 8)) - 1));
}
