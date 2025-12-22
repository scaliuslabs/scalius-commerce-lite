import type { APIRoute } from "astro";
import { db } from "@/db";
import { checkoutLanguages } from "@/db/schema";
import { sql, eq } from "drizzle-orm";

// POST: Restore a soft-deleted checkout language
export const POST: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) {
    return new Response(
      JSON.stringify({ error: "ID is required for restore" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const languageToRestore = await db
      .select({
        id: checkoutLanguages.id,
        deletedAt: checkoutLanguages.deletedAt,
      })
      .from(checkoutLanguages)
      .where(eq(checkoutLanguages.id, id))
      .get();

    if (!languageToRestore) {
      return new Response(
        JSON.stringify({ error: "Checkout language not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!languageToRestore.deletedAt) {
      return new Response(
        JSON.stringify({ error: "Checkout language is not in trash" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await db
      .update(checkoutLanguages)
      .set({
        deletedAt: null,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(eq(checkoutLanguages.id, id));

    return new Response(
      JSON.stringify({ message: "Checkout language restored successfully" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error(`Error restoring checkout language ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to restore checkout language" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
