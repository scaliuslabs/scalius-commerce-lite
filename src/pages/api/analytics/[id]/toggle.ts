import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { analytics } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

const toggleSchema = z.object({
  isActive: z.boolean(),
});

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Analytics script ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = toggleSchema.parse(json);

    // Check if script exists
    const existingScript = await db
      .select({ id: analytics.id })
      .from(analytics)
      .where(eq(analytics.id, id))
      .get();

    if (!existingScript) {
      return new Response(
        JSON.stringify({
          error: "Analytics script not found",
        }),
        { status: 404 },
      );
    }

    // Update script active status
    await db
      .update(analytics)
      .set({
        isActive: data.isActive,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(analytics.id, id));

    // Get the updated script
    const updatedScript = await db
      .select()
      .from(analytics)
      .where(eq(analytics.id, id))
      .get();

    if (updatedScript) {
      // Format dates for consistent API responses
      const formattedScript = {
        ...updatedScript,
        createdAt: updatedScript.createdAt
          ? new Date(Number(updatedScript.createdAt) * 1000).toISOString()
          : null,
        updatedAt: updatedScript.updatedAt
          ? new Date(Number(updatedScript.updatedAt) * 1000).toISOString()
          : null,
      };

      return new Response(
        JSON.stringify({
          success: true,
          message: `Analytics script ${data.isActive ? "activated" : "deactivated"}`,
          script: formattedScript,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error toggling analytics script status:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid data",
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
