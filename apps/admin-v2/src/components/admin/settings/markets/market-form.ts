// One market's editor values and the request they save (docs/MARKETS-DESIGN.md
// D4). A subfolder is the language and a two-letter country code (`en-in`);
// the primary (backup) market keeps the root URL; its language is the store's
// default, changed in Languages. Only the primary market sets a price increment; a market in the shop currency uses
// it, a market in its own currency (step 6) uses that currency's.
import { queryOptions } from "@tanstack/react-query";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { MANUAL_FX_RATE_SOURCE_ID, fxPriceMinor, marketFxPolicyIssue, type FxConversion } from "@scalius/shared/market-pricing";
import { MARKET_HANDLE_PATTERN } from "@scalius/shared/markets";
import { isFxRate } from "@scalius/shared/money-chain";
import { DEFAULT_FX_LOCK_MINUTES, MAX_FX_LOCK_MINUTES, MIN_FX_LOCK_MINUTES } from "@scalius/shared/presentment";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { fetchMarket, marketKeys, type CreateMarketBody, type Market, type UpdateMarketBody } from "~/lib/api-query-options/markets";
import type { SettingsMarketsMessageKey } from "~/i18n/settings-markets";

const SUFFIX_PATTERN = /^[a-z]{2}$/;
const LOCALE_PATTERN = /^[a-z]{2}$/;

export interface MarketForm {
  name: string;
  handle: string;
  status: "draft" | "active";
  countries: string[];
  /** A non-backup market sells at a subfolder. */
  subfolder: boolean;
  /** The presence's language: the root's for the backup market, else the subfolder's. */
  locale: string;
  /** The subfolder's country code, after the language (`in` in `en-in`). */
  suffix: string;
  priceIncrementMinor: number;
  /** Whether the market's prices include tax (MARKETS-DESIGN D8). */
  pricesIncludeTax: boolean;
  /** How a non-backup market prices (MARKETS-DESIGN D5): product prices, or product prices adjusted and rounded. */
  priceMode: "fixed" | "fx";
  /** Percent, two decimals; NaN while the typed text is refused. */
  priceAdjustmentPercent: number | null;
  /** Round adjusted prices up to this step (minor units); null: the price increment. */
  priceRoundingMinor: number | null;
  /** End rounded prices in this amount within the step (minor units); null: none. */
  priceEndingMinor: number | null;
  /** The exchange rate (units of its currency per shop unit); 1 in the shop currency. Typed, or an app's. */
  fxRate: string | null;
  /** Who sets the rate: "manual" (typed here) or an exchange rate app provider id. */
  fxRateSource: string;
  /** The currency buyers pay in: the shop currency, or its own (MARKETS-DESIGN step 6). */
  currencyCode: string;
  /** Minutes a placed order keeps its rate; NaN or null while the typed text is refused. */
  fxLockMinutes: number | null;
  // Facts the editor shows but never saves.
  isBackup: boolean;
  hasRootPresence: boolean;
  hasOrders: boolean;
  shopCurrencyCode: string;
  /** When the saved rate was set (ISO), or null. */
  fxRateAsOf: string | null;
  /** The source the saved rate came from. */
  savedFxRateSource: string;
}

export const EMPTY_MARKET_FORM: MarketForm = {
  name: "",
  handle: "",
  status: "draft",
  countries: [],
  subfolder: false,
  locale: "en",
  suffix: "",
  priceIncrementMinor: 1,
  pricesIncludeTax: false,
  priceMode: "fixed",
  priceAdjustmentPercent: 0,
  priceRoundingMinor: null,
  priceEndingMinor: null,
  fxRate: null,
  fxRateSource: MANUAL_FX_RATE_SOURCE_ID,
  currencyCode: "BDT",
  fxLockMinutes: DEFAULT_FX_LOCK_MINUTES,
  isBackup: false,
  hasRootPresence: false,
  hasOrders: false,
  shopCurrencyCode: "BDT",
  fxRateAsOf: null,
  savedFxRateSource: MANUAL_FX_RATE_SOURCE_ID,
};

/** True when the market sells in its own currency, not the shop's. */
export function sellsOwnCurrency(form: Pick<MarketForm, "currencyCode" | "shopCurrencyCode" | "isBackup">): boolean {
  return !form.isBackup && form.currencyCode !== form.shopCurrencyCode;
}

