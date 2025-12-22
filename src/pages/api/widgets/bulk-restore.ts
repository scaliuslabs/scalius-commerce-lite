import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets } from "@/db/schema";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";

const bulkRestoreSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one widget ID is required"),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const { ids } = bulkRestoreSchema.parse(json);

    await db
      .update(widgets)
      .set({
        deletedAt: null,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(inArray(widgets.id, ids));

    return new Response(
      JSON.stringify({
        success: true,
        message: `${ids.length} widget(s) restored successfully.`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error bulk restoring widgets:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ message: "Error bulk restoring widgets" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

