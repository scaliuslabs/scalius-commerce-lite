import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    activatePromotion: vi.fn(),
    pausePromotion: vi.fn(),
    createPromotionDraft: vi.fn(),
    getPromotionAggregate: vi.fn(),
    getPromotionOrderUsage: vi.fn(),
    archivePromotionDraft: vi.fn(),
}));

vi.mock("@scalius/core/modules/promotions", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/promotions")>(),
    activatePromotion: mocks.activatePromotion,
    pausePromotion: mocks.pausePromotion,
    createPromotionDraft: mocks.createPromotionDraft,
    getPromotionAggregate: mocks.getPromotionAggregate,
    getPromotionOrderUsage: mocks.getPromotionOrderUsage,
    archivePromotionDraft: mocks.archivePromotionDraft,
}));

// The store currency a discount's amounts are in (no database here).
vi.mock("@scalius/core/modules/markets", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/markets")>(),
    readStoreCurrency: vi.fn(async () => ({ code: "BDT" })),
}));

import { adminDiscountRoutes } from "./discounts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
type WireBody = { data: any; error: any };

function draftBody(overrides: Record<string, unknown> = {}) {
    return {
        name: "SAVE10",
        method: "code",
        codes: [{ code: "save10" }],
        effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: 1_000 } }],
        ...overrides,
    };
}

/** A discount as the promotions service stores it (its own field names). */
function storedDiscount(overrides: Record<string, unknown> = {}) {
    return {
        id: "promo_1", revision: 1, status: "draft", timezone: "Asia/Dhaka", budgetCurrencyCode: "BDT", maxDiscountSpendMinor: 50_000,
        conditions: [{ id: "cond_1", kind: "minimum_merchandise_subtotal", config: { amountMinor: 100_000, currencyCode: "BDT" } }],
        effects: [{ id: "eff_1", kind: "fixed_amount_off", target: "order", allocation: "once", config: { amountMinor: 5_000, currencyCode: "BDT" } }],
        startsAtEpochSeconds: null, endsAtEpochSeconds: null, createdAtEpochSeconds: 1_790_000_000, updatedAtEpochSeconds: 1_790_000_000, deletedAtEpochSeconds: null,
        redemptionCount: 0, discountSpendMinor: 0,
        ...overrides,
    };
}

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", {} as never);
        await next();
    });
    app.route("/admin/discounts", adminDiscountRoutes);
    return app;
}

const json = (body: unknown, method = "POST") => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
});

