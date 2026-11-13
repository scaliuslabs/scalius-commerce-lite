// Disputes (chargebacks): a buyer asks their bank to take back a captured
// payment. A dispute is a fact about one `order_payments` row, kept as one
// `payment_disputes` row per provider dispute and moved only through
// `DISPUTE_TRANSITIONS` (disputes.test.ts checks the table exhaustively,
// every state against every event):
//
// - `status`: needs_response -> under_review -> won | lost. Won and lost are
//   final: a late `updated` never reopens a closed dispute.
// - `funds`, the store's money: held -> withdrawn -> reinstated. A withdrawal
//   takes the disputed amount off what the order was paid (payment-state.ts
//   sums it beside the payment rows, so every reader agrees); a reinstatement
//   gives it back; a lost dispute keeps it withdrawn for good. A dispute fee
//   is recorded as information, never as buyer money.
//
// A provider reports its whole current view of a dispute with every event
// (`paymentDisputeSchema`), and each view is applied as the events it implies
// over the row's state as read: an event applied twice, or one arriving
// before an earlier one, changes nothing it should not. The row, its
// transitions, the order's new money (under the same ledger CAS every money
// writer uses), the timeline line and the staff notice commit in one guarded
// batch; a stale read retries. Nothing touches stock or fulfilment: a lost
// dispute on an unfulfilled order is shown to staff, who decide.
//
// A gateway with no dispute events (cash on delivery, bank transfer, the
// regional wallets) has its chargebacks recorded by hand through the same
// rows and transitions, with the staff member recorded.
import { orderEventData } from "../../utils/agent-attribution";
import { and, asc, desc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { notificationOutbox, orderEvents, orderPayments, orders, paymentDisputes, PaymentRecordStatus, refundAttempts, webhookEvents } from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { sha256Hex } from "@scalius/shared/hash";
import { fromMinor } from "@scalius/shared/money";
import { PAYMENT_DISPUTE_STATUSES, type PaymentDispute, type PaymentDisputeStatus } from "@scalius/shared/plugins/providers";
import {
    assertNoActiveRefundAttempt,
    findActiveRefundAttempt,
    assertNoActiveShipmentClaim,
    noActiveRefundAttemptForOrderIdCondition,
    noActiveShipmentClaimCondition,
    shipmentClaimShipmentStatusSql,
} from "../order-kernel";
import { createNotificationOutboxInsertValues } from "../notifications";
import { inJsonArray } from "../../utils/in-json-array";
import { gatewayHasCapability, type PaymentEvent } from "./gateways/port";
import { paymentProvidersFor, type PaymentProvidersSource } from "./gateways/registry";
import { deriveOrderPaymentState, ledgerTotalsCondition, paymentLedgerTotalsSql, type PaymentLedgerTotals } from "./payment-state";

type SQLiteBatchItem = BatchItem<"sqlite">;

export const DISPUTE_STATUSES = PAYMENT_DISPUTE_STATUSES;
export type DisputeStatus = PaymentDisputeStatus;
/** A dispute the merchant may still answer or the bank still decides: refunds drawing on its payment wait. */
export const OPEN_DISPUTE_STATUSES = ["needs_response", "under_review"] as const satisfies readonly DisputeStatus[];
export const DISPUTE_FUNDS = ["held", "withdrawn", "reinstated"] as const;
export type DisputeFunds = (typeof DISPUTE_FUNDS)[number];

/**
 * What moves a dispute: each event moves one column from its source states
 * to its target. An event whose source does not hold is a no-op (applied
 * already, or overtaken by a later fact).
 */
export const DISPUTE_TRANSITIONS = {
    /** The merchant answered; the bank decides. */
    response_submitted: { column: "status", from: ["needs_response"], to: "under_review" },
    won: { column: "status", from: ["needs_response", "under_review"], to: "won" },
    lost: { column: "status", from: ["needs_response", "under_review"], to: "lost" },
    /** The provider took the disputed amount from the merchant. */
    funds_withdrawn: { column: "funds", from: ["held"], to: "withdrawn" },
    /**
     * It gave it back. From `held` too: a reinstatement that arrives before
     * its withdrawal leaves nothing for the withdrawal to take.
     */
    funds_reinstated: { column: "funds", from: ["held", "withdrawn"], to: "reinstated" },
} as const satisfies Record<string, { column: "status"; from: readonly DisputeStatus[]; to: DisputeStatus } | { column: "funds"; from: readonly DisputeFunds[]; to: DisputeFunds }>;
export type DisputeEvent = keyof typeof DISPUTE_TRANSITIONS;

export interface DisputeState {
    status: DisputeStatus;
    funds: DisputeFunds;
}

/** A new dispute's state, before its first fact's events. */
export const NEW_DISPUTE_STATE: DisputeState = { status: "needs_response", funds: "held" };

/** One event over a state (the pure form of `disputeTransition`). */
export function nextDisputeState(state: DisputeState, event: DisputeEvent): DisputeState {
    const transition = DISPUTE_TRANSITIONS[event];
    if (transition.column === "status") {
        return (transition.from as readonly string[]).includes(state.status) ? { ...state, status: transition.to } : state;
    }
    return (transition.from as readonly string[]).includes(state.funds) ? { ...state, funds: transition.to } : state;
}

/** The facts of a dispute as the platform applies them: the port's view, or a staff member's record. */
export interface DisputeFacts {
    status: DisputeStatus;
    fundsWithdrawn: boolean;
    fundsReinstated: boolean;
}

/**
 * The events a provider's whole view implies, in the order they apply: the
 * money first (a lost dispute's money is withdrawn whether or not its
 * withdrawal was reported), then where the dispute stands.
 */
export function disputeEventsOf(facts: DisputeFacts): DisputeEvent[] {
    const events: DisputeEvent[] = [];
    if (facts.fundsWithdrawn || facts.status === "lost") events.push("funds_withdrawn");
    if (facts.fundsReinstated) events.push("funds_reinstated");
    if (facts.status === "under_review") events.push("response_submitted");
    if (facts.status === "won") events.push("won");
    if (facts.status === "lost") events.push("lost");
    return events;
}

/** The one way a dispute row moves: the update of `event` on the row `id`, from its source states only. */
export function disputeTransition(db: Database, event: DisputeEvent, id: string) {
    const transition = DISPUTE_TRANSITIONS[event];
    const closes = transition.to === "won" || transition.to === "lost";
    const column = transition.column === "status" ? paymentDisputes.status : paymentDisputes.funds;
    return db.update(paymentDisputes).set({
        [transition.column]: transition.to,
        updatedAt: sql`unixepoch()`,
        ...(closes ? { closedAt: sql`unixepoch()` } : {}),
    }).where(and(eq(paymentDisputes.id, id), inArray(column, [...transition.from])));
}

/**
 * The `result.reason` of a provider's dispute event waiting for a refund on
 * its order to settle (apps/api utils/webhook-idempotency.ts parks it, with
 * the disputed payment's id as `result.paymentId`). The bank's dispute is
 * real meanwhile: the payment refunds nothing until the event is applied
 * (`orderDisputeLedgerRead`), and the refund's settling makes the event due
 * at once (0220's `refund_attempts_settled_requeue_disputes` trigger).
 */
export const REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT = "refund_in_flight";

/**
 * A dispute event parked behind a refund on `orderId` (its order index),
 * naming its payment: waiting (`retrying`), or claimed by the drain and not
 * recorded yet (`processing` keeps the parked reason until its outcome is
 * written; a crashed worker's claim lasts its whole lease). `applyDispute`
 * never reads this, so the event never blocks its own recording.
 */
function parkedDisputeEventCondition(orderId: string): SQL {
    return sql`${webhookEvents.orderId} = ${orderId}
        AND ${webhookEvents.status} IN ('retrying', 'processing')
        AND json_extract(${webhookEvents.result}, '$.reason') = ${REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT}
        AND json_extract(${webhookEvents.result}, '$.paymentId') IS NOT NULL`;
}

/** A dispute event on one of these payments of the order waits for a refund to settle: refunds on them wait too. */
export function parkedDisputeOnPaymentsSql(orderId: string, paymentIds: readonly string[]): SQL {
    return sql`EXISTS (SELECT 1 FROM ${webhookEvents} WHERE ${parkedDisputeEventCondition(orderId)}
        AND ${inJsonArray(sql`json_extract(${webhookEvents.result}, '$.paymentId')`, paymentIds)})`;
}

/**
 * The disputes of one order as the ledger reads them (refunds, their
 * finalization, the gift-card bound): its dispute rows, and each provider
 * dispute event still waiting for a refund on the order to settle, as a
 * dispute open on its payment with its funds held and nothing counted yet.
 * A refund never draws on a payment the bank is disputing, recorded or not;
 * what was paid, refunded and lost is moved only by the rows.
 */
export function orderDisputeLedgerRead(db: Database, orderId: string) {
    return db.select({
        paymentId: paymentDisputes.paymentId,
        status: sql<DisputeStatus>`${paymentDisputes.status}`,
        funds: sql<DisputeFunds>`${paymentDisputes.funds}`,
        amountMinor: sql<number>`${paymentDisputes.amountMinor}`.mapWith(Number),
        countedMinor: sql<number>`${paymentDisputes.countedMinor}`.mapWith(Number),
    }).from(paymentDisputes).where(eq(paymentDisputes.orderId, orderId)).unionAll(
        db.select({
            paymentId: sql<string>`json_extract(${webhookEvents.result}, '$.paymentId')`,
            status: sql<DisputeStatus>`'needs_response'`,
            funds: sql<DisputeFunds>`'held'`,
            amountMinor: sql<number>`0`.mapWith(Number),
            countedMinor: sql<number>`0`.mapWith(Number),
        }).from(webhookEvents).where(parkedDisputeEventCondition(orderId)),
    );
}
export type OrderDisputeLedgerRow = Awaited<ReturnType<typeof orderDisputeLedgerRead>>[number];

/** Whether a dispute still waits for the merchant's answer or the bank's decision. */
export function isOpenDispute(status: string): boolean {
    return (OPEN_DISPUTE_STATUSES as readonly string[]).includes(status);
}

/** The refusal's `reason`: a refund would draw on a payment with an open dispute (clients word it). */
export const PAYMENT_DISPUTED_REASON = "payment_disputed";
/** The refusal's `reason`: banks withdrew the money a refund would give back (clients word it). */
export const PAYMENT_LOST_TO_DISPUTE_REASON = "payment_lost_to_dispute";
/** The staff notice a dispute raises when it is first recorded. */
export const PAYMENT_DISPUTED_NOTIFICATION = "payment_disputed";

async function disputeId(gateway: string, ref: string): Promise<string> {
    return `pdsp_${(await sha256Hex(`payment-dispute\0${gateway}\0${ref}`)).slice(0, 32)}`;
}

async function disputeLineId(orderId: string, eventKey: string): Promise<string> {
    return `oev_k${(await sha256Hex(`order-event\0${orderId}\0payment_dispute\0${eventKey}`)).slice(0, 32)}`;
}

async function disputeNoticeId(id: string): Promise<string> {
    return `ono_dispute_${(await sha256Hex(`${PAYMENT_DISPUTED_NOTIFICATION}:${id}`)).slice(0, 32)}`;
}

const DISPUTE_APPLY_CONFLICT = "payment_dispute_conflict";
const MAX_APPLY_ROUNDS = 4;
const MAX_REASON_LENGTH = 300;
const MAX_BUYER_MESSAGE_LENGTH = 2000;

/** The disputed payment, as a dispute is applied to it. */
interface DisputedPayment {
    id: string;
    orderId: string;
    paymentMethod: string;
    currency: string;
    amountMinor: number;
}

interface ApplyDisputeInput {
    payment: DisputedPayment;
    /** The provider's dispute reference (a hand-recorded one: its own). */
    ref: string;
    facts: DisputeFacts;
    /** Only for a new dispute: the amount disputed. */
    amountMinor: number;
    reason: string | null;
    evidenceDueAt: Date | null;
    fee: { amountMinor: number; currency: string } | null;
    buyerMessage: string | null;
    dashboardUrl: string | null;
    /** Names this fact: the provider's event, or the staff request. Its timeline line is keyed by it. */
    eventKey: string;
    /** The staff member who recorded it by hand; null for a provider's fact. */
    recordedBy: string | null;
    /** A hand record's request, hashed: its retry key replays only the same request. */
    requestHash?: string;
}

export interface ApplyDisputeResult {
    disputeId: string;
    /** `unchanged`: nothing new in this fact (a duplicate, or one a later fact overtook). */
    outcome: "applied" | "unchanged";
    state: DisputeState;
    /** The staff notice of a dispute recorded for the first time: send it. */
    notificationOutboxId: string | null;
    /** Money banks withdrew from the order and kept, after this fact. */
    disputedMinor: number;
    /**
     * The provider disputes more than its payment still held (its refunds and
     * other disputes took the rest): only what it held counts; staff check
     * the rest with the provider. True only for the fact that first recorded
     * the dispute: its later facts and repeats are ordinary.
     */
    exceedsHeld: boolean;
}

/**
 * A refund on the order is still in flight: what the payment holds is not
 * known until it settles. A provider's dispute event waits for it without
 * spending its attempts (apps/api background/payment-events.ts parks it);
 * staff recording one by hand are told to try again.
 */
export class DisputeWaitsForRefundError extends ConflictError {
    constructor(
        /** The disputed payment: refunds on it wait for the dispute (`REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT`). */
        readonly paymentId: string,
    ) {
        super("A refund on this order is still being processed. Try again once it settles.");
    }
}

export function isDisputeWaitingForRefundError(error: unknown): error is DisputeWaitsForRefundError {
    return error instanceof DisputeWaitsForRefundError;
}

/** A fact that names a dispute of another payment, or an order that is gone: staff look at it, it never retries. */
class DisputeMismatchError extends ValidationError {}

/**
 * Whether a dispute takes money from its payment: its funds are withdrawn
 * (and not reinstated), or it is still open with its funds held (it reserves
 * what it counted until the bank decides). A closed dispute whose funds were
 * never withdrawn (an inquiry closed without a chargeback, a won dispute)
 * and a reinstated one take nothing. The one definition every reader of what
 * a payment holds uses (`disputeReserves` is its twin over rows).
 */
export function disputeReservesSql(): SQL {
    return sql`(${paymentDisputes.funds} = 'withdrawn'
        OR (${paymentDisputes.funds} = 'held' AND ${inArray(paymentDisputes.status, [...OPEN_DISPUTE_STATUSES])}))`;
}

export function disputeReserves(dispute: { status: string; funds: string }): boolean {
    return dispute.funds === "withdrawn" || (dispute.funds === "held" && isOpenDispute(dispute.status));
}

/**
 * What a payment still holds for a dispute to take, never below zero: its
 * amount less its refunds (pending ones included: only a failed refund gave
 * nothing back) and less what its other disputes take (`disputeReservesSql`).
 * Read in the batch that writes the dispute, and the same expression guards
 * it, so a refund or another dispute landing meanwhile fails the write
 * instead of overdrawing the payment.
 */
function paymentHeldSql(paymentId: string, exceptDisputeId: string): SQL<number> {
    return heldSql(sql`(SELECT ${orderPayments.amountMinor} FROM ${orderPayments} WHERE ${orderPayments.id} = ${paymentId})`, paymentId, exceptDisputeId);
}

/**
 * `paymentHeldSql` for each row of a select from `order_payments`: what a new
 * dispute on that payment may take (the hand-record form's maximum).
 */
export function orderPaymentHeldSql(): SQL<number> {
    return heldSql(sql`${orderPayments.amountMinor}`, orderPayments.id);
}

function heldSql(amountMinor: SQL, paymentId: string | AnyColumn, exceptDisputeId?: string): SQL<number> {
    const held = sql`(
        ${amountMinor}
        - (SELECT coalesce(sum(${refundAttempts.amountMinor}), 0) FROM ${refundAttempts}
            WHERE ${refundAttempts.sourcePaymentId} = ${paymentId} AND ${refundAttempts.status} <> 'failed')
        - (SELECT coalesce(sum(${paymentDisputes.countedMinor}), 0) FROM ${paymentDisputes}
            WHERE ${paymentDisputes.paymentId} = ${paymentId} AND ${disputeReservesSql()}
            ${exceptDisputeId === undefined ? sql`` : sql`AND ${paymentDisputes.id} <> ${exceptDisputeId}`})
    )`;
    return sql<number>`(CASE WHEN ${held} > 0 THEN ${held} ELSE 0 END)`.mapWith(Number);
}

/** A dispute still open on the payment (a hand record needs none). */
function openDisputeOnPaymentSql(paymentId: string): SQL {
    return sql`EXISTS (SELECT 1 FROM ${paymentDisputes}
        WHERE ${paymentDisputes.paymentId} = ${paymentId} AND ${inArray(paymentDisputes.status, [...OPEN_DISPUTE_STATUSES])})`;
}

function orderRead(db: Database, orderId: string) {
    return db.select({
        id: orders.id,
        status: orders.status,
        version: orders.version,
        totalAmountMinor: orders.totalAmountMinor,
        paymentTermsDays: orders.paymentTermsDays,
        disputedMinor: orders.disputedMinor,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql(),
        ...paymentLedgerTotalsSql(orderId),
    }).from(orders).where(eq(orders.id, orderId));
}

async function hasActiveRefundAttempt(db: Database, orderId: string): Promise<boolean> {
    return Boolean(await findActiveRefundAttempt(db, orderId));
}

function stateCondition(id: string, state: DisputeState | null): SQL {
    return state
        ? sql`EXISTS (SELECT 1 FROM ${paymentDisputes} WHERE ${paymentDisputes.id} = ${id} AND ${paymentDisputes.status} = ${state.status} AND ${paymentDisputes.funds} = ${state.funds})`
        : sql`NOT EXISTS (SELECT 1 FROM ${paymentDisputes} WHERE ${paymentDisputes.id} = ${id})`;
}

function sameDate(left: Date | null, right: Date | null): boolean {
    return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

/**
 * Apply one fact about a dispute: in one batch, the dispute row (new, or its
 * details refreshed), each transition the fact implies, the order's disputed
 * money from its ledger when it moved, the timeline line and, for a new
 * dispute, the staff notice. Retries a read another write made stale.
 *
 * A new dispute counts at most what its payment still holds
 * (`paymentHeldSql`), guarded in the batch; a hand-recorded one may not ask
 * for more, and needs no other dispute open on its payment. No refund may be
 * in flight on the order while a dispute is written (a provider's fact
 * retries once it settles).
 */
async function applyDispute(db: Database, input: ApplyDisputeInput): Promise<ApplyDisputeResult> {
    const id = await disputeId(input.payment.paymentMethod, input.ref);
    const byHand = input.recordedBy !== null;
    for (let round = 0; ; round += 1) {
        const [orderRows, existingRows, heldRows, openRows] = await db.batch([
            orderRead(db, input.payment.orderId),
            db.select().from(paymentDisputes).where(eq(paymentDisputes.id, id)),
            db.select({ held: paymentHeldSql(input.payment.id, id) }).from(orders).where(eq(orders.id, input.payment.orderId)),
            db.select({ open: sql<number>`CASE WHEN ${openDisputeOnPaymentSql(input.payment.id)} THEN 1 ELSE 0 END`.mapWith(Number) })
                .from(orders).where(eq(orders.id, input.payment.orderId)),
        ]);
        const order = orderRows[0];
        if (!order) throw new DisputeMismatchError("The dispute's order no longer exists.");
        const existing = existingRows[0] ?? null;
        if (existing && existing.paymentId !== input.payment.id) {
            throw new DisputeMismatchError("This dispute belongs to another payment.");
        }
        const heldRead = Number(heldRows[0]?.held ?? 0);
        if (existing && input.requestHash !== undefined) {
            // A hand record's retry: the same request answers what it recorded; another is refused.
            if (existing.requestHash !== input.requestHash) throw new ConflictError("This retry key already recorded a different chargeback. Use a new key for a new chargeback.");
            return { disputeId: id, outcome: "unchanged", state: { status: existing.status, funds: existing.funds }, notificationOutboxId: null, disputedMinor: order.disputedMinor, exceedsHeld: false };
        }
        const before: DisputeState | null = existing ? { status: existing.status, funds: existing.funds } : null;
        let state = before ?? NEW_DISPUTE_STATE;
        const applied: DisputeEvent[] = [];
        for (const event of disputeEventsOf(input.facts)) {
            const next = nextDisputeState(state, event);
            if (next.status !== state.status || next.funds !== state.funds) applied.push(event);
            state = next;
        }
        const details = {
            reason: input.reason ?? existing?.reason ?? null,
            evidenceDueAt: input.evidenceDueAt ?? existing?.evidenceDueAt ?? null,
            feeMinor: input.fee?.amountMinor ?? existing?.feeMinor ?? null,
            feeCurrency: input.fee?.currency ?? existing?.feeCurrency ?? null,
            buyerMessage: input.buyerMessage ?? existing?.buyerMessage ?? null,
            dashboardUrl: input.dashboardUrl ?? existing?.dashboardUrl ?? null,
        };
        const refreshedFields = existing === null ? [] : [
            details.reason !== existing.reason ? "reason" : null,
            !sameDate(details.evidenceDueAt, existing.evidenceDueAt) ? "evidenceDueAt" : null,
            details.feeMinor !== existing.feeMinor || details.feeCurrency !== existing.feeCurrency ? "fee" : null,
            details.buyerMessage !== existing.buyerMessage ? "buyerMessage" : null,
            details.dashboardUrl !== existing.dashboardUrl ? "dashboardUrl" : null,
        ].filter((field): field is string => field !== null);
        const amountMinor = existing?.amountMinor ?? input.amountMinor;
        const countedMinor = existing?.countedMinor ?? Math.min(amountMinor, heldRead);
        if (existing && applied.length === 0 && refreshedFields.length === 0) {
            return { disputeId: id, outcome: "unchanged", state, notificationOutboxId: null, disputedMinor: order.disputedMinor, exceedsHeld: false };
        }
        if (!existing && byHand) {
            if (Number(openRows[0]?.open ?? 0) === 1) {
                throw new ConflictError("A dispute is already open on this payment. Record its outcome before recording another.");
            }
            if (amountMinor > heldRead) {
                throw new ValidationError("The payment holds less than that: its refunds and other disputes took the rest.", { maxAmountMinor: heldRead });
            }
        }
        // A courier booking holds the order: the fact waits for it (a payment event is parked, uncounted).
        assertNoActiveShipmentClaim(order);
        // A refund in flight settles first: what the payment holds is not known until it does.
        try {
            await assertNoActiveRefundAttempt(db, order.id);
        } catch (error) {
            if (error instanceof ConflictError) throw new DisputeWaitsForRefundError(input.payment.id);
            throw error;
        }

        const withdrawn = (funds: DisputeFunds | null) => funds === "withdrawn" ? countedMinor : 0;
        const totals: PaymentLedgerTotals = { receivedMinor: order.receivedMinor, returnedMinor: order.returnedMinor, withdrawnMinor: order.withdrawnMinor };
        const nextTotals: PaymentLedgerTotals = { ...totals, withdrawnMinor: totals.withdrawnMinor - withdrawn(before?.funds ?? null) + withdrawn(state.funds) };
        const money = deriveOrderPaymentState({
            totalAmountMinor: order.totalAmountMinor,
            deferred: order.paymentTermsDays !== null,
            ledger: nextTotals,
        });
        // The order row moves only when its money did (or a new dispute brings an archived order back into view).
        const moneyMoved = money.disputedMinor !== order.disputedMinor;
        const touchOrder = moneyMoved || !existing;
        const nextVersion = touchOrder ? order.version + 1 : order.version;
        const decimals = order.currencyDecimalPlaces;
        const statements: unknown[] = [
            // The order, the dispute and the payment's held money still read as they did: anything else retries.
            buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${orders} WHERE ${orders.id} = ${order.id} AND ${orders.version} = ${order.version} AND ${noActiveShipmentClaimCondition()}
            ) AND ${ledgerTotalsCondition(order.id, totals)} AND ${stateCondition(id, before)}
              AND ${noActiveRefundAttemptForOrderIdCondition(order.id)}
              ${existing ? sql`` : sql`AND ${paymentHeldSql(input.payment.id, id)} = ${heldRead}`}
              ${!existing && byHand ? sql`AND NOT ${openDisputeOnPaymentSql(input.payment.id)}` : sql``}`, DISPUTE_APPLY_CONFLICT),
        ];
        if (!existing) {
            statements.push(db.insert(paymentDisputes).values({
                id,
                orderId: order.id,
                paymentId: input.payment.id,
                gateway: input.payment.paymentMethod,
                disputeRef: input.ref,
                status: NEW_DISPUTE_STATE.status,
                funds: NEW_DISPUTE_STATE.funds,
                amountMinor,
                countedMinor,
                currency: input.payment.currency,
                ...details,
                recordedBy: input.recordedBy,
                requestHash: input.requestHash ?? null,
            }));
        } else if (refreshedFields.length > 0) {
            statements.push(db.update(paymentDisputes).set({ ...details, updatedAt: sql`unixepoch()` }).where(eq(paymentDisputes.id, id)));
        }
        for (const event of applied) statements.push(disputeTransition(db, event, id));
        if (touchOrder) {
            // The order's disputed money from its ledger, and its version: a refund claimed on the old read loses.
            // Paid, due and status stay: a bank's withdrawal is the store's loss, not a balance the buyer owes.
            statements.push(db.update(orders).set({
                disputedMinor: money.disputedMinor,
                version: nextVersion,
                ...(existing ? {} : { deletedAt: null }),
                updatedAt: sql`unixepoch()`,
            }).where(and(eq(orders.id, order.id), eq(orders.version, order.version), ledgerTotalsCondition(order.id, nextTotals))));
        }
        statements.push(db.insert(orderEvents).values({
            id: await disputeLineId(order.id, input.eventKey),
            orderId: order.id,
            kind: "payment_dispute",
            body: null,
            // An agent's hand-recorded chargeback names its connection (`data.via`).
            data: orderEventData({
                disputeId: id,
                paymentId: input.payment.id,
                gateway: input.payment.paymentMethod,
                opened: !existing,
                change: applied,
                ...(refreshedFields.length > 0 ? { refreshed: refreshedFields } : {}),
                status: state.status,
                funds: state.funds,
                amount: fromMinor(amountMinor, decimals),
                amountMinor,
                countedMinor,
                currency: input.payment.currency,
                ...(details.evidenceDueAt ? { evidenceDueAt: Math.floor(details.evidenceDueAt.getTime() / 1000) } : {}),
                ...(details.reason ? { reason: details.reason } : {}),
                ...(byHand ? { byHand: true } : {}),
                // Money back on a cancelled order is the buyer's: it is listed in Money to return.
                ...(applied.includes("funds_reinstated") && order.status === "cancelled" ? { returnOwed: true } : {}),
            }),
            actorId: input.recordedBy,
            actorAppId: null,
            createdAt: sql`unixepoch()`,
        }).onConflictDoNothing({ target: orderEvents.id }));
        const notificationOutboxId = existing ? null : await disputeNoticeId(id);
        if (notificationOutboxId) {
            statements.push(db.insert(notificationOutbox).values({
                ...createNotificationOutboxInsertValues({
                    subjectType: "order",
                    subjectId: order.id,
                    audience: "staff",
                    notificationType: PAYMENT_DISPUTED_NOTIFICATION,
                    dedupeKey: `${PAYMENT_DISPUTED_NOTIFICATION}:${id}`,
                    source: byHand ? "dispute_recorded" : "payment_dispute",
                    data: { disputeId: id, amountMinor, currency: input.payment.currency },
                }),
                id: notificationOutboxId,
            }).onConflictDoNothing());
        }
        statements.push(buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${orders} WHERE ${orders.id} = ${order.id} AND ${orders.version} = ${nextVersion}
        ) AND ${stateCondition(id, state)}`, DISPUTE_APPLY_CONFLICT));
        try {
            await safeBatch(db, statements as SQLiteBatchItem[] as never);
        } catch (error) {
            if (isBatchGuardError(error, DISPUTE_APPLY_CONFLICT) && round + 1 < MAX_APPLY_ROUNDS) continue;
            if (isBatchGuardError(error, DISPUTE_APPLY_CONFLICT)) {
                // A refund claimed since the read is the usual reason: wait for it like one seen in the read.
                if (await hasActiveRefundAttempt(db, order.id)) throw new DisputeWaitsForRefundError(input.payment.id);
                throw new ConflictError("The order changed while the dispute was being recorded. Try again.");
            }
            throw error;
        }
        // Raised once, when the row is first recorded above what its payment held.
        return { disputeId: id, outcome: "applied", state, notificationOutboxId, disputedMinor: money.disputedMinor, exceedsHeld: !existing && countedMinor < amountMinor };
    }
}

