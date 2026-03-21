# Error Handling & Resilience Audit

## Error Flow Diagram

```
DB Layer (D1/Drizzle)
  |
  |  Drizzle throws native JS Error on constraint violations,
  |  query failures, connection issues
  |
  v
Core Services (packages/core)
  |
  |  Services throw typed AppError subclasses:
  |  ValidationError (400), NotFoundError (404),
  |  ConflictError (409), UnauthorizedError (401),
  |  ForbiddenError (403), ServiceUnavailableError (503)
  |
  |  Some services catch + return { success, error } instead
  |  (e.g., process-payment.ts, delivery providers)
  |
  v
API Routes (apps/api - Hono)
  |
  |  Route handlers call core services. Typed errors propagate
  |  uncaught to Hono's onError handler. Some routes do local
  |  try/catch for notification enqueuing (non-fatal).
  |
  |  Global onError handler: app.onError() in app.ts
  |  Catches ApiError (alias for AppError) -> structured JSON
  |  Catches any Error -> generic 500 JSON
  |
  v
API Response Envelope
  |  Success: { success: true, data: T }
  |  Error:   { success: false, error: { code, message, details? } }
  |
  v
+---> Admin SSR (apps/admin/src/lib/api-server.ts)
|       handleResponse() parses envelope, throws Error on failure
|       Astro loaders catch errors, return [] fallbacks
|
+---> Admin Client (apps/admin/src/lib/api-browser.ts)
|       parseResponse() parses envelope, throws Error on failure
|       React hooks: try/catch -> toast.error() for user feedback
|       1 ErrorBoundary class, 1 PageSection wrapper (barely used)
|
+---> Storefront SSR (apps/storefront/src/lib/api/client.ts)
        fetchWithRetry() handles auth, retries (2x), timeouts (8s)
        SDK clients route through same retry infrastructure
        Individual API modules have their own try/catch patterns
```

## Executive Summary

The codebase has a **well-designed error type hierarchy** centered on `AppError` and its subclasses in `packages/core/src/errors/index.ts`. The global Hono error handler correctly maps these to HTTP status codes with structured JSON responses. The API envelope pattern `{ success, data/error }` is consistently applied.

However, several systemic weaknesses exist:

1. **Pervasive silent `catch {}` blocks** -- at least 50+ instances across the codebase swallow errors completely, particularly in settings service KV operations, JSON parsing, and storefront checkout flows.
2. **ErrorBoundary exists but is barely deployed** -- only 1 wrapper component (PageSection) uses it, and PageSection itself is used in 0 actual pages (only defined). The 90+ React components with toast-based error handling have no crash protection.
3. **Mixed error propagation patterns** -- some core services throw typed errors (good), while others return `{ success, error }` result objects (process-payment.ts, delivery providers). This dual pattern creates confusion about whether callers should try/catch or check return values.
4. **No structured logging** -- all error logging uses `console.error`/`console.warn` with ad-hoc string prefixes like `[Queue]`, `[KV]`. No correlation IDs, no log levels, no integration with monitoring services.
5. **No circuit breaker or degradation patterns** -- external service failures (payment gateways, delivery APIs, Firebase, Meta CAPI) are handled individually with varying degrees of resilience but no systematic circuit breaking.

## Ratings

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Maintainability** | 7/10 | Clean error class hierarchy (AppError -> 7 subclasses). Consistent error codes (VALIDATION_ERROR, NOT_FOUND, etc). API envelope well-defined. Weakness: dual throw vs return-result patterns. |
| **Robustness** | 5/10 | 50+ silent catch blocks. Admin ErrorBoundary exists but is unused in practice. No global unhandled rejection handler in admin. Storefront handler only catches stale-asset import errors. Queue processing has good retry logic but payment processing catches and returns errors instead of bubbling. |
| **Code Quality** | 6/10 | Error classes are well-typed. API error response shape is consistent. Admin has `extractApiError()` helper. But: many `catch {}` without logging, inconsistent error message quality, `throw new Error()` used in 39 places in core instead of typed errors. |
| **Scalability** | 3/10 | No structured logging (JSON logs, correlation IDs, request tracing). No error aggregation. No monitoring hooks. Console.error/warn only -- invisible in production without Cloudflare tail. No error rate alerting capability. |
| **Performance** | 7/10 | Retry logic exists in storefront client (2 retries, 300ms backoff). Timeouts on all external calls (5s JWT, 8s API, 30s uploads). Queue processing uses Cloudflare's built-in retry (3x). KV cache gracefully degrades to in-memory. No unnecessary error overhead. |
| **Feature Readiness** | 6/10 | Adding new AppError subclasses is trivial. New API routes automatically get error handling via onError. But: no error monitoring integration points, no feature flag for error reporting, would need significant work to add Sentry/Datadog/etc. |

