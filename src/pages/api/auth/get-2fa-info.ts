// src/pages/api/auth/get-2fa-info.ts
// Returns the user's 2FA method preference for the login flow
import type { APIRoute } from "astro";
import { createAuth } from "@/lib/auth";
import { getDb } from "@/db";
import { user as userTable } from "@/db/schema";
import { eq } from "drizzle-orm";

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const auth = createAuth(env);
  const db = getDb(env);

  try {
    const sessionResult = await auth.api.getSession({ headers: request.headers });

    if (!sessionResult?.session || !sessionResult?.user) {
      return new Response(
        JSON.stringify({ success: false, message: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const userData = await db
      .select({
        twoFactorMethod: userTable.twoFactorMethod,
        twoFactorEnabled: userTable.twoFactorEnabled,
        email: userTable.email
      })
      .from(userTable)
      .where(eq(userTable.id, sessionResult.user.id))
      .get();

    if (!userData) {
      return new Response(
        JSON.stringify({ success: false, message: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        method: userData.twoFactorMethod || "email", // Default to email if not set
        twoFactorEnabled: userData.twoFactorEnabled,
        email: userData.email
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error getting 2FA info:", error);
    return new Response(
      JSON.stringify({ success: false, message: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
