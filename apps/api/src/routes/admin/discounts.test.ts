import { OpenAPIHono, z } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscountType } from "@scalius/database/schema";
import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    listDiscounts: vi.fn(),
    getDiscountById: vi.fn(),
    createDiscount: vi.fn(),
    updateDiscount: vi.fn(),
    deleteDiscount: vi.fn(),
    bulkDeleteDiscounts: vi.fn(),
    restoreDiscounts: vi.fn(),
    permanentlyDeleteDiscount: vi.fn(),
}));

vi.mock("@scalius/core/modules/discounts", () => ({
    listDiscounts: mocks.listDiscounts,
    getDiscountById: mocks.getDiscountById,
    createDiscount: mocks.createDiscount,
    updateDiscount: mocks.updateDiscount,
    deleteDiscount: mocks.deleteDiscount,
    bulkDeleteDiscounts: mocks.bulkDeleteDiscounts,
    restoreDiscounts: mocks.restoreDiscounts,
    permanentlyDeleteDiscount: mocks.permanentlyDeleteDiscount,
    createDiscountSchema: z.object({}).passthrough(),
    updateDiscountSchema: z.object({ id: z.string().optional() }).passthrough(),
}));

import { adminDiscountRoutes } from "./discounts";

function createTestApp() {
    const db = { id: "db" };
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/admin/discounts", adminDiscountRoutes);
    return { app, db };
}

describe("admin discount routes", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("forwards the optional discount type filter to the service", async () => {
        mocks.listDiscounts.mockResolvedValue({
            discounts: [],
            pagination: { total: 0, page: 2, limit: 20, totalPages: 0 },
        });
        const { app, db } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/discounts?page=2&limit=20&search=ship&type=free_shipping&trashed=true&sort=type&order=asc",
        );

        expect(response.status).toBe(200);
        expect(mocks.listDiscounts).toHaveBeenCalledWith(db, {
            page: 2,
            limit: 20,
            search: "ship",
            showTrashed: true,
            type: DiscountType.FREE_SHIPPING,
            sort: "type",
            order: "asc",
        });
    });
});
