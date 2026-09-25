# Platform Module

The deployment's public origins (storefront, API, dashboard, media), the customer cookie domain, extra CORS origins and identity handoff, stored in the `platform` settings document (Settings → System → Platform, `GET /api/v1/platform`). `resolvePlatformConfig()` reads them KV-first once per Worker invocation for `apps/api/src/runtime/runtime-env.ts`; the Worker entry loads only this module, not all of settings.

Public entry: `index.ts` (`platform-settings.service.ts`).
