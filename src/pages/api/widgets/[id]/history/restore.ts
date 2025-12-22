import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets, widgetHistory } from "@/db/schema";
import { eq, sql, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

export const POST: APIRoute = async ({ params, request }) => {
  const widgetId = params.id;
  if (!widgetId) {
    return new Response(JSON.stringify({ error: "Widget ID is required" }), { status: 400 });
  }

  try {
    const { historyId } = await request.json();
    if (!historyId) {
      return new Response(JSON.stringify({ error: "History ID is required" }), { status: 400 });
    }

    // 1. Get the content from the history table
    const versionToRestore = await db.select().from(widgetHistory).where(eq(widgetHistory.id, historyId)).get();
    if (!versionToRestore || versionToRestore.widgetId !== widgetId) {
      return new Response(JSON.stringify({ error: "History record not found" }), { status: 404 });
    }

    const updatedWidget = await db.transaction(async (tx) => {
        // 2. Get the current widget content to save it to history before overwriting
        const currentWidget = await tx.select().from(widgets).where(eq(widgets.id, widgetId)).get();
        if (currentWidget) {
            await tx.insert(widgetHistory).values({
                id: 'wh_' + nanoid(),
                widgetId: widgetId,
                htmlContent: currentWidget.htmlContent,
                cssContent: currentWidget.cssContent,
                reason: `restoring version from ${new Date(
                  versionToRestore.createdAt instanceof Date
                    ? versionToRestore.createdAt.getTime()
                    : versionToRestore.createdAt * 1000
                ).toLocaleString()}`
            });
        }

        // 3. Update the main widget with the restored content
        const [restoredWidget] = await tx
          .update(widgets)
          .set({
            htmlContent: versionToRestore.htmlContent,
            cssContent: versionToRestore.cssContent,
            updatedAt: sql`(cast(strftime('%s','now') as int))`,
          })
          .where(eq(widgets.id, widgetId))
          .returning();

        // 4. Enforce 4-version limit
        const versions = await tx.select({ id: widgetHistory.id }).from(widgetHistory).where(eq(widgetHistory.widgetId, widgetId)).orderBy(desc(widgetHistory.createdAt));
        if (versions.length > 4) {
            const versionsToDelete = versions.slice(4).map(v => v.id);
            await tx.delete(widgetHistory).where(inArray(widgetHistory.id, versionsToDelete));
        }

        return restoredWidget;
    });

    return new Response(JSON.stringify(updatedWidget), { status: 200 });

  } catch (error) {
    console.error("Error restoring widget version:", error);
    return new Response(JSON.stringify({ message: "Error restoring version" }), { status: 500 });
  }
};
