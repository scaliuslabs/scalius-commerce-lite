// src/pages/api/auth/mark-2fa-verified.ts
// Endpoint to mark the current session as 2FA-verified
// Used after enabling 2FA for the first time

import type { APIRoute } from "astro";
import { createAuth } from "@/lib/auth";
import { getDb } from "@/db";
import { session as sessionTable } from "@/db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env || process.env;
  const auth = createAuth(env);
  const db = getDb(env);

  try {
    // Get the current session
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
    });

    if (!sessionResult?.session || !sessionResult?.user) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "No active session found",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // SECURITY: Only allow this if the user has 2FA enabled
    // This prevents abuse - you can only mark as verified if you actually have 2FA set up
    if (!sessionResult.user.twoFactorEnabled) {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "Two-factor authentication is not enabled for this account",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Update the session's twoFactorVerified field
    await db
      .update(sessionTable)
      .set({ twoFactorVerified: true })
      .where(eq(sessionTable.id, sessionResult.session.id));

    return new Response(
      JSON.stringify({
        success: true,
        message: "Session marked as 2FA verified",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[mark-2fa-verified] Error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal error",
        message: error instanceof Error ? error.message : "Failed to update session",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
