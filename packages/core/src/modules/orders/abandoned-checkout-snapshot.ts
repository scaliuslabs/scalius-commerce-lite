import { validateAndFormatPhone } from "@scalius/shared/customer-utils";

const MAX_TEXT_LENGTH = 500;
const MAX_NOTES_LENGTH = 1_000;
const MAX_CART_ITEMS = 100;
const MAX_OPTIONS_PER_ITEM = 10;
const MAX_SNAPSHOT_BYTES = 128 * 1024;

type UnknownRecord = Record<string, unknown>;

export interface AbandonedCheckoutSnapshotInput {
    checkoutId: string;
    customerPhone?: string;
    checkoutData: UnknownRecord;
}

export interface NormalizedAbandonedCheckoutSnapshot {
    checkoutId: string;
    customerPhone: string | null;
    checkoutData: UnknownRecord;
    checkoutDataString: string;
}

export interface AbandonedCheckoutAgentSummary {
    kind: "cart" | "stale_hosted_payment_order" | "unknown";
    stage: "session_created" | "cart_started" | "info_captured" | "archived_hosted_payment" | "unreadable";
    itemCount: number;
    total: number;
    hasCustomerContact: boolean;
    orderId: string | null;
    paymentMethod: "stripe" | "sslcommerz" | "polar" | null;
    paymentStatus: "unpaid" | "failed" | null;
}

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function finiteMoney(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.min(1_000_000_000_000, value)
        : null;
}

/** Compact agent list projection. Buyer identity and raw checkout JSON stay out. */
export function projectAbandonedCheckoutAgentSummary(
    checkoutData: string,
    storedPhone: string | null | undefined,
): AbandonedCheckoutAgentSummary {
    const hasStoredPhone = normalizeOptionalPhone(storedPhone) !== undefined;
    try {
        const data = asRecord(JSON.parse(checkoutData));
        if (!data) throw new Error("Checkout data is not an object");

        const paymentMethod = data.paymentMethod === "stripe"
            || data.paymentMethod === "sslcommerz"
            || data.paymentMethod === "polar"
            ? data.paymentMethod
            : null;
        const paymentStatus = data.paymentStatus === "unpaid" || data.paymentStatus === "failed"
            ? data.paymentStatus
            : null;
        const orderId = cleanText(data.id, 160) ?? null;
        if (orderId && paymentMethod && paymentStatus) {
            return {
                kind: "stale_hosted_payment_order",
                stage: "archived_hosted_payment",
                itemCount: 0,
                total: finiteMoney(data.totalAmount) ?? 0,
                hasCustomerContact: hasStoredPhone || Boolean(
                    normalizeOptionalPhone(data.customerPhone) || cleanText(data.customerEmail, 320),
                ),
                orderId,
                paymentMethod,
                paymentStatus,
            };
        }

        const cart = asRecord(data.cart);
        const itemCount = Array.isArray(cart?.items)
            ? Math.min(MAX_CART_ITEMS, cart.items.length)
            : 0;
        const hasCustomerContact = hasStoredPhone || Boolean(
            normalizeOptionalPhone(data.customerPhone)
            || cleanText(data.customerEmail, 320)
            || cleanText(data.customerName, 160)
            || cleanText(data.shippingAddress, MAX_TEXT_LENGTH),
        );
        return {
            kind: "cart",
            stage: hasCustomerContact
                ? "info_captured"
                : itemCount > 0
                    ? "cart_started"
                    : "session_created",
            itemCount,
            total: finiteMoney(cart?.totalAmount) ?? 0,
            hasCustomerContact,
            orderId: null,
            paymentMethod: null,
            paymentStatus: null,
        };
    } catch {
        return {
            kind: "unknown",
            stage: "unreadable",
            itemCount: 0,
            total: 0,
            hasCustomerContact: hasStoredPhone,
            orderId: null,
            paymentMethod: null,
            paymentStatus: null,
        };
    }
}

function cleanText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().slice(0, maxLength);
    return normalized || undefined;
}

function normalizeOptionalPhone(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > 32) return undefined;

    try {
        return validateAndFormatPhone(normalized);
    } catch {
        return undefined;
    }
}

function cleanMoney(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.min(1_000_000_000_000, Math.max(0, value));
}

