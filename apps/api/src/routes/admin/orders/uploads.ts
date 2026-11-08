// The files buyers gave an order (COMMERCE-HOOKS H17): staff see every app's,
// an app (`order_uploads.list`, `read_orders`) only those its own inputs
// took. Each carries a signed link that streams the file for 5 minutes; links
// are never logged. Permission: ORDERS_VIEW (route-permissions/orders.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { listOrderBuyerUploads, signBuyerUploadLink, BUYER_UPLOADS_PER_ORDER_MAX } from "@scalius/core/modules/buyer-uploads";
import { BUYER_UPLOAD_TYPES } from "@scalius/shared/buyer-uploads";
import { trimTrailingCharacter } from "@scalius/shared/text-scan";
import { adminRouter } from "../admin-router";
import { requestAppId } from "../request-actor";
import { ok } from "../../../utils/api-response";
import { errorResponses, successEnvelope } from "../../../schemas/responses";
import { appOwnedField } from "../../../schemas/protected";
import { isoTimestampSchema } from "../../../schemas/timestamps";

const app = adminRouter();

const orderUploadSchema = z.object({
    id: z.string(),
    appId: z.string().openapi({ description: "The app whose input took the file; only it (and store readers) see it." }),
    key: z.string().openapi({ description: "The input, `<app id>.<key>`: a line input's key on the line's `properties`, or a checkout attribute's key." }),
    target: z.enum(["line", "attribute"]),
    orderItemId: z.string().nullable().openapi({ description: "The order line of a line input; null for an attribute." }),
    filename: z.string(),
    mediaType: z.enum(BUYER_UPLOAD_TYPES),
    sizeBytes: z.number().int(),
    url: z.string().url().openapi({ description: "A signed link that streams the file until `urlExpiresAt` (5 minutes). A bearer link: never log or share it." }),
    urlExpiresAt: isoTimestampSchema,
    attachedAt: isoTimestampSchema,
}).openapi("OrderBuyerUpload");

const listRoute = createRoute({
    operationId: "dashboard.orders.uploads",
    method: "get",
    path: "/{id}/uploads",
    tags: ["Admin - Orders"],
    summary: "The files buyers gave the order's file inputs, with short-lived signed links",
    description: "An app sees only the files its own inputs took. Follow nextCursor for more (an order holds at most 50).",
    request: {
        params: z.object({ id: z.string().min(1).max(128) }),
        query: z.object({
            cursor: z.string().max(64).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
            limit: z.coerce.number().int().min(1).max(BUYER_UPLOADS_PER_ORDER_MAX).default(BUYER_UPLOADS_PER_ORDER_MAX),
        }),
    },
    responses: {
        200: {
            description: "The order's files",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        uploads: appOwnedField("items", z.array(orderUploadSchema)),
                        nextCursor: z.string().nullable(),
                    })),
                },
            },
        },
        400: errorResponses[400],
        404: errorResponses[404],
    },
});

app.openapi(listRoute, async (c) => {
    const { id } = c.req.valid("param");
    const query = c.req.valid("query");
    const rows = await listOrderBuyerUploads(c.get("db"), id, {
        appId: requestAppId(c),
        afterId: query.cursor ?? null,
        limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const base = trimTrailingCharacter((c.env.PUBLIC_API_BASE_URL ?? new URL(c.req.url).origin).trim(), "/");
    const now = Math.floor(Date.now() / 1000);
    const uploads = await Promise.all(page.map(async (row) => {
        const link = await signBuyerUploadLink(c.env, row.id, now);
        return {
            id: row.id,
            appId: row.appId,
            key: row.fieldKey,
            target: row.target,
            orderItemId: row.orderItemId,
            filename: row.filename,
            mediaType: row.mediaType,
            sizeBytes: row.sizeBytes,
            url: `${base}${link.path}`,
            urlExpiresAt: new Date(link.expiresAt * 1000).toISOString(),
            attachedAt: new Date(row.attachedAt * 1000).toISOString(),
        };
    }));
    return ok(c, { uploads, nextCursor: rows.length > query.limit ? page.at(-1)!.id : null });
});

export { app as adminOrderUploadRoutes };
