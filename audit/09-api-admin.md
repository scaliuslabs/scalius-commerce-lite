# Admin API Audit

## Scope

This audit covers the admin API surface mounted under `/api/v1/admin/**`, with a focus on:

- Route registration and mount paths in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:267)
- Authentication and RBAC enforcement in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:24)
- Permission mapping in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:27)
- Route modules under [apps/api/src/routes/admin](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin)
- Related helpers where needed to confirm route-level behavior, especially [packages/database/src/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/client.ts:21), [packages/database/src/schema/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/schema/system.ts:10), and the scanner-token claim flow in [apps/admin-v2/src/routes/api/scanner-token.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:95)

This is a static code audit. I did not run live requests against the worker.

## How The Admin API Works End To End

1. Requests enter the Hono worker at `/api/v1` via [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:78).

2. Global middleware initializes D1, KV, and R2 bindings per request in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:111), then applies CORS, security headers, and proxy headers in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:120).

3. Every `/admin/*` request passes through [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:24).
   It accepts one of three auth modes:
   - Better Auth session cookie via `auth.api.getSession()`
   - Bearer JWT via the custom JWT helper
   - Scanner token via `X-Scanner-Token`

4. For non-scanner callers, `adminAuthMiddleware` loads effective permissions through [packages/core/src/auth/rbac/helpers.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/helpers.ts:47) and then consults [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:723) for fine-grained route authorization.

5. Routes are mounted one module at a time in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:275). Some settings routes are mounted through the aggregator in [apps/api/src/routes/admin/settings.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings.ts:14), while others are mounted separately in `app.ts`, which matters for permission-map drift.

6. Most handlers use `createRoute()` and `c.req.valid()` with standardized envelopes from [apps/api/src/utils/api-response.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/utils/api-response.ts:30). In practice, this slice is only partially “thin HTTP”; several handlers still embed business logic, background cleanup, and direct persistence decisions in the route layer.

## Findings

1. **[P0] Fine-grained RBAC silently degrades to “any admin with any permission” for a large portion of the admin API.**

   The middleware only enforces a route-specific permission if `getRoutePermission()` returns a match; otherwise it falls back to the coarse `userPerms.size > 0` gate in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:109). The route map has drifted badly from the actual mounts in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:272): products are still keyed under `/api/products*` instead of `/api/v1/admin/products*` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:31), many settings endpoints are still keyed under `/api/settings/*` instead of `/api/v1/admin/settings/*` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:412), dashboard is keyed under `/api/dashboard*` instead of `/api/v1/admin/dashboard` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:600), and inventory is keyed under `/api/inventory/*` instead of `/api/v1/admin/inventory/*` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:646). A static comparison of route declarations against `getRoutePermission()` found **113 uncovered route+method combinations out of 270** in this slice. That means users with a single unrelated permission can hit large areas of products, inventory, settings, dashboard, refunds, invoices, media mutations, and other sensitive admin endpoints.

   Key refs: [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:123), [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:275), [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:27), [apps/api/src/routes/admin/products.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/products.ts:35), [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:120), [apps/api/src/routes/admin/settings/payments.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/payments.ts:71)

2. **[P1] `GET /admin/abandoned-checkouts` performs destructive cleanup and order deletion behind a read-only permission.**

   The handler named “List abandoned checkouts” deletes old abandoned-checkout rows, migrates old `INCOMPLETE` orders into `abandoned_checkouts`, and then deletes those orders from `orders` inside the GET handler in [apps/api/src/routes/admin/system-utils.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/system-utils.ts:54). The RBAC map treats `GET /api/v1/admin/abandoned-checkouts` as `orders.view` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:568). So a user who should only be able to view order data can trigger writes and deletions simply by opening the page. This violates HTTP semantics, collapses “view” and “delete” privileges, and makes observability and incident response much harder because reads have side effects.

   Key refs: [apps/api/src/routes/admin/system-utils.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/system-utils.ts:34), [apps/api/src/routes/admin/system-utils.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/system-utils.ts:57), [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:568)

3. **[P1] Scanner-token “device binding” is enforced in the admin app, but ignored by the API worker.**

   The token-claim route binds a claimed scanner token to a `scanner_sid` cookie and rejects reuse from another device in [apps/admin-v2/src/routes/api/scanner-token.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:110). But the admin API middleware only checks whether the KV payload exists and `payload.claimed` is true in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:62). It never verifies the bound `sessionId`, never checks the cookie, and then skips full RBAC for any `/inventory/` path in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:98). In practice, possession of the raw scanner token is enough to impersonate the scanner flow from another client. The API-side trust model is weaker than the token-issuance flow assumes.

   Key refs: [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:62), [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:98), [apps/admin-v2/src/routes/api/scanner-token.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:110)

4. **[P1] Admin session handling does not enforce 2FA verification and does not propagate session state needed by 2FA endpoints.**

   `adminAuthMiddleware` treats any successful Better Auth session lookup as sufficient and only stores `user` in context; it never checks `sessionResult.session?.twoFactorVerified` and never stores `session` in context in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:27) and [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:95). That creates two separate problems:
   - A session with `twoFactorEnabled=true` but `twoFactorVerified=false` can still call admin APIs directly if it has a valid session cookie.
   - `POST /admin/auth/2fa/mark-verified` assumes `c.get("session")` exists and dereferences `session.id` in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:393), but this middleware never sets it, so the route is broken as written.

   `verify2fa` has the same context fallback problem in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:486). The admin UI appears to handle 2FA in its own guards, but the API slice itself is not enforcing the same security boundary.

   Key refs: [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:29), [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:95), [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:393), [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:463)

