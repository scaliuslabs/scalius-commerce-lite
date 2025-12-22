import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets, widgetHistory } from "@/db/schema";
import { eq, isNull, sql, and, desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { WidgetPlacementRule } from "@/db/schema";
import { nanoid } from "nanoid";

const updateWidgetSchema = z
  .object({
    name: z
      .string()
      .min(3, "Widget name must be at least 3 characters")
      .optional(),
    htmlContent: z.string().min(1, "HTML content cannot be empty").optional(),
    cssContent: z.string().optional().nullable(),
    aiContext: z.any().optional(),
    isActive: z.boolean().optional(),
    displayTarget: z.enum(["homepage"]).optional(),
    placementRule: z
      .enum([
        WidgetPlacementRule.BEFORE_COLLECTION,
        WidgetPlacementRule.AFTER_COLLECTION,
        WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
        WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
        WidgetPlacementRule.STANDALONE,
      ])
      .optional(),
    referenceCollectionId: z.string().optional().nullable(),
    sortOrder: z.number().int().optional(),
  })
  .refine(
    (data) => {
      if (
        (data.placementRule === WidgetPlacementRule.BEFORE_COLLECTION ||
          data.placementRule === WidgetPlacementRule.AFTER_COLLECTION) &&
        !data.referenceCollectionId
      ) {
        return data.placementRule === undefined;
      }
      return true;
    },
    {
      message:
        "Reference collection ID is required for before/after collection placement.",
      path: ["referenceCollectionId"],
    },
  );

export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;

    if (!id) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { message: "Widget ID is required" },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const widget = await db
      .select()
      .from(widgets)
      .where(
        and(
          eq(widgets.id, id),
          eq(widgets.isActive, true),
          isNull(widgets.deletedAt),
        ),
      )
      .get();

    if (!widget) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { message: "Widget not found" },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        widget,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching widget:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: { message: "Internal server error" },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

export const PUT: APIRoute = async ({ params, request }) => {
  const widgetId = params.id;
  if (!widgetId) {
    return new Response(JSON.stringify({ error: "Widget ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const json = await request.json();
    const data = updateWidgetSchema.parse(json);

    // --- VERSION HISTORY LOGIC START ---
    const currentWidget = await db.select().from(widgets).where(eq(widgets.id, widgetId)).get();

    if (currentWidget) {
        await db.transaction(async (tx) => {
            await tx.insert(widgetHistory).values({
                id: 'wh_' + nanoid(),
                widgetId: widgetId,
                htmlContent: currentWidget.htmlContent,
                cssContent: currentWidget.cssContent,
                reason: 'updated'
            });

            const versions = await tx.select({ id: widgetHistory.id, createdAt: widgetHistory.createdAt }).from(widgetHistory).where(eq(widgetHistory.widgetId, widgetId)).orderBy(desc(widgetHistory.createdAt));

            if (versions.length > 4) {
                const versionsToDelete = versions.slice(4).map(v => v.id);
                await tx.delete(widgetHistory).where(inArray(widgetHistory.id, versionsToDelete));
            }
        });
    }
    // --- VERSION HISTORY LOGIC END ---

    if (
      data.placementRule &&
      data.placementRule !== WidgetPlacementRule.BEFORE_COLLECTION &&
      data.placementRule !== WidgetPlacementRule.AFTER_COLLECTION
    ) {
      data.referenceCollectionId = null;
    }

    const { aiContext, ...rest } = data;

    const [updatedWidget] = await db
      .update(widgets)
      .set({
        ...rest,
        aiContext: aiContext ? JSON.stringify(aiContext) : undefined,
        updatedAt: sql`(cast(strftime('%s','now') as int))`, // CORRECTED
      })
      .where(eq(widgets.id, widgetId))
      .returning();

    if (!updatedWidget) {
      return new Response(JSON.stringify({ error: "Widget not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(updatedWidget), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`Error updating widget ${widgetId}:`, error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "Error updating widget" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  const widgetId = params.id;
  if (!widgetId) {
    return new Response(JSON.stringify({ error: "Widget ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Soft delete by setting deletedAt
    const [result] = await db
      .update(widgets)
      .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` }) // Ensure this also uses integer timestamp
      .where(eq(widgets.id, widgetId))
      .returning({ id: widgets.id });

    if (!result) {
      return new Response(JSON.stringify({ error: "Widget not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error(`Error deleting widget ${widgetId}:`, error);
    return new Response(JSON.stringify({ message: "Error deleting widget" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
