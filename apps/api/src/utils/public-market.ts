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
import { NotFoundError } from "./api-error";

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
