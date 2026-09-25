// src/modules/attributes/attributes.validation.ts
// Zod schemas for attribute CRUD operations (browser-safe).

import { z } from "zod";
import {
    ATTRIBUTE_FACET_DISPLAYS,
    ATTRIBUTE_GROUP_NAME_MAX_LENGTH,
    ATTRIBUTE_UNIT_MAX_LENGTH,
    ATTRIBUTE_VALUE_MAX_LENGTH,
    ATTRIBUTE_VALUE_TYPES,
    isAttributeFacetDisplayAllowed,
} from "@scalius/shared/catalog-attributes";

/**
 * Listing query keys the storefront owns. An attribute slug is its facet's
 * query key, so these can never be attribute slugs (`brand` is the brand
 * entity's facet). A derived handle skips them (`brand-2`).
 */
export const RESERVED_ATTRIBUTE_SLUGS = [
    "brand",
    "category",
    "search",
    "q",
    "page",
    "limit",
    "sort",
    "ids",
] as const;

export function isReservedAttributeSlug(slug: string): boolean {
    return (RESERVED_ATTRIBUTE_SLUGS as readonly string[]).includes(slug.trim().toLowerCase());
}

/** Ids per request body (the D1 enrichment bound). */
export const MAX_ATTRIBUTE_REQUEST_IDS = 90;
export const ATTRIBUTE_SORT_ORDER_MAX = 10_000;

const existingAttributeValueSchema = z.string().refine(
    (value) => value.trim().length > 0 && value.trim().length <= 100,
    "Value must be between 1 and 100 characters",
);

const attributeValueSchema = z
    .string()
    .trim()
    .min(1, "Value is required")
    .max(100, "Value must be at most 100 characters long");

const attributeNameSchema = z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters long")
    .max(100, "Name must be at most 100 characters long");

const attributeSlugSchema = z
    .string()
    .trim()
    .min(2, "Slug must be at least 2 characters long")
    .max(100, "Slug must be at most 100 characters long")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format");

