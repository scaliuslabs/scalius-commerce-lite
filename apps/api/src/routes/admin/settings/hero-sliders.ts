import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { heroSliders } from "@scalius/database/schema";
import { nanoid } from "nanoid";
import { sql, and, eq, isNull } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "../../../utils/api-error";

import { ok, created } from "../../../utils/api-response";
const app = new OpenAPIHono();

const sliderImageSchema = z.object({
    id: z.string(),
    url: z.string().url(),
    title: z.string(),
    link: z.string()
});

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

// ── List Sliders ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Hero Sliders"],
    summary: "List all hero sliders",
    responses: { 200: { description: "Slider list"  } }
});

app.openapi(listRoute, async (c) => {
    try {
        const db = c.get("db");
        const data = await db.select().from(heroSliders).where(isNull(heroSliders.deletedAt));
        const parsedData = data.map((slider) => ({ ...slider, images: JSON.parse(slider.images) }));
        return ok(c, parsedData);
    } catch (error: unknown) {
        throw error;
    }
});

// ── Create Slider ──

const createSliderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Hero Sliders"],
    summary: "Create a hero slider",
    request: { body: { content: { "application/json": { schema: createHeroSliderSchema } } } },
    responses: { 201: { description: "Slider created"  } }
});

app.openapi(createSliderRoute, async (c) => {
    try {
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
            createdAt: sql`CURRENT_TIMESTAMP`,
            updatedAt: sql`CURRENT_TIMESTAMP`
        }).returning();
        const slider = sliderArr[0];
        if (!slider) throw new Error("Failed to create slider");

        return created(c, { ...slider, images: JSON.parse(slider.images) });
    } catch (error: unknown) {
        throw error;
    }
});

// ── Get Slider ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Hero Sliders"],
    summary: "Get a hero slider by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: { 200: { description: "Slider details"  } }
});

app.openapi(getByIdRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        const slider = await db.select().from(heroSliders).where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt))).get();

        if (!slider) throw new NotFoundError("Slider not found");
        return ok(c, { ...slider, images: JSON.parse(slider.images) });
    } catch (error: unknown) {
        throw error;
    }
});

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
    responses: { 200: { description: "Slider updated"  } }
});

app.openapi(updateSliderRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        const data = c.req.valid("json");

        const updateData = {
            ...data,
            images: data.images ? JSON.stringify(data.images) : undefined,
            updatedAt: sql`CURRENT_TIMESTAMP`
        };

        const [slider] = await db.update(heroSliders)
            .set(updateData)
            .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
            .returning();

        if (!slider) throw new NotFoundError("Slider not found");
        return ok(c, { ...slider, images: JSON.parse(slider.images) });
    } catch (error: unknown) {
        throw error;
    }
});

// ── Delete Slider ──

const deleteSliderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Hero Sliders"],
    summary: "Soft-delete a hero slider",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: { 200: { description: "Slider deleted"  } }
});

app.openapi(deleteSliderRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        const [slider] = await db.update(heroSliders)
            .set({ deletedAt: sql`CURRENT_TIMESTAMP` })
            .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
            .returning();

        if (!slider) throw new NotFoundError("Slider not found");
        return ok(c, { ...slider, images: JSON.parse(slider.images) });
    } catch (error: unknown) {
        throw error;
    }
});

export { app as heroSlidersRoutes };
