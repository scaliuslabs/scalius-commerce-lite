import type { APIRoute } from "astro";
import { db } from "../../../db";
import { siteSettings } from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql, eq } from "drizzle-orm";

export const POST: APIRoute = async ({ request }) => {
  try {
    const { siteTitle, homepageTitle, homepageMetaDescription, robotsTxt } =
      await request.json();

    // Get existing settings
    const [existingSettings] = await db.select().from(siteSettings).limit(1);

    if (existingSettings) {
      // Update existing settings
      await db
        .update(siteSettings)
        .set({
          siteTitle,
          homepageTitle,
          homepageMetaDescription,
          robotsTxt,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(siteSettings.id, existingSettings.id));
    } else {
      // Create new settings if none exist (should ideally not happen if header/footer settings are saved first)
      await db.insert(siteSettings).values({
        id: "settings_" + nanoid(),
        siteName: "My Store", // Default siteName, consider if this needs to be dynamic or pre-existing
        headerConfig: JSON.stringify({}), // Default empty header config
        footerConfig: JSON.stringify({}), // Default empty footer config
        siteTitle,
        homepageTitle,
        homepageMetaDescription,
        robotsTxt,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "SEO settings saved successfully.",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error saving SEO configuration:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to save SEO configuration",
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
        siteTitle: siteSettings.siteTitle,
        homepageTitle: siteSettings.homepageTitle,
        homepageMetaDescription: siteSettings.homepageMetaDescription,
        robotsTxt: siteSettings.robotsTxt,
      })
      .from(siteSettings)
      .limit(1);

    if (!settings) {
      return new Response(
        JSON.stringify({
          siteTitle: "",
          homepageTitle: "",
          homepageMetaDescription: "",
          robotsTxt: "",
        }),
        {
          status: 200, // Return default empty values if no settings found
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    return new Response(JSON.stringify(settings), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error fetching SEO configuration:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch SEO configuration",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500 },
    );
  }
};
