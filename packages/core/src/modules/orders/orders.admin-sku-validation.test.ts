import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { PaymentStatus } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import type { CreateOrderInput } from "./orders.validation";
import type { StorefrontTaxQuoteInput } from "../tax";

const inventoryMocks = vi.hoisted(() => ({
    prepareStockReservationBatch: vi.fn(),
    reserveStockBatch: vi.fn(),
    releaseReservedStockBatch: vi.fn(),
    validateStockBatchAvailability: vi.fn(),
}));
const transitionMocks = vi.hoisted(() => ({
    applyClaimedInventoryEntryBatch: vi.fn(),
    applyInventoryForStatusChange: vi.fn(),
}));
const settingsMocks = vi.hoisted(() => ({
    getCurrencySettings: vi.fn(),
    getAllowedCountries: vi.fn(),
}));
const taxMocks = vi.hoisted(() => ({
    calculateStorefrontTaxQuote: vi.fn(),
}));
const mediaMocks = vi.hoisted(() => ({
    loadProductMediaProjections: vi.fn(async () => new Map()),
}));
const createAttemptMocks = vi.hoisted(() => ({
    buildIdentity: vi.fn(),
    claim: vi.fn(),
    guard: vi.fn(() => ({ kind: "attempt-guard" })),
    commit: vi.fn(() => ({ kind: "attempt-commit" })),
    resolve: vi.fn(),
    markFailed: vi.fn(),
    isGuardError: vi.fn(() => false),
}));

vi.mock("../inventory", () => ({
    prepareStockReservationBatch: inventoryMocks.prepareStockReservationBatch,
    reserveStockBatch: inventoryMocks.reserveStockBatch,
    releaseReservedStockBatch: inventoryMocks.releaseReservedStockBatch,
    validateStockBatchAvailability: inventoryMocks.validateStockBatchAvailability,
}));

vi.mock("../inventory/inventory-transitions", () => ({
    applyClaimedInventoryEntryBatch: transitionMocks.applyClaimedInventoryEntryBatch,
    applyInventoryForStatusChange: transitionMocks.applyInventoryForStatusChange,
    isStockDeductStatus: (status: string) => status === "shipped" || status === "delivered",
    isStockReservableStatus: (status: string) => ["incomplete", "pending", "processing", "confirmed"].includes(status),
    isStockRestoreStatus: (status: string) => ["cancelled", "returned", "refunded"].includes(status),
}));

vi.mock("../settings/site-settings.service", () => ({
    getCurrencySettings: settingsMocks.getCurrencySettings,
    getAllowedCountries: settingsMocks.getAllowedCountries,
}));

vi.mock("../tax", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tax")>()),
    calculateStorefrontTaxQuote: taxMocks.calculateStorefrontTaxQuote,
}));

vi.mock("../products/products.media", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../products/products.media")>()),
    loadProductMediaProjections: mediaMocks.loadProductMediaProjections,
}));

vi.mock("./admin-order-create-attempts", () => ({
    buildAdminOrderCreateAttemptIdentity: createAttemptMocks.buildIdentity,
    claimAdminOrderCreateAttempt: createAttemptMocks.claim,
    buildAdminOrderCreateAttemptGuard: createAttemptMocks.guard,
    buildAdminOrderCreateAttemptCommit: createAttemptMocks.commit,
    resolveAdminOrderCreateAttempt: createAttemptMocks.resolve,
    markAdminOrderCreateAttemptFailed: createAttemptMocks.markFailed,
    isAdminOrderCreateAttemptGuardError: createAttemptMocks.isGuardError,
}));

import { createOrder, resolveAdminOrderItemInventory } from "./orders.admin";

