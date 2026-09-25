// Is this order in the signed-in buyer's account? The receipt asks when a
// signed-in buyer opens an order saved to some account. "Not yours" is a
// normal answer, so it comes back as 200 `{ owned: false }` rather than the
// account order read's 404, which the browser would log as an error.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { resolveBackendTarget } from "@/lib/api/transport";
import { appendRewrittenCustomerAuthSetCookies } from "@/lib/customer-auth-proxy-cookies";

export const prerender = false;

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** The account order read's answers that mean "not this account's order". */
const NOT_OWNED_STATUSES = new Set([401, 403, 404]);

const json = (body: unknown, status = 200, headers = new Headers()) => {
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "private, no-store");
  return new Response(JSON.stringify(body), { status, headers });
};

export const GET: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return json({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }
  const orderId = params.id ?? "";
  if (!ORDER_ID_PATTERN.test(orderId)) return json({ success: true, owned: false });

  const target = resolveBackendTarget(`/api/v1/customer-auth/orders/${encodeURIComponent(orderId)}`);
  if (!target) return json({ success: false, owned: false }, 503);

  const headers = new Headers({ Accept: "application/json" });
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  try {
    const apiResponse = await target.fetch(target.url, { method: "GET", headers });
    // Only the answer leaves this route; the order itself never does.
    await apiResponse.body?.cancel().catch(() => undefined);
    const responseHeaders = new Headers();
    appendRewrittenCustomerAuthSetCookies(responseHeaders, apiResponse.headers);
    if (apiResponse.ok) return json({ success: true, owned: true }, 200, responseHeaders);
    if (NOT_OWNED_STATUSES.has(apiResponse.status)) return json({ success: true, owned: false }, 200, responseHeaders);
    return json({ success: false, owned: false }, 502, responseHeaders);
  } catch {
    return json({ success: false, owned: false }, 502);
  }
};
