// The store's sign-in settings as a sign-in reads them: the identity policy
// and the countries a phone may come from.
import type { Database } from "@scalius/database/client";
import type { PhoneCountryPolicy } from "@scalius/shared/customer-utils";
import type { CustomerIdentitySettings } from "@scalius/shared/customer-auth-policy";
import {
    acceptedCustomerCountries,
    customerAuthDocument,
    customerCountriesDocument,
    selectDocumentsWithSellingCountries,
} from "../settings";

export async function readSignInPolicy(db: Database): Promise<{
    identity: CustomerIdentitySettings;
    phoneCountryPolicy: PhoneCountryPolicy;
}> {
    // The countries the markets sell to ride in the same statement: a phone
    // from any of them is accepted whatever the merchant's list says.
    const { rows, sellingCountries } = await selectDocumentsWithSellingCountries(db, [customerAuthDocument, customerCountriesDocument]);
    const [auth, countries] = await Promise.all([
        customerAuthDocument.fromRows(rows),
        customerCountriesDocument.fromRows(rows),
    ]);
    const accepted = acceptedCustomerCountries(countries.value, sellingCountries);
    return {
        identity: auth.value,
        phoneCountryPolicy: {
            countries: accepted.allowedCountries,
            mode: accepted.allowedCountriesMode,
        },
    };
}
