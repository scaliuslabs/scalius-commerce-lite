import { z } from "zod";

export const PROMOTION_EVALUATOR_VERSION = 1;

const MAX_LINES = 250;
const MAX_CANDIDATES = 100;
const MAX_SUBMITTED_CODES = 10;
const MAX_MINOR_AMOUNT = Number.MAX_SAFE_INTEGER;

const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/u);
const minorAmountSchema = z.number().int().min(0).max(MAX_MINOR_AMOUNT);

const cartLineSchema = z.object({
    id: z.string().trim().min(1).max(160),
    productId: z.string().trim().min(1).max(160),
    variantId: z.string().trim().min(1).max(160),
    unitPriceMinor: minorAmountSchema,
    quantity: z.number().int().min(1).max(10_000),
});

const cartSchema = z.object({
    currencyCode: currencyCodeSchema,
    lines: z.array(cartLineSchema).max(MAX_LINES),
    shippingAmountMinor: minorAmountSchema,
    submittedCodes: z.array(z.string().trim().min(1).max(50)).max(MAX_SUBMITTED_CODES),
    evaluatedAtEpochSeconds: z.number().int().min(0),
}).superRefine((cart, context) => {
    const seenLineIds = new Set<string>();
    let merchandiseSubtotal = 0n;

    cart.lines.forEach((line, index) => {
        if (seenLineIds.has(line.id)) {
            context.addIssue({
                code: "custom",
                path: ["lines", index, "id"],
                message: "Cart line IDs must be unique.",
            });
        }
        seenLineIds.add(line.id);

        const lineBase = BigInt(line.unitPriceMinor) * BigInt(line.quantity);
        merchandiseSubtotal += lineBase;
        if (lineBase > BigInt(MAX_MINOR_AMOUNT)) {
            context.addIssue({
                code: "custom",
                path: ["lines", index],
                message: "Cart line total exceeds the supported range.",
            });
        }
    });

    if (merchandiseSubtotal + BigInt(cart.shippingAmountMinor) > BigInt(MAX_MINOR_AMOUNT)) {
        context.addIssue({
            code: "custom",
            path: ["lines"],
            message: "Cart total exceeds the supported range.",
        });
    }
});

export const promotionEvaluationCartSchema = cartSchema;

const minimumSubtotalConditionSchema = z.object({
    id: z.string().trim().min(1).max(160),
    kind: z.literal("minimum_merchandise_subtotal"),
    config: z.object({
        amountMinor: z.number().int().positive().max(MAX_MINOR_AMOUNT),
        currencyCode: currencyCodeSchema,
    }),
});

const minimumQuantityConditionSchema = z.object({
    id: z.string().trim().min(1).max(160),
    kind: z.literal("minimum_item_quantity"),
    config: z.object({ quantity: z.number().int().positive().max(1_000_000) }),
});

const promotionConditionSchema = z.discriminatedUnion("kind", [
    minimumSubtotalConditionSchema,
    minimumQuantityConditionSchema,
]);

const effectBaseSchema = z.object({
    id: z.string().trim().min(1).max(160),
    target: z.enum(["line", "order", "shipping"]),
    allocation: z.enum(["across", "once"]),
});

const promotionEffectSchema = z.discriminatedUnion("kind", [
    effectBaseSchema.extend({
        kind: z.literal("percentage_off"),
        config: z.object({ basisPoints: z.number().int().min(1).max(10_000) }),
    }),
    effectBaseSchema.extend({
        kind: z.literal("fixed_amount_off"),
        config: z.object({
            amountMinor: z.number().int().positive().max(MAX_MINOR_AMOUNT),
            currencyCode: currencyCodeSchema,
        }),
    }),
    effectBaseSchema.extend({
        kind: z.literal("free"),
        target: z.literal("shipping"),
        allocation: z.literal("once"),
        config: z.object({}),
    }),
]);

