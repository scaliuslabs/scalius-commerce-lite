// Gift-card recipients on an order line (Wave B §4.2): the reserved `_gc_`
// line properties a gift-card product carries. They are a delivery target
// only and never touch `customers`. Checkout refuses a bad one; the fulfiller
// reads the frozen snapshot.
import { ValidationError } from "../../errors";
import { parseGiftCardRecipientStrict } from "./issue";

/** Reserved line-property keys (the `_gc_` prefix, `@scalius/shared/line-properties`). */
export const GIFT_CARD_LINE_PROPERTY_KEYS = {
    recipientName: "_gc_recipient_name",
    recipientEmail: "_gc_recipient_email",
    recipientPhone: "_gc_recipient_phone",
    message: "_gc_message",
} as const;

/**
 * Why a gift-card line's recipient can't be used (a malformed email or phone,
 * or both an email and a phone), naming the property to fix; null when it is
 * fine or absent.
 */
export function giftCardLineRecipientIssue(
    properties: ReadonlyArray<{ key: string; value: string }>,
): { propertyKey: string; message: string } | null {
    const value = (key: string) => properties.find((property) => property.key === key)?.value ?? null;
    try {
        parseGiftCardRecipientStrict({
            name: value(GIFT_CARD_LINE_PROPERTY_KEYS.recipientName),
            email: value(GIFT_CARD_LINE_PROPERTY_KEYS.recipientEmail),
            phone: value(GIFT_CARD_LINE_PROPERTY_KEYS.recipientPhone),
        });
        return null;
    } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        const field = (error.details as { field?: unknown } | undefined)?.field;
        return {
            propertyKey: field === "recipient.email"
                ? GIFT_CARD_LINE_PROPERTY_KEYS.recipientEmail
                : GIFT_CARD_LINE_PROPERTY_KEYS.recipientPhone,
            message: error.message,
        };
    }
}
