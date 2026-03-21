# Settings Domain Re-Audit

## Previous Audit Findings Status

### Critical Issues

#### 1. `delivery-locations.ts` orphaned from settings router
**Status: STILL OPEN**

`delivery-locations.ts` is still mounted directly in `apps/api/src/app.ts` at line 286:
```typescript
app.route("/admin/settings/delivery-locations", adminLocationRoutes);
```
It is NOT mounted through the `adminSettingsRoutes` aggregator in `apps/api/src/routes/admin/settings.ts`. Every other settings sub-route (including the new `notification-channels.ts`) is mounted through the aggregator. The export name `adminLocationRoutes` still does not match the naming convention used by other settings exports.

**Files:** `apps/api/src/app.ts:286`, `apps/api/src/routes/admin/settings.ts`, `apps/api/src/routes/admin/settings/delivery-locations.ts`

#### 2. Hero sliders use `CURRENT_TIMESTAMP` instead of Unix epoch
**Status: FIXED**

All timestamp writes in `apps/api/src/routes/admin/settings/hero-sliders.ts` now use `sql\`(unixepoch())\`` (lines 94-95, 161, 197). The create, update, and delete handlers all produce correct integer timestamps.

#### 3. `saveHeaderConfig` / `saveFooterConfig` overwrite each other's data on fresh installs
**Status: STILL OPEN**

`packages/core/src/modules/settings/site-settings.service.ts` lines 69-103: `saveHeaderConfig` still inserts `footerConfig: JSON.stringify({})` as fallback, and `saveFooterConfig` still inserts `headerConfig: JSON.stringify({})`. The `saveSeoSettings` function (line 163) has the same issue with both header and footer defaulting to `{}`.

The pattern is mitigated by `onConflictDoUpdate` only setting the relevant field, but the insert path on a completely fresh DB still risks data loss in a race condition.

---

### Code Quality Issues

#### 4. Massive inline DB operations in route handlers (thin-layer violation)
**Status: PARTIALLY FIXED**

`apps/api/src/routes/admin/settings/site.ts` now properly delegates to `@scalius/core/modules/settings/site-settings.service.ts` for ALL operations (currency, header, footer, theme, SEO, storefront URL, allowed countries). This is a significant improvement.

However, the following files still inline all DB operations directly in route handlers:

| File | Status |
|------|--------|
| `apps/api/src/routes/admin/settings/site.ts` | FIXED -- delegates to core services |
| `apps/api/src/routes/admin/settings/system.ts` | STILL OPEN -- auth, security, email, firebase all inline |
| `apps/api/src/routes/admin/settings/integrations.ts` | STILL OPEN -- OpenRouter settings inline |
| `apps/api/src/routes/admin/settings/hero-sliders.ts` | STILL OPEN -- all CRUD inline |
| `apps/api/src/routes/admin/settings/shipping.ts` | STILL OPEN -- all CRUD inline |
| `apps/api/src/routes/admin/settings/delivery-locations.ts` | PARTIALLY -- create and getById delegate to core, rest inline |
| `apps/api/src/routes/admin/settings/meta-conversions-admin.ts` | STILL OPEN -- all operations inline (except manualLogCleanup) |
| `apps/api/src/routes/admin/settings/notification-channels.ts` | FIXED -- delegates to core service |
| `apps/api/src/routes/admin/settings/payments.ts` | PARTIALLY -- uses `upsertSetting`/`upsertEncryptedSetting` from core, but GET handlers read DB directly |

#### 5. Nine instances of `as any` type casting
**Status: STILL OPEN**

Current count is 9 instances across 4 files:

| File | Count |
|------|-------|
| `apps/api/src/routes/admin/settings/shipping.ts` | 3 (lines 148, 206, 242) |
| `apps/api/src/routes/admin/settings/delivery-providers.ts` | 2 (lines 116, 176) |
| `apps/api/src/routes/admin/settings/meta-conversions-admin.ts` | 3 (lines 44, 66, 126) |
| `apps/api/src/routes/admin/settings/delivery-locations.ts` | 1 (line 135) |

