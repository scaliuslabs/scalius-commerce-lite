# Analytics, AI & Fraud Checker Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Analytics (scripts + dashboard + meta), AI (OpenRouter + prompts + context), Fraud Checker (provider management + lookup)

---

## Previous Finding Status

### Critical Issues

#### C1. Duplicate System Prompt URLs (AI) -- STILL OPEN

**Files:**
- `packages/core/src/modules/ai/ai-config.ts` (lines 13-17) -- defines `SYSTEM_PROMPT_URLS`
- `apps/api/src/routes/admin/ai-prompts.ts` (lines 10-14) -- redefines identical `PROMPT_URLS`

The same three `text.wrygo.com` URLs are still hardcoded in both files. The route file still does not import from `ai-config.ts`. No change since previous audit.

**Fix:** Delete `PROMPT_URLS` in `ai-prompts.ts` and import `SYSTEM_PROMPT_URLS` from `@scalius/core/modules/ai/ai-config`.

#### C2. `Record<string, unknown>` Parameter in analytics.service.ts -- STILL OPEN

**Files:**
- `packages/core/src/modules/analytics/analytics.service.ts` (lines 40, 61)

`createAnalyticsScript` and `updateAnalyticsScript` still accept `data: Record<string, unknown>` and cast every field with `as string`, `as boolean`, etc. The Zod schema in `analytics.validation.ts` defines proper types but the service layer does not use them.

**Fix:** Use Zod-inferred types:
```typescript
import type { z } from "zod";
import type { createAnalyticsSchema, updateAnalyticsSchema } from "./analytics.validation";
type CreateAnalyticsInput = z.infer<typeof createAnalyticsSchema>;
type UpdateAnalyticsInput = z.infer<typeof updateAnalyticsSchema>;
```

#### C3. Timestamp vs. Date Comparison in getDailyActivityData (Dashboard) -- STILL OPEN

**File:** `packages/core/src/modules/analytics/dashboard.service.ts` (lines 155, 175)

`getDailyActivityData` creates a `Date` object for `startDate` and passes it to `gte(orders.createdAt, startDate)`. Meanwhile `getDashboardStats` (lines 19-22) uses integer unix timestamps with raw `sql` templates. The schema confirms `orders.createdAt` is `integer("created_at", { mode: "timestamp" })`, so Drizzle returns Date objects. Both approaches technically work via Drizzle's automatic conversion, but the inconsistency persists within the same file.

**Status:** Still inconsistent. The two approaches co-exist. Not a runtime bug, but a maintenance hazard.

#### C4. `as any` Handler Casts in OpenRouter/Analytics Routes -- STILL OPEN

**Files:**
- `apps/api/src/routes/admin/openrouter.ts` (lines 71, 214, 342) -- three `as any` casts on route handlers
- `apps/api/src/routes/admin/analytics.ts` (lines 29, 52) -- two `as any` casts (increased from one)

No change. The casts eliminate type checking inside handler bodies. The analytics route now has two `as any` casts (list + create handlers), up from one in the previous audit.

---

### Code Quality Issues

#### Q1. `manualLogCleanup` Duplicates `performLogCleanup` Logic (Meta Service) -- STILL OPEN

**File:** `packages/core/src/modules/analytics/meta.service.ts`

`manualLogCleanup` (lines 76-100) and `performLogCleanup` (lines 59-71) still contain identical deletion logic. The cutoff calculation and DELETE query are duplicated verbatim. `manualLogCleanup` does not delegate to `performLogCleanup`.

#### Q2. Retention Unit Mismatch (Meta Service vs. Schema) -- STILL OPEN

**Files:**
- `packages/database/src/schema/marketing.ts` (line 117) -- `logRetentionDays` (days), integer, default 30
- `packages/core/src/modules/analytics/meta.service.ts` (line 37) -- `retentionHours: number = 12` (hours)

The schema stores days. The service accepts hours. No conversion documentation or inline comment explaining the contract. The default of 12 hours does not match the schema default of 30 days (which would be 720 hours).

#### Q3. Unvalidated `type` Query Parameter (AI Prompts) -- STILL OPEN

