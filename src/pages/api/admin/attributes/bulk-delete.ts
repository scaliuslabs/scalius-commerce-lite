// src/pages/api/admin/attributes/bulk-delete.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { productAttributes, productAttributeValues } from "@/db/schema";
import { sql, inArray, count } from "drizzle-orm";
import { z } from "zod";

const bulkDeleteSchema = z.object({
  attributeIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.attributeIds.length === 0) {
      return new Response(JSON.stringify({ error: "No IDs provided" }), { status: 400 });
    }

    if (data.permanent) {
      await db.batch([
        db.delete(productAttributeValues).where(inArray(productAttributeValues.attributeId, data.attributeIds)),
        db.delete(productAttributes).where(inArray(productAttributes.id, data.attributeIds)),
      ]);
    } else {
      // Check if any attributes are in use before soft-deleting
      const usage = await db
        .select({ attributeId: productAttributeValues.attributeId, count: count() })
        .from(productAttributeValues)
        .where(inArray(productAttributeValues.attributeId, data.attributeIds))
        .groupBy(productAttributeValues.attributeId);
      
      if (usage.length > 0) {
        return new Response(JSON.stringify({ error: `Cannot delete. One or more attributes are still in use by products.` }), { status: 409 });
      }

      await db
        .update(productAttributes)
        .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
        .where(inArray(productAttributes.id, data.attributeIds));
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting attributes:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ error: "Invalid data", details: error.errors }), { status: 400 });
    }
    return new Response(JSON.stringify({ error: "Failed to bulk delete attributes" }), { status: 500 });
  }
};