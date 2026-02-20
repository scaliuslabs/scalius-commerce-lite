import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const reorderSchema = z.array(
  z.object({
    id: z.string(),
    sortOrder: z.number(),
  }),
);

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const validatedData = reorderSchema.parse(body);

    // Update each collection's sort order atomically
    await db.batch(
      validatedData.map((item) =>
        db.update(collections).set({ sortOrder: item.sortOrder }).where(eq(collections.id, item.id))
      ) as any,
    );

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
  } catch (error) {
    console.error("Error reordering collections:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to reorder collections",
      }),
      { status: 500 },
    );
  }
};
