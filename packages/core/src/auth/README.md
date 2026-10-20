# Auth and RBAC

How staff sign in to the dashboard and what they may do: Better Auth, sessions, two-step verification (2FA), roles and permissions, first-admin setup, staff invites, scanner pairing and the identity handoff. For contributors and coding agents.

Buyer sign-in is separate. It lives in `packages/core/src/modules/customers/README.md` (one-time codes, `customer_sessions`). Buyers have no 2FA.

## Overview

The API Worker serves the dashboard SPA (`apps/admin-v2`) and the API. The dashboard host carries three surfaces.

```text
<dashboard>/api/auth/*  -> apps/api/src/dashboard/auth.ts      Better Auth, route-guard state
<dashboard>/api/v1/*    -> apps/api/src/middleware/admin-auth.ts -> getRoutePermission()
<dashboard>/api/scanner-token -> apps/api/src/dashboard/scanner-session.ts
```

The selected relational provider is the authority for staff sessions, setup, scanner tokens and permissions. There is no KV: every permission check reads the database (one batch), so a role change holds on the next request; only the RBAC seed marker is a per-colo Cache API hint. Tables: `packages/database/src/schema/auth.ts` and `rbac.ts`.

The admin API accepts four kinds of caller:

| Caller | Credential | Limits |
| --- | --- | --- |
| Staff | Signed Better Auth cookie | Gates, then route permissions. |
| Scanner device | `scanner_sid` cookie | Only the scanner allowlist. No RBAC. |
| Agent connection (CLI, MCP) | Bearer credential from `apps/api/src/agent-access/` | Dashboard resource, exposed operations, route permissions of its grant. A cookie plus an agent credential returns 403. |
| Installed plugin | In-process dispatch | `apps/api/src/plugins/admin-request.ts`. Plugins never hold `apps.*` permissions. |

## Files

- `auth.ts` has `createAuth()` and `getAuth()`, the Better Auth factory. It is request-scoped: never cache it, because it closes over the request database and bindings.
- `credential-account.ts` holds the guarded provider batches that create staff identities (see "Staff and roles API").
- `rbac/` holds `permissions.ts` (`PERMISSIONS`, prerequisites), `permission-metadata.ts` (display names, categories and sensitivity, kept apart so the dashboard does not download it on every page), `auto-seed.ts`, `route-permissions/` and `page-permissions.ts`. Other files in this folder are named after what they do (`password-hash.ts`, `admin-setup.ts`, `identity-handoff.ts`, `scanner-token-claims.ts`).

## Keys

`SCALIUS_SECRET` is installed on both Workers. Each purpose key below is derived from it with HKDF at Worker entry (`packages/shared/src/runtime-secrets.ts`). Nothing derived is stored. Changing `SCALIUS_SECRET` rotates all of them: staff and buyer sessions, service JWTs and agent credential hashes stop working.

| Derived name (purpose label) | Use here |
| --- | --- |
| `BETTER_AUTH_SECRET` (`better-auth-session`) | Signs the staff session cookie. Encrypts 2FA recovery codes. |
| `CUSTOMER_SESSION_HASH_KEY` (`customer-session-hash`) | Hashes buyer session tokens. |
| `ADMIN_SETUP_TOKEN` (`admin-setup`) | Optional first-admin setup token. |
| `FRONT_PROXY_SECRET` (`front-proxy`), `IDENTITY_HANDOFF_SECRET` (`identity-handoff`) | Automation keys. |
| `JWT_SECRET` (`jwt-signing`), `API_TOKEN` (`service-api-token`), `AGENT_TOKEN_PEPPER` (`agent-token-pepper`) | Service tokens and agent credential hashes. |

`CREDENTIAL_ENCRYPTION_KEY` is installed on the API Worker only. It is not derived. It encrypts provider credentials and customer OTP material, and it feeds the password pepper.

## Better Auth configuration

