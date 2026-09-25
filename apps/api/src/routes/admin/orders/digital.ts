// Digital delivery actions on one order (Wave B design §3.5, §7.2): resend the
// delivery message. The outbox row carries ids only; the files and keys are
// resolved when it is sent. Permission: ORDERS_EDIT in
// packages/core/src/auth/rbac/route-permissions/digital.ts.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { countOrderDigitalEntitlements } from "@scalius/core/modules/digital";
import { recordAndEnqueueNotification } from "@scalius/core/modules/notifications";
import { AppError } from "@scalius/core/errors";
import { ok } from "../../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.openapi(createRoute({
    method: "post",
    path: "/{id}/digital/resend",
    operationId: "dashboard.orders.digital_resend",
    tags: ["Admin - Orders"],
    summary: "Send the buyer their downloads and licence keys again",
    description: "Sends every file and key the order still gives access to, by the store's delivery channels. The same request key sends once.",
    request: {
        params: z.object({ id: z.string().min(1).max(80) }),
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ requestKey: z.string().uuid() }).strict() } },
        },
    },
    responses: {
        200: {
            description: "Message queued",
            content: { "application/json": { schema: successEnvelope(z.object({ outboxId: z.string(), queued: z.boolean() })) } },
        },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const { requestKey } = c.req.valid("json");
    if (await countOrderDigitalEntitlements(db, orderId) === 0) {
        throw new AppError(409, "NOTHING_TO_RESEND", "This order has no downloads or keys to send.");
    }
    const result = await recordAndEnqueueNotification({
        db,
        queue: c.env.JOBS_QUEUE,
        notification: {
            subjectType: "order",
            subjectId: orderId,
            audience: "customer",
            notificationType: "order_digital_delivered",
            dedupeKey: `order:${orderId}:digital_delivered:resend:${requestKey}`,
            source: "admin_resend",
            data: { resend: true },
        },
    });
    return ok(c, { outboxId: result.outboxId, queued: result.enqueued });
});

export { app as adminOrderDigitalRoutes };
