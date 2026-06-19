# Codebase Map

Last reviewed: 2026-06-19

## Runtime Shape

Scalius Commerce is a pnpm/Turborepo monorepo with three Cloudflare Worker applications:

- `apps/api` - Hono + `@hono/zod-openapi` API worker. `apps/api/src/worker.ts` exports a `WorkerEntrypoint` with `fetch`, `queue`, and `scheduled`. `apps/api/src/app.ts` mounts routes under `/api/v1`, initializes D1/KV/R2 per request, applies CORS/security headers, exposes Swagger/OpenAPI, and uses JSON error envelopes.
- `apps/admin-v2` - TanStack Start admin dashboard. Admin data flows through route loaders/components, typed domain server-function slices under `src/lib/api-functions/`, route query wrappers under `src/lib/api-query-options/`, domain mutation hooks under `src/lib/api-mutations/`, and `src/lib/api.server.ts`. The former broad `src/lib/api.functions.ts`/`api.queries.ts` barrels have been removed; `src/lib/api.mutations.ts` remains only as a compatibility re-export barrel. Server functions unwrap standard API envelopes through `api.server.ts`; the browser proxy path under `src/routes/api/v1/admin/$.ts` passes API responses through unchanged.
- `apps/storefront` - Astro SSR storefront with React islands. It calls the API through `env.BACKEND_API` where available, uses edge/L1/L2 caching in `src/lib/*cache*`, and has checkout proxy routes that unwrap API `.data` before returning browser-facing payloads.

## Package Roles

- `packages/database` - Drizzle schema, D1 client factory, and migrations.
- `packages/core` - domain logic: orders, inventory, payments, delivery, notifications, settings, catalog, content, media, search, auth integration.
- `packages/shared` - pure utilities shared by apps.
- `packages/api-client` - generated OpenAPI SDK and generated types. Regenerate with `pnpm generate:sdk` after API contract changes.
- `packages/tsconfig` - shared TypeScript configs.

## Important Contracts

- API success responses must be `{ success: true, data: T }`. Do not nest another `success` or `data` inside `T`.
- API errors must use the standardized JSON error envelope via `ApiError`/global handlers.
- 202 responses still need `{ success: true, data: ... }` at top level.
- Runtime secrets must come from Cloudflare `env`, not `import.meta.env`.
- New provider credential writes require `CREDENTIAL_ENCRYPTION_KEY`; legacy/JWT/plaintext tolerance belongs only on read paths for existing data. Delivery-provider saves are write-strict through `saveDeliveryProvider()` and decrypt-before-mask/merge existing credential rows, including `webhookSecret`. Fraud-checker provider configs are encrypted JSON blobs under `settings.fraud-checker` and route writes use `requireEncryptionKey()`. Firebase service-account saves are also write-strict and store `enc:` AES-GCM values under `settings.firebase/service_account`; FCM OAuth bearer tokens may use `SHARED_AUTH_CACHE` only as encrypted `enc:` values when the dedicated key is present.
- Meta WhatsApp Cloud API access tokens live in encrypted `settings.whatsapp/access_token`; `site_settings.whatsapp_access_token` is legacy fallback only, and auth OTP queue messages must not carry provider secrets. `getWhatsAppCloudApiSettings()` accepts a tolerant read key plus an explicit `migrationEncryptionKey`; only the dedicated migration key may create encrypted migration rows or clear the legacy column.
- Admin in-tab idle navigation relies on `apps/admin-v2/src/lib/admin-route-context.ts`: verified route context is fresh for 1 minute, stale-while-revalidated until a 4-hour hard cap, and explicitly cleared through `refreshAdminRouteContext(router)` after profile/security/session/permission changes. Auth/setup/2FA success paths navigate through TanStack Router instead of hard reloading, the auth guard caches only positive admin-exists reads briefly, no-cookie auth guards skip Better Auth binding initialization/session reads after setup detection, and RBAC loading reuses the fresh Better Auth `user.isSuperAdmin` value to avoid a duplicate D1 read. Cold SSR remains authoritative for authenticated requests and still performs real auth/session/RBAC reads, but the admin dashboard home intentionally does not block SSR or client route entry on metrics. It fetches `/api/v1/admin/dashboard/home-summary` after hydration/navigation and keeps the full `/dashboard/summary` contract for legacy callers.
- Catalog and attribute writes must keep storefront listing caches warm after freshness bumps: `invalidateCatalogCaches()` warms canonical `/search` for product/category/discount writes, category/product routes add affected `/categories/{slug}` paths when cheaply known, and attribute metadata/value writes pass `{ htmlPaths: ["/search"] }` through `invalidateApiAndScheduleStorefrontGroups()`. These exact paths ride the storefront prefix purge payload, are canonicalized/capped, and are warmed after the global version moves.
- The 2026-06-19 provider-secret credential-hardening backlog is addressed for payment, delivery, fraud checker, Firebase/FCM, and WhatsApp legacy migration. Browser FCM registration tokens remain a separate at-rest design question if the threat model later treats device tokens as credentials.
- Storefront must not import `@scalius/core` or `@scalius/database` directly.
- Schema changes require matching Drizzle migrations.
- Typecheck matters: `pnpm build` alone can miss TypeScript regressions.

## Verification Baseline

Use this loop for each issue:

1. Fix one issue with the smallest production-quality change.
2. Run targeted tests/typechecks.
3. Commit with the GitHub issue number in the message.
4. Deploy when the issue affects production behavior.
5. Verify in Chrome or via production API after the page/API has settled.
6. Keep `git status --short` clean before moving to the next issue.

Current full-suite baseline lives in `audit/README.md` and `audit/REMEDIATION_TRACKER.md`. Use those files for the latest test count, deployment versions, and live-smoke evidence instead of this historical map.
