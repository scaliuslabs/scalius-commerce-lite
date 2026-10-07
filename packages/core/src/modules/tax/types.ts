/** A Bangladesh delivery location kind a tax region may be. */
export type TaxPlaceType = "city" | "zone" | "area";

/**
 * How a quote component's rate is scoped, as order snapshots record it:
 * `all` is a whole country, `city`/`zone`/`area` a Bangladesh place,
 * `admin_area` and `postal_prefix` a part of another country, `provider` a
 * tax an app provider calculated.
 */
export type TaxJurisdictionType = "all" | TaxPlaceType | "admin_area" | "postal_prefix" | "provider";

export { SYSTEM_TAX_PROVIDER_ID } from "@scalius/shared/plugins/providers/kinds";

/**
 * Where the order is taxed. The six City/Thana/Area fields are the order's
 * destination snapshot. `countryCode`, `adminArea` and `postalCode` locate
 * an address of another country. An order that ships nothing (pickup,
 * service, digital) has no address: it is taxed where the store ships from
 * (the default inventory location's country).
 */
export interface TaxDestination {
    city: string | null;
    zone: string | null;
    area: string | null;
    cityName?: string | null;
    zoneName?: string | null;
    areaName?: string | null;
    /** ISO 3166-1 alpha-2; absent with a city: Bangladesh; absent without one: no address. */
    countryCode?: string | null;
    adminArea?: string | null;
    postalCode?: string | null;
}

/** The destination snapshot an order keeps (the Bangladesh hierarchy fields). */
export type TaxDestinationSnapshot = Pick<TaxDestination, "city" | "zone" | "area" | "cityName" | "zoneName" | "areaName">;

export interface TaxSettingsDefinition {
    enabled: boolean;
    taxShipping: boolean;
    defaultTaxClassId: string | null;
    shippingTaxClassId: string | null;
    displayLabel: string;
    /** The store-wide provider: `system` or an app's `<plugin id>:<provider id>`. */
    providerId: string;
    version: number;
}

export interface TaxClassDefinition {
    id: string;
    name: string;
    isExempt: boolean;
}

/**
 * Where the merchant collects tax: a whole country (the registration), or
 * one admin area, postal prefix or Bangladesh place of it.
 */
export interface TaxRegionDefinition {
    id: string;
    countryCode: string;
    /** '' or null: none. */
    adminArea: string | null;
    /** '' or null: none. */
    postalPrefix: string | null;
    placeType: TaxPlaceType | null;
    placeId: string | null;
    /** A country region's provider; null: the store-wide one. */
    providerId: string | null;
}

export interface TaxRateDefinition {
    id: string;
    taxClassId: string;
    taxRegionId: string;
    name: string;
    rateBps: number;
    priority: number;
    isCompound: boolean;
    /** Applies with the broader regions' rates of its class instead of replacing them. */
    combinable: boolean;
}

/** Whether each market's prices include tax, by the countries it sells to. */
export interface TaxMarketInclusion {
    /** The backup market's flag: every country no active market sells to. */
    backup: boolean;
    /** Country → its active market's flag. */
    countries: Readonly<Record<string, boolean>>;
}

export interface TaxQuoteLineInput {
    lineId: string;
    productId: string;
    variantId: string;
    unitPriceMinor: number;
    quantity: number;
    taxClassId: string | null;
    /**
     * No rate applies, whatever the class (a gift card is money, not a
     * taxable sale: Wave B §4.2). Absent means taxed by its class.
     */
    taxExempt?: boolean;
}

export interface TaxDiscountAllocationInput {
    lines: Array<{ lineId: string; amountMinor: number }>;
    shippingMinor: number;
}

export interface TaxComponentSnapshot {
    rateId: string;
    name: string;
    rateBps: number;
    priority: number;
    compound: boolean;
    jurisdictionType: TaxJurisdictionType;
    jurisdictionId: string | null;
    amountMinor: number;
}

export interface TaxQuoteLine {
    lineId: string;
    productId: string;
    variantId: string;
    taxClassId: string | null;
    taxClassName: string | null;
    unitPriceMinor: number;
    quantity: number;
    grossAmountMinor: number;
    discountMinor: number;
    taxableAmountMinor: number;
    taxMinor: number;
    totalMinor: number;
    components: TaxComponentSnapshot[];
    /** The most specific region whose rates applied; null: none, or an app provider decided. */
    taxRegionId: string | null;
}

export interface TaxQuoteShipping {
    taxClassId: string | null;
    taxClassName: string | null;
    grossAmountMinor: number;
    discountMinor: number;
    taxableAmountMinor: number;
    taxMinor: number;
    totalMinor: number;
    components: TaxComponentSnapshot[];
    taxRegionId: string | null;
}

/** Where tax was decided and by whom. */
export interface TaxJurisdiction {
    /** The country taxed: the address's, else where the store ships from. */
    countryCode: string;
    /** The provider that calculated (`system` or an app's id). */
    providerId: string;
    /** An app provider's calculation, committed with the order; null for `system`. */
    calculationId: string | null;
    /**
     * The address taxed (`taxAddressSource`): the shipping address, the
     * billing address, or the origin (no address). Absent on a quote priced
     * before 0119.
     */
    addressSource?: "shipping" | "billing" | "origin";
}

export interface TaxQuote {
    schemaVersion: 1;
    calculationVersion: "tax-v1";
    enabled: boolean;
    currencyCode: string;
    decimalPlaces: number;
    displayLabel: string;
    pricesIncludeTax: boolean;
    shippingTaxed: boolean;
    settingsVersion: number;
    subtotalMinor: number;
    shippingMinor: number;
    discountMinor: number;
    taxableMinor: number;
    taxMinor: number;
    totalMinor: number;
    destination: TaxDestinationSnapshot;
    jurisdiction: TaxJurisdiction;
    lines: TaxQuoteLine[];
    shipping: TaxQuoteShipping;
}

export interface CalculateTaxQuoteInput {
    currencyCode: string;
    decimalPlaces: number;
    /**
     * The market's price increment: tax rounds half-up to it, so a total on
     * the increment stays on it (a BDT store's default: whole taka).
     */
    priceIncrementMinor: number;
    settings: TaxSettingsDefinition;
    /** The order's market's flag. */
    pricesIncludeTax: boolean;
    classes: TaxClassDefinition[];
    regions: TaxRegionDefinition[];
    /** Active rates. */
    rates: TaxRateDefinition[];
    destination: TaxDestination;
    /** Which address `destination` is when it has one (default: the shipping address). */
    addressSource?: "shipping" | "billing";
    /** Where the store ships from (an address-less order is taxed there); null: Bangladesh. */
    originCountry?: string | null;
    lines: TaxQuoteLineInput[];
    shippingMinor: number;
    discountMinor: number;
    discountAllocation?: TaxDiscountAllocationInput;
    /** Stable per priced cart (the provider's idempotency key); absent: derived from the input. */
    idempotencyKey?: string;
}
