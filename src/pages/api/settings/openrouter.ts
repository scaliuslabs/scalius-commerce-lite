import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

// SECURITY: Masked value for sensitive fields
const MASKED_VALUE = "••••••••••••";
const SETTING_KEY = "openrouter_api_key";
const SETTING_CATEGORY = "integrations";

export const GET: APIRoute = async () => {
  try {
    const result = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, SETTING_KEY), eq(settings.category, SETTING_CATEGORY)))
      .get();

    // SECURITY: Mask API key before sending to client
    // Return empty string if no key exists (to indicate "not set" vs "masked")
    const maskedApiKey = result?.value ? MASKED_VALUE : "";

    return new Response(JSON.stringify({ apiKey: maskedApiKey }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching OpenRouter API key:", error);
    return new Response(JSON.stringify({ message: "Error fetching API key" }), {
      status: 500,
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    let { apiKey } = await request.json();

    if (typeof apiKey !== "string") {
      return new Response(JSON.stringify({ message: "Invalid API key" }), {
        status: 400,
      });
    }

    // SECURITY: If API key is masked, don't update it
    if (apiKey === MASKED_VALUE) {
      return new Response(
        JSON.stringify({ message: "API key unchanged (masked value provided)" }),
        {
          status: 200,
        },
      );
    }

    await db
      .insert(settings)
      .values({
        id: `set_${nanoid(10)}`,
        key: SETTING_KEY,
        value: apiKey,
        type: "string",
        category: SETTING_CATEGORY,
      })
      .onConflictDoUpdate({
        target: [settings.key, settings.category],
        set: { value: apiKey },
      });

    return new Response(
      JSON.stringify({ message: "API key saved successfully" }),
      {
        status: 200,
      },
    );
  } catch (error) {
    console.error("Error saving OpenRouter API key:", error);
    return new Response(JSON.stringify({ message: "Error saving API key" }), {
      status: 500,
    });
  }
};
