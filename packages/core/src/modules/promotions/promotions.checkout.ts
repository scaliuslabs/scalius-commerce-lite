import type { Database } from "@scalius/database/client";
import {
    collections,
    customers,
    products,
    promotionCodes,
    promotionConditions,
    promotionEffects,
    promotionRedemptions,
    promotions,
} from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { and, asc, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { collectionMembershipForConfig } from "../collections/collection-config";
import type { TaxDiscountAllocationInput } from "../tax/types";
import {
    evaluatePromotionCandidates,
    type PromotionEvaluationCart,
    type PromotionEvaluationResult,
    type PromotionScope,
} from "./promotions.evaluator";
import { promotionCandidateRecord } from "./promotions.service";

export type AppliedPromotion = NonNullable<PromotionEvaluationResult["applied"]>;

type CheckoutLine = Omit<PromotionEvaluationCart["lines"][number], "collectionIds">;

export interface StorefrontDiscountCart {
    currencyCode: string;
    lines: CheckoutLine[];
    shippingAmountMinor: number;
}

/** What the order commit re-evaluates; present only when a discount applies. */
export interface PromotionCheckoutSnapshot {
    cart: StorefrontDiscountCart & { submittedCodes: string[] };
    applied: AppliedPromotion;
}

export interface StorefrontDiscountQuote {
    applied: AppliedPromotion | null;
    snapshot: PromotionCheckoutSnapshot | null;
    /** Exact per-line/shipping allocation for the tax quote. */
    taxAllocation: TaxDiscountAllocationInput | undefined;
    /**
     * Titles of automatic Buy X get Y discounts the buyer has earned but not
     * claimed: the free item is not in the cart yet (the storefront says so).
     */
    offers: string[];
}

export interface StorefrontDiscountInput {
    /** Code the buyer typed, if any. Active automatic discounts always compete. */
    code?: string | null;
    cart: StorefrontDiscountCart;
    /** Buyer identity for per-customer limits: a known id, else the checkout phone. */
    customerId?: string | null;
    customerPhone?: string | null;
    evaluatedAtEpochSeconds?: number;
}

const MAX_AUTOMATIC_CANDIDATES = 20;

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
        case "no_savings": return "This discount does not apply to the items in your cart.";
        case "buy_requirement_not_met": return "Add the qualifying items to your cart to get this discount.";
        case "get_items_missing": return "Add the free item to your cart to get this discount.";
        case "lower_savings": return "Your cart already gets a better discount.";
        default: return "This discount is not active or available.";
    }
}

function scopedCollectionIds(candidates: ReturnType<typeof promotionCandidateRecord>[]): string[] {
    const ids = new Set<string>();
    for (const candidate of candidates) {
        for (const rule of [...candidate.conditions, ...candidate.effects]) {
            const config = rule.config as (PromotionScope & { buy?: PromotionScope }) | null;
            for (const scope of [config, config?.buy]) {
                if (Array.isArray(scope?.collectionIds)) scope.collectionIds.forEach((id) => ids.add(String(id)));
            }
        }
    }
    return [...ids];
}

