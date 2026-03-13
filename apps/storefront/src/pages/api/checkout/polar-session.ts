// src/pages/api/checkout/polar-session.ts
// Server-side proxy: initializes a Polar checkout session via the backend.

import type { APIRoute } from "astro";
import { fetchWithRetry, createApiUrl } from "@/lib/api/client";

export const POST: APIRoute = async ({ request }) => {
    try {
        const payload = await request.json() as Record<string, unknown>;
        console.log("[checkout/polar-session] Requesting session for order:", payload.orderId);

        const res = await fetchWithRetry(
            createApiUrl("/payment/polar/session"),
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            },
            2,     // retries
            15000, // 15s timeout
            true,  // requiresAuth
        );

        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
            console.error("[checkout/polar-session] Backend error:", res.status, JSON.stringify(data));
            return new Response(JSON.stringify({ error: (data.error as string) || "Payment session creation failed" }), {
                status: res.status,
                headers: { "Content-Type": "application/json" },
            });
        }

        console.log("[checkout/polar-session] Session created, gatewayUrl present:", !!data.gatewayUrl);
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[checkout/polar-session] Proxy error:", errMsg);
        return new Response(JSON.stringify({ error: `Payment gateway error: ${errMsg}` }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
};
