// src/pages/api/admin/attributes/bulk-restore.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { productAttributes } from "@/db/schema";
import { sql, inArray } from "drizzle-orm";
import { z } from "zod";

const bulkRestoreSchema = z.object({
  attributeIds: z.array(z.string()),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkRestoreSchema.parse(json);

    if (data.attributeIds.length === 0) {
      return new Response(JSON.stringify({ error: "No IDs provided" }), { status: 400 });
    }

    await db
      .update(productAttributes)
      .set({
        deletedAt: null,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(inArray(productAttributes.id, data.attributeIds));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk restoring attributes:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ error: "Invalid data", details: error.errors }), { status: 400 });
    }
    return new Response(JSON.stringify({ error: "Failed to bulk restore attributes" }), { status: 500 });
  }
};