import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    archivePromotionDraft,
    activatePromotion,
    createPromotionDraft,
    createPromotionDraftSchema,
    getPromotionAggregate,
    getPromotionOrderUsage,
    listPromotionDrafts,
    previewPersistedPromotion,
    pausePromotion,
    updatePromotionDraft,
    updatePromotionDraftSchema,
} from "@scalius/core/modules/promotions";
import { promotionEvaluationCartSchema } from "@scalius/core/modules/promotions/browser";

import { NotFoundError } from "../../utils/api-error";
import { created, noContent, ok } from "../../utils/api-response";
import { bumpCacheGeneration } from "../../utils/cache-generation";
import {
    conflictResponse,
    errorResponses,
    noContentResponse,
    successEnvelope,
} from "../../schemas/responses";

// The one discount engine: code and automatic discounts (promotions tables).
const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Admin - Discounts";
const idParam = z.object({ id: z.string().trim().min(1).max(180) });
const revisionBody = z.object({ expectedRevision: z.number().int().positive() }).strict();

const discountSchema = z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    name: z.string(),
    title: z.string().nullable(),
    method: z.enum(["automatic", "code"]),
    status: z.enum(["draft", "active", "paused", "archived"]),
    priority: z.number().int(),
    conflictPolicy: z.literal("best"),
    combinesWith: z.object({ product: z.boolean(), order: z.boolean(), shipping: z.boolean() }),
    startsAtEpochSeconds: z.number().int().nullable(),
    endsAtEpochSeconds: z.number().int().nullable(),
    timezone: z.string(),
    maxRedemptions: z.number().int().positive().nullable(),
    maxRedemptionsPerCustomer: z.number().int().positive().nullable(),
    maxDiscountSpendMinor: z.number().int().positive().nullable(),
    budgetCurrencyCode: z.string().nullable(),
    redemptionCount: z.number().int().nonnegative().openapi({ description: "Orders that used this discount." }),
    customerRedemptionCount: z.number().int().nonnegative(),
    discountSpendMinor: z.number().int().nonnegative().openapi({ description: "Total savings given, in minor units." }),
    createdAtEpochSeconds: z.number().int(),
    updatedAtEpochSeconds: z.number().int(),
    deletedAtEpochSeconds: z.number().int().nullable(),
    codes: z.array(z.object({ code: z.string(), isActive: z.boolean() })),
    conditions: z.array(z.object({
        id: z.string(),
        kind: z.enum(["minimum_merchandise_subtotal", "minimum_item_quantity"]),
        config: z.record(z.string(), z.unknown()),
    })),
    effects: z.array(z.object({
        id: z.string(),
        kind: z.enum(["percentage_off", "fixed_amount_off", "free"]),
        target: z.enum(["line", "order", "shipping"]),
        allocation: z.enum(["across", "once"]),
        config: z.record(z.string(), z.unknown()),
    })),
});

const mutationSchema = z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    status: z.enum(["draft", "active", "paused", "archived"]),
});
const mutationResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: successEnvelope(mutationSchema) } },
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.list",
    method: "get",
    path: "/",
    tags: [TAG],
    summary: "List code and automatic discounts",
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(90).default(90),
            includeDeleted: z.string().optional(),
        }),
    },
    responses: {
        200: {
            description: "Discounts, most recently updated first",
            content: { "application/json": { schema: successEnvelope(z.object({ discounts: z.array(discountSchema) })) } },
        },
        ...errorResponses,
    },
}), async (c) => {
    const query = c.req.valid("query");
    const discounts = await listPromotionDrafts(c.get("db"), {
        limit: query.limit,
        includeDeleted: query.includeDeleted === "true",
    });
    return ok(c, { discounts });
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.create",
    method: "post",
    path: "/",
    tags: [TAG],
    summary: "Create a draft discount",
    request: { body: { required: true, content: { "application/json": { schema: createPromotionDraftSchema } } } },
    responses: { 201: mutationResponse("Draft discount created"), 409: conflictResponse, ...errorResponses },
}), async (c) => created(c, await createPromotionDraft(c.get("db"), c.req.valid("json"))));

app.openapi(createRoute({
    operationId: "dashboard.discounts.get",
    method: "get",
    path: "/{id}",
    tags: [TAG],
    summary: "Get a discount",
    request: { params: idParam },
    responses: {
        200: { description: "Discount", content: { "application/json": { schema: successEnvelope(discountSchema) } } },
        ...errorResponses,
    },
}), async (c) => {
    const db = c.get("db");
    const discount = await getPromotionAggregate(db, c.req.valid("param").id);
    if (!discount) throw new NotFoundError("Discount not found");
    return ok(c, { ...discount, ...await getPromotionOrderUsage(db, discount.id) });
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.update",
    method: "put",
    path: "/{id}",
    tags: [TAG],
    summary: "Replace a discount's rules (revision-checked)",
    request: {
        params: idParam,
        body: { required: true, content: { "application/json": { schema: updatePromotionDraftSchema } } },
    },
    responses: { 200: mutationResponse("Discount updated"), 409: conflictResponse, ...errorResponses },
}), async (c) => {
    const result = await updatePromotionDraft(c.get("db"), c.req.valid("param").id, c.req.valid("json"));
    await bumpCacheGeneration(c);
    return ok(c, result);
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.preview",
    method: "post",
    path: "/{id}/preview",
    tags: [TAG],
    summary: "Preview a saved discount against a cart",
    request: {
        params: idParam,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        expectedRevision: z.number().int().positive(),
                        customerId: z.string().trim().min(1).max(180).nullable().optional(),
                        cart: promotionEvaluationCartSchema,
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Deterministic evaluation",
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
}), async (c) => {
    const body = c.req.valid("json");
    return ok(c, await previewPersistedPromotion(c.get("db"), {
        promotionId: c.req.valid("param").id,
        expectedRevision: body.expectedRevision,
        customerId: body.customerId ?? null,
        cart: body.cart,
    }));
});

for (const [command, summary, run] of [
    ["activate", "Activate a discount", activatePromotion],
    ["pause", "Deactivate a discount", pausePromotion],
] as const) {
    app.openapi(createRoute({
        operationId: `dashboard.discounts.${command}`,
        method: "post",
        path: `/{id}/${command}`,
        tags: [TAG],
        summary,
        request: { params: idParam, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
        responses: { 200: mutationResponse(summary), 409: conflictResponse, ...errorResponses },
    }), async (c) => {
        const result = await run(c.get("db"), c.req.valid("param").id, c.req.valid("json").expectedRevision);
        await bumpCacheGeneration(c);
        return ok(c, result);
    });
}

app.openapi(createRoute({
    operationId: "dashboard.discounts.archive",
    method: "delete",
    path: "/{id}",
    tags: [TAG],
    summary: "Delete a discount (kept for order history)",
    request: { params: idParam, body: { required: true, content: { "application/json": { schema: revisionBody } } } },
    responses: { 204: noContentResponse, 409: conflictResponse, ...errorResponses },
}), async (c) => {
    await archivePromotionDraft(c.get("db"), c.req.valid("param").id, c.req.valid("json").expectedRevision);
    await bumpCacheGeneration(c);
    return noContent(c);
});

export { app as adminDiscountRoutes };
