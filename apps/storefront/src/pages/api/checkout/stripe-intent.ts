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

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      return new Response(JSON.stringify({ error: (data.error as string) || "Payment initialization failed" }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
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
