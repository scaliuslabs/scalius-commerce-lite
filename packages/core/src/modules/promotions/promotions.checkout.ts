import type { Database } from "@scalius/database/client";
import {
    customers,
    promotionCodes,
} from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { eq } from "drizzle-orm";

import {
    evaluatePromotionCandidates,
    promotionEvaluationCartSchema,
    type PromotionEvaluationCart,
    type PromotionEvaluationResult,
} from "./promotions.evaluator";
import {
    getPromotionAggregate,
    getPromotionUsageStats,
    type PromotionAggregate,
} from "./promotions.service";

export type AppliedPromotion = NonNullable<PromotionEvaluationResult["applied"]>;

export interface PromotionCheckoutSnapshot {
    cart: Omit<PromotionEvaluationCart, "evaluatedAtEpochSeconds">;
    applied: AppliedPromotion;
}

export type StorefrontPromotionCodeResolution =
    | { matched: false }
    | {
        matched: true;
        valid: false;
        promotionId: string | null;
        reason: string;
        message: string;
    }
    | {
        matched: true;
        valid: true;
        promotion: PromotionAggregate;
        evaluation: PromotionEvaluationResult & { applied: AppliedPromotion };
    };

function normalizePromotionCode(rawCode: string): string {
    return rawCode.trim().toUpperCase();
}

function rejectionMessage(reason: string): string {
    switch (reason) {
        case "not_started": return "This discount is not available yet.";
        case "expired": return "This discount has expired.";
        case "minimum_subtotal_not_met": return "Your cart does not meet this discount's minimum subtotal.";
        case "minimum_quantity_not_met": return "Your cart does not meet this discount's minimum item quantity.";
        case "condition_currency_mismatch":
        case "effect_currency_mismatch":
        case "budget_currency_mismatch":
            return "This discount is not available in the checkout currency.";
        case "redemption_limit_reached": return "This discount has reached its usage limit.";
        case "customer_redemption_limit_reached": return "This discount has already reached your usage limit.";
        case "discount_budget_exhausted":
        case "discount_budget_insufficient":
            return "This discount's campaign budget is no longer available.";
        case "no_savings": return "This discount does not apply to the current cart.";
        default: return "This discount is not active or available.";
    }
}

export async function resolvePromotionCustomerIdByPhone(
    db: Database,
    canonicalPhone: string,
): Promise<string | null> {
    const row = await db.select({ id: customers.id })
        .from(customers)
        .where(eq(customers.phone, canonicalPhone))
        .get();
    return row?.id ?? null;
}

export async function loadPromotionRuntimeCandidate(
    db: Database,
    promotionId: string,
    customerId: string | null,
): Promise<PromotionAggregate | null> {
    const aggregate = await getPromotionAggregate(db, promotionId);
    if (!aggregate) return null;
    const usage = await getPromotionUsageStats(db, promotionId, customerId);
    return { ...aggregate, ...usage };
}

export async function evaluateStorefrontPromotionCode(
    db: Database,
    input: {
        code: string;
        cart: Omit<PromotionEvaluationCart, "submittedCodes">;
        customerId: string | null;
    },
): Promise<StorefrontPromotionCodeResolution> {
    const normalizedCode = normalizePromotionCode(input.code);
    const codeRow = await db.select({ promotionId: promotionCodes.promotionId })
        .from(promotionCodes)
        .where(eq(promotionCodes.normalizedCode, normalizedCode))
        .get();
    if (!codeRow) return { matched: false };

    const promotion = await loadPromotionRuntimeCandidate(db, codeRow.promotionId, input.customerId);
    if (!promotion) {
        return {
            matched: true,
            valid: false,
            promotionId: codeRow.promotionId,
            reason: "inactive",
            message: rejectionMessage("inactive"),
        };
    }
    if (promotion.method !== "code") {
        return {
            matched: true,
            valid: false,
            promotionId: promotion.id,
            reason: "invalid_configuration",
            message: rejectionMessage("invalid_configuration"),
        };
    }

    const cart = promotionEvaluationCartSchema.parse({
        ...input.cart,
        submittedCodes: [normalizedCode],
    });
    const evaluation = evaluatePromotionCandidates({ cart, candidates: [promotion] });
    if (!evaluation.applied) {
        const rejection = evaluation.rejected.find(({ promotionId }) => promotionId === promotion.id);
        const reason = rejection?.reason ?? "inactive";
        return {
            matched: true,
            valid: false,
            promotionId: promotion.id,
            reason,
            message: rejectionMessage(reason),
        };
    }

    return {
        matched: true,
        valid: true,
        promotion,
        evaluation: { ...evaluation, applied: evaluation.applied },
    };
}

function canonicalApplied(applied: AppliedPromotion): string {
    return JSON.stringify({
        promotionId: applied.promotionId,
        promotionRevision: applied.promotionRevision,
        promotionName: applied.promotionName,
        method: applied.method,
        promotionCode: applied.promotionCode,
        totalDiscountMinor: applied.totalDiscountMinor,
        allocations: [...applied.allocations]
            .sort((left, right) => (
                left.effectId.localeCompare(right.effectId)
                || left.target.localeCompare(right.target)
                || (left.lineId ?? "").localeCompare(right.lineId ?? "")
            )),
    });
}

/**
 * Re-evaluates a prepared promotion at order-commit time. The D1 redemption
 * triggers remain the concurrent authority; this comparison gives buyers a
 * useful retry instead of accepting a stale price/allocation snapshot.
 */
export async function verifyPromotionCheckoutSnapshot(
    db: Database,
    snapshot: PromotionCheckoutSnapshot,
    customerId: string,
    evaluatedAtEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<AppliedPromotion> {
    const code = snapshot.applied.promotionCode;
    if (snapshot.applied.method !== "code" || !code) {
        throw new ValidationError("The prepared discount authority is invalid. Please retry checkout.");
    }
    const resolution = await evaluateStorefrontPromotionCode(db, {
        code,
        customerId,
        cart: {
            ...snapshot.cart,
            evaluatedAtEpochSeconds,
        },
    });
    if (!resolution.matched || !resolution.valid) {
        throw new ValidationError(
            resolution.matched ? resolution.message : "This discount is no longer available.",
        );
    }
    if (canonicalApplied(resolution.evaluation.applied) !== canonicalApplied(snapshot.applied)) {
        throw new ValidationError("This discount changed while you were checking out. Please review the updated total and try again.");
    }
    return resolution.evaluation.applied;
}

export function getPromotionRedemptionConstraintError(error: unknown): ValidationError | null {
    const message = error instanceof Error ? error.message : String(error);
    if (/PROMOTION_REDEMPTION_TOTAL_LIMIT/u.test(message)) {
        return new ValidationError("This discount has reached its usage limit.");
    }
    if (/PROMOTION_REDEMPTION_CUSTOMER_LIMIT/u.test(message)) {
        return new ValidationError("This discount has already reached your usage limit.");
    }
    if (/PROMOTION_REDEMPTION_SPEND_LIMIT/u.test(message)) {
        return new ValidationError("This discount's campaign budget is no longer available.");
    }
    if (/PROMOTION_REDEMPTION_NOT_ELIGIBLE|PROMOTION_REDEMPTION_ALLOCATION_MISMATCH|ORDER_DISCOUNT_ALLOCATION_REFERENCE_MISMATCH/u.test(message)) {
        return new ValidationError("This discount changed or expired during checkout. Please review your cart and try again.");
    }
    if (/promotion_redemptions_order_unique/u.test(message)) {
        return new ValidationError("This order has already claimed a discount.");
    }
    return null;
}
