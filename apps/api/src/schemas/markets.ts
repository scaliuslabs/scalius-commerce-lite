// Markets on the wire (docs/MARKETS-DESIGN.md D4): the public presence matrix
// the storefront resolves pages against, and the dashboard's market record.
import { z } from "@hono/zod-openapi";
import {
  MARKET_HANDLE_MAX_LENGTH,
  MARKET_NAME_MAX_LENGTH,
  MAX_MARKET_COUNTRIES,
  MAX_MARKETS,
} from "@scalius/shared/markets";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor, toMinor } from "@scalius/shared/money";

const presenceFields = {
  value: z.string().max(5).openapi({ description: "The subfolder (`en-in`: the language and the country), or `''` for the root URL, which only the backup market holds." }),
  locale: z.string().length(2).openapi({ description: "The language of the presence's pages (ISO 639-1)." }),
};

export const marketPresenceSchema = z.object(presenceFields).openapi("MarketPresence");

export const publicMarketSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  isBackup: z.boolean().openapi({ description: "The backup market catches every buyer no other market matches and is sold at the root URL." }),
  countries: z.array(z.string().length(2)).max(MAX_MARKET_COUNTRIES),
  presences: z.array(marketPresenceSchema).max(MAX_MARKETS),
}).openapi("PublicMarket");

export const marketMatrixSchema = z.object({
  markets: z.array(publicMarketSchema).max(MAX_MARKETS),
}).openapi("MarketMatrix", {
  description: "Every active market with its countries and subfolder presences, backup first. Draft markets are left out.",
});

export const marketRecordSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  status: z.enum(["draft", "active"]).openapi({ description: "Only active markets resolve for buyers." }),
  isBackup: z.boolean(),
  revision: z.number().int().positive(),
  countries: z.array(z.string().length(2)).max(MAX_MARKET_COUNTRIES),
  // Inline, not the named component: a nullable reference loses its null in the generated client types.
  presence: z.object(presenceFields).nullable().openapi({ description: "The root presence of the backup market, or the market's subfolder; null when it has none." }),
  currencyCode: z.string().openapi({ description: "Every market sells in the shop currency until markets get their own currency." }),
  priceIncrementMinor: z.number().int().positive().openapi({ description: "The price increment its prices use, in minor units: the backup market's own, inherited by every other market." }),
  priceIncrementInherited: z.boolean(),
  pricesIncludeTax: z.boolean().openapi({ description: "Whether the market's prices include tax: checkout adds tax on top when false, and shows it as included when true." }),
  priceMode: z.enum(["fixed", "fx"]).openapi({ description: "`fixed`: product prices and the market's fixed price lists. `fx`: product prices converted at its exchange rate, adjusted, rounded up and ending as set. The backup market is always `fixed`." }),
  fxRate: z.string().nullable().openapi({ description: "The manual exchange rate (market currency per shop currency unit); null uses the rate source. A market in the shop currency converts at 1." }),
  priceAdjustmentPercent: z.number().openapi({ description: "Raises (positive) or lowers (negative) FX-derived prices by this percentage." }),
  priceRounding: z.number().nullable().openapi({ description: "FX-derived prices round up to this step (major units, such as 10 for 10 taka); null rounds to the price increment." }),
  priceEnding: z.number().nullable().openapi({ description: "What a rounded price ends in within its step (major units: 9 with a step of 10 ends prices in 9); null for none." }),
  hasOrders: z.boolean().openapi({ description: "A market that took orders cannot be deleted; set it to draft instead." }),
  createdAt: z.string().openapi({ format: "date-time" }),
  updatedAt: z.string().openapi({ format: "date-time" }),
}).openapi("Market");

const presenceInputSchema = z.object({
  value: z.string().trim().max(5),
  locale: z.string().trim().length(2),
});

export const createMarketSchema = z.object({
  name: z.string().trim().min(1).max(MARKET_NAME_MAX_LENGTH),
  handle: z.string().trim().min(1).max(MARKET_HANDLE_MAX_LENGTH).optional().openapi({ description: "Derived from the name when omitted." }),
  status: z.enum(["draft", "active"]).default("draft"),
  countries: z.array(z.string().trim().length(2)).min(1).max(MAX_MARKET_COUNTRIES),
  presence: presenceInputSchema.nullable().default(null).openapi({ description: "A subfolder presence such as `{ value: \"en-in\", locale: \"en\" }`." }),
  pricesIncludeTax: z.boolean().optional().openapi({ description: "Whether its prices include tax; omitted: the backup market's." }),
}).strict();

