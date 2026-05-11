# Auth / RBAC / Security Audit

Date: 2026-04-22

## Scope

This audit covers only auth/RBAC/security foundations and security-sensitive request handling across the shared auth package, API worker, admin dashboard, and storefront:

- `packages/core/src/auth/**`
- API auth/admin-auth/webhook middleware
- JWT/encryption helpers
- customer auth flows
- scanner auth surfaces
- permission seeding/protection
- secret handling patterns
- CSP/security headers and cross-surface request boundaries

Out of scope except where needed for security analysis:

- broad business-domain correctness
- pricing/order/payment business rules unrelated to auth or trust boundaries
- non-security UI quality issues

Method: static code audit only. I used `workers-best-practices` and `hono-cf` for Cloudflare Worker/Hono-specific review, plus current upstream docs for Worker secret/runtime patterns and Hono security-header middleware:

- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Hono secure headers middleware](https://hono.dev/docs/middleware/builtin/secure-headers)

I did not execute live requests or confirm exploitability against a running deployment.

## How Auth And Security Work End To End

### 1. Shared admin auth foundation

- Better Auth is configured in [packages/core/src/auth/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/auth.ts:14) with email/password enabled, 2FA plugins enabled, a shared Drizzle adapter over the `user`, `session`, `account`, `verification`, and `two_factor` tables, and `role="admin"` treated as the Better Auth admin role.
- Shared auth defaults new Better Auth accounts to `role="user"` via the Better Auth admin plugin at [packages/core/src/auth/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/auth.ts:190).
- Shared auth also disables mandatory email verification for sign-in at [packages/core/src/auth/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/auth.ts:48).

### 2. Admin dashboard auth path

- The admin worker exposes the raw Better Auth handler publicly at [apps/admin-v2/src/routes/api/auth/$.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/auth/$.ts:12).
- Admin UI route guards use server functions in [apps/admin-v2/src/lib/auth.fns.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.fns.ts:14) and shared helpers in [apps/admin-v2/src/lib/auth.server.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.server.ts:47).
- The admin UI enforces 2FA during page navigation in [apps/admin-v2/src/lib/auth.fns.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.fns.ts:140), and loads RBAC context via [apps/admin-v2/src/middleware/rbac.server.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/middleware/rbac.server.ts:23).
- The admin shell is mounted at [apps/admin-v2/src/routes/admin.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin.tsx:12).

### 3. API auth path

- Generic JWT auth for `/orders/*` is handled by [apps/api/src/middleware/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/auth.ts:22).
- Admin API auth is handled by [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:24). It accepts:
  - a Better Auth session cookie
  - a JWT bearer token
  - a scanner token in `X-Scanner-Token`
- After authentication, admin API authorization depends on:
  - effective permissions from [packages/core/src/auth/rbac/helpers.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/helpers.ts:56)
  - per-route permission mapping from [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:723)
- Admin and cache routes are mounted centrally in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:257) and [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:272).

### 4. RBAC model

- Seeded roles and permissions are created from [packages/core/src/auth/rbac/auto-seed.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/auto-seed.ts:61).
- `super_admin` is seeded with all permissions at [packages/core/src/auth/rbac/auto-seed.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/auto-seed.ts:66).
- Effective permissions come from:
  - `isSuperAdmin`
  - role assignments in `user_roles`
  - per-user overrides in `user_permissions`
- The key permission split between team management and role management is defined in [packages/core/src/auth/rbac/permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/permissions.ts:899).

### 5. Scanner auth path

- A scanner token is created by the admin worker route [apps/admin-v2/src/routes/api/scanner-token.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:40).
- The QR generator embeds the live token in `/scanner?token=...` at [apps/admin-v2/src/components/admin/settings/ScannerTokenGenerator.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/settings/ScannerTokenGenerator.tsx:41).
- The public scanner route reads the token from the URL in [apps/admin-v2/src/routes/scanner.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/scanner.tsx:9).
- The scanner client then reuses that token as `X-Scanner-Token` on admin inventory API calls in [apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:204).
- The API worker converts that token into a synthetic `role="scanner"` user in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:60).

