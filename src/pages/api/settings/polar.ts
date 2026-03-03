// src/pages/api/settings/polar.ts
// Admin API for Polar gateway settings.
// GET  - returns current settings (secrets masked)
// POST - saves new settings to DB, invalidates KV cache

import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getKv } from "@/server/utils/kv-cache";
import {
    upsertSetting,
    invalidatePolarCache,
    invalidatePaymentMethodsCache,
} from "@/lib/payment/gateway-settings";

const MASKED = "••••••••••••";
const CATEGORY = "polar";

const KEYS = {
    accessToken: "access_token",
    webhookSecret: "webhook_secret",
    productId: "product_id",
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
            accessToken: map.access_token ? MASKED : "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            productId: map.product_id ?? "",
            sandbox: map.sandbox !== "false",
            enabled: map.enabled !== "false",
        });
    } catch (error) {
        console.error("Error fetching Polar settings:", error);
        return Response.json({ message: "Error fetching Polar settings" }, { status: 500 });
    }
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json() as {
            accessToken?: string;
            webhookSecret?: string;
            productId?: string;
            sandbox?: boolean;
            enabled?: boolean;
        };

        const ops: Promise<void>[] = [];

        if (typeof body.accessToken === "string" && body.accessToken !== MASKED && body.accessToken.trim()) {
            ops.push(upsertSetting(db, CATEGORY, KEYS.accessToken, body.accessToken.trim()));
        }

        if (typeof body.webhookSecret === "string" && body.webhookSecret !== MASKED && body.webhookSecret.trim()) {
            ops.push(upsertSetting(db, CATEGORY, KEYS.webhookSecret, body.webhookSecret.trim()));
        }

        if (typeof body.productId === "string" && body.productId.trim()) {
            ops.push(upsertSetting(db, CATEGORY, KEYS.productId, body.productId.trim()));
        }

        if (typeof body.sandbox === "boolean") {
            ops.push(upsertSetting(db, CATEGORY, KEYS.sandbox, String(body.sandbox)));
        }

        if (typeof body.enabled === "boolean") {
            ops.push(upsertSetting(db, CATEGORY, KEYS.enabled, String(body.enabled)));
        }

        await Promise.all(ops);

        // Invalidate KV cache so next request reads fresh settings
        const kv = getKv();
        await Promise.all([
            invalidatePolarCache(kv),
            invalidatePaymentMethodsCache(kv),
        ]);

        return Response.json({ message: "Polar settings saved successfully" });
    } catch (error) {
        console.error("Error saving Polar settings:", error);
        return Response.json({ message: "Error saving Polar settings" }, { status: 500 });
    }
};
