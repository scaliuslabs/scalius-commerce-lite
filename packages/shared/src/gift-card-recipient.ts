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
import { LINE_ENTRY_WORDS_EN } from "./line-entry-words";

export const GIFT_CARD_RECIPIENT_FIELDS: readonly CustomizationField[] = Object.freeze([
  {
    key: "_gc_recipient_name",
    type: "text",
    label: LINE_ENTRY_WORDS_EN.lineGiftCardRecipientNameText,
    required: false,
    help: "Sending it to someone? Leave these empty to get the gift card yourself.",
    maxLength: 120,
    priceMinor: 0,
  },
  {
    key: "_gc_recipient_email",
    type: "text",
    label: LINE_ENTRY_WORDS_EN.lineGiftCardRecipientEmailText,
    required: false,
    help: "We email the gift card code here.",
    maxLength: 200,
    priceMinor: 0,
  },
  {
    key: "_gc_recipient_phone",
    type: "text",
    label: LINE_ENTRY_WORDS_EN.lineGiftCardRecipientPhoneText,
    required: false,
    help: "We text the code here instead. Use an email or a phone, not both.",
    maxLength: 40,
    priceMinor: 0,
  },
  {
    key: "_gc_message",
    type: "textarea",
    label: LINE_ENTRY_WORDS_EN.lineGiftCardMessageText,
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

/** The checkout-language words of each recipient input: its label and its help (the product page's catalogue). */
const RECIPIENT_WORDS = {
  _gc_recipient_name: { label: "lineGiftCardRecipientNameText", help: "recipientHelpText" },
  _gc_recipient_email: { label: "lineGiftCardRecipientEmailText", help: "recipientEmailHelpText" },
  _gc_recipient_phone: { label: "lineGiftCardRecipientPhoneText", help: "recipientPhoneHelpText" },
  _gc_message: { label: "lineGiftCardMessageText", help: null },
} as const;
type RecipientWordKey = (typeof RECIPIENT_WORDS)[keyof typeof RECIPIENT_WORDS]["label" | "help"] & string;

/**
 * A buy form's fields with a gift card's recipient inputs in the page's
 * language (`copy`: the product page's checkout copy). The product's own
 * inputs keep the merchant's words.
 */
export function localizedGiftCardRecipientFields<T extends { key: string; label: string; help: string | null }>(
  fields: readonly T[],
  copy: Readonly<Record<RecipientWordKey, string>>,
): T[] {
  return fields.map((field) => {
    const words = (RECIPIENT_WORDS as Record<string, { label: RecipientWordKey; help: RecipientWordKey | null }>)[field.key];
    if (!words) return field;
    return { ...field, label: copy[words.label] || field.label, help: words.help ? copy[words.help] || field.help : field.help };
  });
}