### 6. Storefront customer auth path

- Storefront customer auth goes through the same-origin proxy at [apps/storefront/src/pages/api/customer-auth/[...path].ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/pages/api/customer-auth/[...path].ts:21).
- The API-side customer auth routes live at [apps/api/src/routes/customer-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/customer-auth.ts:35).
- OTP generation/session storage lives in KV-backed helpers in [packages/core/src/modules/customers/customer-auth.service.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/customers/customer-auth.service.ts:181).
- The storefront auth modal drives the UX in [apps/storefront/src/components/AuthModal.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/components/AuthModal.tsx:205).

### 7. Service-to-service auth and webhooks

- `/api/v1/auth/token` exchanges `X-API-Token` for a JWT bearer token in [apps/api/src/routes/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/auth.ts:58).
- Storefront SSR/server-side API calls mint and cache that JWT from `API_TOKEN` in [apps/storefront/src/lib/api/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/api/client.ts:68).
- Delivery webhook auth is centralized in [apps/api/src/middleware/webhook-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/webhook-auth.ts:65).
- Stripe/SSLCommerz/Pathao/Steadfast webhook handlers live in:
  - [apps/api/src/routes/webhooks/stripe.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/webhooks/stripe.ts:16)
  - [apps/api/src/routes/webhooks/sslcommerz.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/webhooks/sslcommerz.ts:16)
  - [apps/api/src/routes/webhooks/pathao.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/webhooks/pathao.ts:14)
  - [apps/api/src/routes/webhooks/steadfast.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/webhooks/steadfast.ts:14)

### 8. Security headers and secret handling

- API-wide security headers are added centrally in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:148).
- Storefront CSP is built in [apps/storefront/src/lib/middleware-helper/csp-handler.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/middleware-helper/csp-handler.ts:231) and applied in [apps/storefront/src/middleware.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/middleware.ts:190).
- Credential encryption uses AES-GCM in [packages/core/src/utils/credential-encryption.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/utils/credential-encryption.ts:7), while the API selects the key in [apps/api/src/utils/encryption-key.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/utils/encryption-key.ts:5).

## Findings

### 1. [P0] Admin API accepts password-only Better Auth sessions and bypasses the 2FA gate

The admin UI enforces 2FA during navigation, but the API does not. In [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:29), the middleware accepts any successful Better Auth session lookup and sets `user` immediately; it never checks `session.twoFactorVerified`. The UI guard in [apps/admin-v2/src/lib/auth.fns.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.fns.ts:140) does check `twoFactorVerified`, which means the protection exists only in the dashboard frontend, not at the actual admin API boundary.

Impact: a user who has only completed the password step can still call `/api/v1/admin/*` directly with their session cookie and bypass the intended 2FA requirement completely.

Key refs:

- [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:29)
- [apps/admin-v2/src/lib/auth.fns.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.fns.ts:140)
- [packages/database/src/schema/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/schema/auth.ts:43)

### 2. [P1] Scanner auth is effectively a bearer-token inventory admin path with no real device binding

The scanner flow has three separate problems that combine badly:

1. Token minting checks only for a valid Better Auth session, not an admin role or an inventory permission, in [apps/admin-v2/src/routes/api/scanner-token.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:46).
2. The claim route binds the token to `scanner_sid`, but the API worker never verifies that cookie. It only checks that the KV payload is `claimed` in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:67). The scanner client itself sends only `X-Scanner-Token` on API calls in [apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:204).
3. Scanner tokens are accepted for any pathname containing `/inventory/` and then skip full RBAC in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:98), not just the narrow scanner lookup/adjust routes.

Impact: any valid dashboard session can mint a scanner token, and anyone who later learns that token can replay it from another device to call broad inventory endpoints. This is a real privilege-escalation path even before considering possible public sign-up exposure elsewhere.

