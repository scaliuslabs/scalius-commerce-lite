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
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { notificationOutbox, orderEvents, orderPayments, orders, paymentDisputes, PaymentRecordStatus } from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { sha256Hex } from "@scalius/shared/hash";
import { fromMinor } from "@scalius/shared/money";
import { PAYMENT_DISPUTE_STATUSES, type PaymentDispute, type PaymentDisputeStatus } from "@scalius/shared/plugins/providers";
import { assertNoActiveShipmentClaim, noActiveShipmentClaimCondition, shipmentClaimShipmentStatusSql } from "../order-kernel";
import { createNotificationOutboxInsertValues } from "../notifications";
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

/** The disputes of one order as the ledger reads them (refunds, their finalization, the gift-card bound). */
export function orderDisputeLedgerRead(db: Database, orderId: string) {
    return db.select({
        paymentId: paymentDisputes.paymentId,
        status: paymentDisputes.status,
        funds: paymentDisputes.funds,
        amountMinor: paymentDisputes.amountMinor,
    }).from(paymentDisputes).where(eq(paymentDisputes.orderId, orderId));
}
export type OrderDisputeLedgerRow = Awaited<ReturnType<typeof orderDisputeLedgerRead>>[number];

/** Whether a dispute still waits for the merchant's answer or the bank's decision. */
export function isOpenDispute(status: string): boolean {
    return (OPEN_DISPUTE_STATUSES as readonly string[]).includes(status);
}

/** The refusal's `reason`: a refund would draw on a payment with an open dispute (clients word it). */
export const PAYMENT_DISPUTED_REASON = "payment_disputed";
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
}

export interface ApplyDisputeResult {
    disputeId: string;
    /** `unchanged`: nothing new in this fact (a duplicate, or one a later fact overtook). */
    outcome: "applied" | "unchanged";
    state: DisputeState;
    /** The staff notice of a dispute recorded for the first time: send it. */
    notificationOutboxId: string | null;
    paidAmountMinor: number;
}

function orderRead(db: Database, orderId: string) {
    return db.select({
        id: orders.id,
        version: orders.version,
        totalAmountMinor: orders.totalAmountMinor,
        paymentTermsDays: orders.paymentTermsDays,
        paidAmountMinor: orders.paidAmountMinor,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql(),
        ...paymentLedgerTotalsSql(orderId),
    }).from(orders).where(eq(orders.id, orderId));
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
 * details refreshed), each transition the fact implies, the order's money
 * from its ledger, the timeline line and, for a new dispute, the staff
 * notice. Retries a read another write made stale.
 */