Pattern remains `(async (c: any) => { ... }) as any` bypassing Hono OpenAPI type inference.

#### 6. Redundant try/catch/throw pattern
**Status: STILL OPEN**

`system.ts` still wraps every handler in try/catch that only rethrows (lines 42-59, 86-124, 143-154, 174-202, 221-234, 255-280, 299-315, 336-370). `integrations.ts` has the same pattern (lines 27-39, 59-81). `payments.ts` has it in all GET handlers and most POST handlers. `hero-sliders.ts` wraps every handler.

A few handlers add legitimate error transformation (e.g., `shipping.ts` catches `UNIQUE constraint` and throws `ConflictError`), but the majority are pure pass-through.

#### 7. Inconsistent secret masking constant names
**Status: STILL OPEN**

Still two naming variants across 7 files:

| Constant | Files |
|----------|-------|
| `MASKED` | `system.ts`, `payments.ts` |
| `MASKED_VALUE` | `integrations.ts`, `delivery-providers.ts`, `meta-conversions-admin.ts`, `AuthSettingsBuilder.tsx`, `EmailSettingsForm.tsx` |

No centralized constant exists.

---

### Pattern Violations

#### 8. Two services for same domain with overlapping functionality
**Status: STILL OPEN**

- `packages/core/src/modules/settings/settings.service.ts` -- read-only with KV caching (storefront/runtime)
- `packages/core/src/modules/settings/site-settings.service.ts` -- read/write without KV caching (admin routes)

Both still query the same tables. The naming still does not communicate the read-only vs. admin distinction.

#### 9. Allowed countries parsing duplicated between service and checkout-config
**Status: STILL OPEN**

`packages/core/src/modules/settings/checkout-config.service.ts` lines 55-70 still contain the identical backward-compatible JSON parsing logic that exists in `packages/core/src/modules/settings/site-settings.service.ts` lines 211-234. `checkout-config.service.ts` does not import or call `getAllowedCountries()` from `site-settings.service.ts`.

#### 10. `upsertSetting` imported from payments, not settings
**Status: STILL OPEN**

`packages/core/src/modules/settings/site-settings.service.ts` line 10 still has:
```typescript
import { upsertSetting } from "../payments/gateway-settings";
```

Additionally, the new notification channels code in `settings.service.ts` (line 229) uses a dynamic import of the same function:
```typescript
const { upsertSetting } = await import("../payments/gateway-settings");
```

This adds a second import point for the same cross-module dependency.

#### 11. `CheckoutFlowSettings` and `AuthSettingsBuilder` both POST to `/auth` endpoint
**Status: STILL OPEN**

Both components still fetch from and POST to `/api/v1/admin/settings/auth`:
- `apps/admin/src/components/admin/settings/AuthSettingsBuilder.tsx` line 44 (GET), line 66 (POST)
- `apps/admin/src/components/admin/settings/CheckoutFlowSettings.tsx` line 40 (GET), line 61 (POST)

The stale-overwrite risk remains: `AuthSettingsBuilder` sends `authVerificationMethod`, `whatsappAccessToken`, `whatsappPhoneNumberId`, `whatsappTemplateName`; `CheckoutFlowSettings` sends `guestCheckoutEnabled`, `checkoutMode`, `partialPaymentEnabled`, `partialPaymentAmount`. Because the API handler uses `if (body.authVerificationMethod)` (line 95 of system.ts) rather than `typeof ... === "string"`, an empty string auth method would not be applied. The `if (body.checkoutMode)` guard (line 105) has the same issue -- an empty string would be silently dropped.

---

### Maintainability Concerns

#### 12. CurrencySettingsBuilder embeds 200+ hardcoded currency entries
**Status: STILL OPEN**

