// src/pages/api/settings/payment-methods.ts
// Admin API for configuring which payment methods are available on the storefront.
// GET  - returns current enabled methods + default
// POST - saves configuration, invalidates caches

import type { APIRoute } from "astro";
import { db } from "@/db";
import { getKv } from "@/server/utils/kv-cache";
import {
    upsertSetting,
    getActivePaymentMethods,
    getStripeSettings,
    getSSLCommerzSettings,
    invalidatePaymentMethodsCache,
} from "@/lib/payment/gateway-settings";
import { z } from "zod";

const CATEGORY = "payment_methods";

const updateSchema = z.object({
    enabledMethods: z.array(z.enum(["stripe", "sslcommerz", "cod"])).min(1, "At least one payment method is required"),
    defaultMethod: z.enum(["stripe", "sslcommerz", "cod"]),
});

export const GET: APIRoute = async () => {
    try {
        const kv = getKv();
        const config = await getActivePaymentMethods(db, kv);

        // Also return credential status for the UI
        const stripeSettings = await getStripeSettings(db);
        const sslSettings = await getSSLCommerzSettings(db);

        return Response.json({
            ...config,
            gatewayStatus: {
                stripe: {
                    configured: !!stripeSettings,
                    enabled: stripeSettings?.enabled ?? false,
                },
                sslcommerz: {
                    configured: !!sslSettings,
                    enabled: sslSettings?.enabled ?? false,
                },
                cod: {
                    configured: true,
                    enabled: true,
                },
            },
        });
    } catch (error) {
        console.error("Error fetching payment methods:", error);
        return Response.json({ error: "Failed to fetch payment methods" }, { status: 500 });
    }
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json();
        const data = updateSchema.parse(body);

        // Validate that default method is in enabled list
        if (!data.enabledMethods.includes(data.defaultMethod)) {
            return Response.json(
                { error: "Default method must be one of the enabled methods" },
                { status: 400 }
            );
        }

        // Save settings
        await Promise.all([
            upsertSetting(db, CATEGORY, "enabled_methods", JSON.stringify(data.enabledMethods)),
            upsertSetting(db, CATEGORY, "default_method", data.defaultMethod),
        ]);

        // Invalidate cache
        const kv = getKv();
        await invalidatePaymentMethodsCache(kv);

        return Response.json({ success: true, message: "Payment methods updated" });
    } catch (error) {
        console.error("Error saving payment methods:", error);
        if (error instanceof z.ZodError) {
            return Response.json(
                { error: "Invalid request data", details: error.errors },
                { status: 400 }
            );
        }
        return Response.json({ error: "Failed to save payment methods" }, { status: 500 });
    }
};
