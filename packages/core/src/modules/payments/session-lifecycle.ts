// The lifetime of a provider payment session, bound to its order's hold: no
// session stays payable after the order it pays for is let go.
//
// - The hold clock counts from the buyer's last payment attempt, not from
//   the order: a session the buyer opened, retried or refreshed recently
//   keeps the order (`paymentHoldLiveCondition`). A session whose provider
//   reported the payment in progress (`processing`, a bank debit) keeps it
//   for at most `PROVIDER_PROCESSING_HOLD_SECONDS`.
// - When the hold ends, the stale-checkout sweep does not cancel an order
//   that still has an open provider session: in one batch, under the same
//   claim that would cancel it, it marks those sessions `cancelling`, a
//   durable command. The drain (`cancelDueSessions`) closes each through the
//   payment port's optional `cancelSession`; a provider without it, or one
//   that cannot stop a payment in flight, closes it locally. The next sweep
//   then cancels the order, releases its stock and archives it.
// - A provider that answers the session was already paid restores it: its
//   payment is applied to the still-open order like any other.
// - A new session for an order retires every other open one first
//   (`retireOpenSessions`), so two tabs cannot both pay.
// - Money a session still takes for a closed order is recorded and refunded
//   automatically (late-payment.ts).
import { and, asc, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { paymentSessionAttempts } from "@scalius/database/schema";
import { providerErrorOf } from "@scalius/shared/plugins/providers/kinds";
import { canOperateExistingPayments, type GatewaySettings, type PaymentEvent, type PaymentGateway } from "./gateways/port";
import { paymentProvidersFor, type PaymentProvidersSource } from "./gateways/registry";

/** The longest an order waits for a payment its provider reported in progress. */
export const PROVIDER_PROCESSING_HOLD_SECONDS = 14 * 24 * 60 * 60;
/** A session whose cancel the provider keeps failing is closed locally after this many tries. */
export const SESSION_CANCEL_MAX_TRIES = 10;
/** How long one provider cancel may take. */
const SESSION_CANCEL_DEADLINE_MS = 15_000;
const MAX_ERROR_LENGTH = 500;

/** A session a buyer's action wrote last: claimed, handed over, or failed at the provider. */
const BUYER_ACTIVITY_STATUSES = ["processing", "created", "failed"] as const;
/** A session handed to the buyer that can still take money. */
export const OPEN_SESSION_STATUSES = ["created", "provider_processing"] as const;
/** The durable "close this session at its provider" command. */
export const CANCELLING_SESSION_STATUS = "cancelling";
/** The provider is completing a payment on the session (`processing` event). */
export const PROVIDER_PROCESSING_STATUS = "provider_processing";

/** A session handed to a buyer (off-session commands share the table: `pcharge_`, `capture:`, `void:`). */
const hostedSession = sql`substr(${paymentSessionAttempts.attemptKey}, 1, 16) = 'payment_session:'`;

/**
 * The order's payment hold is still live: the buyer acted on a session after
 * `cutoffSeconds` (the hold's length before now), a provider reported a
 * payment in progress within its bound, or a session is being closed. The
 * order id is a SQL expression (the swept order's column).
 */
export function paymentHoldLiveCondition(orderId: SQL, cutoffSeconds: number, nowSeconds: number): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${paymentSessionAttempts}
        WHERE ${paymentSessionAttempts.orderId} = ${orderId}
          AND ${hostedSession}
          AND (
            (${paymentSessionAttempts.status} IN (${sql.join(BUYER_ACTIVITY_STATUSES.map((status) => sql`${status}`), sql`, `)})
              AND ${paymentSessionAttempts.updatedAt} > ${cutoffSeconds})
            OR (${paymentSessionAttempts.status} = ${PROVIDER_PROCESSING_STATUS}
              AND ${paymentSessionAttempts.updatedAt} > ${nowSeconds - PROVIDER_PROCESSING_HOLD_SECONDS})
            OR ${paymentSessionAttempts.status} = ${CANCELLING_SESSION_STATUS}
          )
    )`;
}

/** The order has a session handed to the buyer that its provider may still take money on. */
export function openProviderSessionCondition(orderId: SQL): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${paymentSessionAttempts}
        WHERE ${paymentSessionAttempts.orderId} = ${orderId}
          AND ${hostedSession}
          AND ${paymentSessionAttempts.status} IN (${sql.join(OPEN_SESSION_STATUSES.map((status) => sql`${status}`), sql`, `)})
          AND ${paymentSessionAttempts.providerSessionId} IS NOT NULL
    )`;
}

/**
 * The statement that turns the order's open provider sessions into durable
 * cancel commands, for the caller's own batch, only while `authority` holds
 * in that batch (the caller's claim). `except` keeps one session open.
 */
