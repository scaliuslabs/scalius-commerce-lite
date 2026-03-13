// src/pages/api/checkout/create-order.ts
// Server-side proxy: creates an order in the backend using the service API token.
// The API_TOKEN is only available server-side, never exposed to the browser.

import type { APIRoute } from "astro";
import { createOrder } from "@/lib/api/orders";

export const POST: APIRoute = async ({ request }) => {
  try {
    const payload = (await request.json()) as import("@/lib/api/types").CreateOrderPayload;

    const result = await createOrder(payload);

    if (!result.success) {
      return new Response(JSON.stringify({ success: false, error: result.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      data: { id: result.orderId }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[checkout/create-order] Error:", err);
    return new Response(JSON.stringify({ success: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