function cleanQuantity(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const normalized = Math.floor(value);
    return normalized > 0 && normalized <= 99 ? normalized : undefined;
}

function compact<T extends UnknownRecord>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter(([, field]) => field !== undefined),
    ) as T;
}

function normalizeOptions(value: unknown): UnknownRecord[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const options = value
        .slice(0, MAX_OPTIONS_PER_ITEM)
        .map((candidate) => {
            const option = asRecord(candidate);
            if (!option) return null;
            const name = cleanText(option.name, 100);
            const optionValue = cleanText(option.value, 200);
            return name && optionValue ? { name, value: optionValue } : null;
        })
        .filter((option): option is { name: string; value: string } => option !== null);
    return options.length > 0 ? options : undefined;
}

function normalizeCartItems(value: unknown): UnknownRecord[] {
    if (!Array.isArray(value)) return [];

    const normalized: UnknownRecord[] = [];
    for (const candidate of value.slice(0, MAX_CART_ITEMS)) {
        const item = asRecord(candidate);
        if (!item) continue;
        const id = cleanText(item.id, 160);
        const name = cleanText(item.name, 200);
        const quantity = cleanQuantity(item.quantity);
        const price = cleanMoney(item.price);
        if (!id || !name || quantity === undefined || price === undefined) continue;

        normalized.push(compact({
            id,
            variantId: cleanText(item.variantId, 160),
            slug: cleanText(item.slug, 200),
            name,
            quantity,
            price,
            imageMediaId: cleanText(item.imageMediaId, 160),
            options: normalizeOptions(item.options),
            freeDelivery: typeof item.freeDelivery === "boolean" ? item.freeDelivery : undefined,
        }));
    }
    return normalized;
}

function normalizeDiscount(value: unknown): UnknownRecord | null {
    const discount = asRecord(value);
    if (!discount) return null;

    const normalized = compact({
        code: cleanText(discount.code, 100),
        type: cleanText(discount.type, 100),
        valueType: cleanText(discount.valueType, 100),
        discountValue: cleanMoney(discount.discountValue),
        discountAmount: cleanMoney(discount.discountAmount),
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeCheckoutData(value: UnknownRecord): UnknownRecord {
    const cart = asRecord(value.cart);
    const shipping = asRecord(value.shipping);
    const items = normalizeCartItems(cart?.items);

    return compact({
        customerName: cleanText(value.customerName, 160),
        customerPhone: normalizeOptionalPhone(value.customerPhone),
        customerEmail: cleanText(value.customerEmail, 320),
        shippingAddress: cleanText(value.shippingAddress, MAX_TEXT_LENGTH),
        notes: cleanText(value.notes, MAX_NOTES_LENGTH),
        city: cleanText(value.city, 160),
        zone: cleanText(value.zone, 160),
        area: cleanText(value.area, 160),
        cityName: cleanText(value.cityName, 160),
        zoneName: cleanText(value.zoneName, 160),
        areaName: cleanText(value.areaName, 160),
        cart: {
            items,
            totalAmount: cleanMoney(cart?.totalAmount)
                ?? items.reduce((total, item) => total + Number(item.price) * Number(item.quantity), 0),
            discount: normalizeDiscount(cart?.discount),
        },
        shipping: shipping
            ? compact({
                id: cleanText(shipping.id, 160),
                fee: cleanMoney(shipping.fee),
            })
            : undefined,
    });
}

export function normalizeAbandonedCheckoutSnapshot(
    input: AbandonedCheckoutSnapshotInput,
): NormalizedAbandonedCheckoutSnapshot {
    const checkoutId = input.checkoutId.trim();
    if (!/^chk_session_[A-Za-z0-9_-]{16,64}$/.test(checkoutId)) {
        throw new Error("Invalid checkout session identifier");
    }

    const checkoutData = normalizeCheckoutData(input.checkoutData);
    const checkoutDataString = JSON.stringify(checkoutData);
    if (new TextEncoder().encode(checkoutDataString).byteLength > MAX_SNAPSHOT_BYTES) {
        throw new Error("Checkout snapshot is too large");
    }

    return {
        checkoutId,
        customerPhone: normalizeOptionalPhone(input.customerPhone)
            ?? normalizeOptionalPhone(checkoutData.customerPhone)
            ?? null,
        checkoutData,
        checkoutDataString,
    };
}
