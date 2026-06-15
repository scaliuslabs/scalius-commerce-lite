import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { heroSliders } from "@scalius/database/schema";
import { nanoid } from "nanoid";
import { sql, and, eq, isNull } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "../../../utils/api-error";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";
import { nullableTimestampSchema } from "../../../schemas/timestamps";
import {
    getOptionalExecutionContext,
    invalidateGroups,
    triggerStorefrontPurgeForGroups,
} from "../../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const HOMEPAGE_CACHE_GROUPS = ["homepage"] as const;
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;

async function invalidateHomepageCaches(c: { env: Env; executionCtx?: ExecutionContext }): Promise<void> {
    await invalidateGroups([...HOMEPAGE_CACHE_GROUPS], c.env?.CACHE);
    triggerStorefrontPurgeForGroups([...HOMEPAGE_CACHE_GROUPS], c.env, getOptionalExecutionContext(c));
}

const sliderImageSchema = z.object({
    id: z.string(),
    url: z.string().url(),
    title: z.string(),
    link: z.string()
});
type SliderImage = z.infer<typeof sliderImageSchema>;

const createHeroSliderSchema = z.object({
    type: z.enum(["desktop", "mobile"]),
    images: z.array(sliderImageSchema),
    isActive: z.boolean().optional()
});

const updateHeroSliderSchema = z.object({
    type: z.enum(["desktop", "mobile"]).optional(),
    images: z.array(sliderImageSchema).optional(),
    isActive: z.boolean().optional()
});

const parseSliderImages = (images: string): SliderImage[] => {
    try {
        return JSON.parse(images) as SliderImage[];
    } catch {
        return [];
    }
};

// ── List Sliders ──

const heroSliderSchema = z.object({
    id: z.string(),
    type: z.enum(["desktop", "mobile"]),
    images: z.array(sliderImageSchema),
    isActive: z.boolean(),
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
    const data = await db.select().from(heroSliders).where(isNull(heroSliders.deletedAt));
    const parsedData = data.map((slider: typeof heroSliders.$inferSelect) => ({ ...slider, images: parseSliderImages(slider.images) }));
    return ok(c, parsedData);
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
    }
});

app.openapi(createSliderRoute, (async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const existingSlider = await db.select().from(heroSliders).where(sql`type = ${data.type} AND deleted_at IS NULL`).get();

    if (existingSlider) {
        throw new ConflictError(`A ${data.type} slider already exists`);
    }

    const sliderId = "slider_" + nanoid();
    const sliderArr = await db.insert(heroSliders).values({
        id: sliderId,
        type: data.type,
        images: JSON.stringify(data.images),
        isActive: data.isActive ?? true,
        createdAt: sql`(unixepoch())`,
        updatedAt: sql`(unixepoch())`
    }).returning();
    const slider = sliderArr[0];
    if (!slider) throw new ValidationError("Failed to create slider");

    await invalidateHomepageCaches(c);
    return created(c, { ...slider, images: parseSliderImages(slider.images) });
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
    const slider = await db.select().from(heroSliders).where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt))).get();

    if (!slider) throw new NotFoundError("Slider not found");
    return ok(c, { ...slider, images: parseSliderImages(slider.images) });
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
    }
});

app.openapi(updateSliderRoute, (async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");

    const updateData = {
        ...data,
        images: data.images ? JSON.stringify(data.images) : undefined,
        updatedAt: sql`(unixepoch())`
    };

    const [slider] = await db.update(heroSliders)
        .set(updateData)
        .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
        .returning();

    if (!slider) throw new NotFoundError("Slider not found");
    await invalidateHomepageCaches(c);
    return ok(c, { ...slider, images: parseSliderImages(slider.images) });
}) as AppRouteHandler<typeof updateSliderRoute>);

// ── Delete Slider ──

const deleteSliderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Hero Sliders"],
    summary: "Soft-delete a hero slider",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Slider deleted", content: { "application/json": { schema: successEnvelope(heroSliderSchema) } } },
        ...errorResponses,
    }
});

app.openapi(deleteSliderRoute, (async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const [slider] = await db.update(heroSliders)
        .set({ deletedAt: sql`(unixepoch())` })
        .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
        .returning();

    if (!slider) throw new NotFoundError("Slider not found");
    await invalidateHomepageCaches(c);
    return ok(c, { ...slider, images: parseSliderImages(slider.images) });
}) as AppRouteHandler<typeof deleteSliderRoute>);

export { app as heroSlidersRoutes };
