// Pure presentation of the Wave A order-line facts: the fulfilment type, the
// handed-over quantity, the frozen buyer inputs, and the pickup snapshot.
// Shared by the receipt, the account order, the dashboard detail, invoices,
// emails and the CSV export so every surface reads the snapshot the same way.
import {
    CUSTOMIZATION_FIELD_TYPES,
    type CustomizationFieldType,
    type ResolvedLineProperty,
} from "@scalius/shared/line-properties";
import { isFulfillmentType, type DeliveryMethodKind, type FulfillmentType } from "@scalius/shared/fulfilment";
import { fromMinor } from "@scalius/shared/money";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the frozen `order_items.properties` snapshot. The column is written
 * only by the commit (and is immutable), so a malformed entry is skipped
 * rather than failing the whole order read.
 */
export function parseOrderLineProperties(stored: string | null | undefined): ResolvedLineProperty[] {
    if (!stored) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const properties: ResolvedLineProperty[] = [];
    for (const entry of parsed) {
        if (!isRecord(entry)) continue;
        const { key, type, label, value, displayValue, priceMinor } = entry;
        if (
            typeof key !== "string"
            || typeof label !== "string"
            || typeof value !== "string"
            || !(CUSTOMIZATION_FIELD_TYPES as readonly string[]).includes(type as string)
        ) continue;
        properties.push({
            key,
            type: type as CustomizationFieldType,
            label,
            value,
            displayValue: typeof displayValue === "string" ? displayValue : value,
            priceMinor: typeof priceMinor === "number" && Number.isSafeInteger(priceMinor) && priceMinor >= 0
                ? priceMinor
                : 0,
        });
    }
    return properties;
}

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
}

export interface OrderLineFulfilmentRow {
    fulfillmentType: string | null;
    fulfilledQuantity: number | null;
    properties: string | null;
    propertiesPriceMinor: number | null;
    baseUnitPriceMinor: number | null;
}

export function presentOrderLineFulfilment(
    row: OrderLineFulfilmentRow,
    decimalPlaces: number,
): OrderLineFulfilmentFacts {
    const propertiesPriceMinor = row.propertiesPriceMinor ?? 0;
    return {
        fulfillmentType: isFulfillmentType(row.fulfillmentType) ? row.fulfillmentType : "ship",
        fulfilledQuantity: row.fulfilledQuantity ?? 0,
        properties: parseOrderLineProperties(row.properties).map((property) => ({
            ...property,
            price: fromMinor(property.priceMinor, decimalPlaces),
        })),
        propertiesPrice: fromMinor(propertiesPriceMinor, decimalPlaces),
        propertiesPriceMinor,
        baseUnitPriceMinor: row.baseUnitPriceMinor ?? null,
    };
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

export interface AdminOrderFulfilmentView extends BuyerOrderFulfilmentView {
    status: "active" | "voided";
    actorType: "admin" | "system";
    /** Cash taken in the same action (pickup counter or service), in major units. */
    cashCollected: number | null;
    voidedAt: string | null;
}
