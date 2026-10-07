// The dashboard order detail read.
import { orderShippingAddressSelection } from "../shipping-address";
import { orderBillingAddressSelection } from "../billing-address";
import type { Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    customers,
    media,
    deliveryShipments,
    deliveryProviders,
    codTracking,
    inventoryLocations,
} from "@scalius/database/schema";
import { listOrderDiscountLines } from "../../promotions";
import { type OrderAppFactRow, resolveOrderAppFacts, selectOrderAppFactRows } from "../../order-kernel";
import { listOrderHolds } from "../holds";
import { sql, desc, eq } from "drizzle-orm";
import { customerKind } from "../../customers";
import { fromMinor } from "@scalius/shared/money";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { unixToDate } from "@scalius/shared/utils";
import type { OrderDetails, OrderShipmentSummary } from "../types";
import { orderMoneyAmounts, orderMoneySelection } from "../money";
import {
  listOrderPaymentSessionAttempts,
  listOrderRefundAttempts,
  summarizeActiveRefundOperation,
} from "../../payments";
import { listOrderSupportRequests } from "../order-support-requests";
import { getCurrentPublicMediaUrl } from "../../../integrations/storage";
import { publishedMediaObjectKey } from "../../media-references";
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
import { presentOrderLineFulfilment, presentOrderPickup } from "../line-presentation";
import { findOrderConversationForStaff, listAdminOrderFulfilments } from "../fulfilment-reads";

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
    "hasHandedOverItem",
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
            customerWhatsapp: orders.customerWhatsapp,
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
            ...orderShippingAddressSelection(orders),
            ...orderBillingAddressSelection(orders),
            pickupAddress: orders.pickupAddress,
            pickupHours: orders.pickupHours,
            version: orders.version,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${orders.deletedAt} AS INTEGER)`,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            fulfillmentLocationId: orders.fulfillmentLocationId,
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            ...orderEditEvidenceSelection(),
            ...orderListFactsSelection(),
        })
        .from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .where(eq(orders.id, id))
        .get();

    const [order, items, latestShipments, refundAttemptViews, supportRequests, promotionRows, paymentAttempts] = await Promise.all([
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
                inventoryTracked: orderItems.inventoryTracked,
                unitPriceMinor: orderItems.unitPriceMinor,
                lineSubtotalMinor: orderItems.lineSubtotalMinor,
                discountAmountMinor: orderItems.discountAmountMinor,
                taxableAmountMinor: orderItems.taxableAmountMinor,
                taxAmountMinor: orderItems.taxAmountMinor,
                fulfillmentType: orderItems.fulfillmentType,
                fulfilledQuantity: orderItems.fulfilledQuantity,
                properties: orderItems.properties,
                propertiesPriceMinor: orderItems.propertiesPriceMinor,
                baseUnitPriceMinor: orderItems.baseUnitPriceMinor,
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

    if (!order) return null;
    // A second wave keeps the read within six simultaneous D1 connections.
    const [orderExtras, fulfillments, conversation, appRiskRows, holdsByOrder] = await Promise.all([
        // D1 refuses a result set over 100 columns, so the order row is read in two statements on its key.
        db
            .select({
                // The money chain (MARKETS-DESIGN D3): shown when the buyer paid in another currency.
                shopCurrency: orders.shopCurrency,
                fxRate: orders.fxRate,
                fxSource: orders.fxSource,
                fxAsOf: sql<number | null>`CAST(${orders.fxAsOf} AS INTEGER)`,
                fxLockedUntil: sql<number | null>`CAST(${orders.fxLockedUntil} AS INTEGER)`,
                subtotalShopMinor: orders.subtotalShopMinor,
                shippingShopMinor: orders.shippingShopMinor,
                discountShopMinor: orders.discountShopMinor,
                taxShopMinor: orders.taxShopMinor,
                totalShopMinor: orders.totalShopMinor,
                // Where the order's stock leaves from: its own location, else the default.
                effectiveFulfillmentLocationId: sql<string | null>`COALESCE(${orders.fulfillmentLocationId}, (
                    SELECT ${inventoryLocations.id} FROM ${inventoryLocations}
                    WHERE ${inventoryLocations.isDefault} = 1 AND ${inventoryLocations.status} = 'active'
                ))`,
                effectiveFulfillmentLocationName: sql<string | null>`(
                    SELECT ${inventoryLocations.name} FROM ${inventoryLocations}
                    WHERE ${inventoryLocations.id} = COALESCE(${orders.fulfillmentLocationId}, (
                        SELECT default_location.id FROM ${inventoryLocations} AS default_location
                        WHERE default_location.is_default = 1 AND default_location.status = 'active'
                    ))
                )`,
                // The record the order is filed under: its title can differ from the order's own name.
                recordId: customers.id,
                recordName: customers.name,
                recordPhone: customers.phone,
                recordAccountClaimedAt: customers.accountClaimedAt,
                recordOrigin: customers.origin,
            })
            .from(orders)
            .leftJoin(customers, eq(customers.id, orders.customerId))
            .where(eq(orders.id, id))
            .get(),
        listAdminOrderFulfilments(db, id, order.currencyDecimalPlaces, order.status),
        findOrderConversationForStaff(db, id),
        selectOrderAppFactRows(db, [id], ["app_risk"]).all() as Promise<OrderAppFactRow[]>,
        listOrderHolds(db, [id]),
    ]);
    if (!orderExtras) return null;
    const {
        recordId,
        recordName,
        recordPhone,
        recordAccountClaimedAt,
        recordOrigin,
        effectiveFulfillmentLocationId,
        effectiveFulfillmentLocationName,
        shopCurrency,
        fxRate,
        fxSource,
        fxAsOf,
        fxLockedUntil,
        subtotalShopMinor,
        shippingShopMinor,
        discountShopMinor,
        taxShopMinor,
        totalShopMinor,
    } = orderExtras;
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
        inventoryTracked: item.inventoryTracked,
        unitPriceMinor: item.unitPriceMinor,
        lineSubtotalMinor: item.lineSubtotalMinor,
        discountAmountMinor: item.discountAmountMinor,
        taxableAmountMinor: item.taxableAmountMinor,
        taxAmountMinor: item.taxAmountMinor,
        ...presentOrderLineFulfilment(item, order.currencyDecimalPlaces),
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
    const shopAmount = (minor: number) => fromMinor(minor, getDecimalPlaces(shopCurrency));

    return {
        ...publicOrder,
        ...orderMoneyAmounts(order),
        moneyChain: order.currencyCode && shopCurrency && order.currencyCode !== shopCurrency
            ? {
                shopCurrencyCode: shopCurrency,
                rate: fxRate,
                source: fxSource,
                asOf: fxAsOf ? new Date(fxAsOf * 1_000).toISOString() : null,
                lockedUntil: fxLockedUntil ? new Date(fxLockedUntil * 1_000).toISOString() : null,
                subtotalShopAmount: shopAmount(subtotalShopMinor),
                shippingShopAmount: shopAmount(shippingShopMinor),
                discountShopAmount: shopAmount(discountShopMinor),
                taxShopAmount: shopAmount(taxShopMinor),
                totalShopAmount: shopAmount(totalShopMinor),
            }
            : null,
        ...presentOrderListFacts(order),
        pickup: presentOrderPickup({
            shippingMethodKind: order.shippingMethodKind,
            pickupAddress: order.pickupAddress,
            pickupHours: order.pickupHours,
            pickupReadyAt: order.pickupReadyAt,
        }),
        fulfillments,
        conversation,
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
        discounts: promotionRows.map((row) => ({
            source: row.appId ? "app" as const : "promotion" as const,
            promotionId: row.promotionId,
            appId: row.appId,
            appName: row.appName,
            name: row.title,
            code: row.code,
            method: row.method,
            kind: row.kind,
            amount: fromMinor(row.amountMinor + row.shippingAmountMinor, order.currencyDecimalPlaces),
            shippingAmount: fromMinor(row.shippingAmountMinor, order.currencyDecimalPlaces),
        })),
        /** Apps' advisory risk checks, newest first: shown to the merchant, never acted on. */
        appRiskChecks: resolveOrderAppFacts(appRiskRows).riskChecks.map((check) => ({
            appId: check.pluginId,
            appName: check.appName,
            level: check.level,
            reasons: check.reasons,
            checkedAt: check.checkedAt,
        })),
        holds: (holdsByOrder.get(id) ?? []).map((hold) => ({
            id: hold.id,
            appId: hold.pluginId,
            appName: hold.appName,
            reason: hold.reason,
            placedAt: new Date(hold.createdAt * 1000),
            releasedAt: hold.releasedAt === null ? null : new Date(hold.releasedAt * 1000),
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
        fulfillmentLocation: effectiveFulfillmentLocationId && effectiveFulfillmentLocationName
            ? {
                id: effectiveFulfillmentLocationId,
                name: effectiveFulfillmentLocationName,
                explicit: order.fulfillmentLocationId !== null,
            }
            : null,
        customerRecord: customerRecord
            ? { id: customerRecord.id, name: customerRecord.name, phone: customerRecord.phone, kind: customerKind(customerRecord) }
            : null,
    };
}
