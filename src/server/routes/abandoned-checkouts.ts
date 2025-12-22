// src/server/routes/abandoned-checkouts.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { abandonedCheckouts } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { authMiddleware } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// Schema for the public POST endpoint to save data
const abandonedCheckoutSchema = z.object({
  checkoutId: z.string().min(1, "checkoutId is required"),
  customerPhone: z.string().optional(),
  checkoutData: z.record(z.any()),
});

// Schema for the new cleanup endpoint
const cleanupSchema = z.object({
  checkoutId: z.string().min(1, "checkoutId is required for cleanup"),
});

// POST endpoint to CREATE or UPDATE an abandoned checkout (This remains public)
app.post("/", zValidator("json", abandonedCheckoutSchema), async (c) => {
  try {
    const db = c.get("db");
    const { checkoutId, customerPhone, checkoutData } = c.req.valid("json");
    const checkoutDataString = JSON.stringify(checkoutData);

    const existingCheckout = await db
      .select({ id: abandonedCheckouts.id })
      .from(abandonedCheckouts)
      .where(eq(abandonedCheckouts.checkoutId, checkoutId))
      .get();

    if (existingCheckout) {
      await db
        .update(abandonedCheckouts)
        .set({
          customerPhone: customerPhone,
          checkoutData: checkoutDataString,
          updatedAt: sql`(cast(strftime('%s','now') as int))`,
        })
        .where(eq(abandonedCheckouts.id, existingCheckout.id));
    } else {
      await db.insert(abandonedCheckouts).values({
        id: `ab_ch_${nanoid()}`,
        checkoutId: checkoutId,
        customerPhone: customerPhone,
        checkoutData: checkoutDataString,
        createdAt: sql`(cast(strftime('%s','now') as int))`,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      });
    }

    return c.json({ success: true, message: "Abandoned checkout saved." });
  } catch (error) {
    console.error("Error saving abandoned checkout:", error);
    return c.json(
      { success: false, error: "Failed to save abandoned checkout." },
      500,
    );
  }
});

// CHANGE: New, simple POST endpoint specifically for deleting a record after a successful order.
app.post(
  "/cleanup",
  authMiddleware, // This action is protected and requires authentication
  zValidator("json", cleanupSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const { checkoutId } = c.req.valid("json");

      await db
        .delete(abandonedCheckouts)
        .where(eq(abandonedCheckouts.checkoutId, checkoutId));

      return c.json({
        success: true,
        message: `Abandoned checkout record ${checkoutId} deleted.`,
      });
    } catch (error) {
      console.error("Error cleaning up abandoned checkout:", error);
      return c.json(
        { success: false, error: "Failed to clean up abandoned checkout." },
        500,
      );
    }
  },
);

export { app as abandonedCheckoutsRoutes };
