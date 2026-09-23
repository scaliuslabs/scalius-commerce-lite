import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    resendTerminalOrderNotificationOutboxById: vi.fn(),
}));

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/notifications")>();
    return {
        ...actual,
        resendTerminalOrderNotificationOutboxById: mocks.resendTerminalOrderNotificationOutboxById,
    };
});

import { adminOrdersRoutes } from "./orders";

const db = { id: "db" };
const queue = { send: vi.fn(async () => undefined) };

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    const env = {
        JOBS_QUEUE: queue,
    } as unknown as Env;

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });

    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.route("/orders", adminOrdersRoutes);

    return { app, env };
}

describe("admin order notification routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resendTerminalOrderNotificationOutboxById.mockResolvedValue({
            outboxId: "outbox_resend_1",
            dedupeKey: "manual_resend:outbox_1:resend_req_1",
            created: true,
            enqueued: true,
        });
    });

    it("resends a sent notification with an explicit request id", async () => {
        const { app, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/orders/order_1/notifications/outbox_1/resend",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ resendRequestId: " resend_req_1 " }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.resendTerminalOrderNotificationOutboxById).toHaveBeenCalledWith({
            db,
            queue,
            orderId: "order_1",
            outboxId: "outbox_1",
            resendRequestId: "resend_req_1",
        });
        const body = await response.json() as { data: Record<string, unknown> };
        expect(body.data).toMatchObject({
            outboxId: "outbox_resend_1",
            dedupeKey: "manual_resend:outbox_1:resend_req_1",
            created: true,
            enqueued: true,
        });
    });

    it("rejects manual resend without a request id", async () => {
        const { app, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/orders/order_1/notifications/outbox_1/resend",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ resendRequestId: " " }),
            },
            env,
        );

        expect(response.status).toBe(400);
        expect(mocks.resendTerminalOrderNotificationOutboxById).not.toHaveBeenCalled();
    });

    it("passes one canonical header key through exact resend replay", async () => {
        const { app, env } = createTestApp();
        const request = () => app.request(
            "/api/v1/admin/orders/order_1/notifications/outbox_1/resend",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "Idempotency-Key": "resend_req_header_1",
                },
                body: JSON.stringify({}),
            },
            env,
        );

        expect((await request()).status).toBe(200);
        expect((await request()).status).toBe(200);
        expect(mocks.resendTerminalOrderNotificationOutboxById).toHaveBeenCalledTimes(2);
        for (const call of mocks.resendTerminalOrderNotificationOutboxById.mock.calls) {
            expect(call[0]).toMatchObject({ resendRequestId: "resend_req_header_1" });
        }
    });

    it("rejects an exact resend header/body mismatch", async () => {
        const { app, env } = createTestApp();
        const response = await app.request(
            "/api/v1/admin/orders/order_1/notifications/outbox_1/resend",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "Idempotency-Key": "resend_req_header_1",
                },
                body: JSON.stringify({ resendRequestId: "resend_req_body_1" }),
            },
            env,
        );

        expect(response.status).toBe(400);
        expect(mocks.resendTerminalOrderNotificationOutboxById).not.toHaveBeenCalled();
    });
});
