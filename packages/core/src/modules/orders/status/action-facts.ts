// The facts an order's actions are decided by (@scalius/shared/order-admin-actions),
// selected with the order row in the statement a read or a command already
// makes: the list's enrichment batch, the page's second read, the status
// command's own read and bulk confirm's. One selection, one presenter, so a
// row, its page and the commands never decide differently.
import type { OrderAdminActions } from "@scalius/shared/order-admin-actions";
import type { Database } from "@scalius/database/client";
import {
    codTracking,
    deliveryShipments,
    giftCardTransactions,
    orderItems,
    orderPayments,
    orders,
    orderSupportRequests,
    paymentPlans,
    PaymentRecordStatus,
    PaymentStatus,
} from "@scalius/database/schema";
import { eq, sql, type SQL } from "drizzle-orm";
import { GIFT_CARD_PAYMENT_METHOD, listHeldGiftCardTenders, type HeldGiftCardTender } from "../../gift-cards";
import { paymentLedgerTotalsSql } from "../../payments";
import {
    activePaymentSessionAttemptExistsCondition,
    noActiveRefundAttemptForOrderColumnCondition,
    noRefundLocksOrderForColumnCondition,
    shipmentClaimShipmentStatusSql,
} from "../../order-kernel";
import { qualifiedColumn } from "../../../utils/qualified-column";
import { noOpenOrderHoldCondition } from "../holds";
import { presentOrderActions, summarizeHandOverUnits } from "../actions";
import { buildShipmentRecoverySummary } from "../admin/shared";

/**
 * Historical captures remain succeeded after a refund; only their net money
 * or an unfinished payment blocks cancellation. Net money is what was
 * received, less what went back, less what banks withdrew in disputes (the
 * store holds none of it, so there is nothing to refund).
 */
export function cancellationPaymentRecordsSafeCondition(orderId: string | SQL): SQL {
    return sql`
        NOT EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.status} IN (
                  ${PaymentRecordStatus.PENDING},
                  ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED}
              )
        )
        AND (SELECT coalesce(sum(CASE
            WHEN ${orderPayments.paymentType} <> 'refund' AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
              THEN ${orderPayments.amountMinor}
            WHEN ${orderPayments.paymentType} = 'refund' AND ${orderPayments.status} = ${PaymentRecordStatus.REFUNDED}
              THEN -${orderPayments.amountMinor}
            ELSE 0 END), 0)
            FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId})
          - ${paymentLedgerTotalsSql(orderId as string).withdrawnMinor} = 0
    `;
}


/**
 * The money on the order is gift-card tender only (no gateway or cash was
 * taken, and nothing else is pending): the held tenders, which cancelling
 * gives back. Null when the order has no gift-card money, or other money too
 * (that goes through the refund flow first).
 */
export async function giftCardOnlyTenders(
    db: Database,
    orderId: string,
    payment: { paymentStatus: string; paidAmountMinor: number },
): Promise<HeldGiftCardTender[] | null> {
    if (payment.paidAmountMinor <= 0) return null;
    if (payment.paymentStatus !== PaymentStatus.PAID && payment.paymentStatus !== PaymentStatus.PARTIAL) return null;
    // One read: the succeeded gift-card tender, and any other money in flight or taken.
    const money = await db
        .select({
            giftCardMinor: sql<number>`coalesce(sum(CASE
                WHEN ${orderPayments.paymentMethod} = ${GIFT_CARD_PAYMENT_METHOD}
                 AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
                THEN ${orderPayments.amountMinor} ELSE 0 END), 0)`,
            otherRows: sql<number>`coalesce(sum(CASE
                WHEN ${orderPayments.paymentMethod} <> ${GIFT_CARD_PAYMENT_METHOD}
                 AND ${orderPayments.status} IN (
                     ${PaymentRecordStatus.PENDING},
                     ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED},
                     ${PaymentRecordStatus.SUCCEEDED}
                 )
                THEN 1 ELSE 0 END), 0)`,
        })
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId))
        .get();
    if (!money || Number(money.otherRows) > 0 || Number(money.giftCardMinor) !== payment.paidAmountMinor) return null;
    const tenders = await listHeldGiftCardTenders(db, orderId);
    const heldMinor = tenders.reduce((total, tender) => total + tender.amountMinor, 0);
    return heldMinor === payment.paidAmountMinor ? tenders : null;
}



const OUTER = qualifiedColumn(orders.id);
const q = qualifiedColumn;

/** One kind of line's units, still to hand over (`left`) or handed over. */
function units(type: string | null, which: "left" | "handedOver"): SQL<number> {
    const amount = which === "left"
        ? sql`CASE WHEN ${orderItems.quantity} > ${orderItems.fulfilledQuantity} THEN ${orderItems.quantity} - ${orderItems.fulfilledQuantity} ELSE 0 END`
        : sql`${orderItems.fulfilledQuantity}`;
    return sql<number>`(SELECT coalesce(sum(${amount}), 0) FROM ${orderItems}
        WHERE ${orderItems.orderId} = ${OUTER}${type ? sql` AND ${orderItems.fulfillmentType} = ${type}` : sql``})`.mapWith(Number);
}