beforeEach(() => {
    vi.clearAllMocks();
    inventoryMocks.prepareStockReservationBatch.mockResolvedValue({
        success: true,
        results: [],
        statements: [{ kind: "inventory-guard" }, { kind: "inventory-movement" }, { kind: "inventory-update" }],
        resolveIdempotentReplay: vi.fn(async () => null),
    });
    inventoryMocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });
    inventoryMocks.releaseReservedStockBatch.mockResolvedValue({ success: true, results: [] });
    inventoryMocks.validateStockBatchAvailability.mockResolvedValue({ success: true, results: [] });
    transitionMocks.applyClaimedInventoryEntryBatch.mockResolvedValue(undefined);
    transitionMocks.applyInventoryForStatusChange.mockResolvedValue("deducted");
    settingsMocks.getCurrencySettings.mockResolvedValue({
        currencyCode: "BDT",
        currencySymbol: "৳",
        usdExchangeRate: "1",
    });
    settingsMocks.getAllowedCountries.mockResolvedValue({
        allowedCountries: [],
        allowedCountriesMode: "include",
    });
    taxMocks.calculateStorefrontTaxQuote.mockImplementation(async (
        _db: Database,
        input: StorefrontTaxQuoteInput,
    ) => {
        const decimalPlaces = input.currency?.decimalPlaces ?? 2;
        const scale = 10 ** decimalPlaces;
        const minor = (value: number) => Math.round(value * scale);
        const lines = input.lines.map((line) => {
            const unitPriceMinor = minor(line.unitPrice);
            const grossAmountMinor = unitPriceMinor * line.quantity;
            return {
                lineId: line.lineId,
                productId: line.productId,
                variantId: line.variantId,
                taxClassId: line.taxClassId,
                taxClassName: null,
                unitPriceMinor,
                quantity: line.quantity,
                grossAmountMinor,
                discountMinor: 0,
                taxableAmountMinor: grossAmountMinor,
                taxMinor: 0,
                totalMinor: grossAmountMinor,
                components: [],
            };
        });
        const subtotalMinor = lines.reduce((total, line) => total + line.grossAmountMinor, 0);
        const shippingMinor = minor(input.shippingAmount);
        const discountMinor = minor(input.discountAmount);
        return {
            schemaVersion: 1 as const,
            calculationVersion: "tax-v1" as const,
            enabled: false,
            currencyCode: input.currency?.code ?? "BDT",
            decimalPlaces,
            displayLabel: "Tax",
            pricesIncludeTax: false,
            shippingTaxed: false,
            settingsVersion: 0,
            subtotalMinor,
            shippingMinor,
            discountMinor,
            taxableMinor: subtotalMinor,
            taxMinor: 0,
            totalMinor: subtotalMinor + shippingMinor - discountMinor,
            destination: input.destination,
            lines,
            shipping: {
                taxClassId: null,
                taxClassName: null,
                grossAmountMinor: shippingMinor,
                discountMinor: 0,
                taxableAmountMinor: 0,
                taxMinor: 0,
                totalMinor: shippingMinor,
                components: [],
            },
        };
    });
    mediaMocks.loadProductMediaProjections.mockResolvedValue(new Map());
    createAttemptMocks.buildIdentity.mockResolvedValue({
        actorId: "admin_test",
        requestKeyHash: "request-key-hash",
        requestHash: "request-hash",
    });
    createAttemptMocks.claim.mockResolvedValue({
        status: "claimed",
        attempt: {
            id: "attempt_1",
            actorId: "admin_test",
            requestKeyHash: "request-key-hash",
            requestHash: "request-hash",
            orderId: "order_manual_test",
            claimId: "claim_1",
        },
    });
    createAttemptMocks.resolve.mockResolvedValue(null);
    createAttemptMocks.markFailed.mockResolvedValue(undefined);
});

interface SkuRow {
    id: string;
    productId: string;
    trackInventory: boolean;
    variantDeletedAt: number | null;
    productActive: boolean;
    productDeletedAt: number | null;
    imageId?: string | null;
    productName?: string;
    variantLabel?: string | null;
    taxClassId?: string | null;
    productDiscountType?: "percentage" | "flat" | null;
    productDiscountPercentage?: number | null;
    productDiscountAmount?: number | null;
    variantPrice?: number;
    variantDiscountType?: "percentage" | "flat" | null;
    variantDiscountPercentage?: number | null;
    variantDiscountAmount?: number | null;
}

