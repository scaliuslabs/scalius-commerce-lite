// Custom field write shapes (browser-safe): the dashboard, the admin API and
// agents share them. Value and validation semantics live in the shared codec
// (`@scalius/shared/custom-fields`); these schemas carry the request shape.
import { z } from "zod";
import {
    CUSTOM_FIELD_DEFINITIONS_PER_OWNER_MAX,
    CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH,
    CUSTOM_FIELD_KEY_MAX_LENGTH,
    CUSTOM_FIELD_NAME_MAX_LENGTH,
    CUSTOM_FIELD_NAMESPACE_MAX_LENGTH,
    CUSTOM_FIELD_OWNER_TYPES,
    CUSTOM_FIELD_TYPES,
} from "@scalius/shared/custom-fields";

export const customFieldOwnerTypeSchema = z.enum(CUSTOM_FIELD_OWNER_TYPES);
export const customFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);
export const customFieldDefinitionIdSchema = z.string().trim().min(1).max(68);
export const customFieldOwnerIdSchema = z.string().trim().min(1).max(128);

const expectedRevisionSchema = z.number().int().min(1);

/** Validations as sent: bounds in the field's own units (money in integer minor units of the store currency). */
export const customFieldValidationsInputSchema = z.object({
    to: z.string().max(150).nullable().optional().describe("Object references: qualified target type, for example custom.size_chart."),
    min: z.union([z.string(), z.number()]).nullable().optional()
        .describe("Text and URL: minimum length. Numbers, money, dates: minimum value (money in integer minor units of the store currency)."),
    max: z.union([z.string(), z.number()]).nullable().optional()
        .describe("Text and URL: maximum length. Numbers, money, dates: maximum value (money in integer minor units of the store currency)."),
    regex: z.string().max(200).nullable().optional()
        .describe("Single- and multi-line text: a pattern the whole value must match."),
    choices: z.array(z.string()).max(128).nullable().optional()
        .describe("Single-line text: the only values allowed."),
}).strict();

const nameSchema = z.string().trim().min(1).max(CUSTOM_FIELD_NAME_MAX_LENGTH);
const descriptionSchema = z.string().trim().max(CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH).nullable().optional();

export const createCustomFieldDefinitionSchema = z.object({
    ownerType: customFieldOwnerTypeSchema,
    name: nameSchema.describe("Shown to staff (and to buyers when storefront-visible)."),
    key: z.string().trim().min(2).max(CUSTOM_FIELD_KEY_MAX_LENGTH).optional()
        .describe("snake_case; omit to derive it from the name. Fixed once created."),
    namespace: z.string().trim().min(2).max(CUSTOM_FIELD_NAMESPACE_MAX_LENGTH).optional()
        .describe("`custom` (the default) for merchant fields; plugins write only their own namespace."),
    description: descriptionSchema,
    type: customFieldTypeSchema.describe("Fixed once created."),
    validations: customFieldValidationsInputSchema.nullable().optional(),
    storefrontVisible: z.boolean().optional().default(false)
        .describe("Include the field in public storefront reads. Never for customer or order fields."),
});

export const updateCustomFieldDefinitionSchema = z.object({
    expectedRevision: expectedRevisionSchema,
    name: nameSchema.optional(),
    description: descriptionSchema,
    validations: customFieldValidationsInputSchema.nullable().optional(),
    storefrontVisible: z.boolean().optional(),
});

export const reorderCustomFieldDefinitionsSchema = z.object({
    ownerType: customFieldOwnerTypeSchema,
    definitions: z.array(z.object({
        id: customFieldDefinitionIdSchema,
        expectedRevision: expectedRevisionSchema,
    })).min(1).max(CUSTOM_FIELD_DEFINITIONS_PER_OWNER_MAX)
        .describe("Every definition of the owner type, in the new order."),
});

export const setCustomFieldValuesSchema = z.object({
    values: z.array(z.object({
        definitionId: customFieldDefinitionIdSchema,
        value: z.unknown()
            .describe("JSON per the field type (lists as arrays, money as { amountMinor, currency } in the store currency); null, \"\" or [] clears it."),
    })).min(1).max(CUSTOM_FIELD_DEFINITIONS_PER_OWNER_MAX),
});

export type CreateCustomFieldDefinitionInput = z.infer<typeof createCustomFieldDefinitionSchema>;
export type UpdateCustomFieldDefinitionInput = z.infer<typeof updateCustomFieldDefinitionSchema>;
export type ReorderCustomFieldDefinitionsInput = z.infer<typeof reorderCustomFieldDefinitionsSchema>;
export type SetCustomFieldValuesInput = z.infer<typeof setCustomFieldValuesSchema>;
