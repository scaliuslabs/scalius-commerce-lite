import { describe, expect, it } from "vitest";
import { calculateTaxQuote } from "./calculator";
import {
    buildStorefrontDiscountAllocation,
    buildStorefrontTaxAllocationLineId,
} from "./discount-allocation";
import { allocateMinorAmount, fromMinorUnits, toMinorUnits } from "./money";
import type { CalculateTaxQuoteInput, TaxRateDefinition } from "./types";

const destination = {
    city: "city-1",
    zone: "zone-1",
    area: "area-1",
    cityName: "City",
    zoneName: "Zone",
    areaName: "Area",
};

function rate(overrides: Partial<TaxRateDefinition> = {}): TaxRateDefinition {
    return {
        id: "rate-a",
        taxClassId: "class-standard",
        name: "Merchant configured tax",
        rateBps: 1_500,
        jurisdictionType: "all",
        jurisdictionId: null,
        jurisdictionLabel: null,
        priority: 0,
        isCompound: false,
        ...overrides,
    };
}

function input(overrides: Partial<CalculateTaxQuoteInput> = {}): CalculateTaxQuoteInput {
    return {
        currencyCode: "BDT",
        decimalPlaces: 2,
        settings: {
            enabled: true,
            pricesIncludeTax: false,
            taxShipping: false,
            defaultTaxClassId: "class-standard",
            shippingTaxClassId: null,
            displayLabel: "VAT",
            version: 3,
        },
        classes: [
            { id: "class-standard", name: "Standard", isExempt: false },
            { id: "class-exempt", name: "Exempt", isExempt: true },
        ],
        rates: [rate()],
        destination,
        lines: [{
            lineId: "line-1",
            productId: "product-1",
            variantId: "variant-1",
            unitPriceMinor: 10_000,
            quantity: 1,
            taxClassId: null,
        }],
        shippingMinor: 0,
        discountMinor: 0,
        ...overrides,
    };
}

describe("tax minor-unit money", () => {
    it("supports ISO-style zero, two, and three decimal currencies without float drift", () => {
        expect(toMinorUnits(12.6, 0)).toBe(13);
        expect(toMinorUnits(12.345, 2)).toBe(1_235);
        expect(toMinorUnits(1.005, 2)).toBe(101);
        expect(toMinorUnits(0.1 + 0.2, 2)).toBe(30);
        expect(toMinorUnits(12.345, 3)).toBe(12_345);
        expect(fromMinorUnits(12_345, 3)).toBe(12.345);
    });

    it("uses deterministic largest-remainder allocation", () => {
        const allocated = allocateMinorAmount(2, [
            { key: "b", weightMinor: 1 },
            { key: "a", weightMinor: 1 },
            { key: "c", weightMinor: 1 },
        ]);
        expect(Object.fromEntries(allocated)).toEqual({ b: 1, a: 1, c: 0 });
    });

    it("rejects duplicate allocation identities before totals can diverge", () => {
        expect(() => allocateMinorAmount(1, [
            { key: "line", weightMinor: 1 },
            { key: "line", weightMinor: 1 },
        ])).toThrow("Allocation keys must be unique");
    });
});