/** A captured payment a dispute can be about: never a refund row, a pending row or a gift-card tender. */
function disputablePayment(): SQL {
    return and(
        sql`${orderPayments.paymentType} <> 'refund'`,
        inArray(orderPayments.status, [PaymentRecordStatus.SUCCEEDED, PaymentRecordStatus.REFUNDED]),
        sql`${orderPayments.paymentMethod} <> 'gift_card'`,
    )!;
}

const PAYMENT_COLUMNS = {
    id: orderPayments.id,
    orderId: orderPayments.orderId,
    paymentMethod: orderPayments.paymentMethod,
    currency: orderPayments.currency,
    amountMinor: orderPayments.amountMinor,
};

export type ProviderDisputeOutcome =
    | ({ status: "applied" | "unchanged" } & Omit<ApplyDisputeResult, "outcome">)
    /** The dispute names no captured payment of the order at this provider, or does not fit it: staff check it. */
    | { status: "unmatched"; reason: string };

/**
 * A provider's `dispute` event: its dispute applied to the captured payment
 * its `providerRef` names on the event's order.
 */
export async function applyProviderDispute(db: Database, input: { provider: string; event: PaymentEvent }): Promise<ProviderDisputeOutcome> {
    const { event } = input;
    const dispute: PaymentDispute | undefined = event.dispute;
    if (event.kind !== "dispute" || !dispute) return { status: "unmatched", reason: "The event carries no dispute." };
    const payment = await db.select(PAYMENT_COLUMNS).from(orderPayments).where(and(
        eq(orderPayments.orderId, event.orderId),
        eq(orderPayments.paymentMethod, input.provider),
        eq(orderPayments.providerRef, event.providerRef),
        disputablePayment(),
    )).get();
    if (!payment) return { status: "unmatched", reason: "No captured payment of this order matches the disputed payment." };
    if (!Number.isSafeInteger(dispute.amountMinor) || dispute.amountMinor <= 0 || dispute.amountMinor > payment.amountMinor) {
        return { status: "unmatched", reason: "The disputed amount does not fit the payment." };
    }
    if (dispute.currency !== payment.currency) {
        return { status: "unmatched", reason: `The dispute is in ${dispute.currency}; the payment was in ${payment.currency}.` };
    }
    const fee = dispute.fee && Number.isSafeInteger(dispute.fee.amountMinor) && dispute.fee.amountMinor >= 0 ? dispute.fee : null;
    let result: ApplyDisputeResult;
    try {
        result = await applyDispute(db, {
        payment,
        ref: dispute.ref,
        facts: dispute,
        amountMinor: dispute.amountMinor,
        reason: dispute.reason?.slice(0, MAX_REASON_LENGTH) ?? null,
        evidenceDueAt: dispute.evidenceDueAt ? new Date(dispute.evidenceDueAt) : null,
        fee,
        buyerMessage: dispute.buyerMessage?.slice(0, MAX_BUYER_MESSAGE_LENGTH) ?? null,
        dashboardUrl: dispute.dashboardUrl ?? null,
        eventKey: `${input.provider}:${event.eventType}:${event.eventId}`,
        recordedBy: null,
        });
    } catch (error) {
        if (error instanceof DisputeMismatchError) return { status: "unmatched", reason: error.message };
        throw error;
    }
    const { outcome, ...rest } = result;
    return { status: outcome, ...rest };
}

