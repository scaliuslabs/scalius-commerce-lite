import type { APIRoute } from "astro";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { nanoid } from "nanoid";
import { sql, eq } from "drizzle-orm";
import { z } from "zod";

// Validation schema for social links
const socialLinkSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  iconUrl: z.string().optional(),
});

// Navigation item with recursive structure
const navigationItemSchema: z.ZodType<any> = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string().optional(),
  subMenu: z.lazy(() => z.array(navigationItemSchema)).optional(),
});

// Footer menu schema
const footerMenuSchema = z.object({
  id: z.string(),
  title: z.string(),
  links: z.array(navigationItemSchema),
});

// Complete footer config schema
const footerConfigSchema = z.object({
  logo: z.object({
    src: z.string(),
    alt: z.string(),
  }),
  tagline: z.string().optional().default(""),
  description: z.string().optional().default(""),
  copyrightText: z.string().optional().default(""),
  menus: z.array(footerMenuSchema),
  social: z.array(socialLinkSchema),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const config = await request.json();
    const validatedConfig = footerConfigSchema.parse(config);

    // Get existing settings
    const [existingSettings] = await db.select().from(siteSettings).limit(1);

    if (existingSettings) {
      // Update existing settings
      await db
        .update(siteSettings)
        .set({
          footerConfig: JSON.stringify(validatedConfig),
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(siteSettings.id, existingSettings.id));
    } else {
      // Create new settings
      await db.insert(siteSettings).values({
        id: "settings_" + nanoid(),
        siteName: "My Store",
        siteDescription: "",
        headerConfig: JSON.stringify({}),
        footerConfig: JSON.stringify(validatedConfig),
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error saving footer configuration:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid footer configuration",
          details: error.errors,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        error: "Failed to save footer configuration",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
