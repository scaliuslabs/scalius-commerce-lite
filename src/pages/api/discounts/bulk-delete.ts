import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  discounts,
  discountProducts,
  discountCollections,
} from "../../../db/schema";
import { sql, inArray } from "drizzle-orm";
import { z } from "zod";
// import { triggerReindex, deleteFromIndex } from "@/lib/search/index"; // Uncomment if discounts are indexed

const bulkDeleteSchema = z.object({
  discountIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.discountIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "No discount IDs provided" }),
        { status: 400 },
      );
    }

    if (data.permanent) {
      // Permanently delete discounts and their associations
      await db.transaction(async (tx) => {
        await tx
          .delete(discountProducts)
          .where(inArray(discountProducts.discountId, data.discountIds));
        await tx
          .delete(discountCollections)
          .where(inArray(discountCollections.discountId, data.discountIds));
        // Add deletion for discountUsage table if it exists and needs cascading
        // await tx.delete(discountUsage).where(inArray(discountUsage.discountId, data.discountIds));
        await tx
          .delete(discounts)
          .where(inArray(discounts.id, data.discountIds));
      });
    } else {
      // Soft delete discounts
      await db
        .update(discounts)
        .set({ deletedAt: sql`unixepoch()` })
        .where(inArray(discounts.id, data.discountIds));
    }

    // Handle search index updates if necessary
    // if (data.discountIds.length > 0) {
    //     deleteFromIndex({ discountIds: data.discountIds }).catch((error) => {
    //       console.error("Error deleting discounts from search index:", error);
    //       triggerReindex().catch((reindexError) => {
    //         console.error("Background reindexing failed after bulk discount deletion:", reindexError);
    //       });
    //     });
    // }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting discounts:", error);
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid request data",
          details: error.errors,
        }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
};
