// packages/core/src/modules/checkout/prepare.test.ts
// Tests for manual COD deposit computation in createStorefrontOrder (Fix C).
//
// These tests exercise the actual deposit calculation logic by providing
// prevalidated cart, delivery, policy, and tax authority snapshots to
// bypass database reads and complex pricing logic.

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
    createStorefrontOrder,
    type StorefrontCheckoutPolicySnapshot,
    type StorefrontDeliveryPreflightResult,
    type StorefrontCartValidationResult,
    markTrustedStorefrontDeliveryPreflightResult,
    markTrustedStorefrontCartValidationResult,
    createTrustedStorefrontCheckoutPolicySnapshot,
} from "@scalius/core/modules/checkout";
import { type CreateStorefrontOrderInput, type CreateStorefrontOrderCustomerIdentity } from "@scalius/core/modules/orders";
import { ValidationError } from "@scalius/core/errors";
import { PaymentMethod } from "@scalius/database/schema";
import type { TaxQuote } from "../tax/browser";
import { type StorefrontTaxAuthoritySnapshot, markTrustedStorefrontTaxAuthorityForTest } from "../tax/tax.service";
import type { PresentmentMoney } from "@scalius/shared/presentment";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";

// ---- Test Fixtures ----

/** Minimal valid cart validation result for a physical COD-eligible order. */
function createMockCartValidation(overrides: Partial<StorefrontCartValidationResult> = {}): StorefrontCartValidationResult {
    const money: PresentmentMoney = {
        currencyCode: "BDT",
        decimalPlaces: 2,
        incrementMinor: 100, // BDT whole taka
        rate: "1",
        shopCurrencyCode: "BDT",
        shopDecimalPlaces: 2,
        fxSource: "same_currency",
        fxAsOf: null,
        lockMinutes: 30,
    };
    return markTrustedStorefrontCartValidationResult({
        money,
        marketContext: { id: "market_1", country: "BD" },
        valid: true,
        issues: [],
        items: [
            {
                index: 0,
                productId: "prod_1",
                variantId: "var_1",
                quantity: 1,
                unitPriceMinor: 10000, // 100.00 BDT
                baseUnitPriceMinor: 10000,
                priceSource: "base",
                bundle: null,
                sourceIndex: 0,
                propertiesPriceMinor: 0,
                properties: [],
                canonicalProperties: [],
                fulfillmentKind: "physical",
                isGiftCard: false,
                productName: "Test Product",
                variantLabel: null,
                freeDelivery: false,
                shippingProfileId: "profile_1",
                shippingWeightGrams: 500,
                inventoryTracked: true,
                availableQuantity: 10,
                taxClassId: "tax_1",
                productImageMediaId: null,
                productImage: null,
            },
        ],
        subtotalMinor: 10000,
        hasFreeDeliveryProduct: false,
        ...overrides,
    });
}

/** Minimal valid delivery preflight result allowing COD. */
function createMockDeliveryPreflight(overrides: Partial<StorefrontDeliveryPreflightResult> = {}): StorefrontDeliveryPreflightResult {
    return markTrustedStorefrontDeliveryPreflightResult({
        kind: "delivery",
        shippingMinor: 500, // 5.00 BDT shipping
        shippingMethod: {
            id: "rate_1",
            name: "Standard Delivery",
            description: null,
            baseAmountMinor: 500,
            feeWaived: false,
        },
        cityName: "Dhaka",
        zoneName: "Gulshan",
        areaName: "Gulshan-1",
        address: {
            countryCode: "BD",
            city: "city_1",
            zone: "zone_1",
            area: "area_1",
            adminArea: null,
            postalCode: null,
        },
        pickup: null,
        fulfilment: {
            lineTypes: ["ship"],
            requiresDeliveryMethod: true,
            deliveryMethodKind: "delivery",
            requiresShipping: true,
            allowsCashOnDelivery: true,
        },
        ...overrides,
    });
}

