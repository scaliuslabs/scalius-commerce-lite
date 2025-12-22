import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { unixToDate } from "@/lib/utils";

export const PATCH: APIRoute = async ({ params }) => {
  const widgetId = params.id;

  if (!widgetId) {
    return new Response(JSON.stringify({ error: "Widget ID is required" }), {
      status: 400,
    });
  }

  try {
    const currentWidget = await db
      .select({ isActive: widgets.isActive })
      .from(widgets)
      .where(eq(widgets.id, widgetId))
      .get();

    if (!currentWidget) {
      return new Response(JSON.stringify({ error: "Widget not found" }), {
        status: 404,
      });
    }

    const [updatedWidget] = await db
      .update(widgets)
      .set({
        isActive: !currentWidget.isActive,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(eq(widgets.id, widgetId))
      .returning();

    if (!updatedWidget) {
      return new Response(JSON.stringify({ error: "Failed to update widget" }), {
        status: 500,
      });
    }
    
    // Safely serialize the response with proper date formats
    const serializedWidget = {
        ...updatedWidget,
        createdAt: unixToDate(updatedWidget.createdAt)?.toISOString() ?? null,
        updatedAt: unixToDate(updatedWidget.updatedAt)?.toISOString() ?? null,
        deletedAt: unixToDate(updatedWidget.deletedAt)?.toISOString() ?? null,
    }
    
    return new Response(JSON.stringify(serializedWidget), { status: 200 });

  } catch (error) {
    console.error(`Error toggling status for widget ${widgetId}:`, error);
    return new Response(JSON.stringify({ message: "Failed to toggle status" }), {
      status: 500,
    });
  }
};