import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { acceptedPhoneCountryPolicy, validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { sql } from "drizzle-orm";
import { settingsDocumentsJoin, type SettingsDocumentRow } from "../../settings-store";
import { sellingCountriesFromSql, sellingCountriesSql } from "../../utils/selling-countries";
import { customerCountriesDocument, type CustomerCountries } from "./documents";

/**
 * The phone countries a store accepts, in the shape the customer-countries
 * document has: the merchant's policy united with every country an active
 * market sells to (`acceptedPhoneCountryPolicy`, the one rule). Checkout,
 * customer sign-in, staff orders and customers, and the import all apply
 * this, never the merchant's list alone, so a buyer shipping to a market can
 * always give a number from there.
 */
export function acceptedCustomerCountries(
    countries: CustomerCountries,
    sellingCountries: readonly string[] | undefined,
): CustomerCountries {
    const accepted = acceptedPhoneCountryPolicy(
        { countries: countries.allowedCountries, mode: countries.allowedCountriesMode },
        sellingCountries,
    );
    return { allowedCountries: [...accepted.countries], allowedCountriesMode: accepted.mode };
}

/**
 * Settings documents beside the countries the active markets sell to, in ONE
 * statement (a one-row source joined with the documents), so a read that needs
 * both costs the call it already made. Declares `mk:selling`.
 */
export async function selectDocumentsWithSellingCountries(
    db: Database,
    documents: readonly { key: string }[],
): Promise<{ rows: SettingsDocumentRow[]; sellingCountries: string[] }> {
    const found = await db.select({
        selling: sellingCountriesSql(),
        category: settings.category,
        value: settings.value,
        revision: settings.revision,
    })
        .from(sql`(SELECT 1 AS one) AS selling_countries_row`)
        .leftJoin(settings, settingsDocumentsJoin(documents));
    const list = Array.isArray(found) ? found : [];
    return {
        rows: list.flatMap((row) => row.category === null || row.value === null
            ? []
            : [{ category: row.category, value: row.value, revision: row.revision ?? 0 }]),
        sellingCountries: sellingCountriesFromSql(list[0]?.selling),
    };
}

/** The accepted phone countries (merchant policy and market countries) in one statement. */
export async function readAcceptedCustomerCountries(db: Database): Promise<CustomerCountries> {
    const { rows, sellingCountries } = await selectDocumentsWithSellingCountries(db, [customerCountriesDocument]);
    const { value } = await customerCountriesDocument.fromRows(rows);
    return acceptedCustomerCountries(value, sellingCountries);
}

/**
 * Applies the store's accepted phone countries at trusted write boundaries.
 * UI country pickers are guidance; this check is the authority.
 */
export async function validateCustomerPhoneCountry(
    db: Database,
    phone: string,
): Promise<string> {
    const config = await readAcceptedCustomerCountries(db);
    try {
        return validateAndFormatPhone(phone, {
            countries: config.allowedCountries,
            mode: config.allowedCountriesMode,
        });
    } catch (error) {
        throw new ValidationError(
            error instanceof Error ? error.message : "Phone number is not accepted.",
        );
    }
}