Key refs:

- [apps/admin-v2/src/routes/api/scanner-token.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:46)
- [apps/admin-v2/src/routes/api/scanner-token.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:110)
- [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:62)
- [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:98)
- [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:143)
- [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:224)
- [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:251)
- [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:286)
- [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:325)

### 3. [P1] RBAC route-permission drift leaves current admin/cache routes protected only by “has any permission”

The admin API boundary depends on `getRoutePermission()`. If it finds no matching route, `adminAuthMiddleware` falls back to a very weak gate: “user has at least one effective permission” at [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:115).

That fallback is dangerous because the route-permission map has stale pre-monorepo paths for several still-mounted routes:

- inventory uses `/api/inventory/*` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:646) but the live routes are mounted under `/api/v1/admin/inventory` in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:282)
- cache uses `/api/settings/cache/*` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:498) but the live route is `/api/v1/cache/*` in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:258)
- delivery locations use `/api/settings/delivery-locations*` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:459) but the live route is `/api/v1/admin/settings/delivery-locations*` in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:299)
- dashboard uses `/api/dashboard*` in [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:600) but the live route is `/api/v1/admin/dashboard*` in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:287)

Affected handlers such as cache purge and inventory operations do not add their own permission checks; they rely on the central middleware:

- [apps/api/src/routes/cache.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/cache.ts:127)
- [apps/api/src/routes/cache.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/cache.ts:181)
- [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:143)
- [apps/api/src/routes/admin/inventory.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/inventory.ts:224)

Impact: a low-privilege admin with one unrelated permission can access under-mapped routes that were supposed to be governed by narrower permissions, including cache clearing and inventory mutation.

### 4. [P1] `team.manage` can create super-admin-equivalent users and delete super admins

The route map gives `/api/v1/admin/auth/users` only `TEAM_MANAGE` at [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:667), even though permission metadata explicitly reserves role/permission assignment for `TEAM_MANAGE_ROLES` in [packages/core/src/auth/rbac/permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/permissions.ts:908).

The create-user handler then accepts any `roleId` and only checks that the role exists in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:151). Because seeded system roles include `super_admin` with all permissions in [packages/core/src/auth/rbac/auto-seed.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/auto-seed.ts:66), a team manager can create an all-powerful account without actually holding role-management permission.

The delete-user handler has the same permission problem and never blocks deletion of a super admin in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:238).

Impact: the team-management surface can both mint and remove the highest-privilege identities in the system.

Key refs:

- [packages/core/src/auth/rbac/route-permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:667)
- [packages/core/src/auth/rbac/permissions.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/permissions.ts:899)
- [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:149)
- [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:238)
- [packages/core/src/auth/rbac/auto-seed.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/auto-seed.ts:66)

### 5. [P1] `API_TOKEN` can mint a broad `system` JWT that unlocks `/orders/*`, including order PII

`GET /api/v1/auth/token` exchanges `X-API-Token` for a bearer JWT with `role: "system"` in [apps/api/src/routes/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/auth.ts:73). The API then protects `/orders/*` only with generic JWT auth in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:259), and `GET /orders/{id}` returns full customer/order details in [apps/api/src/routes/orders.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/orders.ts:64) without any ownership or scope check.

On the storefront side, SSR code mints and caches this JWT from `API_TOKEN` in [apps/storefront/src/lib/api/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/api/client.ts:80).

Impact: if `API_TOKEN` leaks anywhere in server logs, SSR instrumentation, or misconfigured runtime surfaces, it can be turned into a broad system bearer token with access to order data.

Key refs:

- [apps/api/src/routes/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/auth.ts:58)
- [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:259)
- [apps/api/src/routes/orders.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/orders.ts:64)
- [apps/storefront/src/lib/api/client.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/api/client.ts:80)

### 6. [P1] Cache-purge auth is carried in query strings and accepted on a public GET endpoint