5. **[P1] Several auth-management endpoints instantiate Better Auth with the wrong environment object, so they are wired to fail in the Worker runtime.**

   `createUserRoute`, `changePasswordRoute`, and `verify2faRoute` all use `const env = c.get("env") || process.env; const auth = createAuth(env);` in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:142), [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:279), and [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:466). No middleware sets `"env"` into Hono context, and `createAuth()` immediately calls `getDb(env)` in [packages/database/src/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/client.ts:21), which requires `env.DB`. `process.env` can provide strings, but not the D1 binding. That makes these routes fragile at best and very likely broken in the actual Worker runtime.

   Key refs: [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:142), [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:279), [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:466), [packages/database/src/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/client.ts:21)

6. **[P2] Secret-handling policy is inconsistent; some highly sensitive admin settings are still stored in plaintext D1 rows.**

   Payment, email, and OpenRouter secrets use `getEncryptionKey()` plus `upsertEncryptedSetting()` in routes like [apps/api/src/routes/admin/settings/payments.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/payments.ts:183). But `whatsappAccessToken` is written directly into `siteSettings.whatsappAccessToken` in [apps/api/src/routes/admin/settings/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/system.ts:108), and the schema is plain `text()` in [packages/database/src/schema/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/schema/system.ts:47). Likewise, Firebase `service_account` JSON is written directly into `settings.value` in [apps/api/src/routes/admin/settings/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/system.ts:311) and [apps/api/src/routes/admin/settings/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/system.ts:316). The UI masks these values on read, but they are not protected at rest the way other admin secrets are.

   Key refs: [apps/api/src/routes/admin/settings/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/system.ts:108), [apps/api/src/routes/admin/settings/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/system.ts:311), [packages/database/src/schema/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/schema/system.ts:15), [packages/database/src/schema/system.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/schema/system.ts:47)

7. **[P2] Admin user management still mixes legacy `user.role === "admin"` checks with RBAC, creating inconsistent authorization and a route-heavy implementation.**

   The middleware says RBAC is the source of truth in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:115), but `auth-management.ts` still hard-checks `sessionUser.role !== "admin"` and filters records by `user.role = "admin"` in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:61) and [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:77). On top of that, `GET /admin/auth/users` does an N+1 role/override expansion in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:79), so this slice is both semantically inconsistent and less scalable than it needs to be.

   Key refs: [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:115), [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:61), [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:79)

8. **[P3] Type-safety and contract discipline are being bypassed across many handlers, increasing drift risk.**

   Many admin handlers are wrapped as `(async (c: any) => ...) as any`, which defeats Hono/OpenAPI typing precisely in the slice where auth, params, and env bindings matter most. Examples include [apps/api/src/routes/admin/media.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/media.ts:91), [apps/api/src/routes/admin/openrouter.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/openrouter.ts:33), [apps/api/src/routes/admin/rbac.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/rbac.ts:118), [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:184), and many more. One visible symptom is contract drift in the OpenRouter generation endpoint, which documents a JSON success envelope but can return SSE directly when `stream=true` in [apps/api/src/routes/admin/openrouter.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/openrouter.ts:78) and [apps/api/src/routes/admin/openrouter.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/openrouter.ts:164).

   Key refs: [apps/api/src/routes/admin/openrouter.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/openrouter.ts:78), [apps/api/src/routes/admin/openrouter.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/openrouter.ts:164), [apps/api/src/routes/admin/media.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/media.ts:91)

## Repeated Anti-Patterns

- The permission map is maintained separately from real Hono mounts, and the mount graph is split across `app.ts`, settings aggregation, and reused non-admin route modules. That makes authorization drift very easy.
- The route layer is not consistently thin. `system-utils.ts`, `auth-management.ts`, and several settings routes own workflow logic, side effects, and persistence decisions instead of delegating to focused services.
- Legacy `user.role` checks coexist with RBAC checks. The system is trying to move to permission-based auth, but the transition is incomplete.
- Sensitive configuration is treated inconsistently. Some settings use encrypted storage; others rely only on UI masking.
- `any`-based Hono handlers are common enough that type safety can no longer be trusted to catch route-contract mistakes.

## Prioritized Follow-Ups

1. Make unmatched route permissions a hard failure.
   Add a test that derives every mounted admin route+method and asserts `getRoutePermission()` is non-null. Until that exists, the current default behavior should be “deny if unmapped”, not “allow any admin with any permission”.

2. Move abandoned-checkout cleanup off the GET path.
   Put cleanup/migration into a cron or queue consumer, and keep `GET /admin/abandoned-checkouts` read-only. If any destructive action remains manual, require delete/manage permission explicitly.

3. Fix admin session handling.
   In `adminAuthMiddleware`, store both `user` and `session`, enforce `twoFactorVerified` for 2FA-enabled admins, and make the scanner-token check validate the device-bound `sessionId` rather than only `payload.claimed`.

4. Replace all `createAuth(c.get("env") || process.env)` calls with `createAuth(c.env)`.
   Cover `create user`, `change password`, and `verify 2FA` with route-level tests so the next runtime/config regression is caught automatically.

5. Unify the admin security model around RBAC only.
   Remove `user.role === "admin"` gating from `auth-management.ts`, or explicitly document that `role` remains the real source of truth. Right now the codebase says both.

6. Encrypt the remaining admin secrets at rest.
   `whatsappAccessToken` and Firebase service-account JSON should use the same encrypted-settings path already used for payment/email/OpenRouter secrets, or move to runtime secrets if they do not need DB mutability.

7. Reduce type escapes in the admin route layer.
   Replace `c: any` and `as any` on `app.openapi()` handlers with typed helpers, then add route contract tests for the few intentional exceptions like streaming.
