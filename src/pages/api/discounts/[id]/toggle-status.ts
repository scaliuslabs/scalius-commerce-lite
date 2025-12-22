import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { discounts } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

const toggleStatusSchema = z.object({
  isActive: z.boolean(),
});

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ error: "Discount ID is required" }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = toggleStatusSchema.parse(json);

    // Check if discount exists
    const existingDiscount = await db
      .select({ id: discounts.id })
      .from(discounts)
      .where(eq(discounts.id, id))
      .get();

    if (!existingDiscount) {
      return new Response(JSON.stringify({ error: "Discount not found" }), {
        status: 404,
      });
    }

    // Update discount status
    await db
      .update(discounts)
      .set({
        isActive: data.isActive,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(discounts.id, id));

    return new Response(
      JSON.stringify({
        success: true,
        message: `Discount ${data.isActive ? "activated" : "deactivated"} successfully`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error toggling discount status:", error);
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid data",
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