/** The editor values of a saved market, with the revision it saves against. */
export function marketForm(market: Market): MarketForm & { revision: number } {
  const presence = market.presence;
  const subfolder = !market.isBackup && Boolean(presence?.value);
  return {
    name: market.name,
    handle: market.handle,
    status: market.status,
    countries: [...market.countries],
    subfolder,
    locale: presence?.locale ?? "en",
    suffix: subfolder ? presence!.value.slice(3) : "",
    priceIncrementMinor: market.priceIncrementMinor,
    pricesIncludeTax: market.pricesIncludeTax,
    priceMode: market.priceMode,
    priceAdjustmentPercent: market.priceAdjustmentPercent,
    priceRoundingMinor: market.priceRounding === null ? null : toMinor(market.priceRounding, getDecimalPlaces(market.currencyCode)),
    priceEndingMinor: market.priceEnding === null ? null : toMinor(market.priceEnding, getDecimalPlaces(market.currencyCode)),
    fxRate: market.fxRate,
    fxRateSource: market.fxRateSource,
    currencyCode: market.currencyCode,
    fxLockMinutes: market.fxLockMinutes,
    isBackup: market.isBackup,
    hasRootPresence: market.isBackup && presence?.value === "",
    hasOrders: market.hasOrders,
    shopCurrencyCode: market.shopCurrencyCode,
    fxRateAsOf: market.fxRateAsOf,
    savedFxRateSource: market.fxRateSource,
    revision: market.revision,
  };
}

/** The subfolder path a market sells at (`/en-in`), the root (`/`), or null. */
export function presencePath(form: Pick<MarketForm, "isBackup" | "hasRootPresence" | "subfolder" | "locale" | "suffix">): string | null {
  if (form.isBackup) return form.hasRootPresence ? "/" : null;
  return form.subfolder ? `/${form.locale}-${form.suffix.trim().toLowerCase()}` : null;
}

/** One market's editor values, read fresh: a save is checked against their revision. */
export async function fetchMarketForm(id: string): Promise<MarketForm & { revision: number }> {
  return marketForm(await fetchMarket(id));
}

export const marketEditorQueryOptions = (id: string) =>
  queryOptions({ queryKey: marketKeys.detail(id), queryFn: () => fetchMarketForm(id), staleTime: 0 });

/** The path a saved market sells at, as the list shows it. */
export function marketPresencePath(market: Pick<Market, "presence">): string | null {
  if (!market.presence) return null;
  return market.presence.value ? `/${market.presence.value}` : "/";
}

export type MarketFormProblems = Partial<Record<"name" | "handle" | "countries" | "suffix" | "adjustment" | "rate" | "lock", SettingsMarketsMessageKey>>;

export function marketFormProblems(form: MarketForm): MarketFormProblems {
  const problems: MarketFormProblems = {};
  if (!form.name.trim()) problems.name = "nameRequired";
  if (!MARKET_HANDLE_PATTERN.test(form.handle.trim())) problems.handle = "handleInvalid";
  if (!form.isBackup && form.countries.length === 0) problems.countries = "countriesRequired";
  if (!form.isBackup && form.subfolder && !SUFFIX_PATTERN.test(form.suffix.trim().toLowerCase())) problems.suffix = "suffixInvalid";
  const own = sellsOwnCurrency(form);
  if (!form.isBackup && (own || form.priceMode === "fx") && adjustmentBps(form) === null) problems.adjustment = "adjustmentInvalid";
  // An app sets its own rate, so nothing typed here can be wrong.
  if (own && form.fxRateSource === MANUAL_FX_RATE_SOURCE_ID && !(form.fxRate !== null && isFxRate(form.fxRate.trim()))) problems.rate = "exchangeRateInvalid";
  if (own && (form.fxLockMinutes === null || !Number.isInteger(form.fxLockMinutes) || form.fxLockMinutes < MIN_FX_LOCK_MINUTES || form.fxLockMinutes > MAX_FX_LOCK_MINUTES)) {
    problems.lock = "rateLockInvalid";
  }
  return problems;
}

/** The PATCH body: every editable field, under the revision the editor loaded. */
export function marketUpdateBody(form: MarketForm, expectedRevision: number): UpdateMarketBody {
  const locale = LOCALE_PATTERN.test(form.locale) ? form.locale : "en";
  if (form.isBackup) {
    return {
      expectedRevision,
      name: form.name.trim(),
      handle: form.handle.trim(),
      countries: form.countries,
      ...(form.hasRootPresence ? { presence: { value: "", locale } } : {}),
      priceIncrementMinor: form.priceIncrementMinor,
      pricesIncludeTax: form.pricesIncludeTax,
    };
  }
  const own = sellsOwnCurrency(form);
  return {
    expectedRevision,
    name: form.name.trim(),
    handle: form.handle.trim(),
    status: form.status,
    countries: form.countries,
    presence: form.subfolder ? { value: `${locale}-${form.suffix.trim().toLowerCase()}`, locale } : null,
    pricesIncludeTax: form.pricesIncludeTax,
    // Its own currency converts at its rate (`fx`); the shop currency at 1.
    currencyCode: own ? form.currencyCode : null,
    // While an app sets the rate, the typed one is not sent (the API ignores it).
    ...(own && form.fxRateSource !== MANUAL_FX_RATE_SOURCE_ID ? {} : { fxRate: own ? form.fxRate?.trim() ?? null : null }),
    ...(own ? { fxRateSource: form.fxRateSource } : {}),
    ...(own && form.fxLockMinutes !== null ? { fxLockMinutes: form.fxLockMinutes } : {}),
    priceMode: own ? "fx" : form.priceMode,
    priceAdjustmentPercent: (adjustmentBps(form) ?? 0) / 100,
    priceRounding: form.priceRoundingMinor === null ? null : fromMinor(form.priceRoundingMinor, getDecimalPlaces(form.currencyCode)),
    priceEnding: form.priceEndingMinor === null ? null : fromMinor(form.priceEndingMinor, getDecimalPlaces(form.currencyCode)),
  };
}

