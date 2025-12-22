import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { categories } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Category ID is required",
        }),
        { status: 400 },
      );
    }

    // Delete category
    await db.delete(categories).where(eq(categories.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error permanently deleting category:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
