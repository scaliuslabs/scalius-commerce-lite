import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";

import { getPurgeTokenFromHeaders, PURGE_TOKEN_HEADER } from "@/lib/purge-auth";

export const prerender = false;

async function timingSafeCompare(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("scalius-storefront-purge-auth"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [leftSignature, rightSignature] = await Promise.all([
    crypto.subtle.sign("HMAC", key, leftBytes),
    crypto.subtle.sign("HMAC", key, rightBytes),
  ]);
  const leftView = new Uint8Array(leftSignature);
  const rightView = new Uint8Array(rightSignature);
  let difference = leftView.byteLength ^ rightView.byteLength;
  for (let index = 0; index < leftView.byteLength; index += 1) {
    difference |= leftView[index]! ^ rightView[index]!;
  }
  return difference === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

export const GET: APIRoute = async ({ url }) => {
  if (url.searchParams.has("token")) {
    return json(
      {
        error: `Purge token must be sent with Authorization: Bearer or ${PURGE_TOKEN_HEADER}`,
      },
      400,
    );
  }
  const response = json({ error: "Method Not Allowed" }, 405);
  response.headers.set("Allow", "POST");
  return response;
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const env = cfEnv as unknown as Env;
  if (!env.PURGE_TOKEN) return json({ error: "Server configuration error" }, 500);
  if (url.searchParams.has("token")) {
    return json(
      {
        error: `Purge token must be sent with Authorization: Bearer or ${PURGE_TOKEN_HEADER}`,
      },
      400,
    );
  }

  const providedToken = getPurgeTokenFromHeaders(request.headers);
  if (!providedToken || !(await timingSafeCompare(providedToken, env.PURGE_TOKEN))) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const groups =
    typeof body === "object" && body !== null && Array.isArray((body as { groups?: unknown }).groups)
      ? [...new Set((body as { groups: unknown[] }).groups)]
      : [];
  if (
    groups.length === 0 ||
    groups.length > 30 ||
    groups.some((group) => typeof group !== "string" || group.length > 64)
  ) {
    return json({ error: "groups must contain 1 to 30 bounded strings" }, 400);
  }

  const nativePurger = locals.cfContext.exports?.PublicStorefront;
  if (!nativePurger) return json({ error: "Public cache entrypoint unavailable" }, 503);

  try {
    await nativePurger.purgeGroups(groups as string[]);
    return json({ success: true, groups }, 200);
  } catch (error: unknown) {
    console.error("Native storefront cache purge failed:", error);
    return json({ error: "Failed to purge storefront cache" }, 503);
  }
};