export function requestSessionCancelStatement(db: Database, orderId: string, authority: SQL, except?: string) {
    return db.update(paymentSessionAttempts).set({
        status: CANCELLING_SESSION_STATUS,
        // From here `attempts` counts the provider cancel tries.
        attempts: 0,
        claimId: null,
        claimExpiresAt: null,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(paymentSessionAttempts.orderId, orderId),
        inArray(paymentSessionAttempts.status, [...OPEN_SESSION_STATUSES]),
        isNotNull(paymentSessionAttempts.providerSessionId),
        hostedSession,
        except ? ne(paymentSessionAttempts.id, except) : undefined,
        authority,
    ));
}

/**
 * The provider reported a payment on this session in progress: the session
 * holds its order (bounded) and takes no new attempt meanwhile. Only a
 * session the platform handed out moves; false when the event names none.
 */
export async function markSessionProcessing(
    db: Database,
    event: { orderId: string; provider: string; providerRef: string; correlationId?: string | null },
): Promise<boolean> {
    const rows = await db.update(paymentSessionAttempts).set({
        status: PROVIDER_PROCESSING_STATUS,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(paymentSessionAttempts.orderId, event.orderId),
        eq(paymentSessionAttempts.gateway, event.provider),
        eq(paymentSessionAttempts.status, "created"),
        hostedSession,
        event.correlationId
            ? or(eq(paymentSessionAttempts.providerSessionId, event.providerRef), eq(paymentSessionAttempts.providerCorrelationId, event.correlationId))
            : eq(paymentSessionAttempts.providerSessionId, event.providerRef),
    )).returning({ id: paymentSessionAttempts.id });
    return rows.length > 0;
}

/** Whether a provider is still completing a payment for the order (within its bound). */
export async function hasProviderProcessingSession(db: Database, orderId: string): Promise<boolean> {
    const row = await db.select({ id: paymentSessionAttempts.id }).from(paymentSessionAttempts).where(and(
        eq(paymentSessionAttempts.orderId, orderId),
        eq(paymentSessionAttempts.status, PROVIDER_PROCESSING_STATUS),
        sql`${paymentSessionAttempts.updatedAt} > unixepoch() - ${PROVIDER_PROCESSING_HOLD_SECONDS}`,
    )).limit(1).get();
    return Boolean(row);
}

export interface SessionCloseDeps {
    providers: PaymentProvidersSource;
    encryptionKey: string | undefined;
    /** Applies a provider fact through the kernel (a session the buyer paid before it could be closed). */
    applyEvent?: (input: { provider: string; event: PaymentEvent; source: string }) => Promise<unknown>;
}

/** A cancel command is due: never tried, or its last try is older than its backoff (a minute per try). */
function dueCancelCondition(): SQL {
    return and(
        eq(paymentSessionAttempts.status, CANCELLING_SESSION_STATUS),
        sql`${paymentSessionAttempts.updatedAt} <= unixepoch() - 60 * ${paymentSessionAttempts.attempts}`,
    )!;
}

/** The drain's probe: one indexed row lookup with its list's own condition. */
export function dueSessionCancelProbes(db: Database) {
    return [db.select({ id: paymentSessionAttempts.id }).from(paymentSessionAttempts).where(dueCancelCondition()).limit(1)];
}

type CancelCommand = Pick<typeof paymentSessionAttempts.$inferSelect, "id" | "orderId" | "gateway" | "providerSessionId" | "attempts">;

export type SessionCloseOutcome = "closed" | "paid" | "open";

/** Ends a cancel command, while it still is one. */
async function finishCancel(db: Database, command: CancelCommand, status: "cancelled" | "created", lastError: string | null): Promise<boolean> {
    const rows = await db.update(paymentSessionAttempts).set({
        status,
        lastError: lastError?.slice(0, MAX_ERROR_LENGTH) ?? null,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(paymentSessionAttempts.id, command.id),
        eq(paymentSessionAttempts.status, CANCELLING_SESSION_STATUS),
    )).returning({ id: paymentSessionAttempts.id });
    return rows.length > 0;
}

/**
 * Close one session at its provider. `closed`: it can take no money (the
 * provider cancelled it, or cannot, and money it still takes is refunded as
 * a late payment). `paid`: the buyer paid it first; it is a live session
 * again and its payment is applied. `open`: the provider did not answer;
 * the next tick asks again, and after `SESSION_CANCEL_MAX_TRIES` it is
 * closed locally.
 */
