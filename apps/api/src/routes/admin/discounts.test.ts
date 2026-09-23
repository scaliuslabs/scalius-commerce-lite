import { OpenAPIHono, z } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
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
    setDiscountActiveStatus: vi.fn(),
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
    setDiscountActiveStatus: mocks.setDiscountActiveStatus,
    createDiscountSchema: z.object({}).passthrough(),
    updateDiscountSchema: z.object({ id: z.string().optional() }).passthrough(),
}));

import { adminDiscountRoutes } from "./discounts";

function createTestApp(
    permissions = new Set([PERMISSIONS.DISCOUNTS_TOGGLE_STATUS]),
) {
    const db = { id: "db" };
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("adminPermissions", permissions);
        await next();
    });
    app.route("/admin/discounts", adminDiscountRoutes);
    return { app, db };
}

describe("admin discount routes", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("passes lifecycle authority separately from ordinary create permission", async () => {
        mocks.createDiscount.mockResolvedValue({ id: "disc_1", revision: 1 });
        const { app, db } = createTestApp(new Set());

        const response = await app.request("/api/v1/admin/discounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive: false }),
        });

        expect(response.status).toBe(201);
        expect(mocks.createDiscount).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ isActive: false }),
            { canToggleStatus: false },
        );
    });

    it("forwards the editor revision claim on full rule updates", async () => {
        mocks.updateDiscount.mockResolvedValue({ id: "disc_1", revision: 6 });
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/discounts/disc_1", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: 5, isActive: false }),
        });

        expect(response.status).toBe(200);
        expect(mocks.updateDiscount).toHaveBeenCalledWith(
            db,
            "disc_1",
            expect.objectContaining({ expectedRevision: 5 }),
            { canToggleStatus: true },
        );
    });
});
