// Pure presentation of the Wave A order-line facts: the fulfilment type, the
// handed-over quantity, the frozen buyer inputs, and the pickup snapshot.
// Shared by the receipt, the account order, the dashboard detail, invoices,
// emails and the CSV export so every surface reads the snapshot the same way.
import {
    isLineInputEntry,
    readOrderLineBundle,
    readOrderLineProperties,
    type OrderLineBundle,
    type ResolvedLineProperty,
} from "@scalius/shared/line-properties";
import { isAppScopedKey } from "@scalius/shared/plugins/ids";
import type { BuyerUiOrderLine } from "@scalius/shared/plugins";
import { MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import { LINE_ADD_ONS_MAX, LINE_PROPERTY_INPUT_LIMITS } from "@scalius/shared/line-identity";
import { isFulfillmentType, type DeliveryMethodKind, type FulfillmentType } from "@scalius/shared/fulfilment";
import { fromMinor } from "@scalius/shared/money";
import type { BuyerLineAddOn } from "@scalius/shared/add-on-folding";

export interface PresentedOrderLineProperty extends ResolvedLineProperty {
    price: number;
}

export interface OrderLineFulfilmentFacts {
    fulfillmentType: FulfillmentType;
    fulfilledQuantity: number;
    properties: PresentedOrderLineProperty[];
    propertiesPrice: number;
    propertiesPriceMinor: number;
    baseUnitPriceMinor: number | null;
    /** The bundle the line was bought in (a store kit or an app's), as apps read it; null for a plain line. Only when asked for. */
    bundle?: OrderLineBundle | null;
}

export interface OrderLineFulfilmentRow {
    fulfillmentType: string | null;
    fulfilledQuantity: number | null;
    properties: string | null;
    propertiesPriceMinor: number | null;
    baseUnitPriceMinor: number | null;
    /** The line's quantity, to read its bundle (its units are read against it); absent: no bundle is read. */
    bundleQuantity?: number;
}

export function presentOrderLineFulfilment(
    row: OrderLineFulfilmentRow,
    decimalPlaces: number,
): OrderLineFulfilmentFacts {
    const propertiesPriceMinor = row.propertiesPriceMinor ?? 0;
    return {
        fulfillmentType: isFulfillmentType(row.fulfillmentType) ? row.fulfillmentType : "ship",
        fulfilledQuantity: row.fulfilledQuantity ?? 0,
        properties: readOrderLineProperties(row.properties).map((property) => ({
            ...property,
            price: fromMinor(property.priceMinor, decimalPlaces),
        })),
        propertiesPrice: fromMinor(propertiesPriceMinor, decimalPlaces),
        propertiesPriceMinor,
        baseUnitPriceMinor: row.baseUnitPriceMinor ?? null,
        ...(row.bundleQuantity === undefined ? {} : { bundle: readOrderLineBundle(row.properties, row.bundleQuantity) }),
    };
}

/** A buyer row's app add-ons (`BuyerOrderLine.addOns`, exact totals) with their amounts in major units too: "Protection ৳350" per item. */
export function presentBuyerLineAddOns(addOns: readonly BuyerLineAddOn[], decimalPlaces: number): Array<BuyerLineAddOn & { amount: number | null; total: number }> {
    return addOns.map((addOn) => ({
        ...addOn,
        amount: addOn.amountMinor === null ? null : fromMinor(addOn.amountMinor, decimalPlaces),
        total: fromMinor(addOn.totalMinor, decimalPlaces),
    }));
}

/** A buyer's order row as the order's UI slots read it (`buyerUiOrderLines`). */
export interface BuyerUiOrderRow {
    id: string;
    lineIds: readonly string[];
    productId: string;
    variantId: string | null;
    productName: string | null;
    variantLabel: string | null;
    quantity: number;
    unitsTotalMinor: number;
    bundle: OrderLineBundle | null;
    /** The row's app add-ons, as `foldBuyerOrderLines` reads them. */
    addOns: readonly BuyerLineAddOn[];
    properties: readonly ResolvedLineProperty[];
}

/**
 * Every buyer row's facts for the order's UI slots (`input.orderLines`; the
 * per-line slot `order.line.after` draws under each): its key and real
 * lines, product, title, units and their total, bundle, every app's add-ons
 * as frozen and the apps' line answers frozen on it (every app's here; each
 * app's run is scoped to its own). A row whose SKU is gone is left out, as
 * `order.lines` leaves it out.
 */
export function buyerUiOrderLines(rows: readonly BuyerUiOrderRow[]): BuyerUiOrderLine[] {
    return rows.slice(0, MAX_ORDER_LINES).flatMap((row): BuyerUiOrderLine[] => {
        if (!row.variantId || row.quantity < 1) return [];
        const name = row.productName ?? "";
        return [{
            lineKey: row.id,
            lineIds: [...row.lineIds],
            productId: row.productId,
            variantId: row.variantId,
            title: (row.variantLabel ? `${name} (${row.variantLabel})` : name).slice(0, 300),
            quantity: row.quantity,
            unitsTotalMinor: Math.max(0, row.unitsTotalMinor),
            bundle: row.bundle
                ? { id: row.bundle.id, title: row.bundle.title.slice(0, 300), kind: row.bundle.kind, anchor: row.bundle.anchor, units: row.bundle.units, perUnit: row.bundle.perUnit }
                : null,
            // Within the bounds one app's facts keep (a line's add-ons), as the cart's line facts are.
            addOns: row.addOns.slice(0, LINE_ADD_ONS_MAX).map(({ appId, title, totalMinor, amountMinor, per }) => ({ appId, title: title.slice(0, 80), totalMinor, amountMinor, per })),
            // Every app's answers on the row (each app's run keeps its own), at most a line's entries.
            inputs: row.properties
                .filter((property) => isAppScopedKey(property.key) && isLineInputEntry(property.key))
                .slice(0, LINE_PROPERTY_INPUT_LIMITS.entries)
                .map((property) => ({ key: property.key, value: property.value.slice(0, LINE_PROPERTY_INPUT_LIMITS.valueLength) })),
        }];
    });
}

/** "Engraving: Anika (+৳200)" lines, for plain-text surfaces (CSV, SMS never). */
export function formatOrderLinePropertiesText(
    properties: readonly ResolvedLineProperty[],
    formatPrice: (priceMinor: number) => string,
): string[] {
    return properties.map((property) => property.priceMinor > 0
        ? `${property.label}: ${property.displayValue} (+${formatPrice(property.priceMinor)})`
        : `${property.label}: ${property.displayValue}`);
}

export interface OrderPickupRow {
    shippingMethodKind: string | null;
    pickupAddress: string | null;
    pickupHours: string | null;
    pickupReadyAt: Date | number | null;
}

export interface OrderPickupView {
    address: string | null;
    hours: string | null;
    readyAt: string | null;
}

function toIsoString(value: Date | number | null): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function presentOrderPickup(order: OrderPickupRow): OrderPickupView | null {
    if (order.shippingMethodKind !== "pickup") return null;
    return {
        address: order.pickupAddress,
        hours: order.pickupHours,
        readyAt: toIsoString(order.pickupReadyAt),
    };
}

export function presentShippingMethodKind(value: string | null | undefined): DeliveryMethodKind | null {
    return value === "delivery" || value === "pickup" ? value : null;
}

// ── Fulfilment ledger views (read by ./fulfilment-reads) ──

export interface OrderFulfilmentLineView {
    orderItemId: string;
    quantity: number;
}

export interface OrderFulfilmentTrackingView {
    shipmentId: string;
    courierName: string | null;
    trackingId: string | null;
    trackingUrl: string | null;
    status: string;
}

export interface BuyerOrderFulfilmentView {
    id: string;
    kind: FulfillmentType;
    createdAt: string | null;
    lines: OrderFulfilmentLineView[];
    tracking: OrderFulfilmentTrackingView | null;
}

/** Why a fulfilment can't be voided right now; the dashboard words each one. */
export const FULFILMENT_VOID_BLOCKED_REASONS = [
    "voided",
    "courier",
    "delivered",
    "order_not_confirmed",
] as const;
export type FulfilmentVoidBlockedReason = (typeof FULFILMENT_VOID_BLOCKED_REASONS)[number];

export interface AdminOrderFulfilmentView extends BuyerOrderFulfilmentView {
    status: "active" | "voided";
    actorType: "admin" | "system";
    /** Cash taken in the same action (pickup counter or service), in major units. */
    cashCollected: number | null;
    voidedAt: string | null;
    /** The void action is allowed now (the same rule the void route enforces). */
    canVoid: boolean;
    voidBlockedReason: FulfilmentVoidBlockedReason | null;
}

/**
 * The void rule (fulfilment/ledger.ts `voidOrderFulfilment`): an active
 * own-rider parcel, pickup or service fulfilment of an order still
 * confirmed. Courier-booked parcels follow the courier's status.
 */
export function fulfilmentVoidBlockedReason(input: {
    status: "active" | "voided";
    shipmentId: string | null;
    shipmentProviderType: string | null;
    shipmentProviderId: string | null;
    shipmentStatus: string | null;
    orderStatus: string;
}): FulfilmentVoidBlockedReason | null {
    if (input.status === "voided") return "voided";
    if (input.shipmentId && (input.shipmentProviderType !== "manual" || input.shipmentProviderId)) return "courier";
    if (input.shipmentStatus === "delivered") return "delivered";
    if (input.orderStatus !== "confirmed") return "order_not_confirmed";
    return null;
}
