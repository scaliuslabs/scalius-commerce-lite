import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets } from "@/db/schema";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";

const bulkDeleteSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one widget ID is required"),
  permanent: z.boolean().optional().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const { ids, permanent } = bulkDeleteSchema.parse(json);

    if (permanent) {
      // Permanent delete - actually remove from database
      await db.delete(widgets).where(inArray(widgets.id, ids));
    } else {
      // Soft delete - set deletedAt timestamp
      await db
        .update(widgets)
        .set({
          deletedAt: sql`(cast(strftime('%s','now') as int))`,
        })
        .where(inArray(widgets.id, ids));
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: permanent
          ? `${ids.length} widget(s) permanently deleted.`
          : `${ids.length} widget(s) moved to trash.`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error bulk deleting widgets:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ message: "Error bulk deleting widgets" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

