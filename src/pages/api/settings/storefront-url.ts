import type { APIRoute } from "astro";
import { db } from "../../../db";
import { siteSettings } from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql, eq } from "drizzle-orm";
import { layoutCache, CACHE_KEYS } from "../../../lib/layout-cache";

export const POST: APIRoute = async ({ request }) => {
  try {
    const { storefrontUrl } = await request.json();

    // Get existing settings
    const [existingSettings] = await db.select().from(siteSettings).limit(1);

    if (existingSettings) {
      // Update existing settings
      await db
        .update(siteSettings)
        .set({
          storefrontUrl: storefrontUrl || "/",
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(siteSettings.id, existingSettings.id));
    } else {
      // Create new settings if none exist
      await db.insert(siteSettings).values({
        id: "settings_" + nanoid(),
        siteName: "My Store",
        headerConfig: JSON.stringify({}),
        footerConfig: JSON.stringify({}),
        storefrontUrl: storefrontUrl || "/",
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      });
    }

    // Invalidate layout cache so next page load gets fresh storefront URL
    layoutCache.invalidate(CACHE_KEYS.STOREFRONT_URL);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Storefront URL saved successfully.",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error saving storefront URL:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to save storefront URL",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500 },
    );
  }
};

export const GET: APIRoute = async () => {
  try {
    const [settings] = await db
      .select({
        storefrontUrl: siteSettings.storefrontUrl,
      })
      .from(siteSettings)
      .limit(1);

    return new Response(
      JSON.stringify({
        storefrontUrl: settings?.storefrontUrl || "/",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching storefront URL:", error);
    // Return default if column doesn't exist yet
    return new Response(
      JSON.stringify({
        storefrontUrl: "/",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