`apps/admin/src/components/admin/settings/CurrencySettingsBuilder.tsx` lines 26-212 still contain the full 200+ currency array hardcoded inline in the component (212 lines of data). The `@scalius/shared/currency` module has `getDecimalPlaces()` but not the full currency metadata.

#### 13. No Zod validation in core service layer
**Status: STILL OPEN**

No `settings.validation.ts` file exists. Core services accept raw objects without validation. The new `updateNotificationChannels()` in `settings.service.ts` does validate channel values against `VALID_NOTIFICATION_CHANNELS`, which is a small improvement, but the broader pattern of no service-layer validation remains.

#### 14. Admin UI components have inconsistent loading patterns
**Status: STILL OPEN**

| Component | Loading state | Saving state | Dirty tracking |
|-----------|--------------|--------------|----------------|
| `ThemeSettingsPage.tsx` | `loading` | `saving` | Yes |
| `AuthSettingsBuilder.tsx` | `loading` | `saving` | No |
| `CurrencySettingsBuilder.tsx` | `loading` | `saving` | No |
| `CheckoutFlowSettings.tsx` | `loading` | `saving` | No |
| `SeoSettingsBuilder.tsx` | `isFetching` | `isLoading` | No |
| `SecuritySettingsBuilder.tsx` | `isFetching` | `isLoading` | No |
| `StorefrontUrlBuilder.tsx` | (none) | `isLoading` | No |
| `EmailSettingsForm.tsx` | `loading` | `saving` | No |
| `NotificationChannelsBuilder.tsx` | `isLoading` | `isSaving` | No |

The new `NotificationChannelsBuilder` uses yet another variant (`isLoading`/`isSaving`) -- a third naming convention. No component except `ThemeSettingsPage` tracks dirty state.

#### 15. Three builder components live outside the settings directory
**Status: STILL OPEN**

All three still exist at:
- `apps/admin/src/components/admin/SeoSettingsBuilder.tsx`
- `apps/admin/src/components/admin/SecuritySettingsBuilder.tsx`
- `apps/admin/src/components/admin/StorefrontUrlBuilder.tsx`

`GeneralSettingsPage.tsx` still imports them via `"../SeoSettingsBuilder"` etc.

---

### Performance & Scalability

#### 16. KV cache invalidation inconsistent across settings types
**Status: STILL OPEN**

Currency cache invalidation remains a raw `kv?.delete("gw:currency")` call in the route handler (`apps/api/src/routes/admin/settings/site.ts` line 76) instead of a dedicated function. All other settings cache keys have named invalidation functions.

The security CSP cache still writes via `env.CACHE.put()` directly (`system.ts` line 195) instead of using `getKv()`.

#### 17. `getCheckoutConfig` makes N+1 gateway calls
**Status: STILL OPEN**

`packages/core/src/modules/settings/checkout-config.service.ts` lines 80-83 still resolves each gateway's settings via individual `gw.getSettings()` calls.

#### 18. `deleteCacheByPattern` on theme save not async
**Status: STILL OPEN**

`apps/api/src/routes/admin/settings/site.ts` line 243 still performs `deleteCacheByPattern("api:storefront:layout:*", kv)` synchronously in the save handler (with `await`), blocking the admin response on a KV scan.

---

### Robustness Gaps

#### 19. No validation of `partialPaymentAmount`
**Status: STILL OPEN**

`apps/api/src/routes/admin/settings/system.ts` line 70: `partialPaymentAmount: z.number().optional()` -- no `.min(0)` constraint. Negative values would be accepted.

#### 20. `DELETE /delivery-locations/all` has no confirmation
**Status: FIXED**

`apps/api/src/routes/admin/settings/delivery-locations.ts` lines 148-171 now requires `{ confirmDeleteAll: z.literal(true) }` in the request body (line 155) and validates it (lines 164-167). This was a direct fix of the audit finding.

#### 21. `SeoSettingsBuilder.tsx` double-parses the response on error
**Status: STILL OPEN**

