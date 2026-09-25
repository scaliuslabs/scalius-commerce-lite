/**
 * The buyer inputs every gift-card product asks for (Wave B §4.2): an optional
 * recipient (name and one contact) and a message, as the reserved `_gc_` line
 * properties. They are composed at read time onto the product's own buyer
 * inputs, on the product page and in cart validation alike, so the merchant
 * can't remove or misname them and the stored schema never changes. Empty
 * means "send it to me". The recipient is a delivery target only.
 */
import {
  CUSTOMIZATION_LIMITS,
  RESERVED_PROPERTY_KEY_PREFIX,
  type CustomizationField,
  type CustomizationSchema,
} from "./line-properties";

export const GIFT_CARD_RECIPIENT_FIELDS: readonly CustomizationField[] = Object.freeze([
  {
    key: "_gc_recipient_name",
    type: "text",
    label: "Recipient name",
    required: false,
    help: "Sending it to someone? Leave these empty to get the gift card yourself.",
    maxLength: 120,
    priceMinor: 0,
  },
  {
    key: "_gc_recipient_email",
    type: "text",
    label: "Recipient email",
    required: false,
    help: "We email the gift card code here.",
    maxLength: 200,
    priceMinor: 0,
  },
  {
    key: "_gc_recipient_phone",
    type: "text",
    label: "Or recipient phone",
    required: false,
    help: "We text the code here instead. Use an email or a phone, not both.",
    maxLength: 40,
    priceMinor: 0,
  },
  {
    key: "_gc_message",
    type: "textarea",
    label: "Message",
    required: false,
    help: null,
    maxLength: 200,
    priceMinor: 0,
  },
]);

/**
 * The product's own inputs (never a reserved key), then the gift-card
 * recipient inputs, within the field limit.
 */
export function withGiftCardRecipientFields(schema: CustomizationSchema | null): CustomizationSchema {
  const own = (schema?.fields ?? []).filter((field) => !field.key.startsWith(RESERVED_PROPERTY_KEY_PREFIX));
  const room = CUSTOMIZATION_LIMITS.fields - GIFT_CARD_RECIPIENT_FIELDS.length;
  return {
    version: schema?.version ?? 1,
    fields: [...own.slice(0, room), ...GIFT_CARD_RECIPIENT_FIELDS],
  } as CustomizationSchema;
}
