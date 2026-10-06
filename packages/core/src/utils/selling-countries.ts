// The countries the active markets sell to, as one scalar a statement a read
// already runs can carry (MARKETS-DESIGN step 3a). Checkout ships only there,
// and a phone number from any of them is accepted (step 3b), so the checkout
// authority row, the checkout config and the customer-country reader all read
// it. It lives here, not in the markets domain, because settings and customers
// sit below markets and must read it too.
import { sql, type SQL } from "drizzle-orm";
import { deps } from "../cache-deps";

/**
 * The countries of the active markets as a comma-separated scalar (NULL
 * without any). A market change advances the checkout authority fence, so a
 * quote and its commit read the same list; a public read that carries it
 * declares `mk:selling`, which only a country or status change advances (a
 * market's name or presence edit leaves it alone).
 */
export function sellingCountriesSql(): SQL<string | null> {
    deps.sellingCountries();
    return sql<string | null>`(SELECT group_concat(selling_country.country_code, ',') FROM market_countries AS selling_country
        INNER JOIN markets AS selling_market ON selling_market.id = selling_country.market_id
        WHERE selling_market.status = 'active')`;
}

/** The sorted countries of a `sellingCountriesSql()` value. */
export function sellingCountriesFromSql(value: unknown): string[] {
    return typeof value === "string" && value ? value.split(",").filter(Boolean).sort() : [];
}