| Setting | Value |
| --- | --- |
| Sign-in | E-mail and password only. No OAuth. Disabled when the identity handoff turns local login off (`localLoginDisabled`). |
| Base URL | The Platform dashboard URL (`BETTER_AUTH_URL`; the request origin before it is set). Never the API origin. |
| Base path | `<dashboard base path>/api/auth`. The session cookie `Path` is the dashboard base path. |
| Trusted origins | Dashboard URL and storefront URL. |
| Password | 12 to 128 characters. E-mail verification off. |
| Session | 7 days, refreshed daily. Cookies `better-auth.session_token` and `__Secure-better-auth.session_token`. Extra column `session.two_factor_verified`. |
| Reset and invite links | Reset: 1 hour. Staff invite: 7 days. A new link replaces older ones. Sessions end after a reset. A reset clears `mustChangePassword`. |
| 2FA | TOTP (6 digits, 30 s) and e-mail code (valid 5 minutes). 10 single-use recovery codes like `k7qx4-mn2pa`, stored encrypted. |
| Admin plugin | `defaultRole: user`, `adminRoles: [admin]`. A suspended person gets `BANNED_USER`. |

### Password hashes (`password-hash.ts`)

Format `$sc1$<algorithm>$<params>$<salt>$<hash>`. The plan profile (`planLimits().password`, see `docs/FREE-PLAN.md`) picks the algorithm: Free uses PBKDF2-SHA256 with 30,000 iterations, Paid uses scrypt N=16384, r=16, p=1.

- The password is keyed first: HMAC-SHA256 of the NFKC-normalised password under a key that HKDF derives from `CREDENTIAL_ENCRYPTION_KEY`. A copy of the database alone cannot test a guess.
- Better Auth's own scrypt hashes still verify.
- When a verified hash differs from what this deployment writes (other plan, no pepper, Better Auth format), `upgradeStoredPasswordHash` rewrites it with a compare-and-set. A failed rewrite never fails the sign-in.

### Rate limits and client IP

| Limit | Value | Store |
| --- | --- | --- |
| Better Auth `/sign-in/email` | 5 per minute | D1 `rate_limit` |
| `/request-password-reset` | 3 per 5 minutes | D1 `rate_limit` |
| `/two-factor/*` | 5 per minute | D1 `rate_limit` |
| Other Better Auth routes | 100 per minute (`/get-session`: none) | D1 `rate_limit` |
| Wrong 2FA codes | Better Auth locks the 2FA row; the API answers 429 `TWO_FACTOR_LOCKED` ("try again in 15 minutes") | `two_factor.locked_until` |
| Identity handoff routes | 10 per minute | plugin |
| First-admin setup | 5 per hour per IP | D1 `admin_setup_rate_limits` |

- Better Auth reads the client IP from `cf-connecting-ip`, then `x-forwarded-for`, and groups IPv6 by /64. API routes call `getTrustedClientIp` (`apps/api/src/utils/client-ip.ts`): it trusts `cf-connecting-ip` only, reads `x-forwarded-for` only when a platform origin is loopback, and otherwise returns `unknown`.
- Native limiters `RL_STRICT` (5 per 60 s) and `RL_STANDARD` (60 per 60 s; it also limits agent calls) are in `apps/api/wrangler.jsonc`.

## Dashboard sign-in (`apps/api/src/dashboard/auth.ts`)

- `GET <dashboard>/api/auth/dashboard-session` returns `{ adminExists, signIn, session }` from the same lookup as the admin middleware. `session.permissions` appears only after every gate passes (password set, 2FA enrolled when required, 2FA verified). `signedOut` (`"session_ended"` or `"suspended"`) appears with no session when the browser still holds a validly signed cookie: the session ended or ran out, or its person is suspended. The sign-in page words each one.
- `POST reset-session` checks a reset or invite token sent in the body and sets the cookie `__Host-scalius-password-reset` (10 minutes, `HttpOnly`, `SameSite=Strict`). `POST reset-password-session` sets the password and signs the person in. Tokens never travel in URLs. Dead links answer `TOKEN_USED`, `TOKEN_CANCELLED` or `INVALID_TOKEN`.
- These Better Auth routes return 403 `AUTH_ROUTE_NOT_AVAILABLE`: `/sign-up/email`, `/change-password`, `/reset-password`, `/two-factor/disable`, `/admin/*`. Account creation, password change and 2FA removal go through the admin API.
- A 2FA verify with `trustDevice: true` returns 400 `TRUSTED_DEVICE_DISABLED`.
- Sign-in retries transient D1 failures, then returns 503 `TEMPORARY_AUTH_BACKEND_UNAVAILABLE`.
- After a verified second factor, the handler sets `session.two_factor_verified`. The admin API requires it.
- A request with an `Origin` that is neither the request origin nor the dashboard URL returns 403.

