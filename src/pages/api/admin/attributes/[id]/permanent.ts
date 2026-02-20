// src/pages/api/admin/attributes/[id]/permanent.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { productAttributes, productAttributeValues } from "@/db/schema";
import { eq } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), { status: 400 });
  }

  try {
    await db.batch([
      db.delete(productAttributeValues).where(eq(productAttributeValues.attributeId, id)),
      db.delete(productAttributes).where(eq(productAttributes.id, id)),
    ]);

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error(`Error permanently deleting attribute ${id}:`, error);
    return new Response(JSON.stringify({ error: "Failed to permanently delete attribute" }), { status: 500 });
  }
};