export async function closeSession(db: Database, deps: SessionCloseDeps, command: CancelCommand): Promise<SessionCloseOutcome> {
    const providers = await paymentProvidersFor(deps.providers, command.gateway);
    const gateway = providers.get(command.gateway);
    const settings = gateway ? await gateway.loadSettings(db, deps.encryptionKey).catch(() => null) : null;
    if (!gateway?.cancelSession || !command.providerSessionId || !canOperateExistingPayments(gateway, settings)) {
        return await finishCancel(db, command, "cancelled",
            "The provider cannot close this session; money it still takes for the closed order is refunded.") ? "closed" : "open";
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), SESSION_CANCEL_DEADLINE_MS);
    try {
        const answer = await gateway.cancelSession({
            providerRef: command.providerSessionId,
            orderId: command.orderId,
            idempotencyKey: `cancel:${command.id}`,
            requestTimeoutMs: SESSION_CANCEL_DEADLINE_MS,
        }, { settings, signal: deadline.signal });
        if (answer.status === "paid") {
            if (!await finishCancel(db, command, "created", null)) return "open";
            await applyPaidSession(deps, gateway, settings, command);
            return "paid";
        }
        const note = answer.status === "not_cancellable"
            ? `The provider could not cancel this session (${answer.reason}); money it still takes for the closed order is refunded.`
            : null;
        return await finishCancel(db, command, "cancelled", note) ? "closed" : "open";
    } catch (error: unknown) {
        const message = providerErrorOf(error)?.message ?? (error instanceof Error ? error.message : String(error));
        if (command.attempts + 1 >= SESSION_CANCEL_MAX_TRIES) {
            return await finishCancel(db, command, "cancelled",
                `The provider did not confirm the cancel (${message}); money it still takes for the closed order is refunded.`) ? "closed" : "open";
        }
        await db.update(paymentSessionAttempts).set({
            attempts: sql`${paymentSessionAttempts.attempts} + 1`,
            lastError: message.slice(0, MAX_ERROR_LENGTH),
            updatedAt: sql`unixepoch()`,
        }).where(and(eq(paymentSessionAttempts.id, command.id), eq(paymentSessionAttempts.status, CANCELLING_SESSION_STATUS)));
        return "open";
    } finally {
        clearTimeout(timer);
    }
}

/** The buyer paid the session before it closed: apply its payment now (its webhook may follow; it is deduplicated). */
async function applyPaidSession(
    deps: SessionCloseDeps,
    gateway: PaymentGateway,
    settings: GatewaySettings,
    command: CancelCommand,
): Promise<void> {
    if (!deps.applyEvent || !gateway.queryPayment || !command.providerSessionId) return;
    try {
        const query = await gateway.queryPayment({
            providerRef: command.providerSessionId,
            orderId: command.orderId,
            requestTimeoutMs: SESSION_CANCEL_DEADLINE_MS,
        }, { settings, signal: new AbortController().signal });
        if (query.event) await deps.applyEvent({ provider: gateway.id, event: query.event, source: "session_cancel_paid" });
    } catch (error: unknown) {
        // Its webhook still brings the payment.
        console.warn("[payments] A paid session's payment could not be looked up; its webhook applies it:", error instanceof Error ? error.name : "error");
    }
}

/** The drain: due cancel commands, oldest first, each closed at its provider. */
export async function cancelDueSessions(db: Database, deps: SessionCloseDeps, limit: number): Promise<{ scanned: number; closed: number }> {
    const due = await db.select({
        id: paymentSessionAttempts.id,
        orderId: paymentSessionAttempts.orderId,
        gateway: paymentSessionAttempts.gateway,
        providerSessionId: paymentSessionAttempts.providerSessionId,
        attempts: paymentSessionAttempts.attempts,
    }).from(paymentSessionAttempts)
        .where(dueCancelCondition())
        .orderBy(asc(paymentSessionAttempts.updatedAt))
        .limit(Math.max(1, Math.min(limit, 100)))
        .all();
    let closed = 0;
    for (const command of due) {
        try {
            if (await closeSession(db, deps, command) !== "open") closed += 1;
        } catch (error: unknown) {
            console.warn("[payments] A payment session could not be closed; the next tick retries:", error instanceof Error ? error.name : "error");
        }
    }
    return { scanned: due.length, closed };
}

/**
 * Before a new session is handed out for an order: every other session of
 * the order the buyer could still pay becomes a cancel command (durably,
 * first), and each is closed now (a command left from earlier is the drain's). `paid` when the provider answered one was
 * already paid: the caller hands out no new session.
 */
export async function retireOpenSessions(
    db: Database,
    deps: SessionCloseDeps,
    input: { orderId: string; keepAttemptId: string },
): Promise<{ paid: boolean }> {
    // One statement: the sessions it turns into commands are the ones closed now.
    const commands = await requestSessionCancelStatement(db, input.orderId, sql`1 = 1`, input.keepAttemptId).returning({
        id: paymentSessionAttempts.id,
        orderId: paymentSessionAttempts.orderId,
        gateway: paymentSessionAttempts.gateway,
        providerSessionId: paymentSessionAttempts.providerSessionId,
        attempts: paymentSessionAttempts.attempts,
    });
    let paid = false;
    for (const command of commands) {
        try {
            if (await closeSession(db, deps, command) === "paid") paid = true;
        } catch (error: unknown) {
            // Left a command: the drain closes it.
            console.warn("[payments] A replaced payment session could not be closed now; the drain retries:", error instanceof Error ? error.name : "error");
        }
    }
    return { paid };
}
