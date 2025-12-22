import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { categories } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Category ID is required",
        }),
        { status: 400 }
      );
    }

    // Restore category
    await db
      .update(categories)
      .set({
        deletedAt: null,
      })
      .where(eq(categories.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error restoring category:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 }
    );
  }
};