/** A chargeback staff record by hand: its own reference, from the request key. */
async function handDisputeRef(paymentId: string, requestKey: string): Promise<string> {
    return `hand_${(await sha256Hex(`${paymentId}\0${requestKey}`)).slice(0, 32)}`;
}

export interface RecordDisputeByHandInput {
    orderId: string;
    paymentId: string;
    /** Integer minor units of the payment's currency; at most the payment. */
    amountMinor: number;
    reason: string;
    /** Whether the provider or bank already took the money (most chargebacks do). */
    fundsWithdrawn: boolean;
    /** Lost already (a chargeback the bank settled without asking): final, the money stays taken. */
    lost: boolean;
    evidenceDueAt: Date | null;
    /** The staff member recording it. */
    recordedBy: string;
    /** The request's retry key: one key, one chargeback. */
    requestKey: string;
    /** Its provider reports disputes itself (`disputes` capability): staff do not record them by hand. */
    providerReportsDisputes: boolean;
}

/**
 * Record a chargeback by hand on a captured payment whose provider reports
 * no disputes (cash on delivery, a bank transfer, a regional wallet), through
 * the same rows and transitions as a provider's, with the staff member
 * recorded. A retry with the same key returns the same dispute.
 */
export async function recordDisputeByHand(db: Database, input: RecordDisputeByHandInput): Promise<ApplyDisputeResult> {
    const requestKey = input.requestKey.trim();
    if (requestKey.length < 8 || requestKey.length > 200) throw new ValidationError("A retry key of 8 to 200 characters is required.");
    const reason = input.reason.trim().slice(0, MAX_REASON_LENGTH);
    if (!reason) throw new ValidationError("Say why the buyer disputed the payment.");
    if (input.providerReportsDisputes) {
        throw new ValidationError("This payment's provider reports its disputes itself; they appear here when it does.");
    }
    const payment = await db.select(PAYMENT_COLUMNS).from(orderPayments).where(and(
        eq(orderPayments.id, input.paymentId),
        eq(orderPayments.orderId, input.orderId),
        disputablePayment(),
    )).get();
    if (!payment) throw new NotFoundError("No captured payment of this order matches.");
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > payment.amountMinor) {
        throw new ValidationError("The disputed amount must be more than zero and at most the payment.", { maxAmountMinor: payment.amountMinor });
    }
    // The request the key binds (stable field order): a retry must repeat it exactly.
    const requestHash = await sha256Hex(JSON.stringify([
        payment.id, input.amountMinor, reason, input.fundsWithdrawn, input.lost, input.evidenceDueAt?.getTime() ?? null,
    ]));
    return applyDispute(db, {
        payment,
        requestHash,
        ref: await handDisputeRef(payment.id, requestKey),
        facts: { status: input.lost ? "lost" : "needs_response", fundsWithdrawn: input.fundsWithdrawn, fundsReinstated: false },
        amountMinor: input.amountMinor,
        reason,
        evidenceDueAt: input.evidenceDueAt,
        fee: null,
        buyerMessage: null,
        dashboardUrl: null,
        eventKey: `hand:${requestKey}`,
        recordedBy: input.recordedBy,
    });
}

