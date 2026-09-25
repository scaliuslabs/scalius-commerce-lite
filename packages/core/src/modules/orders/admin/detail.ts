// The dashboard order detail read.
import type { Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    customers,
    media,
    deliveryShipments,
    deliveryProviders,
    codTracking,
} from "@scalius/database/schema";
import { listOrderDiscountLines } from "../../promotions/order-discount-lines";
import { sql, desc, eq } from "drizzle-orm";
import { customerKind } from "../../customers/customer-identity";
import { fromMinor } from "@scalius/shared/money";
import { unixToDate } from "@scalius/shared/utils";
import type { OrderDetails, OrderShipmentSummary } from "../types";
import { orderMoneyAmounts, orderMoneySelection } from "../money";
import {
    listOrderRefundAttempts,
    summarizeActiveRefundOperation,
} from "../../payments/refund-attempt-visibility";
import { listOrderPaymentSessionAttempts } from "../../payments/payment-session-attempts";
import { listOrderSupportRequests } from "../order-support-requests";
import { getCurrentPublicMediaUrl } from "../../../integrations/storage";
import { publishedMediaObjectKey } from "../../media/media.presentation";
import { retryTransientD1 } from "../../../utils/transient-d1";
import {
    paymentRecoveryLifecycleCondition,
    orderEditEvidenceSelection,
    orderListFactsSelection,
    presentOrderListFacts,
    buildShipmentRecoverySummary,
    buildPaymentRecoverySummary,
} from "./shared";
import { buildOrderEditReadiness } from "./readiness";

const ORDER_EDIT_EVIDENCE_KEYS = [
    "inventoryAction",
    "shipmentClaimId",
    "hasTaxSnapshot",
    "hasPaymentHistory",
    "hasPaymentSessionHistory",
    "hasShipmentHistory",
    "hasRefundHistory",
    "hasReturnHistory",
    "hasInvoiceHistory",
    "hasPaymentPlan",
    "hasPromotionAllocation",
    "hasNonPendingItem",
    "hasCleanCodTracking",
] as const;
type OrderEditEvidenceKey = (typeof ORDER_EDIT_EVIDENCE_KEYS)[number];

function omitOrderEditEvidence<T extends Record<OrderEditEvidenceKey, unknown>>(
    order: T,
): Omit<T, OrderEditEvidenceKey> {
    const publicOrder: Record<string, unknown> = { ...order };
    for (const key of ORDER_EDIT_EVIDENCE_KEYS) delete publicOrder[key];
    return publicOrder as Omit<T, OrderEditEvidenceKey>;
}

/**
 * Returns full order details including all items and variant info.
 * Returns null if the order does not exist.
 */
export async function getOrderDetails(
    db: Database,
    id: string,
): Promise<OrderDetails | null> {
    return retryTransientD1(() => getOrderDetailsOnce(db, id));
}