**File:** `apps/api/src/routes/admin/ai-prompts.ts` (lines 23, 34-35)

```typescript
type: z.string().optional().default("widget")
// ...
const promptType = type as keyof typeof PROMPT_URLS;
const promptUrl = PROMPT_URLS[promptType] || PROMPT_URLS.widget;
```

The `type` parameter still uses `z.string()` instead of `z.enum(["widget", "landing-page", "collection"])`. Invalid values silently fall back to `widget`.

#### Q4. `FraudCheckResult` Name Collision (Fraud Checker) -- STILL OPEN

**Files:**
- `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` (line 27) -- exports `FraudCheckResult` (service-level)
- `packages/core/src/modules/fraud-checker/provider.ts` (line 8) -- exports `FraudCheckResult` (provider-level)
- `packages/core/src/modules/fraud-checker/index.ts` (lines 11-15) -- re-exports with `FraudCheckResult as ProviderFraudCheckResult`

The aliasing in the barrel file and at the import site in the service file (`import type { FraudCheckResult as ProviderFraudCheckResult }`) is unchanged.

#### Q5. Fraud Checker API Route Uses PUT Without Path ID -- STILL OPEN

**File:** `apps/api/src/routes/admin/fraud-checker.ts` (lines 101-113)

The update route still uses `PUT /` with `id` in the request body. The delete route uses `DELETE /{id}` with path params. Inconsistent REST design unchanged.

#### Q6. `ai-context.ts` Route Has a Bare `try/catch` That Re-throws -- STILL OPEN

**File:** `apps/api/src/routes/admin/ai-context.ts` (lines 82, 236-239)

The entire handler is still wrapped in `try { ... } catch (error: unknown) { console.error("Batch fetch error:", error); throw error; }`. Adds noise without value.

The fraud-checker route (`apps/api/src/routes/admin/fraud-checker.ts`) has the same pattern in multiple handlers (lines 35-47, 73-88, 115-138, 157-165, 184-192). Five separate `try/catch` blocks that all just `throw error`.

---

### Pattern Violations

#### P1. Analytics Service Does Not Use `@scalius/core/errors` -- STILL OPEN

**File:** `packages/core/src/modules/analytics/analytics.service.ts`

Functions `updateAnalyticsScript`, `toggleAnalyticsScript`, and `deleteAnalyticsScript` still return `null` for not-found cases (lines 68-70, 95-97, 117-119). The API route at `apps/api/src/routes/admin/analytics.ts` handles the null check and throws `NotFoundError` from the API layer. Contrast with `fraud-checker.service.ts` which throws `NotFoundError` from the service layer.

#### P2. Dashboard Stats Uses Mixed SQL Styles -- STILL OPEN

**File:** `packages/core/src/modules/analytics/dashboard.service.ts`

Three functions, three approaches: `getDashboardStats` uses raw `sql` with integer timestamps, `getDailyActivityData` mixes `gte()` with raw `sql`, `getRecentOrders` uses raw `sql` for date formatting plus Drizzle's `desc()`. No change.

#### P3. Analytics Form Uses `alert()` Instead of `toast()` -- STILL OPEN

**File:** `apps/admin/src/components/admin/AnalyticsForm.tsx` (line 103)

```typescript
alert("Failed to save analytics script. Please try again.");
```

Still uses `alert()` instead of `toast.error()` from sonner. Every other component in the admin app uses toast notifications.

#### P4. Meta Conversions Logs Has Custom Pagination -- STILL OPEN

**File:** `apps/admin/src/components/admin/meta-conversions/MetaConversionsLogs.tsx` (lines 72-131)

The custom `Pagination` component with "First/Last" buttons and page number rendering is unchanged. `AdminListPagination` from `apps/admin/src/components/admin/shared/AdminListPagination.tsx` is available and used by `AnalyticsList.tsx`, `WidgetsList.tsx`, `InventoryManager.tsx`, and `AbandonedCheckoutsManager.tsx`.

#### P5. `ai-prompts.ts` Returns `text/plain` Instead of JSON Envelope -- STILL OPEN

**File:** `apps/api/src/routes/admin/ai-prompts.ts` (line 56)

