import { z } from "zod";
import { cashRoundingMinor, percentOfMinor } from "@scalius/shared/money";

export const PROMOTION_EVALUATOR_VERSION = 2;

const MAX_LINES = 250;
const MAX_CANDIDATES = 100;
const MAX_SUBMITTED_CODES = 10;
const MAX_MINOR_AMOUNT = Number.MAX_SAFE_INTEGER;
/** Buy X get Y repetitions evaluated per order (bounds the work per checkout). */
const MAX_BUY_GET_APPLICATIONS = 10_000;
/** Products + collections one rule may target (keeps config JSON small). */
export const PROMOTION_SCOPE_LIMIT = 90;

export const DISCOUNT_CLASSES = ["product", "order", "shipping"] as const;
export type DiscountClass = (typeof DISCOUNT_CLASSES)[number];

const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/u);
const minorAmountSchema = z.number().int().min(0).max(MAX_MINOR_AMOUNT);
const positiveMinorSchema = z.number().int().positive().max(MAX_MINOR_AMOUNT);
const scopeIdsSchema = z.array(z.string().trim().min(1).max(160)).max(PROMOTION_SCOPE_LIMIT);
/**
 * Optional product/collection scope. Empty or absent means every line;
 * otherwise a line matches its product or any active collection containing it.
 */
const scopeShape = {
    productIds: scopeIdsSchema.optional(),
    collectionIds: scopeIdsSchema.optional(),
};

const cartLineSchema = z.object({
    id: z.string().trim().min(1).max(160),
    productId: z.string().trim().min(1).max(160),
    variantId: z.string().trim().min(1).max(160),
    unitPriceMinor: minorAmountSchema,
    quantity: z.number().int().min(1).max(10_000),
    /** Active collections containing the product, resolved by the caller. */
    collectionIds: scopeIdsSchema.default([]),
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
            context.addIssue({ code: "custom", path: ["lines", index, "id"], message: "Cart line IDs must be unique." });
        }
        seenLineIds.add(line.id);
        const lineBase = BigInt(line.unitPriceMinor) * BigInt(line.quantity);
        merchandiseSubtotal += lineBase;
        if (lineBase > BigInt(MAX_MINOR_AMOUNT)) {
            context.addIssue({ code: "custom", path: ["lines", index], message: "Cart line total exceeds the supported range." });
        }
    });
    if (merchandiseSubtotal + BigInt(cart.shippingAmountMinor) > BigInt(MAX_MINOR_AMOUNT)) {
        context.addIssue({ code: "custom", path: ["lines"], message: "Cart total exceeds the supported range." });
    }
});

export const promotionEvaluationCartSchema = cartSchema;

const conditionSchema = z.discriminatedUnion("kind", [
    z.object({
        id: z.string().trim().min(1).max(160),
        kind: z.literal("minimum_merchandise_subtotal"),
        config: z.object({
            amountMinor: positiveMinorSchema,
            currencyCode: currencyCodeSchema,
            ...scopeShape,
            /** Gates only the discount's bundled free shipping, checked after its savings. */
            shippingOnly: z.boolean().optional(),
        }),
    }),
    z.object({
        id: z.string().trim().min(1).max(160),
        kind: z.literal("minimum_item_quantity"),
        config: z.object({ quantity: z.number().int().positive().max(1_000_000), ...scopeShape }),
    }),
]);

/** Buy X get Y: what the customer must buy for each application. */
const buyRuleSchema = z.object({
    quantity: z.number().int().positive().max(10_000).optional(),
    amountMinor: positiveMinorSchema.optional(),
    currencyCode: currencyCodeSchema.optional(),
    ...scopeShape,
}).refine(
    (buy) => (buy.quantity === undefined) !== (buy.amountMinor === undefined)
        && (buy.amountMinor === undefined) === (buy.currencyCode === undefined),
    "Buy rules need either a quantity or an amount with its currency.",
);

const effectBaseSchema = z.object({
    id: z.string().trim().min(1).max(160),
    target: z.enum(["line", "order", "shipping"]),
    allocation: z.enum(["across", "once"]),
});

const effectSchema = z.discriminatedUnion("kind", [
    effectBaseSchema.extend({
        kind: z.literal("percentage_off"),
        config: z.object({
            basisPoints: z.number().int().min(1).max(10_000),
            ...scopeShape,
            /** Present only on Buy X get Y: the scope above is what the customer gets. */
            buy: buyRuleSchema.optional(),
            getQuantity: z.number().int().positive().max(10_000).optional(),
            maxUsesPerOrder: z.number().int().positive().max(MAX_BUY_GET_APPLICATIONS).optional(),
        }),
    }),
    effectBaseSchema.extend({
        kind: z.literal("fixed_amount_off"),
        config: z.object({
            amountMinor: positiveMinorSchema,
            currencyCode: currencyCodeSchema,
            ...scopeShape,
            /** Line effects only: take the amount off every eligible unit instead of once per order. */
            eachItem: z.boolean().optional(),
        }),
    }),
    effectBaseSchema.extend({
        kind: z.literal("free"),
        target: z.literal("shipping"),
        allocation: z.literal("once"),
        config: z.object({}),
    }),
]);

