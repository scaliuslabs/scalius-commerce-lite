import type { APIRoute } from "astro";
import { db } from "../../../../../db";
import { productVariants } from "../../../../../db/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";

const bulkDeleteSchema = z.object({
  variantIds: z.array(z.string()),
});

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const { id: productId } = params;
    if (!productId) {
      return new Response(
        JSON.stringify({
          error: "Product ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.variantIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No variant IDs provided",
        }),
        { status: 400 },
      );
    }

    // Permanently delete all selected variants
    await db
      .delete(productVariants)
      .where(
        sql`${productVariants.id} IN ${data.variantIds} AND ${productVariants.productId} = ${productId}`,
      );

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting variants:", error);

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
