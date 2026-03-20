# Audit 04: Search, Integrations & Provider Architecture

**Auditor:** Claude Opus 4.6 (1M context)
**Date:** 2026-03-20
**Scope:** FTS5 search, email/storage/Firebase/Meta integrations, universal provider system, caching utilities, credential encryption

---

## Summary

The codebase has a **well-designed universal provider registry** (`packages/core/src/providers/`) that represents a genuinely excellent architecture for extensibility. Search is solid with proper FTS5 sanitization and batched queries. Integrations are reasonably isolated. The main structural tension is that **delivery providers live outside the universal registry**, using a parallel legacy interface, which undermines the consistency the registry was designed to provide. Additionally, several security practices around credential handling and API token exposure in URLs need attention.

**Overall Quality:** 7/10 -- strong foundations with a clear migration path forward, but the dual-system issue and a few security gaps hold it back.

---

## Strengths

### 1. Universal Provider Registry -- Excellent Design
The `providers/registry.ts` + `providers/types.ts` system is one of the best-designed pieces in the codebase:
- **Single registry** keyed by `"type:id"` strings -- simple, no over-engineering
- **Zod schema validation** at retrieval time ensures settings are always validated before reaching provider code
- **Lazy factory pattern** -- stores factory functions, creates instances on demand
- **ProviderMeta** separates identity/config from runtime behavior
- **ProviderLifecycle** (initialize/healthCheck/dispose) gives every provider category the same infrastructure contract
- Every provider category (email, payment, delivery, SMS) has inline **"HOW TO ADD A NEW PROVIDER"** documentation in the types file

### 2. FTS5 Search -- Safe and Correct
- `sanitizeFtsQuery()` strips all FTS5 special characters, preventing injection
- Prefix matching (`word*`) provides good UX for incremental search
- Implicit AND semantics (all words must match) is the right default
- `ftsMatch()` returns `undefined` for empty queries, letting callers skip the condition naturally
- Table names are hardcoded by callers (not user-controlled), so `sql.raw()` usage is safe
- `search()` uses `db.batch()` for parallel execution of product/page/category queries
- N+1 fix for product images: single bulk query after initial results

### 3. Credential Encryption
- AES-256-GCM with random IV per encryption -- cryptographically sound
- `decryptCredentialsGraceful()` enables migration from plaintext to encrypted without downtime
- Delivery factory uses this for provider credentials from the database

### 4. Cache Invalidation System
- Group-based invalidation (`INVALIDATION_GROUPS`) maps semantic entities to KV prefixes
- Admin path-to-group mapping auto-triggers correct invalidation on writes
- `storefrontPrefixes` separation from `kvPrefixes` shows careful multi-layer cache awareness
- In-memory fallback cache for local development without KV bindings

### 5. Integration Isolation
- Storage (R2), email, Firebase, and Meta are each self-contained modules
- No integration leaks business logic -- they are pure infrastructure concerns
- Email has a clean provider abstraction with registry pattern
- Firebase admin uses Web Crypto API directly (no heavy SDK dependency)

---

## Issues

### Critical

