import { Hono } from "hono";
import { db } from "@/db";
import { heroSliders } from "@/db/schema";
import { nanoid } from "nanoid";
import { sql, and, eq, isNull } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const app = new Hono<{ Bindings: any, Variables: any }>();

const sliderImageSchema = z.object({
    id: z.string(),
    url: z.url(),
    title: z.string(),
    link: z.string(),
});

const createHeroSliderSchema = z.object({
    type: z.enum(["desktop", "mobile"]),
    images: z.array(sliderImageSchema),
    isActive: z.boolean().optional(),
});

const updateHeroSliderSchema = z.object({
    type: z.enum(["desktop", "mobile"]).optional(),
    images: z.array(sliderImageSchema).optional(),
    isActive: z.boolean().optional(),
});

// GET all sliders
app.get("/", async (c) => {
    try {
        const data = await db.select().from(heroSliders).where(isNull(heroSliders.deletedAt));
        const parsedData = data.map((slider) => ({ ...slider, images: JSON.parse(slider.images) }));
        return c.json({ success: true, data: parsedData });
    } catch (error) {
        return c.json({ success: false, error: "Internal Server Error" }, 500);
    }
});

// POST create a slider
app.post("/", zValidator("json", createHeroSliderSchema), async (c) => {
    try {
        const data = c.req.valid("json");
        const existingSlider = await db.select().from(heroSliders).where(sql`type = ${data.type} AND deleted_at IS NULL`).get();

        if (existingSlider) {
            return c.json({ success: false, error: `A ${data.type} slider already exists` }, 400);
        }

        const sliderId = "slider_" + nanoid();
        const [slider] = await db.insert(heroSliders).values({
            id: sliderId,
            type: data.type,
            images: JSON.stringify(data.images),
            isActive: data.isActive ?? true,
            createdAt: sql`CURRENT_TIMESTAMP`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
        }).returning();

        return c.json({ success: true, data: { ...slider, images: JSON.parse(slider.images) } }, 201);
    } catch (error) {
        return c.json({ success: false, error: "Internal Server Error" }, 500);
    }
});

// GET a single slider
app.get("/:id", async (c) => {
    try {
        const id = c.req.param("id");
        const slider = await db.select().from(heroSliders).where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt))).get();

        if (!slider) return c.json({ success: false, error: "Slider not found" }, 404);
        return c.json({ success: true, data: { ...slider, images: JSON.parse(slider.images) } });
    } catch (error) {
        return c.json({ success: false, error: "Internal Server Error" }, 500);
    }
});

// PUT update a slider
app.put("/:id", zValidator("json", updateHeroSliderSchema), async (c) => {
    try {
        const id = c.req.param("id");
        const data = c.req.valid("json");

        const updateData = {
            ...data,
            images: data.images ? JSON.stringify(data.images) : undefined,
            updatedAt: sql`CURRENT_TIMESTAMP`,
        };

        const [slider] = await db.update(heroSliders)
            .set(updateData)
            .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
            .returning();

        if (!slider) return c.json({ success: false, error: "Slider not found" }, 404);
        return c.json({ success: true, data: { ...slider, images: JSON.parse(slider.images) } });
    } catch (error) {
        return c.json({ success: false, error: "Internal Server Error" }, 500);
    }
});

// DELETE a slider
app.delete("/:id", async (c) => {
    try {
        const id = c.req.param("id");
        const [slider] = await db.update(heroSliders)
            .set({ deletedAt: sql`CURRENT_TIMESTAMP` })
            .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
            .returning();

        if (!slider) return c.json({ success: false, error: "Slider not found" }, 404);
        return c.json({ success: true, data: { ...slider, images: JSON.parse(slider.images) } });
    } catch (error) {
        return c.json({ success: false, error: "Internal Server Error" }, 500);
    }
});

export { app as heroSlidersRoutes };
