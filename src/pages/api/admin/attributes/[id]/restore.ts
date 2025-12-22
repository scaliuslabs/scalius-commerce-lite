// src/pages/api/admin/attributes/[id]/restore.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { productAttributes } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    await db
      .update(productAttributes)
      .set({
        deletedAt: null,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(eq(productAttributes.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error(`Error restoring attribute ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to restore attribute" }),
      { status: 500 },
    );
  }
};
