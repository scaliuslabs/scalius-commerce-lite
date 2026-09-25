// Admin: rebuild the catalogue projections (product_buyer_state and
// product_facet_values) from their sources. Every product, SKU and stock
// write keeps them current in its own batch; this heals drift and fills
// them the first time (a release that adds them runs it once before the
// readers depend on them). The nightly cron queues the same rebuild.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    CATALOG_PROJECTION_REBUILD_DEFAULT_LIMIT,
    CATALOG_PROJECTION_REBUILD_MAX_LIMIT,
    rebuildCatalogProjections,
} from "@scalius/core/modules/products";

import { ok } from "../../utils/api-response";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { bumpCacheGeneration } from "../../utils/cache-generation";

const app = new OpenAPIHono<{ Bindings: Env }>();

const rebuildRoute = createRoute({
    method: "post",
    path: "/projections/rebuild",
    operationId: "dashboard.catalog_projections.rebuild",
    tags: ["Admin - Catalog"],
    summary: "Rebuild the catalogue listing projections",
    description:
        "Recomputes the stored buyer state and facet rows of the next `limit` products after `afterProductId` "
        + "(product id order). Call again with the returned cursor until `done`; the public cache generation "
        + "is bumped once the last product is covered. Stock and checkout are unaffected.",
    request: {
        body: {
            required: false,
            content: {
                "application/json": {
                    schema: z.object({
                        afterProductId: z.string().trim().min(1).max(180).nullable().optional()
                            .openapi({ description: "Cursor from the previous call; omit or null to start." }),
                        limit: z.number().int().min(1).max(CATALOG_PROJECTION_REBUILD_MAX_LIMIT).optional()
                            .openapi({ description: `Products this call recomputes (default ${CATALOG_PROJECTION_REBUILD_DEFAULT_LIMIT}).` }),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "One rebuild chunk committed",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        processed: z.number().int().nonnegative(),
                        nextAfterProductId: z.string().nullable(),
                        done: z.boolean(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(rebuildRoute, async (c) => {
    const body = c.req.valid("json") ?? {};
    const result = await rebuildCatalogProjections(c.get("db"), {
        afterProductId: body.afterProductId ?? null,
        limit: body.limit,
    });
    // Rebuilt rows are buyer-visible (listings, counts, sitemaps).
    if (result.done) await bumpCacheGeneration(c);
    return ok(c, result);
});

export { app as adminCatalogProjectionRoutes };