// ---------------------------------------------------------------------------
// Adjusted prices (MARKETS-DESIGN D5): Shopify's price adjustment and rounding
// ---------------------------------------------------------------------------

/** The adjustment in basis points, or null when it is not a percentage from −99 to 1,000. */
export function adjustmentBps(form: Pick<MarketForm, "priceAdjustmentPercent">): number | null {
  const percent = form.priceAdjustmentPercent ?? 0;
  if (!Number.isFinite(percent) || percent < -99 || percent > 1_000) return null;
  return Math.round(percent * 100);
}

/** Rounding steps a merchant picks from: whole units and their usual multiples, at or above the increment. */
export function roundingChoices(currencyCode: string, incrementMinor: number): number[] {
  const unit = 10 ** getDecimalPlaces(currencyCode);
  const steps = [unit / 20, unit / 10, unit, unit * 5, unit * 10, unit * 50, unit * 100];
  return steps.filter((step) => Number.isInteger(step) && step >= incrementMinor && step % incrementMinor === 0);
}

/** Endings for a step: one increment below it (৳9 of ৳10, 0.99 of 1.00) and the usual 95 and 90. */
export function endingChoices(stepMinor: number | null, incrementMinor: number): number[] {
  if (stepMinor === null) return [];
  const candidates = [stepMinor - incrementMinor, Math.round(stepMinor * 0.95), Math.round(stepMinor * 0.9)];
  return [...new Set(candidates)].filter((ending) => ending > 0 && ending < stepMinor && ending % incrementMinor === 0);
}

/** The conversion a saved form describes, or null when it does not convert (fixed prices or an invalid entry). */
export function formConversion(form: MarketForm, incrementMinor: number): FxConversion | null {
  const bps = adjustmentBps(form);
  const own = sellsOwnCurrency(form);
  if (form.isBackup || (!own && form.priceMode !== "fx") || bps === null) return null;
  const rate = own ? form.fxRate?.trim() ?? "" : "1";
  const policy = { rate, adjustmentBps: bps, roundingMinor: form.priceRoundingMinor, endingMinor: form.priceEndingMinor };
  if (marketFxPolicyIssue(policy, incrementMinor) !== null) return null;
  return {
    policy,
    fromDecimalPlaces: getDecimalPlaces(form.shopCurrencyCode),
    toDecimalPlaces: getDecimalPlaces(form.currencyCode),
    incrementMinor,
  };
}

/** A few product prices and what the market's adjustment makes of them (minor units). */
export function adjustedPricePreview(form: MarketForm, incrementMinor: number, samples: readonly number[]): Array<{ base: number; adjusted: number }> {
  const conversion = formConversion(form, incrementMinor);
  if (!conversion) return [];
  return samples.map((base) => ({ base, adjusted: fxPriceMinor(base, conversion) }));
}

/** A new market: a draft with its name and countries; the handle comes from the name. */
export function createMarketBody(name: string, countries: readonly string[]): CreateMarketBody {
  return { name: name.trim(), status: "draft", countries: [...countries], presence: null };
}

/** Countries other markets sell to, with that market's name (each country belongs to one market). */
export function countriesTakenByOthers(markets: readonly Market[] | undefined, marketId: string | null): Map<string, string> {
  const taken = new Map<string, string>();
  for (const market of markets ?? []) {
    if (market.id === marketId) continue;
    for (const country of market.countries) taken.set(country, market.name);
  }
  return taken;
}

/** Turning a subfolder on starts from the market's first country. */
export function withSubfolder(form: MarketForm, on: boolean): MarketForm {
  if (!on) return { ...form, subfolder: false };
  return {
    ...form,
    subfolder: true,
    suffix: form.suffix || (form.countries[0] ?? "").toLowerCase(),
    locale: LOCALE_PATTERN.test(form.locale) ? form.locale : "en",
  };
}
