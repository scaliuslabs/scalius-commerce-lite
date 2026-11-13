// Same-origin proxy for customer auth endpoints.
//
// The storefront and API may be on different domains. Modern browsers
// silently drop cross-origin Set-Cookie headers, even with
// SameSite=None + credentials:include.
//
// This proxy ensures all customer auth requests go through the
// storefront's own origin so cookies (cs_tok, cs_auth) are set and
// sent correctly.
//
// Production: routes through BACKEND_API service binding (zero latency).
// Local dev: forwards via HTTP to the local API worker.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { resolveBackendTarget } from "@/lib/api/transport";
import { appendRewrittenCustomerAuthSetCookies } from "@/lib/customer-auth-proxy-cookies";
import { OWN_CSP_MARKER } from "@/lib/middleware-helper/own-csp";
import { FORM_REQUEST_MAX_BYTES, limitedBodyStream, payloadTooLargeResponse } from "@/lib/bounded-body";
import { MAX_FORM_BYTES } from "@/lib/account-inbox-server";

export const prerender = false;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);


export const ALL: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ success: false, error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const subpath = params.path || "";

  // Security: reject path traversal and restrict to safe characters.
  // Record ids ("cust_…", nanoid) use letters, digits, "_" and "-".
  // "Continue with <app>" names an app provider (`<plugin id>:<provider id>`, a dot and a colon).
  const isIdentityFlow = /^identity\/[a-z0-9][a-z0-9.-]*:[a-z][a-z0-9_-]*\/(start|callback)$/.test(subpath);
  if (subpath.includes("..") || (!isIdentityFlow && !/^[a-zA-Z0-9_/-]*$/.test(subpath))) {
    return new Response("Bad request", { status: 400 });
  }

  // The query goes along too: the order history pages with ?cursor=&limit=.
  const apiPath = `/api/v1/customer-auth/${subpath}${new URL(request.url).search}`;

  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response("Method not allowed", { status: 405 });
  }

  // Production: service binding; local dev: HTTP to the local API worker.
  // A production Worker without the binding fails closed.
  const target = resolveBackendTarget(apiPath);
  if (!target) {
    return new Response(JSON.stringify({ success: false, error: { code: "service_unavailable", message: "We couldn't reach the store. Check your connection and try again." } }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }

  // The body goes on unread, but never past its limit (bounded-body.ts): an
  // upload form up to the largest buyer form, anything else the API's form class.
  const multipart = request.headers.get("Content-Type")?.toLowerCase().startsWith("multipart/form-data") ?? false;
  const limited = limitedBodyStream(request, multipart ? MAX_FORM_BYTES : FORM_REQUEST_MAX_BYTES);
  if (!limited.ok) return payloadTooLargeResponse();

  // Forward the request, preserving method, headers, and body
  const headers = new Headers(request.headers);
  // Remove host header so the API worker gets the correct one
  headers.delete("host");

  try {
    const apiResponse = await target.fetch(target.url, {
      method: request.method,
      headers,
      body: limited.body,
      // @ts-ignore — needed for streaming request bodies in non-service-binding path
      ...(target.viaServiceBinding ? {} : { duplex: "half" }),
    });

    // Build the response, passing through status, body, and headers
    const responseHeaders = new Headers();

    // Copy all non-cookie headers from API response.
    // Set-Cookie needs dedicated handling because Headers.entries() may collapse
    // multiple cookies into one comma-joined value on some runtimes.
    for (const [key, value] of apiResponse.headers.entries()) {
      const lk = key.toLowerCase();
      // Skip hop-by-hop headers
      if (lk === "transfer-encoding") continue;

      if (lk === "set-cookie") continue;
      // Only this storefront's own code may mark a policy as its own.
      if (lk === OWN_CSP_MARKER.toLowerCase()) continue;

      responseHeaders.append(key, value);
    }
    appendRewrittenCustomerAuthSetCookies(responseHeaders, apiResponse.headers);

    return new Response(apiResponse.body, {
      status: apiResponse.status,
      statusText: apiResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    if (limited.exceeded()) return payloadTooLargeResponse();
    console.error("[customer-auth proxy] Error:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({
      success: false,
      error: { code: "service_unavailable", message: "We couldn't reach the store. Check your connection and try again." },
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }
};