/**
 * Everything an order's actions are decided by, as columns of a select from
 * `orders` (each fact a subquery on the order's own rows). Each expression is
 * named: D1 keys a batch's rows by column name.
 */
export function orderActionFactsSelection() {
    const paid = (expression: SQL) => sql<number>`(SELECT coalesce(sum(${expression}), 0) FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${OUTER})`.mapWith(Number);
    // Gift-card tender only (`giftCardOnlyTenders`, in one expression): its succeeded tenders, each
    // matching its card's redeem debit, are all the money taken, and nothing else is in flight or taken.
    const giftCardMinor = paid(sql`CASE WHEN ${orderPayments.paymentMethod} = ${GIFT_CARD_PAYMENT_METHOD}
        AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED} THEN ${orderPayments.amountMinor} ELSE 0 END`);
    const otherMoneyRows = paid(sql`CASE WHEN ${orderPayments.paymentMethod} <> ${GIFT_CARD_PAYMENT_METHOD}
        AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.CONFIRMED},
            ${PaymentRecordStatus.AUTHORIZED}, ${PaymentRecordStatus.SUCCEEDED}) THEN 1 ELSE 0 END`);
    const heldTenderMinor = sql<number>`(SELECT coalesce(sum(${q(orderPayments.amountMinor)}), 0)
        FROM ${orderPayments} INNER JOIN ${giftCardTransactions}
          ON ${q(giftCardTransactions.id)} = ${q(orderPayments.providerRef)} AND ${q(giftCardTransactions.kind)} = 'redeem'
        WHERE ${q(orderPayments.orderId)} = ${OUTER}
          AND ${q(orderPayments.paymentMethod)} = ${GIFT_CARD_PAYMENT_METHOD}
          AND ${q(orderPayments.status)} = ${PaymentRecordStatus.SUCCEEDED}
          AND -${q(giftCardTransactions.amountMinor)} = coalesce(${q(orderPayments.settlementAmountMinor)}, ${q(orderPayments.amountMinor)}))`;
    return {
        id: orders.id,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        paymentMethod: orders.paymentMethod,
        fulfillmentStatus: orders.fulfillmentStatus,
        paidAmountMinor: orders.paidAmountMinor,
        totalAmountMinor: orders.totalAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
        disputedMinor: orders.disputedMinor,
        paymentTermsDays: orders.paymentTermsDays,
        requiresShipping: orders.requiresShipping,
        pickupReadyAt: orders.pickupReadyAt,
        shippingMethodKind: orders.shippingMethodKind,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql().as("action_shipment_claim_shipment_status"),
        onHold: sql<number>`NOT (${noOpenOrderHoldCondition(OUTER)})`.mapWith(Number).as("action_on_hold"),
        cancellationRequested: sql<number>`EXISTS (SELECT 1 FROM ${orderSupportRequests}
            WHERE ${orderSupportRequests.orderId} = ${OUTER} AND ${orderSupportRequests.type} = 'cancel_pre_shipment'
              AND ${orderSupportRequests.activeKey} IS NOT NULL)`.mapWith(Number).as("action_cancellation_requested"),
        codStatus: sql<string | null>`(SELECT ${codTracking.codStatus} FROM ${codTracking} WHERE ${codTracking.orderId} = ${OUTER})`.as("action_cod_status"),
        shipLeft: units("ship", "left").as("action_ship_left"),
        pickupLeft: units("pickup", "left").as("action_pickup_left"),
        serviceLeft: units("service", "left").as("action_service_left"),
        shipSent: units("ship", "handedOver").as("action_ship_sent"),
        handedOver: units(null, "handedOver").as("action_handed_over"),
        latestShipmentStatus: sql<string | null>`(SELECT ${deliveryShipments.status} FROM ${deliveryShipments}
            WHERE ${deliveryShipments.orderId} = ${OUTER} ORDER BY ${deliveryShipments.createdAt} DESC, ${deliveryShipments.id} DESC LIMIT 1)`.as("action_latest_shipment_status"),
        latestShipmentRawStatus: sql<string | null>`(SELECT ${deliveryShipments.rawStatus} FROM ${deliveryShipments}
            WHERE ${deliveryShipments.orderId} = ${OUTER} ORDER BY ${deliveryShipments.createdAt} DESC, ${deliveryShipments.id} DESC LIMIT 1)`.as("action_latest_shipment_raw_status"),
        refundLocksOrder: sql<number>`NOT (${noRefundLocksOrderForColumnCondition(OUTER)})`.mapWith(Number).as("action_refund_locks_order"),
        refundInFlight: sql<number>`NOT (${noActiveRefundAttemptForOrderColumnCondition(OUTER)})`.mapWith(Number).as("action_refund_in_flight"),
        paymentSessionActive: sql<number>`${activePaymentSessionAttemptExistsCondition(OUTER)}`.mapWith(Number).as("action_payment_session_active"),
        paymentRecordsSettled: sql<number>`CASE WHEN ${cancellationPaymentRecordsSafeCondition(OUTER)} THEN 1 ELSE 0 END`.mapWith(Number).as("action_payment_records_settled"),
        giftCardOnly: sql<number>`CASE WHEN ${orders.paidAmountMinor} > 0
            AND ${orders.paymentStatus} IN (${PaymentStatus.PAID}, ${PaymentStatus.PARTIAL})
            AND ${giftCardMinor} = ${orders.paidAmountMinor} AND ${otherMoneyRows} = 0
            AND ${heldTenderMinor} = ${orders.paidAmountMinor} THEN 1 ELSE 0 END`.mapWith(Number).as("action_gift_card_only"),
        paymentPlanStatus: sql<string | null>`(SELECT ${paymentPlans.status} FROM ${paymentPlans} WHERE ${paymentPlans.orderId} = ${OUTER})`.as("action_payment_plan_status"),
    };
}

