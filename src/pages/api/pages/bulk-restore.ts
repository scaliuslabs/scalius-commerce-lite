import type { APIRoute } from "astro";
import { db } from "../../../db";
import { pages } from "../../../db/schema";
import { inArray } from "drizzle-orm";
import { z } from "zod";

const bulkRestoreSchema = z.object({
  pageIds: z.array(z.string()).min(1, "At least one page ID is required"),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const { pageIds } = bulkRestoreSchema.parse(json);

    const updated = await db
      .update(pages)
      .set({ deletedAt: null })
      .where(inArray(pages.id, pageIds))
      .returning();

    // Trigger reindexing in the background

    return new Response(JSON.stringify({ restored: updated.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error bulk restoring pages:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ message: "Error bulk restoring pages" }),
      { status: 500 },
    );
  }
};
