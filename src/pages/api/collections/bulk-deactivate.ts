import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { inArray, and, isNull } from "drizzle-orm";
import { z } from "zod";

const bulkDeactivateSchema = z.object({
  collectionIds: z.array(z.string()).min(1),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeactivateSchema.parse(json);

    const updated = await db
      .update(collections)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(collections.id, data.collectionIds),
          isNull(collections.deletedAt),
        ),
      )
      .returning();

    return new Response(JSON.stringify({ deactivated: updated.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error bulk deactivating collections:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ error: "Error bulk deactivating collections" }),
      { status: 500 },
    );
  }
};
