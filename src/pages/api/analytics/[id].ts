import type { APIRoute } from "astro";
import { db } from "../../../db";
import { analytics } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

const updateAnalyticsSchema = z.object({
  id: z.string(),
  name: z.string().min(3).max(100),
  type: z.enum(["google_analytics", "facebook_pixel", "custom"]),
  isActive: z.boolean(),
  usePartytown: z.boolean(),
  config: z.string().min(1),
  location: z.enum(["head", "body_start", "body_end"]),
});

export const GET: APIRoute = async ({ params }) => {
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

    const script = await db
      .select()
      .from(analytics)
      .where(eq(analytics.id, id))
      .get();

    if (!script) {
      return new Response(
        JSON.stringify({
          error: "Analytics script not found",
        }),
        { status: 404 },
      );
    }

    // Format dates for consistent API responses
    const formattedScript = {
      ...script,
      createdAt: script.createdAt
        ? new Date(Number(script.createdAt) * 1000).toISOString()
        : null,
      updatedAt: script.updatedAt
        ? new Date(Number(script.updatedAt) * 1000).toISOString()
        : null,
    };

    return new Response(JSON.stringify(formattedScript), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error fetching analytics script:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
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
    const data = updateAnalyticsSchema.parse(json);

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

    // Update script
    await db
      .update(analytics)
      .set({
        name: data.name,
        type: data.type,
        isActive: data.isActive,
        usePartytown: data.usePartytown,
        config: data.config,
        location: data.location,
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
        JSON.stringify({ success: true, script: formattedScript }),
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
    console.error("Error updating analytics script:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid analytics script data",
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

export const DELETE: APIRoute = async ({ params }) => {
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

    // Check if script exists
    const script = await db
      .select()
      .from(analytics)
      .where(eq(analytics.id, id))
      .get();

    if (!script) {
      return new Response(
        JSON.stringify({
          error: "Analytics script not found",
        }),
        { status: 404 },
      );
    }

    // Format the script data before deletion for the response
    const formattedScript = {
      id: script.id,
      name: script.name,
      type: script.type,
      createdAt: script.createdAt
        ? new Date(Number(script.createdAt) * 1000).toISOString()
        : null,
      updatedAt: script.updatedAt
        ? new Date(Number(script.updatedAt) * 1000).toISOString()
        : null,
    };

    // Delete the script
    await db.delete(analytics).where(eq(analytics.id, id));

    return new Response(
      JSON.stringify({
        success: true,
        message: "Analytics script deleted",
        deletedScript: formattedScript,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error deleting analytics script:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
