// The market an order is placed in (MARKETS-DESIGN D4): the market selling to
// its shipping country, else the backup market. Every order writer records it
// in the order insert (`orders.market_id`).
import { BACKUP_MARKET_ID } from "@scalius/database/schema";
import { DELIVERY_HIERARCHY_COUNTRY, resolveMarket, type MarketMatrix } from "@scalius/shared/markets";

/**
 * The order's market id. Every address the storefront and the dashboard
 * collect is in Bangladesh's delivery hierarchy until country-aware
 * addresses (step 3), so that is the shipping country unless one is given.
 */
export function orderMarketId(matrix: MarketMatrix, shippingCountry: string | null = DELIVERY_HIERARCHY_COUNTRY): string {
    return resolveMarket(matrix, { surface: "checkout", shippingCountry }).market?.id ?? BACKUP_MARKET_ID;
}
