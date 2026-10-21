import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    archivePromotionDraft,
    activatePromotion,
    createPromotionDraft,
    getPromotionAggregate,
    getPromotionOrderUsage,
    listPromotionPage,
    PROMOTION_LIST_SORTS,
    PROMOTION_LIST_VIEWS,
    previewPersistedPromotion,
    pausePromotion,
    updatePromotionDraft,
} from "@scalius/core/modules/promotions";
import { promotionEvaluationCartSchema } from "@scalius/core/modules/promotions/browser";

import { readStoreCurrency } from "@scalius/core/modules/markets";
import { NotFoundError } from "../../utils/api-error";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../schemas/timestamps";
import { created, ok } from "../../utils/api-response";
import type { Database } from "@scalius/database/client";
import { createDiscountBody, serviceRule, serviceUpdate, updateDiscountBody, wireRule, withWireRefusals } from "./discount-wire";

import {
    cappedPaginationSchema,
    conflictResponse,
    errorResponses,
    successEnvelope,
} from "../../schemas/responses";

// The one discount engine: code and automatic discounts (promotions tables).
const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Admin - Discounts";
const idParam = z.object({ id: z.string().trim().min(1).max(180) });
const expectedRevisionField = z.number().int().positive().openapi({
    description: "The discount's `revision` you read; a discount changed since is refused with 409 and nothing changes.",
});
const revisionBody = z.object({ expectedRevision: expectedRevisionField }).strict();

const discountShape = {
    id: z.string(),
    revision: z.number().int().positive(),
    name: z.string(),
    title: z.string().nullable(),
    method: z.enum(["automatic", "code"]),
    status: z.enum(["draft", "active", "paused", "archived"]),
    priority: z.number().int(),
    conflictPolicy: z.literal("best"),
    combinesWith: z.object({ product: z.boolean(), order: z.boolean(), shipping: z.boolean() }),
    startsAt: nullableIsoTimestampSchema,
    endsAt: nullableIsoTimestampSchema,
    timeZone: z.string().openapi({ description: "The schedule's IANA time zone." }),
    maxRedemptions: z.number().int().positive().nullable(),
    maxRedemptionsPerCustomer: z.number().int().positive().nullable(),
    /** The store currency: rule amounts and the spend are in its minor units. */
    currency: z.string().length(3).openapi({ description: "The store currency: rule amounts (amountMinor) and the spend are integer minor units of it." }),
    maxDiscountSpendMinor: z.number().int().positive().nullable(),
    budgetCurrency: z.string().nullable().openapi({ description: "The spend budget's currency, with maxDiscountSpendMinor." }),
    redemptionCount: z.number().int().nonnegative().openapi({ description: "Orders that used this discount." }),
    customerRedemptionCount: z.number().int().nonnegative(),
    discountSpendMinor: z.number().int().nonnegative().openapi({ description: "Total savings given, in minor units." }),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    deletedAt: nullableIsoTimestampSchema,
    codes: z.array(z.object({ code: z.string(), isActive: z.boolean() })),
    conditions: z.array(z.object({
        id: z.string(),
        kind: z.enum(["minimum_merchandise_subtotal", "minimum_item_quantity"]),
        config: z.record(z.string(), z.unknown()).openapi({ description: "As `discounts.create` takes it: an amount beside its `currency`." }),
    })),
    effects: z.array(z.object({
        id: z.string(),
        kind: z.enum(["percentage_off", "fixed_amount_off", "free"]),
        target: z.enum(["line", "order", "shipping"]),
        allocation: z.enum(["across", "once"]),
        config: z.record(z.string(), z.unknown()).openapi({ description: "As `discounts.create` takes it: an amount beside its `currency`." }),
    })),
    customerSegmentIds: z.array(z.string()).openapi({
        description: "Only signed-in customers in any of these customer segments get this discount; empty means every customer.",
    }),
};

/** A discount as `discounts.get` reads it; every discount write answers it too (`{ discount }`). */
const DiscountResource = z.object(discountShape).openapi("DiscountResource");
const discountEnvelope = successEnvelope(z.object({ discount: DiscountResource }));

type StoredDiscount = Awaited<ReturnType<typeof getPromotionAggregate>> & object;
const isoOf = (seconds: number | null | undefined) => (typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : null);

/** A stored discount as the HTTP contract carries it: every instant ISO 8601, one spelling per field (discount-wire.ts). */
function discountWire<T extends Pick<StoredDiscount, "startsAtEpochSeconds" | "endsAtEpochSeconds" | "createdAtEpochSeconds" | "updatedAtEpochSeconds" | "deletedAtEpochSeconds" | "timezone" | "budgetCurrencyCode" | "conditions" | "effects">>(discount: T) {
    const { startsAtEpochSeconds, endsAtEpochSeconds, createdAtEpochSeconds, updatedAtEpochSeconds, deletedAtEpochSeconds, ...rest } = discount;
    return {
        ...wireRule(rest),
        startsAt: isoOf(startsAtEpochSeconds),
        endsAt: isoOf(endsAtEpochSeconds),
        createdAt: isoOf(createdAtEpochSeconds)!,
        updatedAt: isoOf(updatedAtEpochSeconds)!,
        deletedAt: isoOf(deletedAtEpochSeconds),
    };
}