/**
 * The outcome of a chargeback recorded by hand: `won` gives back money that
 * was taken, `lost` takes it for good. A provider's dispute is decided by its
 * provider's events, never here.
 */
export async function resolveDisputeByHand(
    db: Database,
    input: { orderId: string; disputeId: string; outcome: "won" | "lost"; recordedBy: string },
): Promise<ApplyDisputeResult> {
    const dispute = await db.select({
        id: paymentDisputes.id,
        paymentId: paymentDisputes.paymentId,
        disputeRef: paymentDisputes.disputeRef,
        recordedBy: paymentDisputes.recordedBy,
        status: paymentDisputes.status,
    }).from(paymentDisputes).where(and(eq(paymentDisputes.id, input.disputeId), eq(paymentDisputes.orderId, input.orderId))).get();
    if (!dispute) throw new NotFoundError("Dispute not found");
    if (!dispute.disputeRef.startsWith("hand_")) {
        throw new ValidationError("This dispute's provider reports its outcome; it updates here when it does.");
    }
    if (!isOpenDispute(dispute.status) && dispute.status !== input.outcome) {
        throw new ConflictError("This dispute is already closed.");
    }
    const payment = await db.select(PAYMENT_COLUMNS).from(orderPayments).where(eq(orderPayments.id, dispute.paymentId)).get();
    if (!payment) throw new NotFoundError("The disputed payment no longer exists.");
    return applyDispute(db, {
        payment,
        ref: dispute.disputeRef,
        facts: input.outcome === "won"
            ? { status: "won", fundsWithdrawn: false, fundsReinstated: true }
            : { status: "lost", fundsWithdrawn: true, fundsReinstated: false },
        amountMinor: 0,
        reason: null,
        evidenceDueAt: null,
        fee: null,
        buyerMessage: null,
        dashboardUrl: null,
        eventKey: `hand:${dispute.id}:${input.outcome}`,
        recordedBy: input.recordedBy,
    });
}