export const promotionCandidateSchema = z.object({
    id: z.string().trim().min(1).max(160),
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(160),
    method: z.enum(["automatic", "code"]),
    status: z.enum(["draft", "active", "paused", "archived"]),
    priority: z.number().int().min(0).max(10_000),
    conflictPolicy: z.literal("best"),
    startsAtEpochSeconds: z.number().int().min(0).nullable(),
    endsAtEpochSeconds: z.number().int().min(0).nullable(),
    codes: z.array(z.object({
        code: z.string().regex(/^[A-Z0-9_-]{3,50}$/u),
        isActive: z.boolean(),
    })).max(1_000),
    conditions: z.array(promotionConditionSchema).max(20),
    effects: z.array(promotionEffectSchema).min(1).max(3),
}).superRefine((candidate, context) => {
    if (candidate.method === "code" && candidate.codes.length === 0) {
        context.addIssue({
            code: "custom",
            path: ["codes"],
            message: "Code promotions require at least one code.",
        });
    }
    if (candidate.method === "automatic" && candidate.codes.length > 0) {
        context.addIssue({
            code: "custom",
            path: ["codes"],
            message: "Automatic promotions cannot own checkout codes.",
        });
    }
    if (
        candidate.startsAtEpochSeconds !== null
        && candidate.endsAtEpochSeconds !== null
        && candidate.endsAtEpochSeconds <= candidate.startsAtEpochSeconds
    ) {
        context.addIssue({
            code: "custom",
            path: ["endsAtEpochSeconds"],
            message: "Promotion end must be after its start.",
        });
    }

    const targets = candidate.effects.map((effect) => effect.target);
    if (new Set(targets).size !== targets.length) {
        context.addIssue({
            code: "custom",
            path: ["effects"],
            message: "A promotion can define only one effect per target class.",
        });
    }
    candidate.effects.forEach((effect, index) => {
        const allocationMatches = effect.target === "line"
            ? effect.allocation === "across"
            : effect.allocation === "once";
        if (!allocationMatches) {
            context.addIssue({
                code: "custom",
                path: ["effects", index, "allocation"],
                message: "Line effects allocate across lines; order and shipping effects allocate once.",
            });
        }
    });

    const uniqueCodes = new Set(candidate.codes.map(({ code }) => code));
    if (uniqueCodes.size !== candidate.codes.length) {
        context.addIssue({
            code: "custom",
            path: ["codes"],
            message: "Promotion codes must be unique.",
        });
    }

    const conditionIds = candidate.conditions.map(({ id }) => id);
    if (new Set(conditionIds).size !== conditionIds.length) {
        context.addIssue({
            code: "custom",
            path: ["conditions"],
            message: "Promotion condition IDs must be unique.",
        });
    }

    const effectIds = candidate.effects.map(({ id }) => id);
    if (new Set(effectIds).size !== effectIds.length) {
        context.addIssue({
            code: "custom",
            path: ["effects"],
            message: "Promotion effect IDs must be unique.",
        });
    }
});

const evaluationInputSchema = z.object({
    cart: cartSchema,
    candidates: z.array(z.unknown()).max(MAX_CANDIDATES),
});

export type PromotionCandidate = z.infer<typeof promotionCandidateSchema>;
export type PromotionEvaluationCart = z.infer<typeof cartSchema>;
export type PromotionEffect = PromotionCandidate["effects"][number];
export type PromotionEffectTarget = PromotionEffect["target"];

export type PromotionRejectionReason =
    | "invalid_configuration"
    | "inactive"
    | "not_started"
    | "expired"
    | "code_not_submitted"
    | "condition_currency_mismatch"
    | "minimum_subtotal_not_met"
    | "minimum_quantity_not_met"
    | "effect_currency_mismatch"
    | "no_savings"
    | "lower_savings";

