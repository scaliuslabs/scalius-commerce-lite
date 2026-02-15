import type { APIRoute, APIContext } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { layoutCache, CACHE_KEYS } from "@/lib/layout-cache";

const CATEGORY = "firebase";
const KEY_SERVICE_ACCOUNT = "service_account";
const KEY_PUBLIC_CONFIG = "public_config";
const MASKED_VALUE = "••••••••••••";

export const GET: APIRoute = async (context) => {
  const { locals } = context as APIContext;

  // Authentication check (relies on Better Auth middleware)
  if (!locals.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  try {
    const results = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.category, CATEGORY));

    const config: any = {
      serviceAccount: "",
      publicConfig: {},
    };

    results.forEach((row) => {
      if (row.key === KEY_SERVICE_ACCOUNT) {
        config.serviceAccount = row.value ? MASKED_VALUE : "";
      } else if (row.key === KEY_PUBLIC_CONFIG) {
        try {
          config.publicConfig = JSON.parse(row.value);
        } catch (e) {
          config.publicConfig = {};
        }
      }
    });

    return new Response(JSON.stringify(config), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching Firebase settings:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
};

export const POST: APIRoute = async (context) => {
  const { request, locals } = context as APIContext;

  // Authentication check (relies on Better Auth middleware)
  if (!locals.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  try {
    const { serviceAccount, publicConfig } = await request.json();

    const updates = [];

    // Update Service Account if provided and not masked
    if (serviceAccount && serviceAccount !== MASKED_VALUE) {
      // Validate JSON
      try {
        JSON.parse(serviceAccount);
        updates.push({
          key: KEY_SERVICE_ACCOUNT,
          value: serviceAccount,
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Invalid Service Account JSON" }),
          { status: 400 }
        );
      }
    }

    // Update Public Config if provided
    if (publicConfig) {
      updates.push({
        key: KEY_PUBLIC_CONFIG,
        value: JSON.stringify(publicConfig),
      });
    }

    // Execute updates
    for (const update of updates) {
      await db
        .insert(settings)
        .values({
          id: `set_${nanoid(10)}`,
          key: update.key,
          value: update.value,
          type: "json",
          category: CATEGORY,
        })
        .onConflictDoUpdate({
          target: [settings.key, settings.category],
          set: { value: update.value, updatedAt: new Date() },
        });
    }

    // Invalidate layout cache so next page load gets fresh Firebase config
    layoutCache.invalidate(CACHE_KEYS.FIREBASE_CONFIG);

    return new Response(
      JSON.stringify({ message: "Settings saved successfully" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error saving Firebase settings:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
};
