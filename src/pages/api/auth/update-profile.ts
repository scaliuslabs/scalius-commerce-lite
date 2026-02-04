// src/pages/api/auth/update-profile.ts
import type { APIRoute } from "astro";
import { createAuth } from "@/lib/auth";
import { getDb } from "@/db";
import { user as userTable } from "@/db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const auth = createAuth(env);

  // Verify the user is authenticated (middleware skips /api/auth/* routes)
  const sessionResult = await auth.api.getSession({
    headers: request.headers,
  });

  if (!sessionResult?.session || !sessionResult?.user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const sessionUser = sessionResult.user;

  try {
    const { name, image } = await request.json();

    // Validate name if provided
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2) {
        return new Response(
          JSON.stringify({ error: "Name must be at least 2 characters" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Validate image URL if provided
    if (image !== undefined && image !== null) {
      if (typeof image !== "string") {
        return new Response(
          JSON.stringify({ error: "Invalid image URL" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const db = getDb(env);

    // Build update object with only provided fields
    const updateData: { name?: string; image?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      updateData.name = name.trim();
    }

    if (image !== undefined) {
      updateData.image = image;
    }

    // Update user in database
    await db
      .update(userTable)
      .set(updateData)
      .where(eq(userTable.id, sessionUser.id));

    // Fetch updated user
    const updatedUser = await db
      .select({
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
      })
      .from(userTable)
      .where(eq(userTable.id, sessionUser.id))
      .get();

    return new Response(
      JSON.stringify({ success: true, user: updatedUser }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error updating profile:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update profile" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
