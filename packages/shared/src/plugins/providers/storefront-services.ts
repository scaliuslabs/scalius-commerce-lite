// The search, address autocomplete and FX rate ports (docs/platform/PLUGINS.md,
// "Providers"). Each answers a narrow question; core keeps the authority:
//
// - search: product ids in rank order for a buyer's words. Core reads the
//   products itself (prices, availability, market), so a provider never
//   prices or shows a product the buyer cannot buy. Built-in full-text
//   search answers when no provider is active or the provider fails.
// - address: suggestions as the buyer types, then one suggestion as an
//   address. The checkout still validates the address by the country rules
//   (`@scalius/shared/address`); a suggestion only fills the form.
// - fx: exchange rates for markets that sell in their own currency. Core
//   asks on the scheduled tick and stores the rate on the market; a page or a
//   checkout never calls a provider. Manual rates are the default source.

import { z } from "zod";
import { providerCountrySchema, providerCurrencySchema } from "./common";

const locale = z.string().regex(/^[a-z]{2}$/, "An ISO 639-1 language code, lower case.");

// ── Search ──────────────────────────────────────────────────────────────────

export const SEARCH_PROVIDER_RESULTS_MAX = 50;

export const searchQueryInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  /** The page's language. */
  locale,
  /** The page's market (`mkt_…`), for market-specific ranking. */
  marketId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(SEARCH_PROVIDER_RESULTS_MAX),
}).strict();
export type SearchQueryInput = z.infer<typeof searchQueryInputSchema>;

export const searchQueryOutputSchema = z.object({
  /** Product ids, best first. Unknown, hidden or unbuyable ids are dropped by core. */
  productIds: z.array(z.string().min(1).max(64)).max(SEARCH_PROVIDER_RESULTS_MAX),
  /** Set when the provider searched for other words (a typo fix). */
  correctedQuery: z.string().trim().min(1).max(120).optional(),
}).strict();
export type SearchQueryOutput = z.infer<typeof searchQueryOutputSchema>;

export const SEARCH_PORT = {
  search: { input: searchQueryInputSchema, output: searchQueryOutputSchema },
} as const;

// ── Address autocomplete ────────────────────────────────────────────────────

export const ADDRESS_SUGGESTIONS_MAX = 8;

/** Groups a buyer's suggest calls and the resolve that ends them (provider billing sessions). */
const sessionToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const addressSuggestInputSchema = z.object({
  query: z.string().trim().min(3).max(200),
  country: providerCountrySchema,
  locale,
  sessionToken,
}).strict();

export const addressSuggestOutputSchema = z.object({
  suggestions: z.array(z.object({
    /** The provider's id for this place; sent back to `resolve`. */
    id: z.string().min(1).max(512),
    /** The line the buyer reads (`House 12, Road 5, Dhanmondi`). */
    text: z.string().min(1).max(200),
    /** A second, smaller line (`Dhaka 1205`). */
    secondaryText: z.string().max(200).optional(),
  }).strict()).max(ADDRESS_SUGGESTIONS_MAX),
}).strict();

export const addressResolveInputSchema = z.object({
  id: z.string().min(1).max(512),
  country: providerCountrySchema,
  locale,
  sessionToken,
}).strict();

/** The canonical address fields (`PostalAddressInput`): the form fills them and validates as usual. */
export const addressResolveOutputSchema = z.object({
  address: z.object({
    countryCode: providerCountrySchema,
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    dependentLocality: z.string().max(120).optional(),
    locality: z.string().max(120).optional(),
    adminArea: z.string().max(120).optional(),
    postalCode: z.string().max(20).optional(),
  }).strict(),
}).strict();

export const ADDRESS_PORT = {
  suggest: { input: addressSuggestInputSchema, output: addressSuggestOutputSchema },
  resolve: { input: addressResolveInputSchema, output: addressResolveOutputSchema },
} as const;

export type AddressSuggestInput = z.infer<typeof addressSuggestInputSchema>;
export type AddressSuggestOutput = z.infer<typeof addressSuggestOutputSchema>;
export type AddressResolveInput = z.infer<typeof addressResolveInputSchema>;
export type AddressResolveOutput = z.infer<typeof addressResolveOutputSchema>;

// ── FX rates ────────────────────────────────────────────────────────────────

export const FX_QUOTES_MAX = 50;

/** A positive exact decimal (`110.25`): the same shape a market's manual rate has. */
export const fxRateValueSchema = z.string().regex(/^(?=.*[1-9])\d{1,12}(?:\.\d{1,12})?$/, "A positive decimal, at most 12 digits each side.");

export const fxRatesInputSchema = z.object({
  /** The shop currency. */
  base: providerCurrencySchema,
  /** The market currencies to quote. */
  quotes: z.array(providerCurrencySchema).min(1).max(FX_QUOTES_MAX),
}).strict();

export const fxRatesOutputSchema = z.object({
  /** Units of `currency` per one unit of `base`; a currency left out keeps its last rate. */
  rates: z.array(z.object({
    currency: providerCurrencySchema,
    rate: fxRateValueSchema,
    /** When the provider took the rate (ISO 8601); now when absent. */
    asOf: z.iso.datetime({ offset: true }).optional(),
  }).strict()).max(FX_QUOTES_MAX),
}).strict();

export const FX_PORT = {
  rates: { input: fxRatesInputSchema, output: fxRatesOutputSchema },
} as const;

export type FxRatesInput = z.infer<typeof fxRatesInputSchema>;
export type FxRatesOutput = z.infer<typeof fxRatesOutputSchema>;