interface AdminOrderSkuIssue {
    index: number;
    productId: string;
    variantId: string | null;
    code: string;
    message: string;
}

function activeLocationRows() {
    return [
        {
            id: "city_dhaka",
            name: "Dhaka",
            type: "city",
            parentId: null,
            isActive: true,
            deletedAt: null,
        },
        {
            id: "zone_mirpur",
            name: "Mirpur",
            type: "zone",
            parentId: "city_dhaka",
            isActive: true,
            deletedAt: null,
        },
        {
            id: "area_section_10",
            name: "Section 10",
            type: "area",
            parentId: "zone_mirpur",
            isActive: true,
            deletedAt: null,
        },
    ];
}

function createSkuDb(rows: SkuRow[]) {
    const where = vi.fn(async () => rows.map((row) => ({
        imageId: null,
        productName: `Product ${row.id}`,
        variantLabel: null,
        taxClassId: null,
        productDiscountType: null,
        productDiscountPercentage: null,
        productDiscountAmount: null,
        variantPrice: 100,
        variantDiscountType: null,
        variantDiscountPercentage: null,
        variantDiscountAmount: null,
        ...row,
    })));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));

    return {
        db: { select } as unknown as Database,
        select,
        where,
    };
}

function queryResult<T>(rows: T[], getValue: unknown = rows[0] ?? null) {
    return {
        get: vi.fn(async () => getValue),
        then: (onFulfilled: (value: T[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(onFulfilled, onRejected),
    };
}

function createOrderDbWithSkuRows(rows: SkuRow[], locationRows = activeLocationRows()) {
    let selectCall = 0;
    const insertValues: Array<Record<string, unknown> | Array<Record<string, unknown>>> = [];
    const updateValues: Array<Record<string, unknown>> = [];
    const batch = vi.fn(async () => []);
    const insert = vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown> | Array<Record<string, unknown>>) => {
            insertValues.push(values);
            return { kind: "insert", values };
        }),
    }));
    const update = vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
            updateValues.push(values);
            return {
                where: vi.fn(() => ({ kind: "update", values })),
            };
        }),
    }));
    const skuWhere = vi.fn(async () => rows.map((row) => ({
        imageId: null,
        productName: `Product ${row.id}`,
        variantLabel: null,
        taxClassId: null,
        productDiscountType: null,
        productDiscountPercentage: null,
        productDiscountAmount: null,
        variantPrice: 100,
        variantDiscountType: null,
        variantDiscountPercentage: null,
        variantDiscountAmount: null,
        ...row,
    })));
    const select = vi.fn(() => {
        selectCall += 1;
        if (selectCall === 2) {
            return {
                from: vi.fn(() => ({
                    innerJoin: vi.fn(() => ({ where: skuWhere })),
                })),
            };
        }

        const result = selectCall === 1 ? queryResult(locationRows) : queryResult([], null);
        return {
            from: vi.fn(() => ({
                where: vi.fn(() => result),
            })),
        };
    });

    return {
        db: { select, batch, insert, update } as unknown as Database,
        batch,
        insert,
        update,
        insertValues,
        updateValues,
    };
}

function createOrderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
    return {
        requestKey: crypto.randomUUID(),
        customerName: "Test Customer",
        customerPhone: "+8801775528888",
        customerEmail: null,
        shippingAddress: "House 1, Road 2, Dhaka",
        city: "city_dhaka",
        zone: "zone_mirpur",
        area: null,
        notes: null,
        items: [
            {
                productId: "prod_active",
                variantId: "var_foreign",
                quantity: 1,
            },
        ],
        discountAmount: null,
        shippingCharge: 60,
        ...overrides,
    };
}

