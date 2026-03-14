// src/pages/api/checkout/stripe-intent.ts
// Server-side proxy: creates a Stripe PaymentIntent via the backend.

import type { APIRoute } from "astro";
import { fetchWithRetry, createApiUrl } from "@/lib/api/client";

export const POST: APIRoute = async ({ request }) => {
  try {
    const payload = await request.json();

    const res = await fetchWithRetry(createApiUrl("/payment/stripe/intent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await res.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown };

    if (!res.ok) {
      const errMsg = typeof json.error === "string" ? json.error : (json.error as Record<string, unknown>)?.message || "Payment initialization failed";
      return new Response(JSON.stringify({ error: errMsg }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Unwrap { success, data } envelope — checkout page reads fields directly
    return new Response(JSON.stringify(json.data || json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[checkout/stripe-intent] Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
