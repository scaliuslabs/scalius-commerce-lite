import type { APIRoute, APIContext } from "astro";
import { db } from "@/db";
import { adminFcmTokens } from "@/db/schema";
import { sql } from "drizzle-orm";

export const POST: APIRoute = async (contextUntyped) => {
  const context = contextUntyped as APIContext & { locals: App.Locals };
  const { request, locals } = context;
  const authResult = locals.auth();
  const clerkUserId = authResult?.userId;

  if (!clerkUserId) {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Admin user must be logged in." }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const { invalidTokens } = await request.json();

    if (!invalidTokens || !Array.isArray(invalidTokens)) {
      return new Response(
        JSON.stringify({
          error: "Invalid request. invalidTokens array is required.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    console.log(`Cleaning up ${invalidTokens.length} invalid FCM tokens`);

    // Mark invalid tokens as inactive instead of deleting them
    if (invalidTokens.length > 0) {
      await db
        .update(adminFcmTokens)
        .set({
          isActive: false,
          updatedAt: sql`(cast(strftime('%s','now') as int))`,
        })
        .where(sql`${adminFcmTokens.token} IN ${invalidTokens}`);
    }

    // Also clean up tokens that haven't been used in 30 days
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    await db
      .update(adminFcmTokens)
      .set({
        isActive: false,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(
        sql`${adminFcmTokens.lastUsed} < ${thirtyDaysAgo} OR ${adminFcmTokens.lastUsed} IS NULL`,
      );

    return new Response(
      JSON.stringify({
        message: "Token cleanup completed successfully.",
        cleanedCount: invalidTokens.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error cleaning up FCM tokens:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error during cleanup." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
