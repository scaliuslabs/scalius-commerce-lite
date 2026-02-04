// src/pages/api/auth/[...all].ts
import type { APIRoute } from "astro";
import { createAuth } from "@/lib/auth";

export const prerender = false;

// Handle all HTTP methods for Better Auth
export const ALL: APIRoute = async (ctx) => {
  // Get environment from Astro context (Cloudflare Workers)
  const env = ctx.locals.runtime?.env || process.env;
  const auth = createAuth(env);

  return auth.handler(ctx.request);
};