async function expectSkuIssues(action: Promise<unknown>): Promise<AdminOrderSkuIssue[]> {
    try {
        await action;
        throw new Error("Expected SKU validation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toBe("Some manual order items need attention.");
        return ((error as ValidationError).details as { itemIssues: AdminOrderSkuIssue[] }).itemIssues;
    }
}

describe("resolveAdminOrderItemInventory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns validated SKU inventory tracking for matching active products", async () => {
        const { db } = createSkuDb([
            {
                id: "var_tracked",
                productId: "prod_1",
                trackInventory: true,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
            {
                id: "var_untracked",
                productId: "prod_2",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
        ]);

        const result = await resolveAdminOrderItemInventory(db, [
            { productId: "prod_1", variantId: "var_tracked", quantity: 2, price: 100 },
            { productId: "prod_2", variantId: "var_untracked", quantity: 1, price: 200 },
        ]);

        expect(result).toEqual([
            {
                productId: "prod_1",
                variantId: "var_tracked",
                quantity: 2,
                price: 100,
                inventoryTracked: true,
                productName: "Product var_tracked",
                variantLabel: null,
                productImageMediaId: null,
                taxClassId: null,
                catalogUnitPrice: null,
            },
            {
                productId: "prod_2",
                variantId: "var_untracked",
                quantity: 1,
                price: 200,
                inventoryTracked: false,
                productName: "Product var_untracked",
                variantLabel: null,
                productImageMediaId: null,
                taxClassId: null,
                catalogUnitPrice: null,
            },
        ]);
    });

    it("resolves the buyer-effective catalog price instead of trusting an admin client amount", async () => {
        const { db } = createSkuDb([
            {
                id: "var_product_discount",
                productId: "prod_1",
                trackInventory: true,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
                variantPrice: 100,
                productDiscountType: "percentage",
                productDiscountPercentage: 10,
            },
            {
                id: "var_variant_discount",
                productId: "prod_2",
                trackInventory: true,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
                variantPrice: 100,
                productDiscountType: "percentage",
                productDiscountPercentage: 10,
                variantDiscountType: "flat",
                variantDiscountAmount: 25,
            },
        ]);

        const result = await resolveAdminOrderItemInventory(db, [
            { productId: "prod_1", variantId: "var_product_discount", quantity: 1 },
            { productId: "prod_2", variantId: "var_variant_discount", quantity: 1 },
        ], { catalogPricePrecision: 2 });

        expect(result.map((item) => item.catalogUnitPrice)).toEqual([90, 75]);
    });

    it("resolves the exact SKU image asset for a manual-order snapshot", async () => {
        mediaMocks.loadProductMediaProjections.mockResolvedValueOnce(new Map([[
            "prod_1",
            [{
                id: "pmed_exact",
                mediaId: "med_exact",
                kind: "image",
                url: "https://media.example.test/exact.webp",
                posterMediaId: null,
                posterUrl: null,
                altText: "Exact",
                caption: null,
                width: 800,
                height: 800,
                durationMs: null,
                isPrimary: true,
                sortOrder: 0,
                status: "ready",
            }],
        ]]));
        const { db } = createSkuDb([{
            id: "var_exact",
            productId: "prod_1",
            trackInventory: true,
            variantDeletedAt: null,
            productActive: true,
            productDeletedAt: null,
            imageId: "pmed_exact",
            productName: "Snapshot product",
            variantLabel: "Large",
        }]);

        const [result] = await resolveAdminOrderItemInventory(db, [{
            productId: "prod_1",
            variantId: "var_exact",
            quantity: 1,
            price: 100,
        }]);

        expect(result).toEqual(expect.objectContaining({
            productName: "Snapshot product",
            variantLabel: "Large",
            productImageMediaId: "med_exact",
        }));
    });

    it("rejects missing SKUs before reading inventory metadata", async () => {
        const { db, select } = createSkuDb([]);

        const issues = await expectSkuIssues(resolveAdminOrderItemInventory(db, [
            { productId: "prod_1", variantId: null, quantity: 1, price: 100 },
        ]));

        expect(select).not.toHaveBeenCalled();
        expect(issues).toEqual([
            {
                index: 0,
                productId: "prod_1",
                variantId: null,
                code: "SKU_REQUIRED",
                message: "Select a product SKU before saving the order.",
            },
        ]);
    });

    it("rejects unavailable, mismatched, deleted, and inactive SKU rows with item-level issues", async () => {
        const { db } = createSkuDb([
            {
                id: "var_foreign",
                productId: "prod_other",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
            {
                id: "var_deleted",
                productId: "prod_active",
                trackInventory: false,
                variantDeletedAt: 1_765_000_000,
                productActive: true,
                productDeletedAt: null,
            },
            {
                id: "var_inactive_product",
                productId: "prod_inactive",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: false,
                productDeletedAt: null,
            },
            {
                id: "var_deleted_product",
                productId: "prod_deleted",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: 1_765_000_001,
            },
        ]);

        const issues = await expectSkuIssues(resolveAdminOrderItemInventory(db, [
            { productId: "prod_missing", variantId: "var_missing", quantity: 1, price: 100 },
            { productId: "prod_active", variantId: "var_foreign", quantity: 1, price: 100 },
            { productId: "prod_active", variantId: "var_deleted", quantity: 1, price: 100 },
            { productId: "prod_inactive", variantId: "var_inactive_product", quantity: 1, price: 100 },
            { productId: "prod_deleted", variantId: "var_deleted_product", quantity: 1, price: 100 },
        ]));

        expect(issues).toEqual([
            expect.objectContaining({ index: 0, productId: "prod_missing", variantId: "var_missing", code: "VARIANT_UNAVAILABLE" }),
            expect.objectContaining({ index: 1, productId: "prod_active", variantId: "var_foreign", code: "VARIANT_MISMATCH" }),
            expect.objectContaining({ index: 2, productId: "prod_active", variantId: "var_deleted", code: "VARIANT_UNAVAILABLE" }),
            expect.objectContaining({ index: 3, productId: "prod_inactive", variantId: "var_inactive_product", code: "PRODUCT_UNAVAILABLE" }),
            expect.objectContaining({ index: 4, productId: "prod_deleted", variantId: "var_deleted_product", code: "PRODUCT_UNAVAILABLE" }),
        ]);
    });

    it("stops admin order creation before inventory or order writes when SKU ownership is invalid", async () => {
        const { db, batch, insert, update } = createOrderDbWithSkuRows([
            {
                id: "var_foreign",
                productId: "prod_other",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
        ]);

        const issues = await expectSkuIssues(createOrder(db, createOrderInput(), "admin_test"));

        expect(issues).toEqual([
            expect.objectContaining({
                index: 0,
                productId: "prod_active",
                variantId: "var_foreign",
                code: "VARIANT_MISMATCH",
            }),
        ]);
        expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
        expect(inventoryMocks.prepareStockReservationBatch).not.toHaveBeenCalled();
        expect(transitionMocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("stores canonical active delivery-location names instead of submitted labels", async () => {
        const { db, batch, insertValues } = createOrderDbWithSkuRows([
            {
                id: "var_untracked",
                productId: "prod_active",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
        ]);

        await createOrder(db, createOrderInput({
            area: "area_section_10",
            cityName: "Forged City",
            zoneName: "Forged Zone",
            areaName: "Forged Area",
            items: [
                {
                    productId: "prod_active",
                    variantId: "var_untracked",
                    quantity: 1,
                },
            ],
        }), "admin_test");

        const orderInsert = insertValues.find((values): values is Record<string, unknown> =>
            !Array.isArray(values) && "cityName" in values && "zoneName" in values,
        );

        expect(batch).toHaveBeenCalledTimes(1);
        expect(orderInsert).toMatchObject({
            city: "city_dhaka",
            zone: "zone_mirpur",
            area: "area_section_10",
            cityName: "Dhaka",
            zoneName: "Mirpur",
            areaName: "Section 10",
        });
    });

    it("rejects inactive or cross-parent delivery locations before inventory and order writes", async () => {
        const { db, batch, insert, update } = createOrderDbWithSkuRows(
            [
                {
                    id: "var_untracked",
                    productId: "prod_active",
                    trackInventory: false,
                    variantDeletedAt: null,
                    productActive: true,
                    productDeletedAt: null,
                },
            ],
            [
                {
                    id: "city_dhaka",
                    name: "Dhaka",
                    type: "city",
                    parentId: null,
                    isActive: true,
                    deletedAt: null,
                },
                {
                    id: "zone_mirpur",
                    name: "Mirpur",
                    type: "zone",
                    parentId: "city_other",
                    isActive: true,
                    deletedAt: null,
                },
            ],
        );

        await expect(createOrder(db, createOrderInput(), "admin_test"))
            .rejects.toThrow("Selected zone is no longer available for the chosen city.");

        expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
        expect(inventoryMocks.prepareStockReservationBatch).not.toHaveBeenCalled();
        expect(transitionMocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("creates unpaid manual orders with balance due equal to the order total", async () => {
        const { db, batch, insertValues } = createOrderDbWithSkuRows([
            {
                id: "var_untracked",
                productId: "prod_active",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
        ]);

        await createOrder(db, createOrderInput({
            items: [
                {
                    productId: "prod_active",
                    variantId: "var_untracked",
                    quantity: 2,
                },
            ],
            shippingCharge: 60,
            discountAmount: null,
        }), "admin_test");

        const orderInsert = insertValues.find((values): values is Record<string, unknown> =>
            !Array.isArray(values) && "shippingCharge" in values && "balanceDue" in values,
        );

        expect(batch).toHaveBeenCalledTimes(1);
        expect(orderInsert).toMatchObject({
            totalAmount: 260,
            paidAmount: 0,
            balanceDue: 260,
            paymentStatus: PaymentStatus.UNPAID,
            currencyCode: "BDT",
            currencyDecimalPlaces: 2,
            subtotalAmountMinor: 20_000,
            shippingAmountMinor: 6_000,
            discountAmountMinor: 0,
            taxAmountMinor: 0,
            totalAmountMinor: 26_000,
            taxLabel: "Tax",
            pricesIncludeTax: false,
            paymentMethod: "cod",
            status: "confirmed",
            inventoryAction: "none",
        });
        expect(insertValues).toContainEqual(expect.objectContaining({
            orderId: expect.any(String),
            deliveryAttempts: 0,
            codStatus: "pending",
        }));
    });

    it.each([
        {
            currencyCode: "JPY",
            itemPrice: 100.49,
            shippingCharge: 1.6,
            discountAmount: 0.6,
            expectedPrice: 100,
            expectedTotal: 201,
            expectedSubtotalMinor: 200,
            expectedShippingMinor: 2,
            expectedDiscountMinor: 1,
            expectedTotalMinor: 201,
            decimalPlaces: 0,
        },
        {
            currencyCode: "KWD",
            itemPrice: 1.2346,
            shippingCharge: 0.0016,
            discountAmount: 0.0006,
            expectedPrice: 1.235,
            expectedTotal: 2.471,
            expectedSubtotalMinor: 2_470,
            expectedShippingMinor: 2,
            expectedDiscountMinor: 1,
            expectedTotalMinor: 2_471,
            decimalPlaces: 3,
        },
    ])(
        "persists an immutable $currencyCode snapshot for new manual-order money",
        async ({
            currencyCode,
            itemPrice,
            shippingCharge,
            discountAmount,
            expectedPrice,
            expectedTotal,
            expectedSubtotalMinor,
            expectedShippingMinor,
            expectedDiscountMinor,
            expectedTotalMinor,
            decimalPlaces,
        }) => {
            settingsMocks.getCurrencySettings.mockResolvedValue({
                currencyCode,
                currencySymbol: currencyCode,
                usdExchangeRate: "1",
            });
            const { db, insertValues } = createOrderDbWithSkuRows([{
                id: "var_untracked",
                productId: "prod_active",
                trackInventory: false,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
                variantPrice: itemPrice,
            }]);

            await createOrder(db, createOrderInput({
                items: [{
                    productId: "prod_active",
                    variantId: "var_untracked",
                    quantity: 2,
                }],
                shippingCharge,
                discountAmount,
            }), "admin_test");

            const orderInsert = insertValues.find((values): values is Record<string, unknown> =>
                !Array.isArray(values) && "currencyCode" in values,
            );
            const itemInsert = insertValues.find(Array.isArray);
            expect(orderInsert).toMatchObject({
                currencyCode,
                currencyDecimalPlaces: decimalPlaces,
                totalAmount: expectedTotal,
                balanceDue: expectedTotal,
                subtotalAmountMinor: expectedSubtotalMinor,
                shippingAmountMinor: expectedShippingMinor,
                discountAmountMinor: expectedDiscountMinor,
                totalAmountMinor: expectedTotalMinor,
            });
            expect(itemInsert?.[0]).toMatchObject({ price: expectedPrice });
        },
    );

    it("composes tracked stock reservation into the failed manual-order transaction", async () => {
        const { db, batch } = createOrderDbWithSkuRows([
            {
                id: "var_tracked",
                productId: "prod_active",
                trackInventory: true,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
        ]);
        const batchError = new Error("D1 write failed");
        batch.mockRejectedValueOnce(batchError);

        await expect(createOrder(db, createOrderInput({
            items: [
                {
                    productId: "prod_active",
                    variantId: "var_tracked",
                    quantity: 2,
                },
            ],
        }), "admin_test")).rejects.toBe(batchError);

        expect(inventoryMocks.prepareStockReservationBatch).toHaveBeenCalledWith(
            db,
            [{ variantId: "var_tracked", quantity: 2, orderId: expect.any(String) }],
            "regular",
            { reservationKey: expect.stringMatching(/^admin-order-create:v2:/) },
        );
        expect(batch).toHaveBeenCalledWith(expect.arrayContaining([
            { kind: "inventory-guard" },
            { kind: "inventory-movement" },
            { kind: "inventory-update" },
        ]));
        expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
        expect(transitionMocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
    });

    it("keeps tracked manual-order stock reserved until fulfillment", async () => {
        const { db, insertValues } = createOrderDbWithSkuRows([
            {
                id: "var_tracked",
                productId: "prod_active",
                trackInventory: true,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
        ]);

        await createOrder(db, createOrderInput({
            items: [{
                productId: "prod_active",
                variantId: "var_tracked",
                quantity: 2,
            }],
        }), "admin_test");

        const orderInsert = insertValues.find((values): values is Record<string, unknown> =>
            !Array.isArray(values) && "inventoryAction" in values && "customerName" in values,
        );
        expect(orderInsert).toMatchObject({
            status: "confirmed",
            inventoryAction: "reserved",
            paymentMethod: "cod",
            paymentStatus: "unpaid",
        });
        expect(transitionMocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
        expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
    });

    it("does not depend on reservation compensation after a failed create batch", async () => {
        const { db, batch } = createOrderDbWithSkuRows([
            {
                id: "var_tracked",
                productId: "prod_active",
                trackInventory: true,
                variantDeletedAt: null,
                productActive: true,
                productDeletedAt: null,
            },
        ]);
        const batchError = new Error("D1 write failed");
        batch.mockRejectedValueOnce(batchError);
        inventoryMocks.releaseReservedStockBatch.mockResolvedValueOnce({
            success: false,
            results: [{
                success: false,
                variantId: "var_tracked",
                previousStock: 0,
                newStock: 0,
                error: "Reservation release batch failed",
            }],
            error: "Reservation release batch failed",
            manualReconciliationRequired: true,
        });

        const failure = createOrder(db, createOrderInput({
            items: [
                {
                    productId: "prod_active",
                    variantId: "var_tracked",
                    quantity: 2,
                },
            ],
        }), "admin_test");

        await expect(failure).rejects.toBe(batchError);

        expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
        expect(createAttemptMocks.markFailed).toHaveBeenCalledWith(
            db,
            expect.any(Object),
            batchError,
        );
        expect(transitionMocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
    });
});
