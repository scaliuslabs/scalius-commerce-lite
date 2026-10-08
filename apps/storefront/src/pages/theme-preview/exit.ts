import type { APIRoute } from "astro";

import { appendClearThemePreviewCookies } from "@/lib/theme-preview-cookie";

export const prerender = false;

export const POST: APIRoute = async () => {
  const headers = new Headers({
    "Cache-Control": "private, no-cache, no-store, must-revalidate",
    "Location": "/",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  });
  appendClearThemePreviewCookies(headers);
  return new Response(null, { status: 303, headers });
};

export const ALL: APIRoute = async () => new Response("Method not allowed", {
  status: 405,
  headers: {
    "Allow": "POST",
    "Cache-Control": "no-store",
  },
});