**Overall: 5.7/10**

## Detailed Findings

### Strengths

**1. Well-Designed Error Type Hierarchy**

`packages/core/src/errors/index.ts` defines a clean class hierarchy:
- `AppError` (base): status, code, message, details
- `ValidationError` (400, VALIDATION_ERROR)
- `NotFoundError` (404, NOT_FOUND)
- `UnauthorizedError` (401, UNAUTHORIZED)
- `ForbiddenError` (403, FORBIDDEN)
- `ConflictError` (409, CONFLICT)
- `RateLimitError` (429, RATE_LIMIT) -- includes retryAfterSeconds
- `ServiceUnavailableError` (503, SERVICE_UNAVAILABLE)

These are used consistently across 28+ core service files.

**2. Global API Error Handler**

`apps/api/src/app.ts` (line 84-111) registers `app.onError()` which catches all uncaught errors:
- `instanceof ApiError` -> structured JSON with status code, error code, message, details
- Any other `Error` -> generic 500 with INTERNAL_ERROR code
- Ensures all responses are JSON (prevents browser `SyntaxError` from `.text()` responses)

**3. Consistent API Envelope Pattern**

`apps/api/src/utils/api-response.ts` provides `ok()`, `created()`, `noContent()` helpers.
All success responses follow `{ success: true, data: T }`.
All error responses follow `{ success: false, error: { code, message, details? } }`.
Both admin (api-server.ts, api-browser.ts) and storefront (client.ts) have envelope unwrappers.

**4. Resilient Storefront Client**

`apps/storefront/src/lib/api/client.ts` implements:
- `fetchWithRetry()` with configurable retries (default 2) and exponential backoff (300ms * attempt)
- `AbortSignal.timeout()` on all requests (default 8s)
- Automatic JWT refresh on 401 response
- Service binding routing in production (0ms latency)
- Response body cancellation before retry (prevents Cloudflare Workers deadlock)

**5. Queue Processing with Retry**

`apps/api/src/queue-consumer.ts` uses `Promise.allSettled()` for independent message processing.
Failed messages get `msg.retry({ delaySeconds: 30 })` for Cloudflare's built-in retry.
`orders.queue.ts` has explicit inventory rollback on DB batch failure.

**6. Idempotent Payment Processing**

`packages/core/src/modules/payments/process-payment.ts` checks for duplicate payments before any mutations. DB-level unique indexes provide secondary idempotency guarantees.

**7. State Machine Validation**

`packages/core/src/modules/orders/order-state-machine.ts` throws `ValidationError` with detailed messages including allowed transitions, preventing invalid state changes.

**8. Admin Error Extraction**

`apps/admin/src/lib/api-helpers.ts` provides `extractApiError()` and `extractApiErrorDetails()` that gracefully handle multiple error response formats (standard, legacy, flat).

### Weaknesses

**1. Massive Silent Catch Block Problem**

Over 50 instances of `catch {}` or `catch { /* ignore */ }` exist across the codebase. While some are defensible (JSON.parse fallbacks, optional KV cache), many swallow errors that could indicate real problems:

**Defensible silent catches (JSON parsing fallbacks):**
- Navigation service: parsing headerConfig/footerConfig JSON
- Storefront service: parsing theme JSON
- Webhook handlers: parsing shipment metadata JSON

**Problematic silent catches:**
- `settings.service.ts` (10 instances): Every KV cache read/write silently fails. If KV is misconfigured, all settings operations silently fall back without any logging.
- `admin-auth.ts` (line 36-38): Better Auth session check silently fails. If the auth system is broken, admins silently get no session and fall through to JWT.
- `admin-auth.ts` (line 55-57): JWT verification silently fails. Combined with the above, auth failures produce no logs.
- `customer-auth.service.ts` (line 115, 124): Auth operations silently fail.

**2. ErrorBoundary Is Effectively Unused**