/** One dispute as the order's payment panel shows it. */
export interface OrderDisputeView {
    id: string;
    paymentId: string;
    gateway: string;
    status: DisputeStatus;
    funds: DisputeFunds;
    amountMinor: number;
    /** What its payment still held when it was recorded: what a withdrawal takes off the order. */
    countedMinor: number;
    currency: string;
    reason: string | null;
    evidenceDueAt: Date | null;
    feeMinor: number | null;
    feeCurrency: string | null;
    buyerMessage: string | null;
    dashboardUrl: string | null;
    /** Recorded by hand (staff decide its outcome); a provider's dispute is decided by its events. */
    byHand: boolean;
    recordedBy: string | null;
    createdAt: Date;
    closedAt: Date | null;
}

/** The order's disputes, newest first: the read (for a caller's batch). */
export function listOrderDisputesQuery(db: Database, orderId: string) {
    return db.select().from(paymentDisputes)
        .where(eq(paymentDisputes.orderId, orderId))
        .orderBy(desc(paymentDisputes.createdAt), desc(paymentDisputes.id));
}

/** The read's rows as the order's payment card shows them. */
export function presentOrderDisputeRows(rows: ReadonlyArray<typeof paymentDisputes.$inferSelect>): OrderDisputeView[] {
    return rows.map((row) => ({
        id: row.id,
        paymentId: row.paymentId,
        gateway: row.gateway,
        status: row.status,
        funds: row.funds,
        amountMinor: row.amountMinor,
        countedMinor: row.countedMinor,
        currency: row.currency,
        reason: row.reason,
        evidenceDueAt: row.evidenceDueAt,
        feeMinor: row.feeMinor,
        feeCurrency: row.feeCurrency,
        buyerMessage: row.buyerMessage,
        dashboardUrl: row.dashboardUrl,
        byHand: row.disputeRef.startsWith("hand_"),
        recordedBy: row.recordedBy,
        createdAt: row.createdAt,
        closedAt: row.closedAt,
    }));
}

