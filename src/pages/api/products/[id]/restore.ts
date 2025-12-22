import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { products } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { triggerReindex } from "@/lib/search/index";

export const POST: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Product ID is required",
        }),
        { status: 400 },
      );
    }

    // Restore the product by setting deletedAt to null and updating the timestamps
    await db
      .update(products)
      .set({
        deletedAt: null,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(products.id, id));

    // Trigger reindexing in the background
    triggerReindex().catch((error) => {
      console.error(
        "Background reindexing failed after product restoration:",
        error,
      );
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error restoring product:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
