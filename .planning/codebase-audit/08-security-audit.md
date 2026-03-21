# Security Audit

## Executive Summary

The Scalius Commerce codebase demonstrates a **mature security posture** for a single-tenant Cloudflare Workers e-commerce platform. The authentication layer (Better Auth + custom JWT) is well-structured with proper rate limiting, 2FA support, and session management. The authorization system (RBAC with fine-grained route permissions) is comprehensive. Webhook verification uses constant-time comparison and HMAC-SHA256. Credentials stored in D1 are encrypted with AES-256-GCM.

However, several vulnerabilities exist ranging from a critical XSS vector in the admin rich-content component to missing security headers, a non-constant-time token comparison in the cache purge endpoint, and CSP directives that include `'unsafe-inline'` and `'unsafe-eval'`. The token blacklist's fail-open behavior (documented in Known Backlog but since fixed to fail-closed) and the exposure of a hardcoded default JWT secret string in diagnostic output are also notable concerns.

**Overall Security Score: 7.2/10** -- Strong fundamentals with specific gaps that need targeted remediation.

---

## Vulnerability Report

| ID | Severity | Description | File(s) | Recommendation |
|----|----------|-------------|---------|----------------|
| SEC-01 | **Critical** | `dangerouslySetInnerHTML` in `RichContent` renders admin-authored HTML without sanitization. If an admin account is compromised (or a stored XSS payload enters via API), arbitrary scripts execute in every admin session viewing that content. | `apps/admin/src/components/ui/rich-content.tsx:71` | Sanitize HTML through DOMPurify or a server-side HTML sanitizer before rendering. Never trust DB content as safe HTML. |
| SEC-02 | **High** | Storefront innerHTML assignments in cart, checkout, and product pages. User-controlled data (product names, order details) inserted via `.innerHTML` without escaping, creating reflected/stored XSS vectors in the storefront. | `apps/storefront/src/lib/cart/client.ts:307-318`, `apps/storefront/src/lib/checkout/index.ts:88-140`, `apps/storefront/src/components/product/scripts/product-controller.ts:442` | Replace `.innerHTML` with `.textContent` for user data, or use a DOM-based template approach with proper escaping. |
| SEC-03 | **High** | Temporary password returned in API response body when email sending fails (`tempPassword` field in 201 response). This password is transmitted to the admin's browser and could be logged by intermediaries or browser extensions. | `apps/api/src/routes/admin/auth-management.ts:194` | Never return passwords in response bodies. Instead, generate a time-limited password reset link and display it as a URL. |
| SEC-04 | **High** | CSP includes `'unsafe-inline'` and `'unsafe-eval'` in `script-src`, effectively neutering CSP's XSS protection. Any inline script injection bypasses CSP entirely. | `apps/storefront/src/lib/middleware-helper/csp-handler.ts:85-89` | Migrate to nonce-based CSP. Remove `'unsafe-eval'` (audit Partytown's `new Function()` usage for alternatives). Use strict CSP with `'strict-dynamic'`. |
| SEC-05 | **High** | `new Function()` usage in Partytown config creates an `eval`-like code execution path. While the input is a static string literal (not user-controlled), it requires `'unsafe-eval'` in CSP and sets a dangerous precedent. | `apps/storefront/src/lib/partytown-config.ts:16` | Refactor to use a regular function instead of `new Function()`. This would also allow removing `'unsafe-eval'` from CSP. |
| SEC-06 | **Medium** | Cache purge endpoint uses non-constant-time string comparison (`!==`) for PURGE_TOKEN verification. This is exploitable via timing side-channel attacks to recover the token character by character. | `apps/storefront/src/pages/api/purge-cache.ts:89,176` | Use the existing `timingSafeCompare` or `timingSafeEqual` pattern from the auth codebase. |
| SEC-07 | **Medium** | No security response headers (X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, Referrer-Policy, Permissions-Policy) are set globally. CSP's `frame-ancestors 'self'` provides partial clickjacking protection for storefront only, but the API and admin have none. | All apps | Add a middleware that sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. |
| SEC-08 | **Medium** | Admin email verification disabled (`requireEmailVerification: false`). Admin users created via invitation have their email force-verified, but self-registered users (if sign-up were ever exposed) would have unverified emails with full access. | `packages/core/src/auth/auth.ts:50` | Enable email verification or ensure the sign-up endpoint is completely gated behind existing admin auth. |
| SEC-09 | **Medium** | Hardcoded default JWT secret string `"your-jwt-secret-key-change-this-in-production"` exists in diagnostic code. While it's only used for comparison in `getTokenStats()` (not for signing), its presence in the codebase could mislead developers into using it. | `apps/api/src/utils/jwt.ts:209` | Remove the hardcoded string entirely. The `isUsingDefaultSecret` check provides limited value and the string itself is a code smell. |
| SEC-10 | **Medium** | CORS allows all localhost origins (`http://localhost:*`, `http://127.0.0.1:*`) in production. While service bindings mean the API isn't directly exposed to browsers in production, this is a defense-in-depth gap if the network topology changes. | `packages/shared/src/cors-helper.ts:48-49` | Conditionally include localhost origins only when `NODE_ENV === "development"` or the request URL is a localhost origin. |
| SEC-11 | **Medium** | Partytown proxy endpoints (both API and storefront) have `Access-Control-Allow-Origin: *`. While they validate target URLs against an allowlist, the wildcard CORS means any origin can trigger fetches through these proxies. | `apps/api/src/routes/partytown-proxy.ts:48,134-148`, `apps/storefront/src/pages/api/__ptproxy.ts:52` | Restrict CORS to the storefront origin only. The proxy is only needed by the storefront's Partytown worker. |
| SEC-12 | **Medium** | FTS5 query construction uses `sql.raw()` for table names. While table names are validated against an allowlist at runtime, the parameterized match value goes through Drizzle's `sql` tagged template which is safe. The allowlist defense is correct but the `sql.raw()` pattern warrants ongoing vigilance. | `packages/core/src/search/fts5.ts:64` | Consider adding a compile-time type guard (const assertion) that makes it impossible to pass arbitrary strings to `sql.raw()`. The current runtime check is acceptable but a belt-and-suspenders approach is better. |
| SEC-13 | **Low** | Swagger UI and OpenAPI spec exposed at `/api/v1/docs` and `/api/v1/openapi.json` with no authentication. This exposes the full API surface area including admin endpoints to anyone. | `apps/api/src/app.ts:300-320` | Restrict Swagger UI to development only, or gate it behind admin authentication in production. |
| SEC-14 | **Low** | Health endpoint exposes cache backend type and memory usage stats without authentication. While individually low-risk, this is information disclosure that aids reconnaissance. | `apps/api/src/app.ts:202-229` | Reduce the information returned by the public health endpoint. Move detailed stats to an authenticated admin endpoint. |
| SEC-15 | **Low** | Token stats endpoint exposes partial JWT secret (`first3...last3` characters). While gated behind admin/system role, this reduces the effective keyspace for brute-force attacks on the secret. | `apps/api/src/utils/jwt.ts:213-214` | Return only a boolean `isConfigured` flag, never any portion of the secret. |
| SEC-16 | **Low** | FCM token logged in plain text (`console.log("FCM Token obtained:", currentToken)`) in the Firebase client integration. FCM tokens grant push notification send capability. | `packages/core/src/integrations/firebase/client.ts:123` | Remove the log statement or mask the token value. |
| SEC-17 | **Low** | Customer session cookie `SameSite=None` in production. While required for cross-origin service-binding architecture, this makes the cookie available in cross-site contexts, increasing CSRF attack surface for customer accounts. | `packages/core/src/modules/customers/customer-auth.service.ts:134` | The storefront proxy already rewrites to `SameSite=Lax` for same-origin requests. Document this architectural requirement clearly. Consider CSRF tokens for state-changing customer operations. |