Route guards (`apps/admin-v2/src/lib/auth-guards.ts`) redirect from that one session read: no administrator to `/auth/setup`, signed out to `/auth/login`, `mustChangePassword` to `/auth/forgot-password`, `mustEnrollTwoFactor` to `/auth/setup-2fa`, an unverified 2FA session to `/auth/two-factor`, and no page permission to `/admin/access-denied`. `/auth/reset-password` completes a reset or an invite. `/admin/access-denied` and `/admin/account` open for any signed-in person.

## Admin API middleware (`apps/api/src/middleware/admin-auth.ts`)

For a cookie session, in order:

1. Verify the Better Auth cookie signature with `BETTER_AUTH_SECRET`. Only then read the session and user from D1 (unexpired, not banned). A tampered cookie never reaches D1.
2. If there is no staff session, try the `scanner_sid` cookie (below).
3. Apply the gates. Each blocks everything except the listed requests (all under `/api/v1/admin/auth`):
   - `mustChangePassword`: only `POST /change-password`.
   - `mustEnrollTwoFactor` without 2FA: only `GET /2fa/info`, `POST /2fa/method`.
   - 2FA enabled, session not verified: only `GET /2fa/info`, `POST /2fa/verify`, `POST /2fa/method`.
4. Load permissions with `getUserPermissions`. A person with none gets 403. The legacy `user.role` is never a fallback.
5. Schedule RBAC seed reconciliation with `waitUntil`. It never delays the response.
6. Look up `getRoutePermission(path, method)`. An unmapped route returns 403, also for super admins.
7. Check the rule: `allowAnyAdmin`, `permission`, `anyOf` or `allOf`.

`middleware/auth.ts` is a JWT-only middleware for service-token routes. The admin API accepts no JWT bearer. `GET /api/v1/auth/token` (`routes/auth.ts`) exchanges `X-API-Token` for a `system` JWT with a constant-time compare.

### CSRF and CORS

- CORS allows credentials. Allowed origins: `PUBLIC_API_BASE_URL`, `BETTER_AUTH_URL`, `STOREFRONT_URL` and the Platform `corsAllowedOrigins` list (exact origins only), plus loopback origins when a platform origin is loopback (`packages/shared/src/cors-helper.ts`).
- `dashboardOriginGuardMiddleware` covers `/admin/*` and `/cache/*`. Any request with cookies and a foreign `Origin` returns 403, reads included. Requests without cookies (agents, CLI) skip it.
- `cookieOriginGuardMiddleware` covers `/customer-auth/*` and `/orders/*`. An unsafe request with cookies and an `Origin` outside the allowed list returns 403.

## Permissions

`PERMISSIONS` in `rbac/permissions.ts` is the one list: 95 permissions named `<area>.<action>`.

- `permission-metadata.ts` marks 25 permissions sensitive: both `permanent_delete`, `orders.refund`, `orders.issue_invoice`, `gift_cards.*`, `discounts.*`, `settings.general.*`, `settings.delivery_providers.*`, `settings.fraud_checker.*`, `taxes.manage`, `team.manage`, `team.manage_roles`, `agent_access.*`, `webhooks.*` and `apps.manage`.
- The dashboard groups them in 13 display categories (`PermissionCategory`). Inventory, reviews and gift cards show under Products. Conversations show under Orders. Taxes, agent access, webhooks and apps show under Settings.
- Prerequisites (`permissionPrerequisites`): a permission needs its area's `.view`; `permanent_delete` needs `delete`; `inventory.view` needs `products.view`. A role save is rejected when a permission lacks its prerequisite. Effective access drops a permission whose prerequisite is missing.

