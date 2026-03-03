// src/server/routes/admin/discounts.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { DiscountService, createDiscountSchema, updateDiscountSchema } from "@/modules/discounts";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
    const db = c.get("db");
    const query = c.req.query();

    const result = await DiscountService.list(db, {
        page: parseInt(query.page || "1"),
        limit: parseInt(query.limit || "10"),
        search: query.search || "",
        showTrashed: query.trashed === "true",
        sort: query.sort || "updatedAt",
        order: query.order || "desc",
    });

    return c.json(result);
});

app.post("/", zValidator("json", createDiscountSchema), async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await DiscountService.create(db, data);
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

app.post("/bulk-delete", zValidator("json", z.object({ discountIds: z.array(z.string()), permanent: z.boolean().default(false) })), async (c) => {
    const db = c.get("db");
    const { discountIds, permanent } = c.req.valid("json");
    if (discountIds.length === 0) return c.json({ error: "No discount IDs provided" }, 400);

    await DiscountService.bulkDelete(db, discountIds, permanent);
    return c.body(null, 204);
});

app.post("/bulk-restore", zValidator("json", z.object({ discountIds: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    const { discountIds } = c.req.valid("json");
    if (discountIds.length === 0) return c.json({ error: "No discount IDs provided" }, 400);

    await DiscountService.restore(db, discountIds);
    return c.body(null, 204);
});

app.get("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const discount = await DiscountService.getById(db, id);
    if (!discount) return c.json({ error: "Discount not found" }, 404);
    return c.json(discount);
});

app.put("/:id", zValidator("json", updateDiscountSchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const data = c.req.valid("json");
    try {
        const result = await DiscountService.update(db, id, data);
        return c.json(result);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

app.delete("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    await DiscountService.delete(db, id);
    return c.body(null, 204);
});

app.delete("/:id/permanent", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    await DiscountService.permanentlyDelete(db, id);
    return c.body(null, 204);
});

app.post("/:id/restore", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    await DiscountService.restore(db, [id]);
    return c.json({ success: true });
});

export { app as adminDiscountRoutes };
