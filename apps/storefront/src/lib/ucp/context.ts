/**
 * The market a UCP catalog request is answered in (docs/MARKETS-DESIGN.md D4).
 *
 * A storefront page's market is its URL presence. A UCP request has no page,
 * so its buyer context (`context.address_country`, `currency`, `language`)
 * picks the presence an agent's buyer would land on, and every read then runs
 * under that presence exactly as the presence page does: the same market
 * prices, currency and translations, and links into the same presence.
 *
 * - The country decides the market, like a shipping country at checkout; no
 *   market selling there leaves the backup market (the root).
 * - Without a country, a currency picks a market selling in it (the backup
 *   market first).
 * - The language picks one of that market's presences (`/bn`, `/en-in`).
 *
 * A signal the store cannot honour falls back to the root market (or the
 * market's own language) with a message, never an error: context is a hint.
 */
import {
  backupMarket,
  marketLanguagePresences,
  marketOfCountry,
  normalizeMarketCountry,
  primaryPresence,
  type MarketMatrix,
  type PublicMarket,
  type PublicMarketPresence,
} from "@scalius/shared/markets";

export interface UcpContextMessage {
  type: "warning" | "info";
  code: string;
  content: string;
}

export interface UcpPresenceResolution {
  /** The subfolder presence to answer in; `''` is the root (the backup market). */
  presence: string;
  /** Why a signal was not honoured; empty when every signal was. */
  messages: UcpContextMessage[];
}

function contextField(context: unknown, field: string): string {
  if (!context || typeof context !== "object" || Array.isArray(context)) return "";
  const value = (context as Record<string, unknown>)[field];
  return typeof value === "string" ? value.trim() : "";
}

/** The ISO 4217 code a request names, or '' (an unreadable value is ignored, not echoed). */
function requestedCurrency(context: unknown): { code: string; named: boolean } {
  const raw = contextField(context, "currency");
  const code = raw.toUpperCase();
  return { code: /^[A-Z]{3}$/.test(code) ? code : "", named: raw.length > 0 };
}

/** The primary language subtag of a BCP 47 tag (`fr-CA` -> `fr`), or ''. */
function requestedLanguage(context: unknown): string {
  const primary = contextField(context, "language").split(/[-_]/)[0]?.toLowerCase() ?? "";
  return /^[a-z]{2}$/.test(primary) ? primary : "";
}

/** The presence a market is reached at, or the root for a market without one. */
function presenceOf(market: PublicMarket | null): PublicMarketPresence | null {
  return market ? primaryPresence(market) : null;
}

/**
 * The presence a UCP request is answered in. `matrix` is the store's active
 * presence matrix (absent: the store has only its root); `shopCurrency` the
 * currency of a market without its own.
 */
export function resolveUcpPresence(
  matrix: MarketMatrix | null | undefined,
  shopCurrency: string,
  context: unknown,
): UcpPresenceResolution {
  const messages: UcpContextMessage[] = [];
  const markets = matrix?.markets ?? [];
  const backup = matrix ? backupMarket(matrix) : null;
  const currencyOf = (market: PublicMarket | null) =>
    (market?.currencyCode ?? shopCurrency).toUpperCase();

  const countryValue = contextField(context, "address_country");
  const currency = requestedCurrency(context);
  const language = requestedLanguage(context);

  let market: PublicMarket | null = backup;
  // An older API sends no matrix: the store has only its root, so only the currency can be checked.
  if (countryValue && matrix) {
    const country = normalizeMarketCountry(countryValue);
    const selling = country ? marketOfCountry(matrix, country) : null;
    if (selling && presenceOf(selling)) {
      market = selling;
    } else {
      messages.push({
        type: "warning",
        code: "market_unavailable",
        content: country
          ? `No market of this store sells to ${country}; prices are the store's default market's, in ${currencyOf(backup)}.`
          : `The country is not a two-letter ISO 3166-1 code; prices are the store's default market's, in ${currencyOf(backup)}.`,
      });
    }
  } else if (currency.code) {
    const selling = markets.filter((each) => currencyOf(each) === currency.code && presenceOf(each));
    market = selling.find((each) => each.isBackup) ?? selling[0] ?? backup;
  }

  if (currency.named && currencyOf(market) !== currency.code) {
    messages.push({
      type: "warning",
      code: "currency_unavailable",
      content: currency.code
        ? `Prices are in ${currencyOf(market)}: this market does not sell in ${currency.code}.`
        : `The currency is not an ISO 4217 code; prices are in ${currencyOf(market)}.`,
    });
  }

  let presence = presenceOf(market);
  if (language && market) {
    const inLanguage = marketLanguagePresences(market).find((each) => each.locale === language);
    if (inLanguage) {
      presence = inLanguage;
    } else {
      messages.push({
        type: "info",
        code: "language_unavailable",
        content: `Content is in ${presence?.locale ?? "the store's default language"}: this market has no ${language} pages.`,
      });
    }
  }

  return { presence: presence?.value ?? "", messages };
}