### Resolution (`getUserPermissions`)

1. `user.isSuperAdmin`: every permission.
2. The union of the person's role permissions (`user_roles`, `role_permissions`).
3. User overrides (`user_permissions`): a grant adds, a denial removes. A denial wins.
4. Drop permissions with an unmet prerequisite.

### System roles (`rbac/auto-seed.ts`)

| Role | Permissions |
| --- | --- |
| `super_admin` | All. |
| `manager` | All except `products.permanent_delete`, `categories.permanent_delete`, `orders.refund`, `gift_cards.manage`, `settings.delivery_providers.edit`, `settings.fraud_checker.edit`, `team.manage_roles`, `agent_access.*`, `webhooks.*`, `apps.manage`. |
| `sales_rep` | Orders and shipments, conversations, customers (no delete), `discounts.view`, product, category and collection view. |
| `content_editor` | Pages, media, collection view and edit, header, footer and SEO settings edit. |
| `product_specialist` | Products (no `permanent_delete`), inventory, categories, collections, attributes, media view and upload. |

Every role has `dashboard.view`. Exact grants: `getSystemRoleSeeds()`.

`autoSeedRbacIfNeeded` creates missing permissions and roles and corrects system role grants. A per-colo Cache API marker `rbac:seed-current:v5:<hash>` (`rbacSeedMarker(env)`, 6 hours, keyed by the Worker version) skips repeat checks. The database stays the authority.

### Permission snapshot cache

- There is no permission cache: `getUserPermissions` resolves from the database every time.
- Every role or override write deletes the affected entries (`clearPermissionCache`, `clearPermissionCacheForRole`).
- Role changes do not end sessions. The next request reads the new permissions.

### Routes and pages

- `rbac/route-permissions/<domain>.ts` files map patterns (`/api/v1/admin/...`) to rules. `index.ts` merges them in `ROUTE_PERMISSION_MAPS`. A pattern lives in exactly one file (`route-permissions.test.ts`). Append a new map; do not reorder.
- Matching: exact first, then more segments and fewer wildcards first. `*` is one segment. `**` is one or more (plugin route families only).
- `allowAnyAdmin` admits the signed-in person's own account routes. Agents reach it only as super admin.
- Every new admin route needs a rule. Add its page to `page-permissions.ts` (`hasPageAccess`; a page with no entry denies).

## Staff and roles API

Under `/api/v1/admin`. Rules from `rbac/route-permissions/staff.ts`.

| Method and path | Permission |
| --- | --- |
| `GET /auth/users` | `team.view`, `team.manage` or `team.manage_roles` |
| `POST /auth/users` (invite), `POST /auth/users/{id}/resend-setup`, `DELETE /auth/users/{id}` (revoke invite), `POST /auth/users/{id}/suspension`, `POST /auth/users/{id}/remove` | `team.manage` |
| `GET /rbac/roles`, `GET /rbac/roles/{id}`, `GET /rbac/permissions` | `team.view` or `team.manage_roles` |
| `POST /rbac/roles`, `PUT` and `DELETE /rbac/roles/{id}`, `POST` and `DELETE /rbac/user-roles`, `POST` and `DELETE /rbac/user-permissions` | `team.manage_roles` |
| `POST /auth/change-password`, `POST /auth/update-profile`, `GET` and `PUT /auth/shortcuts`, `/auth/2fa/*`, `GET /auth/account-security`, `GET /auth/sessions`, `DELETE /auth/sessions` and `/{commandId}`, `GET /rbac/my-permissions` | Any signed-in person |
| `POST /auth/scanner-link` | `products.view` and `products.edit` |

Rules that code enforces:

