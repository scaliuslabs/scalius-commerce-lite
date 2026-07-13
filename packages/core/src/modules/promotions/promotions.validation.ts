import { z } from "zod";

const MAX_MINOR_AMOUNT = Number.MAX_SAFE_INTEGER;
const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/u);

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
            amountMinor: z.number().int().positive().max(MAX_MINOR_AMOUNT),
            currencyCode: currencyCodeSchema,
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal("minimum_item_quantity"),
        config: z.object({
            quantity: z.number().int().positive().max(1_000_000),
        }).strict(),
    }).strict(),
]);

const promotionEffectBaseSchema = z.object({
    target: z.enum(["line", "order", "shipping"]),
    allocation: z.enum(["across", "once"]),
});

export const promotionEffectInputSchema = z.discriminatedUnion("kind", [
    promotionEffectBaseSchema.extend({
        kind: z.literal("percentage_off"),
        config: z.object({
            basisPoints: z.number().int().min(1).max(10_000),
        }).strict(),
    }).strict(),
    promotionEffectBaseSchema.extend({
        kind: z.literal("fixed_amount_off"),
        config: z.object({
            amountMinor: z.number().int().positive().max(MAX_MINOR_AMOUNT),
            currencyCode: currencyCodeSchema,
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal("free"),
        target: z.literal("shipping"),
        allocation: z.literal("once"),
        config: z.object({}).strict(),
    }).strict(),
]);

type PromotionConditionInput = z.infer<typeof promotionConditionInputSchema>;
type PromotionEffectInput = z.infer<typeof promotionEffectInputSchema>;

const promotionRuleShape = {
    name: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(200).nullable().optional()
        .transform((title) => title ?? null),
    method: z.enum(["automatic", "code"]),
    priority: z.number().int().min(0).max(10_000).default(100),
    conflictPolicy: z.literal("best").default("best"),
    startsAtEpochSeconds: z.number().int().nonnegative().nullable().default(null),
    endsAtEpochSeconds: z.number().int().nonnegative().nullable().default(null),
    timezone: z.string().trim().min(1).max(80).default("Asia/Dhaka"),
    maxRedemptions: z.number().int().positive().nullable().default(null),
    maxRedemptionsPerCustomer: z.number().int().positive().nullable().default(null),
    maxDiscountSpendMinor: z.number().int().positive().max(MAX_MINOR_AMOUNT).nullable().default(null),
    budgetCurrencyCode: currencyCodeSchema.nullable().default(null),
    codes: z.array(promotionCodeInputSchema).max(90).default([]),
    conditions: z.array(promotionConditionInputSchema).max(20).default([]),
    effects: z.array(promotionEffectInputSchema).min(1).max(3),
} as const;

function refinePromotionRule(
    rule: {
        method: "automatic" | "code";
        startsAtEpochSeconds: number | null;
        endsAtEpochSeconds: number | null;
        timezone: string;
        maxRedemptions: number | null;
        maxRedemptionsPerCustomer: number | null;
        maxDiscountSpendMinor: number | null;
        budgetCurrencyCode: string | null;
        codes: Array<{ code: string; isActive: boolean }>;
        conditions: PromotionConditionInput[];
        effects: PromotionEffectInput[];
    },
    context: z.RefinementCtx,
): void {
    if (rule.method === "code" && rule.codes.length === 0) {
        context.addIssue({
            code: "custom",
            path: ["codes"],
            message: "Code promotions require at least one code.",
        });
    }
    if (rule.method === "automatic" && rule.codes.length > 0) {
        context.addIssue({
            code: "custom",
            path: ["codes"],
            message: "Automatic promotions cannot own checkout codes.",
        });
    }
    const normalizedCodes = rule.codes.map(({ code }) => code);
    if (new Set(normalizedCodes).size !== normalizedCodes.length) {
        context.addIssue({
            code: "custom",
            path: ["codes"],
            message: "Promotion codes must be unique after normalization.",
        });
    }
    if (
        rule.startsAtEpochSeconds !== null
        && rule.endsAtEpochSeconds !== null
        && rule.endsAtEpochSeconds <= rule.startsAtEpochSeconds
    ) {
        context.addIssue({
            code: "custom",
            path: ["endsAtEpochSeconds"],
            message: "Promotion end must be after its start.",
        });
    }
    try {
        new Intl.DateTimeFormat("en", { timeZone: rule.timezone }).format(0);
    } catch {
        context.addIssue({
            code: "custom",
            path: ["timezone"],
            message: "Promotion timezone must be a valid IANA timezone.",
        });
    }
    if (
        rule.maxRedemptions !== null
        && rule.maxRedemptionsPerCustomer !== null
        && rule.maxRedemptionsPerCustomer > rule.maxRedemptions
    ) {
        context.addIssue({
            code: "custom",
            path: ["maxRedemptionsPerCustomer"],
            message: "Per-customer redemptions cannot exceed the total redemption limit.",
        });
    }
    if ((rule.maxDiscountSpendMinor === null) !== (rule.budgetCurrencyCode === null)) {
        context.addIssue({
            code: "custom",
            path: [rule.maxDiscountSpendMinor === null ? "maxDiscountSpendMinor" : "budgetCurrencyCode"],
            message: "Discount spend budgets require both an amount and currency.",
        });
    }
    const configuredCurrencies = new Set<string>();
    if (rule.budgetCurrencyCode) configuredCurrencies.add(rule.budgetCurrencyCode);
    for (const condition of rule.conditions) {
        if (condition.kind === "minimum_merchandise_subtotal") {
            configuredCurrencies.add(condition.config.currencyCode);
        }
    }
    for (const effect of rule.effects) {
        if (effect.kind === "fixed_amount_off") {
            configuredCurrencies.add(effect.config.currencyCode);
        }
    }
    if (configuredCurrencies.size > 1) {
        context.addIssue({
            code: "custom",
            path: ["budgetCurrencyCode"],
            message: "All currency-specific promotion rules and budgets must use one currency.",
        });
    }

    const targets = rule.effects.map(({ target }) => target);
    if (new Set(targets).size !== targets.length) {
        context.addIssue({
            code: "custom",
            path: ["effects"],
            message: "A promotion can define only one effect per target class.",
        });
    }
    rule.effects.forEach((effect, index) => {
        const expectedAllocation = effect.target === "line" ? "across" : "once";
        if (effect.allocation !== expectedAllocation) {
            context.addIssue({
                code: "custom",
                path: ["effects", index, "allocation"],
                message: "Line effects allocate across lines; order and shipping effects allocate once.",
            });
        }
    });
}

export const createPromotionDraftSchema = z.object(promotionRuleShape)
    .strict()
    .superRefine(refinePromotionRule);

export const updatePromotionDraftSchema = z.object({
    expectedRevision: z.number().int().positive(),
    ...promotionRuleShape,
}).strict().superRefine(refinePromotionRule);

/**
 * The first merchant API intentionally exposes code drafts only. Automatic
 * activation, combinations, gifts, and targeting stay absent until checkout
 * can execute them. Supported redemption/spend limits are enforced at commit.
 */
export const createMerchantPromotionDraftSchema = createPromotionDraftSchema.refine(
    (rule) => rule.method === "code",
    { path: ["method"], message: "Automatic promotions are not available yet." },
);

export const updateMerchantPromotionDraftSchema = updatePromotionDraftSchema.refine(
    (rule) => rule.method === "code",
    { path: ["method"], message: "Automatic promotions are not available yet." },
);

export type CreatePromotionDraftInput = z.infer<typeof createPromotionDraftSchema>;
export type UpdatePromotionDraftInput = z.infer<typeof updatePromotionDraftSchema>;