async function getOrderDetailsOnce(
    db: Database,
    id: string,
): Promise<OrderDetails | null> {
    // Every read is keyed by the order id, so they all go out in one wave
    // rather than waiting for the order row first.
    const orderRead = db
        .select({
            id: orders.id,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            customerId: orders.customerId,
            ...orderMoneySelection(orders),
            currencyCode: orders.currencyCode,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingMethodId: orders.shippingMethodId,
            shippingMethodName: orders.shippingMethodName,
            shippingMethodDescription: orders.shippingMethodDescription,
            shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
            shippingFeeWaived: orders.shippingFeeWaived,
            taxAmountMinor: orders.taxAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            status: orders.status,
            notes: orders.notes,
            shippingAddress: orders.shippingAddress,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            version: orders.version,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${orders.deletedAt} AS INTEGER)`,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            ...orderEditEvidenceSelection(),
            ...orderListFactsSelection(),
            // The record the order is filed under: its title can differ from the order's own name.
            recordId: customers.id,
            recordName: customers.name,
            recordPhone: customers.phone,
            recordAccountClaimedAt: customers.accountClaimedAt,
            recordOrigin: customers.origin,
        })
        .from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .leftJoin(customers, eq(customers.id, orders.customerId))
        .where(eq(orders.id, id))
        .get();

    const [orderRow, items, latestShipments, refundAttemptViews, supportRequests, promotionRows, paymentAttempts] = await Promise.all([
        orderRead,
        db
            .select({
                id: orderItems.id,
                productId: orderItems.productId,
                variantId: orderItems.variantId,
                quantity: orderItems.quantity,
                productName: orderItems.productName,
                productImageObjectKey: publishedMediaObjectKey(),
                productImageStatus: media.status,
                variantLabel: orderItems.variantLabel,
                fulfillmentStatus: orderItems.fulfillmentStatus,
                shippedQuantity: orderItems.shippedQuantity,
                inventoryTracked: orderItems.inventoryTracked,
                unitPriceMinor: orderItems.unitPriceMinor,
                lineSubtotalMinor: orderItems.lineSubtotalMinor,
                discountAmountMinor: orderItems.discountAmountMinor,
                taxableAmountMinor: orderItems.taxableAmountMinor,
                taxAmountMinor: orderItems.taxAmountMinor,
            })
            .from(orderItems)
            .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
            .where(eq(orderItems.orderId, id)),
        db
            .select({
                orderId: deliveryShipments.orderId,
                id: deliveryShipments.id,
                providerId: deliveryShipments.providerId,
                providerType: deliveryShipments.providerType,
                status: deliveryShipments.status,
                rawStatus: deliveryShipments.rawStatus,
                externalId: deliveryShipments.externalId,
                trackingId: deliveryShipments.trackingId,
                lastChecked: deliveryShipments.lastChecked,
                updatedAt: deliveryShipments.updatedAt,
                createdAt: deliveryShipments.createdAt,
                providerName: deliveryProviders.name,
            })
            .from(deliveryShipments)
            .leftJoin(
                deliveryProviders,
                eq(deliveryShipments.providerId, deliveryProviders.id),
            )
            .where(eq(deliveryShipments.orderId, id))
            .orderBy(desc(deliveryShipments.createdAt))
            .limit(1),
        listOrderRefundAttempts(db, id, { audience: "admin" }),
        listOrderSupportRequests(db, id),
        listOrderDiscountLines(db, id),
        listOrderPaymentSessionAttempts(db, id),
    ]);

    if (!orderRow) return null;
    const { recordId, recordName, recordPhone, recordAccountClaimedAt, recordOrigin, ...order } = orderRow;
    const customerRecord = recordId && recordName !== null && recordPhone !== null
        ? { id: recordId, name: recordName, phone: recordPhone, accountClaimedAt: recordAccountClaimedAt, origin: recordOrigin }
        : undefined;

    const formattedItems = items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        price: fromMinor(item.unitPriceMinor, order.currencyDecimalPlaces),
        productName: item.productName || null,
        productImage:
            item.productImageObjectKey &&
            (item.productImageStatus === "ready" || item.productImageStatus === "trashed")
                ? getCurrentPublicMediaUrl(item.productImageObjectKey)
                : null,
        variantLabel: item.variantLabel || null,
        fulfillmentStatus: item.fulfillmentStatus,
        shippedQuantity: item.shippedQuantity,
        inventoryTracked: item.inventoryTracked,
        unitPriceMinor: item.unitPriceMinor,
        lineSubtotalMinor: item.lineSubtotalMinor,
        discountAmountMinor: item.discountAmountMinor,
        taxableAmountMinor: item.taxableAmountMinor,
        taxAmountMinor: item.taxAmountMinor,
    }));

    const latestShipmentRow = latestShipments[0] ?? null;
    const latestShipment: OrderShipmentSummary | null = latestShipmentRow
        ? {
            id: latestShipmentRow.id,
            providerId: latestShipmentRow.providerId,
            providerType: latestShipmentRow.providerType,
            providerName: latestShipmentRow.providerName,
            status: latestShipmentRow.status,
            rawStatus: latestShipmentRow.rawStatus,
            externalId: latestShipmentRow.externalId,
            trackingId: latestShipmentRow.trackingId,
            lastChecked: unixToDate(latestShipmentRow.lastChecked),
            updatedAt: unixToDate(latestShipmentRow.updatedAt) ?? new Date(),
            createdAt: unixToDate(latestShipmentRow.createdAt) ?? new Date(),
        }
        : null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const {
        paymentRecoveryApplicable: _paymentRecoveryApplicable,
        codStatus: _codStatus,
        codDeliveryAttempts: _codDeliveryAttempts,
        returnedValueMinor: _returnedValueMinor,
        refundedMinor: _refundedMinor,
        ...publicOrder
    } = omitOrderEditEvidence(order);

    return {
        ...publicOrder,
        ...orderMoneyAmounts(order),
        ...presentOrderListFacts(order),
        // The address columns are nullable from migration 0083, but no order is
        // written without one until the address-optional contract (Wave A S3).
        shippingAddress: order.shippingAddress ?? "",
        city: order.city ?? "",
        zone: order.zone ?? "",
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
        discounts: promotionRows.map((row) => ({
            promotionId: row.promotionId,
            name: row.title,
            code: row.code,
            method: row.method,
            kind: row.kind,
            amount: fromMinor(row.amountMinor + row.shippingAmountMinor, order.currencyDecimalPlaces),
            shippingAmount: fromMinor(row.shippingAmountMinor, order.currencyDecimalPlaces),
        })),
        items: formattedItems,
        itemCount: formattedItems.length,
        latestShipment,
        shipmentRecovery: buildShipmentRecoverySummary(order, latestShipment, nowSeconds),
        refundAttempts: refundAttemptViews,
        activeRefundOperation: summarizeActiveRefundOperation(refundAttemptViews, "admin"),
        supportRequests,
        paymentRecovery: buildPaymentRecoverySummary(order, paymentAttempts, nowSeconds),
        editReadiness: buildOrderEditReadiness(order),
        customerRecord: customerRecord
            ? { id: customerRecord.id, name: customerRecord.name, phone: customerRecord.phone, kind: customerKind(customerRecord) }
            : null,
    };
}
