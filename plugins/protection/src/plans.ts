// Protection Plans' plans and prices, shared by the app (checkout functions)
// and its storefront part: no platform code, so the product page loads only
// these few functions.
export const APP_ID = "scaliuslabs.protection";
/** The key the plan travels under on a line and an order. */
export const PLAN_KEY = `${APP_ID}.plan`;
export const PLANS = {
  one_year: { years: 1, setting: "one_year_percent", name: "1-year protection plan" },
  two_years: { years: 2, setting: "two_years_percent", name: "2-year protection plan" },
  lifetime: { years: null, setting: "lifetime_percent", name: "Lifetime protection plan" },
} as const;
/** The terms every plan's warranty records carry. */
export const PLAN_TERMS = "Covers accidental damage and defects of the protected unit. Claim it from your account or your order receipt.";
export type PlanId = keyof typeof PLANS;
/** The decline the buyer ticks: the app's words, until the merchant writes theirs (`decline_text`). */
export const DECLINE_TEXT = "I don't need protection. If this item is damaged or lost through my own account or device, I am responsible.";
/** The key the decline travels under on a line. */
export const DECLINE_KEY = `${APP_ID}.decline`;
/** The plan choice "No protection": an answer, never a plan (nothing is priced or issued); the store asks the buyer to agree to `DECLINE_TEXT` first. */
export const DECLINED = "declined";


export type Settings = {
  one_year_percent?: number | null; two_years_percent?: number | null; lifetime_percent?: number | null;
  pricing?: string | null; tiers?: string | null;
};

/** One row of the price table, in the store currency's minor units: items up to `upToMinor` (null: above every row) cost `priceMinor`. */
export interface PriceTier { upToMinor: number | null; priceMinor: number }

/** A major-unit amount ("1,000.50") in minor units, or null. */
function minorOf(text: string, decimalPlaces: number): number | null {
  const value = text.replace(/[,\s]/gu, "");
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimalPlaces) return null;
  const minor = Number(whole) * 10 ** decimalPlaces + Number(fraction.padEnd(decimalPlaces, "0") || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * The price table (`tiers`): `up to=price` rows, cheapest first, ending with
 * `above=price`, in the store currency (`decimalPlaces` its places). Null
 * when it is malformed or has no `above` row: then no plan sells, so an item
 * of any price is always priced by the table.
 */
export function parsePriceTiers(text: string | null | undefined, decimalPlaces: number): PriceTier[] | null {
  const rows = (text ?? "").split(/[\n;]+/u).map((row) => row.trim()).filter(Boolean);
  const tiers: PriceTier[] = [];
  for (const row of rows) {
    const [limit, price] = row.split("=").map((part) => part?.trim() ?? "");
    const priceMinor = price ? minorOf(price, decimalPlaces) : null;
    if (priceMinor === null || priceMinor <= 0 || tiers.at(-1)?.upToMinor === null) return null;
    if (limit?.toLowerCase() === "above") { tiers.push({ upToMinor: null, priceMinor }); continue; }
    const upToMinor = limit ? minorOf(limit, decimalPlaces) : null;
    const previous = tiers.at(-1)?.upToMinor;
    if (upToMinor === null || (previous !== undefined && previous !== null && upToMinor <= previous)) return null;
    tiers.push({ upToMinor, priceMinor });
  }
  return tiers.at(-1)?.upToMinor === null ? tiers : null;
}

/** The table's price for an item of `itemMinor` (store currency). */
export function tierPrice(tiers: readonly PriceTier[], itemMinor: number): number {
  return tiers.find((tier) => tier.upToMinor === null || itemMinor <= tier.upToMinor)!.priceMinor;
}

/** Whether the plan sells: it has a share above 0, and in table pricing the table reads. */
export function planSells(plan: PlanId, settings: Settings, decimalPlaces: number): boolean {
  if (planPercent(plan, settings) === 0) return false;
  return settings.pricing !== "tiers" || parsePriceTiers(settings.tiers, decimalPlaces) !== null;
}

export function isPlan(value: unknown): value is PlanId {
  return value === "one_year" || value === "two_years" || value === "lifetime";
}

/** A plan's price as a share of the item, at most two decimals; 0 when the merchant set none (the plan is not sold). */
export function planPercent(plan: PlanId, settings: Settings): number {
  const percent = Number(settings[PLANS[plan].setting] ?? 0);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(1_000, Math.round(percent * 100) / 100);
}