```typescript
return c.text(systemPrompt, 200, {
    "Content-Type": "text/plain",
    "Cache-Control": "public, max-age=300"
});
```

Still returns raw text, bypassing the `{ success: true, data: T }` envelope contract. The OpenAPI spec at line 27 correctly declares `"text/plain"` content type, so at least it is self-documenting. However, any consumer using `unwrapEnvelope()` on this response would fail.

---

### Maintainability Concerns

#### M1. `ai-config.ts` Is a 357-Line Config (AI) -- STILL OPEN

**File:** `packages/core/src/modules/ai/ai-config.ts`

Still 357 lines mixing backend configuration (model capabilities, retry logic, OpenRouter settings) with frontend UI config (toast durations, preview device widths). No splitting has occurred.

#### M2. `prompt-helper-v2.ts` Has DOM Reference for Server-Side Code -- STILL OPEN

**File:** `packages/core/src/modules/ai/prompt-helper-v2.ts` (line 1)

```typescript
/// <reference lib="dom" />
```

Still present. The comment on line 141 ("Image() is a browser-only DOM API -- not available in Workers/Node") was added, which documents the intent, but the `/// <reference lib="dom" />` directive still pollutes the TypeScript environment.

#### M3. `ai-context-schema.ts` Recovery Logic Is Overly Complex -- STILL OPEN

**File:** `packages/core/src/modules/ai/ai-context-schema.ts` (lines 99-156)

`parseAiContext` still has three-layer parsing: parse JSON, validate with Zod, manually reconstruct and re-validate. The manual recovery (lines 126-139) duplicates schema defaults. No simplification.

---

### Performance & Scalability

#### S1. Dashboard Makes Sequential DB Queries -- STILL OPEN

**File:** `packages/core/src/modules/analytics/dashboard.service.ts` (lines 145-183)

`getDailyActivityData` still makes two separate queries (orders + customers). `getDashboardStats` correctly uses `Promise.all` for its five queries.

#### S2. `ai-context.ts` N+1 URL Resolution -- PARTIALLY FIXED

**File:** `apps/api/src/routes/admin/ai-context.ts` (lines 131-148)

The route now batches all storefront path lookups into a single `Promise.all` (lines 146-148). All paths are collected first (lines 132-144), then resolved together. This is a significant improvement over the previous per-path approach.

However, the standalone category resolution at lines 225-229 still uses `Promise.all` with individual `getStorefrontPath` calls per category (when `allCategories` or `categoryIds` are provided without `productIds`). Each `getStorefrontPath` likely makes its own DB/KV lookup internally.

#### S3. `logCapiEvent` Fire-and-Forget Cleanup on Every Log Write -- STILL OPEN

**File:** `packages/core/src/modules/analytics/meta.service.ts` (line 50)

```typescript
void performLogCleanup(db, retentionHours);
```

Every CAPI event still triggers a fire-and-forget DELETE query.

#### S4. OpenRouter Model List Not Cached -- STILL OPEN

**File:** `apps/api/src/routes/admin/openrouter.ts` (line 35)

The `/models` endpoint still fetches `https://openrouter.ai/api/v1/models` on every request without KV caching.

---

### Robustness Gaps

#### R1. Fraud Checker `testFraudProvider` Uses Hardcoded Phone -- STILL OPEN

**File:** `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` (line 176)

```typescript
const result = await fraudLookup(provider, "+8801700000000");
```

Still hardcoded Bangladesh phone number.

#### R2. OpenRouter Generate Has No Rate Limiting -- STILL OPEN

**File:** `apps/api/src/routes/admin/openrouter.ts`

No rate limiting on `/generate` or `/generate-staged` endpoints.

#### R3. Streaming Response Bypasses Envelope Contract -- STILL OPEN

**File:** `apps/api/src/routes/admin/openrouter.ts` (lines 180-187)

When `stream: true`, the handler returns a raw `Response` with no error handling for mid-stream failures. No error event injection at end of stream.

#### R4. `getImageDimensions` Always Returns {0,0} in Workers -- STILL OPEN

**File:** `packages/core/src/modules/ai/prompt-helper-v2.ts` (lines 137-167)

