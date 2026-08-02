import type { Database } from "@scalius/database/client";
import { taxClasses, taxRates, taxSettings } from "@scalius/database/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getCurrencyConfig } from "../settings";
import { calculateTaxQuote } from "./calculator";
import { buildStorefrontDiscountAllocation, type StorefrontDiscountType } from "./discount-allocation";
import { toMinorUnits } from "./money";
import type {
    TaxDestination,
    TaxDiscountAllocationInput,
    TaxQuote,
    TaxQuoteLineInput,
    TaxSettingsDefinition,
} from "./types";
import { getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { ValidationError } from "@scalius/core/errors";

const DISABLED_TAX_SETTINGS: TaxSettingsDefinition = {
    enabled: false,
    pricesIncludeTax: false,
    taxShipping: false,
    defaultTaxClassId: null,
    shippingTaxClassId: null,
    displayLabel: "Tax",
    version: 0,
};

export interface StorefrontTaxClassAuthorityRow {
    id: string;
    name: string;
    isExempt: boolean;
}

export interface StorefrontTaxRateAuthorityRow {
    id: string;
    taxClassId: string;
    name: string;
    rateBps: number;
    jurisdictionType: "all" | "city" | "zone" | "area";
    jurisdictionId: string | null;
    jurisdictionLabel: string | null;
    priority: number;
    isCompound: boolean;
}

export interface StorefrontTaxAuthoritySnapshot {
    settings: TaxSettingsDefinition;
    classes: StorefrontTaxClassAuthorityRow[];
    rates: StorefrontTaxRateAuthorityRow[];
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

export function createStorefrontTaxAuthorityReadPlan(
    db: Database,
): StorefrontTaxAuthorityReadPlan {
    return {
        statements: [
            db.select().from(taxSettings).where(eq(taxSettings.id, "default")),
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
        ],
        resolve(results) {
            const settingsRows = Array.isArray(results[0])
                ? results[0] as (typeof taxSettings.$inferSelect)[]
                : [];
            const settingsRow = settingsRows[0] ?? null;
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
            return markTrustedStorefrontTaxAuthority({
                settings,
                classes: Array.isArray(results[1])
                    ? [...results[1] as StorefrontTaxClassAuthorityRow[]]
                    : [],
                rates: Array.isArray(results[2])
                    ? [...results[2] as StorefrontTaxRateAuthorityRow[]]
                    : [],
            });
        },
    };
}

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
    /** Exact evaluator allocation for typed promotions; mutually exclusive with legacy discount metadata. */
    promotionDiscountAllocation?: TaxDiscountAllocationInput;
    currency?: { code: string; decimalPlaces: number };
}

export async function calculateStorefrontTaxQuote(
    db: Database,
    input: StorefrontTaxQuoteInput,
    authoritySnapshot?: StorefrontTaxAuthoritySnapshot,
): Promise<TaxQuote> {
    const suppliedCurrencyCode = normalizeSupportedCurrencyCode(input.currency?.code);
    if (
        input.currency &&
        (
            !suppliedCurrencyCode ||
            input.currency.decimalPlaces !== getDecimalPlaces(suppliedCurrencyCode)
        )
    ) {
        throw new ValidationError("Checkout currency authority is invalid. Please retry checkout.");
    }
    const currencyRead = input.currency && suppliedCurrencyCode
        ? Promise.resolve({
            code: suppliedCurrencyCode,
            decimalPlaces: input.currency.decimalPlaces,
            symbol: suppliedCurrencyCode,
            usdExchangeRate: 1,
        })
        : getCurrencyConfig(db);
    if (authoritySnapshot && !isTrustedStorefrontTaxAuthority(authoritySnapshot)) {
        throw new ValidationError("Checkout tax authority could not be trusted. Please retry checkout.");
    }
    const authorityPlan = authoritySnapshot
        ? null
        : createStorefrontTaxAuthorityReadPlan(db);
    const [currency, authority] = await Promise.all([
        currencyRead,
        authoritySnapshot
            ? Promise.resolve(authoritySnapshot)
            : db.batch(authorityPlan!.statements as never)
                .then((results) => authorityPlan!.resolve(results as unknown[])),
    ]);
    const lines: TaxQuoteLineInput[] = input.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        variantId: line.variantId,
        unitPriceMinor: toMinorUnits(line.unitPrice, currency.decimalPlaces),
        quantity: line.quantity,
        taxClassId: line.taxClassId,
    }));

    if (
        input.promotionDiscountAllocation
        && (input.discountType !== null || input.applicableProductIds !== undefined)
    ) {
        throw new ValidationError("Promotion allocations cannot be combined with legacy discount metadata.");
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
        settings: authority.settings,
        classes: authority.classes,
        rates: authority.rates,
        destination: input.destination,
        lines,
        shippingMinor: toMinorUnits(input.shippingAmount, currency.decimalPlaces),
        discountMinor: discount.discountMinor,
        discountAllocation: discount.allocation,
    });
}