/** The discount as it is now, with its usage; an archived one too. */
async function readDiscount(db: Database, id: string) {
    const discount = await getPromotionAggregate(db, id, { includeDeleted: true });
    if (!discount) throw new NotFoundError("Discount not found");
    const [usage, currency] = await Promise.all([getPromotionOrderUsage(db, discount.id), readStoreCurrency(db)]);
    return { ...discountWire(discount), currency: currency.code, ...usage };
}

const mutationResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: discountEnvelope } },
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.list",
    method: "get",
    path: "/",
    tags: [TAG],
    summary: "List code and automatic discounts",
    description: "One page of discounts, searched (name, title, or a code from its start), filtered by view and sorted on the server. Each row carries its first code only, with `codeCount` for the rest.",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number; reaches the first 1,000 rows (10,000 on a Paid deployment)." }),
            limit: z.coerce.number().int().min(1).max(90).default(50),
            search: z.string().trim().max(120).optional().openapi({ description: "Matches the name or title anywhere, or a code from its start." }),
            view: z.enum(PROMOTION_LIST_VIEWS).optional().openapi({ description: "active: on and started; scheduled: on, starts later; expired: its end has passed." }),
            sort: z.enum(PROMOTION_LIST_SORTS).optional().default("updated"),
            includeDeleted: z.string().optional(),
        }),
    },
    responses: {
        200: {
            description: "Discounts, most recently updated first unless sorted",
            content: { "application/json": { schema: successEnvelope(z.object({
                discounts: z.array(z.object(discountShape).extend({
                    codeCount: z.number().int().nonnegative().openapi({ description: "Codes the discount has; `codes` holds the first only." }),
                })),
                pagination: cappedPaginationSchema,
            })) } },
        },
        ...errorResponses,
    },
}), async (c) => {
    const query = c.req.valid("query");
    const db = c.get("db");
    const [result, currency] = await Promise.all([listPromotionPage(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || undefined,
        view: query.view,
        sort: query.sort,
        includeDeleted: query.includeDeleted === "true",
    }), readStoreCurrency(db)]);
    return ok(c, { ...result, discounts: result.discounts.map((discount) => ({ ...discountWire(discount), currency: currency.code })) });
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.create",
    method: "post",
    path: "/",
    tags: [TAG],
    summary: "Create a draft discount",
    request: { body: { required: true, content: { "application/json": { schema: createDiscountBody } } } },
    responses: { 201: mutationResponse("The new draft discount"), 409: conflictResponse, ...errorResponses },
}), async (c) => {
    const db = c.get("db");
    const { id } = await withWireRefusals(() => createPromotionDraft(db, serviceRule(c.req.valid("json"))));
    return created(c, { discount: await readDiscount(db, id) });
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.get",
    method: "get",
    path: "/{id}",
    tags: [TAG],
    summary: "Get a discount",
    request: { params: idParam },
    responses: {
        200: { description: "The discount", content: { "application/json": { schema: discountEnvelope } } },
        ...errorResponses,
    },
}), async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    if (!(await getPromotionAggregate(db, id))) throw new NotFoundError("Discount not found");
    return ok(c, { discount: await readDiscount(db, id) });
});

app.openapi(createRoute({
    operationId: "dashboard.discounts.update",
    method: "put",
    path: "/{id}",
    tags: [TAG],
    summary: "Replace a discount's rules (revision-checked)",
    request: {
        params: idParam,
        body: { required: true, content: { "application/json": { schema: updateDiscountBody } } },
    },
    responses: { 200: mutationResponse("The discount as updated"), 409: conflictResponse, ...errorResponses },
}), async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await withWireRefusals(() => updatePromotionDraft(db, id, serviceUpdate(c.req.valid("json"))));
    return ok(c, { discount: await readDiscount(db, id) });
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
                        expectedRevision: expectedRevisionField,
                        customerId: z.string().trim().min(1).max(180).nullable().optional().openapi({
                            description: "Preview as this customer, signed in: their usage and customer segments. Without one, a discount limited to segments does not apply.",
                        }),
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
        const db = c.get("db");
        const { id } = c.req.valid("param");
        await run(db, id, c.req.valid("json").expectedRevision);
        return ok(c, { discount: await readDiscount(db, id) });
    });
}

app.openapi(createRoute({
    operationId: "dashboard.discounts.archive",
    method: "delete",
    path: "/{id}",
    tags: [TAG],
    summary: "Archive a discount (kept for order history)",
    description: "The discount stops applying and leaves the list; orders that used it keep it. Answers the archived discount.",
    request: {
        params: idParam,
        query: z.object({ expectedRevision: z.coerce.number().int().positive().openapi({ description: "The discount's `revision` you read; a discount changed since is refused with 409 and nothing changes." }) }),
    },
    responses: { 200: mutationResponse("The archived discount"), 409: conflictResponse, ...errorResponses },
}), async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await archivePromotionDraft(db, id, c.req.valid("query").expectedRevision);
    return ok(c, { discount: await readDiscount(db, id) });
});

export { app as adminDiscountRoutes };
