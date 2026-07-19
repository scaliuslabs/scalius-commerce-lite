import type { APIRoute } from "astro";

import { resolveThemePreview } from "@/lib/api";
import { createThemePreviewCookieHeader } from "@/lib/theme-preview-cookie";
import { isThemePreviewToken } from "@scalius/shared/theme-preview-handoff";

export const prerender = false;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: PRIVATE_HEADERS });
}

export const POST: APIRoute = async ({ request }) => {
  const origin = request.headers.get("Origin");
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return jsonError(403, "Forbidden");
  }
  if (!origin || origin !== expectedOrigin) return jsonError(403, "Forbidden");

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") return jsonError(415, "JSON required");

  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 2048) {
    return jsonError(413, "Request too large");
  }

  let payload: unknown;
  try {
    const text = await request.text();
    if (text.length > 2048) return jsonError(413, "Request too large");
    payload = JSON.parse(text);
  } catch {
    return jsonError(400, "Invalid request");
  }

  const token =
    typeof payload === "object" && payload !== null && "token" in payload
      ? (payload as { token?: unknown }).token
      : null;
  if (!isThemePreviewToken(token)) return jsonError(400, "Invalid request");

  const preview = await resolveThemePreview(token);
  if (!preview) return jsonError(404, "Preview unavailable");

  const cookie = createThemePreviewCookieHeader(token);
  if (!cookie) return jsonError(400, "Invalid request");
  return new Response(null, {
    status: 204,
    headers: { ...PRIVATE_HEADERS, "Set-Cookie": cookie },
  });
};

export const ALL: APIRoute = async () => new Response("Method not allowed", {
  status: 405,
  headers: { ...PRIVATE_HEADERS, "Allow": "POST" },
});
