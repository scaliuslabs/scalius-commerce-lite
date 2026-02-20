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

    // 2. Pre-fetch current widget and existing versions outside the batch
    const currentWidget = await db.select().from(widgets).where(eq(widgets.id, widgetId)).get();
    const existingVersions = await db
      .select({ id: widgetHistory.id })
      .from(widgetHistory)
      .where(eq(widgetHistory.widgetId, widgetId))
      .orderBy(desc(widgetHistory.createdAt));

    const restoreReason = `restoring version from ${new Date(
      versionToRestore.createdAt instanceof Date
        ? versionToRestore.createdAt.getTime()
        : versionToRestore.createdAt * 1000
    ).toLocaleString()}`;

    const batchOps: any[] = [];
    let updateIndex = 0;

    if (currentWidget) {
      batchOps.push(
        db.insert(widgetHistory).values({
          id: 'wh_' + nanoid(),
          widgetId: widgetId,
          htmlContent: currentWidget.htmlContent,
          cssContent: currentWidget.cssContent,
          reason: restoreReason,
        }),
      );
      updateIndex = 1;
    }

    // 3. Update the main widget with the restored content
    batchOps.push(
      db
        .update(widgets)
        .set({
          htmlContent: versionToRestore.htmlContent,
          cssContent: versionToRestore.cssContent,
          updatedAt: sql`(cast(strftime('%s','now') as int))`,
        })
        .where(eq(widgets.id, widgetId))
        .returning(),
    );

    // 4. Enforce 4-version limit: total after = existing + (currentWidget ? 1 : 0)
    const willAdd = currentWidget ? 1 : 0;
    if (existingVersions.length + willAdd > 4) {
      const keepCount = 4 - willAdd;
      const versionsToDelete = existingVersions.slice(keepCount).map((v) => v.id);
      if (versionsToDelete.length > 0) {
        batchOps.push(db.delete(widgetHistory).where(inArray(widgetHistory.id, versionsToDelete)));
      }
    }

    const batchResult = await db.batch(batchOps as any);
    const updatedWidget = (batchResult[updateIndex] as any[])[0];

    return new Response(JSON.stringify(updatedWidget), { status: 200 });

  } catch (error) {
    console.error("Error restoring widget version:", error);
    return new Response(JSON.stringify({ message: "Error restoring version" }), { status: 500 });
  }
};
