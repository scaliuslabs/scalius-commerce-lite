// The order's tax snapshot rows (MARKETS-DESIGN D8): what every order writer
// (checkout, staff orders, amendments) stores from a quote. The rate
// snapshots keep the shape they had before regions; the jurisdiction (the
// country and the region that applied) and the provider ride beside them.
import { sql, type SQL } from "drizzle-orm";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { SYSTEM_TAX_PROVIDER_ID, type TaxQuote, type TaxQuoteLine } from "./types";

const COUNTRY = /^[A-Z]{2}$/;

/**
 * A provider id or a country as an SQL literal. A line's snapshot binds no
 * parameter for the order's facts, so a 99-line order still writes the same
 * statements (D1 binds at most 100 parameters): only ISO codes and provider
 * ids (`system`, `<plugin id>:<provider id>`: lower-case letters, digits,
 * dots, dashes, one colon) are inlined.
 */
function literal(value: string): SQL {
    if (!COUNTRY.test(value) && value !== SYSTEM_TAX_PROVIDER_ID && !isQualifiedProviderId(value)) {
        throw new RangeError("A tax snapshot literal must be a country code or a provider id.");
    }
    return sql.raw(`'${value}'`);
}

const ADDRESS_SOURCES = new Set(["shipping", "billing", "origin"]);

/** The taxed address as an SQL literal; NULL for a quote priced before 0119. */
function addressSourceLiteral(value: string | undefined): SQL {
    return sql.raw(value && ADDRESS_SOURCES.has(value) ? `'${value}'` : "NULL");
}

/**
 * One order line's tax snapshot columns: four bound values besides the line
 * and order ids. A quote priced by a Worker before tax regions (an in-flight
 * checkout across a deploy) has no jurisdiction: the system provider, none
 * recorded.
 */
export function orderItemTaxSnapshotColumns(quote: TaxQuote, line: TaxQuoteLine) {
    const jurisdiction = quote.jurisdiction as TaxQuote["jurisdiction"] | undefined;
    return {
        taxClassId: line.taxClassId,
        taxClassName: line.taxClassName,
        pricesIncludeTax: sql.raw(quote.pricesIncludeTax ? "1" : "0"),
        rateSnapshot: JSON.stringify(line.components),
        countryCode: jurisdiction ? literal(jurisdiction.countryCode) : sql.raw("NULL"),
        taxRegionId: line.taxRegionId ?? null,
        providerId: literal(jurisdiction?.providerId ?? SYSTEM_TAX_PROVIDER_ID),
    };
}

/** Bound parameters of one `orderItemTaxSnapshotColumns` row with its two ids. */
export const ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW = 6;

/** The order's tax snapshot columns (besides its id and creation time). */
export function orderTaxSnapshotColumns(quote: TaxQuote) {
    return {
        currencyCode: quote.currencyCode,
        decimalPlaces: quote.decimalPlaces,
        displayLabel: quote.displayLabel,
        pricesIncludeTax: quote.pricesIncludeTax,
        shippingTaxed: quote.shippingTaxed,
        settingsVersion: quote.settingsVersion,
        calculationVersion: quote.calculationVersion,
        destinationSnapshot: JSON.stringify(quote.destination),
        rateSnapshot: JSON.stringify({
            lines: quote.lines.map((line) => ({
                lineId: line.lineId,
                taxClassId: line.taxClassId,
                taxClassName: line.taxClassName,
                components: line.components,
            })),
            shipping: {
                taxClassId: quote.shipping.taxClassId,
                taxClassName: quote.shipping.taxClassName,
                grossAmountMinor: quote.shipping.grossAmountMinor,
                discountMinor: quote.shipping.discountMinor,
                taxableAmountMinor: quote.shipping.taxableAmountMinor,
                taxMinor: quote.shipping.taxMinor,
                totalMinor: quote.shipping.totalMinor,
                components: quote.shipping.components,
            },
        }),
        providerId: (quote.jurisdiction as TaxQuote["jurisdiction"] | undefined)?.providerId ?? SYSTEM_TAX_PROVIDER_ID,
        providerCalculationId: (quote.jurisdiction as TaxQuote["jurisdiction"] | undefined)?.calculationId ?? null,
        // An SQL literal (one of three words): the order's snapshot binds nothing more.
        addressSource: addressSourceLiteral((quote.jurisdiction as TaxQuote["jurisdiction"] | undefined)?.addressSource),
    };
}
