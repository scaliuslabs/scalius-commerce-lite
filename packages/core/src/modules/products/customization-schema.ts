// Pure zod schemas for the Wave A product fields: the buyer-input schema in
// the decimal HTTP contract and the fulfilment kinds the editor offers. Kept
// free of server imports so product validation can load them first.
import { z } from "zod";
import {
    CUSTOMIZATION_FIELD_TYPES,
    CUSTOMIZATION_LIMITS,
} from "@scalius/shared/line-properties";
import { FULFILLMENT_KINDS } from "@scalius/shared/fulfilment";
import { MAX_PRODUCT_PRICE } from "@scalius/shared/product-options";

/**
 * Kinds the product API accepts (Wave B). Checkout still refuses a digital
 * line until its variant is deliverable and the digital fulfiller exists, so
 * accepting the kind here never sells something that cannot be delivered.
 */
export const EDITABLE_FULFILLMENT_KINDS = FULFILLMENT_KINDS;
export type EditableFulfillmentKind = (typeof EDITABLE_FULFILLMENT_KINDS)[number];

export const editableFulfillmentKindSchema = z.enum(EDITABLE_FULFILLMENT_KINDS)
    .describe("physical: shipped or picked up. digital: delivered as files or licence keys after payment. service: performed, nothing delivered (no address needed).");

const surchargeSchema = z.number().min(0).max(MAX_PRODUCT_PRICE)
    .describe("Added to one unit's price when the buyer uses this input, in major units.");

export const customizationOptionInputSchema = z.object({
    value: z.string().trim().min(1).max(CUSTOMIZATION_LIMITS.optionValueLength),
    label: z.string().trim().min(1).max(CUSTOMIZATION_LIMITS.optionLabelLength),
    price: surchargeSchema.optional(),
});

export const customizationFieldInputSchema = z.object({
    key: z.string().regex(CUSTOMIZATION_LIMITS.keyPattern, "Use 1-40 lowercase letters, digits or underscores."),
    label: z.string().trim().min(1).max(CUSTOMIZATION_LIMITS.labelLength),
    type: z.enum(CUSTOMIZATION_FIELD_TYPES),
    required: z.boolean().optional(),
    help: z.string().trim().max(CUSTOMIZATION_LIMITS.helpLength).nullable().optional(),
    /** text: at most 200; textarea: at most 1,000. */
    maxLength: z.number().int().min(1).max(CUSTOMIZATION_LIMITS.textareaMaxLength).optional(),
    /** text, textarea and checkbox only. */
    price: surchargeSchema.optional(),
    /** select only: 1-20 choices. */
    options: z.array(customizationOptionInputSchema).max(CUSTOMIZATION_LIMITS.selectOptions).optional(),
});

/** The merchant-facing schema; null (or no fields) removes every buyer input. */
export const customizationSchemaInputSchema = z.object({
    fields: z.array(customizationFieldInputSchema).max(CUSTOMIZATION_LIMITS.fields),
}).describe("Buyer inputs asked on the product page (at most 10 fields).");

export type CustomizationSchemaInput = z.infer<typeof customizationSchemaInputSchema>;
