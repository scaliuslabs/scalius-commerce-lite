/**
 * EMI plans: "from ৳X/month" on the product page and cards. Informational
 * only until an EMI payment integration exists (owner decision 2026-09-25):
 * off by default, shown only when the merchant has entered plans and the
 * product is `emi_eligible`.
 *
 * The plans live in a settings document (`settings.emi`, declared by the
 * settings domain with {@link normalizeEmiSettings}); there is no table.
 *
 * Money is integer minor units. A plan's bank conversion fee is a flat
 * percentage of the price over the whole tenure (how Bangladeshi banks quote
 * "0% EMI, 3% conversion fee for 6 months"). The fee rounds half-up to the
 * cash unit (whole taka in BDT) like every percentage in `money.ts`; the
 * monthly amount rounds UP to the cash unit, so `months × monthly` always
 * covers the total and the buyer is never shown less than the bank charges.
 */
import { z } from "zod";
import { cashRoundingMinor, percentOfMinor } from "./money";

export const EMI_MAX_PLANS = 24;
export const EMI_MIN_MONTHS = 2;
export const EMI_MAX_MONTHS = 60;
/** 50% total fee is far above any real plan; it bounds typos. */
export const EMI_MAX_FEE_BPS = 5_000;

export const emiPlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  /** The bank or card network, as buyers know it ("City Bank", "EBL"). */
  provider: z.string().trim().min(1).max(60),
  months: z.number().int().min(EMI_MIN_MONTHS).max(EMI_MAX_MONTHS),
  /** Total conversion fee over the tenure, in basis points (300 = 3%). */
  feeBps: z.number().int().min(0).max(EMI_MAX_FEE_BPS),
  /** The smallest price the plan applies to (integer minor units). */
  minAmountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type EmiPlan = z.infer<typeof emiPlanSchema>;

export const emiSettingsSchema = z.object({
  enabled: z.boolean(),
  plans: z.array(emiPlanSchema).max(EMI_MAX_PLANS),
}).strict().superRefine((settings, context) => {
  const ids = new Set<string>();
  settings.plans.forEach((plan, index) => {
    if (ids.has(plan.id)) context.addIssue({ code: "custom", path: ["plans", index, "id"], message: "Plan ids must be unique." });
    ids.add(plan.id);
  });
});
export type EmiSettings = z.infer<typeof emiSettingsSchema>;

export const DEFAULT_EMI_SETTINGS: EmiSettings = Object.freeze({ enabled: false, plans: [] }) as EmiSettings;

/** A stored document as valid settings; anything unreadable is "off" (fail closed). */
export function normalizeEmiSettings(value: unknown): EmiSettings {
  const result = emiSettingsSchema.safeParse(value);
  return result.success ? result.data : { enabled: false, plans: [] };
}

export interface EmiQuote {
  planId: string;
  provider: string;
  months: number;
  feeMinor: number;
  totalMinor: number;
  monthlyMinor: number;
}

function assertPrice(priceMinor: number): void {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) {
    throw new RangeError("EMI prices are non-negative integer minor units.");
  }
}

/** One plan applied to a price, or null when the price is below the plan's minimum or zero. */
export function emiQuote(priceMinor: number, plan: EmiPlan, currencyCode: string): EmiQuote | null {
  assertPrice(priceMinor);
  if (priceMinor === 0 || priceMinor < plan.minAmountMinor) return null;
  const unit = BigInt(cashRoundingMinor(currencyCode));
  const feeMinor = plan.feeBps === 0 ? 0 : percentOfMinor(priceMinor, plan.feeBps, currencyCode);
  const total = BigInt(priceMinor) + BigInt(feeMinor);
  const perMonth = (total + BigInt(plan.months) - 1n) / BigInt(plan.months);
  const monthly = ((perMonth + unit - 1n) / unit) * unit;
  return {
    planId: plan.id,
    provider: plan.provider,
    months: plan.months,
    feeMinor,
    totalMinor: Number(total),
    monthlyMinor: Number(monthly),
  };
}

/** Every applicable quote, cheapest monthly amount first (ties: fewer months, then id). */
export function emiQuotes(priceMinor: number, settings: EmiSettings, currencyCode: string): EmiQuote[] {
  if (!settings.enabled) return [];
  return settings.plans
    .map((plan) => emiQuote(priceMinor, plan, currencyCode))
    .filter((quote): quote is EmiQuote => quote !== null)
    .sort((a, b) => a.monthlyMinor - b.monthlyMinor || a.months - b.months || a.planId.localeCompare(b.planId));
}

/** The "from X/month" line: the lowest monthly amount, or null when no plan applies. */
export function lowestEmiQuote(priceMinor: number, settings: EmiSettings, currencyCode: string): EmiQuote | null {
  return emiQuotes(priceMinor, settings, currencyCode)[0] ?? null;
}