export interface PromotionAllocationPlan {
    promotionId: string;
    promotionRevision: number;
    evaluatorVersion: number;
    promotionName: string;
    promotionCode: string | null;
    method: "automatic" | "code";
    effectId: string;
    effectKind: "percentage_off" | "fixed_amount_off" | "free";
    target: PromotionEffectTarget;
    lineId: string | null;
    quantity: number | null;
    currencyCode: string;
    baseAmountMinor: number;
    discountAmountMinor: number;
}

export interface PromotionEvaluationResult {
    evaluatorVersion: number;
    applied: null | {
        promotionId: string;
        promotionRevision: number;
        promotionName: string;
        method: "automatic" | "code";
        promotionCode: string | null;
        totalDiscountMinor: number;
        allocations: PromotionAllocationPlan[];
    };
    rejected: Array<{
        promotionId: string;
        reason: PromotionRejectionReason;
        evaluatedSavingsMinor?: number;
    }>;
    unmatchedCodes: string[];
}

export class PromotionEvaluationInputError extends Error {
    readonly issues: z.core.$ZodIssue[];

    constructor(message: string, issues: z.core.$ZodIssue[]) {
        super(message);
        this.name = "PromotionEvaluationInputError";
        this.issues = issues;
    }
}

interface EvaluatedCandidate {
    candidate: PromotionCandidate;
    promotionCode: string | null;
    allocations: PromotionAllocationPlan[];
    totalDiscountMinor: number;
}

function toSafeNumber(value: bigint, label: string): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new PromotionEvaluationInputError(`${label} exceeds the supported range.`, []);
    }
    return Number(value);
}

function lineBaseMinor(line: PromotionEvaluationCart["lines"][number]): number {
    return toSafeNumber(
        BigInt(line.unitPriceMinor) * BigInt(line.quantity),
        `Cart line ${line.id}`,
    );
}

function percentageDiscount(baseMinor: number, basisPoints: number): number {
    const numerator = BigInt(baseMinor) * BigInt(basisPoints);
    return toSafeNumber((numerator + 5_000n) / 10_000n, "Percentage discount");
}

function fixedAcrossLineBases(
    totalDiscountMinor: number,
    bases: Array<{ id: string; baseMinor: number }>,
): Map<string, number> {
    const result = new Map<string, number>();
    const totalBase = bases.reduce((total, item) => total + BigInt(item.baseMinor), 0n);
    if (totalBase === 0n || totalDiscountMinor === 0) return result;

    const totalDiscount = BigInt(totalDiscountMinor);
    const shares = bases.map((item) => {
        const numerator = totalDiscount * BigInt(item.baseMinor);
        return {
            ...item,
            amount: numerator / totalBase,
            remainder: numerator % totalBase,
        };
    });
    let allocated = shares.reduce((total, item) => total + item.amount, 0n);
    shares.sort((left, right) => {
        if (left.remainder !== right.remainder) {
            return left.remainder > right.remainder ? -1 : 1;
        }
        return left.id.localeCompare(right.id);
    });
    for (const share of shares) {
        if (allocated >= totalDiscount) break;
        share.amount += 1n;
        allocated += 1n;
    }
    for (const share of shares) {
        const amount = toSafeNumber(share.amount, "Line allocation");
        if (amount > 0) result.set(share.id, amount);
    }
    return result;
}

function allocationFor(
    candidate: PromotionCandidate,
    promotionCode: string | null,
    effect: PromotionEffect,
    cart: PromotionEvaluationCart,
    input: {
        baseAmountMinor: number;
        discountAmountMinor: number;
        lineId?: string;
        quantity?: number;
    },
): PromotionAllocationPlan {
    return {
        promotionId: candidate.id,
        promotionRevision: candidate.revision,
        evaluatorVersion: PROMOTION_EVALUATOR_VERSION,
        promotionName: candidate.name,
        promotionCode,
        method: candidate.method,
        effectId: effect.id,
        effectKind: effect.kind,
        target: effect.target,
        lineId: input.lineId ?? null,
        quantity: input.quantity ?? null,
        currencyCode: cart.currencyCode,
        baseAmountMinor: input.baseAmountMinor,
        discountAmountMinor: input.discountAmountMinor,
    };
}