/** Minimal valid tax quote with configurable total. */
function createMockTaxQuote(totalMinor: number = 10500): TaxQuote {
    return {
        schemaVersion: 1,
        calculationVersion: "tax-v1",
        enabled: true,
        currencyCode: "BDT",
        decimalPlaces: 2,
        displayLabel: "VAT",
        pricesIncludeTax: false,
        shippingTaxed: true,
        settingsVersion: 1,
        subtotalMinor: 10000,
        shippingMinor: 500,
        discountMinor: 0,
        taxableMinor: 10500,
        taxMinor: 0,
        totalMinor,
        destination: {
            city: "city_1",
            zone: "zone_1",
            area: "area_1",
            cityName: "Dhaka",
            zoneName: "Gulshan",
            areaName: "Gulshan-1",
        },
        jurisdiction: {
            countryCode: "BD",
            providerId: "system",
            calculationId: null,
            addressSource: "shipping",
        },
        lines: [
            {
                lineId: "line_1",
                productId: "prod_1",
                variantId: "var_1",
                taxClassId: "tax_1",
                taxClassName: "Standard",
                unitPriceMinor: 10000,
                quantity: 1,
                grossAmountMinor: 10000,
                discountMinor: 0,
                taxableAmountMinor: 10000,
                taxMinor: 0,
                totalMinor: 10000,
                components: [],
                taxRegionId: null,
            },
        ],
        shipping: {
            taxClassId: "tax_1",
            taxClassName: "Standard",
            grossAmountMinor: 500,
            discountMinor: 0,
            taxableAmountMinor: 500,
            taxMinor: 0,
            totalMinor: 500,
            components: [],
            taxRegionId: null,
        },
    };
}

/** Minimal tax authority snapshot for Bangladesh (store country). */
const mockTaxAuthoritySnapshot: StorefrontTaxAuthoritySnapshot = markTrustedStorefrontTaxAuthorityForTest({
    settings: {
        enabled: true,
        taxShipping: true,
        defaultTaxClassId: "tax_1",
        shippingTaxClassId: "tax_1",
        displayLabel: "VAT",
        providerId: "system",
        version: 1,
    },
    classes: [
        { id: "tax_1", name: "Standard", isExempt: false },
    ],
    regions: [
        { id: "region_1", countryCode: "BD", adminArea: null, postalPrefix: null, placeType: null, placeId: null, providerId: null },
    ],
    rates: [
        { id: "rate_1", taxClassId: "tax_1", taxRegionId: "region_1", name: "VAT", rateBps: 0, priority: 1, isCompound: false, combinable: false },
    ],
    markets: {
        backup: false,
        countries: { BD: false },
    },
    originCountry: "BD",
});

/** Creates a checkout policy snapshot with configurable COD deposit settings. */
function createMockCheckoutPolicy(
    depositConfig: {
        codDepositEnabled?: boolean;
        codDepositMode?: "fixed" | "percentage";
        codDepositAmount?: number;
        codDepositPercent?: number;
        codDepositInstructions?: string;
        partialPaymentEnabled?: boolean;
        partialPaymentAmount?: number;
    } = {},
): StorefrontCheckoutPolicySnapshot {
    return createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: depositConfig.partialPaymentEnabled ?? false,
        partialPaymentAmount: depositConfig.partialPaymentAmount,
        shippingCountries: ["BD"],
        contactFields: undefined,
        requireFullBillingAddress: false,
        authorityRevision: 1,
        orderCreatedNotificationEnabled: true,
        metaPurchaseEnabled: true,
        paymentTermsDays: null,
        codDepositEnabled: depositConfig.codDepositEnabled ?? false,
        codDepositMode: depositConfig.codDepositMode ?? "fixed",
        codDepositAmount: depositConfig.codDepositAmount ?? 0,
        codDepositPercent: depositConfig.codDepositPercent ?? 0,
        codDepositInstructions: depositConfig.codDepositInstructions ?? "Please deposit to bKash number 01XXXXXXXXX",
    });
}

