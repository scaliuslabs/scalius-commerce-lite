import type { APIRoute } from "astro";
import { db } from "../../../db";
import { pages } from "../../../db/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex, deleteFromIndex } from "@/lib/search/index";

const bulkDeleteSchema = z.object({
  pageIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.pageIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No page IDs provided",
        }),
        { status: 400 },
      );
    }

    if (data.permanent) {
      // Permanently delete pages
      await db.delete(pages).where(sql`${pages.id} IN ${data.pageIds}`);
    } else {
      // Soft delete pages
      await db
        .update(pages)
        .set({
          deletedAt: sql`unixepoch()`,
        })
        .where(sql`${pages.id} IN ${data.pageIds}`);
    }

    // Delete from search index directly instead of full reindexing
    // This is more efficient for bulk deletions
    deleteFromIndex({ pageIds: data.pageIds }).catch((error) => {
      console.error("Error deleting pages from search index:", error);
      // Fall back to full reindexing if direct deletion fails
      triggerReindex().catch((reindexError) => {
        console.error(
          "Background reindexing failed after bulk page deletion:",
          reindexError,
        );
      });
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting pages:", error);

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
