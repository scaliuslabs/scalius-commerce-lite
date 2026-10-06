// One market's editor values and the request they save (docs/MARKETS-DESIGN.md
// D4). A subfolder is the language and a two-letter country code (`en-in`);
// the backup market keeps the root URL and edits only its language. Only the
// backup market has its own price increment; every other market uses it.
import { queryOptions } from "@tanstack/react-query";
import { MARKET_HANDLE_PATTERN } from "@scalius/shared/markets";
import { fetchMarket, marketKeys, type CreateMarketBody, type Market, type UpdateMarketBody } from "~/lib/api-query-options/markets";
import type { SettingsMarketsMessageKey } from "~/i18n/settings-markets";

/** The languages the storefront has text in. A market already in another language keeps it. */
export const MARKET_LANGUAGES = ["en", "bn"] as const;

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
  // Facts the editor shows but never saves.
  isBackup: boolean;
  hasRootPresence: boolean;
  hasOrders: boolean;
  currencyCode: string;
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
  isBackup: false,
  hasRootPresence: false,
  hasOrders: false,
  currencyCode: "BDT",
};

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
    isBackup: market.isBackup,
    hasRootPresence: market.isBackup && presence?.value === "",
    hasOrders: market.hasOrders,
    currencyCode: market.currencyCode,
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

export type MarketFormProblems = Partial<Record<"name" | "handle" | "countries" | "suffix", SettingsMarketsMessageKey>>;

export function marketFormProblems(form: MarketForm): MarketFormProblems {
  const problems: MarketFormProblems = {};
  if (!form.name.trim()) problems.name = "nameRequired";
  if (!MARKET_HANDLE_PATTERN.test(form.handle.trim())) problems.handle = "handleInvalid";
  if (!form.isBackup && form.countries.length === 0) problems.countries = "countriesRequired";
  if (!form.isBackup && form.subfolder && !SUFFIX_PATTERN.test(form.suffix.trim().toLowerCase())) problems.suffix = "suffixInvalid";
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
  return {
    expectedRevision,
    name: form.name.trim(),
    handle: form.handle.trim(),
    status: form.status,
    countries: form.countries,
    presence: form.subfolder ? { value: `${locale}-${form.suffix.trim().toLowerCase()}`, locale } : null,
    pricesIncludeTax: form.pricesIncludeTax,
  };
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
