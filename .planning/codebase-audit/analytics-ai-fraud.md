# Analytics, AI & Fraud Checker Audit

**Date:** 2026-03-20

## Summary

Three loosely related admin-facing domains examined across core services, API routes, and admin UI. **Analytics** (script management + dashboard stats) is solid but has type-safety gaps and a timestamp comparison bug. **AI** (OpenRouter integration + prompt helpers) has significant code duplication and the most `as any` casts in the API layer. **Fraud Checker** (phone lookup for merchant risk assessment) is cleanly structured with a provider registry pattern. **Meta Conversions** (CAPI event logging) works but has a retention logic mismatch between core service and DB schema. Overall code quality is above average for these domains, with a handful of correctible issues.

---

## Critical Issues

### C1. Duplicate System Prompt URLs (AI)

**Files:**
- `packages/core/src/modules/ai/ai-config.ts` (lines 13-17) -- defines `SYSTEM_PROMPT_URLS`
- `apps/api/src/routes/admin/ai-prompts.ts` (lines 9-13) -- redefines identical `PROMPT_URLS`

The same three URLs (`text.wrygo.com`) are hardcoded in both files. If one is updated, the other will silently fall out of sync. The route file does not import from `ai-config.ts` even though the config module was built specifically to centralize these values.

**Fix:** Delete the local `PROMPT_URLS` in `ai-prompts.ts` and import `SYSTEM_PROMPT_URLS` from `@scalius/core/modules/ai/ai-config`.

### C2. `Record<string, unknown>` Parameter in analytics.service.ts (Analytics)

**Files:**
- `packages/core/src/modules/analytics/analytics.service.ts` (lines 39, 60)

`createAnalyticsScript` and `updateAnalyticsScript` accept `data: Record<string, unknown>` and cast every field with `as string`, `as boolean`, etc. This bypasses the Zod validation schema that the API route validates against, and means the service layer has zero type safety. Any runtime caller passing bad data will silently insert garbage.

