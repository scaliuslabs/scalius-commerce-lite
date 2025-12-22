import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { inArray, and, isNotNull } from "drizzle-orm";
import { z } from "zod";

const bulkRestoreSchema = z.object({
  collectionIds: z.array(z.string()).min(1),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkRestoreSchema.parse(json);

    const updated = await db
      .update(collections)
      .set({
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(collections.id, data.collectionIds),
          isNotNull(collections.deletedAt),
        ),
      )
      .returning();

    return new Response(JSON.stringify({ restored: updated.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error bulk restoring collections:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ error: "Error bulk restoring collections" }),
      { status: 500 },
    );
  }
};