const attributeOptionsSchema = z
    .array(z.string().trim().min(1, "Option values cannot be empty").max(100, "Option values must be at most 100 characters long"))
    .max(500, "Too many options")
    .transform((options) => {
        const seen = new Set<string>();
        return options.filter((option) => {
            const key = option.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    });

const sortOrderSchema = z.number().int().min(0).max(ATTRIBUTE_SORT_ORDER_MAX);
const attributeUnitInputSchema = z.string().trim().min(1).max(ATTRIBUTE_UNIT_MAX_LENGTH).nullable();
const groupIdSchema = z.string().trim().min(1).max(80).nullable();
const valueTypeSchema = z.enum(ATTRIBUTE_VALUE_TYPES);
const facetDisplaySchema = z.enum(ATTRIBUTE_FACET_DISPLAYS);

export const createAttributeSchema = z.object({
    name: attributeNameSchema,
    slug: attributeSlugSchema
        .refine((slug) => !isReservedAttributeSlug(slug), "That slug is a storefront listing query key. Choose another.")
        .optional()
        .describe("Omit to derive the handle from the name; a taken one gets a -2, -3… suffix."),
    filterable: z.boolean().default(true),
    options: attributeOptionsSchema.optional(),
    valueType: valueTypeSchema.default("text"),
    groupId: groupIdSchema.optional(),
    unit: attributeUnitInputSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    keySpec: z.boolean().optional(),
    highlight: z.boolean().optional(),
    facetDisplay: facetDisplaySchema.optional(),
}).superRefine((input, context) => {
    if (input.facetDisplay && !isAttributeFacetDisplayAllowed(input.valueType, input.facetDisplay)) {
        context.addIssue({
            code: "custom",
            path: ["facetDisplay"],
            message: `A ${input.facetDisplay} filter does not suit ${input.valueType} values.`,
        });
    }
    if (input.unit && input.valueType !== "number") {
        context.addIssue({ code: "custom", path: ["unit"], message: "Only number attributes have a unit." });
    }
    if ((input.valueType === "number" || input.valueType === "boolean") && (input.options?.length ?? 0) > 0) {
        context.addIssue({
            code: "custom",
            path: ["options"],
            message: "Number and yes/no attributes have no preset values.",
        });
    }
});

/**
 * `valueType` is not editable here: changing it rewrites every product value
 * (`POST /attributes/{id}/convert-type`). Unit and filter widget are checked
 * against the stored type by the service.
 */
export const updateAttributeSchema = z.object({
    name: attributeNameSchema.optional(),
    slug: attributeSlugSchema.optional(),
    filterable: z.boolean().optional(),
    options: attributeOptionsSchema.optional().nullable(),
    groupId: groupIdSchema.optional(),
    unit: attributeUnitInputSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    keySpec: z.boolean().optional(),
    highlight: z.boolean().optional(),
    facetDisplay: facetDisplaySchema.optional(),
});

export const bulkActionSchema = z.object({
    ids: z.array(z.string().trim().min(1)).min(1, "No IDs provided").max(90, "Select at most 90 attributes"),
    permanent: z.boolean().default(false)
});

export const addValueSchema = z.object({
    value: attributeValueSchema,
});

export const updateValueSchema = z.object({
    oldValue: existingAttributeValueSchema,
    newValue: attributeValueSchema,
});

export const deleteValueSchema = z.object({
    value: existingAttributeValueSchema
});

// ── Attribute groups ──

const groupNameSchema = z.string().trim().min(1, "Name is required").max(ATTRIBUTE_GROUP_NAME_MAX_LENGTH);

export const createAttributeGroupSchema = z.object({
    name: groupNameSchema,
    sortOrder: sortOrderSchema.optional(),
}).strict();

export const updateAttributeGroupSchema = z.object({
    name: groupNameSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
}).strict();

export const reorderAttributeGroupsSchema = z.object({
    items: z.array(z.object({
        groupId: z.string().trim().min(1).max(80),
        sortOrder: sortOrderSchema,
    }).strict()).min(1).max(MAX_ATTRIBUTE_REQUEST_IDS),
}).strict();

// ── Normalised values (attribute_values) ──

/** A #rrggbb colour; the service stores it lowercased (the database CHECK). */
export const attributeSwatchHexInputSchema = z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour.")
    .nullable();

const normalizedValueTextSchema = z.string().trim().min(1, "Value is required").max(ATTRIBUTE_VALUE_MAX_LENGTH);

export const createAttributeValueRowSchema = z.object({
    value: normalizedValueTextSchema,
    swatchHex: attributeSwatchHexInputSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
}).strict();

export const updateAttributeValueRowSchema = z.object({
    value: normalizedValueTextSchema.optional(),
    swatchHex: attributeSwatchHexInputSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
}).strict();

export const reorderAttributeValueRowsSchema = z.object({
    items: z.array(z.object({
        valueId: z.string().trim().min(1).max(80),
        sortOrder: sortOrderSchema,
    }).strict()).min(1).max(MAX_ATTRIBUTE_REQUEST_IDS),
}).strict();

// ── Type conversion ──

export const convertAttributeTypeSchema = z.object({
    valueType: valueTypeSchema,
    facetDisplay: facetDisplaySchema.optional(),
    unit: attributeUnitInputSchema.optional(),
    dryRun: z.boolean().default(false),
}).strict().superRefine((input, context) => {
    if (input.facetDisplay && !isAttributeFacetDisplayAllowed(input.valueType, input.facetDisplay)) {
        context.addIssue({
            code: "custom",
            path: ["facetDisplay"],
            message: `A ${input.facetDisplay} filter does not suit ${input.valueType} values.`,
        });
    }
    if (input.unit && input.valueType !== "number") {
        context.addIssue({ code: "custom", path: ["unit"], message: "Only number attributes have a unit." });
    }
});

// ── Category attribute sets ──

export const replaceCategoryAttributeSetSchema = z.object({
    attributes: z.array(z.object({
        attributeId: z.string().trim().min(1).max(100),
        sortOrder: sortOrderSchema.optional(),
    }).strict()).max(MAX_ATTRIBUTE_REQUEST_IDS),
}).strict().superRefine((input, context) => {
    const seen = new Set<string>();
    input.attributes.forEach((item, index) => {
        if (seen.has(item.attributeId)) {
            context.addIssue({
                code: "custom",
                path: ["attributes", index, "attributeId"],
                message: "Each attribute can be in a category's set only once.",
            });
        }
        seen.add(item.attributeId);
    });
});

/** Input shape: `filterable` defaults to true and `valueType` to text. */
export type CreateAttributeInput = z.input<typeof createAttributeSchema>;
export type UpdateAttributeInput = z.infer<typeof updateAttributeSchema>;
export type CreateAttributeGroupInput = z.infer<typeof createAttributeGroupSchema>;
export type UpdateAttributeGroupInput = z.infer<typeof updateAttributeGroupSchema>;
export type CreateAttributeValueRowInput = z.infer<typeof createAttributeValueRowSchema>;
export type UpdateAttributeValueRowInput = z.infer<typeof updateAttributeValueRowSchema>;
export type ConvertAttributeTypeInput = z.input<typeof convertAttributeTypeSchema>;
export type ReplaceCategoryAttributeSetInput = z.infer<typeof replaceCategoryAttributeSetSchema>;