- `ErrorBoundary.tsx` exists with proper componentDidCatch logging
- `PageSection.tsx` wraps children in ErrorBoundary
- But `PageSection` is used in exactly 0 actual pages/components
- The 90+ admin React components with API calls have no crash protection
- If any hook throws during render, the entire admin UI crashes with a white screen

**3. Dual Error Propagation Patterns**

Core services use two incompatible patterns:

Pattern A (throw): Most services throw typed AppError subclasses
```
throw new NotFoundError("Order not found");
```

Pattern B (return result): Payment processing, delivery providers
```
return { success: false, error: "Payment processing error" };
```

This creates confusion. `processPaymentConfirmed()` catches ALL errors and returns `{ success: false }`. The queue consumer then checks the return value but some callers might expect throws.

**4. 39 Instances of `throw new Error()` in Core**

Files in `packages/core` throw 39 generic `Error` objects instead of using the typed hierarchy. These bypass the API's error code system and all map to 500 INTERNAL_ERROR:
- `integrations/firebase/admin.ts` (7 instances)
- `integrations/storage.ts` (6 instances)
- `modules/delivery/factory.ts` (5 instances)
- `modules/delivery/providers/pathao.ts` (4 instances)
- `auth/rbac/helpers.ts` (2 instances)
- `integrations/email/resend.ts` (2 instances)
- Various others

**5. No Structured Logging**

All error logging is via `console.error()` and `console.warn()` with ad-hoc prefixes:
- `[Queue]`, `[KV]`, `[Cache]`, `[EdgeCache]`, `[Notifications]`, `[CustomerAuth]`, etc.
- No JSON structured logs
- No request ID / correlation ID
- No log levels (everything is error or warn)
- No log sampling or rate limiting
- Cloudflare Workers logs are ephemeral without explicit integration

**6. No Global Unhandled Rejection Handler in Admin**

The storefront has a limited `unhandledrejection` handler (only for stale asset imports). The admin app has no global error handler at all. Unhandled promise rejections in admin React hooks are completely invisible.

### Critical Issues

**1. Admin Auth Silent Failure Chain (CRITICAL)**

In `apps/api/src/middleware/admin-auth.ts`, the three-stage auth check (Better Auth -> JWT -> Scanner Token) has silent catch blocks at each stage. If Better Auth is misconfigured and JWT verification has a bug, the auth middleware silently returns 401 without ANY logging. This makes production auth issues extremely difficult to diagnose.

**2. Payment Processing Swallows Errors (HIGH)**

`processPaymentConfirmed()` wraps the entire function in try/catch and returns `{ success: false }`. The queue consumer logs this but continues. If there's a systematic DB issue, payments would silently fail to process with only a console.error that's ephemeral in Cloudflare Workers.

**3. Settings Service Full Fallback Chain (MEDIUM)**

`settings.service.ts` has a pattern where KV read fails silently, DB read fails silently, and hardcoded defaults are returned. A broken DB connection would cause the entire store to run on default settings (BDT currency, "/" storefront URL) with no indication anything is wrong.

**4. Notification Delivery Failures (MEDIUM)**

`notifications.service.ts` catches FCM send errors per-token but the overall function catches its own errors (line 31). A systemic Firebase configuration issue would silently prevent all admin push notifications.

## Silent Failure Inventory