---

## Dimension Ratings

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Maintainability** | 8/10 | Security middleware is cleanly separated (auth.ts, admin-auth.ts, webhook-auth.ts). RBAC is organized into helpers, route-permissions, and auto-seed modules. The `@scalius/core/auth` package provides a single factory function. Clear separation of concerns between Better Auth sessions and JWT tokens. Deduction: route-permissions.ts is a 700-line file that could benefit from domain-based splitting. |
| **Robustness** | 7/10 | Auth covers multiple vectors (session cookie, JWT bearer, scanner token) with proper fallback chain. 2FA implementation supports TOTP, email OTP, and backup codes. Rate limiting on sign-in (5/min), password reset (3/5min), and 2FA endpoints. Token blacklist now fails closed. Deductions: no account lockout after repeated failures (rate limit resets), no session binding to IP/user-agent, permission cache TTL (5 min) means revoked permissions are effective for up to 5 minutes. |
| **Code Quality** | 8/10 | Consistent use of typed error classes (ApiError hierarchy), Zod validation on all OpenAPI routes, HTML escaping in email templates, constant-time comparison for webhook signatures. SQL injection prevention via Drizzle ORM parameterized queries throughout. FTS5 input sanitization with character stripping. No `sql.raw()` with user input. Deductions: scattered `innerHTML` usage in storefront scripts, `dangerouslySetInnerHTML` without sanitization, `new Function()` usage. |
| **Scalability** | 6/10 | Permission caching uses in-memory Map with KV fallback -- suitable for single-tenant but the in-memory Map resets on isolate restart. Rate limiting in Better Auth uses the library's built-in mechanism (in-memory per isolate). The KV-based rate limiter in `@scalius/shared` is distributed but not used for auth endpoints. Session storage in KV is horizontally scalable. Deductions: in-memory permission cache doesn't scale across isolates, Better Auth rate limiting is per-isolate (not distributed), no distributed session store for admin sessions (Better Auth uses D1 which is fine for single-tenant). |
| **Performance** | 7/10 | Auth instance is cached per env signature to avoid recreation. RBAC permission resolution uses a batched D1 query (3 queries in 1 round-trip). KV cache lookups have 1s timeouts. Token verification is synchronous (jsonwebtoken library) after the async blacklist check. Deductions: every admin request triggers a DB query for RBAC (mitigated by 5-min cache), webhook auth queries DB for provider credentials on every call, route-permission matching sorts and iterates all patterns on every request. |
| **Feature Readiness** | 8/10 | Auth system supports multiple authentication methods (session, JWT, scanner token). Payment gateway settings are stored in DB with AES-256-GCM encryption. Adding a new auth provider would involve: extending admin-auth.ts middleware, adding RBAC permissions, and route-permission mappings. The gateway-settings pattern (DB + encrypted credentials + KV cache) is well-established for adding new payment providers. RBAC auto-seeds permissions on first access. Deductions: no OAuth/SAML support, no API key management for third-party integrations. |

