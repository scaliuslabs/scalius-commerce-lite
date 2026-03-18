// src/pages/api/auth/[...all].ts
import type { APIRoute } from "astro";
import { createAuth } from "@scalius/core/auth";

export const prerender = false;

// Handle all HTTP methods for Better Auth
export const ALL: APIRoute = async (ctx) => {
  // Get environment from Astro context (Cloudflare Workers)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Astro Locals type lacks cfContext from Cloudflare adapter
  const env = (ctx.locals as any).cfContext?.env || process.env;
  const auth = createAuth(env);

  return auth.handler(ctx.request);
};