`apps/admin/src/components/admin/SeoSettingsBuilder.tsx` lines 36-41 still has the pattern where `.json()` is called in the `!response.ok` branch (line 37) AND again after the branch (line 40). While both calls cannot execute in sequence for the same response, the pattern is fragile and unlike other components that use `unwrapEnvelope(json)` with a single `.json()` call.

#### 22. WhatsApp access token stored unencrypted
**Status: STILL OPEN**

`apps/api/src/routes/admin/settings/system.ts` line 112 stores the WhatsApp access token as plaintext in the `siteSettings` table, while payment gateway secrets use AES-GCM encryption via `upsertEncryptedSetting`.

---

## New Issues Found

### NEW-1. Notification channels data shape mismatch between API and UI (Critical)

**Files:**
- `apps/api/src/routes/admin/settings/notification-channels.ts` -- API returns `Record<string, string[]>` (e.g., `{ order_created: ["email"] }`)
- `apps/admin/src/components/admin/settings/NotificationChannelsBuilder.tsx` -- UI expects `{ channels: ChannelConfig }` and sends `{ channels: {...} }`

The API GET handler (line 30-31) returns the channels directly via `ok(c, channels)`, producing `{ success: true, data: { order_created: ["email"], ... } }`. The UI's `unwrapEnvelope()` extracts `data`, yielding the flat record. But the UI then reads `data.channels` (line 60), which is `undefined` because there is no `channels` wrapper key. The channels will never load from the API -- the UI always falls back to defaults.

The PUT handler (line 41-42) expects `channelsSchema` which is `z.record(z.string(), z.array(z.string()))` -- a flat record. But the UI sends `{ channels: {...} }` (line 89), wrapping the data in a `channels` key. Zod validation will pass (the `channels` key becomes a record entry), but the stored data will be `{ channels: { order_created: {...}, ... } }` -- doubly nested -- which the GET handler returns directly, creating compounding corruption on each save cycle.

Furthermore, the UI stores channels as `Record<StatusKey, Record<ChannelKey, boolean>>` (boolean map per status), but the API and core service expect `Record<string, string[]>` (array of channel names per status). There is no transformation between these two formats in the UI.

**Impact:** Notification channel settings do not load or save correctly. Data corruption on save.

**Fix:**
1. API GET should wrap: `return ok(c, { channels })` OR UI should read `data` directly without `.channels`
2. UI PUT should send the flat record, not `{ channels: {...} }`
3. UI needs to transform boolean map to string array format before sending and vice versa on load

### NEW-2. `updatedAt: new Date()` in settings KV table writes produces wrong type

**Files:** `apps/api/src/routes/admin/settings/system.ts` lines 190, 264, 272, 347, 358; `apps/api/src/routes/admin/settings/delivery-providers.ts` line 276

Six instances use `updatedAt: new Date()` in `onConflictDoUpdate` set clauses for the `settings` KV table. The `settings.updatedAt` column type needs to be verified, but if it follows the codebase convention of Unix epoch integers (which most tables do), `new Date()` produces a JavaScript Date object that Drizzle would serialize differently than an integer timestamp. Other settings writes in `site-settings.service.ts` use `sql\`unixepoch()\`` for timestamps.

Contrast with `site-settings.service.ts` which correctly uses `updatedAt: sql\`unixepoch()\`` for `siteSettings` table writes.

**Impact:** `updatedAt` values in the `settings` table for security, email, firebase, and delivery-providers entries may be stored as ISO strings or Date object serializations instead of Unix epoch integers, causing inconsistency with the rest of the schema.

### NEW-3. `system.ts` still bundles four unrelated concerns

**File:** `apps/api/src/routes/admin/settings/system.ts` (373 lines)

This file handles:
1. Auth settings (GET/POST `/auth`) -- lines 19-125
2. Security settings (GET/POST `/security`) -- lines 131-203
3. Email settings (GET/POST `/email`) -- lines 209-281
4. Firebase settings (GET/POST `/firebase`) -- lines 287-373

