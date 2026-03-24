// src/modules/discounts/discounts.validation.ts
import { z } from "zod";
import { DiscountType, DiscountValueType } from "@scalius/database/schema";

const discountTypeEnum = z.nativeEnum(DiscountType);
const discountValueTypeEnum = z.nativeEnum(DiscountValueType);

const baseDiscountFields = {
    code: z.string().min(3).max(50).transform((v) => v.toUpperCase()),
    type: discountTypeEnum,
    valueType: discountValueTypeEnum,
    discountValue: z.number().positive(),
    minPurchaseAmount: z.number().nullable().optional(),
    minQuantity: z.number().int().positive().nullable().optional(),
    maxUsesPerOrder: z.number().int().positive().nullable().optional(),
    maxUses: z.number().int().positive().nullable().optional(),
    limitOnePerCustomer: z.boolean().default(false),
    combineWithProductDiscounts: z.boolean().default(false),
    combineWithOrderDiscounts: z.boolean().default(false),
    combineWithShippingDiscounts: z.boolean().default(false),
    customerSegment: z.string().nullable().optional(),
    startDate: z
        .date()
        .or(z.string())
        .or(z.number())
        .transform((val) => {
            if (typeof val === "number") {
                return new Date(val < 10000000000 ? val * 1000 : val);
            }
            return new Date(val);
        }),
    endDate: z
        .date()
        .or(z.string())
        .or(z.number())
        .nullable()
        .optional()
        .transform((val) => {
            if (!val) return null;
            if (typeof val === "number") {
                return new Date(val < 10000000000 ? val * 1000 : val);
            }
            return new Date(val);
        }),
    isActive: z.boolean().default(true),
    appliesToProducts: z.array(z.string()).optional(),
    appliesToCollections: z.array(z.string()).optional(),
} as const;

const percentageCheck = (data: { valueType: string; discountValue: number }) =>
    data.valueType !== DiscountValueType.PERCENTAGE || data.discountValue <= 100;

const percentageError = { message: "Percentage discount cannot exceed 100%", path: ["discountValue"] };

export const createDiscountSchema = z.object(baseDiscountFields).refine(percentageCheck, percentageError);

export const updateDiscountSchema = z.object({ ...baseDiscountFields, id: z.string() }).refine(percentageCheck, percentageError);

export type CreateDiscountInput = z.infer<typeof createDiscountSchema>;
export type UpdateDiscountInput = z.infer<typeof updateDiscountSchema>;
