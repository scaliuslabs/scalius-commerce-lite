import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    archivePromotionDraft,
    createMerchantPromotionDraftSchema,
    createPromotionDraft,
    getPromotionAggregate,
    listPromotionDrafts,
    previewPersistedPromotion,
    promotionEvaluationCartSchema,
    updateMerchantPromotionDraftSchema,
    updatePromotionDraft,
} from "@scalius/core/modules/promotions";

import { NotFoundError } from "../../utils/api-error";
import { created, noContent, ok } from "../../utils/api-response";
import { invalidateCatalogCaches } from "../../utils/cache-invalidation";
import {
    conflictResponse,
    errorResponses,
    noContentResponse,
    successEnvelope,
} from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const promotionAggregateResponseSchema = z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    name: z.string(),
    title: z.string().nullable(),
    method: z.enum(["automatic", "code"]),
    status: z.enum(["draft", "active", "paused", "archived"]),
    priority: z.number().int(),
    conflictPolicy: z.literal("best"),
    startsAtEpochSeconds: z.number().int().nullable(),
    endsAtEpochSeconds: z.number().int().nullable(),
    timezone: z.string(),
    createdAtEpochSeconds: z.number().int(),
    updatedAtEpochSeconds: z.number().int(),
    deletedAtEpochSeconds: z.number().int().nullable(),
    codes: z.array(z.object({ code: z.string(), isActive: z.boolean() })),
    conditions: z.array(z.object({
        id: z.string(),
        kind: z.string(),
        config: z.record(z.string(), z.unknown()),
    })),
    effects: z.array(z.object({
        id: z.string(),
        kind: z.string(),
        target: z.string(),
        allocation: z.string(),
        config: z.record(z.string(), z.unknown()),
    })),
});

const promotionMutationResponseSchema = z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    status: z.enum(["draft", "active", "paused", "archived"]),
});

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Promotions"],
    summary: "List revisioned promotion drafts",
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).default(50),
            includeDeleted: z.string().optional(),
        }),
    },
    responses: {
        200: {
            description: "Promotion drafts",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        promotions: z.array(promotionAggregateResponseSchema),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(listRoute, async (c) => {
    const query = c.req.valid("query");
    const promotionRows = await listPromotionDrafts(c.get("db"), {
        limit: query.limit,
        includeDeleted: query.includeDeleted === "true",
    });
    return ok(c, { promotions: promotionRows });
});

const createPromotionRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Promotions"],
    summary: "Create a revisioned code-promotion draft",
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: createMerchantPromotionDraftSchema } },
        },
    },
    responses: {
        201: {
            description: "Promotion draft created",
            content: {
                "application/json": {
                    schema: successEnvelope(promotionMutationResponseSchema),
                },
            },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(createPromotionRoute, async (c) => {
    const result = await createPromotionDraft(c.get("db"), c.req.valid("json"));
    return created(c, result);
});

const getRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Promotions"],
    summary: "Get a revisioned promotion draft",
    request: { params: z.object({ id: z.string().trim().min(1).max(180) }) },
    responses: {
        200: {
            description: "Promotion draft",
            content: {
                "application/json": { schema: successEnvelope(promotionAggregateResponseSchema) },
            },
        },
        ...errorResponses,
    },
});

app.openapi(getRoute, async (c) => {
    const promotion = await getPromotionAggregate(c.get("db"), c.req.valid("param").id);
    if (!promotion) throw new NotFoundError("Promotion not found");
    return ok(c, promotion);
});

const updateRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Promotions"],
    summary: "Replace a promotion draft with revision protection",
    request: {
        params: z.object({ id: z.string().trim().min(1).max(180) }),
        body: {
            required: true,
            content: { "application/json": { schema: updateMerchantPromotionDraftSchema } },
        },
    },
    responses: {
        200: {
            description: "Promotion draft updated",
            content: {
                "application/json": { schema: successEnvelope(promotionMutationResponseSchema) },
            },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(updateRoute, async (c) => {
    const result = await updatePromotionDraft(
        c.get("db"),
        c.req.valid("param").id,
        c.req.valid("json"),
    );
    await invalidateCatalogCaches("discounts", c);
    return ok(c, result);
});

const previewRoute = createRoute({
    method: "post",
    path: "/{id}/preview",
    tags: ["Admin - Promotions"],
    summary: "Preview a saved promotion with the production evaluator",
    request: {
        params: z.object({ id: z.string().trim().min(1).max(180) }),
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        expectedRevision: z.number().int().positive(),
                        cart: promotionEvaluationCartSchema,
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Deterministic promotion evaluation",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        evaluatorVersion: z.number().int().positive(),
                        applied: z.unknown().nullable(),
                        rejected: z.array(z.unknown()),
                        unmatchedCodes: z.array(z.string()),
                        assumedActive: z.boolean(),
                        promotionRevision: z.number().int().positive(),
                    })),
                },
            },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(previewRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await previewPersistedPromotion(c.get("db"), {
        promotionId: c.req.valid("param").id,
        expectedRevision: body.expectedRevision,
        cart: body.cart,
    });
    return ok(c, result);
});

const archiveRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Promotions"],
    summary: "Archive a promotion draft",
    request: {
        params: z.object({ id: z.string().trim().min(1).max(180) }),
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({ expectedRevision: z.number().int().positive() }).strict(),
                },
            },
        },
    },
    responses: {
        204: noContentResponse,
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(archiveRoute, async (c) => {
    await archivePromotionDraft(
        c.get("db"),
        c.req.valid("param").id,
        c.req.valid("json").expectedRevision,
    );
    await invalidateCatalogCaches("discounts", c);
    return noContent(c);
});

export { app as adminPromotionRoutes };