export const updateMarketSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(MARKET_NAME_MAX_LENGTH).optional(),
  handle: z.string().trim().min(1).max(MARKET_HANDLE_MAX_LENGTH).optional(),
  status: z.enum(["draft", "active"]).optional(),
  countries: z.array(z.string().trim().length(2)).max(MAX_MARKET_COUNTRIES).optional(),
  presence: presenceInputSchema.nullable().optional().openapi({ description: "Backup market: only the root's language. Other markets: the subfolder, or null to remove it." }),
  priceIncrementMinor: z.number().int().positive().max(1_000).optional().openapi({ description: "Backup market only: 1 (minor units) or the currency's whole unit (100 for BDT)." }),
  pricesIncludeTax: z.boolean().optional().openapi({ description: "Whether its prices include tax (checkout and the order's tax read the order's market)." }),
  // How a non-backup market prices (MARKETS-DESIGN D5).
  priceMode: z.enum(["fixed", "fx"]).optional().openapi({ description: "Non-backup markets: `fixed` or `fx` (product prices converted, adjusted and rounded)." }),
  fxRate: z.string().trim().max(25).nullable().optional().openapi({ description: "The manual exchange rate; null uses the rate source. While every market sells the shop currency it is 1." }),
  priceAdjustmentPercent: z.number().min(-99).max(1_000).optional().openapi({ description: "Raises or lowers FX-derived prices by this percentage (two decimals)." }),
  priceRounding: z.number().positive().nullable().optional().openapi({ description: "Round FX-derived prices up to this step (major units); null: the price increment." }),
  priceEnding: z.number().positive().nullable().optional().openapi({ description: "End rounded prices in this amount within the step (major units); null for none." }),
}).strict();

/** The dashboard record with dates as ISO strings and pricing amounts in major units. */
export function presentMarket<T extends {
  createdAt: Date;
  updatedAt: Date;
  currencyCode: string;
  priceAdjustmentBps: number;
  priceRoundingMinor: number | null;
  priceEndingMinor: number | null;
}>(market: T) {
  const { priceAdjustmentBps, priceRoundingMinor, priceEndingMinor, ...rest } = market;
  const places = getDecimalPlaces(market.currencyCode);
  return {
    ...rest,
    priceAdjustmentPercent: priceAdjustmentBps / 100,
    priceRounding: priceRoundingMinor === null ? null : fromMinor(priceRoundingMinor, places),
    priceEnding: priceEndingMinor === null ? null : fromMinor(priceEndingMinor, places),
    createdAt: market.createdAt.toISOString(),
    updatedAt: market.updatedAt.toISOString(),
  };
}

/** A market update's pricing fields in the service's minor units and basis points. */
export function marketPricingInput(
  input: { priceMode?: "fixed" | "fx"; fxRate?: string | null; priceAdjustmentPercent?: number; priceRounding?: number | null; priceEnding?: number | null },
  currencyCode: string,
) {
  const places = getDecimalPlaces(currencyCode);
  const minor = (value: number | null | undefined) => value === undefined ? undefined : value === null ? null : toMinor(value, places);
  return {
    ...(input.priceMode === undefined ? {} : { priceMode: input.priceMode }),
    ...(input.fxRate === undefined ? {} : { fxRate: input.fxRate }),
    ...(input.priceAdjustmentPercent === undefined ? {} : { priceAdjustmentBps: Math.round(input.priceAdjustmentPercent * 100) }),
    ...(input.priceRounding === undefined ? {} : { priceRoundingMinor: minor(input.priceRounding) }),
    ...(input.priceEnding === undefined ? {} : { priceEndingMinor: minor(input.priceEnding) }),
  };
}

/**
 * The page's market presence on a market-keyed public read (MARKETS-DESIGN
 * D4, D5): its market prices the products the read shows.
 */
export const marketPresenceQueryField = z.string().max(5).optional().openapi({
  description: "The page's subfolder presence (`en-in`); its market prices the products shown. Omit for the root (the backup market). An inactive or unknown presence answers 404.",
});

export const marketPresenceQuerySchema = z.object({ presence: marketPresenceQueryField });
