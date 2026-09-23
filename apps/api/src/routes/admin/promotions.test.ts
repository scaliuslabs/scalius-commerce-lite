import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    activatePromotion: vi.fn(),
    pausePromotion: vi.fn(),
    createPromotionDraft: vi.fn(),
    getPromotionAggregate: vi.fn(),
    getPromotionUsageStats: vi.fn(),
    bumpCacheGeneration: vi.fn(),
}));

vi.mock("@scalius/core/modules/promotions", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/promotions")>(),
    activatePromotion: mocks.activatePromotion,
    pausePromotion: mocks.pausePromotion,
    createPromotionDraft: mocks.createPromotionDraft,
    getPromotionAggregate: mocks.getPromotionAggregate,
    getPromotionUsageStats: mocks.getPromotionUsageStats,
}));

vi.mock("../../utils/cache-generation", () => ({
    bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { adminPromotionRoutes } from "./promotions";

function draftBody(overrides: Record<string, unknown> = {}) {
    return {
        name: "Ten percent code",
        title: null,
        method: "code",
        priority: 100,
        conflictPolicy: "best",
        startsAtEpochSeconds: null,
        endsAtEpochSeconds: null,
        timezone: "Asia/Dhaka",
        codes: [{ code: "SAVE10", isActive: true }],
        conditions: [],
        effects: [{
            kind: "percentage_off",
            target: "order",
            allocation: "once",
            config: { basisPoints: 1_000 },
        }],
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
    app.route("/admin/promotions", adminPromotionRoutes);
    return app;
}

describe("admin promotion draft routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createPromotionDraft.mockResolvedValue({
            id: "promo_1",
            revision: 1,
            status: "draft",
        });
        mocks.getPromotionUsageStats.mockResolvedValue({
            redemptionCount: 2,
            customerRedemptionCount: 0,
            discountSpendMinor: 3_000,
        });
    });

    it("creates only a code draft and rejects automatic authoring", async () => {
        const app = createTestApp();
        const response = await app.request("/api/v1/admin/promotions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draftBody()),
        });

        expect(response.status).toBe(201);
        expect(mocks.createPromotionDraft).toHaveBeenCalledWith({}, expect.objectContaining({
            method: "code",
            codes: [{ code: "SAVE10", isActive: true }],
        }));

        const automaticResponse = await app.request("/api/v1/admin/promotions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draftBody({ method: "automatic", codes: [] })),
        });
        expect(automaticResponse.status).toBe(400);
        expect(mocks.createPromotionDraft).toHaveBeenCalledTimes(1);
    });

    it("reports current immutable usage and the conservative budget policy", async () => {
        const app = createTestApp();
        mocks.getPromotionAggregate.mockResolvedValue({ id: "promo_1", redemptionCount: 0 });

        const response = await app.request("/api/v1/admin/promotions/promo_1");

        expect(response.status).toBe(200);
        expect(mocks.getPromotionUsageStats).toHaveBeenCalledWith({}, "promo_1", null);
        await expect(response.json()).resolves.toMatchObject({
            data: {
                id: "promo_1",
                redemptionCount: 2,
                discountSpendMinor: 3_000,
                redemptionBudgetPolicy: "committed_orders_never_released",
            },
        });
    });

    it("requires an explicit revision claim for lifecycle commands", async () => {
        const app = createTestApp();
        for (const command of ["activate", "pause"]) {
            const response = await app.request(`/api/v1/admin/promotions/promo_1/${command}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            expect(response.status).toBe(400);
        }
        expect(mocks.activatePromotion).not.toHaveBeenCalled();
        expect(mocks.pausePromotion).not.toHaveBeenCalled();
    });
});
