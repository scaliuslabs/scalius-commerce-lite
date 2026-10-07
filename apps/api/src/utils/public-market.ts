// The market of a market-keyed public read (docs/MARKETS-DESIGN.md D4). A
// public read learns its market only here, and only when
// `PUBLIC_API_CACHE_ROUTES` marks its route market-keyed: the page's
// presence then travels in the query (and so in the cache key). A
// market-invariant route that asks for a market is a programming error, so a
// read cannot start to vary by market (price lists, FX, translations) without
// its route entry saying so and its cache key changing with it.
import type { Context } from "hono";
import { MARKET_PRESENCE_QUERY_PARAM, isMarketSubfolder } from "@scalius/shared/markets";
import { isMarketKeyedPublicRead } from "@scalius/shared/public-api-cache-routes";
import type { Database } from "@scalius/database/client";
import { startMarketPricing, type MarketPricing } from "@scalius/core/modules/price-lists";
import { NotFoundError, ValidationError } from "./api-error";

export class MarketInvariantRouteError extends Error {
  constructor(pathname: string) {
    super(`${pathname} is market-invariant in PUBLIC_API_CACHE_ROUTES and cannot read a market; mark it market-keyed first.`);
    this.name = "MarketInvariantRouteError";
  }
}

/**
 * The request's presence (`''`: the root, the backup market) for the route to
 * read its market with (`readPresenceMarketWithDocuments`, joined into the
 * statement the route already runs).
 * Refuses a market-invariant route; a malformed presence is a 404.
 */
export function publicMarketPresence(c: Context): string {
  const url = new URL(c.req.url);
  if (!isMarketKeyedPublicRead(url)) throw new MarketInvariantRouteError(url.pathname);
  const value = url.searchParams.get(MARKET_PRESENCE_QUERY_PARAM) ?? "";
  if (value !== "" && !isMarketSubfolder(value)) throw new NotFoundError("Market not found");
  return value;
}

/**
 * A market-keyed catalogue read's pricing (MARKETS-DESIGN D5): the page's
 * presence and its market's price context, read beside the route's own
 * reads. Null at the root: the read is today's, byte for byte.
 */
export function publicMarketPricing(c: Context): MarketPricing | null {
  return startMarketPricing(c.get("db") as Database, publicMarketPresence(c));
}

/**
 * The pricing of an uncached public read that prices products (site
 * search): its `presence` when it is a well-formed subfolder, else the root.
 * It is never stored, so no cache key carries it.
 */
export function uncachedMarketPricing(c: Context): MarketPricing | null {
  const value = new URL(c.req.url).searchParams.get(MARKET_PRESENCE_QUERY_PARAM) ?? "";
  if (value !== "" && !isMarketSubfolder(value)) throw new NotFoundError("Market not found");
  return startMarketPricing(c.get("db") as Database, value);
}

/** Refuses any query parameter but the page's presence (reads with one entry per presence). */
export function assertOnlyPresenceQuery(url: string, message: string): void {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => key !== MARKET_PRESENCE_QUERY_PARAM) || params.getAll(MARKET_PRESENCE_QUERY_PARAM).length > 1) {
    throw new ValidationError(message);
  }
}
