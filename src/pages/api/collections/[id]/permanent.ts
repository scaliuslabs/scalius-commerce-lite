import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params }) => {
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

    // Permanently delete the collection
    await db.delete(collections).where(eq(collections.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error permanently deleting collection:", error);
    return new Response(
      JSON.stringify({ message: "Error permanently deleting collection" }),
      { status: 500 },
    );
  }
};
