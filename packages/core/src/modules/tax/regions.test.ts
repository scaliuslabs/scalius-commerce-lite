// Tax regions (MARKETS-DESIGN step 3c): the most specific region with rates
// of a line's class applies, combinable rates bring the broader ones, an
// address with no region of its country pays no tax, the order's market
// decides whether prices include tax, and the tax provider is selected per
// country region (else store-wide) and fails closed.
import { describe, expect, it, vi } from "vitest";
import type { AppProviders, BoundProvider } from "../../integrations/provider-port";
import { calculateTaxQuote, TAX_UNAVAILABLE_REASON } from "./calculator";
import { quoteTax, SYSTEM_TAX_PROVIDER } from "./provider";
import { matchTaxRegions, ratesForTaxClass, taxAddressSource, taxProviderIdFor } from "./region-match";
import { marketTaxInclusionFromSql, pricesIncludeTaxFor } from "./tax.service";
import { orderItemTaxSnapshotColumns, orderTaxSnapshotColumns } from "./snapshot";
import type { CalculateTaxQuoteInput, TaxRateDefinition, TaxRegionDefinition } from "./types";

const region = (id: string, countryCode: string, scope: Partial<TaxRegionDefinition> = {}): TaxRegionDefinition => ({
    id, countryCode, adminArea: null, postalPrefix: null, placeType: null, placeId: null, providerId: null, ...scope,
});
const rate = (id: string, taxRegionId: string, rateBps: number, extra: Partial<TaxRateDefinition> = {}): TaxRateDefinition => ({
    id, taxClassId: "std", taxRegionId, name: id, rateBps, priority: 0, isCompound: false, combinable: false, ...extra,
});

const REGIONS = [
    region("us", "US"),
    region("us_ca", "US", { adminArea: "CA" }),
    region("us_941", "US", { postalPrefix: "941" }),
    region("us_9410", "US", { postalPrefix: "9410" }),
    region("bd", "BD"),
    region("bd_dhaka", "BD", { placeType: "city", placeId: "city_dhaka" }),
    region("bd_mirpur", "BD", { placeType: "zone", placeId: "zone_mirpur" }),
    region("gb", "GB", { providerId: "acme.tax:avalara" }),
];

function input(overrides: Partial<CalculateTaxQuoteInput> = {}): CalculateTaxQuoteInput {
    return {
        currencyCode: "USD",
        decimalPlaces: 2,
        priceIncrementMinor: 1,
        settings: {
            enabled: true,
            taxShipping: true,
            defaultTaxClassId: "std",
            shippingTaxClassId: null,
            displayLabel: "Tax",
            providerId: "system",
            version: 1,
        },
        pricesIncludeTax: false,
        classes: [{ id: "std", name: "Standard", isExempt: false }, { id: "food", name: "Food", isExempt: false }],
        regions: REGIONS,
        rates: [
            rate("us_federal", "us", 0),
            rate("ca_state", "us_ca", 725),
            rate("sf_city", "us_941", 125, { combinable: true }),
            rate("bd_vat", "bd", 1_500),
            rate("bd_food", "bd", 500, { taxClassId: "food" }),
            rate("dhaka", "bd_dhaka", 200, { combinable: true, priority: 1 }),
        ],
        destination: { city: null, zone: null, area: null, countryCode: "US", adminArea: "CA", postalCode: "94107" },
        lines: [{ lineId: "l1", productId: "p1", variantId: "v1", unitPriceMinor: 10_000, quantity: 1, taxClassId: null }],
        shippingMinor: 1_000,
        discountMinor: 0,
        ...overrides,
    };
}

