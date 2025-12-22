import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgetHistory } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params }) => {
  const { id: widgetId, historyId } = params;

  if (!widgetId || !historyId) {
    return new Response(JSON.stringify({ error: "Widget ID and History ID are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const [deleted] = await db
      .delete(widgetHistory)
      .where(and(eq(widgetHistory.id, historyId), eq(widgetHistory.widgetId, widgetId)))
      .returning({ id: widgetHistory.id });

    if (!deleted) {
      return new Response(JSON.stringify({ error: "History record not found or does not belong to this widget" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, deletedId: deleted.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error(`Error deleting widget history ${historyId}:`, error);
    return new Response(JSON.stringify({ message: "Error deleting widget history" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
