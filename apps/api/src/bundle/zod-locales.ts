// The API Worker's zod locale catalogue (apps/api/wrangler.jsonc `alias` for
// "../locales/index.js"): none. zod re-exports every locale as `z.locales`,
// and @hono/zod-openapi's `extendZodWithOpenApi(z)` passes `z` as a value, so
// Wrangler's esbuild must keep all of them (about 260 KB of JavaScript compiled
// at every isolate start). Nothing reads `z.locales`; zod's English messages
// come from "../locales/en.js", which this alias does not touch.
export {};