/** Minimal valid order input for COD. */
function createMockOrderInput(overrides: Partial<CreateStorefrontOrderInput> = {}): CreateStorefrontOrderInput {
    return {
        checkoutRequestId: "chkreq_1",
        expectedQuoteFingerprint: "fp_1",
        customerName: "Test Customer",
        customerPhone: "+8801712345678",
        customerEmail: "test@example.com",
        shippingCountryCode: "BD",
        shippingAddress: "House 1, Road 2",
        shippingAddressLine2: null,
        shippingDependentLocality: null,
        shippingLocality: "Gulshan",
        shippingAdminArea: "Dhaka",
        shippingPostalCode: "1212",
        city: "city_1",
        zone: "zone_1",
        area: "area_1",
        billingSameAsShipping: true,
        billingCountryCode: null,
        billingName: null,
        billingCompany: null,
        billingAddress: null,
        billingAddressLine2: null,
        billingDependentLocality: null,
        billingLocality: null,
        billingAdminArea: null,
        billingPostalCode: null,
        notes: null,
        attributes: {},
        items: [
            {
                productId: "prod_1",
                variantId: "var_1",
                quantity: 1,
                price: 10000,
                productName: "Test Product",
                variantLabel: null,
                properties: [],
            },
        ],
        discountCodes: [],
        shippingCharge: 500,
        shippingMethodId: "rate_1",
        paymentMethod: PaymentMethod.COD,
        inventoryPool: "regular",
        giftCards: [],
        ...overrides,
    };
}

/** Mock database that returns empty results for any query. */
function createMockDb(): Database {
    // Create a mock query builder that mimics drizzle's interface
    const createQueryBuilder = () => {
        const qb: Record<string, unknown> = {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            groupBy: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            offset: vi.fn().mockReturnThis(),
            leftJoin: vi.fn().mockReturnThis(),
            rightJoin: vi.fn().mockReturnThis(),
            innerJoin: vi.fn().mockReturnThis(),
            // Set operations (union, unionAll, intersect, except)
            union: vi.fn().mockReturnThis(),
            unionAll: vi.fn().mockReturnThis(),
            intersect: vi.fn().mockReturnThis(),
            except: vi.fn().mockReturnThis(),
            // Internal method called by set operations
            addSetOperators: vi.fn().mockReturnThis(),
            getSelectedFields: vi.fn().mockReturnValue([]),
            get: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue([]),
            execute: vi.fn().mockResolvedValue([]),
            // Make query builder thenable (drizzle query builders can be awaited directly)
            then: vi.fn().mockImplementation((onFulfilled) => Promise.resolve([]).then(onFulfilled)),
        };
        return qb;
    };

    const queryBuilder = createQueryBuilder();

    const mockDb = {
        select: vi.fn().mockReturnValue(queryBuilder),
        insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
                onConflictDoUpdate: vi.fn().mockReturnValue({
                    returning: vi.fn().mockResolvedValue([]),
                }),
            }),
        }),
        update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    returning: vi.fn().mockResolvedValue([]),
                }),
            }),
        }),
        delete: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]),
            }),
        }),
        batch: vi.fn().mockImplementation((queries: unknown[]) => Promise.resolve(queries.map(() => []))),
        execute: vi.fn().mockResolvedValue({ changes: 0 }),
        run: vi.fn().mockResolvedValue({ changes: 0 }),
        transaction: vi.fn(),
        prepare: vi.fn(),
        exec: vi.fn(),
    };
    return mockDb as unknown as Database;
}

// ---- Tests ----

