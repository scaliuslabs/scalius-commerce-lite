// src/modules/discounts/discounts.schema.ts
import { z } from "zod";
import { DiscountType, DiscountValueType } from "@/db/schema";

const discountTypeEnum = z.nativeEnum(DiscountType);
const discountValueTypeEnum = z.nativeEnum(DiscountValueType);

export const createDiscountSchema = z.object({
    code: z.string().min(3).max(50),
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
});

export const updateDiscountSchema = createDiscountSchema.extend({
    id: z.string(),
});
