import type { Database } from "@scalius/database/client";
import {
    collections,
    customers,
    productVariants,
    products,
    promotionCodes,
    promotionConditions,
    promotionEffects,
    promotionRedemptions,
    promotions,
} from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { formatMoney, getDecimalPlaces } from "@scalius/shared/currency";
import { discountedPriceMinor, fromMinor } from "@scalius/shared/money";
import { and, asc, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { collectionMembershipForConfig } from "../collections/collection-config";
import { publicProductBaseConditions, publicProductHasCustomerOptions } from "../products/public-eligibility";
import type { TaxDiscountAllocationInput } from "../tax/types";
import {
    discountClassOf,
    discountsCombine,
    evaluatePromotionCandidates,
    promotionCandidateSchema,
    type PromotionCandidate,
    type PromotionEvaluationCart,
    type PromotionEvaluationResult,
    type PromotionRejectionReason,
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

/** A product that completes a Buy X get Y offer, addable in one tap when it has one SKU. */
export interface DiscountOfferProduct {
    id: string;
    slug: string;
    name: string;
    /** The only SKU of a simple product; null when the buyer must pick options. */
    variantId: string | null;
    /** That SKU's catalog price (major units), when `variantId` is set. */
    price: number | null;
}

/** A Buy X get Y the buyer can complete by adding items. */
export interface StorefrontDiscountOffer {
    promotionId: string;
    title: string;
    code: string | null;
    /** "get": add these items to get them discounted; "buy": add these to qualify. */
    kind: "get" | "buy";
    /** Percentage off the items to get; 10000 means free. */
    basisPoints: number;
    /** Units to add (items to get, or items still to buy). */
    quantity: number;
    /** Amount still to spend when the rule is an amount (buy offers only). */
    shortfallMinor: number | null;
    products: DiscountOfferProduct[];
}

export type DiscountCodeRejectionReason =
    | "not_found"
    | "needs_phone"
    | "minimum_subtotal"
    | "minimum_quantity"
    | "get_items"
    | "buy_items"
    | "not_combinable"
    | "lower_savings"
    /** A delivery discount waiting for the buyer's address (kept, not refused). */
    | "needs_delivery"
    /** Another delivery discount already applies; only one per order. */
    | "delivery_discount_applied"
    | "unavailable";

/** A typed code that does not apply right now, and what the buyer can do about it. */
export interface RejectedDiscountCode {
    code: string;
    reason: DiscountCodeRejectionReason;
    /** Buyer-facing English sentence; storefronts may localize from the fields below. */
    message: string;
    shortfallMinor?: number;
    shortfallQuantity?: number;
    /** The applied discount this code cannot be combined with. */
    conflictsWith?: string;
    offer?: StorefrontDiscountOffer;
    requiresCustomerPhone?: boolean;
}

/**
 * One line per applied discount, split the way the buyer sees it: the part
 * off the items is a discount line, the part off delivery shows on the
 * delivery line ("Free" with the fee struck through).
 */
export interface AppliedDiscountLine {
    promotionId: string;
    title: string;
    code: string | null;
    /** Off the items. */
    amountMinor: number;
    /** Off delivery. */
    shippingAmountMinor: number;
    /** A code only: the automatic discount it replaced because it saves more and they can't be combined. */
    replaces?: string;
}

export interface StorefrontDiscountQuote {
    applied: AppliedPromotion | null;
    snapshot: PromotionCheckoutSnapshot | null;
    /** Exact per-line/shipping allocation for the tax quote. */
    taxAllocation: TaxDiscountAllocationInput | undefined;
    discounts: AppliedDiscountLine[];
    /** Automatic Buy X get Y discounts earned but not claimed: the items to get are not in the cart. */
    offers: StorefrontDiscountOffer[];
    /** Typed codes that do not apply; they add nothing to the totals above. */
    rejectedCodes: RejectedDiscountCode[];
}

export interface StorefrontDiscountInput {
    /** Codes the buyer typed. Active automatic discounts always compete. */
    codes?: readonly string[] | null;
    cart: StorefrontDiscountCart;
    /** False before the buyer has a delivery option: delivery discounts wait instead of failing. */
    shippingKnown?: boolean;
    /** Buyer identity for per-customer limits: a known id, else the checkout phone. */
    customerId?: string | null;
    customerPhone?: string | null;
    evaluatedAtEpochSeconds?: number;
}

/** Codes a buyer may submit together (at most one applies per discount class). */
export const MAX_SUBMITTED_DISCOUNT_CODES = 5;
const MAX_AUTOMATIC_CANDIDATES = 20;
const MAX_OFFER_PRODUCTS = 3;

function genericRejectionMessage(reason: PromotionRejectionReason | "inactive"): string {
    switch (reason) {
        case "not_started": return "This discount is not available yet.";
        case "expired": return "This discount has expired.";
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
        default: return "This discount is not active or available.";
    }
}

function scopedCollectionIds(
    candidates: ReadonlyArray<{ conditions: ReadonlyArray<{ config: unknown }>; effects: ReadonlyArray<{ config: unknown }> }>,
): string[] {
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
 * Loads the codes' promotions (any status, so the buyer hears why they fail)
 * plus the currently scheduled active automatic promotions, with code usage,
 * in one read batch.
 */
async function loadCandidates(
    db: Database,
    codes: readonly string[],
    input: StorefrontDiscountInput,
    now: number,
) {
    const codeIds = sql`SELECT ${promotionCodes.promotionId} FROM ${promotionCodes} WHERE ${idList(promotionCodes.normalizedCode, codes)}`;
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

type Candidate = PromotionCandidate;
type Effect = PromotionCandidate["effects"][number];

/** Candidates with valid rules, typed; the evaluator reports invalid ones itself. */
function typedCandidates(candidates: Awaited<ReturnType<typeof loadCandidates>>): Candidate[] {
    return candidates.flatMap((candidate) => {
        const parsed = promotionCandidateSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
    });
}
type OfferDraft = Omit<StorefrontDiscountOffer, "products"> & { productIds: string[] };

function normalizeCodes(codes: readonly string[] | null | undefined): string[] {
    const normalized = [...new Set((codes ?? []).map((code) => code.trim().toUpperCase()).filter(Boolean))];
    if (normalized.length > MAX_SUBMITTED_DISCOUNT_CODES) {
        throw new ValidationError(`Use up to ${MAX_SUBMITTED_DISCOUNT_CODES} discount codes.`);
    }
    return normalized;
}

function scopedQuantity(lines: readonly CheckoutLine[], scope: PromotionScope, lineCollections: Map<string, string[]>) {
    return inScope(lines, scope, lineCollections).reduce((total, line) => total + line.quantity, 0);
}

function inScope(lines: readonly CheckoutLine[], scope: PromotionScope, lineCollections: Map<string, string[]>) {
    const any = (scope.productIds?.length ?? 0) + (scope.collectionIds?.length ?? 0) === 0;
    return lines.filter((line) => any
        || scope.productIds?.includes(line.productId)
        || scope.collectionIds?.some((id) => lineCollections.get(line.productId)?.includes(id)));
}

function buyGetEffect(candidate: Candidate): Extract<Effect, { kind: "percentage_off" }> | null {
    const effect = candidate.effects[0];
    return effect?.kind === "percentage_off" && effect.config.buy ? effect : null;
}

/** What the buyer adds to complete a Buy X get Y: the items to get, or the rest of the items to buy. */
function buyGetOffer(
    candidate: Candidate,
    code: string | null,
    kind: "get" | "buy",
    lines: readonly CheckoutLine[],
    lineCollections: Map<string, string[]>,
): OfferDraft | null {
    const effect = buyGetEffect(candidate);
    if (!effect) return null;
    const { buy } = effect.config;
    const scope = kind === "get" ? effect.config : buy!;
    const stillToBuyMinor = kind === "buy" && buy!.amountMinor !== undefined
        ? Math.max(0, buy!.amountMinor - inScope(lines, buy!, lineCollections)
            .reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0))
        : null;
    return {
        promotionId: candidate.id,
        title: candidate.name,
        code,
        kind,
        basisPoints: effect.config.basisPoints,
        quantity: kind === "get"
            ? effect.config.getQuantity ?? 1
            : Math.max(1, (buy!.quantity ?? 0) - scopedQuantity(lines, buy!, lineCollections)),
        shortfallMinor: stillToBuyMinor,
        productIds: (scope.productIds ?? []).slice(0, MAX_OFFER_PRODUCTS),
    };
}

/** Names and, for simple products, the single SKU of every offered product, in one read batch. */
async function loadOfferProducts(
    db: Database,
    productIds: readonly string[],
    currencyCode: string,
): Promise<Map<string, DiscountOfferProduct>> {
    const result = new Map<string, DiscountOfferProduct>();
    if (productIds.length === 0) return result;
    const [productRows, skuRows] = await db.batch([
        db.select({
            id: products.id,
            slug: products.slug,
            name: products.name,
            optioned: publicProductHasCustomerOptions(),
            discountType: products.discountType,
            discountBps: products.discountBps,
            discountAmountMinor: products.discountAmountMinor,
        }).from(products).where(and(idList(products.id, productIds), ...publicProductBaseConditions())),
        db.select({
            id: productVariants.id,
            productId: productVariants.productId,
            priceMinor: productVariants.priceMinor,
            discountType: productVariants.discountType,
            discountBps: productVariants.discountBps,
            discountAmountMinor: productVariants.discountAmountMinor,
        }).from(productVariants).where(and(
            idList(productVariants.productId, productIds),
            isNull(productVariants.deletedAt),
            sql`${productVariants.id} <> 'default'`,
        )),
    ]);
    const decimalPlaces = getDecimalPlaces(currencyCode);
    for (const product of productRows) {
        const skus = skuRows.filter((sku) => sku.productId === product.id);
        const sku = !product.optioned && skus.length === 1 ? skus[0]! : null;
        const ownDiscount = sku && ((sku.discountType === "percentage" && sku.discountBps > 0)
            || (sku.discountType === "flat" && sku.discountAmountMinor > 0));
        const discount = ownDiscount ? sku : product;
        result.set(product.id, {
            id: product.id,
            slug: product.slug,
            name: product.name,
            variantId: sku?.id ?? null,
            price: sku
                ? fromMinor(discountedPriceMinor(
                    sku.priceMinor,
                    discount.discountType,
                    discount.discountBps,
                    discount.discountAmountMinor,
                    currencyCode,
                ), decimalPlaces)
                : null,
        });
    }
    return result;
}

function describeOffer(offer: StorefrontDiscountOffer): string {
    const item = offer.products.map(({ name }) => name).join(" or ") || "a qualifying item";
    if (offer.kind === "buy") {
        return offer.shortfallMinor !== null
            ? `Spend more on ${item} to get this discount.`
            : `Add ${offer.quantity} more ${item} to get this discount.`;
    }
    const benefit = offer.basisPoints >= 10_000 ? "free" : `${offer.basisPoints / 100}% off`;
    return `Add ${item} to your cart to get it ${benefit}.`;
}

/**
 * The one buyer discount path (storefront cart and tax quote, checkout, agent
 * checkout, and the commit re-check): evaluates the typed codes, if any,
 * against every active automatic discount and applies the best combinable
 * set (at most one discount per class). Codes that do not apply are returned
 * with the buyer-facing reason and add nothing; commit paths call
 * `assertDiscountCodesApplied` so an order never silently drops a code.
 */
export async function quoteStorefrontDiscount(
    db: Database,
    input: StorefrontDiscountInput,
): Promise<StorefrontDiscountQuote> {
    const codes = normalizeCodes(input.codes);
    const now = input.evaluatedAtEpochSeconds ?? Math.floor(Date.now() / 1_000);
    const { currencyCode } = input.cart;
    const loaded = await loadCandidates(db, codes, input, now);
    const candidates = typedCandidates(loaded);
    const knownCodes = new Set(loaded.flatMap((candidate) => candidate.codes.map(({ code }) => code)));
    const candidateByCode = new Map<string, Candidate>();
    for (const candidate of candidates) {
        for (const { code } of candidate.codes) if (codes.includes(code)) candidateByCode.set(code, candidate);
    }

    const rejected: Array<Omit<RejectedDiscountCode, "message" | "offer"> & { message?: string; offer?: OfferDraft }> = [];
    const submitted: string[] = [];
    for (const code of codes) {
        const candidate = candidateByCode.get(code);
        if (!candidate && knownCodes.has(code)) rejected.push({ code, reason: "unavailable" });
        else if (!candidate) rejected.push({ code, reason: "not_found", message: "This discount code is not valid." });
        else if (candidate.method !== "code") rejected.push({ code, reason: "unavailable" });
        else if (candidate.maxRedemptionsPerCustomer && !input.customerId && !input.customerPhone) {
            rejected.push({
                code,
                reason: "needs_phone",
                message: "Enter your phone number to check this one-use discount.",
                requiresCustomerPhone: true,
            });
        } else submitted.push(code);
    }

    const lineCollections = await resolveLineCollections(db, input.cart.lines, scopedCollectionIds(loaded));
    const evaluation = evaluatePromotionCandidates({
        cart: {
            ...input.cart,
            lines: input.cart.lines.map((line) => ({
                ...line,
                collectionIds: lineCollections.get(line.productId) ?? [],
            })),
            submittedCodes: submitted,
            evaluatedAtEpochSeconds: now,
        },
        candidates: loaded,
    });
    const applied = evaluation.applied;
    const appliedIds = new Set(applied?.discounts.map(({ promotionId }) => promotionId));
    const merchandiseMinor = input.cart.lines.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
    const nonShippingSavings = (applied?.discounts ?? [])
        .filter(({ discountClass }) => discountClass !== "shipping")
        .reduce((total, { totalDiscountMinor }) => total + totalDiscountMinor, 0);
    const accepted: string[] = [];
    for (const code of submitted) {
        const candidate = candidateByCode.get(code)!;
        if (appliedIds.has(candidate.id)) {
            accepted.push(code);
            continue;
        }
        const reason = evaluation.rejected.find(({ promotionId }) => promotionId === candidate.id)?.reason ?? "inactive";
        const discountClass = discountClassOf(candidate.effects[0]!.target);
        const appliedDelivery = discountClass === "shipping"
            ? applied?.discounts.find((other) => other.discountClass === "shipping")
            : undefined;
        if (appliedDelivery && appliedDelivery.totalDiscountMinor >= input.cart.shippingAmountMinor && input.cart.shippingAmountMinor > 0) {
            // Delivery is already free: no minimum this code still needs can make it better.
            rejected.push({
                code,
                reason: "delivery_discount_applied",
                conflictsWith: appliedDelivery.promotionCode ?? appliedDelivery.promotionName,
            });
        } else if (
            discountClass === "shipping"
            && input.shippingKnown === false
            && (reason === "no_savings" || reason === "lower_savings")
        ) {
            // One delivery discount per order: a second one waiting for the address says so now.
            const waiting = rejected.find((other) => other.reason === "needs_delivery");
            rejected.push(waiting
                ? { code, reason: "delivery_discount_applied", conflictsWith: waiting.code }
                : { code, reason: "needs_delivery" });
        } else if (reason === "minimum_subtotal_not_met") {
            const shippingMinimum = discountClass === "shipping"
                || candidate.conditions.some((condition) => condition.kind === "minimum_merchandise_subtotal" && condition.config.shippingOnly);
            const shortfalls = candidate.conditions.flatMap((condition) => {
                if (condition.kind !== "minimum_merchandise_subtotal") return [];
                const base = shippingMinimum && (condition.config.shippingOnly || discountClass === "shipping")
                    ? merchandiseMinor - nonShippingSavings
                    : inScope(input.cart.lines, condition.config, lineCollections)
                        .reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
                return condition.config.amountMinor > base ? [condition.config.amountMinor - base] : [];
            });
            rejected.push({ code, reason: "minimum_subtotal", shortfallMinor: Math.max(1, ...shortfalls) });
        } else if (reason === "minimum_quantity_not_met") {
            const shortfalls = candidate.conditions.flatMap((condition) => {
                if (condition.kind !== "minimum_item_quantity") return [];
                const have = scopedQuantity(input.cart.lines, condition.config, lineCollections);
                return condition.config.quantity > have ? [condition.config.quantity - have] : [];
            });
            rejected.push({ code, reason: "minimum_quantity", shortfallQuantity: Math.max(1, ...shortfalls) });
        } else if (reason === "get_items_missing" || reason === "buy_requirement_not_met") {
            const kind = reason === "get_items_missing" ? "get" : "buy";
            const offer = buyGetOffer(candidate, code, kind, input.cart.lines, lineCollections) ?? undefined;
            rejected.push({ code, reason: kind === "get" ? "get_items" : "buy_items", offer });
        } else if (reason === "lower_savings") {
            const conflict = applied?.discounts.find((other) => !discountsCombine(
                { discountClass, combinesWith: candidate.combinesWith },
                {
                    discountClass: other.discountClass,
                    combinesWith: candidates.find(({ id }) => id === other.promotionId)?.combinesWith
                        ?? { product: false, order: false, shipping: false },
                },
            ) && other.discountClass !== discountClass);
            // The same kind of discount already applies and saves at least as much: name it.
            const better = conflict ? undefined : applied?.discounts.find((other) => other.discountClass === discountClass);
            rejected.push(conflict
                ? { code, reason: "not_combinable", conflictsWith: conflict.promotionCode ?? conflict.promotionName }
                : better
                    ? { code, reason: "lower_savings", conflictsWith: better.promotionCode ?? better.promotionName }
                    : { code, reason: "lower_savings" });
        } else {
            rejected.push({ code, reason: "unavailable", message: genericRejectionMessage(reason) });
        }
    }

    const offerDrafts = evaluation.rejected
        .filter(({ reason }) => reason === "get_items_missing")
        .flatMap(({ promotionId }) => {
            const candidate = candidates.find(({ id }) => id === promotionId);
            return candidate?.method === "automatic"
                ? [buyGetOffer(candidate, null, "get", input.cart.lines, lineCollections)].filter((offer): offer is OfferDraft => offer !== null)
                : [];
        })
        .slice(0, 3);
    const offerProducts = await loadOfferProducts(db, [...new Set([
        ...offerDrafts.flatMap(({ productIds }) => productIds),
        ...rejected.flatMap(({ offer }) => offer?.productIds ?? []),
    ])], currencyCode);
    const finishOffer = ({ productIds, ...offer }: OfferDraft): StorefrontDiscountOffer => ({
        ...offer,
        products: productIds.flatMap((id) => {
            const product = offerProducts.get(id);
            return product ? [product] : [];
        }),
    });
    const money = (minor: number) => formatMoney(fromMinor(minor, getDecimalPlaces(currencyCode)), { code: currencyCode });
    const rejectedCodes = rejected.map(({ offer, message, ...rejection }): RejectedDiscountCode => {
        const finished = offer ? finishOffer(offer) : undefined;
        const text = message ?? (() => {
            switch (rejection.reason) {
                case "minimum_subtotal": return `Add ${money(rejection.shortfallMinor!)} more to use ${rejection.code}.`;
                case "minimum_quantity": return `Add ${rejection.shortfallQuantity} more ${rejection.shortfallQuantity === 1 ? "item" : "items"} to use ${rejection.code}.`;
                case "get_items":
                case "buy_items": return finished ? describeOffer(finished) : "Add the qualifying items to your cart to get this discount.";
                case "not_combinable": return `${rejection.code} can't be combined with ${rejection.conflictsWith}.`;
                case "lower_savings": return rejection.conflictsWith
                    ? `${rejection.conflictsWith} gives an equal or bigger discount, so ${rejection.conflictsWith} is applied.`
                    : "Your cart already gets an equal or better discount.";
                case "needs_delivery": return `Choose your delivery address to use ${rejection.code}.`;
                case "delivery_discount_applied": return `Only one delivery discount can be used. ${rejection.conflictsWith} already applies to delivery.`;
                default: return genericRejectionMessage("inactive");
            }
        })();
        return { ...rejection, message: text, ...(finished ? { offer: finished } : {}) };
    }).sort((left, right) => codes.indexOf(left.code) - codes.indexOf(right.code));

    const appliedClasses = new Set(applied?.discounts.map(({ discountClass }) => discountClass));
    /**
     * The automatic discount a code took the place of: it would have applied,
     * but it can't be combined with the code and the code saves more. An
     * automatic discount that lost to another applied discount of its own
     * kind was not replaced by the code.
     */
    const replacedBy = (discount: AppliedPromotion["discounts"][number]): string | undefined => {
        if (!discount.promotionCode) return undefined;
        const code = candidates.find(({ id }) => id === discount.promotionId);
        if (!code) return undefined;
        const automatic = evaluation.rejected.flatMap(({ promotionId, reason, evaluatedSavingsMinor }) => {
            if (reason !== "lower_savings" || !evaluatedSavingsMinor) return [];
            const candidate = candidates.find(({ id }) => id === promotionId);
            if (!candidate || candidate.method !== "automatic") return [];
            const automaticClass = discountClassOf(candidate.effects[0]!.target);
            const tookItsPlace = automaticClass === discount.discountClass
                || (!appliedClasses.has(automaticClass) && !discountsCombine(
                    { discountClass: automaticClass, combinesWith: candidate.combinesWith },
                    { discountClass: discount.discountClass, combinesWith: code.combinesWith },
                ));
            return tookItsPlace ? [candidate.name] : [];
        });
        return automatic[0];
    };

    const quote = {
        discounts: (applied?.discounts ?? []).map((discount) => {
            const shippingAmountMinor = applied!.allocations
                .filter(({ promotionId, target }) => promotionId === discount.promotionId && target === "shipping")
                .reduce((total, { discountAmountMinor }) => total + discountAmountMinor, 0);
            const replaces = replacedBy(discount);
            return {
                promotionId: discount.promotionId,
                title: discount.promotionName,
                code: discount.promotionCode,
                amountMinor: discount.totalDiscountMinor - shippingAmountMinor,
                shippingAmountMinor,
                ...(replaces ? { replaces } : {}),
            };
        }),
        offers: offerDrafts.map(finishOffer),
        rejectedCodes,
    };
    if (!applied) return { ...quote, applied: null, snapshot: null, taxAllocation: undefined };
    return {
        ...quote,
        applied,
        snapshot: {
            cart: {
                currencyCode,
                lines: input.cart.lines.map(({ id, productId, variantId, unitPriceMinor, quantity }) => ({
                    id, productId, variantId, unitPriceMinor, quantity,
                })),
                shippingAmountMinor: input.cart.shippingAmountMinor,
                submittedCodes: accepted,
            },
            applied,
        },
        taxAllocation: buildPromotionTaxAllocation(applied),
    };
}

/** An automatic Buy X get Y shown on the product page of an item the buyer can buy for it. */
export interface ProductBuyGetOffer {
    promotionId: string;
    title: string;
    /**
     * "buy": this product counts toward the offer and `products` are what the
     * buyer gets; "get": this product is what the buyer gets and `products`
     * are what to buy.
     */
    role: "buy" | "get";
    /** Units of this product (or its scope) to buy per application; null when the rule is an amount. */
    buyQuantity: number | null;
    buyAmountMinor: number | null;
    getQuantity: number;
    /** 10000 means the items to get are free. */
    basisPoints: number;
    /** The page can hide the offer after this time without waiting for a cache refresh. */
    endsAtEpochSeconds: number | null;
    /** The other side of the offer (up to three named products). */
    products: DiscountOfferProduct[];
}

/** Active automatic Buy X get Y discounts this product counts toward or is given by. */
export async function listProductBuyGetOffers(
    db: Database,
    productId: string,
    currencyCode: string,
    evaluatedAtEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<ProductBuyGetOffer[]> {
    const candidates = typedCandidates(
        await loadCandidates(db, [], { cart: { currencyCode, lines: [], shippingAmountMinor: 0 } }, evaluatedAtEpochSeconds),
    ).filter((candidate) => candidate.method === "automatic" && buyGetEffect(candidate));
    if (candidates.length === 0) return [];
    const line = { id: productId, productId, variantId: productId, unitPriceMinor: 0, quantity: 1 };
    const lineCollections = await resolveLineCollections(db, [line], scopedCollectionIds(candidates));
    const drafts = candidates.flatMap((candidate) => {
        const effect = buyGetEffect(candidate)!;
        const buy = effect.config.buy!;
        const buys = inScope([line], buy, lineCollections).length > 0;
        // The product given away names the products to buy, when the offer lists them.
        const gets = !buys && inScope([line], effect.config, lineCollections).length > 0 && (buy.productIds?.length ?? 0) > 0;
        if (!buys && !gets) return [];
        return [{
            promotionId: candidate.id,
            title: candidate.name,
            role: buys ? "buy" as const : "get" as const,
            buyQuantity: buy.quantity ?? null,
            buyAmountMinor: buy.amountMinor ?? null,
            getQuantity: effect.config.getQuantity ?? 1,
            basisPoints: effect.config.basisPoints,
            endsAtEpochSeconds: candidate.endsAtEpochSeconds,
            productIds: (buys ? effect.config.productIds ?? [] : buy.productIds ?? []).slice(0, MAX_OFFER_PRODUCTS),
        }];
    }).slice(0, 3);
    const offerProducts = await loadOfferProducts(db, [...new Set(drafts.flatMap(({ productIds }) => productIds))], currencyCode);
    return drafts.map(({ productIds, ...offer }) => ({
        ...offer,
        products: productIds.flatMap((id) => {
            const product = offerProducts.get(id);
            return product ? [product] : [];
        }),
    }));
}

/** Commit paths: every submitted code must apply, or the buyer hears why it does not. */
export function assertDiscountCodesApplied(quote: StorefrontDiscountQuote): void {
    const [first] = quote.rejectedCodes;
    if (!first) return;
    throw new ValidationError(
        first.message,
        first.requiresCustomerPhone ? { requiresCustomerPhone: true, code: first.code } : { code: first.code },
    );
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
        codes: submittedCodes,
        cart,
        customerId,
        evaluatedAtEpochSeconds,
    });
    assertDiscountCodesApplied(quote);
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
    if (/promotion_redemptions_order_promotion_unique|promotion_redemptions\.order_id/u.test(message)) {
        return new ValidationError("This order has already claimed this discount.");
    }
    return null;
}