#### C1. Meta CAPI Access Token Exposed in URL Query String
**File:** `packages/core/src/integrations/meta/conversions-api.ts:166`
```typescript
const url = `https://graph.facebook.com/${version}/${pixelId}/events?access_token=${accessToken}`;
```
The Meta CAPI access token is placed in the URL query string. While this follows Meta's older documentation pattern, it means:
- Tokens appear in server logs if request logging is enabled
- Tokens can leak through any intermediary proxy or CDN logs
- The Meta API also accepts `Authorization: Bearer {token}` header, which is the preferred approach

**Recommendation:** Move to `Authorization: Bearer ${accessToken}` header and remove the token from the URL.

#### C2. Delivery Providers Import Module-Level DB Singleton
**File:** `packages/core/src/modules/delivery/providers/pathao.ts:14`
```typescript
import { db } from "@scalius/database/client";
```
The Pathao provider imports the module-level `db` singleton directly, bypassing the DI pattern used everywhere else (where `db` is passed as a parameter). This:
- Creates a hard coupling to module-level state
- Makes the provider untestable in isolation
- Could cause issues if the singleton isn't initialized when the provider runs (e.g., in queue workers)
- Contradicts the factory pattern in `factory.ts` which properly receives credentials but doesn't pass `db`

**Recommendation:** Pass `db` through the provider constructor or through method parameters. The `getExternalLocationIds` call on line 183 is the one that needs it.

### Major

#### M1. Two Parallel Provider Systems for Delivery
The codebase has **two** provider abstractions for delivery:
1. **Universal registry** (`providers/delivery/types.ts`): `DeliveryProvider` interface with `createShipment(data: ShipmentData)` -- generic, clean, uses the registry
2. **Legacy module** (`modules/delivery/provider.ts`): `DeliveryProviderInterface` with `createShipment(order: Order, options?)` -- takes raw Order entity, has `getName()`/`getType()` methods

The actual Pathao/Steadfast implementations use the **legacy** interface. The universal `DeliveryProvider` interface exists but has **zero implementations** registered. No delivery providers call `registerProvider()` for the `"delivery"` type. This means:
- `getRegisteredProviders("delivery")` returns an empty array
- The universal registry is incomplete -- delivery is the missing piece
- Two different `ShipmentResult` types exist (legacy has `success: boolean`, universal has `externalId` as top-level)

**Recommendation:** Create adapter files (like `stripe-adapter.ts` and `resend-adapter.ts`) for Pathao and Steadfast. The pattern already exists for payment and email. This should be straightforward.

#### M2. Legacy Email Provider Reads Settings Per-Send
**File:** `packages/core/src/integrations/email/resend.ts:13-46`
The legacy `ResendEmailProvider` calls `getEmailSettings()` on **every single email send**, which:
- Runs two DB queries (api key + sender) per email
- Uses dynamic `import()` for `getDb`, `settings`, `and`, `eq` to avoid circular deps
- Creates new DB query pipelines on each invocation

The new adapter (`providers/email/resend-adapter.ts`) correctly receives settings at construction time. However, the legacy provider is still the one wired up and used by `sendEmail()`, `sendVerificationEmail()`, etc. via `integrations/email/index.ts`.

**Recommendation:** Migrate the convenience email functions to use the universal provider. Or at minimum, cache the settings in the legacy provider with a short TTL rather than querying on every send.

#### M3. FCM Singleton Breaks with Dynamic Credentials
**File:** `packages/core/src/integrations/firebase/admin.ts:405-425`
The `getFirebaseAdminMessaging()` function:
- Returns a cached singleton when no explicit `serviceAccountJson` is provided
- Creates a **new instance every time** when `serviceAccountJson` IS provided
- The comment admits this complexity: "too complex to check match"

If credentials are updated in the admin UI and re-read from DB, the singleton still holds the old credentials. There's no invalidation mechanism.

**Recommendation:** Either invalidate the singleton when credentials change, or always create fresh instances (the Web Crypto JWT creation is fast enough).

#### M4. Firebase Client Logs FCM Token to Console
**File:** `packages/core/src/integrations/firebase/client.ts:122`
```typescript
console.log("FCM Token obtained:", currentToken);
```
FCM tokens are sensitive device identifiers. Logging them to the browser console in production is a security concern -- browser extensions and other client-side code can read console output.

**Recommendation:** Remove this log or gate it behind a debug flag.

#### M5. KV Cache Pattern Deletion is O(n) with Sequential Deletes
**File:** `packages/core/src/utils/kv-cache.ts:195-232`
`deleteCacheByPattern()` lists all keys with a prefix, then issues individual `ns.delete()` calls in parallel. For a large cache with thousands of keys, this:
- Requires paginated KV list calls
- Issues potentially hundreds of parallel deletes
- No rate limiting on KV API calls (Cloudflare has KV rate limits)

**Recommendation:** Consider a version-bumping strategy (which the cache-invalidation system already partially supports with `bumpsHtml`) rather than key-by-key deletion. Alternatively, batch deletes if KV batch API becomes available.

### Minor

#### m1. Search Returns Empty Results on All Errors
**File:** `packages/core/src/search/index.ts:194-202`
The catch block returns `{ products: [], pages: [], categories: [] }` for ANY error, including DB connection failures, syntax errors, etc. The error is only logged to console. The caller has no way to distinguish "no results" from "search is broken."

**Recommendation:** Consider returning an error flag or throwing for infrastructure errors (DB down) while gracefully returning empty results for user-input-related issues.

#### m2. Dummy Queries When Search Type is Disabled
**File:** `packages/core/src/search/index.ts:114, 133`
```typescript
: db.select({ id: sql`NULL` }).from(pages).where(sql`1 = 0`); // Dummy query
```
When `searchPages` or `searchCategories` is false, a dummy query that always returns 0 rows is executed. This still hits the database. The batch API requires a fixed number of queries, but this wastes a DB round-trip.

**Recommendation:** If the batch API truly requires fixed-size arrays, this is acceptable. Document why the dummy is needed. If batch supports variable-length arrays, remove the dummies.

#### m3. Storage Module Uses Module-Level Mutable State
**File:** `packages/core/src/integrations/storage.ts:36-37`
```typescript
let _bucket: R2Bucket | undefined;
let _publicUrl: string = "";
```
Same pattern as KV cache. Module-level state in a Worker isolate is acceptable for single-tenant but fragile:
- `initStorage()` must be called before `uploadFile()` or it throws
- No validation that `initStorage()` was called exactly once
- If Worker isolate is shared between requests (unlikely but possible), state could leak

**Recommendation:** This is acceptable for the current architecture but should be documented as a constraint.

#### m4. Email Template HTML is Inline Strings
**File:** `packages/core/src/integrations/email/index.ts:46-143`
Verification, password reset, and admin invite emails are all inline HTML strings with string interpolation. This:
- Makes template changes require code changes
- No HTML escaping on interpolated values (e.g., `name` could contain HTML)
- Hardcoded "Scalius Commerce" branding in subject lines

**Recommendation:** At minimum, escape HTML entities in interpolated user values. Long-term, consider a simple template system or storing templates in the database.

#### m5. Analytics Module Declares Global Window
**File:** `packages/core/src/integrations/analytics.ts:9-12`
```typescript
declare const window: {
  dataLayer: unknown[];
  fbq: (...args: unknown[]) => void;
} & Record<string, unknown>;
```
This global `window` declaration will conflict with any other module that declares `window` differently. The file is client-side only but lives in a package (`@scalius/core`) that is primarily server-side.

**Recommendation:** Move to `packages/shared` or a dedicated client-side package. Or use `typeof window !== "undefined"` guards consistently.

#### m6. Resend Error Handling Bug
**File:** `packages/core/src/integrations/email/resend.ts:78-79`
```typescript
const error = await response.json().catch(() => ({}));
throw new Error(
  error instanceof Error ? error.message : `Resend API error: ${response.status}`,
);
```
The `error` variable here is always the parsed JSON object (or `{}`), never an `Error` instance. The `instanceof Error` check is always false. The error message will always be the generic `Resend API error: ${status}` even when the API returns a descriptive error.

**Recommendation:** Change to `(error as Record<string, unknown>).message || \`Resend API error: ${response.status}\``.

