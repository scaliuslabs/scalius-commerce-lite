// The lifetime of a provider payment session, bound to its order's hold: no
// session stays payable after the order it pays for is let go, and no session
// holds an order without a bound.
//
// Every state a hosted session can be in, every event that moves it, and how
// long each state may hold its order are written down once, in
// `SESSION_TRANSITIONS` and `SESSION_HOLD`; the writers below move a session
// only through `sessionTransition`, and session-lifecycle.test.ts checks the
// table exhaustively (every state against every event).
//
// - The hold counts from the buyer's last real payment attempt (a claim, not
//   a replay of a session already handed out), never past
//   `PAYMENT_HOLD_MAX_SECONDS` after the order was placed. A provider's
//   `processing` holds it for at most `PROVIDER_PROCESSING_HOLD_SECONDS` after
//   the session was opened.
// - When the hold ends, the stale-checkout sweep does not cancel an order
//   that still has a session the buyer could pay: in one batch, under the
//   same claim that would cancel it, those sessions become `cancelling`, a
//   durable command. The drain (`cancelDueSessions`) closes each through the
//   payment port's optional `cancelSession`. The order is archived only once
//   no session of it can take money.
// - A provider that answers the session was already paid, or that cannot
//   stop a payment in flight, moves it to `provider_processing`: the order
//   waits for its confirmation (bounded as above).
// - A new session for an order retires every other payable one first
//   (`retireOpenSessions`), so two tabs cannot both pay.
// - A provider's confirmed or failed event moves the session it names to
//   `paid` or `failed` in the batch that applies it.
// - Money a session still takes for a closed order is recorded and refunded
//   automatically (late-payment.ts).
import { and, asc, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { paymentSessionAttempts } from "@scalius/database/schema";
import { providerErrorOf } from "@scalius/shared/plugins/providers/kinds";
import { canOperateExistingPayments, type GatewaySettings, type PaymentEvent, type PaymentGateway } from "./gateways/port";
import { paymentProvidersFor, type PaymentProvidersSource } from "./gateways/registry";

/**
 * The longest an unpaid checkout holds its stock, however often the buyer
 * starts a new payment: three hours after the order was placed, three times
 * the one-hour hold. A buyer who retries a declined card or switches method
 * needs minutes; three hours leaves room for a slow bank app or a second
 * device, and an abandoned or abusive checkout still gives its stock back the
 * same day. A payment the provider is completing has its own bound below.
 */
export const PAYMENT_HOLD_MAX_SECONDS = 3 * 60 * 60;
/**
 * The longest an order waits for a payment its provider reported in progress
 * (a bank debit), counted from when the session was opened: the slowest
 * delayed methods settle within two weeks.
 */
export const PROVIDER_PROCESSING_HOLD_SECONDS = 14 * 24 * 60 * 60;
/** A session whose cancel the provider keeps failing is closed locally after this many tries. */
export const SESSION_CANCEL_MAX_TRIES = 10;
/** How long one provider cancel may take. */
const SESSION_CANCEL_DEADLINE_MS = 15_000;
const MAX_ERROR_LENGTH = 500;

/** Every state of a hosted payment session. */
export const SESSION_STATUSES = ["processing", "created", "failed", "provider_processing", "cancelling", "paid", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * How long each state may hold its order, and whether the provider may still
 * take money on it (a declined card at Stripe can be paid again on the same
 * session, so `failed` is payable).
 */
export const SESSION_HOLD: Record<SessionStatus, { holds: "lease" | "buyer_activity" | "provider_processing" | "until_closed" | "none"; payable: boolean }> = {
    /** A claim creating the session: its five-minute lease. */
    processing: { holds: "lease", payable: false },
    /** Handed to the buyer: the hold, from the buyer's last attempt, capped from the order's placing. */
    created: { holds: "buyer_activity", payable: true },
    failed: { holds: "buyer_activity", payable: true },
    /** The provider is completing a payment: capped from the session's opening. */
    provider_processing: { holds: "provider_processing", payable: true },
    /** Being closed at its provider: the drain closes it within `SESSION_CANCEL_MAX_TRIES` ticks. */
    cancelling: { holds: "until_closed", payable: true },
    paid: { holds: "none", payable: false },
    cancelled: { holds: "none", payable: false },
};

/**
 * What moves a session: the claim (`claim_*`, `handed_out`, `create_failed`:
 * payment-session-attempts.ts), the buyer's hosted return (`buyer_*`), the
 * provider's facts (`provider_*`), the hold ending (`hold_ended`), a newer
 * session (`replaced`, `superseded_unopened`) and the drain's close answers
 * (`close_*`). A new session is a new row (`openSessionValues`), never a
 * closed one reused: a slot (one link's attempt identity) whose last session
 * closed opens its next generation (payment-session-attempts.ts
 * `nextPaymentSessionSlot`), so a provider reference is never overwritten.
 */
export const SESSION_TRANSITIONS = {
    /** The same attempt asked again: one that never reached a provider session, or whose claim lapsed. */
    claim_retried: { from: ["failed", "processing"], to: "processing" },
    /** A lapsed claim another attempt took the order's single-flight slot from. */
    claim_superseded: { from: ["processing"], to: "failed" },
    /** A lapsed claim taken over, under the new attempt's identity. */
    claim_rekeyed: { from: ["processing"], to: "processing" },
    handed_out: { from: ["processing"], to: "created" },
    create_failed: { from: ["processing"], to: "failed" },
    buyer_returned_failed: { from: ["created"], to: "failed" },
    /** A session with no provider reference a gateway switch leaves behind. */
    superseded_unopened: { from: ["created"], to: "cancelled" },
    provider_processing: { from: ["created", "failed", "cancelling"], to: "provider_processing" },
    provider_confirmed: { from: ["processing", "created", "failed", "provider_processing", "cancelling"], to: "paid" },
    provider_failed: { from: ["processing", "created", "provider_processing", "cancelling"], to: "failed" },
    hold_ended: { from: ["created", "failed", "provider_processing"], to: "cancelling" },
    replaced: { from: ["created", "failed", "provider_processing"], to: "cancelling" },
    close_cancelled: { from: ["cancelling"], to: "cancelled" },
    /** The buyer paid it, or the provider cannot stop a payment in flight: wait for its confirmation (bounded). */
    close_in_flight: { from: ["cancelling"], to: "provider_processing" },
    /** No cancel at the provider, its bound passed, or it kept failing: closed locally; late money is refunded. */
    close_given_up: { from: ["cancelling"], to: "cancelled" },
} as const satisfies Record<string, { from: readonly SessionStatus[]; to: SessionStatus }>;
export type SessionEvent = keyof typeof SESSION_TRANSITIONS;

const statusList = (statuses: readonly string[]) => sql.join(statuses.map((status) => sql`${status}`), sql`, `);

/** A session handed to a buyer (off-session commands share the table: `pcharge_`, `capture:`, `void:`). */
const hostedSession = sql`substr(${paymentSessionAttempts.attemptKey}, 1, 16) = 'payment_session:'`;

/** The sessions of one order the provider may still take money on (and that it can be asked about). */
const PAYABLE_STATUSES = SESSION_STATUSES.filter((status) => SESSION_HOLD[status].payable);

/**
 * The one way a session moves: the update of `event` (its source states to
 * its target) over the hosted sessions `where` selects.
 */
export function sessionTransition(
    db: Database,
    event: SessionEvent,
    where: SQL | undefined,
    extra: { [K in Exclude<keyof typeof paymentSessionAttempts.$inferInsert, "status" | "id">]?: (typeof paymentSessionAttempts.$inferInsert)[K] | SQL } = {},
) {
    const transition = SESSION_TRANSITIONS[event];
    return db.update(paymentSessionAttempts).set({
        claimId: null,
        claimExpiresAt: null,
        ...(transition.to === "cancelling" ? { attempts: 0 } : {}),
        updatedAt: sql`unixepoch()`,
        ...extra,
        status: transition.to,
    }).where(and(
        hostedSession,
        inArray(paymentSessionAttempts.status, [...transition.from]),
        where,
    ));
}

/** A new session's row: the only insert of a hosted session, claimed `processing`. */
export function openSessionValues<T extends Record<string, unknown>>(values: T & { status?: never }): T & { status: "processing" } {
    return { ...values, status: "processing" };
}

/** The session a provider's fact names: its order, its gateway, and its reference or the merchant reference. */
export function sessionNamedBy(event: { orderId: string; provider: string; providerRef?: string | null; correlationId?: string | null }): SQL {
    const byRef = event.providerRef ? eq(paymentSessionAttempts.providerSessionId, event.providerRef) : undefined;
    const byCorrelation = event.correlationId ? eq(paymentSessionAttempts.providerCorrelationId, event.correlationId) : undefined;
    return and(
        eq(paymentSessionAttempts.orderId, event.orderId),
        eq(paymentSessionAttempts.gateway, event.provider),
        byRef && byCorrelation ? or(byRef, byCorrelation) : byRef ?? byCorrelation ?? sql`1 = 0`,
    )!;
}

/**
 * The order's payment hold is still live (`SESSION_HOLD`): a session holds
 * it by its lease, by the buyer's last real attempt after `cutoffSeconds`
 * (the hold's length before now) while the order is younger than
 * `PAYMENT_HOLD_MAX_SECONDS`, by a payment in flight within its bound, or by
 * being closed. Order id and creation time are the swept order's columns.
 */
export function paymentHoldLiveCondition(orderId: SQL, orderCreatedAt: SQL, cutoffSeconds: number, nowSeconds: number): SQL {
    const statuses = (holds: string) => statusList(SESSION_STATUSES.filter((status) => SESSION_HOLD[status].holds === holds));
    return sql`EXISTS (
        SELECT 1 FROM ${paymentSessionAttempts}
        WHERE ${paymentSessionAttempts.orderId} = ${orderId}
          AND ${hostedSession}
          AND (
            (${paymentSessionAttempts.status} IN (${statuses("lease")})
              AND ${paymentSessionAttempts.claimExpiresAt} > ${nowSeconds})
            OR (${paymentSessionAttempts.status} IN (${statuses("buyer_activity")})
              AND ${paymentSessionAttempts.updatedAt} > ${cutoffSeconds}
              AND ${orderCreatedAt} > ${nowSeconds - PAYMENT_HOLD_MAX_SECONDS})
            OR (${paymentSessionAttempts.status} IN (${statuses("provider_processing")})
              AND ${paymentSessionAttempts.createdAt} > ${nowSeconds - PROVIDER_PROCESSING_HOLD_SECONDS})
            OR ${paymentSessionAttempts.status} IN (${statuses("until_closed")})
          )
    )`;
}

/** The order has a session its provider may still take money on (it is closed before the order is let go). */
export function openProviderSessionCondition(orderId: SQL): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${paymentSessionAttempts}
        WHERE ${paymentSessionAttempts.orderId} = ${orderId}
          AND ${hostedSession}
          AND ${paymentSessionAttempts.status} IN (${statusList(PAYABLE_STATUSES)})
          AND ${paymentSessionAttempts.providerSessionId} IS NOT NULL
    )`;
}

/**
 * The statement that turns the order's payable sessions into durable cancel
 * commands (`hold_ended`, or `replaced` with `except` the new session), for
 * the caller's own batch, only while `authority` holds in that batch.
 */
export function requestSessionCancelStatement(db: Database, orderId: string, authority: SQL, except?: string) {
    return sessionTransition(db, except ? "replaced" : "hold_ended", and(
        eq(paymentSessionAttempts.orderId, orderId),
        isNotNull(paymentSessionAttempts.providerSessionId),
        except ? ne(paymentSessionAttempts.id, except) : undefined,
        authority,
    ));
}

/**
 * The provider reported a payment on this session in progress: the session
 * holds its order (bounded) and takes no new attempt meanwhile. False when
 * the event names no session the platform handed out.
 */
export async function markSessionProcessing(
    db: Database,
    event: { orderId: string; provider: string; providerRef: string; correlationId?: string | null },
): Promise<boolean> {
    const rows = await sessionTransition(db, "provider_processing", sessionNamedBy(event)).returning({ id: paymentSessionAttempts.id });
    return rows.length > 0;
}

/** Whether a provider is still completing a payment for the order (within its bound). */
export async function hasProviderProcessingSession(db: Database, orderId: string): Promise<boolean> {
    const row = await db.select({ id: paymentSessionAttempts.id }).from(paymentSessionAttempts).where(and(
        eq(paymentSessionAttempts.orderId, orderId),
        eq(paymentSessionAttempts.status, "provider_processing"),
        sql`${paymentSessionAttempts.createdAt} > unixepoch() - ${PROVIDER_PROCESSING_HOLD_SECONDS}`,
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
        eq(paymentSessionAttempts.status, "cancelling"),
        sql`${paymentSessionAttempts.updatedAt} <= unixepoch() - 60 * ${paymentSessionAttempts.attempts}`,
    )!;
}

/** The drain's probe: one indexed row lookup with its list's own condition. */
export function dueSessionCancelProbes(db: Database) {
    return [db.select({ id: paymentSessionAttempts.id }).from(paymentSessionAttempts).where(dueCancelCondition()).limit(1)];
}

type CancelCommand = Pick<typeof paymentSessionAttempts.$inferSelect, "id" | "orderId" | "gateway" | "providerSessionId" | "attempts" | "createdAt">;

/** The columns a cancel command is read with. */
const CANCEL_COMMAND_COLUMNS = {
    id: paymentSessionAttempts.id,
    orderId: paymentSessionAttempts.orderId,
    gateway: paymentSessionAttempts.gateway,
    providerSessionId: paymentSessionAttempts.providerSessionId,
    attempts: paymentSessionAttempts.attempts,
    createdAt: paymentSessionAttempts.createdAt,
};

/**
 * `closed`: it can take no money now (or never will through us: late money
 * is refunded). `in_flight`: the buyer paid it, or the provider is
 * completing a payment on it: the order waits for that payment.
 * `open`: the provider did not answer; asked again next tick.
 */
export type SessionCloseOutcome = "closed" | "in_flight" | "open";

/** Ends a cancel command through the table, while it still is one. */
async function finishCancel(db: Database, command: CancelCommand, event: "close_cancelled" | "close_in_flight" | "close_given_up", lastError: string | null): Promise<boolean> {
    const rows = await sessionTransition(db, event, eq(paymentSessionAttempts.id, command.id), {
        lastError: lastError?.slice(0, MAX_ERROR_LENGTH) ?? null,
    }).returning({ id: paymentSessionAttempts.id });
    return rows.length > 0;
}

/** A payment in flight on this session may still be waited for (`PROVIDER_PROCESSING_HOLD_SECONDS` from its opening). */
function withinProcessingBound(command: CancelCommand): boolean {
    return Number(command.createdAt) > Math.floor(Date.now() / 1000) - PROVIDER_PROCESSING_HOLD_SECONDS;
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
        return await finishCancel(db, command, "close_given_up",
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
        if (answer.status === "cancelled") return await finishCancel(db, command, "close_cancelled", null) ? "closed" : "open";
        // Paid, or a payment the provider is still completing: the order waits for it, within its bound.
        if (withinProcessingBound(command)) {
            const note = answer.status === "not_cancellable" ? `The provider is completing a payment on this session (${answer.reason}).` : null;
            if (!await finishCancel(db, command, "close_in_flight", note)) return "open";
            if (answer.status === "paid") await applyPaidSession(deps, gateway, settings, command);
            return "in_flight";
        }
        return await finishCancel(db, command, "close_given_up",
            "The provider is still completing a payment past its bound; money it takes for the closed order is refunded.") ? "closed" : "open";
    } catch (error: unknown) {
        const message = providerErrorOf(error)?.message ?? (error instanceof Error ? error.message : String(error));
        if (command.attempts + 1 >= SESSION_CANCEL_MAX_TRIES) {
            return await finishCancel(db, command, "close_given_up",
                `The provider did not confirm the cancel (${message}); money it still takes for the closed order is refunded.`) ? "closed" : "open";
        }
        await db.update(paymentSessionAttempts).set({
            attempts: sql`${paymentSessionAttempts.attempts} + 1`,
            lastError: message.slice(0, MAX_ERROR_LENGTH),
            updatedAt: sql`unixepoch()`,
        }).where(and(eq(paymentSessionAttempts.id, command.id), eq(paymentSessionAttempts.status, "cancelling")));
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
    const due = await db.select(CANCEL_COMMAND_COLUMNS).from(paymentSessionAttempts)
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
 * first), and each is closed now (a command left from earlier is the drain's).
 * `paid` when the provider answered one was already paid or is completing a
 * payment on it: the caller hands out no new session.
 */
export async function retireOpenSessions(
    db: Database,
    deps: SessionCloseDeps,
    input: { orderId: string; keepAttemptId: string },
): Promise<{ paid: boolean }> {
    // One statement: the sessions it turns into commands are the ones closed now.
    const commands = await requestSessionCancelStatement(db, input.orderId, sql`1 = 1`, input.keepAttemptId).returning(CANCEL_COMMAND_COLUMNS);
    let paid = false;
    for (const command of commands) {
        try {
            if (await closeSession(db, deps, command) === "in_flight") paid = true;
        } catch (error: unknown) {
            // Left a command: the drain closes it.
            console.warn("[payments] A replaced payment session could not be closed now; the drain retries:", error instanceof Error ? error.name : "error");
        }
    }
    return { paid };
}
