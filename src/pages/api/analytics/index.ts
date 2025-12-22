import type { APIRoute } from "astro";
import { db } from "../../../db";
import { analytics } from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { z } from "zod";

const createAnalyticsSchema = z.object({
  name: z.string().min(3).max(100),
  type: z.enum(["google_analytics", "facebook_pixel", "custom"]),
  isActive: z.boolean().default(true),
  usePartytown: z.boolean().default(true),
  config: z.string().min(1),
  location: z.enum(["head", "body_start", "body_end"]),
});

export const GET: APIRoute = async () => {
  try {
    // Get all analytics scripts
    const results = await db.select().from(analytics);

    // Format dates for consistent API responses
    const formattedResults = results.map((script) => ({
      ...script,
      createdAt: script.createdAt
        ? new Date(Number(script.createdAt) * 1000).toISOString()
        : null,
      updatedAt: script.updatedAt
        ? new Date(Number(script.updatedAt) * 1000).toISOString()
        : null,
    }));

    return new Response(JSON.stringify(formattedResults), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error fetching analytics scripts:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createAnalyticsSchema.parse(json);

    const analyticsId = "analytics_" + nanoid();

    // Create analytics script
    const [script] = await db
      .insert(analytics)
      .values({
        id: analyticsId,
        name: data.name,
        type: data.type,
        isActive: data.isActive,
        usePartytown: data.usePartytown,
        config: data.config,
        location: data.location,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .returning();

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

    return new Response(
      JSON.stringify({ id: analyticsId, script: formattedScript }),
      {
        status: 201,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error creating analytics script:", error);

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
