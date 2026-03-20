// src/pages/api/auth/[...all].ts
import type { APIRoute } from "astro";
import { createAuth } from "@scalius/core/auth";

export const prerender = false;

// Handle all HTTP methods for Better Auth
export const ALL: APIRoute = async (ctx) => {
  const env = ctx.locals._env;
  const auth = createAuth(env);

  return auth.handler(ctx.request);
};