---

## Pattern Analysis

### Provider Architecture Overview

```
providers/
  types.ts          ProviderMeta, ProviderLifecycle, ProviderFactory (universal)
  registry.ts       registerProvider(), getProvider() -- Map<"type:id", registration>
  index.ts          Barrel exports
  email/
    types.ts        EmailProvider extends ProviderLifecycle
    resend-adapter   Registered with universal registry
  payment/
    types.ts        PaymentProvider extends ProviderLifecycle
    stripe-adapter   Registered with universal registry
  delivery/
    types.ts        DeliveryProvider extends ProviderLifecycle (NO IMPLEMENTATIONS)
  sms/
    types.ts        SMSProvider extends ProviderLifecycle (NO IMPLEMENTATIONS)

integrations/
  email/            Legacy email system (still the active code path!)
  storage.ts        R2 storage (no provider abstraction, direct)
  firebase/         Direct FCM integration (no provider abstraction)
  meta/             Direct CAPI integration (no provider abstraction)

modules/delivery/
  provider.ts       DeliveryProviderInterface (legacy, active)
  factory.ts        Switch-case factory (legacy, active)
  providers/        Pathao, Steadfast (implement legacy interface)
```

**Key insight:** The universal provider registry exists and is well-designed, but only email (Resend) and payment (Stripe) have been migrated to it. Delivery and SMS have type definitions but zero registered implementations. The actual runtime code paths still use the legacy systems.

### Configuration Storage

