import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
  const widgetId = params.id;

  if (!widgetId) {
    return new Response(JSON.stringify({ error: "Widget ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const restoredWidget = await db
      .update(widgets)
      .set({
        deletedAt: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(widgets.id, widgetId))
      .returning()
      .get();

    if (!restoredWidget) {
      return new Response(
        JSON.stringify({ error: "Widget not found or already active" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify(restoredWidget), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`Error restoring widget ${widgetId}:`, error);
    return new Response(JSON.stringify({ message: "Error restoring widget" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