---

## Detailed Findings

### Strengths

1. **Defense-in-Depth Authentication**: The admin-auth middleware implements a three-tier auth chain (Better Auth session -> JWT Bearer -> Scanner Token) with clean fallback semantics. Each method is properly scoped -- scanner tokens are restricted to inventory endpoints only.

2. **Comprehensive RBAC**: Fine-grained permissions with 80+ route mappings, role-based inheritance, user-level overrides (grants AND denials), super-admin bypass, and batched DB queries for performance. Permission changes clear both local and KV caches.

3. **Webhook Security**: All payment webhooks verify signatures before processing. Stripe uses its built-in signature verification. SSLCommerz validates via API callback. Polar uses signature verification. Delivery webhooks (Pathao/Steadfast) support HMAC-SHA256 with constant-time comparison and IP allowlist fallback. All webhooks have KV-based idempotency deduplication.

4. **Credential Encryption**: Sensitive credentials (payment gateway secrets, delivery provider credentials) are encrypted at rest in D1 using AES-256-GCM with a dedicated CREDENTIAL_ENCRYPTION_KEY (fallback to JWT_SECRET). Graceful decryption enables migration from plaintext.

5. **Token Blacklist**: JWT tokens can be revoked via KV-based blacklist with SHA-256 hashing. The blacklist fails closed (rejects token when KV is unavailable). TTL matches token expiration to prevent unbounded growth.

6. **Input Validation**: All API routes use Zod schemas via OpenAPIHono's `createRoute()`. Email format validation, phone number normalization (E.164), password minimum length (12 chars), and FTS5 query sanitization with special character stripping and table name allowlisting.

