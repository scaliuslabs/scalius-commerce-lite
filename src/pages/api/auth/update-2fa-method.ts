// src/pages/api/auth/update-2fa-method.ts
// Updates the user's preferred 2FA method (totp or email)
import type { APIRoute } from "astro";
import { createAuth } from "@/lib/auth";
import { getDb } from "@/db";
import { user as userTable } from "@/db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ request, locals }) => {
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

    const body = await request.json();
    const { method } = body;

    if (!method || !["totp", "email"].includes(method)) {
      return new Response(
        JSON.stringify({ success: false, message: "Invalid method. Must be 'totp' or 'email'" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    await db
      .update(userTable)
      .set({ twoFactorMethod: method })
      .where(eq(userTable.id, sessionResult.user.id));

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error updating 2FA method:", error);
    return new Response(
      JSON.stringify({ success: false, message: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
