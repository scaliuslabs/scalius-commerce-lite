import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import {
    createHeroSlider,
    deleteHeroSlider,
    getHeroSlider,
    listHeroSliders,
    updateHeroSlider,
} from "@scalius/core/modules/hero-sliders";
import { HERO_SLIDE_LIMIT, HERO_SLIDE_TITLE_LIMIT } from "@scalius/shared/hero-slider";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, errorResponses, conflictResponse } from "../../../schemas/responses";
import { nullableTimestampSchema } from "../../../schemas/timestamps";
import {
    getOptionalExecutionContext,
    invalidateGroups,
    triggerStorefrontPurgeForGroups,
    type WaitUntilExecutionContext,
} from "../../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const HOMEPAGE_CACHE_GROUPS = ["homepage"] as const;
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;

async function invalidateHomepageCaches(c: { env: Env; executionCtx?: WaitUntilExecutionContext }): Promise<void> {
    await invalidateGroups([...HOMEPAGE_CACHE_GROUPS], c.env?.CACHE);
    triggerStorefrontPurgeForGroups([...HOMEPAGE_CACHE_GROUPS], c.env, getOptionalExecutionContext(c));
}

const sliderImageSchema = z.object({
    id: z.string().min(1).max(80),
    url: z.string().url().max(2_048),
    title: z.string().min(1).max(HERO_SLIDE_TITLE_LIMIT),
    link: z.string().max(2_048),
    focalPoint: z.object({
        x: z.number().min(0).max(100),
        y: z.number().min(0).max(100),
    }).optional(),
});

const normalizedSliderImageSchema = sliderImageSchema.extend({
    focalPoint: z.object({
        x: z.number().min(0).max(100),
        y: z.number().min(0).max(100),
    }),
});

const createHeroSliderSchema = z.object({
    type: z.enum(["desktop", "mobile"]),
    images: z.array(sliderImageSchema).max(HERO_SLIDE_LIMIT),
    isActive: z.boolean().optional()
});

const updateHeroSliderSchema = z.object({
    expectedRevision: z.number().int().min(1),
    images: z.array(sliderImageSchema).max(HERO_SLIDE_LIMIT).optional(),
    isActive: z.boolean().optional()
});

// ── List Sliders ──

const heroSliderSchema = z.object({
    id: z.string(),
    type: z.enum(["desktop", "mobile"]),
    images: z.array(normalizedSliderImageSchema),
    isActive: z.boolean(),
    revision: z.number().int().min(1),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
    deletedAt: nullableTimestampSchema,
}).passthrough();

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Hero Sliders"],
    summary: "List all hero sliders",
    responses: {
        200: { description: "Slider list", content: { "application/json": { schema: successEnvelope(z.array(heroSliderSchema)) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, (async (c) => {
    const db = c.get("db");
    return ok(c, await listHeroSliders(db));
}) as AppRouteHandler<typeof listRoute>);

// ── Create Slider ──

const createSliderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Hero Sliders"],
    summary: "Create a hero slider",
    request: { body: { content: { "application/json": { schema: createHeroSliderSchema } } } },
    responses: {
        201: { description: "Slider created", content: { "application/json": { schema: successEnvelope(heroSliderSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(createSliderRoute, (async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const slider = await createHeroSlider(db, data);
    await invalidateHomepageCaches(c);
    return created(c, slider);
}) as AppRouteHandler<typeof createSliderRoute>);

// ── Get Slider ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Hero Sliders"],
    summary: "Get a hero slider by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Slider details", content: { "application/json": { schema: successEnvelope(heroSliderSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, (async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    return ok(c, await getHeroSlider(db, id));
}) as AppRouteHandler<typeof getByIdRoute>);

// ── Update Slider ──

const updateSliderRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Hero Sliders"],
    summary: "Update a hero slider",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateHeroSliderSchema } } }
    },
    responses: {
        200: { description: "Slider updated", content: { "application/json": { schema: successEnvelope(heroSliderSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(updateSliderRoute, (async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const slider = await updateHeroSlider(db, id, data);
    await invalidateHomepageCaches(c);
    return ok(c, slider);
}) as AppRouteHandler<typeof updateSliderRoute>);

// ── Delete Slider ──

const deleteSliderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Hero Sliders"],
    summary: "Soft-delete a hero slider",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({ expectedRevision: z.number().int().min(1) }),
                },
            },
        },
    },
    responses: {
        200: { description: "Slider deleted", content: { "application/json": { schema: successEnvelope(heroSliderSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(deleteSliderRoute, (async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedRevision } = c.req.valid("json");
    const slider = await deleteHeroSlider(db, id, expectedRevision);
    await invalidateHomepageCaches(c);
    return ok(c, slider);
}) as AppRouteHandler<typeof deleteSliderRoute>);

export { app as heroSlidersRoutes };
