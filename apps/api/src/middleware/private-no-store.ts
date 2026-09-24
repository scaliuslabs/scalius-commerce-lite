import type { Context, Next } from "hono";

/**
 * Dashboard responses carry merchant data, including refusals: no browser,
 * proxy or back/forward cache may keep them. Set before next() so an error
 * response built from this context (onError) carries it too.
 */
export async function privateNoStore(c: Context, next: Next): Promise<void> {
  c.header("Cache-Control", "private, no-store");
  await next();
  if (!c.res.headers.get("Cache-Control")?.includes("no-store")) {
    c.res.headers.set("Cache-Control", "private, no-store");
  }
}
