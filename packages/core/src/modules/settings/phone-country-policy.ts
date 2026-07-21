import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { getAllowedCountries } from "./site-settings.service";

/**
 * Applies the merchant's customer-country policy at trusted write boundaries.
 * UI country pickers are guidance; this check is the authority.
 */
export async function validateCustomerPhoneCountry(
    db: Database,
    phone: string,
): Promise<string> {
    const config = await getAllowedCountries(db);
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
