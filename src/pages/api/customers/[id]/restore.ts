import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { customers } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Customer ID is required",
        }),
        { status: 400 }
      );
    }

    // Restore customer
    await db
      .update(customers)
      .set({
        deletedAt: null,
      })
      .where(eq(customers.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error restoring customer:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 }
    );
  }
};
