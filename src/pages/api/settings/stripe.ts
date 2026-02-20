// src/pages/api/settings/stripe.ts
// Admin API for Stripe gateway settings.
// GET  - returns current settings (secrets masked)
// POST - saves new settings to DB, invalidates KV cache

import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getKv } from "@/server/utils/kv-cache";
import {
  upsertSetting,
  invalidateStripeCache,
} from "@/lib/payment/gateway-settings";

const MASKED = "••••••••••••";
const CATEGORY = "stripe";

const KEYS = {
  secretKey: "secret_key",
  publishableKey: "publishable_key",
  webhookSecret: "webhook_secret",
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
      secretKey: map.secret_key ? MASKED : "",
      publishableKey: map.publishable_key ?? "",
      webhookSecret: map.webhook_secret ? MASKED : "",
      enabled: map.enabled !== "false",
    });
  } catch (error) {
    console.error("Error fetching Stripe settings:", error);
    return Response.json({ message: "Error fetching Stripe settings" }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as {
      secretKey?: string;
      publishableKey?: string;
      webhookSecret?: string;
      enabled?: boolean;
    };

    const ops: Promise<void>[] = [];

    if (typeof body.secretKey === "string" && body.secretKey !== MASKED && body.secretKey.trim()) {
      ops.push(upsertSetting(db, CATEGORY, KEYS.secretKey, body.secretKey.trim()));
    }

    if (typeof body.publishableKey === "string" && body.publishableKey !== MASKED) {
      ops.push(upsertSetting(db, CATEGORY, KEYS.publishableKey, body.publishableKey.trim()));
    }

    if (typeof body.webhookSecret === "string" && body.webhookSecret !== MASKED && body.webhookSecret.trim()) {
      ops.push(upsertSetting(db, CATEGORY, KEYS.webhookSecret, body.webhookSecret.trim()));
    }

    if (typeof body.enabled === "boolean") {
      ops.push(upsertSetting(db, CATEGORY, KEYS.enabled, String(body.enabled)));
    }

    await Promise.all(ops);

    // Invalidate KV cache so next request reads fresh settings
    await invalidateStripeCache(getKv());

    return Response.json({ message: "Stripe settings saved successfully" });
  } catch (error) {
    console.error("Error saving Stripe settings:", error);
    return Response.json({ message: "Error saving Stripe settings" }, { status: 500 });
  }
};