- A person who is not the store owner cannot put a permission they lack into a role, an override or an assigned role (`assertPermissionSubset`). Only the store owner assigns `super_admin`.
- Nobody edits their own roles or permissions, or those of a super admin. Removing a person's last role is refused.
- System roles cannot change permissions or be deleted. A role assigned to staff cannot be deleted.
- Invite: `POST /auth/users` creates a blocked user (`mustChangePassword`, `mustEnrollTwoFactor`), the invitation row and the role in one atomic batch. A random bootstrap password is never returned or e-mailed. The response says `emailFailed: true` when the setup link did not send.
- Suspend: sets `banned` and deletes the person's sessions. Refused for yourself, the store owner and the last active administrator.
- Remove (`removeStaffMember`): ends sessions, password, 2FA, roles, overrides, scanner claims and pending invites. The `user` row stays so history keeps the name. Refused for yourself and the store owner.
- 2FA is optional for the first admin and manual admins, and required for invited admins: a person with a non-revoked `admin_invitations` row can't turn it off (`GET /auth/account-security` says `twoFactorRequired`). Change an established method with `POST /auth/2fa/method-challenge` (needs the password; the staged challenge lasts 10 minutes) then `POST /auth/2fa/method` with `challengeId` and a code. Turn it off with `POST /auth/2fa/disable` (the password and a current code; 403 `TWO_FACTOR_REQUIRED` for invited staff); it deletes the `two_factor` row and emails a security notice.
- The authenticator key in `two_factor` is `verified` only while the method is `totp`. Enrolling with email codes, or switching to them, leaves it unverified, so Better Auth's sign-in offers only email codes (and recovery codes) and the old app's codes stop signing in.

Better Auth e-mail sign-up is not atomic on the one-shot proxy adapters. Create administrative identities only with the atomic provider batches in `credential-account.ts` (`createInvitedAdminCredentialAccount`, `completeAdminSetupClaimWithCredentialIdentity`). Never enable interactive Drizzle transactions on these adapters.

## First-admin setup (`admin-setup.ts`)

- `GET /api/v1/setup` returns `{ adminExists, setupTokenRequired }`. `POST /api/v1/setup` creates the first super admin and seeds RBAC.
- D1 decides concurrency: the singleton row `admin_setup_claims` (`first_admin`, 60-second lease) and 5 attempts per hour per IP in `admin_setup_rate_limits`. Do not move this lock out of the database.
- When the Platform setting `setupTokenRequired` is on, the request needs the header `X-Scalius-Setup-Token` with the derived `ADMIN_SETUP_TOKEN`. See `docs/AUTOMATED-DEPLOYMENTS.md`.

## Scanner pairing

1. `POST /api/v1/admin/auth/scanner-link` stores the SHA-256 of a one-time token (`sct_...`) in `scanner_token_claims`. It lives 15 minutes.
2. The scanner page (`/scanner`) reads the token from the URL fragment and posts it to `<dashboard>/api/scanner-token`. Tokens in URLs are refused.
3. The exchange consumes the claim atomically. The claim row is the session: `consumed_session_hash` (SHA-256 of the cookie value) and `session_expires_at` (6 hours, slid by each refresh of `<dashboard>/api/scanner-token`). It sets `scanner_sid` (`HttpOnly`, `SameSite=Strict`). Every read of the session also requires the pairing staff member to be unbanned and to still hold `products.adjust_stock` (`staffPermissionSql`); suspending, removing or deleting them deletes the rows.
4. The middleware lets a scanner session call only the allowlist in `packages/shared/src/scanner-auth.ts` (inventory lookup, locations, stock adjust and set, purchase order and transfer reads and receiving). It never inherits the minting admin's permissions.

Scheduled maintenance deletes expired claims and claims whose session has expired.

## Identity handoff

Opt-in. An operator's identity provider mints a short-lived token, and the dashboard turns it into a normal session. `GET <dashboard>/api/auth/handoff?token=...` signs in. `POST <dashboard>/api/auth/handoff/revoke` ends a person's sessions. Both answer 404 while the handoff is off. Each attempt writes `admin_identity_handoff_events`. The token contract, settings and the `pnpm auth:handoff-token` tool are in `docs/AUTOMATED-DEPLOYMENTS.md`. Code: `identity-handoff.ts`.
