// src/pages/api/settings/theme.ts
// Admin API for storefront theme color settings.
// GET  - returns current theme color overrides
// POST - saves new color overrides to DB, invalidates layout KV cache

import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { upsertSetting } from "@/lib/payment/gateway-settings";
import { getKv } from "@/server/utils/kv-cache";
import { deleteCacheByPattern } from "@/server/utils/kv-cache";

const CATEGORY = "theme";
const KEY = "storefront_colors";

export const GET: APIRoute = async () => {
    try {
        const row = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.category, CATEGORY), eq(settings.key, KEY)))
            .get();

        const colors = row?.value ? JSON.parse(row.value) : {};
        return Response.json({ colors });
    } catch (error) {
        console.error("Error fetching theme settings:", error);
        return Response.json({ message: "Error fetching theme settings" }, { status: 500 });
    }
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = (await request.json()) as { colors?: Record<string, string> };

        if (!body.colors || typeof body.colors !== "object") {
            return Response.json({ message: "Invalid colors payload" }, { status: 400 });
        }

        // Persist as JSON blob
        await upsertSetting(db, CATEGORY, KEY, JSON.stringify(body.colors));

        // Invalidate layout KV cache so the storefront picks up new colors
        const kv = getKv();
        if (kv) {
            await deleteCacheByPattern("api:storefront:layout:*", kv);
        }

        return Response.json({ message: "Theme settings saved successfully" });
    } catch (error) {
        console.error("Error saving theme settings:", error);
        return Response.json({ message: "Error saving theme settings" }, { status: 500 });
    }
};