async function applyDispute(db: Database, input: ApplyDisputeInput): Promise<ApplyDisputeResult> {
    const id = await disputeId(input.payment.paymentMethod, input.ref);
    for (let round = 0; ; round += 1) {
        const [orderRows, existingRows] = await db.batch([
            orderRead(db, input.payment.orderId),
            db.select().from(paymentDisputes).where(eq(paymentDisputes.id, id)),
        ]);
        const order = orderRows[0];
        if (!order) throw new NotFoundError("Order not found");
        const existing = existingRows[0] ?? null;
        if (existing && existing.paymentId !== input.payment.id) {
            throw new ValidationError("This dispute belongs to another payment.");
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
        const refreshed = existing !== null && (
            details.reason !== existing.reason
            || !sameDate(details.evidenceDueAt, existing.evidenceDueAt)
            || details.feeMinor !== existing.feeMinor
            || details.feeCurrency !== existing.feeCurrency
            || details.buyerMessage !== existing.buyerMessage
            || details.dashboardUrl !== existing.dashboardUrl
        );
        if (existing && applied.length === 0 && !refreshed) {
            return { disputeId: id, outcome: "unchanged", state, notificationOutboxId: null, paidAmountMinor: order.paidAmountMinor };
        }
        // A courier booking holds the order: the fact waits for it (a payment event is parked, uncounted).
        assertNoActiveShipmentClaim(order);

        const amountMinor = existing?.amountMinor ?? input.amountMinor;
        const withdrawn = (funds: DisputeFunds | null) => funds === "withdrawn" ? amountMinor : 0;
        const totals: PaymentLedgerTotals = { receivedMinor: order.receivedMinor, returnedMinor: order.returnedMinor, withdrawnMinor: order.withdrawnMinor };
        const nextTotals: PaymentLedgerTotals = { ...totals, withdrawnMinor: totals.withdrawnMinor - withdrawn(before?.funds ?? null) + withdrawn(state.funds) };
        const money = deriveOrderPaymentState({
            totalAmountMinor: order.totalAmountMinor,
            deferred: order.paymentTermsDays !== null,
            ledger: nextTotals,
        });
        const nextVersion = order.version + 1;
        const decimals = order.currencyDecimalPlaces;
        const statements: unknown[] = [
            // The order and the dispute still read as they did: anything else retries.
            buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${orders} WHERE ${orders.id} = ${order.id} AND ${orders.version} = ${order.version} AND ${noActiveShipmentClaimCondition()}
            ) AND ${ledgerTotalsCondition(order.id, totals)} AND ${stateCondition(id, before)}`, DISPUTE_APPLY_CONFLICT),
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
                currency: input.payment.currency,
                ...details,
                recordedBy: input.recordedBy,
            }));
        } else if (refreshed) {
            statements.push(db.update(paymentDisputes).set({ ...details, updatedAt: sql`unixepoch()` }).where(eq(paymentDisputes.id, id)));
        }
        for (const event of applied) statements.push(disputeTransition(db, event, id));
        // The order's money from its ledger, and its version: a refund claimed on the old read loses.
        // An archived order comes back into view: a dispute is never hidden.
        statements.push(db.update(orders).set({
            paidAmountMinor: money.paidAmountMinor,
            balanceDueMinor: money.balanceDueMinor,
            paymentStatus: money.paymentStatus,
            version: nextVersion,
            ...(existing ? {} : { deletedAt: null }),
            updatedAt: sql`unixepoch()`,
        }).where(and(eq(orders.id, order.id), eq(orders.version, order.version), ledgerTotalsCondition(order.id, nextTotals))));
        if (!existing || applied.length > 0) {
            statements.push(db.insert(orderEvents).values({
                id: await disputeLineId(order.id, input.eventKey),
                orderId: order.id,
                kind: "payment_dispute",
                body: null,
                data: JSON.stringify({
                    disputeId: id,
                    paymentId: input.payment.id,
                    gateway: input.payment.paymentMethod,
                    opened: !existing,
                    change: applied,
                    status: state.status,
                    funds: state.funds,
                    amount: fromMinor(amountMinor, decimals),
                    amountMinor,
                    currency: input.payment.currency,
                    ...(details.reason ? { reason: details.reason } : {}),
                    ...(input.recordedBy ? { byHand: true } : {}),
                }),
                actorId: input.recordedBy,
                actorAppId: null,
                createdAt: sql`unixepoch()`,
            }).onConflictDoNothing({ target: orderEvents.id }));
        }
        const notificationOutboxId = existing ? null : await disputeNoticeId(id);
        if (notificationOutboxId) {
            statements.push(db.insert(notificationOutbox).values({
                ...createNotificationOutboxInsertValues({
                    subjectType: "order",
                    subjectId: order.id,
                    audience: "staff",
                    notificationType: PAYMENT_DISPUTED_NOTIFICATION,
                    dedupeKey: `${PAYMENT_DISPUTED_NOTIFICATION}:${id}`,
                    source: input.recordedBy ? "dispute_recorded" : "payment_dispute",
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
                throw new ConflictError("The order changed while the dispute was being recorded. Try again.");
            }
            throw error;
        }
        return { disputeId: id, outcome: "applied", state, notificationOutboxId, paidAmountMinor: money.paidAmountMinor };
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
    const result = await applyDispute(db, {
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
    return applyDispute(db, {
        payment,
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

/** The order's disputes, newest first. */
export async function listOrderDisputes(db: Database, orderId: string): Promise<OrderDisputeView[]> {
    const rows = await db.select().from(paymentDisputes)
        .where(eq(paymentDisputes.orderId, orderId))
        .orderBy(desc(paymentDisputes.createdAt), desc(paymentDisputes.id));
    return rows.map((row) => ({
        id: row.id,
        paymentId: row.paymentId,
        gateway: row.gateway,
        status: row.status,
        funds: row.funds,
        amountMinor: row.amountMinor,
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
 * not a gift-card tender, and taken by a gateway that reports no disputes.
 */
export async function handDisputablePaymentIds(
    providers: PaymentProvidersSource | undefined,
    payments: ReadonlyArray<{ id: string; paymentType: string; status: string; paymentMethod: string }>,
): Promise<string[]> {
    const ids: string[] = [];
    for (const payment of payments) {
        if (payment.paymentType === "refund" || payment.paymentMethod === "gift_card") continue;
        if (payment.status !== PaymentRecordStatus.SUCCEEDED && payment.status !== PaymentRecordStatus.REFUNDED) continue;
        if (!await providerReportsDisputes(providers, payment.paymentMethod)) ids.push(payment.id);
    }
    return ids;
}
