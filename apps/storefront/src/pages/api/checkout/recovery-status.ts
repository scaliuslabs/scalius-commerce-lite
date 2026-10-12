import type { APIRoute } from "astro";
import { apiFetch } from "@/lib/api/transport";

export const prerender = false;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** A read-only status lookup; neither checkout identity nor receipt proof enters a URL. */
export const POST: APIRoute = async ({ request }) => {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return reply({ success: false }, 403);
  }
  const payload = await request.json().catch(() => null) as { statusToken?: unknown } | null;
  if (typeof payload?.statusToken !== "string" || !/^cst_[a-f0-9]{64}$/.test(payload.statusToken)) {
    return reply({ success: false }, 400);
  }
  try {
    const response = await apiFetch(`/orders/status/${payload.statusToken}`, {
      cache: "no-store",
    }, { auth: false, retries: 0, timeout: 5_000 });
    if (!response.ok) return reply({ success: false }, 503);
    const result = await response.json() as {
      success?: unknown;
      data?: { status?: unknown; orderId?: unknown };
    } | null;
    const status = result?.data?.status;
    const orderId = result?.data?.orderId;
    if (result?.success !== true || typeof status !== "string") return reply({ success: false }, 502);
    return reply({ success: true, data: {
      status: status === "expired" || status === "completed" ? status : "unknown",
      ...(typeof orderId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(orderId) ? { orderId } : {}),
    } });
  } catch {
    return reply({ success: false }, 503);
  }
};