`typeof Image === "undefined"` is always true in Cloudflare Workers, so `getImageDimensions` always returns `{width: 0, height: 0}`. The `generateImageContext` function at line 229 filters out images with `width === 0`, but falls back to including URLs without dimensions (lines 234-236). So images still get included -- just without dimension metadata. Dead code path remains misleading.

#### R5. Analytics Timestamp Formatting -- FIXED

**File:** `packages/core/src/modules/analytics/analytics.service.ts` (lines 12-23)

The `formatScriptResponse` function was rewritten to handle both `Date` objects and raw integers:

```typescript
createdAt: script.createdAt instanceof Date
    ? script.createdAt.toISOString()
    : script.createdAt ? new Date(Number(script.createdAt) * 1000).toISOString() : null,
```

The function now checks `instanceof Date` first (for Drizzle's `mode: "timestamp"` return values) and falls back to integer conversion only when needed. The previous `Number(date) * 1000` bug that would produce dates in the year ~65000 is fixed.

---

### LLM-Friendliness

#### L1-L4: All observations unchanged. No changes to documentation, JSDoc, or provider patterns.

---

## New Issues Found

### N1. Analytics Route `as any` Count Increased

**File:** `apps/api/src/routes/admin/analytics.ts` (lines 25-29, 47-52)

Previously reported as one `as any` cast on line 47. Now there are two: the list handler (line 25) and the create handler (line 47) both use `(async (c: any) => { ... }) as any)`. The get, update, delete, and toggle handlers (lines 70, 95, 125, 150) are properly typed without casts. This suggests the `as any` pattern was selectively applied during the fix session, but the list and create routes were not cleaned up.

### N2. Fraud Checker Route Imports Directly From Service, Not Barrel

**File:** `apps/api/src/routes/admin/fraud-checker.ts` (line 5)

```typescript
import { getFraudProviders, getFraudProvider, ... } from "@scalius/core/modules/fraud-checker/fraud-checker.service";
```

The import goes directly to `fraud-checker.service.ts` instead of the barrel `@scalius/core/modules/fraud-checker` (which re-exports everything via `index.ts`). This is inconsistent with how `analytics.ts` imports from `@scalius/core/modules/analytics` (using the barrel). Not a bug, but a convention inconsistency.

### N3. OpenRouter Error Handling Code Duplication

**Files:**
- `apps/api/src/routes/admin/openrouter.ts` (lines 165-178, 296-308)

The `/generate` and `/generate-staged` handlers have identical error-handling blocks for the OpenRouter API response: parse error text, try JSON parse, extract `error.message`, fall back to truncated body. This is duplicated verbatim across both handlers (~13 lines each). Should be extracted to a shared helper.

### N4. OpenRouter API Key Lookup Duplicated

**Files:**
- `apps/api/src/routes/admin/openrouter.ts` (lines 102-110, 243-250)

Both `/generate` and `/generate-staged` perform identical DB queries to fetch `openrouter_api_key` from the settings table. This query pattern should be extracted to a shared function or middleware.

### N5. `ai-context.ts` Uses `(c.env as Record<string, unknown>)` Cast

**File:** `apps/api/src/routes/admin/ai-context.ts` (line 84)

```typescript
const kv = (c.env as Record<string, unknown>)?.CACHE as KVNamespace | undefined;
```

This double cast bypasses Hono's typed env. The `c.env` type should include `CACHE` via the Hono app's type parameter, or at minimum use a single narrower cast.

---

## Summary of Fixes Since Previous Audit

| # | Finding | Status |
|---|---------|--------|
| R5 | Timestamp formatting bug (analytics.service.ts) | **FIXED** |
| S2 | N+1 URL resolution (ai-context.ts) | **PARTIALLY FIXED** (product paths batched, standalone category paths still N+1) |

**Fixed:** 1 of 20
**Partially Fixed:** 1 of 20
**Still Open:** 18 of 20
**New Issues Found:** 5

---

## Revised Recommendations

### Priority: High (Bugs / Data Correctness)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 1 | **Type the analytics service parameters (C2)** | `packages/core/src/modules/analytics/analytics.service.ts` | 15 min |
| 2 | **Remove duplicate prompt URLs (C1)** | `apps/api/src/routes/admin/ai-prompts.ts` | 5 min |
| 3 | **Validate prompt `type` param with z.enum (Q3)** | `apps/api/src/routes/admin/ai-prompts.ts` | 5 min |

### Priority: Medium (Consistency / Maintainability)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 4 | **Fix `as any` casts in OpenRouter + analytics routes (C4, N1)** | `apps/api/src/routes/admin/openrouter.ts`, `analytics.ts` | 30 min |
| 5 | **Replace `alert()` with `toast()` (P3)** | `apps/admin/src/components/admin/AnalyticsForm.tsx` | 2 min |
| 6 | **Use `AdminListPagination` in Meta logs (P4)** | `apps/admin/src/components/admin/meta-conversions/MetaConversionsLogs.tsx` | 15 min |
| 7 | **Deduplicate `manualLogCleanup` to call `performLogCleanup` (Q1)** | `packages/core/src/modules/analytics/meta.service.ts` | 10 min |
| 8 | **Fix fraud-checker PUT route to use path ID (Q5)** | `apps/api/src/routes/admin/fraud-checker.ts` | 15 min |
| 9 | **Remove DOM reference from core package (M2)** | `packages/core/src/modules/ai/prompt-helper-v2.ts` | 5 min |
| 10 | **Rename `FraudCheckResult` to eliminate collision (Q4)** | `packages/core/src/modules/fraud-checker/provider.ts`, `index.ts` | 10 min |
| 11 | **Standardize analytics service errors to throw NotFoundError (P1)** | `packages/core/src/modules/analytics/analytics.service.ts` | 15 min |
| 12 | **Remove try/catch rethrow wrappers (Q6)** | `apps/api/src/routes/admin/ai-context.ts`, `fraud-checker.ts` | 10 min |
| 13 | **Extract OpenRouter error parsing + API key lookup helpers (N3, N4)** | `apps/api/src/routes/admin/openrouter.ts` | 20 min |
| 14 | **Fix fraud-checker barrel import (N2)** | `apps/api/src/routes/admin/fraud-checker.ts` | 2 min |

### Priority: Low (Performance / Nice-to-Have)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 15 | **Cache OpenRouter model list in KV (S4)** | `apps/api/src/routes/admin/openrouter.ts` | 20 min |
| 16 | **Remove per-event log cleanup, use cron (S3)** | `packages/core/src/modules/analytics/meta.service.ts` | 20 min |
| 17 | **Add rate limiting to OpenRouter generate endpoints (R2)** | `apps/api/src/routes/admin/openrouter.ts` | 20 min |
| 18 | **Split ai-config.ts into backend/frontend/messages (M1)** | `packages/core/src/modules/ai/ai-config.ts` | 30 min |
| 19 | **Simplify `parseAiContext` recovery logic (M3)** | `packages/core/src/modules/ai/ai-context-schema.ts` | 20 min |
| 20 | **Make fraud-checker test phone configurable (R1)** | `packages/core/src/modules/fraud-checker/fraud-checker.service.ts` | 10 min |
| 21 | **Standardize dashboard query style (P2)** | `packages/core/src/modules/analytics/dashboard.service.ts` | 30 min |
| 22 | **Fix `c.env` cast in ai-context route (N5)** | `apps/api/src/routes/admin/ai-context.ts` | 10 min |
| 23 | **Fix retention unit mismatch documentation (Q2)** | `packages/core/src/modules/analytics/meta.service.ts` | 5 min |

---

## Health Score: 5/10

**Rationale:** Only 1 of 20 previous findings was fully fixed (R5 timestamp bug). The partially-fixed S2 shows awareness of the N+1 problem but incomplete coverage. The 18 remaining open issues span type safety (C2, C4), code duplication (C1, Q1, N3, N4), REST convention violations (Q5), and missing validation (Q3). No regressions were introduced, and the one fix applied (R5) was done correctly with proper Date/integer branching. The five new issues found (N1-N5) are minor consistency/duplication concerns, not new bugs. The domains remain functional but carry significant maintenance debt.