function effectDiscount(effect: PromotionEffect, baseAmountMinor: number): number {
    if (baseAmountMinor <= 0) return 0;
    if (effect.kind === "free") return baseAmountMinor;
    if (effect.kind === "fixed_amount_off") {
        return Math.min(baseAmountMinor, effect.config.amountMinor);
    }
    return Math.min(
        baseAmountMinor,
        percentageDiscount(baseAmountMinor, effect.config.basisPoints),
    );
}

function calculateCandidate(
    candidate: PromotionCandidate,
    promotionCode: string | null,
    cart: PromotionEvaluationCart,
    lineBases: Array<{
        line: PromotionEvaluationCart["lines"][number];
        baseMinor: number;
    }>,
    merchandiseSubtotalMinor: number,
): EvaluatedCandidate | { reason: PromotionRejectionReason } {
    for (const effect of candidate.effects) {
        if (
            effect.kind === "fixed_amount_off"
            && effect.config.currencyCode !== cart.currencyCode
        ) {
            return { reason: "effect_currency_mismatch" };
        }
    }

    const allocations: PromotionAllocationPlan[] = [];
    const remainingLineBases = new Map(
        lineBases.map(({ line, baseMinor }) => [line.id, baseMinor]),
    );
    const orderedEffects = [...candidate.effects].sort((left, right) => {
        const rank = { line: 0, order: 1, shipping: 2 } as const;
        return rank[left.target] - rank[right.target] || left.id.localeCompare(right.id);
    });

    for (const effect of orderedEffects) {
        if (effect.target === "line") {
            if (effect.kind === "fixed_amount_off") {
                const totalDiscount = Math.min(
                    merchandiseSubtotalMinor,
                    effect.config.amountMinor,
                );
                const shares = fixedAcrossLineBases(
                    totalDiscount,
                    lineBases.map(({ line, baseMinor }) => ({ id: line.id, baseMinor })),
                );
                for (const { line, baseMinor } of lineBases) {
                    const amount = shares.get(line.id) ?? 0;
                    if (amount <= 0) continue;
                    allocations.push(allocationFor(candidate, promotionCode, effect, cart, {
                        baseAmountMinor: baseMinor,
                        discountAmountMinor: amount,
                        lineId: line.id,
                        quantity: line.quantity,
                    }));
                    remainingLineBases.set(line.id, baseMinor - amount);
                }
            } else {
                for (const { line, baseMinor } of lineBases) {
                    const amount = effectDiscount(effect, baseMinor);
                    if (amount <= 0) continue;
                    allocations.push(allocationFor(candidate, promotionCode, effect, cart, {
                        baseAmountMinor: baseMinor,
                        discountAmountMinor: amount,
                        lineId: line.id,
                        quantity: line.quantity,
                    }));
                    remainingLineBases.set(line.id, baseMinor - amount);
                }
            }
            continue;
        }

        if (effect.target === "order") {
            const orderBases = lineBases
                .map(({ line }) => ({
                    line,
                    baseMinor: remainingLineBases.get(line.id) ?? 0,
                }))
                .filter(({ baseMinor }) => baseMinor > 0);
            const baseAmountMinor = toSafeNumber(
                orderBases.reduce((total, item) => total + BigInt(item.baseMinor), 0n),
                "Order effect base",
            );
            const amount = effectDiscount(effect, baseAmountMinor);
            const shares = fixedAcrossLineBases(
                amount,
                orderBases.map(({ line, baseMinor }) => ({ id: line.id, baseMinor })),
            );
            for (const { line, baseMinor } of orderBases) {
                const lineAmount = shares.get(line.id) ?? 0;
                if (lineAmount <= 0) continue;
                allocations.push(allocationFor(candidate, promotionCode, effect, cart, {
                    baseAmountMinor: baseMinor,
                    discountAmountMinor: lineAmount,
                    lineId: line.id,
                    quantity: line.quantity,
                }));
            }
            continue;
        }

        const amount = effectDiscount(effect, cart.shippingAmountMinor);
        if (amount <= 0) continue;
        allocations.push(allocationFor(candidate, promotionCode, effect, cart, {
            baseAmountMinor: cart.shippingAmountMinor,
            discountAmountMinor: amount,
        }));
    }

    const totalDiscountMinor = toSafeNumber(
        allocations.reduce(
            (total, allocation) => total + BigInt(allocation.discountAmountMinor),
            0n,
        ),
        "Promotion discount total",
    );
    return { candidate, promotionCode, allocations, totalDiscountMinor };
}

