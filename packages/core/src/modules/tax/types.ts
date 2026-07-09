export type TaxJurisdictionType = "all" | "city" | "zone" | "area";

export interface TaxDestination {
    city: string;
    zone: string;
    area: string | null;
    cityName?: string | null;
    zoneName?: string | null;
    areaName?: string | null;
}

export interface TaxSettingsDefinition {
    enabled: boolean;
    pricesIncludeTax: boolean;
    taxShipping: boolean;
    defaultTaxClassId: string | null;
    shippingTaxClassId: string | null;
    displayLabel: string;
    version: number;
}

export interface TaxClassDefinition {
    id: string;
    name: string;
    isExempt: boolean;
}

export interface TaxRateDefinition {
    id: string;
    taxClassId: string;
    name: string;
    rateBps: number;
    jurisdictionType: TaxJurisdictionType;
    jurisdictionId: string | null;
    jurisdictionLabel: string | null;
    priority: number;
    isCompound: boolean;
}

export interface TaxQuoteLineInput {
    lineId: string;
    productId: string;
    variantId: string;
    unitPriceMinor: number;
    quantity: number;
    taxClassId: string | null;
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
    destination: TaxDestination;
    lines: TaxQuoteLine[];
    shipping: TaxQuoteShipping;
}

export interface CalculateTaxQuoteInput {
    currencyCode: string;
    decimalPlaces: number;
    settings: TaxSettingsDefinition;
    classes: TaxClassDefinition[];
    rates: TaxRateDefinition[];
    destination: TaxDestination;
    lines: TaxQuoteLineInput[];
    shippingMinor: number;
    discountMinor: number;
    discountAllocation?: TaxDiscountAllocationInput;
}
