// The gift-card fulfiller (Wave B §4.2): one card, one `issue` transaction and
// one `gift_card_issued` outbox row per unit, in the auto-fulfil batch after
// the ledger insert, so a card exists exactly when its unit is handed over.
// Idempotent twice over: the fulfilment request key (`auto:gift_card:` and the units) fails a
// repeated run before any card, and `gift_cards_purchase_unit_unique`
// (order item, unit) would refuse a second card for the same unit.
//
// The card's value is the line's base unit price (gift-card products carry no
// discount; promotions and tax exclude them). The recipient comes from the
// reserved `_gc_` line properties and is a delivery target only; without one
// the card belongs to the order's account owner.
import type { BatchItem } from "drizzle-orm/batch";
import { eq } from "drizzle-orm";
import { orderItems, orders } from "@scalius/database/schema";
import {
    GIFT_CARD_LINE_PROPERTY_KEYS,
    buildGiftCardIssueStatements,
    deriveGiftCardKeys,
    giftCardExpiryFromMonths,
    normalizeGiftCardMessage,
    normalizeGiftCardRecipient,
    type GiftCardRecipient,
} from "../../gift-cards";
import { buildNotificationOutboxInsert } from "../../notifications";
import { readGiftCardSettings } from "../../settings";
import { ServiceUnavailableError } from "../../../errors";
import type { AutoFulfiller } from "../registry";
import { inJsonArray } from "../../../utils/in-json-array";

/** Reserved line-property keys, owned by the gift-cards domain (checkout validates them too). */
export { GIFT_CARD_LINE_PROPERTY_KEYS };

/** Recipient and message from a frozen `order_items.properties` snapshot. */
export function giftCardDeliveryFromProperties(properties: string | null): {
    recipient: GiftCardRecipient | null;
    message: string | null;
} {
    if (!properties) return { recipient: null, message: null };
    let entries: unknown;
    try {
        entries = JSON.parse(properties);
    } catch {
        return { recipient: null, message: null };
    }
    if (!Array.isArray(entries)) return { recipient: null, message: null };
    const value = (key: string): string | null => {
        const entry = entries.find((candidate: unknown) =>
            typeof candidate === "object" && candidate !== null && (candidate as { key?: unknown }).key === key);
        const raw = (entry as { value?: unknown } | undefined)?.value;
        return typeof raw === "string" ? raw : null;
    };
    return {
        recipient: normalizeGiftCardRecipient({
            name: value(GIFT_CARD_LINE_PROPERTY_KEYS.recipientName),
            email: value(GIFT_CARD_LINE_PROPERTY_KEYS.recipientEmail),
            phone: value(GIFT_CARD_LINE_PROPERTY_KEYS.recipientPhone),
        }),
        message: normalizeGiftCardMessage(value(GIFT_CARD_LINE_PROPERTY_KEYS.message)),
    };
}

export function giftCardIssuedDedupeKey(giftCardId: string): string {
    return `gift_card_issued:${giftCardId}`;
}

export const giftCardFulfiller: AutoFulfiller = {
    async prepare(db, context) {
        const keys = await deriveGiftCardKeys(context.credentialEncryptionKey);
        const settings = await readGiftCardSettings(db);
        if (!settings.ok) throw new ServiceUnavailableError("Gift-card settings can't be read; the cards will be issued on the next run.");
        const order = await db.select({
            currencyCode: orders.currencyCode,
            accountOwnerCustomerId: orders.accountOwnerCustomerId,
        }).from(orders).where(eq(orders.id, context.orderId)).get();
        if (!order) throw new Error(`Order ${context.orderId.slice(0, 12)} is missing.`);
        const items = await db.select({
            id: orderItems.id,
            quantity: orderItems.quantity,
            baseUnitPriceMinor: orderItems.baseUnitPriceMinor,
            unitPriceMinor: orderItems.unitPriceMinor,
            propertiesPriceMinor: orderItems.propertiesPriceMinor,
            properties: orderItems.properties,
        }).from(orderItems).where(inJsonArray(orderItems.id, context.lines.map((line) => line.orderItemId))).all();
        const itemById = new Map(items.map((item) => [item.id, item]));
        const expiresAt = giftCardExpiryFromMonths(settings.value.defaultExpiryMonths);

        const statements: BatchItem<"sqlite">[] = [];
        const deliveredLineIds: string[] = [];
        const noValue: string[] = [];
        const day = new Date().toISOString().slice(0, 10);
        for (const line of context.lines) {
            const item = itemById.get(line.orderItemId);
            if (!item) throw new Error(`Order line ${line.orderItemId.slice(0, 12)} is missing.`);
            // The card's value is the base price (no discount, no surcharge).
            const valueMinor = item.baseUnitPriceMinor ?? item.unitPriceMinor - (item.propertiesPriceMinor ?? 0);
            if (!Number.isSafeInteger(valueMinor) || valueMinor <= 0) {
                // This line stays owed (staff alerted once a day); the others are issued.
                noValue.push(line.orderItemId);
                await buildNotificationOutboxInsert(db, {
                    subjectType: "order",
                    subjectId: context.orderId,
                    audience: "staff",
                    notificationType: "digital_keys_exhausted",
                    dedupeKey: `gift_card_no_value:${line.orderItemId}:${day}`,
                    source: "auto_fulfil",
                    data: { reason: "gift_card_no_value", orderItemId: line.orderItemId },
                }).statement.run();
                continue;
            }
            deliveredLineIds.push(line.orderItemId);
            const { recipient, message } = giftCardDeliveryFromProperties(item.properties);
            // Units already handed over keep their index; this run issues the rest.
            const firstUnit = item.quantity - line.quantity;
            for (let unit = firstUnit; unit < item.quantity; unit += 1) {
                const giftCardId = `gc_${crypto.randomUUID().replace(/-/g, "")}`;
                const built = await buildGiftCardIssueStatements(db, keys, {
                    id: giftCardId,
                    source: "purchase",
                    amountMinor: valueMinor,
                    currencyCode: order.currencyCode,
                    expiresAt,
                    customerId: recipient ? null : order.accountOwnerCustomerId,
                    recipient,
                    message,
                    note: null,
                    issuedByUserId: null,
                    sourceOrderId: context.orderId,
                    sourceOrderItemId: item.id,
                    sourceUnitIndex: unit,
                    idempotencyKey: `issue:${item.id}:${unit}`,
                    actor: { type: "system", id: null },
                });
                statements.push(...built.statements);
                statements.push(buildNotificationOutboxInsert(db, {
                    subjectType: "gift_card",
                    subjectId: giftCardId,
                    audience: "customer",
                    notificationType: "gift_card_issued",
                    dedupeKey: giftCardIssuedDedupeKey(giftCardId),
                    source: "gift-card-fulfiller",
                    data: { orderId: context.orderId },
                }).statement as unknown as BatchItem<"sqlite">);
                // Sent to someone else: the buyer hears where it went (no code).
                if (recipient?.email || recipient?.phone) {
                    statements.push(buildNotificationOutboxInsert(db, {
                        subjectType: "gift_card",
                        subjectId: giftCardId,
                        audience: "customer",
                        notificationType: "gift_card_sent",
                        dedupeKey: `gift_card_sent:${giftCardId}`,
                        source: "gift-card-fulfiller",
                        data: { orderId: context.orderId },
                    }).statement as unknown as BatchItem<"sqlite">);
                }
            }
        }
        return {
            statements,
            deliveredLineIds,
            owedReason: noValue.length > 0 ? `${noValue.length} gift-card line(s) have no value` : undefined,
        };
    },
};