The API worker appends `PURGE_TOKEN` to the purge URL query string before calling the storefront in [apps/api/src/routes/cache.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/cache.ts:131) and [apps/api/src/routes/cache.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/cache.ts:214). The storefront purge endpoint accepts the token from `?token=` on both `GET` and `POST` in [apps/storefront/src/pages/api/purge-cache.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/pages/api/purge-cache.ts:115) and [apps/storefront/src/pages/api/purge-cache.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/pages/api/purge-cache.ts:192).

Impact: the purge secret is much more likely to leak into logs, traces, metrics dashboards, copied URLs, and browser history than if it were sent only in a header or service-binding-only call.

### 7. [P1] Disabled delivery providers can still authenticate webhooks

`verifyDeliveryWebhook()` selects the provider by `type` only in [apps/api/src/middleware/webhook-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/webhook-auth.ts:74). It never checks `isActive`, even though delivery providers have an `is_active` flag in [packages/database/src/schema/delivery.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/database/src/schema/delivery.ts:32).

Impact: disabling a provider in admin settings does not fully disable its inbound trust path. If the old secret is still present, webhook-driven state changes can continue to enter the system.

### 8. [P2] Permission revocations propagate lazily across API isolates

The API auth path loads permissions without a KV namespace in [apps/api/src/middleware/admin-auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:113), so it relies on the in-memory cache in [packages/core/src/auth/rbac/helpers.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/helpers.ts:17). RBAC mutation helpers can clear KV-backed caches, but the API routes do not pass KV when calling them:

- [apps/api/src/routes/admin/rbac.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/rbac.ts:456)
- [apps/api/src/routes/admin/rbac.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/rbac.ts:508)
- [apps/api/src/routes/admin/rbac.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/rbac.ts:561)
- [apps/api/src/routes/admin/rbac.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/rbac.ts:619)

Impact: a role removal or permission denial may remain effective on other isolates for up to the cache TTL, leaving a stale-access window after revocation.

### 9. [P2] First-admin bootstrap is race-prone and can mint multiple super admins

The public setup path checks whether an admin already exists in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:582), then uses a KV `get` + `put` lock in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:598). That lock is not atomic. Two concurrent requests can both see “no admin, no lock” and both create first-admin accounts, each later marked `role="admin", isSuperAdmin=true` in [apps/api/src/routes/admin/auth-management.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:624).

Related fragility: the RBAC auto-seed recovery path silently promotes the oldest admin back to super admin in [packages/core/src/auth/rbac/auto-seed.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/auto-seed.ts:220).

### 10. [P2] Customer auth can bind an unverified secondary identifier to the resulting account

The storefront modal can require or accept both email and phone in [apps/storefront/src/components/AuthModal.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/components/AuthModal.tsx:190). On verification, the backend proves only the primary identifier’s OTP, then uses the optional secondary `phone` or `email` when creating the customer record in [packages/core/src/modules/customers/customer-auth.service.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/customers/customer-auth.service.ts:346) and [packages/core/src/modules/customers/customer-auth.service.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/customers/customer-auth.service.ts:361).

Impact: a user who controls one channel can attach an unverified second identifier, which becomes risky anywhere the product later assumes both are trusted or independently verified.

### 11. [P2] Potentially critical: `markFirstUserAsSuperAdmin()` has no built-in authorization or first-run guard

The admin app exposes a server function at [apps/admin-v2/src/lib/auth.fns.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.fns.ts:174) that unconditionally runs:

- `UPDATE user SET role = 'admin', is_super_admin = 1 WHERE email = ?`

There is no session check, no CSRF-style validation in the function itself, and no first-run constraint. Shared auth also leaves public Better Auth endpoints enabled in [packages/core/src/auth/auth.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/auth.ts:48) and exposes the raw handler publicly at [apps/admin-v2/src/routes/api/auth/$.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/auth/$.ts:12).