describe("tax region specificity", () => {
    it("orders an address's regions most specific first: place, postal prefix (longest first), admin area, country", () => {
        expect(matchTaxRegions({ country: "US", adminArea: "ca", postalCode: "94107" }, REGIONS).map((each) => each.id))
            .toEqual(["us_9410", "us_941", "us_ca", "us"]);
        expect(matchTaxRegions({ country: "BD", locationIds: ["area_x", "zone_mirpur", "city_dhaka"] }, REGIONS).map((each) => each.id))
            .toEqual(["bd_mirpur", "bd_dhaka", "bd"]);
        // Regions of another country never match; no region of the country: none.
        expect(matchTaxRegions({ country: "FR", postalCode: "94107" }, REGIONS)).toEqual([]);
    });

    it("applies the most specific region with rates of the class, adding the broader ones only through combinable rates", () => {
        const chain = matchTaxRegions({ country: "US", adminArea: "CA", postalCode: "94107" }, REGIONS);
        const rates = input().rates;
        // 9410 has no rate; 941's combinable city rate brings California's, which replaces the federal one.
        expect(ratesForTaxClass(chain, rates, "std")).toEqual({
            rates: [rates[1], rates[2]],
            regionId: "us_941",
        });
        const quote = calculateTaxQuote(input());
        expect(quote.lines[0]).toMatchObject({ taxMinor: 850, taxRegionId: "us_941" });
        expect(quote.lines[0]!.components.map((component) => [component.rateId, component.jurisdictionType, component.jurisdictionId, component.amountMinor]))
            .toEqual([["ca_state", "admin_area", "CA", 725], ["sf_city", "postal_prefix", "941", 125]]);
        // Another class with no rate here pays none.
        expect(calculateTaxQuote(input({ lines: [{ ...input().lines[0]!, taxClassId: "food" }] })).lines[0])
            .toMatchObject({ taxMinor: 0, components: [], taxRegionId: null });
    });

    it("charges no tax where the store has no region of the country, without asking any provider", async () => {
        const quote = calculateTaxQuote(input({ destination: { city: null, zone: null, area: null, countryCode: "FR", postalCode: "75001" } }));
        expect(quote).toMatchObject({ taxMinor: 0, totalMinor: 11_000, shippingTaxed: false, jurisdiction: { countryCode: "FR", providerId: "system" } });
        const resolve = vi.fn();
        await quoteTax(input({ destination: { city: null, zone: null, area: null, countryCode: "FR" } }), { apps: { resolve } as AppProviders });
        expect(resolve).not.toHaveBeenCalled();
    });

    it("taxes an order with no address where the store ships from", () => {
        const pickup = { city: null, zone: null, area: null };
        expect(calculateTaxQuote(input({ destination: pickup, originCountry: "US" })).taxMinor).toBe(0 + 0);
        const bd = calculateTaxQuote(input({ destination: pickup, originCountry: "BD", shippingMinor: 0 }));
        // Only the country's rates: a place's rate needs an address there.
        expect(bd.lines[0]!.components.map((component) => component.rateId)).toEqual(["bd_vat"]);
        expect(bd.jurisdiction.countryCode).toBe("BD");
        // No origin known: Bangladesh, as before regions.
        expect(calculateTaxQuote(input({ destination: pickup, shippingMinor: 0 })).taxMinor).toBe(1_500);
    });
});

describe("prices including tax per market", () => {
    it("reads the order's market: the market selling to the shipping country, else the backup market", () => {
        const markets = marketTaxInclusionFromSql("*:1,IN:0,GB:1");
        expect(markets).toEqual({ backup: true, countries: { IN: false, GB: true } });
        expect(pricesIncludeTaxFor(markets, "IN")).toBe(false);
        expect(pricesIncludeTaxFor(markets, "GB")).toBe(true);
        expect(pricesIncludeTaxFor(markets, "BD")).toBe(true);
        expect(pricesIncludeTaxFor(markets, null)).toBe(true);
        expect(pricesIncludeTaxFor(marketTaxInclusionFromSql(null), "BD")).toBe(false);
    });

    it("adds tax on top in an exclusive market and extracts it in an inclusive one, for the same cart", () => {
        const bd = { city: "city_x", zone: null, area: null, countryCode: "BD" };
        const exclusive = calculateTaxQuote(input({ destination: bd, shippingMinor: 0, pricesIncludeTax: false }));
        const inclusive = calculateTaxQuote(input({ destination: bd, shippingMinor: 0, pricesIncludeTax: true }));
        expect([exclusive.taxMinor, exclusive.totalMinor, exclusive.pricesIncludeTax]).toEqual([1_500, 11_500, false]);
        expect([inclusive.taxMinor, inclusive.totalMinor, inclusive.pricesIncludeTax]).toEqual([1_304, 10_000, true]);
    });
});