function idList(column: AnyColumn, ids: readonly string[]): SQL {
    return sql`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
}

/**
 * Loads the code's promotion (any status, so the buyer hears why it fails)
 * plus the currently scheduled active automatic promotions, with code usage,
 * in one read batch.
 */
async function loadCandidates(
    db: Database,
    code: string | null,
    input: StorefrontDiscountInput,
    now: number,
) {
    const codeIds = sql`SELECT ${promotionCodes.promotionId} FROM ${promotionCodes} WHERE ${promotionCodes.normalizedCode} = ${code ?? ""}`;
    const automaticIds = sql`SELECT automatic.id FROM (SELECT ${promotions.id} AS id FROM ${promotions}
        WHERE ${promotions.method} = 'automatic' AND ${promotions.status} = 'active'
          AND ${promotions.deletedAt} IS NULL
          AND (${promotions.startsAt} IS NULL OR ${promotions.startsAt} <= ${now})
          AND (${promotions.endsAt} IS NULL OR ${promotions.endsAt} > ${now})
        ORDER BY ${promotions.priority}, ${promotions.id} LIMIT ${MAX_AUTOMATIC_CANDIDATES}) AS automatic`;
    const candidateIds = sql`(${codeIds} UNION ${automaticIds})`;
    const customerMatch = input.customerId
        ? sql`${promotionRedemptions.customerId} = ${input.customerId}`
        : input.customerPhone
            ? sql`${promotionRedemptions.customerId} IN (SELECT ${customers.id} FROM ${customers} WHERE ${customers.phone} = ${input.customerPhone})`
            : sql`1 = 0`;
    const [parents, codeRows, conditionRows, effectRows, usageRows] = await db.batch([
        db.select().from(promotions).where(sql`${promotions.id} IN ${candidateIds}`),
        db.select().from(promotionCodes)
            .where(sql`${promotionCodes.promotionId} IN ${candidateIds}`)
            .orderBy(asc(promotionCodes.normalizedCode)),
        db.select().from(promotionConditions)
            .where(sql`${promotionConditions.promotionId} IN ${candidateIds}`)
            .orderBy(asc(promotionConditions.position), asc(promotionConditions.id)),
        db.select().from(promotionEffects)
            .where(and(sql`${promotionEffects.promotionId} IN ${candidateIds}`, isNull(promotionEffects.deletedAt)))
            .orderBy(asc(promotionEffects.position), asc(promotionEffects.id)),
        db.select({
            promotionId: promotionRedemptions.promotionId,
            redemptionCount: sql<number>`count(*)`,
            discountSpendMinor: sql<number>`coalesce(sum(${promotionRedemptions.discountAmountMinor}), 0)`,
            customerRedemptionCount: sql<number>`coalesce(sum(CASE WHEN ${customerMatch} THEN 1 ELSE 0 END), 0)`,
        }).from(promotionRedemptions)
            .where(sql`${promotionRedemptions.promotionId} IN (${codeIds})`)
            .groupBy(promotionRedemptions.promotionId),
    ]);
    const usage = new Map(usageRows.map((row) => [row.promotionId, row]));
    return parents.map((parent) => {
        const stats = usage.get(parent.id);
        return {
            ...promotionCandidateRecord(
                parent,
                codeRows.filter((row) => row.promotionId === parent.id),
                conditionRows.filter((row) => row.promotionId === parent.id),
                effectRows.filter((row) => row.promotionId === parent.id),
            ),
            redemptionCount: Number(stats?.redemptionCount ?? 0),
            customerRedemptionCount: Number(stats?.customerRedemptionCount ?? 0),
            discountSpendMinor: Number(stats?.discountSpendMinor ?? 0),
        };
    });
}

/**
 * Collections that contain each cart product, limited to the collections the
 * candidates target. Only active collections grant eligibility; manual
 * collections list products, dynamic ones list categories.
 */
async function resolveLineCollections(
    db: Database,
    lines: readonly CheckoutLine[],
    collectionIds: readonly string[],
): Promise<Map<string, string[]>> {
    const byProduct = new Map<string, string[]>();
    if (collectionIds.length === 0 || lines.length === 0) return byProduct;
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const [collectionRows, productRows] = await db.batch([
        db.select({ id: collections.id, config: collections.config }).from(collections).where(and(
            idList(collections.id, collectionIds),
            eq(collections.isActive, true),
            isNull(collections.deletedAt),
        )),
        db.select({ id: products.id, categoryId: products.categoryId })
            .from(products)
            .where(idList(products.id, productIds)),
    ]);
    const categoryByProduct = new Map(productRows.map((row) => [row.id, row.categoryId]));
    for (const collection of collectionRows) {
        const membership = collectionMembershipForConfig(collection.config);
        for (const productId of productIds) {
            const categoryId = categoryByProduct.get(productId);
            const member = membership.productIds.includes(productId)
                || (categoryId != null && membership.categoryIds.includes(categoryId));
            if (member) byProduct.set(productId, [...(byProduct.get(productId) ?? []), collection.id]);
        }
    }
    return byProduct;
}

export function buildPromotionTaxAllocation(applied: AppliedPromotion): TaxDiscountAllocationInput {
    const lineAmounts = new Map<string, number>();
    let shippingMinor = 0;
    for (const allocation of applied.allocations) {
        if (allocation.target === "shipping") {
            shippingMinor += allocation.discountAmountMinor;
            continue;
        }
        if (!allocation.lineId) {
            throw new ValidationError("Discount line allocation is missing its checkout line.");
        }
        lineAmounts.set(
            allocation.lineId,
            (lineAmounts.get(allocation.lineId) ?? 0) + allocation.discountAmountMinor,
        );
    }
    return {
        lines: [...lineAmounts.entries()].map(([lineId, amountMinor]) => ({ lineId, amountMinor })),
        shippingMinor,
    };
}

/**
 * The one buyer discount path (storefront validate, tax quote, checkout,
 * agent checkout, and the commit re-check): evaluates the typed code, if
 * any, against every active automatic discount and applies the best one.
 * A typed code that does not win fails closed with the buyer-facing reason.
 */
export async function quoteStorefrontDiscount(
    db: Database,
    input: StorefrontDiscountInput,
): Promise<StorefrontDiscountQuote> {
    const code = input.code?.trim().toUpperCase() || null;
    const now = input.evaluatedAtEpochSeconds ?? Math.floor(Date.now() / 1_000);
    const candidates = await loadCandidates(db, code, input, now);
    const codeCandidate = code
        ? candidates.find((candidate) => candidate.codes.some((row) => row.code === code))
        : undefined;
    if (code && !codeCandidate) throw new ValidationError("This discount code is not valid.");
    if (codeCandidate && codeCandidate.method !== "code") {
        throw new ValidationError(rejectionMessage("invalid_configuration"));
    }
    if (codeCandidate?.maxRedemptionsPerCustomer && !input.customerId && !input.customerPhone) {
        throw new ValidationError("Enter your phone number to check this one-use discount.", {
            requiresCustomerPhone: true,
        });
    }

    const lineCollections = await resolveLineCollections(db, input.cart.lines, scopedCollectionIds(candidates));
    const evaluation = evaluatePromotionCandidates({
        cart: {
            ...input.cart,
            lines: input.cart.lines.map((line) => ({
                ...line,
                collectionIds: lineCollections.get(line.productId) ?? [],
            })),
            submittedCodes: code ? [code] : [],
            evaluatedAtEpochSeconds: now,
        },
        candidates,
    });
    const applied = evaluation.applied;
    if (codeCandidate && !applied?.discounts.some(({ promotionId }) => promotionId === codeCandidate.id)) {
        const rejection = evaluation.rejected.find(({ promotionId }) => promotionId === codeCandidate.id);
        throw new ValidationError(rejectionMessage(rejection?.reason ?? "inactive"));
    }
    const offers = evaluation.rejected
        .filter(({ reason }) => reason === "get_items_missing")
        .flatMap(({ promotionId }) => {
            const candidate = candidates.find(({ id }) => id === promotionId);
            return candidate?.method === "automatic" ? [candidate.name] : [];
        })
        .slice(0, 3);
    if (!applied) return { applied: null, snapshot: null, taxAllocation: undefined, offers };
    return {
        offers,
        applied,
        snapshot: {
            cart: {
                currencyCode: input.cart.currencyCode,
                lines: input.cart.lines.map(({ id, productId, variantId, unitPriceMinor, quantity }) => ({
                    id, productId, variantId, unitPriceMinor, quantity,
                })),
                shippingAmountMinor: input.cart.shippingAmountMinor,
                submittedCodes: code ? [code] : [],
            },
            applied,
        },
        taxAllocation: buildPromotionTaxAllocation(applied),
    };
}

function canonicalApplied(applied: AppliedPromotion): string {
    return JSON.stringify({
        totalDiscountMinor: applied.totalDiscountMinor,
        discounts: [...applied.discounts].sort((left, right) => left.promotionId.localeCompare(right.promotionId)),
        allocations: [...applied.allocations]
            .sort((left, right) => (
                left.promotionId.localeCompare(right.promotionId)
                || left.effectId.localeCompare(right.effectId)
                || left.target.localeCompare(right.target)
                || (left.lineId ?? "").localeCompare(right.lineId ?? "")
            )),
    });
}

/**
 * Re-evaluates a prepared discount at order-commit time for the committing
 * customer. The redemption triggers (code limits, lifecycle) and the
 * allocation revision guard remain the concurrent authority; this check turns
 * a stale price into a useful retry instead of a silently different total.
 */
export async function verifyPromotionCheckoutSnapshot(
    db: Database,
    snapshot: PromotionCheckoutSnapshot,
    customerId: string,
    evaluatedAtEpochSeconds?: number,
): Promise<AppliedPromotion> {
    const { submittedCodes, ...cart } = snapshot.cart;
    const quote = await quoteStorefrontDiscount(db, {
        code: submittedCodes[0] ?? null,
        cart,
        customerId,
        evaluatedAtEpochSeconds,
    });
    if (!quote.applied || canonicalApplied(quote.applied) !== canonicalApplied(snapshot.applied)) {
        throw new ValidationError("This discount changed while you were checking out. Please review the updated total and try again.");
    }
    return quote.applied;
}

function errorText(error: unknown, depth = 0): string {
    if (depth > 3 || error === null || error === undefined) return "";
    if (error instanceof Error) {
        return `${error.message} ${errorText((error as Error & { cause?: unknown }).cause, depth + 1)}`;
    }
    return typeof error === "string" ? error : "";
}

export function getPromotionRedemptionConstraintError(error: unknown): ValidationError | null {
    const message = errorText(error);
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
    if (/promotion_redemptions_order_unique|promotion_redemptions\.order_id/u.test(message)) {
        return new ValidationError("This order has already claimed a discount.");
    }
    return null;
}
