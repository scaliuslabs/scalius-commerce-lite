// src/pages/api/admin/settings/meta-conversions/index.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { metaConversionsSettings } from "@/db/schema";
import { sql, eq } from "drizzle-orm";
import { z } from "zod";
import { clearCapiSettingsCache } from "@/lib/meta/conversions-api";

// SECURITY: Masked value for sensitive fields
const MASKED_VALUE = "••••••••••••";

// Zod schema for Meta Conversions settings
const metaConversionsSettingsSchema = z.object({
  pixelId: z.string().optional(),
  accessToken: z.string().optional(),
  testEventCode: z.string().optional(),
  isEnabled: z.boolean().default(false),
  logRetentionDays: z.number().int().min(1).max(365).default(30),
});

// GET: Fetch Meta Conversions settings
export const GET: APIRoute = async () => {
  try {
    const settings = await db
      .select()
      .from(metaConversionsSettings)
      .where(eq(metaConversionsSettings.id, "singleton"))
      .get();

    // SECURITY: Mask access token before sending to client
    const maskedSettings = settings ? {
      ...settings,
      accessToken: settings.accessToken ? MASKED_VALUE : null,
    } : null;

    return new Response(JSON.stringify({ data: maskedSettings }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching Meta Conversions settings:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch Meta Conversions settings" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// POST: Create or update Meta Conversions settings
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const validation = metaConversionsSettingsSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    let { pixelId, accessToken, testEventCode, isEnabled, logRetentionDays } =
      validation.data;

    // Check if settings already exist
    const existingSettings = await db
      .select()
      .from(metaConversionsSettings)
      .where(eq(metaConversionsSettings.id, "singleton"))
      .get();

    // SECURITY: If access token is masked, use existing token from database
    if (accessToken === MASKED_VALUE && existingSettings?.accessToken) {
      accessToken = existingSettings.accessToken;
    }

    let result;
    if (existingSettings) {
      // Update existing settings
      [result] = await db
        .update(metaConversionsSettings)
        .set({
          pixelId,
          accessToken,
          testEventCode,
          isEnabled,
          logRetentionDays,
          updatedAt: sql`(cast(strftime('%s','now') as int))`,
        })
        .where(eq(metaConversionsSettings.id, "singleton"))
        .returning();
    } else {
      // Create new settings
      [result] = await db
        .insert(metaConversionsSettings)
        .values({
          id: "singleton",
          pixelId,
          accessToken,
          testEventCode,
          isEnabled,
          logRetentionDays,
          createdAt: sql`(cast(strftime('%s','now') as int))`,
          updatedAt: sql`(cast(strftime('%s','now') as int))`,
        })
        .returning();
    }

    // FIX: Clear the settings cache so the service picks up changes immediately
    clearCapiSettingsCache();

    // SECURITY: Mask access token in response
    const maskedResult = {
      ...result,
      accessToken: result.accessToken ? MASKED_VALUE : null,
    };

    return new Response(JSON.stringify({ data: maskedResult }), {
      status: existingSettings ? 200 : 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error saving Meta Conversions settings:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save Meta Conversions settings" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};