/** The order's disputes, newest first. */
export async function listOrderDisputes(db: Database, orderId: string): Promise<OrderDisputeView[]> {
    return presentOrderDisputeRows(await listOrderDisputesQuery(db, orderId));
}

/**
 * Disputes waiting for the merchant's answer, and the nearest deadline among
 * them (Home's to-do): read from the partial index of those disputes.
 */
export async function readDisputesAwaitingResponse(db: Database): Promise<{ count: number; nextEvidenceDueAt: Date | null }> {
    const [counted, nearest] = await db.batch([
        db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(paymentDisputes)
            .where(eq(paymentDisputes.status, "needs_response")),
        db.select({ evidenceDueAt: paymentDisputes.evidenceDueAt }).from(paymentDisputes)
            .where(and(eq(paymentDisputes.status, "needs_response"), sql`${paymentDisputes.evidenceDueAt} IS NOT NULL`))
            .orderBy(asc(paymentDisputes.evidenceDueAt))
            .limit(1),
    ]);
    return { count: counted[0]?.count ?? 0, nextEvidenceDueAt: nearest[0]?.evidenceDueAt ?? null };
}

/** The order ids with a dispute (the orders list's Disputes view): the dispute table's order index. */
export function disputedOrderIds(): SQL {
    return sql`SELECT ${paymentDisputes.orderId} AS order_id FROM ${paymentDisputes}`;
}

