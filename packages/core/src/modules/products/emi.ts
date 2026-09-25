// The product page's "EMI on card payment, from X/month" line. Informational
// only (owner decision 2026-09-25): no checkout EMI promise until a payment
// gateway supports it. It shows only when the store's `emi` settings document
// is enabled with plans, the product is `emi_eligible`, and a plan applies to
// the product's lowest buyer price.
import { sql } from "drizzle-orm";
import { settings } from "@scalius/database/schema";
import { fromMinor } from "@scalius/shared/money";
import { lowestEmiQuote, normalizeEmiSettings, type EmiSettings } from "@scalius/shared/emi";
import { emiDocument } from "../settings/documents";
import { SETTINGS_DOCUMENT_ROW_KEY } from "../settings/settings-store";

/** The stored `emi` document as a scalar subquery, so a page read carries it without a statement of its own. */
export function storeEmiSettingsSql() {
    return sql<string | null>`(
        SELECT ${settings.value} FROM ${settings}
        WHERE ${settings.category} = ${emiDocument.key} AND ${settings.key} = ${SETTINGS_DOCUMENT_ROW_KEY}
    )`;
}

/** The stored document's text as settings; missing or unreadable is off (fail closed). */
export function parseStoredEmiSettings(value: string | null | undefined): EmiSettings {
    if (!value) return normalizeEmiSettings(null);
    try {
        return normalizeEmiSettings(JSON.parse(value));
    } catch {
        return normalizeEmiSettings(null);
    }
}

export interface ProductEmiOffer {
    provider: string;
    months: number;
    /** Rounded up to the cash unit, so `months × monthly` covers the bank's total. */
    monthlyMinor: number;
    monthly: number;
}

/** The lowest monthly amount for a product, or null when the line must not show. */
export function productEmiOffer(input: {
    emiEligible: boolean;
    /** The product's lowest buyer price (after catalog discounts), in minor units. */
    priceMinor: number | null;
    settings: EmiSettings;
    currencyCode: string;
    decimalPlaces: number;
}): ProductEmiOffer | null {
    if (!input.emiEligible || input.priceMinor === null || !Number.isSafeInteger(input.priceMinor) || input.priceMinor <= 0) {
        return null;
    }
    const quote = lowestEmiQuote(input.priceMinor, input.settings, input.currencyCode);
    if (!quote) return null;
    return {
        provider: quote.provider,
        months: quote.months,
        monthlyMinor: quote.monthlyMinor,
        monthly: fromMinor(quote.monthlyMinor, input.decimalPlaces),
    };
}
