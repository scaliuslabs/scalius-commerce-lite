import type { APIRoute } from "astro";
import { db } from "@/db";
import { shippingMethods } from "@/db/schema";
import { eq } from "drizzle-orm";

// DELETE: Permanently delete a shipping method
export const DELETE: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // First check if the method exists and is soft-deleted
    const existingMethod = await db
      .select({ id: shippingMethods.id, deletedAt: shippingMethods.deletedAt })
      .from(shippingMethods)
      .where(eq(shippingMethods.id, id))
      .get();

    if (!existingMethod) {
      return new Response(
        JSON.stringify({ error: "Shipping method not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Warning: Allow permanent deletion regardless of soft-delete status
    // If you want to enforce that only soft-deleted items can be permanently deleted,
    // uncomment the following block:
    /*
    if (!existingMethod.deletedAt) {
      return new Response(
        JSON.stringify({
          error: "Shipping method must be moved to trash before permanent deletion",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    */

    // Permanently delete the shipping method from the database
    await db.delete(shippingMethods).where(eq(shippingMethods.id, id));

    return new Response(null, { status: 204 }); // No content
  } catch (error) {
    console.error(`Error permanently deleting shipping method ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to permanently delete shipping method" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
