// The store's country: the backup market's country (the one the store setup
// step chose; the first, sorted, when the backup market sells to several).
// Formatting and the merchant calendar's week start follow it (CLDR), so the
// dashboard's store defaults and the analytics context read it. It lives
// here, not in the markets domain, because platform and analytics read it.
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { BACKUP_MARKET_ID, marketCountries } from "@scalius/database/schema";

/** The store's ISO 3166-1 alpha-2 country, or null before it has one. */
export async function readStoreCountry(db: Database): Promise<string | null> {
    const rows = await db.select({ countryCode: marketCountries.countryCode }).from(marketCountries)
        .where(sql`${marketCountries.marketId} = ${BACKUP_MARKET_ID}`)
        .orderBy(marketCountries.countryCode)
        .limit(1);
    return rows[0]?.countryCode ?? null;
}
