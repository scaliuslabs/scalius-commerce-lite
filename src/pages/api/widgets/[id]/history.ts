import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgetHistory } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export const GET: APIRoute = async ({ params }) => {
  const widgetId = params.id;
  if (!widgetId) {
    return new Response(JSON.stringify({ error: "Widget ID is required" }), { status: 400 });
  }

  try {
    const history = await db
      .select()
      .from(widgetHistory)
      .where(eq(widgetHistory.widgetId, widgetId))
      .orderBy(desc(widgetHistory.createdAt));

    return new Response(JSON.stringify(history), { status: 200 });
  } catch (error) {
    console.error("Error fetching widget history:", error);
    return new Response(JSON.stringify({ message: "Error fetching history" }), { status: 500 });
  }
};
