// src/pages/api/settings/sslcommerz.ts
// Admin API for SSLCommerz gateway settings.
// GET  - returns current settings (secrets masked)
// POST - saves new settings to DB, invalidates KV cache

import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getKv } from "@/server/utils/kv-cache";
import {
  upsertSetting,
  invalidateSSLCommerzCache,
} from "@/lib/payment/gateway-settings";

const MASKED = "••••••••••••";
const CATEGORY = "sslcommerz";

const KEYS = {
  storeId: "store_id",
  storePassword: "store_password",
  sandbox: "sandbox",
  enabled: "enabled",
} as const;

export const GET: APIRoute = async () => {
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(eq(settings.category, CATEGORY))
      .all();

    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    return Response.json({
      storeId: map.store_id ?? "",
      // Mask the password
      storePassword: map.store_password ? MASKED : "",
      sandbox: map.sandbox !== "false",
      enabled: map.enabled !== "false",
    });
  } catch (error) {
    console.error("Error fetching SSLCommerz settings:", error);
    return Response.json({ message: "Error fetching SSLCommerz settings" }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as {
      storeId?: string;
      storePassword?: string;
      sandbox?: boolean;
      enabled?: boolean;
    };

    const ops: Promise<void>[] = [];

    if (typeof body.storeId === "string" && body.storeId.trim()) {
      ops.push(upsertSetting(db, CATEGORY, KEYS.storeId, body.storeId.trim()));
    }

    if (typeof body.storePassword === "string" && body.storePassword !== MASKED && body.storePassword.trim()) {
      ops.push(upsertSetting(db, CATEGORY, KEYS.storePassword, body.storePassword.trim()));
    }

    if (typeof body.sandbox === "boolean") {
      ops.push(upsertSetting(db, CATEGORY, KEYS.sandbox, String(body.sandbox)));
    }

    if (typeof body.enabled === "boolean") {
      ops.push(upsertSetting(db, CATEGORY, KEYS.enabled, String(body.enabled)));
    }

    await Promise.all(ops);

    // Invalidate KV cache
    await invalidateSSLCommerzCache(getKv());

    return Response.json({ message: "SSLCommerz settings saved successfully" });
  } catch (error) {
    console.error("Error saving SSLCommerz settings:", error);
    return Response.json({ message: "Error saving SSLCommerz settings" }, { status: 500 });
  }
};
