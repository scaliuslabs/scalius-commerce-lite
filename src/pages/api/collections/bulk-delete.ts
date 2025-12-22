import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { inArray, and, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";

const bulkDeleteSchema = z.object({
  collectionIds: z.array(z.string()).min(1),
  permanent: z.boolean().optional().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.permanent) {
      // Permanently delete (from trash)
      const deleted = await db
        .delete(collections)
        .where(
          and(
            inArray(collections.id, data.collectionIds),
            isNotNull(collections.deletedAt),
          ),
        )
        .returning();

      return new Response(JSON.stringify({ deleted: deleted.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else {
      // Soft delete (move to trash)
      const updated = await db
        .update(collections)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(collections.id, data.collectionIds),
            isNull(collections.deletedAt),
          ),
        )
        .returning();

      return new Response(JSON.stringify({ deleted: updated.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    console.error("Error bulk deleting collections:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ error: "Error bulk deleting collections" }),
      { status: 500 },
    );
  }
};