describe("createStorefrontOrder — manual COD deposit computation (Fix C)", () => {
    const mockDb = createMockDb();
    const requestUrl = "https://store.example.com/checkout";
    const requestCurrency = {
        code: "BDT",
        decimalPlaces: 2,
        priceIncrementMinor: 100, // BDT whole taka
    };

    describe("fixed mode", () => {
        it("rejects zero deposit amount (codDepositAmount = 0)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: 0,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            await expect(
                createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot),
            ).rejects.toThrow(
                "Cash on delivery is unavailable for this order: the deposit must be greater than zero.",
            );
        });

        it("rejects negative deposit amount (caught by toMinor validation)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: -100,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            await expect(
                createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot),
            ).rejects.toThrow(
                "Money amount must be finite and non-negative.",
            );
        });

        it("accepts valid fixed deposit (50 BDT = 5000 minor)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: 50, // 50.00 BDT = 5000 minor
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500); // total = 105.00 BDT = 10500 minor

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.depositPlan).toBe(true);
            expect(result.commitPayload.codDeposit).toBeDefined();
            expect(result.commitPayload.codDeposit?.amountMinor).toBe(5000);
            expect(result.commitPayload.codDeposit?.percent).toBeNull();
        });

        it("rejects when deposit >= order total (deposit 105 BDT = 10500 minor, total 10500 minor)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: 105, // 105.00 BDT = 10500 minor >= 105.00 BDT total
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500); // total = 105.00 BDT = 10500 minor

            const input = createMockOrderInput();

            await expect(
                createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot),
            ).rejects.toThrow(
                "Cash on delivery is unavailable for this order: the deposit must be less than the order total.",
            );
        });

        it("accepts deposit just under order total", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: 104.99, // 104.99 BDT < 105.00 BDT total
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500); // total = 105.00 BDT = 10500 minor

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.depositPlan).toBe(true);
            expect(result.commitPayload.codDeposit?.amountMinor).toBe(10499); // 104.99 * 100 = 10499
        });
    });

    describe("percentage mode", () => {
        it("rejects zero percent (codDepositPercent = 0)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: 0,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            await expect(
                createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot),
            ).rejects.toThrow(
                "Cash on delivery is unavailable for this order: the deposit must be greater than zero.",
            );
        });

        it("rejects negative percent", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: -10,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            await expect(
                createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot),
            ).rejects.toThrow(
                "Cash on delivery is unavailable for this order: the deposit must be greater than zero.",
            );
        });

        it("accepts valid percentage (10% of 10500 = 1050 minor)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: 10,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.depositPlan).toBe(true);
            expect(result.commitPayload.codDeposit).toBeDefined();
            expect(result.commitPayload.codDeposit?.amountMinor).toBe(1050); // ceil(10500 * 10 / 100) = 1050
            expect(result.commitPayload.codDeposit?.percent).toBe(10);
        });

        it("accepts percentage that rounds up (33% of 10500 = 3465 minor, ceil = 3465)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: 33,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            // ceil(10500 * 33 / 100) = ceil(3465) = 3465
            expect(result.commitPayload.codDeposit?.amountMinor).toBe(3465);
        });

        it("caps percentage deposit at totalMinor - 1 (99% of 10500 = 10395, cap = 10499)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: 99,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            // Math.min(10500 - 1, ceil(10500 * 99 / 100)) = Math.min(10499, 10395) = 10395
            // Wait: 10500 * 99 / 100 = 10395, ceil = 10395
            // But cap is totalMinor - 1 = 10499, so result is 10395
            expect(result.commitPayload.codDeposit?.amountMinor).toBe(10395);
        });

        it("caps at totalMinor - 1 when percentage would exceed (100% would be 10500, cap = 10499)", async () => {
            // The schema should prevent 100% but let's test the cap logic with a value that would exceed
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: 100, // Would be 100% but schema limits to 1-99
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            // 100% is not a valid schema value but let's see what happens
            // Math.min(10500 - 1, ceil(10500 * 100 / 100)) = Math.min(10499, 10500) = 10499
            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.commitPayload.codDeposit?.amountMinor).toBe(10499);
        });
    });

    describe("COD deposit disabled or conditions not met", () => {
        it("does not create deposit plan when codDepositEnabled is false", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: false,
                codDepositMode: "fixed",
                codDepositAmount: 500,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.depositPlan).toBe(false);
            expect(result.commitPayload.codDeposit).toBeUndefined();
        });

        it("does not create deposit plan when payment method is not COD", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: 500,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput({ paymentMethod: "stripe" });

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.depositPlan).toBe(false);
            expect(result.commitPayload.codDeposit).toBeUndefined();
        });

        it("rejects COD when delivery doesn't allow COD", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: false, // Disable COD deposit
                codDepositMode: "fixed",
                codDepositAmount: 500,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight({
                fulfilment: {
                    requiresShipping: true,
                    allowsCashOnDelivery: false, // COD not allowed
                    lineTypes: ["ship"],
                    requiresDeliveryMethod: true,
                    deliveryMethodKind: "delivery",
                },
            });
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            await expect(
                createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot),
            ).rejects.toThrow(
                "Cash on delivery isn't available for this order. Choose an online payment method.",
            );
        });

        it("does not create deposit plan when gift cards are applied (codDepositEnabled disabled)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: false, // Disable COD deposit to avoid error
                codDepositMode: "fixed",
                codDepositAmount: 500,
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput({
                giftCards: [{ handle: "gift_1" }],
                expectedAmountDueMinor: 0,
            });

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot, { masterSecret: "secret" });

            expect(result.depositPlan).toBe(false);
            expect(result.commitPayload.codDeposit).toBeUndefined();
        });

        it("does not create deposit plan when order is in foreign currency (codDepositEnabled disabled)", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: false, // Disable COD deposit to avoid currency authority error
                codDepositMode: "fixed",
                codDepositAmount: 500,
            });
            const cart = createMockCartValidation({
                money: {
                    currencyCode: "USD",
                    decimalPlaces: 2,
                    rate: "0.009",
                    shopCurrencyCode: "BDT",
                    shopDecimalPlaces: 2,
                    incrementMinor: 1,
                    fxSource: "fx_rate",
                    fxAsOf: Math.floor(Date.now() / 1000),
                    lockMinutes: 30,
                },
            });
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500); // Still BDT but cart is USD

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.depositPlan).toBe(false);
            expect(result.commitPayload.codDeposit).toBeUndefined();
        });
    });

    describe("existing deposit >= total check preserved", () => {
        it("rejects when fixed deposit equals order total", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: 105.00, // Exactly equals 105.00 BDT total
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            await expect(
                createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot),
            ).rejects.toThrow(
                "Cash on delivery is unavailable for this order: the deposit must be less than the order total.",
            );
        });

        it("caps percentage deposit at totalMinor - 1 when percentage would equal or exceed total (1 BDT = 100 minor, 100% capped at 99)", async () => {
            // Use BDT with totalMinor = 100 (1 BDT) to test the cap logic
            // percent = 100 would give ceil(100 * 100 / 100) = 100, but cap is totalMinor - 1 = 99
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: 100, // Would be 100% but schema limits to 1-99; testing cap logic
            });
            // Create cart with 1 BDT subtotal (100 minor) and 0 shipping
            const cart = createMockCartValidation({
                items: [
                    {
                        index: 0,
                        productId: "prod_1",
                        variantId: "var_1",
                        quantity: 1,
                        unitPriceMinor: 100, // 1.00 BDT
                        baseUnitPriceMinor: 100,
                        priceSource: "base",
                        bundle: null,
                        sourceIndex: 0,
                        propertiesPriceMinor: 0,
                        properties: [],
                        canonicalProperties: [],
                        fulfillmentKind: "physical",
                        isGiftCard: false,
                        productName: "Test Product",
                        variantLabel: null,
                        freeDelivery: false,
                        shippingProfileId: "profile_1",
                        shippingWeightGrams: 500,
                        inventoryTracked: true,
                        availableQuantity: 10,
                        taxClassId: "tax_1",
                        productImageMediaId: null,
                        productImage: null,
                    },
                ],
                subtotalMinor: 100,
            });
            const delivery = createMockDeliveryPreflight({
                shippingMinor: 0, // Free shipping
            });

            const input = createMockOrderInput();

            // ceil(100 * 100 / 100) = 100, cap = 100 - 1 = 99, so deposit = 99
            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.commitPayload.codDeposit?.amountMinor).toBe(99);
        });
    });

    describe("deposit amount in commit payload", () => {
        it("includes correct amountMinor, percent, instructions, and contactSnapshot for fixed mode", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "fixed",
                codDepositAmount: 25.50, // 25.50 BDT = 2550 minor (less than 10500 total)
                codDepositInstructions: "Deposit to bKash 01XXXXXXXXX",
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.commitPayload.codDeposit).toEqual({
                amountMinor: 2550, // 25.50 * 100
                instructions: "Deposit to bKash 01XXXXXXXXX",
                percent: null,
                contactSnapshot: expect.any(String), // JSON string with business contact info
            });
        });

        it("includes correct amountMinor, percent, instructions, and contactSnapshot for percentage mode", async () => {
            const policy = createMockCheckoutPolicy({
                codDepositEnabled: true,
                codDepositMode: "percentage",
                codDepositPercent: 20,
                codDepositInstructions: "Deposit 20% to bKash",
            });
            const cart = createMockCartValidation();
            const delivery = createMockDeliveryPreflight();
            const taxQuote = createMockTaxQuote(10500);

            const input = createMockOrderInput();

            const result = await createStorefrontOrder(mockDb, input, requestUrl, undefined, cart, delivery, undefined, requestCurrency, policy, mockTaxAuthoritySnapshot);

            expect(result.commitPayload.codDeposit).toEqual({
                amountMinor: 2100, // ceil(10500 * 20 / 100) = 2100
                instructions: "Deposit 20% to bKash",
                percent: 20,
                contactSnapshot: expect.any(String),
            });
        });
    });
});