**Fix:** Define a typed interface (or reuse the Zod schema's inferred type from `analytics.validation.ts`) for the `data` parameter:
```typescript
import type { z } from "zod";
import { createAnalyticsSchema } from "./analytics.validation";
type CreateAnalyticsInput = z.infer<typeof createAnalyticsSchema>;
```

### C3. Timestamp vs. Date Comparison Bug in getDailyActivityData (Dashboard)

**File:** `packages/core/src/modules/analytics/dashboard.service.ts` (lines 155, 173)

The `orders.createdAt` column is `integer("created_at", { mode: "timestamp" })` in the schema -- Drizzle's `timestamp` mode stores/returns a `Date` object. However, `getDailyActivityData` creates `startDate` as a JavaScript `Date` object and passes it directly to `gte(orders.createdAt, startDate)`.

Meanwhile, `getDashboardStats` (lines 19-22) correctly computes integer unix timestamps (`firstDayOfMonthTs`, `firstDayOfLastMonthTs`) and uses raw `sql` templates with them.

The inconsistency means `getDailyActivityData` relies on Drizzle's automatic Date-to-integer conversion for the `gte` comparison. This works in practice because Drizzle handles it, but the two functions in the same file use contradictory approaches. This is a maintenance hazard -- someone copying the pattern from one function to the other will introduce a bug.

**Fix:** Standardize on one approach. Since the schema uses `mode: "timestamp"`, use `Date` objects consistently with Drizzle's typed operators, or use raw `sql` templates consistently.

### C4. `as any` Handler Casts in OpenRouter Routes (AI)

**Files:**
- `apps/api/src/routes/admin/openrouter.ts` (lines 33, 99, 240) -- three `as any` casts on route handlers
- `apps/api/src/routes/admin/analytics.ts` (line 47) -- one `as any` cast

These casts on the `.openapi()` handler callback and its `c` parameter eliminate all type checking inside the handler body. This defeats the purpose of using OpenAPIHono for type-safe routes. The casts exist to work around Hono's OpenAPI type inference when the route schema uses `.passthrough()` or complex types.

**Fix:** Properly type the route schemas so the handler types resolve without casts. If Hono's type inference cannot handle it, extract the handler as a named function with explicit typing rather than casting the entire function.

---

## Code Quality Issues

### Q1. `manualLogCleanup` Duplicates `performLogCleanup` Logic (Meta Service)

**File:** `packages/core/src/modules/analytics/meta.service.ts`

`manualLogCleanup` (lines 76-99) and `performLogCleanup` (lines 59-70) contain identical deletion logic with the same `lt(metaConversionsLogs.createdAt, cutoffTime)` query. The only difference is the return type (void vs. result object).

**Fix:** Have `manualLogCleanup` call `performLogCleanup` internally and wrap the result:
```typescript
export async function manualLogCleanup(db: Database, retentionHours: number) {
  try {
    await performLogCleanup(db, retentionHours);
    return { success: true, message: `...` };
  } catch (error) { ... }
}
```

### Q2. Retention Unit Mismatch (Meta Service vs. Schema)

**Files:**
- `packages/database/src/schema/marketing.ts` (line 117) -- `logRetentionDays` (days)
- `packages/core/src/modules/analytics/meta.service.ts` (line 37) -- `retentionHours: number = 12` (hours)

The DB schema stores `logRetentionDays` as an integer in days. The service functions accept and operate on hours. The caller must convert, but there is no documented contract about this unit mismatch. The `MetaConversionsSettingsForm` UI shows "Log Retention (Days)" but the service works in hours.

**Fix:** Either convert days-to-hours at the call site and document it clearly, or change the service to accept days and convert internally.

### Q3. Unvalidated `type` Query Parameter (AI Prompts)

**File:** `apps/api/src/routes/admin/ai-prompts.ts` (line 33)

```typescript
const promptType = type as keyof typeof PROMPT_URLS;
const promptUrl = PROMPT_URLS[promptType] || PROMPT_URLS.widget;
```

The `type` parameter is declared as `z.string().optional().default("widget")` but never validated against the known prompt types. An invalid type silently falls back to `widget`. While not dangerous, it masks user errors. The Zod schema should use `z.enum(["widget", "landing-page", "collection"])` to match the prompt URL keys.

### Q4. `FraudCheckResult` Name Collision (Fraud Checker)

**Files:**
- `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` (line 27) -- exports `FraudCheckResult` (service-level)
- `packages/core/src/modules/fraud-checker/provider.ts` (line 8) -- exports `FraudCheckResult` (provider-level)
- `packages/core/src/modules/fraud-checker/index.ts` (lines 11-15) -- re-exports both with rename

The barrel export uses `FraudCheckResult as ProviderFraudCheckResult` to disambiguate, but this forces all consumers to remember which is which. The service file also imports `FraudCheckResult as ProviderFraudCheckResult` internally. These should have distinct names at the source.

**Fix:** Rename the provider-level type to `ProviderLookupResult` in `provider.ts` to eliminate the aliasing.

### Q5. Fraud Checker API Route Uses PUT Without Path ID

**File:** `apps/api/src/routes/admin/fraud-checker.ts` (line 101-113)

The update route uses `PUT /` with `id` in the request body, not `PUT /{id}` in the path. This violates REST conventions and is inconsistent with the delete route which uses `DELETE /{id}`. It makes the API harder to understand and the OpenAPI spec less useful.

**Fix:** Change to `PUT /{id}` with `id` in path params, matching the delete route pattern.

### Q6. `ai-context.ts` Route Has a Bare `try/catch` That Re-throws

**File:** `apps/api/src/routes/admin/ai-context.ts` (lines 81-239)

The entire handler is wrapped in `try { ... } catch (error) { console.error("Batch fetch error:", error); throw error; }`. The `console.error` + `throw` pattern adds noise without value -- Hono's error handler already logs errors. Several fraud-checker routes have the same pattern (lines 35-48, 73-89, etc.).

**Fix:** Remove the outer try/catch wrappers. Let Hono's global error handler manage logging and response formatting.

---

## Pattern Violations

### P1. Analytics Service Does Not Use `@scalius/core/errors`

**File:** `packages/core/src/modules/analytics/analytics.service.ts`

Other domain services (fraud-checker, orders, payments, etc.) throw typed errors from `@scalius/core/errors` (e.g., `NotFoundError`, `ValidationError`). The analytics service returns `null` for not-found cases and lets the API route handle the error. This is inconsistent with the codebase pattern.

**Fix:** Throw `NotFoundError` from the service layer rather than returning `null`, matching the pattern used in `fraud-checker.service.ts`.

### P2. Dashboard Stats Uses Mixed SQL Styles

**File:** `packages/core/src/modules/analytics/dashboard.service.ts`

`getDashboardStats` (lines 10-68) uses raw `sql` template literals for date comparisons with integer timestamps. `getDailyActivityData` (lines 140-210) mixes Drizzle's `gte()` operator with raw `sql` for status checks. `getRecentOrders` (lines 117-134) uses Drizzle's `desc()` with a raw `sql` for date formatting.

Three functions, three different approaches. This makes the code harder to maintain and reason about.

### P3. Analytics Form Uses `alert()` Instead of `toast()`

**File:** `apps/admin/src/components/admin/AnalyticsForm.tsx` (line 103)

```typescript
alert("Failed to save analytics script. Please try again.");
```

Every other component in the admin app uses `sonner` toast notifications. `AnalyticsList.tsx` (same domain) correctly uses `toast.error()`.

**Fix:** Replace `alert()` with `toast.error("Failed to save analytics script. Please try again.")` and import `toast` from `sonner`.

### P4. Meta Conversions Logs Has Custom Pagination, Not `AdminListPagination`

**File:** `apps/admin/src/components/admin/meta-conversions/MetaConversionsLogs.tsx` (lines 72-131)

The component implements its own `Pagination` component with "First/Last" buttons and page number rendering. The rest of the admin app uses `AdminListPagination` from `apps/admin/src/components/admin/shared/AdminListPagination.tsx` (used by `AnalyticsList.tsx`, for example).

**Fix:** Replace the custom `Pagination` component with `AdminListPagination` for consistency.

### P5. `ai-prompts.ts` Returns `text/plain` Instead of JSON Envelope

**File:** `apps/api/src/routes/admin/ai-prompts.ts` (line 55)

```typescript
return c.text(systemPrompt, 200, { "Content-Type": "text/plain" });
```

All other API routes return `{ success: true, data: T }` via `ok(c, data)`. This route returns raw text. While technically correct for serving a prompt string, it breaks the envelope contract that admin proxy and SDK expect.

**Fix:** Either return `ok(c, { prompt: systemPrompt })` or document this as an intentional exception. If the admin client handles it as text, ensure it does not try to call `unwrapEnvelope()` on the response.

---

## Maintainability Concerns

### M1. `ai-config.ts` Is a 357-Line God Config (AI)

**File:** `packages/core/src/modules/ai/ai-config.ts`

This file contains: system prompt URLs, fallback prompts, OpenRouter config, model capability thresholds, generation config (temperature, timeouts, retry, context limits), prompt assembly instructions, UI config (preview devices, toast durations, progress settings), error messages, success messages, helper functions, and type exports.

Mixing backend configuration (model capabilities, retry logic) with frontend UI config (toast durations, preview device widths) in the same file creates a coupling problem. Changing a toast duration requires editing the same file as changing retry logic.

**Recommendation:** Split into `ai-config.ts` (backend: models, prompts, retry, timeouts), `ai-ui-config.ts` (frontend: previews, toasts, progress), and `ai-messages.ts` (error/success message strings).

### M2. `prompt-helper-v2.ts` Has DOM Reference for Server-Side Code (AI)

**File:** `packages/core/src/modules/ai/prompt-helper-v2.ts` (line 1)

```typescript
/// <reference lib="dom" />
```

And on line 142:
```typescript
if (typeof Image === "undefined") {
    return { width: 0, height: 0 };
}
```

This is a `@scalius/core` package file, which runs in Cloudflare Workers (no DOM). The `Image` constructor is browser-only. The code correctly guards against its absence, but including `/// <reference lib="dom" />` pollutes the TypeScript environment for all files that import this module, potentially masking type errors elsewhere.

**Fix:** Remove the `/// <reference lib="dom" />` directive. The `typeof Image === "undefined"` guard already handles the runtime case. If Image types are needed, use a `declare` statement scoped to this file.

### M3. `ai-context-schema.ts` Recovery Logic Is Overly Complex

**File:** `packages/core/src/modules/ai/ai-context-schema.ts` (lines 99-156)

`parseAiContext` has three layers of parsing: parse JSON, validate with Zod, then manually reconstruct and re-validate if Zod fails. The manual recovery (lines 126-139) duplicates the schema's default values and could easily drift.

**Recommendation:** Use `AiContextSchema.partial().safeParse()` with `.merge()` instead of manual field-by-field recovery. Or simplify to: parse JSON, safeParse, return `.data` on success or empty context on failure.

---

## Performance & Scalability

### S1. Dashboard Makes 5 Sequential-ish DB Queries (Analytics)

**File:** `packages/core/src/modules/analytics/dashboard.service.ts` (lines 24-69)

`getDashboardStats` uses `Promise.all` for 5 queries -- good. But `getDailyActivityData` (lines 145-183) makes two separate queries (orders + customers) that could potentially be combined into a single query with a join or union. For stores with large order volumes, the two full-table scans with `strftime` formatting on every row will be slow.

**Recommendation:** Consider a materialized daily summary table for stores beyond a few thousand orders, or at minimum add a composite index on `(created_at, deleted_at, status)` for the orders table.

### S2. `ai-context.ts` N+1 URL Resolution

**File:** `apps/api/src/routes/admin/ai-context.ts` (lines 132-148)

The batch-details endpoint correctly batches URL resolution via `Promise.all` over all paths. However, each path calls `SettingsService.getStorefrontPath(db, path, kv)` which likely makes a DB or KV lookup per path. For a request with 20 products, 10 variants, and 5 categories, this generates 55+ individual lookups.

**Recommendation:** `getStorefrontPath` should accept a batch of paths and resolve them all with a single DB query + KV batch get.

### S3. `logCapiEvent` Fire-and-Forget Cleanup on Every Log Write (Meta)

**File:** `packages/core/src/modules/analytics/meta.service.ts` (line 50)

```typescript
void performLogCleanup(db, retentionHours);
```

Every single CAPI event triggers a fire-and-forget DELETE query against the logs table. For high-traffic stores sending many CAPI events, this means an extra DELETE query per event. Since the cleanup is time-based, running it once per hour (via a cron or scheduled worker) would be more efficient.

**Recommendation:** Remove the per-event cleanup. Use Cloudflare Cron Triggers to run cleanup on a schedule, or throttle cleanup to once per N events using an in-memory counter.

### S4. OpenRouter Model List Not Cached

**File:** `apps/api/src/routes/admin/openrouter.ts` (line 36)

The `/models` endpoint fetches the full model list from `https://openrouter.ai/api/v1/models` on every request. OpenRouter's model list changes rarely (maybe weekly). This should be cached in KV for 1-4 hours.

---

## Robustness Gaps

### R1. Fraud Checker `testFraudProvider` Uses Hardcoded Phone Number

**File:** `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` (line 176)

```typescript
const result = await fraudLookup(provider, "+8801700000000");
```

The test uses a hardcoded Bangladesh phone number. This will fail for fraud-checking providers that only support other regions. The test also makes a real API call that counts against rate limits.

**Fix:** Make the test phone number configurable per provider, or use a `/ping` or `/health` endpoint if the provider supports it.

### R2. OpenRouter Generate Has No Rate Limiting

**File:** `apps/api/src/routes/admin/openrouter.ts`

The `/generate` and `/generate-staged` endpoints have no rate limiting. A bug in the admin frontend could trigger rapid-fire generation requests, burning through the OpenRouter API key's credits quickly.

**Recommendation:** Add a simple in-memory rate limiter (e.g., max 5 requests per minute per admin user) or use `@scalius/shared/rate-limit`.

### R3. Streaming Response Bypasses Envelope Contract

**File:** `apps/api/src/routes/admin/openrouter.ts` (lines 180-187)

When `stream: true`, the handler returns a raw `Response` with `text/event-stream` content type, bypassing both `ok()` and any error handling middleware. If the upstream OpenRouter stream errors mid-response, the client receives a truncated SSE stream with no error indication.

**Recommendation:** At minimum, wrap the streaming response to inject an error event at the end of the stream if the upstream fails.

### R4. `getImageDimensions` Always Returns {0,0} in Workers

**File:** `packages/core/src/modules/ai/prompt-helper-v2.ts` (lines 137-167)

The function uses the `Image()` DOM constructor. In Cloudflare Workers (where this code runs server-side), `typeof Image === "undefined"` is always true, so it always returns `{width: 0, height: 0}`. The function only works in the browser context, but the module is exported from `@scalius/core` which is a server-side package.

The downstream effect: `generateImageContext` filters out images with `width === 0` (line 229), meaning dimension info is always empty when called server-side. The images still get included as URLs without dimensions.

**Impact:** Minor -- the AI generation still works, it just does not include dimension metadata. But the dead code path is misleading.

### R5. Analytics Timestamp Formatting Inconsistency

**File:** `packages/core/src/modules/analytics/analytics.service.ts` (lines 11-22)

`formatScriptResponse` manually converts unix timestamps to ISO strings: `new Date(Number(script.createdAt) * 1000).toISOString()`. But the schema defines `createdAt` with `mode: "timestamp"`, meaning Drizzle returns `Date` objects, not raw integers. Multiplying a Date's valueOf by 1000 would produce a date in the year ~65000.

The function uses `Number(script.createdAt)` which, for a `Date` object, returns milliseconds since epoch. Multiplying by 1000 turns milliseconds into microseconds, yielding incorrect dates.

**This is a real bug.** The `* 1000` multiplication assumes the value is a unix timestamp in seconds, but `mode: "timestamp"` gives a `Date` object whose `.valueOf()` is in milliseconds. The `Number(date)` returns milliseconds, then `* 1000` makes it 1000x too large.

**Fix:** Since Drizzle returns `Date` objects with `mode: "timestamp"`, just call `.toISOString()` directly:
```typescript
createdAt: script.createdAt ? script.createdAt.toISOString() : null,
```

---

## LLM-Friendliness

### L1. AI Module Architecture Is Well-Structured for LLM Consumption

The `ai-config.ts` file, despite being large, has excellent organization with clear section headers (`// ====`), JSDoc comments, and `as const` assertions. The prompt helper has clear type definitions and documented function signatures. An LLM can understand and modify these files effectively.

### L2. Analytics Service Lacks JSDoc on Public Functions

**File:** `packages/core/src/modules/analytics/analytics.service.ts`

Only `formatScriptResponse` has a comment. The public CRUD functions (`listAnalyticsScripts`, `createAnalyticsScript`, etc.) have no documentation. Compare with `meta.service.ts` which has JSDoc on every function.

### L3. Fraud Checker Provider Pattern Is Exemplary

**Files:**
- `packages/core/src/modules/fraud-checker/provider.ts` -- clean interface + registry pattern
- `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` -- typed errors, clear function signatures

The fraud checker uses a well-documented provider registry with `FraudCheckProvider` interface, a `DefaultFraudCheckProvider` implementation, and `registerFraudCheckProvider`/`getFraudCheckProvider` registry functions. This pattern is easy for an LLM to extend with new providers.

### L4. Dashboard Service Would Benefit From Query Comments

**File:** `packages/core/src/modules/analytics/dashboard.service.ts`

The raw SQL strings (e.g., `sum(case when status NOT IN ('cancelled', 'returned') then total_amount else 0 end)`) are complex enough to warrant inline comments explaining the business logic.

---

## Recommended Changes

### Priority: High (Bugs / Data Correctness)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 1 | **Fix timestamp formatting bug (R5)** -- `Number(date) * 1000` is wrong for Date objects | `packages/core/src/modules/analytics/analytics.service.ts` | 5 min |
| 2 | **Type the analytics service parameters (C2)** -- replace `Record<string, unknown>` with Zod-inferred types | `packages/core/src/modules/analytics/analytics.service.ts` | 15 min |
| 3 | **Remove duplicate prompt URLs (C1)** -- import from `ai-config.ts` in `ai-prompts.ts` | `apps/api/src/routes/admin/ai-prompts.ts` | 5 min |

### Priority: Medium (Consistency / Maintainability)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 4 | **Fix `as any` casts in OpenRouter/analytics routes (C4)** -- properly type handlers | `apps/api/src/routes/admin/openrouter.ts`, `analytics.ts` | 30 min |
| 5 | **Replace `alert()` with `toast()` (P3)** | `apps/admin/src/components/admin/AnalyticsForm.tsx` | 2 min |
| 6 | **Use `AdminListPagination` in Meta logs (P4)** | `apps/admin/src/components/admin/meta-conversions/MetaConversionsLogs.tsx` | 15 min |
| 7 | **Deduplicate `manualLogCleanup` (Q1)** | `packages/core/src/modules/analytics/meta.service.ts` | 10 min |
| 8 | **Validate prompt `type` query param with z.enum (Q3)** | `apps/api/src/routes/admin/ai-prompts.ts` | 5 min |
| 9 | **Fix fraud-checker PUT route to use path ID (Q5)** | `apps/api/src/routes/admin/fraud-checker.ts` | 15 min |
| 10 | **Remove DOM reference from core package (M2)** | `packages/core/src/modules/ai/prompt-helper-v2.ts` | 5 min |
| 11 | **Rename `FraudCheckResult` to eliminate collision (Q4)** | `packages/core/src/modules/fraud-checker/provider.ts`, `index.ts` | 10 min |
| 12 | **Standardize analytics service errors to throw NotFoundError (P1)** | `packages/core/src/modules/analytics/analytics.service.ts` | 15 min |

### Priority: Low (Performance / Nice-to-Have)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 13 | **Cache OpenRouter model list in KV (S4)** | `apps/api/src/routes/admin/openrouter.ts` | 20 min |
| 14 | **Remove per-event log cleanup, use cron (S3)** | `packages/core/src/modules/analytics/meta.service.ts` | 20 min |
| 15 | **Add rate limiting to OpenRouter generate endpoints (R2)** | `apps/api/src/routes/admin/openrouter.ts` | 20 min |
| 16 | **Split ai-config.ts into backend/frontend/messages (M1)** | `packages/core/src/modules/ai/ai-config.ts` | 30 min |
| 17 | **Simplify `parseAiContext` recovery logic (M3)** | `packages/core/src/modules/ai/ai-context-schema.ts` | 20 min |
| 18 | **Make fraud-checker test phone configurable (R1)** | `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` | 10 min |
| 19 | **Remove try/catch rethrow wrappers (Q6)** | `apps/api/src/routes/admin/ai-context.ts`, `fraud-checker.ts` | 10 min |
| 20 | **Standardize dashboard query style (P2)** | `packages/core/src/modules/analytics/dashboard.service.ts` | 30 min |

---

## File Index

### Analytics Domain
- `packages/database/src/schema/system.ts` -- `analytics` table schema (lines 60-76)
- `packages/core/src/modules/analytics/analytics.service.ts` -- CRUD for analytics scripts
- `packages/core/src/modules/analytics/analytics.validation.ts` -- Zod schemas for create/update/toggle
- `packages/core/src/modules/analytics/dashboard.service.ts` -- Dashboard stats, recent orders, daily activity queries
- `packages/core/src/modules/analytics/meta.service.ts` -- Meta CAPI settings + log management
- `packages/core/src/modules/analytics/index.ts` -- Barrel exports
- `apps/api/src/routes/admin/analytics.ts` -- OpenAPI routes for analytics scripts
- `apps/api/src/routes/admin/dashboard.ts` -- Dashboard summary route
- `apps/admin/src/components/admin/AnalyticsList.tsx` -- Analytics script table + pagination
- `apps/admin/src/components/admin/AnalyticsForm.tsx` -- Create/edit analytics script form
- `apps/admin/src/components/admin/DashboardStats.tsx` -- Dashboard stats cards + chart container
- `apps/admin/src/components/admin/DashboardChart.tsx` -- Recharts area chart for daily activity

### AI Domain
- `packages/core/src/modules/ai/ai-config.ts` -- Centralized AI config (357 lines)
- `packages/core/src/modules/ai/ai-context-schema.ts` -- Zod schemas for widget AI context persistence
- `packages/core/src/modules/ai/prompt-helper-v2.ts` -- Structured prompt builder with caching support
- `packages/core/src/modules/ai/index.ts` -- Barrel exports
- `apps/api/src/routes/admin/ai-context.ts` -- Batch product/category details for AI context
- `apps/api/src/routes/admin/ai-prompts.ts` -- System prompt fetcher
- `apps/api/src/routes/admin/openrouter.ts` -- OpenRouter model list + generate + staged generate

### Fraud Checker Domain
- `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` -- Provider CRUD + phone lookup
- `packages/core/src/modules/fraud-checker/provider.ts` -- Provider interface + registry + default provider
- `packages/core/src/modules/fraud-checker/index.ts` -- Barrel exports
- `apps/api/src/routes/admin/fraud-checker.ts` -- OpenAPI routes for provider management + lookup
- `apps/admin/src/components/admin/FraudCheckerSettings.tsx` -- Provider list/detail/form UI

### Meta Conversions Domain
- `packages/database/src/schema/marketing.ts` -- `metaConversionsSettings` + `metaConversionsLogs` tables
- `apps/admin/src/components/admin/meta-conversions/MetaConversionsContainer.tsx` -- Tab container
- `apps/admin/src/components/admin/meta-conversions/MetaConversionsSettingsForm.tsx` -- Settings form
- `apps/admin/src/components/admin/meta-conversions/MetaConversionsLogs.tsx` -- Log table + pagination
- `apps/admin/src/components/admin/meta-conversions/LogDetails.tsx` -- Expandable log detail view
- `apps/admin/src/components/admin/meta-conversions/hooks/useMetaConversionsSettings.ts` -- Settings hook
- `apps/admin/src/components/admin/meta-conversions/hooks/useMetaConversionsLogs.ts` -- Logs hook
- `apps/admin/src/components/admin/meta-conversions/index.ts` -- Barrel export