const combinesWithSchema = z.object({
    product: z.boolean(),
    order: z.boolean(),
    shipping: z.boolean(),
});

export type PromotionScope = { productIds?: string[]; collectionIds?: string[] };

export function hasScope(scope: PromotionScope | null | undefined): boolean {
    return (scope?.productIds?.length ?? 0) + (scope?.collectionIds?.length ?? 0) > 0;
}

export function discountClassOf(target: "line" | "order" | "shipping"): DiscountClass {
    return target === "line" ? "product" : target;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type ConditionShape = WithoutId<z.infer<typeof conditionSchema>>;
type EffectShape = WithoutId<z.infer<typeof effectSchema>>;

/** Shared business rules for stored rules (input validation) and evaluator candidates. */
export function checkPromotionRule(
    rule: {
        method: "automatic" | "code";
        codes: Array<{ code: string }>;
        startsAtEpochSeconds: number | null;
        endsAtEpochSeconds: number | null;
        maxRedemptions: number | null;
        maxRedemptionsPerCustomer: number | null;
        maxDiscountSpendMinor: number | null;
        budgetCurrencyCode: string | null;
        conditions: ConditionShape[];
        effects: EffectShape[];
    },
    context: z.RefinementCtx,
): void {
    const issue = (path: (string | number)[], message: string) =>
        context.addIssue({ code: "custom", path, message });
    if (rule.method === "code" && rule.codes.length === 0) issue(["codes"], "Code discounts need a code.");
    if (rule.method === "automatic" && rule.codes.length > 0) issue(["codes"], "Automatic discounts cannot have codes.");
    if (new Set(rule.codes.map(({ code }) => code)).size !== rule.codes.length) {
        issue(["codes"], "Discount codes must be unique.");
    }
    if (
        rule.method === "automatic"
        && (rule.maxRedemptions !== null || rule.maxRedemptionsPerCustomer !== null || rule.maxDiscountSpendMinor !== null)
    ) {
        issue(["maxRedemptions"], "Usage limits apply to discount codes only.");
    }
    if (
        rule.startsAtEpochSeconds !== null
        && rule.endsAtEpochSeconds !== null
        && rule.endsAtEpochSeconds <= rule.startsAtEpochSeconds
    ) {
        issue(["endsAtEpochSeconds"], "The end date must be after the start date.");
    }
    if (
        rule.maxRedemptions !== null
        && rule.maxRedemptionsPerCustomer !== null
        && rule.maxRedemptionsPerCustomer > rule.maxRedemptions
    ) {
        issue(["maxRedemptionsPerCustomer"], "Uses per customer cannot exceed total uses.");
    }
    if ((rule.maxDiscountSpendMinor === null) !== (rule.budgetCurrencyCode === null)) {
        issue(["maxDiscountSpendMinor"], "A spend budget needs both an amount and a currency.");
    }
    // One value per discount; a product or order value may also bundle free shipping.
    const bundlesShipping = rule.effects.length === 2
        && rule.effects[0]!.target !== "shipping"
        && rule.effects[1]!.target === "shipping"
        && rule.effects[1]!.kind === "free";
    if (rule.effects.length !== 1 && !bundlesShipping) {
        issue(["effects"], "A discount has one value, optionally with free shipping.");
    }
    rule.conditions.forEach((condition, index) => {
        if (condition.kind === "minimum_merchandise_subtotal" && condition.config.shippingOnly && !bundlesShipping) {
            issue(["conditions", index, "config"], "A free-shipping minimum needs bundled free shipping.");
        }
    });
    const currencies = new Set<string>();
    if (rule.budgetCurrencyCode) currencies.add(rule.budgetCurrencyCode);
    const scopes: Array<{ path: (string | number)[]; scope: PromotionScope }> = [];
    rule.conditions.forEach((condition, index) => {
        if (condition.kind === "minimum_merchandise_subtotal") currencies.add(condition.config.currencyCode);
        scopes.push({ path: ["conditions", index, "config"], scope: condition.config });
    });
    rule.effects.forEach((effect, index) => {
        const path = ["effects", index, "config"];
        const expectedAllocation = effect.target === "line" ? "across" : "once";
        if (effect.allocation !== expectedAllocation) {
            issue(["effects", index, "allocation"], "Line effects allocate across lines; order and shipping effects allocate once.");
        }
        if (effect.kind === "free") return;
        scopes.push({ path, scope: effect.config });
        if (effect.kind === "fixed_amount_off") {
            currencies.add(effect.config.currencyCode);
            if (effect.config.eachItem && effect.target !== "line") issue(path, "Only product discounts apply to each item.");
        } else {
            const { buy, getQuantity, maxUsesPerOrder } = effect.config;
            if (buy) {
                scopes.push({ path: [...path, "buy"], scope: buy });
                if (buy.currencyCode) currencies.add(buy.currencyCode);
                if (effect.target !== "line" || !getQuantity || !hasScope(effect.config) || !hasScope(buy)) {
                    issue(path, "Buy X get Y needs products to buy, products to get, and a quantity to get.");
                }
            } else if (getQuantity !== undefined || maxUsesPerOrder !== undefined) {
                issue(path, "Quantities to get apply to Buy X get Y only.");
            }
        }
        if (effect.target !== "line" && hasScope(effect.config)) {
            issue(path, "Only product discounts can target products or collections.");
        }
    });
    for (const { path, scope } of scopes) {
        if ((scope.productIds?.length ?? 0) + (scope.collectionIds?.length ?? 0) > PROMOTION_SCOPE_LIMIT) {
            issue(path, `A discount can target at most ${PROMOTION_SCOPE_LIMIT} products and collections.`);
        }
    }
    if (currencies.size > 1) issue(["budgetCurrencyCode"], "All amounts in a discount must use one currency.");
}

export const promotionCandidateSchema = z.object({
    id: z.string().trim().min(1).max(160),
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(160),
    method: z.enum(["automatic", "code"]),
    status: z.enum(["draft", "active", "paused", "archived"]),
    priority: z.number().int().min(0).max(10_000),
    conflictPolicy: z.literal("best"),
    combinesWith: combinesWithSchema,
    startsAtEpochSeconds: z.number().int().min(0).nullable(),
    endsAtEpochSeconds: z.number().int().min(0).nullable(),
    maxRedemptions: z.number().int().positive().nullable().default(null),
    maxRedemptionsPerCustomer: z.number().int().positive().nullable().default(null),
    maxDiscountSpendMinor: positiveMinorSchema.nullable().default(null),
    budgetCurrencyCode: currencyCodeSchema.nullable().default(null),
    redemptionCount: z.number().int().nonnegative().default(0),
    customerRedemptionCount: z.number().int().nonnegative().default(0),
    discountSpendMinor: minorAmountSchema.default(0),
    codes: z.array(z.object({
        code: z.string().regex(/^[A-Z0-9_-]{3,50}$/u),
        isActive: z.boolean(),
    })).max(1_000),
    conditions: z.array(conditionSchema).max(20),
    effects: z.array(effectSchema).min(1).max(2),
}).superRefine((candidate, context) => {
    checkPromotionRule(candidate, context);
    const ids = [...candidate.conditions, ...candidate.effects].map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", path: ["conditions"], message: "Rule IDs must be unique." });
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
type CartLine = PromotionEvaluationCart["lines"][number];

export type PromotionRejectionReason =
    | "invalid_configuration"
    | "inactive"
    | "not_started"
    | "expired"
    | "code_not_submitted"
    | "redemption_limit_reached"
    | "customer_redemption_limit_reached"
    | "budget_currency_mismatch"
    | "discount_budget_exhausted"
    | "discount_budget_insufficient"
    | "condition_currency_mismatch"
    | "minimum_subtotal_not_met"
    | "minimum_quantity_not_met"
    | "buy_requirement_not_met"
    | "get_items_missing"
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

export interface AppliedDiscount {
    promotionId: string;
    promotionRevision: number;
    promotionName: string;
    method: "automatic" | "code";
    promotionCode: string | null;
    discountClass: DiscountClass;
    totalDiscountMinor: number;
}

export interface PromotionEvaluationResult {
    evaluatorVersion: number;
    /** The best combinable set: at most one discount per class, product → order → shipping. */
    applied: null | {
        totalDiscountMinor: number;
        discounts: AppliedDiscount[];
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

interface Eligible {
    candidate: PromotionCandidate;
    /** The discount's value (product, order or shipping class). */
    effect: PromotionEffect;
    discountClass: DiscountClass;
    promotionCode: string | null;
    /** Free shipping bundled with a product or order value. */
    bundledShipping: PromotionEffect | null;
    /** Merchandise subtotal, after the order's other savings, that shipping savings need. */
    shippingMinimumMinor: number;
}

/** One effect's savings: per line id, or under SHIPPING_KEY. */
interface Computed {
    eligible: Eligible;
    effect: PromotionEffect;
    amounts: Map<string, number>;
    total: number;
}

const SHIPPING_KEY = "\u0000shipping";

function toSafeNumber(value: bigint, label: string): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new PromotionEvaluationInputError(`${label} exceeds the supported range.`, []);
    }
    return Number(value);
}

/**
 * Splits a fixed amount across weights by largest remainder (ties by id), so
 * the parts always sum to the amount and never exceed their weight. In a
 * cash-rounded currency (BDT) whole-taka amounts over whole-taka lines split
 * into whole taka, so no line carries paisa.
 */
function splitAcross(
    totalMinor: number,
    weights: Array<{ id: string; baseMinor: number }>,
    currencyCode: string,
): Map<string, number> {
    const unit = cashRoundingMinor(currencyCode);
    if (unit > 1 && totalMinor % unit === 0 && weights.every(({ baseMinor }) => baseMinor % unit === 0)) {
        const units = splitUnits(totalMinor / unit, weights.map(({ id, baseMinor }) => ({ id, baseMinor: baseMinor / unit })));
        return new Map([...units].map(([id, part]) => [id, part * unit]));
    }
    return splitUnits(totalMinor, weights);
}

function splitUnits(totalMinor: number, weights: Array<{ id: string; baseMinor: number }>): Map<string, number> {
    const result = new Map<string, number>();
    const totalBase = weights.reduce((total, item) => total + BigInt(item.baseMinor), 0n);
    if (totalBase === 0n || totalMinor <= 0) return result;
    const amount = BigInt(Math.min(totalMinor, toSafeNumber(totalBase, "Split base")));
    const shares = weights.map((item) => {
        const numerator = amount * BigInt(item.baseMinor);
        return { ...item, part: numerator / totalBase, remainder: numerator % totalBase };
    });
    let allocated = shares.reduce((total, item) => total + item.part, 0n);
    const byRemainder = [...shares].sort((left, right) =>
        left.remainder === right.remainder ? left.id.localeCompare(right.id) : left.remainder > right.remainder ? -1 : 1);
    for (const share of byRemainder) {
        if (allocated >= amount) break;
        share.part += 1n;
        allocated += 1n;
    }
    for (const share of shares) {
        if (share.part > 0n) result.set(share.id, toSafeNumber(share.part, "Line allocation"));
    }
    return result;
}

function lineInScope(line: CartLine, scope: PromotionScope): boolean {
    if (!hasScope(scope)) return true;
    return Boolean(scope.productIds?.includes(line.productId)
        || scope.collectionIds?.some((id) => line.collectionIds.includes(id)));
}

type BuyGetConfig = Extract<PromotionEffect, { kind: "percentage_off" }>["config"];

/**
 * Buy X get Y over unit counts. Each application first takes the "buy" units
 * (units the customer cannot get free first, then the most expensive), then
 * the cheapest remaining "get" units, like Shopify. Applications repeat until
 * the cart runs out or the per-order cap is reached. `buyMet` says the
 * customer bought enough but has not added the items they get.
 */
function buyGetUnits(lines: CartLine[], config: BuyGetConfig): { got: Map<string, number>; buyMet: boolean } {
    const buy = config.buy!;
    const getQuantity = config.getQuantity!;
    const inGet = (line: CartLine) => lineInScope(line, config);
    const buyLines = lines.filter((line) => lineInScope(line, buy)).sort((left, right) =>
        Number(inGet(left)) - Number(inGet(right))
        || right.unitPriceMinor - left.unitPriceMinor
        || left.id.localeCompare(right.id));
    const getLines = lines.filter(inGet).sort((left, right) =>
        left.unitPriceMinor - right.unitPriceMinor || left.id.localeCompare(right.id));
    const available = new Map(lines.map((line) => [line.id, line.quantity]));
    const got = new Map<string, number>();
    let buyMet = false;
    const maxUses = Math.min(config.maxUsesPerOrder ?? MAX_BUY_GET_APPLICATIONS, MAX_BUY_GET_APPLICATIONS);
    for (let uses = 0; uses < maxUses; uses += 1) {
        const draft = new Map(available);
        let needUnits = buy.quantity ?? 0;
        let needAmount = buy.amountMinor ?? 0;
        for (const line of buyLines) {
            if (needUnits <= 0 && needAmount <= 0) break;
            const left = draft.get(line.id) ?? 0;
            const take = buy.quantity !== undefined
                ? Math.min(left, needUnits)
                : Math.min(left, line.unitPriceMinor > 0 ? Math.ceil(needAmount / line.unitPriceMinor) : 0);
            draft.set(line.id, left - take);
            needUnits -= take;
            needAmount -= take * line.unitPriceMinor;
        }
        if (needUnits > 0 || needAmount > 0) break;
        buyMet = true;
        let needGet = getQuantity;
        const takes: Array<[string, number]> = [];
        for (const line of getLines) {
            if (needGet <= 0) break;
            const take = Math.min(draft.get(line.id) ?? 0, needGet);
            if (take <= 0) continue;
            draft.set(line.id, (draft.get(line.id) ?? 0) - take);
            takes.push([line.id, take]);
            needGet -= take;
        }
        if (needGet > 0) break;
        for (const [lineId, take] of takes) got.set(lineId, (got.get(lineId) ?? 0) + take);
        for (const [lineId, left] of draft) available.set(lineId, left);
    }
    return { got, buyMet };
}

function finish(eligible: Eligible, effect: PromotionEffect, amounts: Map<string, number>): Computed {
    for (const [key, amount] of amounts) if (amount <= 0) amounts.delete(key);
    const total = toSafeNumber([...amounts.values()].reduce((sum, amount) => sum + BigInt(amount), 0n), "Discount total");
    return { eligible, effect, amounts, total };
}

function computeProduct(eligible: Eligible, lines: CartLine[], currencyCode: string): Computed & { getMissing: boolean } {
    const { effect } = eligible;
    const amounts = new Map<string, number>();
    const scoped = lines.filter((line) => effect.kind !== "free" && lineInScope(line, effect.config));
    const base = (line: CartLine) => line.unitPriceMinor * line.quantity;
    let getMissing = false;
    if (effect.kind === "fixed_amount_off") {
        if (effect.config.eachItem) {
            for (const line of scoped) {
                amounts.set(line.id, Math.min(line.unitPriceMinor, effect.config.amountMinor) * line.quantity);
            }
        } else {
            const split = splitAcross(
                effect.config.amountMinor,
                scoped.map((line) => ({ id: line.id, baseMinor: base(line) })),
                currencyCode,
            );
            split.forEach((amount, lineId) => amounts.set(lineId, amount));
        }
    } else if (effect.kind === "percentage_off" && effect.config.buy) {
        const byId = new Map(lines.map((line) => [line.id, line]));
        const { got, buyMet } = buyGetUnits(lines, effect.config);
        getMissing = buyMet && got.size === 0;
        for (const [lineId, units] of got) {
            amounts.set(lineId, percentOfMinor(byId.get(lineId)!.unitPriceMinor * units, effect.config.basisPoints, currencyCode));
        }
    } else if (effect.kind === "percentage_off") {
        for (const line of scoped) amounts.set(line.id, percentOfMinor(base(line), effect.config.basisPoints, currencyCode));
    }
    return { ...finish(eligible, effect, amounts), getMissing };
}

function computeOrder(eligible: Eligible, remaining: Map<string, number>, currencyCode: string): Computed {
    const { effect } = eligible;
    const weights = [...remaining].filter(([, baseMinor]) => baseMinor > 0).map(([id, baseMinor]) => ({ id, baseMinor }));
    const subtotal = weights.reduce((total, { baseMinor }) => total + baseMinor, 0);
    const amount = effect.kind === "percentage_off"
        ? percentOfMinor(subtotal, effect.config.basisPoints, currencyCode)
        : effect.kind === "fixed_amount_off" ? Math.min(subtotal, effect.config.amountMinor) : 0;
    return finish(eligible, effect, splitAcross(amount, weights, currencyCode));
}

function computeShipping(eligible: Eligible, effect: PromotionEffect, shippingMinor: number, currencyCode: string): Computed {
    const amount = effect.kind === "free"
        ? shippingMinor
        : effect.kind === "percentage_off"
            ? percentOfMinor(shippingMinor, effect.config.basisPoints, currencyCode)
            : Math.min(shippingMinor, effect.config.amountMinor);
    return finish(eligible, effect, amount > 0 ? new Map([[SHIPPING_KEY, amount]]) : new Map());
}

function withinBudget(candidate: PromotionCandidate, total: number): boolean {
    return candidate.maxDiscountSpendMinor === null
        || candidate.discountSpendMinor + total <= candidate.maxDiscountSpendMinor;
}

/**
 * Symmetric: one discount allowing the other's class is enough, so a single
 * checkbox decides and merchants never have to tick both sides.
 */
export function discountsCombine(
    left: { discountClass: DiscountClass; combinesWith: Record<DiscountClass, boolean> },
    right: { discountClass: DiscountClass; combinesWith: Record<DiscountClass, boolean> },
): boolean {
    return left.discountClass !== right.discountClass
        && (left.combinesWith[right.discountClass] || right.combinesWith[left.discountClass]);
}

function combines(left: Eligible, right: Eligible): boolean {
    return discountsCombine(
        { discountClass: left.discountClass, combinesWith: left.candidate.combinesWith },
        { discountClass: right.discountClass, combinesWith: right.candidate.combinesWith },
    );
}

function rejectForLifecycle(candidate: PromotionCandidate, now: number): PromotionRejectionReason | null {
    if (candidate.status !== "active") return "inactive";
    if (candidate.startsAtEpochSeconds !== null && now < candidate.startsAtEpochSeconds) return "not_started";
    if (candidate.endsAtEpochSeconds !== null && now >= candidate.endsAtEpochSeconds) return "expired";
    return null;
}

/**
 * Limits and requirements known before any savings. An unscoped minimum
 * purchase on a shipping discount (or the minimum for bundled free shipping)
 * is checked later against the subtotal after the order's other savings.
 */
function rejectForRules(
    candidate: PromotionCandidate,
    effect: PromotionEffect,
    cart: PromotionEvaluationCart,
): PromotionRejectionReason | null {
    if (candidate.maxRedemptions !== null && candidate.redemptionCount >= candidate.maxRedemptions) {
        return "redemption_limit_reached";
    }
    if (
        candidate.maxRedemptionsPerCustomer !== null
        && candidate.customerRedemptionCount >= candidate.maxRedemptionsPerCustomer
    ) {
        return "customer_redemption_limit_reached";
    }
    if (candidate.maxDiscountSpendMinor !== null) {
        if (candidate.budgetCurrencyCode !== cart.currencyCode) return "budget_currency_mismatch";
        if (candidate.discountSpendMinor >= candidate.maxDiscountSpendMinor) return "discount_budget_exhausted";
    }
    for (const condition of candidate.conditions) {
        const scoped = cart.lines.filter((line) => lineInScope(line, condition.config));
        if (condition.kind === "minimum_merchandise_subtotal") {
            if (condition.config.currencyCode !== cart.currencyCode) return "condition_currency_mismatch";
            if (condition.config.shippingOnly) continue;
            const subtotal = scoped.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
            if (subtotal < condition.config.amountMinor) return "minimum_subtotal_not_met";
        } else if (scoped.reduce((total, line) => total + line.quantity, 0) < condition.config.quantity) {
            return "minimum_quantity_not_met";
        }
    }
    if (effect.kind === "fixed_amount_off" && effect.config.currencyCode !== cart.currencyCode) {
        return "effect_currency_mismatch";
    }
    if (effect.kind === "percentage_off" && effect.config.buy?.currencyCode
        && effect.config.buy.currencyCode !== cart.currencyCode) {
        return "effect_currency_mismatch";
    }
    return null;
}

function shippingMinimum(candidate: PromotionCandidate, shippingClass: boolean): number {
    return Math.max(0, ...candidate.conditions.flatMap((condition) =>
        condition.kind === "minimum_merchandise_subtotal"
        && (condition.config.shippingOnly || (shippingClass && !hasScope(condition.config)))
            ? [condition.config.amountMinor]
            : []));
}

function toAllocations(computed: Computed, lines: Map<string, CartLine>, cart: PromotionEvaluationCart): PromotionAllocationPlan[] {
    const { candidate, promotionCode } = computed.eligible;
    const { effect } = computed;
    return [...computed.amounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, discountAmountMinor]) => {
            const line = key === SHIPPING_KEY ? null : lines.get(key)!;
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
                lineId: line?.id ?? null,
                quantity: line?.quantity ?? null,
                currencyCode: cart.currencyCode,
                baseAmountMinor: line ? line.unitPriceMinor * line.quantity : cart.shippingAmountMinor,
                discountAmountMinor,
            };
        });
}

