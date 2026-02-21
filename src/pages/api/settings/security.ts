// src/pages/api/settings/security.ts
import type { APIRoute } from "astro";
import { db } from "../../../db";
import { settings } from "../../../db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

const CATEGORY = "security";
const KEY_CSP_ALLOWED = "csp_allowed_domains";

export const GET: APIRoute = async () => {
    try {
        const row = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, KEY_CSP_ALLOWED), eq(settings.category, CATEGORY)))
            .get();

        return new Response(JSON.stringify({ cspAllowedDomains: row?.value || "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        console.error("Error fetching security settings:", error);
        return new Response(JSON.stringify({ message: "Error fetching security settings" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
};

export const POST: APIRoute = async ({ request, locals }) => {
    try {
        const body = await request.json();
        const { cspAllowedDomains } = body as { cspAllowedDomains?: string };

        if (typeof cspAllowedDomains === "string") {
            // 1. Save to SQLite Database
            await db
                .insert(settings)
                .values({
                    id: `set_${nanoid(10)}`,
                    key: KEY_CSP_ALLOWED,
                    value: cspAllowedDomains,
                    type: "string",
                    category: CATEGORY,
                })
                .onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: cspAllowedDomains, updatedAt: new Date() },
                });

            // 2. Propagate to Cloudflare KV Cache
            // The Cloudflare Env is exposed on locals.runtime.env
            const env = (locals as any).runtime?.env;
            if (env?.CACHE) {
                // We use waitUntil so we don't block the API response
                (locals as any).runtime.ctx.waitUntil(
                    env.CACHE.put("security:csp_allowed_domains", cspAllowedDomains)
                );
            } else {
                console.warn("CACHE binding not found. Could not update KV.");
            }
        }

        return new Response(
            JSON.stringify({ message: "Security settings saved successfully" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    } catch (error) {
        console.error("Error saving security settings:", error);
        return new Response(
            JSON.stringify({ message: "Error saving security settings" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
        );
    }
};