describe("tax provider selection", () => {
    it("uses the country region's provider, else the store-wide one", () => {
        expect(taxProviderIdFor(matchTaxRegions({ country: "GB" }, REGIONS), "system")).toBe("acme.tax:avalara");
        expect(taxProviderIdFor(matchTaxRegions({ country: "US" }, REGIONS), "acme.tax:vertex")).toBe("acme.tax:vertex");
        expect(taxProviderIdFor(matchTaxRegions({ country: "US" }, REGIONS), "system")).toBe("system");
        expect(taxProviderIdFor([], "acme.tax:vertex")).toBeNull();
    });

    it("asks an app provider through the port and keeps its lines, rounded to the price increment", async () => {
        const calculate = vi.fn(async (_input: unknown) => ({
            calculationId: "calc_1",
            lines: [{ lineId: "l1", taxes: [{ taxMinor: 2_049, rateBps: 2_000, jurisdiction: "GB", name: "VAT" }] }],
            shipping: [{ taxMinor: 200, rateBps: 2_000, jurisdiction: "GB" }],
        }));
        const app = { id: "acme.tax:avalara", label: "Avalara", calculate } as unknown as BoundProvider<"tax">;
        const apps: AppProviders = { resolve: vi.fn(async () => ({ provider: app, issue: null })) as unknown as AppProviders["resolve"] };
        const quote = await quoteTax(input({
            currencyCode: "GBP",
            priceIncrementMinor: 100,
            destination: { city: null, zone: null, area: null, countryCode: "GB", postalCode: "SW1A 1AA" },
        }), { apps });
        expect(apps.resolve).toHaveBeenCalledWith("tax", "acme.tax:avalara");
        const request = calculate.mock.calls[0]![0] as { destination: unknown; lines: unknown; shippingTaxCode?: string; idempotencyKey: string };
        expect(request.destination).toEqual({ country: "GB", adminArea: null, city: null, postalCode: "SW1A 1AA" });
        expect(request.lines).toEqual([{ lineId: "l1", taxCode: "std", quantity: 1, amountMinor: 10_000 }]);
        expect(request.shippingTaxCode).toBe("std");
        expect(quote.lines[0]!.components).toEqual([{
            rateId: "acme.tax:avalara:GB", name: "VAT", rateBps: 2_000, priority: 0, compound: false,
            jurisdictionType: "provider", jurisdictionId: "GB", amountMinor: 2_000,
        }]);
        expect(quote).toMatchObject({ taxMinor: 2_200, totalMinor: 13_200, jurisdiction: { countryCode: "GB", providerId: "acme.tax:avalara", calculationId: "calc_1" } });
        // The same cart calculates under the same idempotency key.
        await quoteTax(input({ currencyCode: "GBP", priceIncrementMinor: 100, destination: { city: null, zone: null, area: null, countryCode: "GB", postalCode: "SW1A 1AA" } }), { apps });
        expect((calculate.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey).toBe(request.idempotencyKey);
    });

    it("fails closed when the chosen app is missing, not ready, failing or answering wrongly", async () => {
        const gb = input({ destination: { city: null, zone: null, area: null, countryCode: "GB" } });
        await expect(quoteTax(gb)).rejects.toMatchObject({ details: { reason: TAX_UNAVAILABLE_REASON } });
        const notReady: AppProviders = { resolve: async () => ({ provider: null, issue: "Avalara is not ready." }) as never };
        await expect(quoteTax(gb, { apps: notReady })).rejects.toMatchObject({ details: { reason: TAX_UNAVAILABLE_REASON } });
        const failing = (calculate: () => Promise<unknown>): AppProviders => ({
            resolve: async () => ({ provider: { id: "acme.tax:avalara", label: "Avalara", calculate }, issue: null }) as never,
        });
        await expect(quoteTax(gb, { apps: failing(async () => { throw new Error("timeout"); }) }))
            .rejects.toMatchObject({ details: { reason: TAX_UNAVAILABLE_REASON } });
        await expect(quoteTax(gb, { apps: failing(async () => ({ calculationId: "c", lines: [], shipping: [] })) }))
            .rejects.toMatchObject({ details: { reason: TAX_UNAVAILABLE_REASON } });
        await expect(quoteTax({ ...gb, pricesIncludeTax: true }, { apps: failing(async () => ({
            calculationId: "c", lines: [{ lineId: "l1", taxes: [{ taxMinor: 20_000, rateBps: 2_000, jurisdiction: "GB" }] }], shipping: [],
        })) })).rejects.toMatchObject({ details: { reason: TAX_UNAVAILABLE_REASON } });
        // The synchronous system quote refuses an address an app taxes.
        expect(() => calculateTaxQuote(gb)).toThrow(/app provider/);
    });

    it("lets a store-wide app provider replace the system provider everywhere the store has a region", async () => {
        const calculate = vi.fn(async () => ({ calculationId: "calc_us", lines: [{ lineId: "l1", taxes: [] }], shipping: [] }));
        const apps: AppProviders = { resolve: vi.fn(async () => ({ provider: { id: "acme.tax:vertex", label: "Vertex", calculate }, issue: null })) as never };
        const quote = await quoteTax(input({ settings: { ...input().settings, providerId: "acme.tax:vertex" } }), { apps });
        expect(apps.resolve).toHaveBeenCalledWith("tax", "acme.tax:vertex");
        expect(quote).toMatchObject({ taxMinor: 0, jurisdiction: { providerId: "acme.tax:vertex", calculationId: "calc_us" } });
    });

    it("gives the built-in provider the same port: calculate through the registry, no-op documents", async () => {
        const system = await quoteTax(input());
        expect(system).toEqual(calculateTaxQuote(input()));
        expect(system.jurisdiction).toEqual({ countryCode: "US", providerId: "system", calculationId: null, addressSource: "shipping" });
        const settings = { classes: [], regions: [], rates: [], defaultTaxClassId: null, priceIncrementMinor: 1 };
        const document = { calculationId: "c", orderId: "ord_1", idempotencyKey: "k" };
        await expect(SYSTEM_TAX_PROVIDER.commit!(document, { settings })).resolves.toEqual({ documentId: "system:ord_1" });
        await expect(SYSTEM_TAX_PROVIDER.void!(document, { settings })).resolves.toEqual({ documentId: "system:ord_1" });
        await expect(SYSTEM_TAX_PROVIDER.refund!({ ...document, refundId: "rf_1", amountMinor: 100, taxMinor: 13 }, { settings }))
            .resolves.toEqual({ documentId: "system:ord_1:rf_1" });
    });
});

describe("order tax snapshots", () => {
    it("keep the jurisdiction and the provider beside the rate snapshot, binding four values a line", () => {
        const quote = calculateTaxQuote(input());
        const columns = orderItemTaxSnapshotColumns(quote, quote.lines[0]!);
        expect(columns.taxRegionId).toBe("us_941");
        expect(columns.rateSnapshot).toBe(JSON.stringify(quote.lines[0]!.components));
        // The order's facts are literals: a 99-line order still writes the same statements.
        const bound = Object.values(columns).filter((value) => value === null || typeof value !== "object");
        expect(bound).toHaveLength(4);
        const order = orderTaxSnapshotColumns(quote);
        expect([order.providerId, order.providerCalculationId]).toEqual(["system", null]);
        // The order-level snapshot keeps the shape it had before regions.
        expect(Object.keys(JSON.parse(order.rateSnapshot).shipping).sort()).toEqual([
            "components", "discountMinor", "grossAmountMinor", "taxClassId", "taxClassName", "taxMinor", "taxableAmountMinor", "totalMinor",
        ]);
        expect(JSON.parse(order.destinationSnapshot)).toEqual({ city: null, zone: null, area: null });
    });
});

describe("the taxed address (Shopify's rule, migration 0119)", () => {
    it("taxes a shipped order at its shipping address, a pickup at the store, and an order that ships nothing at its billing address", () => {
        expect(taxAddressSource({ deliveryKind: "delivery", hasBillingAddress: true })).toBe("shipping");
        expect(taxAddressSource({ deliveryKind: "pickup", hasBillingAddress: true })).toBe("origin");
        expect(taxAddressSource({ deliveryKind: null, hasBillingAddress: true })).toBe("billing");
        expect(taxAddressSource({ deliveryKind: null, hasBillingAddress: false })).toBe("origin");
    });

    it("records which address was taxed, in the quote and as a literal in the order snapshot", () => {
        const billed = calculateTaxQuote(input({ addressSource: "billing" }));
        expect(billed.jurisdiction.addressSource).toBe("billing");
        expect(orderTaxSnapshotColumns(billed).addressSource).toMatchObject({ queryChunks: [expect.objectContaining({ value: ["'billing'"] })] });
        const origin = calculateTaxQuote(input({ destination: { city: null, zone: null, area: null } }));
        expect(origin.jurisdiction.addressSource).toBe("origin");
    });
});

describe("D1 parity", () => {
    it("binds the same parameters per snapshot line as before regions, so a 99-line order writes the same statements", async () => {
        const { createSqliteD1Database } = await import("@scalius/database/testing/sqlite-d1");
        const { chunkRowsForD1 } = await import("@scalius/database/client");
        const { orderItemTaxSnapshots } = await import("@scalius/database/schema");
        const { ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW } = await import("./snapshot");
        const { db, sqlite } = createSqliteD1Database();
        try {
            const quote = calculateTaxQuote(input());
            const rows = Array.from({ length: 99 }, (_, index) => ({
                orderItemId: `item_${index}`,
                orderId: "ord_1",
                ...orderItemTaxSnapshotColumns(quote, quote.lines[0]!),
            }));
            const chunks = chunkRowsForD1(rows, ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW);
            // Six bound values a row, as before (prices_include_tax is now a literal and tax_region_id bound).
            expect(ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW).toBe(6);
            expect(chunks).toHaveLength(7);
            for (const chunk of chunks) {
                const params = db.insert(orderItemTaxSnapshots).values(chunk).toSQL().params;
                expect(params.length).toBeLessThanOrEqual(100);
                expect(params.length).toBe(chunk.length * ORDER_ITEM_TAX_SNAPSHOT_PARAMETERS_PER_ROW);
            }
        } finally {
            sqlite.close();
        }
    });
});
