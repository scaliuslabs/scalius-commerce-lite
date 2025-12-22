import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets } from "@/db/schema";
import { eq } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params }) => {
  const widgetId = params.id;

  if (!widgetId) {
    return new Response(JSON.stringify({ error: "Widget ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await db
      .delete(widgets)
      .where(eq(widgets.id, widgetId))
      .returning({ id: widgets.id })
      .get();

    if (!result) {
      return new Response(JSON.stringify({ error: "Widget not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(null, { status: 204 }); // No content, success
  } catch (error) {
    console.error(`Error permanently deleting widget ${widgetId}:`, error);
    return new Response(
      JSON.stringify({ message: "Error permanently deleting widget" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
