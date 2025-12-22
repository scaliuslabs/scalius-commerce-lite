import type { APIRoute } from "astro";
import { db } from "@/db";
import { widgets, collections } from "@/db/schema";
import { eq, isNull, asc, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { WidgetPlacementRule } from "@/db/schema";

const createWidgetSchema = z
  .object({
    name: z.string().min(3, "Widget name must be at least 3 characters"),
    htmlContent: z.string().min(1, "HTML content cannot be empty"),
    cssContent: z.string().optional(),
    aiContext: z.any().optional(),
    isActive: z.boolean().default(true),
    displayTarget: z.enum(["homepage"]).default("homepage"),
    placementRule: z.enum([
      WidgetPlacementRule.BEFORE_COLLECTION,
      WidgetPlacementRule.AFTER_COLLECTION,
      WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
      WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
      WidgetPlacementRule.STANDALONE,
    ]),
    referenceCollectionId: z.string().optional().nullable(),
    sortOrder: z.number().int().optional().default(0),
  })
  .refine(
    (data) => {
      if (
        (data.placementRule === WidgetPlacementRule.BEFORE_COLLECTION ||
          data.placementRule === WidgetPlacementRule.AFTER_COLLECTION) &&
        !data.referenceCollectionId
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        "A reference collection is required for this placement rule.",
      path: ["referenceCollectionId"],
    },
  );

export const GET: APIRoute = async () => {
  try {
    const allWidgets = await db
      .select()
      .from(widgets)
      .where(isNull(widgets.deletedAt))
      .orderBy(asc(widgets.sortOrder), asc(widgets.name));

    const availableCollections = await db
      .select({
        id: collections.id,
        name: collections.name,
        sortOrder: collections.sortOrder,
        type: collections.type,
      })
      .from(collections)
      .where(and(isNull(collections.deletedAt), eq(collections.isActive, true)))
      .orderBy(asc(collections.sortOrder));

    return new Response(
      JSON.stringify({ widgets: allWidgets, availableCollections }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching widgets:", error);
    return new Response(JSON.stringify({ error: "Error fetching widgets" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createWidgetSchema.parse(json);

    const newWidgetId = "wid_" + nanoid();

    const newWidget = await db
      .insert(widgets)
      .values({
        id: newWidgetId,
        name: data.name,
        htmlContent: data.htmlContent,
        cssContent: data.cssContent,
        isActive: data.isActive,
        displayTarget: data.displayTarget,
        placementRule: data.placementRule,
        referenceCollectionId: data.referenceCollectionId,
        sortOrder: data.sortOrder,
        aiContext: data.aiContext ? JSON.stringify(data.aiContext) : null,
      })
      .returning()
      .get();

    return new Response(JSON.stringify(newWidget), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating widget:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "Error creating widget" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};