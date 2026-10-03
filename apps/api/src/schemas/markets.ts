// Markets on the wire (docs/MARKETS-DESIGN.md D4): the public presence matrix
// the storefront resolves pages against, and the dashboard's market record.
import { z } from "@hono/zod-openapi";
import {
  MARKET_HANDLE_MAX_LENGTH,
  MARKET_NAME_MAX_LENGTH,
  MAX_MARKET_COUNTRIES,
  MAX_MARKETS,
} from "@scalius/shared/markets";

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
}).strict();

export const updateMarketSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(MARKET_NAME_MAX_LENGTH).optional(),
  handle: z.string().trim().min(1).max(MARKET_HANDLE_MAX_LENGTH).optional(),
  status: z.enum(["draft", "active"]).optional(),
  countries: z.array(z.string().trim().length(2)).max(MAX_MARKET_COUNTRIES).optional(),
  presence: presenceInputSchema.nullable().optional().openapi({ description: "Backup market: only the root's language. Other markets: the subfolder, or null to remove it." }),
  priceIncrementMinor: z.number().int().positive().max(1_000).optional().openapi({ description: "Backup market only: 1 (minor units) or the currency's whole unit (100 for BDT)." }),
}).strict();

/** The dashboard record with dates as ISO strings. */
export function presentMarket<T extends { createdAt: Date; updatedAt: Date }>(market: T) {
  return { ...market, createdAt: market.createdAt.toISOString(), updatedAt: market.updatedAt.toISOString() };
}
