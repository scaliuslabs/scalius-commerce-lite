import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    archivePromotionDraft: vi.fn(),
    createPromotionDraft: vi.fn(),
    getPromotionAggregate: vi.fn(),
    listPromotionDrafts: vi.fn(),
    previewPersistedPromotion: vi.fn(),
    updatePromotionDraft: vi.fn(),
    invalidateCatalogCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/promotions", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/promotions")>(),
    archivePromotionDraft: mocks.archivePromotionDraft,
    createPromotionDraft: mocks.createPromotionDraft,
    getPromotionAggregate: mocks.getPromotionAggregate,
    listPromotionDrafts: mocks.listPromotionDrafts,
    previewPersistedPromotion: mocks.previewPersistedPromotion,
    updatePromotionDraft: mocks.updatePromotionDraft,
}));

vi.mock("../../utils/cache-invalidation", () => ({
    invalidateCatalogCaches: mocks.invalidateCatalogCaches,
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
        mocks.previewPersistedPromotion.mockResolvedValue({
            evaluatorVersion: 1,
            applied: null,
            rejected: [],
            unmatchedCodes: [],
            assumedActive: true,
            promotionRevision: 1,
        });
    });

    it("creates only a code draft and never exposes automatic activation", async () => {
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

    it("previews a claimed revision with the persisted production evaluator", async () => {
        const app = createTestApp();
        const cart = {
            currencyCode: "BDT",
            lines: [{
                id: "line_1",
                productId: "prod_1",
                variantId: "sku_1",
                unitPriceMinor: 10_000,
                quantity: 1,
            }],
            shippingAmountMinor: 600,
            submittedCodes: ["SAVE10"],
            evaluatedAtEpochSeconds: 1_800_000_000,
        };
        const response = await app.request("/api/v1/admin/promotions/promo_1/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: 1, cart }),
        });

        expect(response.status).toBe(200);
        expect(mocks.previewPersistedPromotion).toHaveBeenCalledWith({}, {
            promotionId: "promo_1",
            expectedRevision: 1,
            cart,
        });
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            data: { assumedActive: true, promotionRevision: 1 },
        });
    });
});
