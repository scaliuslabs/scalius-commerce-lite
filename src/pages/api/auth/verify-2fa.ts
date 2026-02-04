// src/pages/api/auth/verify-2fa.ts
// Custom endpoint that verifies TOTP/OTP and updates the session's twoFactorVerified field

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
    const body = await request.json();
    const { code, trustDevice, type = "totp" } = body;

    if (!code) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          message: "Verification code is required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Verify the code using Better Auth's API based on type
    let verifyResult: { token?: string; user?: { id: string } } | null = null;

    if (type === "backup") {
      verifyResult = await auth.api.verifyBackupCode({
        headers: request.headers,
        body: { code },
      });
    } else {
      // TOTP (authenticator app) verification
      // Note: Email OTP is handled client-side via authClient.twoFactor.verifyOtp()
      verifyResult = await auth.api.verifyTOTP({
        headers: request.headers,
        body: {
          code,
          trustDevice: trustDevice ?? false,
        },
      });
    }

    // Get session token from verify result to find the session
    const sessionToken = verifyResult?.token;

    if (sessionToken) {
      // Find and update session by token
      const sessionByToken = await db
        .select({ id: sessionTable.id })
        .from(sessionTable)
        .where(eq(sessionTable.token, sessionToken))
        .get();

      if (sessionByToken) {
        await db
          .update(sessionTable)
          .set({ twoFactorVerified: true })
          .where(eq(sessionTable.id, sessionByToken.id));

        return new Response(
          JSON.stringify({
            success: true,
            message: "Two-factor authentication verified",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Fallback: try getSession
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
    });

    if (sessionResult?.session) {
      await db
        .update(sessionTable)
        .set({ twoFactorVerified: true })
        .where(eq(sessionTable.id, sessionResult.session.id));

      return new Response(
        JSON.stringify({
          success: true,
          message: "Two-factor authentication verified",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // SECURITY: Do not update all sessions as fallback - return error instead
    return new Response(
      JSON.stringify({
        error: "No session",
        message: "Could not find session to update",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[verify-2fa] Error:", error);

    // Check if it's a verification failure
    if (error instanceof Error && error.message.includes("Invalid")) {
      return new Response(
        JSON.stringify({
          error: "Invalid code",
          message: "The verification code is invalid or expired",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        error: "Verification failed",
        message: error instanceof Error ? error.message : "Failed to verify code",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
