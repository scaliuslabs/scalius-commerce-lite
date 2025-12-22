import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ message: "Collection ID is required" }),
        {
          status: 400,
        },
      );
    }

    // Check if collection exists in trash
    const existing = await db
      .select()
      .from(collections)
      .where(and(eq(collections.id, id), isNotNull(collections.deletedAt)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!existing) {
      return new Response(
        JSON.stringify({ message: "Collection not found in trash" }),
        {
          status: 404,
        },
      );
    }

    // Restore the collection
    await db
      .update(collections)
      .set({
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(collections.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error restoring collection:", error);
    return new Response(
      JSON.stringify({ message: "Error restoring collection" }),
      { status: 500 },
    );
  }
};