describe("admin discount routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createPromotionDraft.mockResolvedValue({ id: "promo_1", revision: 1, status: "draft" });
        mocks.getPromotionOrderUsage.mockResolvedValue({ redemptionCount: 2, discountSpendMinor: 3_000 });
        mocks.getPromotionAggregate.mockResolvedValue(storedDiscount());
    });

    it("creates code and automatic drafts with normalized codes and default combinations", async () => {
        const app = createTestApp();
        expect((await app.request("/api/v1/admin/discounts", json(draftBody()))).status).toBe(201);
        expect(mocks.createPromotionDraft).toHaveBeenLastCalledWith({}, expect.objectContaining({
            method: "code",
            codes: [{ code: "SAVE10", isActive: true }],
            combinesWith: { product: false, order: false, shipping: false },
        }));
        const automatic = await app.request("/api/v1/admin/discounts", json(draftBody({
            name: "Free delivery weekend",
            method: "automatic",
            codes: [],
            effects: [{ kind: "free", target: "shipping", allocation: "once", config: {} }],
        })));
        expect(automatic.status).toBe(201);
        const limitedAutomatic = await app.request("/api/v1/admin/discounts", json(draftBody({
            method: "automatic", codes: [], maxRedemptions: 10,
        })));
        expect(limitedAutomatic.status).toBe(400);
        expect(mocks.createPromotionDraft).toHaveBeenCalledTimes(2);
    });

    it("reports order usage for code and automatic discounts", async () => {
        const app = createTestApp();
        const response = await app.request("/api/v1/admin/discounts/promo_1");
        expect(response.status).toBe(200);
        const { discount } = (await response.json() as WireBody).data;
        expect(discount).toMatchObject({ id: "promo_1", currency: "BDT", redemptionCount: 2, discountSpendMinor: 3_000 });
        // One spelling per field on the wire (L6): currency, budgetCurrency, timeZone.
        expect(discount).toMatchObject({ timeZone: "Asia/Dhaka", budgetCurrency: "BDT" });
        expect(discount.conditions[0].config).toEqual({ amountMinor: 100_000, currency: "BDT" });
        expect(discount.effects[0].config).toEqual({ amountMinor: 5_000, currency: "BDT" });
        expect(JSON.stringify(discount)).not.toMatch(/currencyCode|timezone|EpochSeconds/u);
    });

    it("requires a revision claim to activate or deactivate,", async () => {
        const app = createTestApp();
        for (const command of ["activate", "pause"]) {
            expect((await app.request(`/api/v1/admin/discounts/promo_1/${command}`, json({}))).status).toBe(400);
        }
        expect(mocks.activatePromotion).not.toHaveBeenCalled();
        mocks.activatePromotion.mockResolvedValue({ id: "promo_1", revision: 2, status: "active" });
        const response = await app.request("/api/v1/admin/discounts/promo_1/activate", json({ expectedRevision: 1 }));
        expect(response.status).toBe(200);
        expect(mocks.activatePromotion).toHaveBeenCalledWith({}, "promo_1", 1);
        expect((await response.json() as WireBody).data.discount).toMatchObject({ id: "promo_1", revision: 1 });
    });

    it("takes the wire spellings and gives the service its own, the store's zone when none is sent", async () => {
        const app = createTestApp();
        const response = await app.request("/api/v1/admin/discounts", json(draftBody({
            maxDiscountSpendMinor: 50_000,
            budgetCurrency: "BDT",
            conditions: [{ kind: "minimum_merchandise_subtotal", config: { amountMinor: 100_000, currency: "BDT" } }],
        })));
        expect(response.status, await response.clone().text()).toBe(201);
        const [, input] = mocks.createPromotionDraft.mock.calls.at(-1)!;
        expect(input).toMatchObject({
            budgetCurrencyCode: "BDT",
            conditions: [{ kind: "minimum_merchandise_subtotal", config: { amountMinor: 100_000, currencyCode: "BDT" } }],
        });
        expect(typeof input.timezone).toBe("string");
        expect(input).not.toHaveProperty("budgetCurrency");
        expect((await response.json() as WireBody).data.discount.id).toBe("promo_1");
        // The service's own spellings are not the wire's.
        expect((await app.request("/api/v1/admin/discounts", json(draftBody({ timezone: "Asia/Dhaka" })))).status).toBe(400);
        // A refusal names the wire field.
        const mixed = await app.request("/api/v1/admin/discounts", json(draftBody({
            maxDiscountSpendMinor: 50_000, budgetCurrency: "USD",
            conditions: [{ kind: "minimum_merchandise_subtotal", config: { amountMinor: 100_000, currency: "BDT" } }],
        })));
        expect(mixed.status).toBe(400);
        expect(JSON.stringify((await mixed.json() as WireBody).error.details)).toContain("budgetCurrency");
    });

    it("archives under the revision in the query and answers the archived discount", async () => {
        const app = createTestApp();
        expect((await app.request("/api/v1/admin/discounts/promo_1", { method: "DELETE" })).status).toBe(400);
        mocks.archivePromotionDraft.mockResolvedValue({ id: "promo_1", revision: 2, status: "archived" });
        mocks.getPromotionAggregate.mockResolvedValue(storedDiscount({ revision: 2, status: "archived", deletedAtEpochSeconds: 1_790_000_100 }));
        const response = await app.request("/api/v1/admin/discounts/promo_1?expectedRevision=1", { method: "DELETE" });
        expect(response.status).toBe(200);
        expect(mocks.archivePromotionDraft).toHaveBeenCalledWith({}, "promo_1", 1);
        expect((await response.json() as WireBody).data.discount).toMatchObject({ id: "promo_1", status: "archived", revision: 2 });

    });
});