function promotionsOf(selection: Computed[]): PromotionCandidate[] {
    return [...new Map(selection.map(({ eligible }) => [eligible.candidate.id, eligible.candidate])).values()];
}

/** Deterministic preference between equal-savings selections. */
function selectionKey(selection: Computed[]): string {
    return promotionsOf(selection)
        .map((candidate) => `${String(candidate.priority).padStart(5, "0")}:${candidate.id}`)
        .join("|");
}

/**
 * Deterministic discount evaluator. Each candidate has one value in one class
 * (product, order, shipping); a product or order value may bundle free
 * shipping. Discounts of different classes combine when either of them
 * allows the other's class; at most one discount per class applies, and at
 * most one shipping saving. Product discounts apply first, order discounts to
 * the remaining subtotal, then shipping, whose minimum purchase is checked
 * against the subtotal after those savings. The selection with the most
 * savings wins (ties: fewer discounts, then lower priority, then id).
 */
export function evaluatePromotionCandidates(input: unknown): PromotionEvaluationResult {
    const parsedInput = evaluationInputSchema.safeParse(input);
    if (!parsedInput.success) {
        throw new PromotionEvaluationInputError("Promotion evaluation input is invalid.", parsedInput.error.issues);
    }
    const cart: PromotionEvaluationCart = {
        ...parsedInput.data.cart,
        lines: [...parsedInput.data.cart.lines].sort((left, right) => left.id.localeCompare(right.id)),
        submittedCodes: Array.from(new Set(
            parsedInput.data.cart.submittedCodes.map((code) => code.trim().toUpperCase()),
        )).sort((left, right) => left.localeCompare(right)),
    };
    const linesById = new Map(cart.lines.map((line) => [line.id, line]));
    const submitted = new Set(cart.submittedCodes);
    const knownCodes = new Set<string>();
    const rejected: PromotionEvaluationResult["rejected"] = [];
    const reject = (promotionId: string, reason: PromotionRejectionReason, evaluatedSavingsMinor?: number) =>
        rejected.push({ promotionId, reason, ...(evaluatedSavingsMinor === undefined ? {} : { evaluatedSavingsMinor }) });

    const rawCandidates = parsedInput.data.candidates.map((raw, index) => {
        const id = raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string" && raw.id.trim()
            ? raw.id.trim()
            : `invalid:${index}`;
        return { id, parsed: promotionCandidateSchema.safeParse(raw) };
    });
    const idCounts = new Map<string, number>();
    rawCandidates.forEach(({ id }) => idCounts.set(id, (idCounts.get(id) ?? 0) + 1));

    const merchandiseMinor = cart.lines.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
    const byClass: Record<DiscountClass, Eligible[]> = { product: [], order: [], shipping: [] };
    const duplicateReported = new Set<string>();
    for (const { id, parsed } of rawCandidates) {
        if ((idCounts.get(id) ?? 0) > 1 || !parsed.success) {
            if (!duplicateReported.has(id)) reject(id, "invalid_configuration");
            duplicateReported.add(id);
            continue;
        }
        const candidate = parsed.data;
        candidate.codes.forEach(({ code }) => knownCodes.add(code));
        const lifecycle = rejectForLifecycle(candidate, cart.evaluatedAtEpochSeconds);
        if (lifecycle) {
            reject(candidate.id, lifecycle);
            continue;
        }
        const promotionCode = candidate.method === "code"
            ? candidate.codes.filter(({ code, isActive }) => isActive && submitted.has(code)).map(({ code }) => code).sort()[0] ?? null
            : null;
        if (candidate.method === "code" && promotionCode === null) {
            reject(candidate.id, "code_not_submitted");
            continue;
        }
        const effect = candidate.effects[0]!;
        const reason = rejectForRules(candidate, effect, cart);
        if (reason) {
            reject(candidate.id, reason);
            continue;
        }
        const discountClass = discountClassOf(effect.target);
        const eligible: Eligible = {
            candidate,
            effect,
            discountClass,
            promotionCode,
            bundledShipping: candidate.effects[1] ?? null,
            shippingMinimumMinor: shippingMinimum(candidate, discountClass === "shipping"),
        };
        if (discountClass === "shipping" && merchandiseMinor < eligible.shippingMinimumMinor) {
            reject(candidate.id, "minimum_subtotal_not_met");
            continue;
        }
        byClass[discountClass].push(eligible);
    }

    const productOptions = byClass.product.flatMap((eligible) => {
        const computed = computeProduct(eligible, cart.lines, cart.currencyCode);
        if (computed.total <= 0) {
            const buyGet = eligible.effect.kind === "percentage_off" && eligible.effect.config.buy;
            reject(eligible.candidate.id, computed.getMissing ? "get_items_missing" : buyGet ? "buy_requirement_not_met" : "no_savings");
            return [];
        }
        if (!withinBudget(eligible.candidate, computed.total)) {
            reject(eligible.candidate.id, "discount_budget_insufficient", computed.total);
            return [];
        }
        return [computed];
    });
    const shippingOptions = byClass.shipping.flatMap((eligible) => {
        const computed = computeShipping(eligible, eligible.effect, cart.shippingAmountMinor, cart.currencyCode);
        if (computed.total <= 0) {
            reject(eligible.candidate.id, "no_savings");
            return [];
        }
        if (!withinBudget(eligible.candidate, computed.total)) {
            reject(eligible.candidate.id, "discount_budget_insufficient", computed.total);
            return [];
        }
        return [computed];
    });
    const fullBases = new Map(cart.lines.map((line) => [line.id, line.unitPriceMinor * line.quantity]));
    const orderOptions = byClass.order.filter((eligible) => {
        const computed = computeOrder(eligible, fullBases, cart.currencyCode);
        if (computed.total <= 0) reject(eligible.candidate.id, "no_savings");
        return computed.total > 0;
    });

    type Selection = { parts: Computed[]; total: number; merchandiseAfterMinor: number };
    let best: Selection | null = null;
    const consider = (parts: Computed[], merchandiseAfterMinor: number) => {
        const total = parts.reduce((sum, part) => sum + part.total, 0);
        if (total <= 0) return;
        const count = promotionsOf(parts).length;
        const current = best as Selection | null;
        if (
            !current
            || total > current.total
            || (total === current.total && (
                count < promotionsOf(current.parts).length
                || (count === promotionsOf(current.parts).length && selectionKey(parts) < selectionKey(current.parts))
            ))
        ) {
            best = { parts, total, merchandiseAfterMinor };
        }
    };
    /** Bundled free shipping of a chosen discount, when its minimum is met and its budget allows. */
    const bundledPart = (primary: Computed | null, merchandiseAfterMinor: number): Computed | null => {
        const eligible = primary?.eligible;
        if (!eligible?.bundledShipping || merchandiseAfterMinor < eligible.shippingMinimumMinor) return null;
        const part = computeShipping(eligible, eligible.bundledShipping, cart.shippingAmountMinor, cart.currencyCode);
        return part.total > 0 && withinBudget(eligible.candidate, primary!.total + part.total) ? part : null;
    };
    for (const product of [null, ...productOptions]) {
        const remaining = new Map(fullBases);
        product?.amounts.forEach((amount, lineId) => remaining.set(lineId, (remaining.get(lineId) ?? 0) - amount));
        for (const orderEligible of [null, ...orderOptions]) {
            if (product && orderEligible && !combines(product.eligible, orderEligible)) continue;
            const order = orderEligible ? computeOrder(orderEligible, remaining, cart.currencyCode) : null;
            if (order && (order.total <= 0 || !withinBudget(order.eligible.candidate, order.total))) continue;
            const merchandiseAfterMinor = merchandiseMinor - (product?.total ?? 0) - (order?.total ?? 0);
            const primaries = [product, order].filter((part): part is Computed => part !== null);
            const bundled = bundledPart(product, merchandiseAfterMinor) ?? bundledPart(order, merchandiseAfterMinor);
            if (bundled) {
                consider([...primaries, bundled], merchandiseAfterMinor);
                continue;
            }
            for (const shipping of [null, ...shippingOptions]) {
                if (shipping && merchandiseAfterMinor < shipping.eligible.shippingMinimumMinor) continue;
                const parts = shipping ? [...primaries, shipping] : primaries;
                const compatible = parts.every((left, index) =>
                    parts.slice(index + 1).every((right) => combines(left.eligible, right.eligible)));
                if (compatible) consider(parts, merchandiseAfterMinor);
            }
        }
    }

    const winner = best as Selection | null;
    const appliedIds = new Set(winner?.parts.map(({ eligible }) => eligible.candidate.id) ?? []);
    for (const computed of productOptions) {
        if (!appliedIds.has(computed.eligible.candidate.id)) {
            reject(computed.eligible.candidate.id, "lower_savings", computed.total);
        }
    }
    for (const computed of shippingOptions) {
        if (appliedIds.has(computed.eligible.candidate.id)) continue;
        const shortOfMinimum = (winner?.merchandiseAfterMinor ?? merchandiseMinor) < computed.eligible.shippingMinimumMinor;
        reject(computed.eligible.candidate.id, shortOfMinimum ? "minimum_subtotal_not_met" : "lower_savings", computed.total);
    }
    for (const eligible of orderOptions) {
        if (!appliedIds.has(eligible.candidate.id)) {
            reject(eligible.candidate.id, "lower_savings", computeOrder(eligible, fullBases, cart.currencyCode).total);
        }
    }
    rejected.sort((left, right) => left.promotionId.localeCompare(right.promotionId) || left.reason.localeCompare(right.reason));

    return {
        evaluatorVersion: PROMOTION_EVALUATOR_VERSION,
        applied: winner ? {
            totalDiscountMinor: winner.total,
            discounts: promotionsOf(winner.parts).map((candidate) => {
                const parts = winner.parts.filter(({ eligible }) => eligible.candidate.id === candidate.id);
                const { eligible } = parts[0]!;
                return {
                    promotionId: candidate.id,
                    promotionRevision: candidate.revision,
                    promotionName: candidate.name,
                    method: candidate.method,
                    promotionCode: eligible.promotionCode,
                    discountClass: eligible.discountClass,
                    totalDiscountMinor: parts.reduce((sum, part) => sum + part.total, 0),
                };
            }),
            allocations: winner.parts.flatMap((computed) => toAllocations(computed, linesById, cart)),
        } : null,
        rejected,
        unmatchedCodes: cart.submittedCodes.filter((code) => !knownCodes.has(code)),
    };
}