7. **Secret Management**: Secrets come from Cloudflare Workers env bindings (`wrangler secret put`), never from `import.meta.env`. The `.dev.vars` files are gitignored. The `dev:setup` script auto-generates random secrets. The API refuses to issue system tokens if `API_TOKEN` uses the default value.

8. **Session Security**: Admin sessions expire in 7 days with daily renewal. Cookie caching (5-min) reduces DB lookups. Customer sessions are stored in KV with 30-day TTL. Session cookies are HttpOnly, Secure, with appropriate SameSite policies.

9. **Rate Limiting**: Better Auth rate limits sign-in (5/min), password reset (3/5min), and 2FA endpoints. Customer OTP has IP-based rate limiting (5/10min) and per-identifier cooldown (2-min between sends). Setup endpoint is rate limited (5/hour per IP).

10. **Setup Endpoint Protection**: The initial admin setup endpoint checks for existing admins, rate limits by IP, and logs security warnings if accessed after setup. Once an admin exists, the endpoint is permanently locked.

### Weaknesses

1. **XSS Attack Surface**: Multiple `innerHTML` assignments in storefront scripts inject data from API responses without escaping. The admin `RichContent` component renders HTML from the database without sanitization. While admin content is "trusted," a compromised admin account or API injection could pivot to all admin sessions.

