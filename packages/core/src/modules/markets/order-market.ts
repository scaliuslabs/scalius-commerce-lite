// The market an order is placed in (MARKETS-DESIGN D4, step 3a): the market
// selling to its shipping country, else the backup market. Every order writer records it
// in the order insert (`orders.market_id`), as the SQL twin below, so placing
// an order reads nothing more than it did before markets.
import { BACKUP_MARKET_ID } from "@scalius/database/schema";
import {
    MARKET_COUNTRY_PATTERN,
    resolveMarket,
    type MarketMatrix,
} from "@scalius/shared/markets";
import { sql, type SQL } from "drizzle-orm";

/**
 * The order's market id: the market of its shipping country (the address
 * snapshot's `shipping_country_code`), else the backup market. An order that
 * ships nothing (pickup, digital) has no shipping country.
 */
export function orderMarketId(matrix: MarketMatrix, shippingCountry: string | null): string {
    return resolveMarket(matrix, { surface: "checkout", shippingCountry }).market?.id ?? BACKUP_MARKET_ID;
}

/**
 * `orderMarketId` as a scalar for the order insert: the active market that
 * sells to the shipping country, else the backup market (which always
 * exists). It binds no parameter (the order insert is near D1's 100), so the
 * country must be an ISO code; anything else resolves to the backup market.
 */
export function orderMarketIdSql(shippingCountry: string | null): SQL<string> {
    const backup = sql.raw(`'${BACKUP_MARKET_ID}'`);
    if (!shippingCountry || !MARKET_COUNTRY_PATTERN.test(shippingCountry)) return sql<string>`${backup}`;
    return sql<string>`coalesce((
        SELECT order_market_country.market_id FROM market_countries AS order_market_country
        INNER JOIN markets AS order_market ON order_market.id = order_market_country.market_id
        WHERE order_market_country.country_code = ${sql.raw(`'${shippingCountry}'`)} AND order_market.status = 'active'
    ), ${backup})`;
}
