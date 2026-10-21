import type { Database } from "@scalius/database/client";
import { taxClasses, taxRates, taxRegions, taxSettings } from "@scalius/database/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { readStoreCurrency } from "../markets";
import type { AppProviders } from "../../integrations/provider-port";
import { buildStorefrontDiscountAllocation } from "./discount-allocation";
import { quoteTax } from "./provider";
import { taxCountryOf } from "./region-match";
import {
    SYSTEM_TAX_PROVIDER_ID,
    type TaxClassDefinition,
    type TaxDestination,
    type TaxDiscountAllocationInput,
    type TaxMarketInclusion,
    type TaxPlaceType,
    type TaxQuote,
    type TaxQuoteCustomer,
    type TaxQuoteLineInput,
    type TaxRateDefinition,
    type TaxRegionDefinition,
    type TaxSettingsDefinition,
} from "./types";
import { getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { isPriceIncrementMinor, type PricingCurrency } from "@scalius/shared/currency-policy";
import { ValidationError } from "@scalius/core/errors";

const DISABLED_TAX_SETTINGS: TaxSettingsDefinition = {
    enabled: false,
    taxShipping: false,
    defaultTaxClassId: null,
    shippingTaxClassId: null,
    displayLabel: "Tax",
    providerId: SYSTEM_TAX_PROVIDER_ID,
    version: 0,
};

/** Everything a tax quote reads: settings, classes, regions with their active rates, the markets' flags. */
export interface StorefrontTaxAuthoritySnapshot {
    settings: TaxSettingsDefinition;
    classes: TaxClassDefinition[];
    regions: TaxRegionDefinition[];
    /** Active rates. */
    rates: TaxRateDefinition[];
    /** Whether prices include tax, by the order's market. */
    markets: TaxMarketInclusion;
    /** Where the store ships from (the default inventory location's country). */
    originCountry: string | null;
}

const STOREFRONT_TAX_AUTHORITY_PROOF = Symbol("scalius.storefrontTaxAuthority");

function markTrustedStorefrontTaxAuthority(
    snapshot: StorefrontTaxAuthoritySnapshot,
): StorefrontTaxAuthoritySnapshot {
    Object.defineProperty(snapshot, STOREFRONT_TAX_AUTHORITY_PROOF, {
        value: true,
        enumerable: false,
    });
    return snapshot;
}

export function isTrustedStorefrontTaxAuthority(
    snapshot: StorefrontTaxAuthoritySnapshot | undefined,
): snapshot is StorefrontTaxAuthoritySnapshot {
    return Boolean(snapshot && Reflect.get(snapshot, STOREFRONT_TAX_AUTHORITY_PROOF) === true);
}

export interface StorefrontTaxAuthorityReadPlan {
    statements: unknown[];
    resolve(results: readonly unknown[]): StorefrontTaxAuthoritySnapshot;
}

/**
 * Each active market's tax flag in one text, folded into the settings row:
 * `*:<0|1>` for the backup market, `<country>:<0|1>` for each country an
 * active market sells to.
 */
const MARKET_TAX_INCLUSION_SQL = sql<string | null>`(SELECT group_concat(tax_inclusion.entry, ',') FROM (
    SELECT '*:' || backup_tax.prices_include_tax AS entry FROM markets AS backup_tax WHERE backup_tax.is_backup = 1
    UNION ALL
    SELECT tax_country.country_code || ':' || tax_market.prices_include_tax AS entry
    FROM market_countries AS tax_country INNER JOIN markets AS tax_market ON tax_market.id = tax_country.market_id
    WHERE tax_market.status = 'active'
) AS tax_inclusion)`;

/** Where the store ships from: an order with no address is taxed there. */
const ORIGIN_COUNTRY_SQL = sql<string | null>`(SELECT origin_location.country_code FROM inventory_locations AS origin_location
    WHERE origin_location.is_default = 1 AND origin_location.status = 'active' LIMIT 1)`;

/** The markets' flags of a `MARKET_TAX_INCLUSION_SQL` value. */
export function marketTaxInclusionFromSql(value: unknown): TaxMarketInclusion {
    const countries: Record<string, boolean> = {};
    let backup = false;
    if (typeof value === "string") {
        for (const entry of value.split(",")) {
            const [key, flag] = entry.split(":");
            if (!key) continue;
            if (key === "*") backup = flag === "1";
            else countries[key] = flag === "1";
        }
    }
    return { backup, countries };
}

/** The order's market's flag: the active market selling to its shipping country, else the backup market. */
export function pricesIncludeTaxFor(markets: TaxMarketInclusion, shippingCountry: string | null): boolean {
    return shippingCountry !== null && Object.hasOwn(markets.countries, shippingCountry)
        ? markets.countries[shippingCountry] === true
        : markets.backup;
}

interface RegionRateRow {
    regionId: string;
    countryCode: string;
    adminArea: string;
    postalPrefix: string;
    placeType: TaxPlaceType | null;
    placeId: string | null;
    providerId: string | null;
    rateId: string | null;
    taxClassId: string | null;
    name: string | null;
    rateBps: number | null;
    priority: number | null;
    isCompound: boolean | number | null;
    combinable: boolean | number | null;
}

/**
 * The tax authority in three statements, as before regions: the settings
 * row (with the markets' flags and the origin country beside it), the
 * classes, and the regions with their active rates.
 */
export function createStorefrontTaxAuthorityReadPlan(
    db: Database,
): StorefrontTaxAuthorityReadPlan {
    return {
        statements: [
            db.select({
                enabled: taxSettings.enabled,
                taxShipping: taxSettings.taxShipping,
                defaultTaxClassId: taxSettings.defaultTaxClassId,
                shippingTaxClassId: taxSettings.shippingTaxClassId,
                displayLabel: taxSettings.displayLabel,
                providerId: taxSettings.providerId,
                version: taxSettings.version,
                marketTaxInclusion: MARKET_TAX_INCLUSION_SQL,
                originCountry: ORIGIN_COUNTRY_SQL,
            }).from(taxSettings).where(eq(taxSettings.id, "default")),
            db.select({
                id: taxClasses.id,
                name: taxClasses.name,
                isExempt: taxClasses.isExempt,
            }).from(taxClasses).where(isNull(taxClasses.deletedAt)),
            db.select({
                regionId: taxRegions.id,
                countryCode: taxRegions.countryCode,
                adminArea: taxRegions.adminArea,
                postalPrefix: taxRegions.postalPrefix,
                placeType: taxRegions.placeType,
                placeId: taxRegions.placeId,
                providerId: taxRegions.providerId,
                // Aliased: D1 returns rows by column name, and both tables have an `id`.
                rateId: sql<string | null>`${taxRates.id}`.as("tax_rate_id"),
                taxClassId: taxRates.taxClassId,
                name: taxRates.name,
                rateBps: taxRates.rateBps,
                priority: taxRates.priority,
                isCompound: taxRates.isCompound,
                combinable: taxRates.combinable,
            }).from(taxRegions).leftJoin(taxRates, and(
                eq(taxRates.taxRegionId, taxRegions.id),
                eq(taxRates.isActive, true),
            )).orderBy(asc(taxRegions.id), asc(taxRates.priority), asc(taxRates.id)),
        ],
        resolve(results) {
            const settingsRows = Array.isArray(results[0])
                ? results[0] as Array<Omit<TaxSettingsDefinition, never> & { marketTaxInclusion: string | null; originCountry: string | null }>
                : [];
            const settingsRow = settingsRows[0] ?? null;
            const settings: TaxSettingsDefinition = settingsRow
                ? {
                    enabled: Boolean(settingsRow.enabled),
                    taxShipping: Boolean(settingsRow.taxShipping),
                    defaultTaxClassId: settingsRow.defaultTaxClassId,
                    shippingTaxClassId: settingsRow.shippingTaxClassId,
                    displayLabel: settingsRow.displayLabel,
                    providerId: settingsRow.providerId,
                    version: settingsRow.version,
                }
                : DISABLED_TAX_SETTINGS;
            const regionRows = Array.isArray(results[2]) ? results[2] as RegionRateRow[] : [];
            const regions = new Map<string, TaxRegionDefinition>();
            const rates: TaxRateDefinition[] = [];
            for (const row of regionRows) {
                if (!regions.has(row.regionId)) {
                    regions.set(row.regionId, {
                        id: row.regionId,
                        countryCode: row.countryCode,
                        adminArea: row.adminArea || null,
                        postalPrefix: row.postalPrefix || null,
                        placeType: row.placeType,
                        placeId: row.placeId,
                        providerId: row.providerId,
                    });
                }
                if (row.rateId && row.taxClassId && row.name !== null && row.rateBps !== null) {
                    rates.push({
                        id: row.rateId,
                        taxClassId: row.taxClassId,
                        taxRegionId: row.regionId,
                        name: row.name,
                        rateBps: row.rateBps,
                        priority: row.priority ?? 0,
                        isCompound: Boolean(row.isCompound),
                        combinable: Boolean(row.combinable),
                    });
                }
            }
            return markTrustedStorefrontTaxAuthority({
                settings,
                classes: Array.isArray(results[1])
                    ? (results[1] as TaxClassDefinition[]).map((row) => ({ id: row.id, name: row.name, isExempt: Boolean(row.isExempt) }))
                    : [],
                regions: [...regions.values()],
                rates,
                markets: marketTaxInclusionFromSql(settingsRow?.marketTaxInclusion),
                originCountry: settingsRow?.originCountry ?? null,
            });
        },
    };
}

/** Reads the tax authority in one batch (staff orders and previews; checkout folds it into its own). */
export async function readStorefrontTaxAuthority(db: Database): Promise<StorefrontTaxAuthoritySnapshot> {
    const plan = createStorefrontTaxAuthorityReadPlan(db);
    return plan.resolve(await db.batch(plan.statements as never) as unknown[]);
}

export interface StorefrontTaxQuoteLineInput {
    lineId: string;
    productId: string;
    variantId: string;
    unitPriceMinor: number;
    quantity: number;
    taxClassId: string | null;
    /** Tax-exempt at sale whatever its class (gift-card lines). */
    taxExempt?: boolean;
    /** Never given a share of a manual order discount (gift-card lines). */
    discountExempt?: boolean;
}

export interface StorefrontTaxQuoteInput {
    destination: TaxDestination;
    /** Which address `destination` is when it has one (`taxAddressSource`); default the shipping address. */
    addressSource?: "shipping" | "billing";
    lines: StorefrontTaxQuoteLineInput[];
    shippingMinor: number;
    /** Manual order-level discount (admin orders), in minor units. */
    discountMinor?: number;
    /** Exact allocation of the applied storefront discount. */
    promotionDiscountAllocation?: TaxDiscountAllocationInput;
    /** The checkout's currency authority; absent reads the store currency. */
    currency?: PricingCurrency;
    /** The buyer and their tax exemption (`taxExemptionApplies`); absent or null: a guest. */
    customer?: TaxQuoteCustomer | null;
}

export interface StorefrontTaxQuoteOptions {
    /** The request's app providers: an app tax provider is reached through them (fail closed without). */
    apps?: AppProviders;
    signal?: AbortSignal;
}

export async function calculateStorefrontTaxQuote(
    db: Database,
    input: StorefrontTaxQuoteInput,
    authoritySnapshot?: StorefrontTaxAuthoritySnapshot,
    options: StorefrontTaxQuoteOptions = {},
): Promise<TaxQuote> {
    const suppliedCurrencyCode = normalizeSupportedCurrencyCode(input.currency?.code);
    if (
        input.currency &&
        (
            !suppliedCurrencyCode ||
            input.currency.decimalPlaces !== getDecimalPlaces(suppliedCurrencyCode) ||
            !isPriceIncrementMinor(suppliedCurrencyCode, input.currency.priceIncrementMinor)
        )
    ) {
        throw new ValidationError("Checkout currency authority is invalid. Please retry checkout.");
    }
    const currencyRead = input.currency && suppliedCurrencyCode
        ? Promise.resolve({
            code: suppliedCurrencyCode,
            decimalPlaces: input.currency.decimalPlaces,
            priceIncrementMinor: input.currency.priceIncrementMinor,
            symbol: suppliedCurrencyCode,
        })
        : readStoreCurrency(db);
    if (authoritySnapshot && !isTrustedStorefrontTaxAuthority(authoritySnapshot)) {
        throw new ValidationError("Checkout tax authority could not be trusted. Please retry checkout.");
    }
    const [currency, authority] = await Promise.all([
        currencyRead,
        authoritySnapshot ? Promise.resolve(authoritySnapshot) : readStorefrontTaxAuthority(db),
    ]);
    const lines: TaxQuoteLineInput[] = input.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        variantId: line.variantId,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        taxClassId: line.taxClassId,
        ...(line.taxExempt === true ? { taxExempt: true } : {}),
    }));

    if (input.promotionDiscountAllocation && input.discountMinor) {
        throw new ValidationError("A discount allocation cannot be combined with a manual discount.");
    }
    const discount = input.promotionDiscountAllocation
        ? {
            discountMinor: input.promotionDiscountAllocation.lines.reduce(
                (total, allocation) => total + allocation.amountMinor,
                input.promotionDiscountAllocation.shippingMinor,
            ),
            allocation: input.promotionDiscountAllocation,
        }
        : buildStorefrontDiscountAllocation({
            discountMinor: input.discountMinor ?? 0,
            lines: input.lines.filter((line) => line.discountExempt !== true),
        });

    // The order's market is its taxed address's country: the shipping
    // country, or the billing country of an order that ships nothing (no
    // address: the backup market).
    const destination = input.destination;
    const shippingCountry = destination.city || destination.countryCode ? taxCountryOf(destination) : null;
    return quoteTax({
        currencyCode: currency.code,
        decimalPlaces: currency.decimalPlaces,
        priceIncrementMinor: currency.priceIncrementMinor,
        settings: authority.settings,
        pricesIncludeTax: pricesIncludeTaxFor(authority.markets, shippingCountry),
        classes: authority.classes,
        regions: authority.regions,
        rates: authority.rates,
        destination,
        ...(input.addressSource ? { addressSource: input.addressSource } : {}),
        originCountry: authority.originCountry,
        lines,
        shippingMinor: input.shippingMinor,
        discountMinor: discount.discountMinor,
        discountAllocation: discount.allocation,
        ...(input.customer ? { customer: input.customer } : {}),
    }, options);
}
