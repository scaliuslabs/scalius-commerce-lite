// A discount on the wire (audit L6): one spelling per concept. Amounts sit
// beside `currency` (the budget's beside `budgetCurrency`) and the schedule's
// zone is `timeZone`; an omitted zone is the store's, applied when the rule is
// saved (the promotions service), so no schema emits a default zone. The
// promotions service and its stored rules keep their own names
// (`currencyCode`, `budgetCurrencyCode`, `timezone`): this module renames at
// the edge, both ways, and maps a refusal's field paths to the wire names.
import { z } from "@hono/zod-openapi";
import {
  PROMOTION_CUSTOMER_SEGMENT_LIMIT,
  PROMOTION_SCOPE_LIMIT,
  createPromotionDraftSchema,
  updatePromotionDraftSchema,
  type CreatePromotionDraftInput,
  type UpdatePromotionDraftInput,
} from "@scalius/core/modules/promotions";
import { ValidationError } from "../../utils/api-error";
import { MAX_MINOR_AMOUNT } from "@scalius/shared/money";

const currencySchema = z.string().regex(/^[A-Z]{3}$/u).openapi({ description: "ISO 4217, the store currency." });
const positiveMinorSchema = z.number().int().positive().max(MAX_MINOR_AMOUNT);
const scopeIdsSchema = z.array(z.string().trim().min(1).max(160)).max(PROMOTION_SCOPE_LIMIT);
const scopeShape = {
  productIds: scopeIdsSchema.optional(),
  collectionIds: scopeIdsSchema.optional(),
};

const codeInput = z.object({
  code: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9_-]+$/u, "Codes may contain letters, numbers, underscores, and hyphens only.")
    .openapi({ description: "Saved upper-case." }),
  isActive: z.boolean().default(true),
}).strict();

const conditionInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("minimum_merchandise_subtotal"),
    config: z.object({
      amountMinor: positiveMinorSchema,
      currency: currencySchema,
      ...scopeShape,
      shippingOnly: z.boolean().optional().openapi({ description: "The minimum for the discount's bundled free shipping, after its savings." }),
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

const effectInput = z.discriminatedUnion("kind", [
  z.object({
    ...effectBaseShape,
    kind: z.literal("percentage_off"),
    config: z.object({
      basisPoints: z.number().int().min(1).max(10_000),
      ...scopeShape,
      buy: z.object({
        quantity: z.number().int().positive().max(10_000).optional(),
        amountMinor: positiveMinorSchema.optional(),
        currency: currencySchema.optional(),
        ...scopeShape,
      }).strict().optional().openapi({ description: "Buy X get Y: what the customer buys, a quantity or an amount (with its currency)." }),
      getQuantity: z.number().int().positive().max(10_000).optional(),
      maxUsesPerOrder: z.number().int().positive().max(10_000).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...effectBaseShape,
    kind: z.literal("fixed_amount_off"),
    config: z.object({
      amountMinor: positiveMinorSchema,
      currency: currencySchema,
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

const ruleShape = {
  name: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  method: z.enum(["automatic", "code"]),
  priority: z.number().int().min(0).max(10_000).default(100),
  conflictPolicy: z.literal("best").default("best"),
  combinesWith: z.object({
    product: z.boolean(),
    order: z.boolean(),
    shipping: z.boolean(),
  }).strict().default({ product: false, order: false, shipping: false })
    .openapi({ description: "Which other discount classes may apply to the same order (both sides must allow it)." }),
  startsAt: z.iso.datetime({ offset: true }).nullable().default(null).openapi({ description: "When it starts; null: now." }),
  endsAt: z.iso.datetime({ offset: true }).nullable().default(null).openapi({ description: "When it ends; null: never." }),
  timeZone: z.string().trim().min(1).max(80).optional()
    .openapi({ description: "The schedule's IANA time zone, such as Europe/London. Omit it for the store's zone (Settings → Store details)." }),
  maxRedemptions: z.number().int().positive().nullable().default(null),
  maxRedemptionsPerCustomer: z.number().int().positive().nullable().default(null),
  maxDiscountSpendMinor: positiveMinorSchema.nullable().default(null),
  budgetCurrency: currencySchema.nullable().default(null).openapi({ description: "The spend budget's currency (ISO 4217), with maxDiscountSpendMinor." }),
  codes: z.array(codeInput).max(90).default([]),
  conditions: z.array(conditionInput).max(20).default([]),
  effects: z.array(effectInput).min(1).max(2).openapi({ description: "One value; a product or order value may add free shipping as a second effect." }),
  customerSegmentIds: z.array(z.string().trim().min(1).max(40)).max(PROMOTION_CUSTOMER_SEGMENT_LIMIT).default([])
    .openapi({ description: "Only signed-in customers in any of these customer segments get this discount; empty means every customer." }),
};

export const createDiscountBody = z.object(ruleShape).strict();
export const updateDiscountBody = z.object({
  expectedRevision: z.number().int().positive().openapi({ description: "The discount's `revision` you read; a discount changed since is refused with 409 and nothing changes." }),
  ...ruleShape,
}).strict();

type WireRule = z.output<typeof createDiscountBody>;

/** Renames one key of a plain object, keeping the others. */
function renameKey(value: unknown, from: string, to: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !(from in value)) return value;
  const { [from]: moved, ...rest } = value as Record<string, unknown>;
  return { ...rest, [to]: moved };
}

/** A condition's or effect's config with its currency key renamed, `buy` included. */
function renameConfigCurrency(config: unknown, from: string, to: string): unknown {
  const renamed = renameKey(config, from, to);
  if (!renamed || typeof renamed !== "object" || !("buy" in renamed)) return renamed;
  const record = renamed as Record<string, unknown>;
  return { ...record, buy: renameKey(record.buy, from, to) };
}

function renameRuleParts<T extends { config: unknown }>(parts: readonly T[], from: string, to: string): T[] {
  return parts.map((part) => ({ ...part, config: renameConfigCurrency(part.config, from, to) }));
}

/** A wire rule renamed to the promotions service's fields. */
function renamedRule(rule: WireRule): CreatePromotionDraftInput {
  const { timeZone, budgetCurrency, conditions, effects, ...rest } = rule;
  return {
    ...rest,
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    budgetCurrencyCode: budgetCurrency,
    conditions: renameRuleParts(conditions, "currency", "currencyCode"),
    effects: renameRuleParts(effects, "currency", "currencyCode"),
  } as CreatePromotionDraftInput;
}

/**
 * A create body as the promotions service takes it, checked against the
 * service's rules here (one currency, a valid zone, codes only on code
 * discounts...), so a refusal is a 400 naming the wire fields. An omitted
 * zone becomes the store's.
 */
export function serviceRule(body: WireRule): CreatePromotionDraftInput {
  const parsed = createPromotionDraftSchema.safeParse(renamedRule(body));
  if (!parsed.success) throw wireRefusal(parsed.error);
  return parsed.data;
}

/** An update body as the promotions service takes it (see {@link serviceRule}). */
export function serviceUpdate(body: z.output<typeof updateDiscountBody>): UpdatePromotionDraftInput {
  const { expectedRevision, ...rule } = body;
  const parsed = updatePromotionDraftSchema.safeParse({ expectedRevision, ...renamedRule(rule) });
  if (!parsed.success) throw wireRefusal(parsed.error);
  return parsed.data;
}

/** A stored discount's rule fields as the wire names them. */
export function wireRule<T extends { timezone: string; budgetCurrencyCode: string | null; conditions: readonly { config: unknown }[]; effects: readonly { config: unknown }[] }>(discount: T) {
  const { timezone, budgetCurrencyCode, conditions, effects, ...rest } = discount;
  return {
    ...rest,
    timeZone: timezone,
    budgetCurrency: budgetCurrencyCode,
    conditions: renameRuleParts(conditions, "currencyCode", "currency") as unknown as T["conditions"],
    effects: renameRuleParts(effects, "currencyCode", "currency") as unknown as T["effects"],
  };
}

const WIRE_PATH: Record<string, string> = { timezone: "timeZone", budgetCurrencyCode: "budgetCurrency", currencyCode: "currency" };

/**
 * Runs a promotions write; a rule it refuses (its own checks: one currency,
 * a valid zone, the schedule's order...) is a 400 naming the wire fields.
 */
export async function withWireRefusals<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof z.ZodError) throw wireRefusal(error);
    throw error;
  }
}

function wireRefusal(error: z.ZodError): ValidationError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "string" ? WIRE_PATH[segment] ?? segment : segment)).join("."),
    message: issue.message,
  }));
  return new ValidationError(issues[0]?.message ?? "Check the discount.", { issues });
}
