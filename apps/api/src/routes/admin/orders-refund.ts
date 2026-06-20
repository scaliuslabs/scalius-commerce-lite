import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { processReturn, processRefund } from "@scalius/core/modules/payments/refund-service";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ForbiddenError, ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope } from "../../schemas/responses";
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── Inline response schemas ────────────────────────────────────────────────

const refundResultSchema = z.object({
    success: z.boolean(),
    gateway: z.string(),
    refundId: z.string().optional(),
    amount: z.number(),
    isFullRefund: z.boolean(),
    error: z.string().optional(),
}).passthrough();

const returnResultSchema = successEnvelope(z.object({
    refundResult: refundResultSchema.optional(),
}));

// ─── POST /:id/return ────────────────────────────────────────────────────────

const returnOrderRoute = createRoute({
    method: "post",
    path: "/{id}/return",
    tags: ["Admin - Orders"],
    summary: "Process order return",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: z.object({ reason: z.string().optional(), autoRefund: z.boolean().optional() }) } } }
    },
    responses: {
        200: {
            description: "Return processed",
            content: { "application/json": { schema: returnResultSchema } },
        },
    }
});

app.openapi(returnOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");
    if (data.autoRefund) {
        const user = c.get("user") as { id?: string } | undefined;
        const userPerms = user?.id ? await getUserPermissions(db, user.id) : new Set<string>();
        if (!userPerms.has(PERMISSIONS.ORDERS_REFUND)) {
            throw new ForbiddenError("Refund permission is required to auto-refund a returned order");
        }
    }
    const envCache = c.env?.CACHE;
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const result = await processReturn(db, envCache, { orderId, reason: data.reason ?? "Customer return", autoRefund: data.autoRefund ?? false }, encryptionKey);
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);
    return ok(c, result);
});

// ─── POST /:id/refund ────────────────────────────────────────────────────────

const refundOrderRoute = createRoute({
    method: "post",
    path: "/{id}/refund",
    tags: ["Admin - Orders"],
    summary: "Process order refund",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        amount: z.number().optional(),
                        reason: z.string().optional(),
                        gateway: z.enum(["stripe", "sslcommerz", "polar", "cod"]).optional()
                    })
                }
            }
        }
    },
    responses: {
        200: {
            description: "Refund processed",
            content: { "application/json": { schema: successEnvelope(refundResultSchema) } },
        },
    }
});

app.openapi(refundOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");
    const envCache = c.env?.CACHE;
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const result = await processRefund(db, envCache, { orderId, amount: data.amount, reason: data.reason ?? "Refund requested", gateway: data.gateway }, encryptionKey);
    if (!result.success) throw new ValidationError(result.error || "Refund processing failed");
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);
    return ok(c, result);
});

export { app as adminOrdersRefundRoutes };
