// src/modules/discounts/discounts.validation.ts
import { z } from "zod";
import { DiscountType, DiscountValueType } from "@scalius/database/schema";

const discountTypeEnum = z.nativeEnum(DiscountType);
const discountValueTypeEnum = z.nativeEnum(DiscountValueType);

const DISCOUNT_SCOPE_LIMIT = 90;

const discountDateSchema = z
    .union([z.date(), z.string().min(1), z.number().finite()])
    .transform((value) => {
        if (value instanceof Date) return value;
        if (typeof value === "number") {
            return new Date(value < 10_000_000_000 ? value * 1_000 : value);
        }
        return new Date(value);
    })
    .pipe(z.date());

const optionalScopeSchema = z
    .array(z.string().trim().min(1))
    .max(DISCOUNT_SCOPE_LIMIT)
    .transform((values) => Array.from(new Set(values)))
    .optional();

const baseDiscountFields = {
    code: z
        .string()
        .trim()
        .min(3)
        .max(50)
        .regex(/^[a-zA-Z0-9_-]+$/, "Code can only contain letters, numbers, underscores, and hyphens")
        .transform((value) => value.toUpperCase()),
    type: discountTypeEnum,
    valueType: discountValueTypeEnum,
    discountValue: z.number().finite().positive(),
    minPurchaseAmount: z.number().finite().positive().nullable().optional(),
    minQuantity: z.number().int().positive().nullable().optional(),
    maxUsesPerOrder: z.number().int().positive().max(1, "Only one discount code can be used per order").nullable().optional(),
    maxUses: z.number().int().positive().nullable().optional(),
    limitOnePerCustomer: z.boolean().default(false),
    combineWithProductDiscounts: z.boolean().default(false),
    combineWithOrderDiscounts: z.boolean().default(false),
    combineWithShippingDiscounts: z.boolean().default(false),
    customerSegment: z.string().nullable().optional(),
    startDate: discountDateSchema,
    endDate: discountDateSchema.nullable().optional().transform((value) => value ?? null),
    isActive: z.boolean().default(false),
    appliesToProducts: optionalScopeSchema,
    appliesToCollections: optionalScopeSchema,
} as const;

function refineDiscountSemantics<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
    return schema.superRefine((data, context) => {
        const discount = data as {
            type: DiscountType;
            valueType: DiscountValueType;
            discountValue: number;
            startDate: Date;
            endDate?: Date | null;
            customerSegment?: string | null;
            combineWithProductDiscounts: boolean;
            combineWithOrderDiscounts: boolean;
            combineWithShippingDiscounts: boolean;
            appliesToProducts?: string[];
            appliesToCollections?: string[];
        };

        if (
            discount.valueType === DiscountValueType.PERCENTAGE &&
            discount.discountValue > 100
        ) {
            context.addIssue({
                code: "custom",
                message: "Percentage discount cannot exceed 100%",
                path: ["discountValue"],
            });
        }

        if (
            discount.type === DiscountType.FREE_SHIPPING &&
            discount.valueType !== DiscountValueType.FREE
        ) {
            context.addIssue({
                code: "custom",
                message: "Free-shipping discounts must use the free value type",
                path: ["valueType"],
            });
        }

        if (
            discount.type !== DiscountType.FREE_SHIPPING &&
            discount.valueType === DiscountValueType.FREE
        ) {
            context.addIssue({
                code: "custom",
                message: "Amount discounts must use a percentage or fixed amount",
                path: ["valueType"],
            });
        }

        if (discount.endDate && discount.endDate <= discount.startDate) {
            context.addIssue({
                code: "custom",
                message: "End date must be after the start date",
                path: ["endDate"],
            });
        }

        const scopeCount =
            (discount.appliesToProducts?.length ?? 0) +
            (discount.appliesToCollections?.length ?? 0);
        if (scopeCount > DISCOUNT_SCOPE_LIMIT) {
            context.addIssue({
                code: "custom",
                message: `A discount can target at most ${DISCOUNT_SCOPE_LIMIT} products and collections`,
                path: ["appliesToProducts"],
            });
        }

        if (discount.customerSegment?.trim()) {
            context.addIssue({
                code: "custom",
                message: "Customer segments are not supported yet",
                path: ["customerSegment"],
            });
        }

        if (
            discount.combineWithProductDiscounts ||
            discount.combineWithOrderDiscounts ||
            discount.combineWithShippingDiscounts
        ) {
            context.addIssue({
                code: "custom",
                message: "Discount combinations are unavailable while checkout supports one code per order",
                path: ["combineWithProductDiscounts"],
            });
        }
    });
}

export const createDiscountSchema = refineDiscountSemantics(z.object(baseDiscountFields));

export const updateDiscountSchema = refineDiscountSemantics(
    z.object({ ...baseDiscountFields, id: z.string().trim().min(1) }),
);

export type CreateDiscountInput = z.infer<typeof createDiscountSchema>;
export type UpdateDiscountInput = z.infer<typeof updateDiscountSchema>;
