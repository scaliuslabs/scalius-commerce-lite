import type { APIRoute } from "astro";

import { clearThemePreviewCookieHeader } from "@/lib/theme-preview-cookie";

export const prerender = false;

export const POST: APIRoute = async () => new Response(null, {
  status: 303,
  headers: {
    "Cache-Control": "private, no-cache, no-store, must-revalidate",
    "Location": "/",
    "Referrer-Policy": "no-referrer",
    "Set-Cookie": clearThemePreviewCookieHeader(),
    "X-Robots-Tag": "noindex, nofollow",
  },
});

export const ALL: APIRoute = async () => new Response("Method not allowed", {
  status: 405,
  headers: {
    "Allow": "POST",
    "Cache-Control": "no-store",
  },
});