These are four completely independent feature areas sharing nothing except being in the same HTTP route file. All four inline their DB operations (issue #4). This was noted in the previous audit's LLM-friendliness section but not tracked as a numbered issue.

**Impact:** 373-line file with no shared logic between sections. Increases cognitive load and merge conflict risk.

### NEW-4. `NotificationChannelsBuilder` uses `isLoading`/`isSaving` -- third naming variant

**File:** `apps/admin/src/components/admin/settings/NotificationChannelsBuilder.tsx` lines 50-51

The new component introduces `isLoading`/`isSaving` as state variable names, which is a third variant alongside `loading`/`saving` (AuthSettingsBuilder, CurrencySettingsBuilder, etc.) and `isFetching`/`isLoading` (SeoSettingsBuilder, SecuritySettingsBuilder). This exacerbates issue #14.

### NEW-5. `console.error` usage in route handlers remains widespread

**Files:** `apps/api/src/routes/admin/settings/delivery-locations.ts` (6 instances), `apps/api/src/routes/admin/settings/shipping.ts` (7 instances)

13 total `console.error` calls across two route files. These are redundant with Hono's error handler logging and add noise.

### NEW-6. `site.ts` swallows errors on GET /general and GET /seo with fallback data

**File:** `apps/api/src/routes/admin/settings/site.ts` lines 97-103, 271-277

```typescript
// GET /general
} catch (error: unknown) {
    return ok(c, { headerConfig: {}, footerConfig: {} });
}

// GET /seo
} catch (error: unknown) {
    return ok(c, { siteTitle: "", homepageTitle: "", ... });
}
```

Database errors are silently swallowed and replaced with empty defaults. The admin user sees an empty form with no indication that data loading failed. Other GET handlers (GET /storefront-url, line 327) do the same. This masks real DB connectivity issues.

---

## Summary

| Category | Total Issues | Fixed | Partially Fixed | Still Open | New |
|----------|-------------|-------|-----------------|------------|-----|
| Critical | 3 + 1 new | 1 (#2 timestamps) | 0 | 2 (#1, #3) | 1 (NEW-1 notification shape) |
| Code Quality | 4 + 2 new | 0 | 1 (#4 partial delegation) | 3 (#5, #6, #7) | 2 (NEW-2 Date(), NEW-5 console.error) |
| Pattern Violations | 4 | 0 | 0 | 4 (#8, #9, #10, #11) | 0 |
| Maintainability | 4 + 2 new | 0 | 0 | 4 (#12, #13, #14, #15) | 2 (NEW-3 system.ts, NEW-4 naming) |
| Performance | 3 | 0 | 0 | 3 (#16, #17, #18) | 0 |
| Robustness | 4 + 1 new | 1 (#20 confirm delete) | 0 | 3 (#19, #21, #22) | 1 (NEW-6 swallowed errors) |
| **Totals** | **22 + 6 new = 28** | **2** | **1** | **19** | **6** |

## Quality Score: 4/10

**Rationale:** Only 2 of 22 original issues were fully fixed (hero slider timestamps, delivery-locations delete-all confirmation). One more was partially addressed (site.ts now delegates to core services). The most impactful architectural issues (inline DB operations in 6+ route files, `as any` casts, `upsertSetting` ownership, dual service confusion) remain unchanged. The new notification channels feature introduced a critical data shape mismatch (NEW-1) that means the feature is non-functional as shipped. The `updatedAt: new Date()` issue (NEW-2) represents a regression pattern that may produce incorrect timestamps in the settings table.

The domain's core weakness -- the settings routes being the primary location where "thin HTTP layer" is violated -- remains unaddressed. The positive trend is that `site.ts` was refactored to use core services, proving the pattern works, but the same refactoring was not applied to `system.ts`, `hero-sliders.ts`, `shipping.ts`, or `meta-conversions-admin.ts`.