describe("calculateTaxQuote", () => {
    it("defaults an unconfigured or disabled store to zero tax", () => {
        const quote = calculateTaxQuote(input({
            settings: { ...input().settings, enabled: false, version: 0 },
        }));
        expect(quote.taxMinor).toBe(0);
        expect(quote.totalMinor).toBe(10_000);
        expect(quote.lines[0]?.taxClassId).toBeNull();
    });

    it("adds exclusive tax after deterministic discount allocation", () => {
        const quote = calculateTaxQuote(input({ discountMinor: 1_000 }));
        expect(quote.lines[0]).toMatchObject({
            grossAmountMinor: 10_000,
            discountMinor: 1_000,
            taxableAmountMinor: 9_000,
            taxMinor: 1_350,
            totalMinor: 10_350,
        });
        expect(quote.totalMinor).toBe(10_350);
    });

    it("extracts inclusive tax without inflating buyer totals", () => {
        const quote = calculateTaxQuote(input({
            settings: { ...input().settings, pricesIncludeTax: true },
            lines: [{
                ...input().lines[0]!,
                unitPriceMinor: 11_500,
            }],
        }));
        expect(quote.lines[0]).toMatchObject({
            grossAmountMinor: 11_500,
            taxableAmountMinor: 10_000,
            taxMinor: 1_500,
            totalMinor: 11_500,
        });
        expect(quote.totalMinor).toBe(11_500);
    });

    it("applies compound rates in priority then stable id order", () => {
        const quote = calculateTaxQuote(input({
            rates: [
                rate({ id: "rate-second", rateBps: 500, priority: 20, isCompound: true }),
                rate({ id: "rate-first", rateBps: 1_000, priority: 10 }),
            ],
        }));
        expect(quote.lines[0]?.components.map((component) => ({
            id: component.rateId,
            amount: component.amountMinor,
        }))).toEqual([
            { id: "rate-first", amount: 1_000 },
            { id: "rate-second", amount: 550 },
        ]);
        expect(quote.taxMinor).toBe(1_550);
    });

    it("matches only the configured destination scopes while allowing layered all-scope rates", () => {
        const quote = calculateTaxQuote(input({
            rates: [
                rate({ id: "global", rateBps: 100 }),
                rate({ id: "zone-match", rateBps: 200, jurisdictionType: "zone", jurisdictionId: "zone-1" }),
                rate({ id: "zone-other", rateBps: 900, jurisdictionType: "zone", jurisdictionId: "zone-2" }),
            ],
        }));
        expect(quote.lines[0]?.components.map((component) => component.rateId)).toEqual([
            "global",
            "zone-match",
        ]);
        expect(quote.taxMinor).toBe(300);
    });

    it("keeps exempt classes and untaxed shipping at zero", () => {
        const quote = calculateTaxQuote(input({
            lines: [{ ...input().lines[0]!, taxClassId: "class-exempt" }],
            shippingMinor: 5_000,
            settings: { ...input().settings, taxShipping: false },
        }));
        expect(quote.lines[0]?.taxMinor).toBe(0);
        expect(quote.shipping.taxMinor).toBe(0);
        expect(quote.totalMinor).toBe(15_000);
    });

    it("taxes shipping only through the explicitly configured shipping class", () => {
        const quote = calculateTaxQuote(input({
            shippingMinor: 2_000,
            settings: {
                ...input().settings,
                taxShipping: true,
                shippingTaxClassId: "class-standard",
            },
        }));
        expect(quote.shipping).toMatchObject({
            grossAmountMinor: 2_000,
            taxableAmountMinor: 2_000,
            taxMinor: 300,
            totalMinor: 2_300,
        });
        expect(quote.totalMinor).toBe(13_800);
    });

    it("allocates free-shipping discounts only to shipping", () => {
        const discount = buildStorefrontDiscountAllocation({
            decimalPlaces: 2,
            discountAmount: 20,
            discountType: "free_shipping",
            lines: [{
                lineId: "line-1",
                productId: "product-1",
                unitPrice: 100,
                quantity: 1,
            }],
            shippingAmount: 20,
        });
        const quote = calculateTaxQuote(input({
            shippingMinor: 2_000,
            discountMinor: discount.discountMinor,
            discountAllocation: discount.allocation,
            settings: {
                ...input().settings,
                taxShipping: true,
                shippingTaxClassId: "class-standard",
            },
        }));

        expect(quote.lines[0]).toMatchObject({
            discountMinor: 0,
            taxableAmountMinor: 10_000,
            taxMinor: 1_500,
        });
        expect(quote.shipping).toMatchObject({
            discountMinor: 2_000,
            taxableAmountMinor: 0,
            taxMinor: 0,
        });
    });

    it("keeps product-scoped discounts away from unrelated tax classes", () => {
        const lines = [
            { lineId: "line-low", productId: "product-low", unitPrice: 100, quantity: 1 },
            { lineId: "line-high", productId: "product-high", unitPrice: 100, quantity: 1 },
        ];
        const discount = buildStorefrontDiscountAllocation({
            decimalPlaces: 2,
            discountAmount: 50,
            discountType: "amount_off_products",
            applicableProductIds: ["product-low"],
            lines,
            shippingAmount: 0,
        });
        const quote = calculateTaxQuote(input({
            classes: [
                { id: "class-low", name: "Low", isExempt: false },
                { id: "class-high", name: "High", isExempt: false },
            ],
            rates: [
                rate({ id: "low", taxClassId: "class-low", rateBps: 1_000 }),
                rate({ id: "high", taxClassId: "class-high", rateBps: 2_000 }),
            ],
            lines: [
                { ...input().lines[0]!, lineId: "line-low", productId: "product-low", taxClassId: "class-low" },
                { ...input().lines[0]!, lineId: "line-high", productId: "product-high", taxClassId: "class-high" },
            ],
            discountMinor: discount.discountMinor,
            discountAllocation: discount.allocation,
        }));

        expect(quote.lines[0]).toMatchObject({
            discountMinor: 5_000,
            taxableAmountMinor: 5_000,
            taxMinor: 500,
        });
        expect(quote.lines[1]).toMatchObject({
            discountMinor: 0,
            taxableAmountMinor: 10_000,
            taxMinor: 2_000,
        });
    });

    it("keeps largest-remainder line allocation identical across quote/create retries", () => {
        const lowLineId = buildStorefrontTaxAllocationLineId(0, "variant-low");
        const highLineId = buildStorefrontTaxAllocationLineId(1, "variant-high");
        const storefrontLines = [
            { lineId: lowLineId, productId: "product-low", unitPrice: 1, quantity: 1 },
            { lineId: highLineId, productId: "product-high", unitPrice: 1, quantity: 1 },
        ];
        const discount = buildStorefrontDiscountAllocation({
            decimalPlaces: 2,
            discountAmount: 0.01,
            discountType: "amount_off_order",
            lines: storefrontLines,
            shippingAmount: 0,
        });
        const quoteInput = input({
            classes: [
                { id: "class-low", name: "Low", isExempt: false },
                { id: "class-high", name: "High", isExempt: false },
            ],
            rates: [
                rate({ id: "low", taxClassId: "class-low", rateBps: 10_000 }),
                rate({ id: "high", taxClassId: "class-high", rateBps: 0 }),
            ],
            lines: [
                {
                    ...input().lines[0]!,
                    lineId: lowLineId,
                    productId: "product-low",
                    variantId: "variant-low",
                    unitPriceMinor: 100,
                    taxClassId: "class-low",
                },
                {
                    ...input().lines[0]!,
                    lineId: highLineId,
                    productId: "product-high",
                    variantId: "variant-high",
                    unitPriceMinor: 100,
                    taxClassId: "class-high",
                },
            ],
            discountMinor: discount.discountMinor,
            discountAllocation: discount.allocation,
        });

        const quote = calculateTaxQuote(quoteInput);
        const retry = calculateTaxQuote({ ...quoteInput, lines: [...quoteInput.lines].reverse() });
        const lineSnapshot = (value: typeof quote) => Object.fromEntries(
            value.lines.map((line) => [line.lineId, {
                discountMinor: line.discountMinor,
                taxMinor: line.taxMinor,
                totalMinor: line.totalMinor,
            }]),
        );

        expect(lineSnapshot(retry)).toEqual(lineSnapshot(quote));
        expect(quote.taxMinor).toBe(99);
        expect(retry.taxMinor).toBe(99);
        expect(lineSnapshot(quote)).toMatchObject({
            [lowLineId]: { discountMinor: 1, taxMinor: 99 },
            [highLineId]: { discountMinor: 0, taxMinor: 0 },
        });
    });

    it("rejects explicit allocations that do not reconcile to the discount", () => {
        expect(() => calculateTaxQuote(input({
            discountMinor: 1_000,
            discountAllocation: {
                lines: [{ lineId: "line-1", amountMinor: 999 }],
                shippingMinor: 0,
            },
        }))).toThrow("must equal the bounded discount total");
    });

    it("reconciles inclusive compound rounding so component sums equal the tax snapshot", () => {
        const quote = calculateTaxQuote(input({
            settings: { ...input().settings, pricesIncludeTax: true },
            lines: [{ ...input().lines[0]!, unitPriceMinor: 10_157 }],
            rates: [
                rate({ id: "first", rateBps: 333, priority: 1 }),
                rate({ id: "second", rateBps: 277, priority: 2, isCompound: true }),
            ],
        }));
        const line = quote.lines[0]!;
        expect(line.totalMinor).toBe(10_157);
        expect(line.components.reduce((sum, component) => sum + component.amountMinor, 0))
            .toBe(line.taxMinor);
        expect(line.taxableAmountMinor + line.taxMinor).toBe(line.grossAmountMinor);
    });
});
