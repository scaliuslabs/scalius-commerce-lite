import type { Database } from "@scalius/database/client";
import { taxClasses, taxRates, taxSettings } from "@scalius/database/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getCurrencyConfig } from "../settings";
import { calculateTaxQuote } from "./calculator";
import { buildStorefrontDiscountAllocation, type StorefrontDiscountType } from "./discount-allocation";
import { toMinorUnits } from "./money";
import type { TaxDestination, TaxQuote, TaxQuoteLineInput, TaxSettingsDefinition } from "./types";

const DISABLED_TAX_SETTINGS: TaxSettingsDefinition = {
    enabled: false,
    pricesIncludeTax: false,
    taxShipping: false,
    defaultTaxClassId: null,
    shippingTaxClassId: null,
    displayLabel: "Tax",
    version: 0,
};

export interface StorefrontTaxQuoteLineInput {
    lineId: string;
    productId: string;
    variantId: string;
    unitPrice: number;
    quantity: number;
    taxClassId: string | null;
}

export interface StorefrontTaxQuoteInput {
    destination: TaxDestination;
    lines: StorefrontTaxQuoteLineInput[];
    shippingAmount: number;
    discountAmount: number;
    discountType: StorefrontDiscountType | null;
    applicableProductIds?: readonly string[];
}

export async function calculateStorefrontTaxQuote(
    db: Database,
    input: StorefrontTaxQuoteInput,
): Promise<TaxQuote> {
    const [currency, settingsRow, classRows, rateRows] = await Promise.all([
        getCurrencyConfig(db),
        db.select().from(taxSettings).where(eq(taxSettings.id, "default")).get(),
        db.select({
            id: taxClasses.id,
            name: taxClasses.name,
            isExempt: taxClasses.isExempt,
        }).from(taxClasses).where(isNull(taxClasses.deletedAt)),
        db.select({
            id: taxRates.id,
            taxClassId: taxRates.taxClassId,
            name: taxRates.name,
            rateBps: taxRates.rateBps,
            jurisdictionType: taxRates.jurisdictionType,
            jurisdictionId: taxRates.jurisdictionId,
            jurisdictionLabel: taxRates.jurisdictionLabel,
            priority: taxRates.priority,
            isCompound: taxRates.isCompound,
        }).from(taxRates).where(and(
            eq(taxRates.isActive, true),
            isNull(taxRates.deletedAt),
        )).orderBy(asc(taxRates.priority), asc(taxRates.id)),
    ]);

    const settings: TaxSettingsDefinition = settingsRow
        ? {
            enabled: settingsRow.enabled,
            pricesIncludeTax: settingsRow.pricesIncludeTax,
            taxShipping: settingsRow.taxShipping,
            defaultTaxClassId: settingsRow.defaultTaxClassId,
            shippingTaxClassId: settingsRow.shippingTaxClassId,
            displayLabel: settingsRow.displayLabel,
            version: settingsRow.version,
        }
        : DISABLED_TAX_SETTINGS;
    const lines: TaxQuoteLineInput[] = input.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        variantId: line.variantId,
        unitPriceMinor: toMinorUnits(line.unitPrice, currency.decimalPlaces),
        quantity: line.quantity,
        taxClassId: line.taxClassId,
    }));

    const discount = buildStorefrontDiscountAllocation({
        decimalPlaces: currency.decimalPlaces,
        discountAmount: input.discountAmount,
        discountType: input.discountType,
        applicableProductIds: input.applicableProductIds,
        lines: input.lines,
        shippingAmount: input.shippingAmount,
    });

    return calculateTaxQuote({
        currencyCode: currency.code,
        decimalPlaces: currency.decimalPlaces,
        settings,
        classes: classRows,
        rates: rateRows,
        destination: input.destination,
        lines,
        shippingMinor: toMinorUnits(input.shippingAmount, currency.decimalPlaces),
        discountMinor: discount.discountMinor,
        discountAllocation: discount.allocation,
    });
}