This is not promoted higher only because I did not hit the live app to confirm how TanStack Start exposes this server function over HTTP in this deployment. If it is directly callable as usual, this becomes a critical account-takeover path.

### 12. [P3] Foundational hardening gaps weaken secret isolation and XSS containment

There are several lower-severity but still meaningful hardening gaps:

- credential encryption falls back to `JWT_SECRET` if `CREDENTIAL_ENCRYPTION_KEY` is missing in [apps/api/src/utils/encryption-key.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/utils/encryption-key.ts:5), collapsing key separation
- decryption fails open to plaintext in [packages/core/src/utils/credential-encryption.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/utils/credential-encryption.ts:58), which can hide misconfiguration or key drift
- the shared/storefront CSP builders still allow `'unsafe-inline'` and, in one path, `'unsafe-eval'` in [packages/core/src/middleware-helper/csp-handler.ts](/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/middleware-helper/csp-handler.ts:142) and [apps/storefront/src/lib/middleware-helper/csp-handler.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/storefront/src/lib/middleware-helper/csp-handler.ts:84)
- the storefront does not add the same baseline security headers the API adds in [apps/api/src/app.ts](/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/app.ts:151)

These are not the most urgent issues in this audit, but they reduce the margin for error if an XSS or config leak happens elsewhere.

## Notable Attack Surfaces

- Direct calls to `/api/v1/admin/*` with a password-only Better Auth session cookie.
- Scanner QR URLs and copied `/scanner?token=...` links.
- Under-mapped admin/cache routes where `routePermission === null` silently downgrades authorization to “has any permission.”
- The raw Better Auth handler at `/api/auth/*`, especially if sign-up is reachable in production.
- `X-API-Token` to `/api/v1/auth/token`, because the minted JWT currently has very broad downstream power.
- Storefront purge URLs containing `?token=...`.
- Delivery webhook endpoints when a provider is disabled but its secret still exists.

## Prioritized Follow-Ups

1. Enforce `twoFactorVerified` inside `adminAuthMiddleware`, not only in the admin UI. Reject password-only sessions at the API boundary.
2. Rework scanner auth immediately:
   - require a real admin/inventory permission to mint tokens
   - validate the bound `scanner_sid` on the API side
   - scope scanner tokens to a tiny allowlist of scanner routes instead of any `/inventory/` path
   - stop putting live scanner bearer tokens in query strings
3. Replace the current “route map missing means any permission is enough” model with fail-closed authorization. Then fix stale path prefixes in `route-permissions.ts` and add coverage tests that compare mounted routes against permission mappings.
4. Tighten team-management boundaries:
   - require `TEAM_MANAGE_ROLES` for assigning roles
   - block assigning system roles unless explicitly super-admin-only
   - block deletion of super admins except by super admins
5. Narrow service-to-service auth:
   - stop issuing a generic `system` JWT from `API_TOKEN`
   - scope service credentials to specific endpoints/actions
   - add ownership/scope checks to `/orders/*`
6. Move purge auth out of query strings and remove the public GET purge entrypoint.
7. Make webhook trust respect `isActive`, and fail closed when a provider is disabled.
8. Use KV-backed invalidation consistently for RBAC cache clears so revocations take effect across isolates immediately.
9. Replace the setup lock with an atomic uniqueness guard at the database level or an actually atomic distributed lock.
10. Live-verify whether `markFirstUserAsSuperAdmin()` is remotely callable. If it is, remove it or add strict auth + one-time bootstrap constraints immediately.

## Summary

The biggest theme is boundary mismatch: the UI, API, scanner flow, and RBAC map each define “authorized admin” slightly differently. That drift has produced multiple real gaps: API-side 2FA bypass, scanner-based inventory escalation, stale route-permission coverage, and team-management powers that exceed their intended scope.

If I were fixing this slice first, I would start with the API boundary itself: enforce 2FA in `adminAuthMiddleware`, fail closed on missing route permissions, and strip scanner auth back to a narrow, explicitly authorized flow.
