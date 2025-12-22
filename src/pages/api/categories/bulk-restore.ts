import type { APIRoute } from "astro";
import { db } from "../../../db";
import { categories } from "../../../db/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex } from "@/lib/search/index";

const bulkRestoreSchema = z.object({
  categoryIds: z.array(z.string()),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkRestoreSchema.parse(json);

    if (data.categoryIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No category IDs provided",
        }),
        { status: 400 },
      );
    }

    // Restore categories (set deletedAt to null)
    await db
      .update(categories)
      .set({
        deletedAt: null,
      })
      .where(sql`${categories.id} IN ${data.categoryIds}`);

    // Trigger reindexing to add the restored categories back to the search index
    // We need a full reindex here since we're adding items back
    triggerReindex().catch((error) => {
      console.error(
        "Background reindexing failed after bulk category restoration:",
        error,
      );
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error restoring categories:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid request data",
          details: error.errors,
        }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
