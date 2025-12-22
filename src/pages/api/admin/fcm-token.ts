// src/pages/api/admin/fcm-token.ts

import type { APIContext } from "astro";
import { db } from "@/db";
import { adminFcmTokens } from "@/db/schema";
import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";

// Zod schema for request body validation
const fcmTokenSchema = z.object({
  token: z.string().min(1, "FCM token is required"),
  userId: z.string().min(1, "User ID is required"),
  deviceInfo: z.string().optional(),
});

// v-- CHANGE: Define the handler as an async function and explicitly type the context parameter
export async function POST({ request, locals }: APIContext) {
  // 1. Authentication check (relies on Clerk middleware)
  const auth = locals.auth; // This will now be correctly typed
  if (!auth || !auth().userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const authenticatedUserId = auth().userId;

  // 2. Parse and validate the request body
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validation = fcmTokenSchema.safeParse(body);

  if (!validation.success) {
    return new Response(
      JSON.stringify({
        error: "Invalid input",
        details: validation.error.flatten(),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { token, userId, deviceInfo } = validation.data;

  // 3. Authorization check: Ensure the user is not trying to register a token for someone else
  if (userId !== authenticatedUserId) {
    return new Response(
      JSON.stringify({ error: "Forbidden: User ID mismatch" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    // 4. Perform an "upsert" (insert or update) operation on the database.
    await db
      .insert(adminFcmTokens)
      .values({
        id: createId(),
        userId,
        token,
        deviceInfo,
        isActive: true,
        lastUsed: sql`(cast(strftime('%s','now') as int))`,
        createdAt: sql`(cast(strftime('%s','now') as int))`,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .onConflictDoUpdate({
        target: adminFcmTokens.token,
        set: {
          userId,
          deviceInfo,
          isActive: true,
          lastUsed: sql`(cast(strftime('%s','now') as int))`,
          updatedAt: sql`(cast(strftime('%s','now') as int))`,
        },
      });

    console.log(`Successfully upserted FCM token for user ${userId}`);

    // 5. Return a success response
    return new Response(
      JSON.stringify({ message: "FCM token registered successfully" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error saving FCM token:", error);
    return new Response(JSON.stringify({ error: "Failed to save FCM token" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}