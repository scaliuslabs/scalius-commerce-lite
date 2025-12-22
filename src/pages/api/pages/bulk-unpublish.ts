import type { APIRoute } from "astro";
import { db } from "../../../db";
import { pages } from "../../../db/schema";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex } from "@/lib/search/index";

const bulkUnpublishSchema = z.object({
  pageIds: z.array(z.string()).min(1, "At least one page ID is required"),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const { pageIds } = bulkUnpublishSchema.parse(json);

    const updated = await db
      .update(pages)
      .set({
        isPublished: false,
        updatedAt: sql`unixepoch()`,
      })
      .where(inArray(pages.id, pageIds))
      .returning();

    // Trigger reindexing in the background
    triggerReindex().catch((error) => {
      console.error(
        "Background reindexing failed after bulk unpublish:",
        error,
      );
    });

    return new Response(JSON.stringify({ unpublished: updated.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error bulk unpublishing pages:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ message: "Error bulk unpublishing pages" }),
      { status: 500 },
    );
  }
};