| Provider Type | Config Source | Runtime Pattern |
|---|---|---|
| Email (Resend) | `settings` table (category=email) | Legacy: DB query per send. Adapter: constructor injection |
| Payment (Stripe) | `settings` table + Wrangler secrets | Mixed: some from DB, webhook secret from env |
| Delivery (Pathao/Steadfast) | `deliveryProviders` table (encrypted JSON) | Factory decrypts + parses + instantiates |
| Firebase FCM | `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` env var OR DB | Singleton with optional override |
| Meta CAPI | `metaConversionsSettings` table | DB query per event send |
| Storage (R2) | Wrangler binding + env var for public URL | `initStorage()` once per isolate |
| KV Cache | Wrangler binding | `initKv()` once per isolate |

### Error Handling Patterns

| Integration | On Failure | Graceful? |
|---|---|---|
| Email send | Throws (legacy) or returns empty result (adapter) | Partial -- no retry |
| FCM push | Returns error in response array, retries 429/5xx (3 attempts with backoff) | Yes |
| Meta CAPI | Logs failure to DB, returns `{ success: false }` | Yes |
| R2 upload | Throws with user-friendly message, timeout protection | Yes |
| FTS5 search | Returns empty results, logs to console | Yes (silent failure) |
| KV cache | Falls back to in-memory cache | Yes |
| Delivery (Pathao) | Returns `{ success: false, message }` | Yes |
| Delivery (Steadfast) | Returns `{ success: false, message }` | Yes |

FCM is the only integration with proper retry logic. Email, Meta CAPI, and storage all fail on first attempt.

### Extensibility Assessment

| Task | Difficulty | Files to Touch |
|---|---|---|
| Add new email provider (universal) | Easy | 1 new file + 1 import line |
| Add new payment provider (universal) | Easy | 1 new file + 1 import line |
| Add new delivery provider (legacy) | Medium | 1 new file + factory.ts switch case + types.ts |
| Add new SMS provider | Easy | 1 new file + 1 import line (but no SMS implementations exist yet) |
| Add new analytics integration | Hard | Modify analytics.ts, no provider pattern |
| Add new storage provider | Hard | Would need provider abstraction (currently R2-only) |

---

## Recommendations

### Priority 1 -- Security Fixes
1. **Move Meta CAPI access token from URL to Authorization header** (C1)
2. **Remove FCM token logging from browser console** (M4)
3. **Escape HTML in email template interpolations** (m4)

### Priority 2 -- Complete the Universal Registry
4. **Create delivery provider adapters** for Pathao and Steadfast, following the exact pattern of `stripe-adapter.ts` and `resend-adapter.ts`. This is the most impactful architectural fix -- it completes the provider story. (M1)
5. **Pass `db` as parameter** to PathaoProvider instead of importing the singleton (C2)
6. **Wire the convenience email functions** (`sendVerificationEmail`, etc.) to the universal provider system or cache settings in the legacy provider (M2)

### Priority 3 -- Operational Improvements
7. **Add retry logic to email sends** -- FCM has good retry logic (exponential backoff + Retry-After header) that should be extracted into a shared utility and used by email and Meta CAPI too
8. **Fix the Resend error parsing bug** (m6)
9. **Consider version-bumping** for cache invalidation instead of key enumeration + deletion (M5)
10. **Invalidate FCM singleton** when credentials change (M3)

### Priority 4 -- Code Quality
11. **Move analytics.ts** out of `@scalius/core` into a client-side package (m5)
12. **Add error discrimination** to search results so callers know if search failed vs. returned empty (m1)
13. **Document dummy query pattern** in search or eliminate if batch API supports variable arrays (m2)

---

## LLM-Friendliness Score: 8/10

**Positive factors:**
- Universal provider types are exceptionally well-documented with inline examples
- Clear interface contracts (`EmailProvider`, `PaymentProvider`, `DeliveryProvider`, `SMSProvider`)
- Registry pattern is simple to understand and explain
- Zod schemas make settings requirements explicit and machine-readable
- Each provider type file has a complete 5-step "HOW TO ADD" guide
- Consistent naming: `{Provider}Provider`, `{provider}SettingsSchema`, `{provider}-adapter.ts`

**Negative factors:**
- Dual provider systems (legacy vs. universal) for delivery creates confusion -- an LLM might implement against the wrong interface
- The legacy email system being the active code path while the new adapter exists creates ambiguity about which to use
- `integrations/email/` vs. `providers/email/` vs. `modules/delivery/providers/` -- three different locations for "providers"

**Recommendation for LLM consumers:** Always use the universal provider system (`providers/`) for new implementations. The legacy systems (`integrations/email/`, `modules/delivery/providers/`) are in maintenance mode and will be migrated.