| File | Line(s) | Description |
|------|---------|-------------|
| `packages/core/src/modules/settings/settings.service.ts` | 57, 71, 75-76, 96, 120, 147, 160, 174 | KV cache and DB reads silently swallowed; falls back to defaults with no logging |
| `apps/api/src/middleware/admin-auth.ts` | 36-38, 55-57, 83-85 | All three auth strategy failures (Better Auth, JWT, Scanner) silently swallowed |
| `packages/core/src/modules/storefront/storefront.service.ts` | 29, 39-41, 336 | JSON parsing and DB reads fail silently |
| `packages/core/src/modules/customers/customer-auth.service.ts` | 115, 124 | Auth operations fail silently |
| `apps/admin/src/loaders/admin/orders.ts` | 91-93, 142-144, 152-154 | Order data loaders return empty arrays on any error |
| `apps/admin/src/loaders/admin/settings.ts` | 36-38, 45-47 | Settings loaders return empty arrays on any error |
| `apps/admin/src/loaders/admin/layout.ts` | 31-33 | Super admin check fails silently |
| `packages/core/src/modules/navigation/navigation.service.ts` | 87-88 | Header/footer config parsing fails silently |
| `packages/core/src/modules/settings/site-settings.service.ts` | 61 | JSON parsing fails silently, returns empty object |
| `packages/core/src/modules/settings/checkout-config.service.ts` | (multiple) | Checkout config parsing with silent fallbacks |
| `apps/storefront/src/lib/checkout/index.ts` | 62-65, 79-81, 209-211, 256-258 | Multiple `catch { // ignore }` in checkout flow |
| `apps/storefront/src/lib/checkout/create-order.ts` | 12-14 | Order creation response parsing silently ignored |
| `apps/api/src/routes/webhooks/sslcommerz.ts` | 32-34 | SSLCommerz webhook error returns "OK" (hides failures from gateway) |
| `packages/core/src/modules/payments/process-payment.ts` | 312-314 | `recordWebhookEvent` duplicate key catch is intentional but overly broad |
| `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` | 66-68, 90-92 | Fraud check failures return null (fraud score unavailable is treated as clean) |
| `apps/storefront/src/middleware.ts` | 282 | CDN domain read `catch {}` -- empty catch, no variable name |
| `packages/core/src/modules/delivery/pathao-location-import.ts` | 140 | Malformed location entries silently skipped |
| `apps/api/src/routes/payment/sslcommerz-routes.ts` | 182 | Error parsing falls through silently |

## Recommendations

### P0 -- Critical (Do Now)

1. **Add logging to admin-auth.ts catch blocks.** The silent auth failure chain is a production debuggability disaster. At minimum, add `console.warn` with the auth method that failed and a sanitized error message (not the full error, for security).

2. **Add logging to settings.service.ts catch blocks.** When KV or DB operations fail, log a warning. The silent fallback to defaults can cause invisible data corruption (e.g., wrong currency on all orders).

3. **Wrap all admin page roots in ErrorBoundary.** The ErrorBoundary component exists but is unused. Import it in each admin page's root React component to prevent white-screen crashes.

### P1 -- High (This Sprint)

4. **Eliminate generic `throw new Error()` from core.** Replace the 39 instances in `packages/core` with appropriate AppError subclasses. This ensures the API returns proper status codes instead of 500 for what are really 400/404/503 errors.

5. **Standardize error propagation pattern.** Choose ONE pattern for core services:
   - For business validation: throw typed errors (already dominant)
   - For external service calls (payment/delivery): return result objects with typed errors for the failure case
   - Document the rule in CLAUDE.md

6. **Add request-scoped logging context.** Create a simple logging wrapper that attaches a request ID (from `crypto.randomUUID()`) to all log calls within a request. This enables correlating logs across the DB -> Core -> API chain.

### P2 -- Medium (Next Sprint)

7. **Implement structured JSON logging.** Replace `console.error/warn` with a thin logger that outputs JSON with fields: `{ level, message, requestId, module, error?, timestamp }`. This enables Cloudflare Logpush integration.

8. **Add health check for external services.** Extend `/health` to probe DB, KV, R2, and optionally payment gateways. Return degraded status when services are unhealthy.

9. **Add circuit breaker for delivery providers.** Delivery API calls (Steadfast, Pathao) currently retry on the caller's side. Implement a simple circuit breaker (count failures, open circuit after N failures, half-open after cooldown) to prevent cascading failures during provider outages.

10. **Add error rate monitoring hooks.** Create an `onError` event emitter in the API layer that can be subscribed to by monitoring integrations (Sentry, Datadog, custom analytics). Even without a monitoring service, tracking error counts in KV provides basic alerting capability.

### P3 -- Low (Backlog)

11. **Add retry logic to admin SSR API client.** `apps/admin/src/lib/api-server.ts` has no retry logic (unlike the storefront client). SSR page loads that hit a transient API error return error pages with no recovery.

12. **Implement dead letter queue for payment failures.** Currently, if a payment queue message fails all 3 Cloudflare retries, it is lost. Add a DLQ mechanism (write to a `failed_payments` table or separate KV namespace) for manual review.

13. **Add error boundary reporting.** When the React ErrorBoundary catches an error, it should POST the error details to an API endpoint for server-side logging (client-side errors are otherwise invisible).

14. **Normalize the `console.error` prefix taxonomy.** Current prefixes are ad-hoc: `[Queue]`, `[KV]`, `[Cache]`, `[process-payment]`, `API Error (onError):`. Define a standard set of module prefixes and enforce via linting.