function rejectForLifecycle(
    candidate: PromotionCandidate,
    evaluatedAtEpochSeconds: number,
): PromotionRejectionReason | null {
    if (candidate.status !== "active") return "inactive";
    if (
        candidate.startsAtEpochSeconds !== null
        && evaluatedAtEpochSeconds < candidate.startsAtEpochSeconds
    ) {
        return "not_started";
    }
    if (
        candidate.endsAtEpochSeconds !== null
        && evaluatedAtEpochSeconds >= candidate.endsAtEpochSeconds
    ) {
        return "expired";
    }
    return null;
}

/**
 * Deterministic best-candidate evaluator for the first promotion authority
 * slice. It supports automatic and submitted-code methods, AND conditions,
 * line/order/shipping effects, and immutable allocation-plan output. Stacking,
 * audience/target selectors, budgets, and commit-time claims are deliberately
 * rejected by the schema until their authorities exist.
 */
export function evaluatePromotionCandidates(input: unknown): PromotionEvaluationResult {
    const parsedInput = evaluationInputSchema.safeParse(input);
    if (!parsedInput.success) {
        throw new PromotionEvaluationInputError(
            "Promotion evaluation input is invalid.",
            parsedInput.error.issues,
        );
    }
    const cart = {
        ...parsedInput.data.cart,
        submittedCodes: Array.from(new Set(
            parsedInput.data.cart.submittedCodes.map((code) => code.trim().toUpperCase()),
        )).sort((left, right) => left.localeCompare(right)),
    };
    const lineBases = cart.lines
        .map((line) => ({ line, baseMinor: lineBaseMinor(line) }))
        .sort((left, right) => left.line.id.localeCompare(right.line.id));
    const merchandiseSubtotalMinor = toSafeNumber(
        lineBases.reduce((total, line) => total + BigInt(line.baseMinor), 0n),
        "Merchandise subtotal",
    );
    const merchandiseQuantity = cart.lines.reduce(
        (total, line) => total + line.quantity,
        0,
    );
    const submittedCodeSet = new Set(cart.submittedCodes);
    const knownCodeSet = new Set<string>();
    const rejected: PromotionEvaluationResult["rejected"] = [];
    const eligible: EvaluatedCandidate[] = [];
    const candidateInputs = parsedInput.data.candidates.map((rawCandidate, index) => {
        const explicitId = rawCandidate
            && typeof rawCandidate === "object"
            && "id" in rawCandidate
            && typeof rawCandidate.id === "string"
            && rawCandidate.id.trim().length > 0
            ? rawCandidate.id.trim()
            : null;
        return {
            explicitId,
            fallbackId: `invalid:${index}`,
            parsed: promotionCandidateSchema.safeParse(rawCandidate),
        };
    });
    const candidateIdCounts = new Map<string, number>();
    const rejectedDuplicateIds = new Set<string>();

    for (const { explicitId } of candidateInputs) {
        if (explicitId !== null) {
            candidateIdCounts.set(
                explicitId,
                (candidateIdCounts.get(explicitId) ?? 0) + 1,
            );
        }
    }

    candidateInputs.forEach(({ explicitId, fallbackId, parsed: parsedCandidate }) => {
        if (explicitId !== null && (candidateIdCounts.get(explicitId) ?? 0) > 1) {
            if (!rejectedDuplicateIds.has(explicitId)) {
                rejected.push({
                    promotionId: explicitId,
                    reason: "invalid_configuration",
                });
                rejectedDuplicateIds.add(explicitId);
            }
            return;
        }
        if (!parsedCandidate.success) {
            rejected.push({
                promotionId: explicitId ?? fallbackId,
                reason: "invalid_configuration",
            });
            return;
        }
        const candidate = parsedCandidate.data;
        candidate.codes.forEach(({ code }) => knownCodeSet.add(code));

        const lifecycleReason = rejectForLifecycle(candidate, cart.evaluatedAtEpochSeconds);
        if (lifecycleReason) {
            rejected.push({ promotionId: candidate.id, reason: lifecycleReason });
            return;
        }

        const promotionCode = candidate.method === "code"
            ? candidate.codes
                .filter(({ code, isActive }) => isActive && submittedCodeSet.has(code))
                .map(({ code }) => code)
                .sort((left, right) => left.localeCompare(right))[0] ?? null
            : null;
        if (candidate.method === "code" && promotionCode === null) {
            rejected.push({ promotionId: candidate.id, reason: "code_not_submitted" });
            return;
        }

        for (const condition of candidate.conditions) {
            if (condition.kind === "minimum_merchandise_subtotal") {
                if (condition.config.currencyCode !== cart.currencyCode) {
                    rejected.push({
                        promotionId: candidate.id,
                        reason: "condition_currency_mismatch",
                    });
                    return;
                }
                if (merchandiseSubtotalMinor < condition.config.amountMinor) {
                    rejected.push({
                        promotionId: candidate.id,
                        reason: "minimum_subtotal_not_met",
                    });
                    return;
                }
            } else if (merchandiseQuantity < condition.config.quantity) {
                rejected.push({
                    promotionId: candidate.id,
                    reason: "minimum_quantity_not_met",
                });
                return;
            }
        }

        const calculated = calculateCandidate(
            candidate,
            promotionCode,
            cart,
            lineBases,
            merchandiseSubtotalMinor,
        );
        if ("reason" in calculated) {
            rejected.push({ promotionId: candidate.id, reason: calculated.reason });
            return;
        }
        if (calculated.totalDiscountMinor <= 0) {
            rejected.push({ promotionId: candidate.id, reason: "no_savings" });
            return;
        }
        eligible.push(calculated);
    });

    eligible.sort((left, right) => (
        right.totalDiscountMinor - left.totalDiscountMinor
        || left.candidate.priority - right.candidate.priority
        || left.candidate.id.localeCompare(right.candidate.id)
    ));
    const winner = eligible[0] ?? null;
    for (const losingCandidate of eligible.slice(1)) {
        rejected.push({
            promotionId: losingCandidate.candidate.id,
            reason: "lower_savings",
            evaluatedSavingsMinor: losingCandidate.totalDiscountMinor,
        });
    }
    rejected.sort((left, right) => (
        left.promotionId.localeCompare(right.promotionId)
        || left.reason.localeCompare(right.reason)
    ));

    return {
        evaluatorVersion: PROMOTION_EVALUATOR_VERSION,
        applied: winner ? {
            promotionId: winner.candidate.id,
            promotionRevision: winner.candidate.revision,
            promotionName: winner.candidate.name,
            method: winner.candidate.method,
            promotionCode: winner.promotionCode,
            totalDiscountMinor: winner.totalDiscountMinor,
            allocations: winner.allocations,
        } : null,
        rejected,
        unmatchedCodes: cart.submittedCodes.filter((code) => !knownCodeSet.has(code)),
    };
}
