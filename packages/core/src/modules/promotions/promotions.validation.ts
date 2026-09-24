import { z } from "zod";
import { isWholeCashAmountMinor, WHOLE_TAKA_MESSAGE } from "@scalius/shared/money";

import { checkPromotionRule, PROMOTION_SCOPE_LIMIT } from "./promotions.evaluator";

const MAX_MINOR_AMOUNT = Number.MAX_SAFE_INTEGER;
const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/u);
const positiveMinorSchema = z.number().int().positive().max(MAX_MINOR_AMOUNT);
const scopeIdsSchema = z.array(z.string().trim().min(1).max(160))
    .max(PROMOTION_SCOPE_LIMIT)
    .transform((ids) => Array.from(new Set(ids)));
/** Limit a product discount (or a requirement) to these products/collections. */
const scopeShape = {
    productIds: scopeIdsSchema.optional(),
    collectionIds: scopeIdsSchema.optional(),
};

export const promotionCodeInputSchema = z.object({
    code: z.string()
        .trim()
        .min(3)
        .max(50)
        .regex(/^[A-Za-z0-9_-]+$/u, "Codes may contain letters, numbers, underscores, and hyphens only.")
        .transform((code) => code.toUpperCase()),
    isActive: z.boolean().default(true),
}).strict();

export const promotionConditionInputSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("minimum_merchandise_subtotal"),
        config: z.object({
            amountMinor: positiveMinorSchema,
            currencyCode: currencyCodeSchema,
            ...scopeShape,
            /** Minimum for the discount's bundled free shipping, after its savings. */
            shippingOnly: z.boolean().optional(),
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal("minimum_item_quantity"),
        config: z.object({ quantity: z.number().int().positive().max(1_000_000), ...scopeShape }).strict(),
    }).strict(),
]);

const effectBaseShape = {
    target: z.enum(["line", "order", "shipping"]),
    allocation: z.enum(["across", "once"]),
};

export const promotionEffectInputSchema = z.discriminatedUnion("kind", [
    z.object({
        ...effectBaseShape,
        kind: z.literal("percentage_off"),
        config: z.object({
            basisPoints: z.number().int().min(1).max(10_000),
            ...scopeShape,
            buy: z.object({
                quantity: z.number().int().positive().max(10_000).optional(),
                amountMinor: positiveMinorSchema.optional(),
                currencyCode: currencyCodeSchema.optional(),
                ...scopeShape,
            }).strict().refine(
                (buy) => (buy.quantity === undefined) !== (buy.amountMinor === undefined)
                    && (buy.amountMinor === undefined) === (buy.currencyCode === undefined),
                "Set either a quantity or an amount the customer buys.",
            ).optional(),
            getQuantity: z.number().int().positive().max(10_000).optional(),
            maxUsesPerOrder: z.number().int().positive().max(10_000).optional(),
        }).strict(),
    }).strict(),
    z.object({
        ...effectBaseShape,
        kind: z.literal("fixed_amount_off"),
        config: z.object({
            amountMinor: positiveMinorSchema,
            currencyCode: currencyCodeSchema,
            ...scopeShape,
            eachItem: z.boolean().optional(),
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal("free"),
        target: z.literal("shipping"),
        allocation: z.literal("once"),
        config: z.object({}).strict(),
    }).strict(),
]);

const promotionRuleShape = {
    name: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(200).nullable().optional()
        .transform((title) => title ?? null),
    method: z.enum(["automatic", "code"]),
    priority: z.number().int().min(0).max(10_000).default(100),
    conflictPolicy: z.literal("best").default("best"),
    /** Which other discount classes may apply to the same order (both sides must allow it). */
    combinesWith: z.object({
        product: z.boolean(),
        order: z.boolean(),
        shipping: z.boolean(),
    }).strict().default({ product: false, order: false, shipping: false }),
    startsAtEpochSeconds: z.number().int().nonnegative().nullable().default(null),
    endsAtEpochSeconds: z.number().int().nonnegative().nullable().default(null),
    timezone: z.string().trim().min(1).max(80).default("Asia/Dhaka"),
    maxRedemptions: z.number().int().positive().nullable().default(null),
    maxRedemptionsPerCustomer: z.number().int().positive().nullable().default(null),
    maxDiscountSpendMinor: positiveMinorSchema.nullable().default(null),
    budgetCurrencyCode: currencyCodeSchema.nullable().default(null),
    codes: z.array(promotionCodeInputSchema).max(90).default([]),
    conditions: z.array(promotionConditionInputSchema).max(20).default([]),
    /** One value; a product or order value may add free shipping as a second effect. */
    effects: z.array(promotionEffectInputSchema).min(1).max(2),
} as const;

/** In BDT every amount (a fixed discount, a minimum, a Buy X amount, a budget) is whole taka. */
function requireWholeCashAmounts(rule: Parameters<typeof checkPromotionRule>[0], context: z.RefinementCtx): void {
    const check = (amountMinor: number | null | undefined, currencyCode: string | null | undefined, path: (string | number)[]) => {
        if (amountMinor != null && currencyCode && !isWholeCashAmountMinor(amountMinor, currencyCode)) {
            context.addIssue({ code: "custom", path, message: WHOLE_TAKA_MESSAGE });
        }
    };
    rule.conditions.forEach((condition, index) => {
        if (condition.kind === "minimum_merchandise_subtotal") {
            check(condition.config.amountMinor, condition.config.currencyCode, ["conditions", index, "config", "amountMinor"]);
        }
    });
    rule.effects.forEach((effect, index) => {
        if (effect.kind === "fixed_amount_off") {
            check(effect.config.amountMinor, effect.config.currencyCode, ["effects", index, "config", "amountMinor"]);
        } else if (effect.kind === "percentage_off" && effect.config.buy) {
            check(effect.config.buy.amountMinor, effect.config.buy.currencyCode, ["effects", index, "config", "buy", "amountMinor"]);
        }
    });
    check(rule.maxDiscountSpendMinor, rule.budgetCurrencyCode, ["maxDiscountSpendMinor"]);
}

function refinePromotionRule(
    rule: Parameters<typeof checkPromotionRule>[0] & { timezone: string },
    context: z.RefinementCtx,
): void {
    checkPromotionRule(rule, context);
    requireWholeCashAmounts(rule, context);
    try {
        new Intl.DateTimeFormat("en", { timeZone: rule.timezone }).format(0);
    } catch {
        context.addIssue({ code: "custom", path: ["timezone"], message: "Use a valid time zone, such as Asia/Dhaka." });
    }
}

export const createPromotionDraftSchema = z.object(promotionRuleShape)
    .strict()
    .superRefine(refinePromotionRule);

export const updatePromotionDraftSchema = z.object({
    expectedRevision: z.number().int().positive(),
    ...promotionRuleShape,
}).strict().superRefine(refinePromotionRule);

export type CreatePromotionDraftInput = z.input<typeof createPromotionDraftSchema>;
export type UpdatePromotionDraftInput = z.input<typeof updatePromotionDraftSchema>;
export type PromotionRule = z.output<typeof createPromotionDraftSchema>;