const ACTION_FACT_KEYS = Object.keys(orderActionFactsSelection());

/** The row without the facts the read did not also select for itself (`own`, its own selection). */
export function withoutActionFacts<T extends object>(row: T, own: object): T {
    const rest = { ...row } as Record<string, unknown>;
    for (const key of ACTION_FACT_KEYS) if (!(key in own)) delete rest[key];
    return rest as T;
}

/** One order's selected facts (`orderActionFactsSelection`). */
export interface OrderActionFactsRow {
    id: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string | null;
    fulfillmentStatus: string;
    paidAmountMinor: number;
    totalAmountMinor: number;
    balanceDueMinor: number;
    disputedMinor: number;
    paymentTermsDays: number | null;
    requiresShipping: boolean;
    pickupReadyAt: unknown;
    shippingMethodKind: string | null;
    shipmentClaimId: string | null;
    shipmentClaimExpiresAt: unknown;
    shipmentClaimShipmentStatus: string | null;
    onHold: number;
    cancellationRequested: number;
    codStatus: string | null;
    shipLeft: number;
    pickupLeft: number;
    serviceLeft: number;
    shipSent: number;
    handedOver: number;
    latestShipmentStatus: string | null;
    latestShipmentRawStatus: string | null;
    refundLocksOrder: number;
    refundInFlight: number;
    paymentSessionActive: number;
    paymentRecordsSettled: number;
    giftCardOnly: number;
    paymentPlanStatus: string | null;
}

/** The actions an order's selected facts decide. */
export function orderActionsFromFacts(facts: OrderActionFactsRow, nowSeconds = Math.floor(Date.now() / 1000)): OrderAdminActions {
    const latestShipment = facts.latestShipmentStatus === null
        ? null
        : { status: facts.latestShipmentStatus, rawStatus: facts.latestShipmentRawStatus } as Parameters<typeof buildShipmentRecoverySummary>[1];
    const shipmentRecovery = buildShipmentRecoverySummary({
        id: facts.id,
        status: facts.status,
        paymentStatus: facts.paymentStatus,
        paymentMethod: facts.paymentMethod,
        shipmentClaimId: facts.shipmentClaimId,
        shipmentClaimExpiresAt: facts.shipmentClaimExpiresAt as never,
    }, latestShipment, nowSeconds);
    return presentOrderActions({
        status: facts.status,
        onHold: facts.onHold,
        openRequestType: facts.cancellationRequested ? "cancel_pre_shipment" : null,
        codStatus: facts.codStatus,
        requiresShipping: facts.requiresShipping,
        pickupReadyAt: facts.pickupReadyAt,
        shippingMethodKind: facts.shippingMethodKind,
        disputedMinor: facts.disputedMinor,
        paymentStatus: facts.paymentStatus,
        paymentMethod: facts.paymentMethod,
        fulfillmentStatus: facts.fulfillmentStatus,
        paidAmountMinor: facts.paidAmountMinor,
        totalAmountMinor: facts.totalAmountMinor,
        balanceDueMinor: facts.balanceDueMinor,
        paymentTermsDays: facts.paymentTermsDays,
    }, {
        units: summarizeHandOverUnits([
            { fulfillmentType: "ship", left: facts.shipLeft, handedOver: facts.shipSent },
            { fulfillmentType: "pickup", left: facts.pickupLeft, handedOver: 0 },
            { fulfillmentType: "service", left: facts.serviceLeft, handedOver: facts.handedOver - facts.shipSent },
        ]),
        latestShipment: latestShipment && { status: latestShipment.status },
        refundLocksOrder: Boolean(facts.refundLocksOrder),
        refundInFlight: Boolean(facts.refundInFlight),
        shipmentRecovery: { activeLock: shipmentRecovery.activeLock },
        paymentRecovery: { activeProcessing: Boolean(facts.paymentSessionActive) },
        money: {
            paymentRecordsSettled: Boolean(facts.paymentRecordsSettled),
            giftCardOnly: Boolean(facts.giftCardOnly),
            paymentPlanStatus: facts.paymentPlanStatus,
        },
    });
}
