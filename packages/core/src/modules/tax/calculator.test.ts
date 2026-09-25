import { describe, expect, it } from "vitest";
import { calculateTaxQuote } from "./calculator";
import {
    buildStorefrontDiscountAllocation,
    buildStorefrontTaxAllocationLineId,
} from "./discount-allocation";
import { allocateMinorAmount } from "./money";
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

// Minor-unit precision is exercised in USD; BDT cash rounding has its own tests.
function input(overrides: Partial<CalculateTaxQuoteInput> = {}): CalculateTaxQuoteInput {
    return {
        currencyCode: "USD",
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
    it("uses deterministic largest-remainder allocation", () => {
        const allocated = allocateMinorAmount(2, [
            { key: "b", weightMinor: 1 },
            { key: "a", weightMinor: 1 },
            { key: "c", weightMinor: 1 },
        ]);
        expect(Object.fromEntries(allocated)).toEqual({ b: 1, a: 1, c: 0 });
    });

    it("allocates whole cash units over whole-unit weights", () => {
        const allocated = allocateMinorAmount(300, [
            { key: "a", weightMinor: 100 },
            { key: "b", weightMinor: 100 },
            { key: "c", weightMinor: 200 },
        ], 100);
        expect(Object.fromEntries(allocated)).toEqual({ a: 100, b: 100, c: 100 });
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

    it("rounds BDT tax to whole taka so a COD total is whole taka", () => {
        const bdt = (overrides: Partial<CalculateTaxQuoteInput>) => calculateTaxQuote(input({ currencyCode: "BDT", ...overrides }));
        // 15% of ৳3,208.53 would be ৳481.28; it is ৳481.
        const exclusive = bdt({ lines: [{ ...input().lines[0]!, unitPriceMinor: 320_853 }] });
        expect(exclusive.taxMinor).toBe(48_100);
        expect(exclusive.totalMinor % 100).toBe(53);
        const whole = bdt({ lines: [{ ...input().lines[0]!, unitPriceMinor: 320_900 }] });
        expect(whole.taxMinor % 100).toBe(0);
        expect(whole.totalMinor % 100).toBe(0);
        // Prices including 15% VAT: ৳1,000 contains ৳130.43, shown as ৳130.
        const inclusive = bdt({
            settings: { ...input().settings, pricesIncludeTax: true },
            lines: [{ ...input().lines[0]!, unitPriceMinor: 100_000 }],
        });
        expect(inclusive.lines[0]).toMatchObject({ taxMinor: 13_000, taxableAmountMinor: 87_000, totalMinor: 100_000 });
        expect(inclusive.totalMinor).toBe(100_000);
        // An order discount spread over lines stays whole taka per line.
        const lines = [
            { ...input().lines[0]!, lineId: "a", unitPriceMinor: 25_000 },
            { ...input().lines[0]!, lineId: "b", unitPriceMinor: 15_000 },
        ];
        const discounted = bdt({ lines, discountMinor: 3_300 });
        expect(discounted.lines.map((line) => line.discountMinor)).toEqual([2_100, 1_200]);
        expect(discounted.lines.every((line) => line.taxMinor % 100 === 0)).toBe(true);
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

    it("applies compound rates across ascending priority layers", () => {
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

    it("treats equal-priority rates as one layer instead of compounding by opaque id order", () => {
        const quote = calculateTaxQuote(input({
            rates: [
                rate({ id: "z-compound", rateBps: 500, priority: 10, isCompound: true }),
                rate({ id: "a-standard", rateBps: 1_000, priority: 10 }),
            ],
        }));
        expect(quote.lines[0]?.components.map((component) => ({
            id: component.rateId,
            amount: component.amountMinor,
        }))).toEqual([
            { id: "a-standard", amount: 1_000 },
            { id: "z-compound", amount: 500 },
        ]);
        expect(quote.taxMinor).toBe(1_500);
    });

    it("extracts inclusive equal-priority layers without hidden same-layer compounding", () => {
        const quote = calculateTaxQuote(input({
            settings: { ...input().settings, pricesIncludeTax: true },
            lines: [{ ...input().lines[0]!, unitPriceMinor: 11_500 }],
            rates: [
                rate({ id: "z-compound", rateBps: 500, priority: 10, isCompound: true }),
                rate({ id: "a-standard", rateBps: 1_000, priority: 10 }),
            ],
        }));
        expect(quote.lines[0]).toMatchObject({
            taxableAmountMinor: 10_000,
            taxMinor: 1_500,
            totalMinor: 11_500,
        });
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

    it("applies only store-wide rates to an order with no address (pickup, service, digital)", () => {
        const quote = calculateTaxQuote(input({
            destination: { city: null, zone: null, area: null },
            rates: [
                rate({ id: "global", rateBps: 100 }),
                rate({ id: "city-match", rateBps: 400, jurisdictionType: "city", jurisdictionId: "city-1" }),
                rate({ id: "zone-match", rateBps: 200, jurisdictionType: "zone", jurisdictionId: "zone-1" }),
                rate({ id: "area-match", rateBps: 300, jurisdictionType: "area", jurisdictionId: "area-1" }),
            ],
        }));
        expect(quote.lines[0]?.components.map((component) => component.rateId)).toEqual(["global"]);
        expect(quote.taxMinor).toBe(100);
        expect(quote.destination).toEqual({ city: null, zone: null, area: null });
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

    it("G7: a tax-exempt line (a gift card) takes no rate whatever its class, exclusive or inclusive", () => {
        const lines = [
            input().lines[0]!,
            { lineId: "line-gc", productId: "product-gc", variantId: "variant-gc", unitPriceMinor: 50_000, quantity: 2, taxClassId: "class-standard", taxExempt: true },
        ];
        const exclusive = calculateTaxQuote(input({ lines }));
        expect(exclusive.lines.map((line) => [line.lineId, line.taxClassId, line.taxMinor, line.taxableAmountMinor, line.totalMinor])).toEqual([
            ["line-1", "class-standard", 1_500, 10_000, 11_500],
            ["line-gc", null, 0, 0, 100_000],
        ]);
        expect(exclusive.totalMinor).toBe(111_500);
        const inclusive = calculateTaxQuote(input({ lines, settings: { ...input().settings, pricesIncludeTax: true } }));
        expect(inclusive.lines[1]).toMatchObject({ taxClassId: null, taxMinor: 0, totalMinor: 100_000, components: [] });
        expect(inclusive.totalMinor).toBe(110_000);
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
        const discount = { discountMinor: 2_000, allocation: { lines: [], shippingMinor: 2_000 } };
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
        const discount = {
            discountMinor: 5_000,
            allocation: { lines: [{ lineId: "line-low", amountMinor: 5_000 }], shippingMinor: 0 },
        };
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
            { lineId: lowLineId, productId: "product-low", unitPriceMinor: 100, quantity: 1 },
            { lineId: highLineId, productId: "product-high", unitPriceMinor: 100, quantity: 1 },
        ];
        const discount = buildStorefrontDiscountAllocation({
            discountMinor: 1,
            lines: storefrontLines,
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