/** Whether a gateway reports its disputes itself (the `disputes` capability): staff then never record one by hand. */
export async function providerReportsDisputes(providers: PaymentProvidersSource | undefined, gatewayId: string): Promise<boolean> {
    const gateway = (await paymentProvidersFor(providers, gatewayId)).get(gatewayId);
    return gateway ? gatewayHasCapability(gateway, "disputes") : false;
}

/**
 * The order's payments staff may record a chargeback on by hand: captured,
 * not a gift-card tender, taken by a gateway that reports no disputes, and
 * still holding money (`heldMinor`, from `orderPaymentHeldSql`: the most a
 * chargeback may take, which `applyDispute` enforces).
 */
export async function handDisputablePayments(
    providers: PaymentProvidersSource | undefined,
    payments: ReadonlyArray<{ id: string; paymentType: string; status: string; paymentMethod: string; heldMinor: number }>,
): Promise<Array<{ paymentId: string; heldMinor: number }>> {
    const found: Array<{ paymentId: string; heldMinor: number }> = [];
    for (const payment of payments) {
        if (payment.paymentType === "refund" || payment.paymentMethod === "gift_card") continue;
        if (payment.status !== PaymentRecordStatus.SUCCEEDED && payment.status !== PaymentRecordStatus.REFUNDED) continue;
        if (payment.heldMinor <= 0) continue;
        if (!await providerReportsDisputes(providers, payment.paymentMethod)) found.push({ paymentId: payment.id, heldMinor: payment.heldMinor });
    }
    return found;
}
