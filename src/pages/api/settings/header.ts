import type { APIRoute } from "astro";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { nanoid } from "nanoid";
import { sql, eq } from "drizzle-orm";
import { z } from "zod";

// Validation schema for header configuration
const socialLinkSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  iconUrl: z.string().optional(),
});

const navigationItemSchema: z.ZodType<any> = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string().optional(),
  subMenu: z.lazy(() => z.array(navigationItemSchema)).optional(),
});

const headerConfigSchema = z.object({
  topBar: z.object({
    text: z.string(),
    isEnabled: z.boolean().optional().default(true),
  }),
  logo: z.object({
    src: z.string(),
    alt: z.string(),
  }),
  favicon: z.object({
    src: z.string(),
    alt: z.string(),
  }),
  contact: z.object({
    phone: z.string(),
    text: z.string(),
    isEnabled: z.boolean().optional().default(true),
  }),
  social: z.array(socialLinkSchema),
  navigation: z.array(navigationItemSchema),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const config = await request.json();
    const validatedConfig = headerConfigSchema.parse(config);

    // Get existing settings
    const [existingSettings] = await db.select().from(siteSettings).limit(1);

    if (existingSettings) {
      // Update existing settings
      await db
        .update(siteSettings)
        .set({
          headerConfig: JSON.stringify(validatedConfig),
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(siteSettings.id, existingSettings.id));
    } else {
      // Create new settings
      await db.insert(siteSettings).values({
        id: "settings_" + nanoid(),
        siteName: "My Store",
        siteDescription: "",
        headerConfig: JSON.stringify(validatedConfig),
        footerConfig: JSON.stringify({}),
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error saving header configuration:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid header configuration",
          details: error.errors,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        error: "Failed to save header configuration",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
