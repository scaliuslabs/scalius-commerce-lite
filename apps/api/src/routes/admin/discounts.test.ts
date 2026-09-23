import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    activatePromotion: vi.fn(),
    pausePromotion: vi.fn(),
    createPromotionDraft: vi.fn(),
    getPromotionAggregate: vi.fn(),
    getPromotionOrderUsage: vi.fn(),
    bumpCacheGeneration: vi.fn(),
}));

vi.mock("@scalius/core/modules/promotions", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/promotions")>(),
    activatePromotion: mocks.activatePromotion,
    pausePromotion: mocks.pausePromotion,
    createPromotionDraft: mocks.createPromotionDraft,
    getPromotionAggregate: mocks.getPromotionAggregate,
    getPromotionOrderUsage: mocks.getPromotionOrderUsage,
}));

vi.mock("../../utils/cache-generation", () => ({
    bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { adminDiscountRoutes } from "./discounts";

function draftBody(overrides: Record<string, unknown> = {}) {
    return {
        name: "SAVE10",
        method: "code",
        codes: [{ code: "save10" }],
        effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: 1_000 } }],
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
        mocks.getPromotionAggregate.mockResolvedValue({ id: "promo_1", redemptionCount: 0, discountSpendMinor: 0 });
        const response = await app.request("/api/v1/admin/discounts/promo_1");
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            data: { id: "promo_1", redemptionCount: 2, discountSpendMinor: 3_000 },
        });
    });

    it("requires a revision claim to activate or deactivate, and refreshes the storefront cache", async () => {
        const app = createTestApp();
        for (const command of ["activate", "pause"]) {
            expect((await app.request(`/api/v1/admin/discounts/promo_1/${command}`, json({}))).status).toBe(400);
        }
        expect(mocks.activatePromotion).not.toHaveBeenCalled();
        mocks.activatePromotion.mockResolvedValue({ id: "promo_1", revision: 2, status: "active" });
        const response = await app.request("/api/v1/admin/discounts/promo_1/activate", json({ expectedRevision: 1 }));
        expect(response.status).toBe(200);
        expect(mocks.activatePromotion).toHaveBeenCalledWith({}, "promo_1", 1);
        expect(mocks.bumpCacheGeneration).toHaveBeenCalledOnce();
    });
});