2. **CSP Effectiveness Undermined**: `'unsafe-inline'` and `'unsafe-eval'` in script-src make CSP largely ineffective against XSS. These are included for framework compatibility (Partytown's `new Function()`, inline event handlers) but should be addressed with nonce-based CSP.

3. **Missing Security Headers**: No `X-Content-Type-Options`, `Strict-Transport-Security`, `Referrer-Policy`, or `Permissions-Policy` headers. Cloudflare edge may add some of these, but they should be explicitly set at the application level for defense-in-depth.

4. **No CSRF Protection for Mutation Endpoints**: The storefront checkout proxy endpoints (`create-order`, `stripe-intent`, etc.) accept POST requests without CSRF tokens. While `SameSite` cookies provide some protection, `SameSite=None` in production (required for cross-origin service bindings) weakens this.

5. **Information Disclosure**: Swagger UI, OpenAPI spec, health endpoint, and token stats all expose information that aids attacker reconnaissance. The token stats endpoint reveals partial JWT secret characters.

6. **Permission Cache Staleness**: 5-minute TTL on RBAC permission cache means a revoked admin can continue operating for up to 5 minutes. For security-sensitive operations (deleting users, changing settings), this could be significant.

### Critical Issues

1. **SEC-01 (Critical)**: The `dangerouslySetInnerHTML` in RichContent without sanitization is the highest-priority fix. This component is used to render product descriptions, page content, and other admin-authored HTML throughout the admin dashboard.

2. **SEC-03 (High)**: Returning temporary passwords in API response bodies violates password handling best practices and could lead to credential exposure via browser history, logs, or network monitoring.

3. **SEC-04 (High)**: The CSP `'unsafe-inline'` + `'unsafe-eval'` combination means CSP provides virtually no XSS protection. Combined with the innerHTML/dangerouslySetInnerHTML issues, this creates a significant attack surface.

---

## OWASP Top 10 (2021) Checklist

| # | Category | Status | Notes |
|---|----------|--------|-------|
| A01 | Broken Access Control | **PASS** | Comprehensive RBAC with route-level permissions, admin middleware on all /admin/* routes, scanner token scoping. Setup endpoint locked after first admin. |
| A02 | Cryptographic Failures | **PASS** | AES-256-GCM for credential encryption, proper JWT signing, bcrypt password hashing (via Better Auth), SHA-256 token hashing for blacklist. Secrets from env bindings. |
| A03 | Injection | **PASS (with caveats)** | Drizzle ORM prevents SQL injection. FTS5 queries sanitized with character stripping and table allowlisting. HTML escaping in email templates. However, innerHTML usage in storefront creates DOM injection vectors (SEC-02). |
| A04 | Insecure Design | **PASS** | Separation of concerns (thin HTTP layer, domain services, RBAC), defense-in-depth (multiple auth methods, webhook signature verification), principle of least privilege (scanner token restrictions). |
| A05 | Security Misconfiguration | **PARTIAL FAIL** | Missing security headers (SEC-07), Swagger UI exposed in production (SEC-13), localhost in CORS allowlist in production (SEC-10), email verification disabled (SEC-08). |
| A06 | Vulnerable and Outdated Components | **PASS** | Using Better Auth (actively maintained), Hono (actively maintained), Stripe SDK v17+ (current). `jsonwebtoken` library is stable. No known CVEs in direct dependencies (not exhaustively audited). |
| A07 | Identification and Authentication Failures | **PASS** | Rate limiting on auth endpoints, 12-char minimum passwords, 2FA support (TOTP/email/backup), constant-time comparison for secrets, token blacklist with fail-closed. |
| A08 | Software and Data Integrity Failures | **PASS** | Webhook signature verification on all payment/delivery providers, HMAC-SHA256 with constant-time comparison, idempotency deduplication via KV, atomic payment processing via db.batch(). |
| A09 | Security Logging and Monitoring Failures | **PARTIAL FAIL** | Security events logged (setup access after admin exists, webhook rejections), but no structured audit logging for admin actions (who changed what, when). No alerting on repeated auth failures. |
| A10 | Server-Side Request Forgery (SSRF) | **PASS** | Partytown proxy validates URLs against hostname allowlist. Storefront proxy has hardcoded ALLOWED_HOSTS set. No unvalidated URL fetching in API routes. |

---

## Recommendations

### Immediate (P0 -- This Sprint)

1. **Sanitize HTML rendering (SEC-01, SEC-02)**: Integrate DOMPurify or a similar library for all `dangerouslySetInnerHTML` and `innerHTML` usage. Create a shared `sanitizeHtml()` utility in `@scalius/shared`.

2. **Remove tempPassword from API responses (SEC-03)**: Generate a time-limited password reset URL instead. If email fails, show the reset link, never the password.

3. **Fix purge-cache timing attack (SEC-06)**: Replace `!==` with the existing `timingSafeCompare` or `timingSafeEqual` function pattern.

4. **Add security response headers (SEC-07)**: Create a shared middleware that sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Referrer-Policy`, and `Permissions-Policy` on all responses.

### Short-Term (P1 -- Next 2 Sprints)

5. **Strengthen CSP (SEC-04, SEC-05)**: Replace `new Function()` in partytown-config.ts with a regular function. Implement nonce-based CSP to replace `'unsafe-inline'`. Evaluate whether `'unsafe-eval'` can be removed after the partytown fix.

6. **Gate Swagger UI in production (SEC-13)**: Conditionally mount `/docs` and `/openapi.json` only in development, or protect them with admin auth.

7. **Restrict CORS localhost origins (SEC-10)**: Only include `localhost:*` origins when the worker is running in development mode.

8. **Remove partial secret exposure (SEC-15)**: Change `getTokenStats()` to return `isConfigured: boolean` instead of partial secret characters.

9. **Remove FCM token logging (SEC-16)**: Delete or mask the `console.log("FCM Token obtained:", currentToken)` statement.

### Medium-Term (P2 -- Next Quarter)

10. **Implement audit logging**: Log all admin mutations (create, update, delete) with actor ID, timestamp, affected resource, and before/after values. Store in a dedicated audit_log table.

11. **Add CSRF tokens for storefront mutations**: Implement double-submit cookie or synchronizer token pattern for checkout and customer profile endpoints.

12. **Reduce permission cache TTL for sensitive operations**: For destructive actions (user deletion, role changes, settings updates), bypass the RBAC cache and query DB directly.

13. **Implement account lockout**: After N consecutive failed sign-in attempts (e.g., 10), lock the account for a progressive duration. Currently, rate limiting resets every 60 seconds.

14. **Restrict partytown proxy CORS (SEC-11)**: Change `Access-Control-Allow-Origin: *` to the storefront's specific origin.

15. **Enable email verification (SEC-08)**: Set `requireEmailVerification: true` and ensure the invitation flow handles the verification step.
